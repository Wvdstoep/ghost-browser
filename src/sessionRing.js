'use strict';
/*
 * A SESSION THAT HITS A WALL MOVES TO A DEVICE.
 *
 * Sessions run on the cluster, and the cluster leaves the internet from a datacenter address. Shops
 * and marketplaces refuse that address on sight: bol.com answers 403, Google Trends 429, CJ shows a
 * "verify you are human" page. The owner's phone (or desktop node) sits on a home connection where
 * the same pages open normally — and it was already connected through the device ring. But the ring
 * only ever took JOBS (ringGate) and scheduled passes; a session driven step by step through the API
 * or MCP (open → navigate → read → click) never asked it, so every walled page just failed.
 *
 * Now a navigate that lands on a refusal or a challenge hands the SESSION over: the same session id
 * keeps working, but from then on navigate / read / analyze / click / type / scroll / screenshot run
 * on the device. A host that walled us is remembered for a while, so the next session goes straight
 * to the device instead of being refused first. With no device online, nothing changes except that
 * the answer says why the page is a wall and what would get past it.
 *
 * Pure apart from `run` (device-hub's runCommand) and `pickDevice`, so every part is testable with a
 * stubbed device — the same way deviceThread is.
 */

const WALL_STATUS = new Set([401, 403, 407, 429, 503]);
// What a refusal or challenge page says about itself, in the languages these shops answer in.
const WALL_WORDS = /just a moment|attention required|verify you are (a )?human|are you a robot|robot check|unusual traffic|captcha|access denied|pardon our interruption|checking your browser|security check|please verify|request blocked|bot detection|geen toegang|toegang geweigerd|controleer of je een mens bent|ben je een robot/i;
const REMEMBER_MS = 6 * 60 * 60 * 1000;
const SETTLE_MS = 2500;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
}

/** Does this landing look like a wall rather than the page? `sample` = the first bit of its text. */
function looksWalled({ status, title = '', sample = '' } = {}) {
  if (WALL_STATUS.has(Number(status))) return `the site answered HTTP ${status} to the server's address`;
  const words = `${title}\n${String(sample).slice(0, 3000)}`;
  const m = WALL_WORDS.exec(words);
  // A short page that is mostly a challenge — not an article that happens to mention "captcha".
  if (m && String(sample).length < 4000) return `the site showed a challenge ("${m[0]}") instead of the page`;
  return '';
}

/*
 * The phone answers through two wrappers (hub result → device result) and sends JSON as a string.
 * Accept every shape rather than assume one: the wrapper has changed before.
 */
function unwrap(r) {
  let v = r;
  for (let i = 0; i < 5; i += 1) {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return v; } continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && 'result' in v && Object.keys(v).length <= 4) { v = v.result; continue; }
    break;
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.error === 'string') throw new Error(`device: ${v.error}`);
  return v;
}

/** The phone's numbered list (0-based `i`) in the cluster's shape (1-based `index`), so a click means the same thing. */
function toElements(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.elements) ? raw.elements : []);
  return list.map((e, n) => ({
    index: n + 1, tag: e.tag || '', type: e.type || '', role: e.role || '',
    text: String(e.text || '').slice(0, 200), label: String(e.label || '').slice(0, 200), href: e.href || '',
  }));
}

function createSessionRing({ run, pickDevice, log = console, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const walledHosts = new Map(); // host -> { until, why }

  const call = async (s, path, body = {}, timeoutMs = 120000) => unwrap(await run(s.ring.deviceId, { method: 'POST', path, body }, timeoutMs));

  async function info(s) {
    try { const i = await call(s, '/v1/info', {}, 30000); return { url: (i && i.url) || '', title: (i && i.title) || '' }; }
    catch (_) { return { url: '', title: '' }; }
  }

  return {
    hostOf,
    looksWalled,
    /** Has this host walled us recently? Then go straight to a device. */
    knownWall(url) {
      const w = walledHosts.get(hostOf(url));
      if (!w) return '';
      if (w.until < now()) { walledHosts.delete(hostOf(url)); return ''; }
      return w.why;
    },
    remember(url, why) { const h = hostOf(url); if (h) walledHosts.set(h, { until: now() + REMEMBER_MS, why }); },

    /** Move this session to a device with a home connection. Returns the device, or null when none is online. */
    attach(s, owners) {
      if (s.ring) return s.ring;
      const dev = pickDevice(owners);
      if (!dev) return null;
      s.ring = { deviceId: dev.deviceId, name: dev.name, elements: [] };
      log.info?.(`[ring] session ${s.id}: handed to ${dev.name} (home connection)`);
      return s.ring;
    },

    async navigate(s, url) {
      await call(s, '/v1/navigate', { url });
      await wait(SETTLE_MS);
      const here = await info(s);
      s.ring.elements = [];
      return { url: here.url || url, status: null, title: here.title, onDevice: s.ring.name };
    },
    async content(s) {
      const t = await call(s, '/v1/content');
      const text = typeof t === 'string' ? t : String((t && (t.text || t.content)) || '');
      const here = await info(s);
      return { url: here.url, title: here.title, chars: text.length, content: text.slice(0, 200000), onDevice: s.ring.name };
    },
    async analyze(s) {
      const elements = toElements(await call(s, '/v1/analyze'));
      s.ring.elements = elements;
      const here = await info(s);
      const summary = elements.slice(0, 150).map((e) => `[${e.index}] ${e.tag}${e.role ? `(${e.role})` : ''} ${e.text || e.label}`.trim()).join('\n');
      return { url: here.url, title: here.title, elementCount: elements.length, elements, summary, screenshot: null, onDevice: s.ring.name };
    },
    async click(s, { index, text }) {
      if (text) await call(s, '/v1/click_text', { text: String(text) });
      else await call(s, '/v1/click', { index: Number(index) - 1 });
      await wait(1500);
      const here = await info(s);
      return { clicked: text ? { text } : { index: Number(index) }, url: here.url, onDevice: s.ring.name };
    },
    async type(s, { index, text = '', submit = false }) {
      await call(s, '/v1/type', { index: Number(index) - 1, text: String(text) });
      if (submit) {
        // The phone's type has no Enter; submit the field's own form the way a key press would.
        await call(s, '/v1/eval', { code: '(function(){var e=document.activeElement;if(e&&e.form){if(e.form.requestSubmit)e.form.requestSubmit();else e.form.submit();return "submitted"}return "no form"})()' }).catch(() => null);
        await wait(SETTLE_MS);
      }
      const here = await info(s);
      return { typed: String(text).length, mode: 'type', url: here.url, onDevice: s.ring.name };
    },
    async scroll(s, dy) {
      await call(s, '/v1/scroll', { dy: Number(dy) || 400 });
      const here = await info(s);
      return { url: here.url, onDevice: s.ring.name };
    },
    /** PNG bytes. */
    async screenshot(s) {
      const r = await call(s, '/v1/screenshot', {}, 60000);
      const b64 = (r && (r.png_base64 || r.png)) || '';
      if (!b64) throw new Error('the device returned no screenshot');
      return Buffer.from(b64, 'base64');
    },
    /** Structured product data from the page's own schema.org markup, read on the device. */
    async product(s) {
      const code = '(function(){var out=[];document.querySelectorAll(\'script[type="application/ld+json"]\').forEach(function(n){try{var j=JSON.parse(n.textContent);(Array.isArray(j)?j:(j["@graph"]||[j])).forEach(function(x){if(x&&/Product/i.test(String(x["@type"])))out.push(x)})}catch(e){}});return {url:location.href,title:document.title,products:out}})()';
      const r = await call(s, '/v1/eval', { code });
      return { ...(r && typeof r === 'object' ? r : { raw: r }), onDevice: s.ring.name };
    },
  };
}

module.exports = { createSessionRing, looksWalled, unwrap, toElements, hostOf, WALL_STATUS };
