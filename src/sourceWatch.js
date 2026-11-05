'use strict';
/*
 * A SOURCES WATCHER — public pages read from the SERVER, never from the owner.
 *
 * The other watcher modes drive Chromium in a signed-in profile. This one must not, and the reason
 * is where Chromium leaves the internet from: a cluster browser exits through the tailnet by default
 * (pool.js, `routeThroughTailnet !== false`), and the tailnet's exit is the OWNER's own device. A
 * session that hits a wall is handed to the owner's phone (sessionRing.js). Both are right for a
 * marketplace and exactly wrong for this: the first OSINT walk through the browser showed a Russian
 * court's search form the owner's mobile IP and city, because the session had moved to the phone.
 *
 * So a sources pass never opens a browser. It is a plain HTTP GET from the pod's own Node process,
 * which goes nowhere near the SOCKS proxy or the device ring: the request leaves from the
 * datacenter address, and `egress()` measures that address with the same fetch to prove it. A site
 * that refuses the datacenter (403/429/a challenge page) is recorded as BLOCKED and left alone —
 * there is no fallback, deliberately, because every fallback here is the owner's IP.
 *
 * Deterministic, no model. Each pass reads the headlines/posts on each page, compares them with what
 * the previous pass saw, and files only the NEW ones into the watcher's feed with the keywords they
 * hit. The first pass of a source is a baseline: it is remembered, and only its keyword hits are
 * filed, so the feed does not open with a hundred menu links.
 *
 * Polite by construction: one request at a time across the whole pass (so never two on a host), a
 * pause between requests, a body cap, a timeout, at most one scheduled pass an hour, a browser-like
 * User-Agent that carries nothing about the owner. Pure apart from the injected fetch/lookup, so all
 * of it is testable offline.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const dnsp = require('dns').promises;

const MIN_INTERVAL_MS = 60 * 60e3;   // a scheduled pass at most once an hour, whatever the trigger says
const FORCE_GAP_MS = 5 * 60e3;       // a hand-started pass may not hammer the sources either
const REQUEST_GAP_MS = 2000;
const TIMEOUT_MS = 25000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_SOURCES = 40;
const MAX_KEYWORDS = 100;
const MAX_NEW_PER_SOURCE = 25;
const MAX_BASELINE_HITS = 5;
const SEEN_CAP = 3000;
const SUMMARY_CHARS = 400;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const dirOf = () => path.join(process.env.PROFILE_DIR || '/profiles', 'source-watch');
const stateFile = (wid) => path.join(dirOf(), String(wid || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');

// ── Config ──────────────────────────────────────────────────────────────────────────────

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function normalizeSources(list) {
  const out = []; const ids = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue;
    let u; try { u = new URL(String(s.url || '').trim()); } catch { continue; }
    if (u.protocol !== 'https:' || u.username || u.password) continue;
    if (u.port && u.port !== '443') continue;
    u.hash = '';
    let id = slug(s.id || s.name || u.hostname); if (!id) continue;
    while (ids.has(id)) id = (id + '-x').slice(0, 44);
    ids.add(id);
    out.push({
      id, name: String(s.name || s.id || u.hostname).trim().slice(0, 80), url: u.toString(),
      lang: /^[a-z]{2}$/i.test(String(s.lang || '')) ? String(s.lang).toLowerCase() : '',
      kind: isTelegram(u) ? 'telegram' : 'page',
    });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

function normalizeKeywords(list) {
  const out = []; const seen = new Set();
  for (const k of Array.isArray(list) ? list : String(list || '').split(',')) {
    const w = String(k || '').trim().slice(0, 60); const l = w.toLowerCase();
    if (!w || seen.has(l)) continue;
    seen.add(l); out.push(w);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

const isTelegram = (u) => u.hostname === 't.me' && /^\/s\/[A-Za-z0-9_]{3,64}\/?$/.test(u.pathname);

// ── Network: public https only, checked on every hop ────────────────────────────────────

function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0);
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l);
  }
  return true;   // not an address at all: refuse
}

async function assertPublicUrl(raw, { lookup = (h) => dnsp.lookup(h, { all: true }) } = {}) {
  let u; try { u = new URL(String(raw)); } catch { throw new Error('not a valid address'); }
  if (u.protocol !== 'https:') throw new Error('only https sources are read');
  if (u.username || u.password) throw new Error('an address with credentials is refused');
  if (u.port && u.port !== '443') throw new Error('only the standard https port is read');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.svc|.*\.cluster\.local)$/i.test(host)) throw new Error('an internal host is refused');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host);
  if (!addrs || !addrs.length) throw new Error('the host does not resolve');
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('the host resolves to a private address');
  return u;
}

const WALL_STATUS = new Set([401, 403, 407, 429, 451, 503]);
const WALL_WORDS = /just a moment|attention required|verify you are (a )?human|are you a robot|unusual traffic|captcha|access denied|checking your browser|request blocked|ddos-guard|доступ запрещ|проверка браузера|вы не робот|подозрительн\S* трафик|dostęp zabroniony|nie jesteś robotem/i;

/** A refusal is a status, or a SHORT page that says it is a check. A long news page that mentions a captcha is not. */
function isWall(status, text) {
  if (WALL_STATUS.has(Number(status))) return true;
  const t = String(text || '');
  return t.length < 3000 && WALL_WORDS.test(t);
}

async function readCapped(res) {
  if (!res.body || typeof res.body.getReader !== 'function') return Buffer.from(await res.arrayBuffer()).subarray(0, MAX_BYTES);
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  while (n < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); n += value.length;
  }
  try { await reader.cancel(); } catch { /* already finished */ }
  return Buffer.concat(chunks).subarray(0, MAX_BYTES);
}

function decode(buf, contentType) {
  let cs = (String(contentType || '').match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) cs = (buf.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  try { return new TextDecoder(String(cs || 'utf-8').toLowerCase()).decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
}

/**
 * GET one public page from this process. Redirects are followed by hand so every hop is checked
 * again (a public page must not bounce the request into the cluster).
 */
async function fetchPage(url, { fetchImpl = fetch, lookup, lang = '' } = {}) {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(at, { lookup });
    const res = await fetchImpl(at, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': lang === 'pl' ? 'pl,en;q=0.5' : lang === 'ru' ? 'ru,en;q=0.5' : 'en;q=0.8',
      },
    });
    const status = res.status;
    if (status >= 300 && status < 400 && res.headers.get('location')) {
      at = new URL(res.headers.get('location'), at).toString();
      continue;
    }
    const html = decode(await readCapped(res), res.headers.get('content-type'));
    return { status, html, finalUrl: at };
  }
  throw new Error('too many redirects');
}

// ── Reading a page ──────────────────────────────────────────────────────────────────────

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m;
  });
}
const clean = (html) => decodeEntities(String(html || '')
  .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The visible text of a page, for the wall check. */
const pageText = (html) => clean(String(html || '').replace(/<head\b[\s\S]*?<\/head>/i, ' '));

/** A public Telegram channel's web preview (t.me/s/<name>): one item per post, keyed by its id. */
function extractTelegram(html) {
  const out = [];
  const parts = String(html || '').split(/data-post="/).slice(1);
  for (const p of parts) {
    const post = (p.match(/^([A-Za-z0-9_]{3,64}\/\d{1,12})"/) || [])[1];
    if (!post) continue;
    const body = (p.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const text = clean(body || '');
    if (text.length < 15) continue;
    const when = (p.match(/<time[^>]+datetime="([^"]+)"/) || [])[1] || '';
    out.push({ key: 'tg:' + post, url: 'https://t.me/' + post, title: text.slice(0, 140), summary: text.slice(0, SUMMARY_CHARS), published: when });
  }
  return out;
}

const SKIP_HREF = /^(mailto:|tel:|javascript:|#)|\/(login|logout|register|signin|signup|privacy|cookies?|polityka|regulamin|kontakt|contact|rss|search|szukaj|tag|tags|page\/\d+)(\/|$|\?)/i;
const TRACKING = /^(utm_\w+|fbclid|gclid|yclid|ref|from)$/i;
const baseHost = (h) => String(h || '').toLowerCase().replace(/^(www|m)\./, '');

function canonicalUrl(href, base) {
  let u; try { u = new URL(decodeEntities(href), base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString();
}

/** A news page: its headline links — same site, sentence-length text, menus and footers dropped by the diff. */
function extractHeadlines(html, baseUrl) {
  const out = []; const seen = new Set();
  const home = baseHost(new URL(baseUrl).hostname);
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(String(html || ''))) && out.length < 200) {
    const href = (m[1].match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href || SKIP_HREF.test(href)) continue;
    const url = canonicalUrl(href, baseUrl); if (!url) continue;
    const host = baseHost(new URL(url).hostname);
    if (host !== home && !host.endsWith('.' + home)) continue;
    const text = clean(m[2]);
    if (text.length < 25 || text.length > 300 || text.split(' ').length < 4) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ key: 'url:' + url, url, title: text.slice(0, 200), summary: '', published: '' });
  }
  return out;
}

function extract(source, html) {
  return source.kind === 'telegram' ? extractTelegram(html) : extractHeadlines(html, source.url);
}

function keywordHits(text, keywords) {
  const t = String(text || '').toLowerCase();
  return (keywords || []).filter((k) => t.includes(String(k).toLowerCase()));
}

const urgencyOf = (hits) => (hits.length ? Math.min(5, 2 + hits.length) : 1);

// ── State ───────────────────────────────────────────────────────────────────────────────

function loadState(wid) {
  try { const d = JSON.parse(fs.readFileSync(stateFile(wid), 'utf8')); if (d && d.sources) return d; } catch { /* first pass */ }
  return { sources: {}, lastPassAt: 0 };
}
function saveState(wid, d) {
  try { fs.mkdirSync(dirOf(), { recursive: true, mode: 0o700 }); const t = stateFile(wid) + '.tmp'; fs.writeFileSync(t, JSON.stringify(d), { mode: 0o600 }); fs.renameSync(t, stateFile(wid)); } catch { /* best effort */ }
}

/** Whether a pass may start now. A scheduled pass waits out the hour; a forced one waits out five minutes. */
function mayRun(state, { force = false, now = Date.now() } = {}) {
  const last = Number(state && state.lastPassAt) || 0;
  const gap = force ? FORCE_GAP_MS : MIN_INTERVAL_MS;
  if (now - last >= gap) return { ok: true };
  return { ok: false, why: `the last pass was ${Math.round((now - last) / 60e3)} min ago; ${force ? 'a hand-started pass' : 'a scheduled pass'} waits ${Math.round(gap / 60e3)} min between passes` };
}

// ── A pass ──────────────────────────────────────────────────────────────────────────────

/**
 * Read every source once and file what is new. `feed` is watcherFeed (injected so a test can use a
 * temp dir). Returns a report; per-source status is kept in the state and on the watcher's config.
 */
async function pass(wid, config, { feed, fetchImpl, lookup, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), force = false, log = () => {} } = {}) {
  const sources = normalizeSources(config && config.sources);
  const keywords = normalizeKeywords(config && config.keywords);
  const state = loadState(wid);
  const gate = mayRun(state, { force, now: now() });
  if (!gate.ok) return { ran: false, why: gate.why };
  state.lastPassAt = now();
  saveState(wid, state);   // claimed before the first request, so an overlapping pass sees it

  const report = { ran: true, at: now(), sources: [], filed: 0 };
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (i) await sleep(REQUEST_GAP_MS);
    const st = state.sources[src.id] || { seen: [] };
    const row = { id: src.id, name: src.name, url: src.url, status: 'ok', found: 0, filed: 0, error: '' };
    try {
      const got = await fetchPage(src.url, { fetchImpl, lookup, lang: src.lang });
      if (isWall(got.status, pageText(got.html))) {
        row.status = 'blocked'; row.error = `the server address was refused (HTTP ${got.status})`;
      } else if (got.status >= 400) {
        row.status = 'error'; row.error = `HTTP ${got.status}`;
      } else {
        const items = extract(src, got.html);
        row.found = items.length;
        if (!items.length) { row.status = 'thin'; row.error = 'the page gave nothing to read — it may be built by JavaScript'; }
        const seen = new Set(st.seen || []);
        const baseline = !st.baselineAt;
        let fresh = items.filter((it) => !seen.has(it.key));
        const withHits = fresh.map((it) => ({ it, hits: keywordHits(it.title + ' ' + it.summary, keywords) }));
        const toFile = baseline
          ? withHits.filter((x) => x.hits.length).slice(0, MAX_BASELINE_HITS)
          : withHits.slice(0, MAX_NEW_PER_SOURCE);
        for (const { it, hits } of toFile) {
          const r = feed.upsert(wid, { title: it.title, url: it.url, kind: 'source', fields: { source: src.name, sourceId: src.id, lang: src.lang, published: it.published, baseline } });
          if (r && r.item) feed.mark(wid, r.item.key, { source: src.name, sourceId: src.id, lang: src.lang, summary: it.summary, keywordHits: hits, urgency: urgencyOf(hits), published: it.published });
          row.filed += 1;
        }
        for (const it of items) seen.add(it.key);
        st.seen = [...seen].slice(-SEEN_CAP);
        if (baseline) st.baselineAt = now();
      }
    } catch (e) {
      row.status = /abort|timeout/i.test(e.name + ' ' + e.message) ? 'timeout' : 'error';
      row.error = String(e.message || e).slice(0, 200);
    }
    st.lastAt = now(); st.status = row.status; st.error = row.error; st.found = row.found; st.filed = row.filed;
    state.sources[src.id] = st;
    report.sources.push(row); report.filed += row.filed;
    log(`[source-watch] ${wid}: ${src.id} ${row.status}${row.error ? ' — ' + row.error : ''} (${row.found} read, ${row.filed} filed)`);
  }
  saveState(wid, state);
  return report;
}

/** Per-source standing for the feed response, without the seen-lists. */
function statusOf(wid, config) {
  const state = loadState(wid);
  return {
    lastPassAt: state.lastPassAt || 0,
    sources: normalizeSources(config && config.sources).map((s) => {
      const st = state.sources[s.id] || {};
      return { id: s.id, name: s.name, url: s.url, lang: s.lang, status: st.status || 'not-read-yet', error: st.error || '', lastAt: st.lastAt || 0, found: st.found || 0, filed: st.filed || 0 };
    }),
  };
}

/**
 * Where a request from THIS process leaves the internet. The same fetch a pass uses, so what it
 * answers is the address the sources see. via is always "cluster": this path has no proxy and no
 * device; a caller treats anything else as a failure.
 */
async function egress({ fetchImpl = fetch } = {}) {
  const get = async (u) => { const r = await fetchImpl(u, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': UA, accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  try {
    const j = await get('https://ipinfo.io/json');
    return { ip: String(j.ip || ''), country: String(j.country || ''), org: String(j.org || ''), via: 'cluster' };
  } catch (e) {
    const j = await get('https://api.ipify.org?format=json');
    return { ip: String(j.ip || ''), country: '', org: '', via: 'cluster' };
  }
}

module.exports = {
  pass, statusOf, egress, mayRun, normalizeSources, normalizeKeywords, extract, extractTelegram, extractHeadlines,
  keywordHits, isWall, isPrivateIp, assertPublicUrl, fetchPage, decode, loadState,
  MIN_INTERVAL_MS, FORCE_GAP_MS,
};
