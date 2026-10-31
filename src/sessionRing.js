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
/*
 * MARKETPLACES GO TO THE DEVICE FIRST. Measured 2026-10-31: AliExpress let the server in (200) but
 * served it the English site with foreign prices, while the phone got the Dutch market — the data a
 * Dutch shop is sourced from. A wall is not the only reason to prefer the home connection; for a
 * marketplace the country is the content. (Used only when a device is online; else the server.)
 */
const MARKETPLACES = /(^|\.)(aliexpress\.(com|us|ru)|alibaba\.com|temu\.com|bol\.com|amazon\.[a-z.]+|ebay\.[a-z.]+|etsy\.com|marktplaats\.nl|cjdropshipping\.com|trends\.google\.[a-z.]+)$/i;
const SETTLE_MS = 2500;
const NAV_BUDGET_MS = 48000;   // under the 60 s a client such as Claude gives one tool call

/*
 * A COOKIE BANNER IS THE FIRST THING ON EVERY SHOP — AND ON THE PHONE NOTHING CLICKED IT.
 *
 * The cluster's analyzePage dismisses consent before it looks; the phone path had no such step, so
 * on AliExpress the session sat behind "Akceptuj pliki cookie" and the product cards it was asked to
 * read were under the banner. Accept is pressed after every navigate and before every analyze, in
 * the languages these shops answer in. "All" wins over a plain "accept"; settings buttons never match.
 */
const CONSENT_JS = `(function(){
  var want=[/^(accept|allow|agree to) all( cookies)?$/i,/^alles? (accepteren|toestaan|akzeptieren)$/i,/^alle (cookies )?(accepteren|toestaan|akzeptieren)$/i,/^akceptuj( wszystkie| pliki cookie| wszystko)?$/i,/^zaakceptuj( wszystkie)?$/i,/^tout accepter$/i,/^aceptar( todo| todas)?$/i,/^accetta( tutti)?$/i,
    /^(accept|accepteren|akkoord|i agree|agree|ok|got it|allow|zgadzam si[eę]|akzeptieren|zustimmen|accepter|j'accepte|ja,? (ik ga akkoord|prima))( cookies)?$/i];
  var nodes=[].slice.call(document.querySelectorAll('button,[role=button],a,input[type=button],input[type=submit]'));
  var vis=function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};
  for(var w=0;w<want.length;w++){for(var i=0;i<nodes.length;i++){var e=nodes[i];var t=(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ');
    if(t&&t.length<40&&want[w].test(t)&&vis(e)){e.click();return t}}}
  return ''})()`;

/*
 * WHICH COUNTRY A SHOP SHOWS. A marketplace reads the device's language, so the owner's phone in
 * Polish got AliExpress in Polish with zł prices — for a shop selling in the Netherlands. Where the
 * site keeps that choice in a cookie it is set to the shop's market before the page is read.
 */
const MARKET = { site: 'nld', currency: 'EUR', region: 'NL', locale: 'nl_NL' };
const REGION_JS = {
  // Three cookies, measured 2026-10-31: aep_usuc_f alone was answered with gatewayAdapt=nld2pol (the
  // phone's own language won); with intl_locale + xman_us_f as well the site serves Dutch and euros.
  'aliexpress.com': `(function(){var want='site=${MARKET.site}&c_tp=${MARKET.currency}&region=${MARKET.region}&b_locale=${MARKET.locale}';
    // AliExpress rewrites the cookie in its own order (…&isb=y&region=NL…): check the parts, or every page reloads.
    var c=document.cookie,m=(c.match(/aep_usuc_f=[^;]*/)||[''])[0];
    if(m.indexOf('site=${MARKET.site}')>=0&&m.indexOf('region=${MARKET.region}')>=0&&m.indexOf('b_locale=${MARKET.locale}')>=0&&c.indexOf('intl_locale=${MARKET.locale}')>=0)return '';
    var o='; domain=.aliexpress.com; path=/; max-age=31536000';
    document.cookie='aep_usuc_f='+want+o; document.cookie='intl_locale=${MARKET.locale}'+o;
    document.cookie='xman_us_f=x_l=0&x_locale=${MARKET.locale}&x_c_chg=1'+o; return 'set'})()`,
};
/* …and its own country host, so a redirect to pl./de. cannot undo the choice. */
const marketUrl = (url) => {
  try {
    const u = new URL(url);
    if (/(^|\.)aliexpress\.com$/i.test(u.hostname)) u.hostname = `${MARKET.region.toLowerCase()}.aliexpress.com`;
    return u.href;
  } catch (_) { return url; }
};
const regionScriptFor = (url) => { const h = hostOf(url); const k = Object.keys(REGION_JS).find((d) => h === d || h.endsWith('.' + d)); return k ? REGION_JS[k] : ''; };

const SUBMIT_JS = `(function(){
  var e=document.activeElement; if(!e||e===document.body){e=document.querySelector('input[type=search],input[name*=search i],input[placeholder]')}
  if(!e)return 'no field';
  if(e.form){if(e.form.requestSubmit)e.form.requestSubmit();else e.form.submit();return 'submitted form'}
  ['keydown','keypress','keyup'].forEach(function(t){e.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}))});
  var box=e.closest('header,form,[class*=search i],[role=search]')||document;
  var b=[].slice.call(box.querySelectorAll('button,[role=button],input[type=submit],a')).find(function(x){var t=(x.innerText||x.value||x.getAttribute('aria-label')||x.className||'').toString();return /search|zoek|szukaj|suche|cherch|busca/i.test(t)});
  if(b){b.click();return 'pressed search'} return 'sent enter'})()`;

/*
 * A BROWSER NOBODY HAS DRAWN. Reopened in the background for the ring, the app's WebView may never be laid
 * out: measured 2026-10-31, innerWidth/innerHeight 0, the page fully loaded (20 product links, prices) yet
 * the phone's element scan — which keeps only what is on screen — returned 1 element. So the session can
 * list the page's own links, buttons and fields from the DOM, and act on them through the page itself.
 */
const DOM_LIST_JS = `(function(){
  var sel='a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[contenteditable=true]';
  var out=[];var keep=[];
  [].slice.call(document.querySelectorAll(sel)).forEach(function(e){
    var cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden')return;
    var t=(e.innerText||e.value||'').trim().replace(/\s+/g,' ').slice(0,200);
    var l=(e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.getAttribute('title')||'').slice(0,200);
    if(!t&&!l&&e.tagName!=='INPUT'&&e.tagName!=='TEXTAREA')return;
    keep.push(e); out.push({tag:e.tagName.toLowerCase(),type:e.getAttribute('type')||'',role:e.getAttribute('role')||'',text:t,label:l,href:e.href||''});
  });
  window.__ringEls=keep.slice(0,400); return out.slice(0,400)})()`;
const domClickJs = (i) => `(function(){var e=window.__ringEls&&window.__ringEls[${Number(i)}];if(!e)return 'gone';if(e.scrollIntoView)e.scrollIntoView({block:'center'});e.click();return 'clicked'})()`;
const domTypeJs = (i, text) => `(function(){var e=window.__ringEls&&window.__ringEls[${Number(i)}];if(!e)return 'gone';e.focus();
  var p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(p,'value');
  if(d&&d.set&&e.tagName!=='DIV')d.set.call(e,${JSON.stringify(String(text))});else e.innerText=${JSON.stringify(String(text))};
  e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'typed'})()`;

/* A product page without schema.org markup still names itself in its meta tags and shows a price. */
const PRODUCT_JS = `(function(){
  var out=[];document.querySelectorAll('script[type="application/ld+json"]').forEach(function(n){try{var j=JSON.parse(n.textContent);(Array.isArray(j)?j:(j['@graph']||[j])).forEach(function(x){if(x&&/Product/i.test(String(x['@type'])))out.push(x)})}catch(e){}});
  var m=function(s){var e=document.querySelector(s);return e?(e.getAttribute('content')||e.textContent||'').trim():''};
  var text=(document.body&&document.body.innerText||'');
  var prices=(text.match(/(€|EUR|zł|PLN|\\$|US \\$|£)\\s?\\d{1,4}([.,]\\d{2})?|\\d{1,4}[.,]\\d{2}\\s?(€|zł|EUR|PLN)/g)||[]).slice(0,8);
  var imgs=[].slice.call(document.images).filter(function(i){return i.naturalWidth>=300&&i.naturalHeight>=300}).map(function(i){return i.currentSrc||i.src}).filter(function(s,k,a){return s&&a.indexOf(s)===k}).slice(0,10);
  return {url:location.href,title:m('meta[property="og:title"]')||document.title,description:m('meta[property="og:description"]')||m('meta[name="description"]'),
    image:m('meta[property="og:image"]'),price:m('meta[property="product:price:amount"]')||m('[itemprop=price]'),currency:m('meta[property="product:price:currency"]')||m('[itemprop=priceCurrency]'),
    pricesOnPage:prices,images:imgs,products:out,text:text.slice(0,3000)}})()`;

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
    try {
      const i = await call(s, '/v1/info', {}, 30000);
      // null = no page to ask: the app on the device is closed (Android destroys its browser with it).
      if (!i || typeof i !== 'object') return { url: '', title: '', ready: 'closed' };
      return { url: i.url || '', title: i.title || '', ready: i.ready || '' };
    } catch (_) { return { url: '', title: '', ready: '' }; }
  }
  /*
   * WAIT FOR THE PAGE, AND SAY SO WHEN IT NEVER COMES. Measured 2026-10-31 after midnight: the phone
   * kept polling but its page stayed readyState "loading" with no body — Android pauses a WebView whose
   * app is in the background or whose screen is off. Reading then returned an empty page, which the
   * caller took for "nothing found". Now the session waits for the load and, if it never finishes,
   * answers with what is actually wrong.
   */
  async function loaded(s, maxMs = 20000) {
    const until = now() + maxMs;
    let here = await info(s);
    while (here.ready === 'loading' && now() < until) { await wait(1500); here = await info(s); }
    if (here.ready === 'closed') {
      here.notice = `The Ghost Browser app on ${s.ring.name} is closed, so there is no browser to load the page in. Ask the owner to open the app once (the phone may be locked after that), then try again.`;
    } else if (here.ready === 'loading') {
      here.notice = `The page is still loading on ${s.ring.name}. Ask the owner to make sure the Ghost Browser app is open (it may be in the background, the phone may be locked), then try again.`;
    }
    return here;
  }
  /** Press the cookie banner's accept, if there is one. Returns the button text it pressed. */
  async function acceptCookies(s) {
    try {
      const t = await call(s, '/v1/eval', { code: CONSENT_JS }, 30000);
      const pressed = typeof t === 'string' ? t : '';
      if (pressed) { log.info?.(`[ring] session ${s.id}: accepted cookies ("${pressed}")`); await wait(1200); }
      return pressed;
    } catch (_) { return ''; }   // an older app without eval: the caller can still analyze and click
  }

  return {
    hostOf,
    looksWalled,
    /** Has this host walled us recently, or is it a marketplace? Then go straight to a device. */
    knownWall(url) {
      if (MARKETPLACES.test(hostOf(url))) return 'marketplaces show the shop’s own country, prices and stock only to a home connection';
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

    /*
     * EVERY STEP ANSWERS WITHIN A CLIENT'S PATIENCE. Claude gives a tool 60 s (measured: "browser_navigate
     * timed out after 60s"), and a phone navigate could take 31 s twice plus waits. So a navigate spends at
     * most NAV_BUDGET_MS; a page still loading then is reported as such — the phone keeps loading it, and the
     * next read or analyze picks it up — instead of the call being cut off with nothing.
     */
    async navigate(s, asked) {
      const url = marketUrl(asked);
      const deadline = now() + NAV_BUDGET_MS;
      const left = () => deadline - now();
      await call(s, '/v1/navigate', { url }, Math.max(5000, left() - 8000));
      // The shop's market, not the phone's language: set it once (it sticks), then load the page with it.
      const region = regionScriptFor(url);
      if (region && left() > 20000) {
        const set = await call(s, '/v1/eval', { code: region }, 15000).catch(() => '');
        if (set === 'set' && left() > 20000) await call(s, '/v1/navigate', { url }, Math.max(5000, left() - 8000));
      }
      await loaded(s, Math.max(0, left() - 6000));
      const cookies = left() > 3000 ? await acceptCookies(s) : '';
      const here = await info(s);
      if (here.ready === 'loading') here.notice = `Still loading on ${s.ring.name}. It keeps loading there — call browser_read or browser_analyze in a few seconds.`;
      else if (here.ready === 'closed') here.notice = (await loaded(s, 0)).notice;
      s.ring.elements = [];
      return { url: here.url || url, status: null, title: here.title, onDevice: s.ring.name,
        ...(cookies ? { acceptedCookies: cookies } : {}), ...(here.notice ? { notice: here.notice } : {}) };
    },
    async content(s) {
      const first = await loaded(s, 15000);
      if (first.notice) return { url: first.url, title: '', chars: 0, content: '', onDevice: s.ring.name, notice: first.notice };
      const t = await call(s, '/v1/content');
      const text = typeof t === 'string' ? t : String((t && (t.text || t.content)) || '');
      const here = await info(s);
      return { url: here.url, title: here.title, chars: text.length, content: text.slice(0, 200000), onDevice: s.ring.name };
    },
    async analyze(s) {
      const first = await loaded(s, 15000);
      if (first.notice) return { url: first.url, title: '', elementCount: 0, elements: [], summary: '', screenshot: null, onDevice: s.ring.name, notice: first.notice };
      await acceptCookies(s);
      let elements = toElements(await call(s, '/v1/analyze'));
      s.ring.mode = 'screen';
      if (elements.length < 5) {
        // Nothing (or next to nothing) on screen: list the page itself and act through it.
        const dom = toElements(await call(s, '/v1/eval', { code: DOM_LIST_JS }).catch(() => []));
        if (dom.length > elements.length) { elements = dom; s.ring.mode = 'dom'; }
      }
      s.ring.elements = elements;
      const here = await info(s);
      const summary = elements.slice(0, 150).map((e) => `[${e.index}] ${e.tag}${e.role ? `(${e.role})` : ''} ${e.text || e.label}`.trim()).join('\n');
      return { url: here.url, title: here.title, elementCount: elements.length, elements, summary, screenshot: null, onDevice: s.ring.name };
    },
    async click(s, { index, text }) {
      if (text) await call(s, '/v1/click_text', { text: String(text) });
      else if (s.ring.mode === 'dom') await call(s, '/v1/eval', { code: domClickJs(Number(index) - 1) });
      else await call(s, '/v1/click', { index: Number(index) - 1 });
      await wait(1500);
      const here = await info(s);
      return { clicked: text ? { text } : { index: Number(index) }, url: here.url, onDevice: s.ring.name };
    },
    async type(s, { index, text = '', submit = false }) {
      if (s.ring.mode === 'dom') await call(s, '/v1/eval', { code: domTypeJs(Number(index) - 1, text) });
      else await call(s, '/v1/type', { index: Number(index) - 1, text: String(text) });
      if (submit) {
        // The phone's type has no Enter key. Do what Enter does: submit the field's form; a search bar
        // that is no form (AliExpress) gets the key events, then its own search button is pressed.
        await call(s, '/v1/eval', { code: SUBMIT_JS }).catch(() => null);
        await wait(SETTLE_MS);
        await acceptCookies(s);
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
    /** The product on the page: schema.org markup when it has it, else its meta tags, visible prices and large images. */
    async product(s) {
      await acceptCookies(s);
      const r = await call(s, '/v1/eval', { code: PRODUCT_JS });
      return { ...(r && typeof r === 'object' ? r : { raw: r }), onDevice: s.ring.name };
    },
  };
}

module.exports = { createSessionRing, looksWalled, unwrap, toElements, hostOf, regionScriptFor, marketUrl, WALL_STATUS, CONSENT_JS, PRODUCT_JS };
