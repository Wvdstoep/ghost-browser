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

/*
 * A SIGN-IN PAGE WHERE A LOGIN WAS EXPECTED. Measured 2026-11-04: the owner signed in to Google in the
 * "default" profile on the phone, but the cluster's "default" had no Google session (a Google login does
 * not travel with a cookie sync), so Merchant Center answered with its public page and the sign-in form.
 * That is not a wall — the site lets the server in — but the login lives on the device. When the device
 * holds the same profile, the session moves there (the server decides, sessionRing only recognises it).
 */
const SIGNIN_HOSTS = /^(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|www\.facebook\.com|m\.facebook\.com|www\.linkedin\.com|www\.amazon\.[a-z.]+|login\.aliexpress\.com)$/i;
const SIGNIN_PATH = /(^|\/)(signin|sign-in|login|log-in|logon|servicelogin|accountchooser|identifier|checkpoint|uas\/login|ap\/signin)(\/|$|\?)/i;
const SIGNIN_TITLE = /^(sign in|log in|login|inloggen|aanmelden|zaloguj|anmelden|se connecter|iniciar sesi[oó]n)\b|sign in - google accounts|inloggen - google-accounts/i;
function signInPage({ url = '', title = '' } = {}) {
  let u; try { u = new URL(url); } catch (_) { return ''; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname + (u.search ? '?' : '');
  if ((SIGNIN_HOSTS.test(host) && SIGNIN_PATH.test(path)) || (SIGNIN_PATH.test(path) && SIGNIN_TITLE.test(String(title).trim()))) {
    return `${host} asked to sign in`;
  }
  return '';
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
    // Where it is, in the cluster's terms (box + centre); the phone's scan has it, the page list does not.
    ...(Number.isFinite(e.x) && Number.isFinite(e.y) ? {
      left: e.x, top: e.y, width: Number(e.w) || 0, height: Number(e.h) || 0,
      x: Math.round(e.x + (Number(e.w) || 0) / 2), y: Math.round(e.y + (Number(e.h) || 0) / 2),
    } : {}),
  }));
}

/*
 * WHAT A NUMBERED ELEMENT HOLDS AND WHETHER IT CAN BE USED (ringPage.fieldsJs). The phone's scan names a
 * field by its value or its placeholder in one `text`, never says a button is disabled — which is how the
 * disabled "Get started" of 2026-11-19 stayed invisible — and a password's value would have been its text.
 */
function withField(e, f, ih) {
  if (!f || typeof f !== 'object') return e;
  const out = { ...e, disabled: !!f.disabled };
  if (f.placeholder) out.placeholder = String(f.placeholder).slice(0, 200);
  if (f.password) { out.filled = !!f.filled; out.text = e.label || f.placeholder || 'password'; }
  else if (typeof f.value === 'string') {
    out.value = f.value;
    // The scan's text of a field IS its value; name it by its label or placeholder instead.
    if (f.value && e.text === f.value.replace(/\s+/g, ' ').trim().slice(0, e.text.length)) out.text = e.label || f.placeholder || '';
  }
  if (typeof f.checked === 'boolean') out.checked = f.checked;
  if (f.required) out.required = true;
  if (f.invalid) out.invalid = true;
  if (Number.isFinite(ih) && Number.isFinite(e.top)) out.visible = e.top < ih && e.top + (e.height || 0) > 0;
  return out;
}

/** Width of a PNG or JPEG, from its header (0 when unknown): a spot on a screenshot is in its pixels. */
function imageWidth(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return 0;
  if (buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16);
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return buf.readUInt16BE(i + 7);
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return 0;
}

/*
 * THE CONSOLE IS SHOWN FOR THE ACCOUNT'S OWN APPS ONLY. A page logs whatever it likes, and on a site the
 * owner is signed in to that includes tokens, ids and personal data (diagnostics.js: the owner's decision,
 * the cluster's console is QA's alone, for our own freshly built apps). An app on the platform
 * (<app>.<account>.my-app.engineer) is that case; any other site is refused, with the reason.
 */
const OWN_APP_HOST = /^[a-z0-9-]+\.[a-z0-9-]+\.my-app\.engineer$/i;
function consoleAllowed(url, extra = process.env.GB_CONSOLE_HOSTS || '') {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return false; }
  if (OWN_APP_HOST.test(host)) return true;
  return String(extra).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
    .some((h) => host === h || host.endsWith(`.${h}`));
}

const consoleRefusal = (url) => `The console is shown only for your own apps on my-app.engineer (this page is ${(() => { try { return new URL(url).hostname; } catch (_) { return 'not one'; } })()}): other sites log sign-in tokens and personal data into it. Open your app's page first.`;

const page = require('./ringPage');
const UPLOAD_CHUNK = 512 * 1024;

/*
 * KEYS OR INSERT (2026-11-20). Real key presses stay for short plain text (a search box whose suggestions
 * answer keys); long text, and text with a letter the phone's keymap has no key for (ą, ę, ł, emoji), is
 * inserted. Key by key cost ~60 ms a character on Facebook's post box, so a post stopped at ~2,000.
 */
const KEYED_MAX = 300;
const INSERT_PIECE = 800;
const keyable = (t) => String(t).length <= KEYED_MAX && /^[\x20-\x7e\n\t]*$/.test(String(t));
/** Pieces of at most n characters, never splitting an emoji or another two-unit character. */
function pieces(t, n) {
  const chars = Array.from(String(t)); const out = [];
  for (let k = 0; k < chars.length; k += n) out.push(chars.slice(k, k + n).join(''));
  return out;
}
/** Did the field get the whole text? Spacing and line breaks may be rendered differently by an editor. */
function arrived(got, want) {
  const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const g = norm(got); const w = norm(want);
  return !w || g === w || g.endsWith(w) || (g.includes(w.slice(-60)) && g.length >= w.length * 0.97);
}

const { deviceProfileFor, baseName } = require('./deviceProfile');

function createSessionRing({ run, pickDevice, log = console, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const walledHosts = new Map(); // host -> { until, why }

  const call = async (s, path, body = {}, timeoutMs = 120000) => unwrap(await run(s.ring.deviceId,
    { method: 'POST', path, body: s.ring.profile ? { ...body, profile: s.ring.profile } : body }, timeoutMs));

  async function info(s) {
    try {
      const i = await call(s, '/v1/info', {}, 30000);
      // null = no page to ask: the app on the device is closed (Android destroys its browser with it).
      if (!i || typeof i !== 'object') return { url: '', title: '', ready: 'closed' };
      if (i.url && s.ring) s.ring.lastUrl = i.url;
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
  /*
   * A HUMAN CHECK IS NOT A PAGE. Measured 2026-10-31: after many visits AliExpress answered a product
   * click with its slider check (/_____tmd_____/punish). Read as a product it came back empty. Say what it
   * is: the owner solves it once in the Ghost Browser app (the same cookies), the session never tries to.
   */
  async function humanCheck(s, here) {
    if (/\/_____tmd_____\/|\/punish\b|x5secdata|captcha|challenge/i.test(here.url || '')) return true;
    const t = await call(s, '/v1/eval', { code: '(document.title+"\\n"+(document.body?document.body.innerText.slice(0,1500):""))' }, 15000).catch(() => '');
    return typeof t === 'string' && t.length < 1500 && WALL_WORDS.test(t);
  }
  /*
   * THE OWNER HEARS IT ON THE PHONE (2026-11-20): a check or a stuck browser needs the owner to open the app,
   * and the person the session talks to is often not holding the phone. The phone shows a notification
   * (app 0.99+; an older app answers "unsupported", which is fine). Once per kind per session in 10 minutes.
   */
  async function notify(s, tag, title, text) {
    const seen = s.ring.notified || (s.ring.notified = {});
    if (seen[tag] && now() - seen[tag] < 10 * 60 * 1000) return false;
    seen[tag] = now();
    try { const r = await call(s, '/v1/notify', { tag, title, text }, 15000); return !!(r && r.notified); } catch (_) { return false; }
  }
  const checkNotice = (s) => {
    let site = ''; try { site = hostOf(s.ring.lastUrl || ''); } catch (_) { /* unknown */ }
    notify(s, 'check', 'A site wants a check', `${site || 'A site'} asks to verify you are human. Tap to open Ghost Browser and solve it once.`).catch(() => {});
    return `${s.ring.name} was shown a "verify you are human" check by this site. Do not try to solve it: the owner was sent a notification on ${s.ring.name} (app 0.99 or newer); they open the Ghost Browser app there and solve it once. browser_status says when it is gone.`;
  };

  /** Run a script in the page; its value, or null when the page (or an older app) could not answer. */
  async function ask(s, code, ms = 30000) {
    try { const v = await call(s, '/v1/eval', { code }, ms); return v === undefined || v === '' ? null : v; } catch (_) { return null; }
  }
  const askObj = async (s, code, ms) => { const v = await ask(s, code, ms); return v && typeof v === 'object' ? v : null; };

  /*
   * BEFORE A TAP (ringPage.stateJs): gone, disabled, deaf to taps or covered → say so instead of tapping
   * nothing and answering "clicked". A disabled one gets the chance a person gives it: the field the cursor
   * is in is left, and the button is watched for two seconds. null = go ahead (also when the page cannot
   * tell: an element in a frame, an app without page scripts).
   */
  async function refusal(s, ref, what, seen = {}) {
    let st = await askObj(s, page.stateJs(ref, { release: true }));
    const released = !!(st && st.released);
    for (let k = 0; k < 4 && st && (st.disabled || (st.inert && !st.point)); k += 1) { await wait(500); st = await askObj(s, page.stateJs(ref)); }
    seen.st = st;
    if (!st || st.unknown) return null;
    if (st.gone) return { error: `${what} is no longer on the page (it changed since browser_analyze). Call browser_analyze again.` };
    if (st.disabled) {
      return { error: `${what} is disabled${released ? ', also after leaving the field the cursor was in' : ''}: the form is not complete or not valid yet. Fill in what it asks for (browser_read or browser_screenshot shows the message), then click again.`, disabled: true };
    }
    if (st.inert && !st.point) return { error: `${what} does not take clicks right now (pointer-events: none) and nothing under it on screen does. Wait for the page, or call browser_analyze again.` };
    if (st.cover) return { error: `${what} is covered by <${st.cover}>: a dialog, banner or overlay is on top of it. Close that first, or call browser_analyze again.`, coveredBy: st.cover };
    return null;
  }
  /** The app's own trusted tap on element `deviceIndex` (0-based, or a ringPage slot). An error = nothing was tapped. */
  async function tap(s, deviceIndex) {
    const r = await call(s, '/v1/click', { index: deviceIndex });
    if (r && typeof r === 'object' && (r.err || r.error)) return { error: `the device found nothing to tap there (${r.err || r.error}). Call browser_analyze again.` };
    return null;
  }

  /*
   * The tap itself. An element sticking out of the screen (a menu that opens below it) is tapped on its part
   * that is shown; one with nothing on screen is clicked by script, and the answer says so (stateJs).
   */
  async function press(s, ref, deviceIndex, st) {
    const spot = st && (st.part || (st.inert && st.point));
    if (spot) {
      const p = await askObj(s, page.pointJs(spot.x, spot.y));
      if (!p || p.error) return { no: { error: 'the device could not be asked where to tap. Call browser_analyze again.' } };
      const missed = await tap(s, page.SPOT);
      if (missed) return { no: missed };
      if (st.inert) return { how: `it takes no clicks itself (pointer-events: none), so its spot was tapped, as a finger would: that reaches <${st.reach}>` };
      if (st.nested) return { how: `<${st.nested}> sits over its centre, so a free spot of it was tapped` };
      return { how: 'tapped the part of it that is on screen' };
    }
    if (st && st.offscreen) {
      const r = await askObj(s, page.scriptClickJs(ref));
      if (!r || r.error) return { no: { error: 'it is outside the screen and could not be clicked. Scroll (browser_scroll) or call browser_analyze again.' } };
      return { how: 'it is outside the screen (a menu or layer that does not scroll), so it was clicked by script instead of a tap; check the result with browser_screenshot' };
    }
    const missed = await tap(s, deviceIndex);
    return missed ? { no: missed } : {};
  }

  /*
   * Text that is long or holds a letter without a key goes in by the browser's insert command (ringPage,
   * LINE_BREAK_JS): the app's real tap focuses and empties the field, then the text arrives line by line in
   * pieces, and what the field holds afterwards is compared with what was asked. A part that did not arrive
   * is an error that says how much did, never "typed".
   */
  async function insertText(s, i, txt) {
    await call(s, '/v1/type', { index: i, text: '' });
    const f = await askObj(s, page.focusInJs(page.elementRef(s.ring.mode, i)));
    if (!f || !f.focused) return { error: `the field could not be focused on ${s.ring.name}. Call browser_analyze and type into the field by its number again.` };
    const lines = txt.split('\n');
    for (let n = 0; n < lines.length; n += 1) {
      if (n > 0) {
        const br = await askObj(s, page.LINE_BREAK_JS);
        if (!br || br.error || !br.ok) return { error: `typing stopped at line ${n + 1} of ${lines.length}: the field took no line break${br && br.error ? ` (${br.error})` : ''}.`, landed: await landed(s) };
      }
      for (const piece of pieces(lines[n], INSERT_PIECE)) {
        const r = await askObj(s, page.insertTextJs(piece));
        if (!r || r.error || !r.changed) return { error: `typing stopped at line ${n + 1} of ${lines.length}: the field took no more text${r && r.error ? ` (${r.error})` : ''}.`, landed: await landed(s) };
      }
    }
    const got = await landed(s);
    if (!arrived(got.text, txt)) return { error: `only ${got.length} of ${txt.length} characters arrived in the field on ${s.ring.name}. Read the field (browser_analyze) before typing again, so nothing goes in twice.`, landed: got };
    return { landed: { length: got.length } };
  }
  async function landed(s) {
    const r = await askObj(s, page.FIELD_TEXT_JS);
    const text = r && typeof r.text === 'string' ? r.text : '';
    return { text, length: text.length };
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

    signInPage,
    /**
     * Move this session to a device with a home connection. Returns the device, or null when none is online.
     * `device` is one the caller already chose (browser_open { device }, or the device that holds a login).
     */
    attach(s, owners, { device = null } = {}) {
      if (s.ring) return s.ring;
      const dev = device || pickDevice(owners, { profile: s.profile });
      if (!dev) return null;
      // The device runs the session in the profile the session was opened with, under the name the device
      // holds it by (deviceProfile.js). One it does not hold goes as the plain name: the app refuses it and
      // says how to add it, instead of opening an empty store.
      const prof = String(s.profile || 'default');
      const held = deviceProfileFor(dev.caps, prof) || baseName(prof);
      s.ring = { deviceId: dev.deviceId, name: dev.name, elements: [], profile: held === 'default' ? '' : held };
      /* The cloud copy of the page goes blank (2026-11-21): a site left open there keeps calling home with the
         session's cookies from the datacenter (Facebook polls for chat and notifications) while the device works. */
      try { if (s.page && typeof s.page.goto === 'function' && !(s.page.isClosed && s.page.isClosed())) s.page.goto('about:blank').catch(() => {}); } catch (_) { /* nothing open */ }
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
      /*
       * THE PAGE IT WAS ASKED FOR, NOT THE ONE IT HAD. Measured 2026-11-19: the first navigate of a new session
       * answered with the previous session's Product Hunt page, and the app asked for never got a request.
       * A navigation is a new document with a new timeOrigin; the same timeOrigin after it means nothing
       * loaded. Then it is asked once more, and if the device still stays, that is the answer, not the old page.
       */
      const was = await ask(s, page.LOADED_AT_JS, 10000);
      await call(s, '/v1/navigate', { url }, Math.max(5000, left() - 8000));
      if (typeof was === 'number' && left() > 15000 && await ask(s, page.LOADED_AT_JS, 10000) === was) {
        log.info?.(`[ring] session ${s.id}: ${s.ring.name} did not load ${url}; asking again`);
        await call(s, '/v1/navigate', { url }, Math.max(5000, left() - 8000));
        /* Still the same page (after a Facebook search, 2026-11-20, every navigate of every new session stayed
           there): the page itself is told to go, which a page whose own routing holds the browser obeys. */
        if (await ask(s, page.LOADED_AT_JS, 10000) === was && left() > 12000) {
          log.info?.(`[ring] session ${s.id}: ${s.ring.name} still stayed; the page itself goes to ${url}`);
          await ask(s, page.goJs(url), 10000);
          await wait(2500);
        }
        if (await ask(s, page.LOADED_AT_JS, 10000) === was) {
          const stuck = await info(s);
          notify(s, 'stuck', 'Ghost Browser is stuck', `It stayed on ${hostOf(stuck.url || '') || 'a page'} and cannot open the next one. Tap to open the app once, that wakes it.`).catch(() => {});
          return { error: `${s.ring.name} stayed on ${stuck.url || 'its previous page'} and did not open ${url}, also when the page itself was told to go. Ask the owner to open the Ghost Browser app on ${s.ring.name} once (that wakes its browser), then call browser_navigate again.`,
            stuck: true, url: stuck.url || '', title: stuck.title || '', onDevice: s.ring.name };
        }
      }
      if (s.ring.console) await ask(s, page.CONSOLE_JS, 10000);   // an older app: catch this page's errors from now on
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
      else if (here.ready !== 'closed' && await humanCheck(s, here)) here.notice = checkNotice(s);
      else if (here.ready === 'closed') here.notice = (await loaded(s, 0)).notice;
      s.ring.elements = [];
      return { url: here.url || url, status: null, title: here.title, onDevice: s.ring.name,
        ...(cookies ? { acceptedCookies: cookies } : {}), ...(here.notice ? { notice: here.notice } : {}) };
    },
    /* Where the session is and whether a human check is still up (after the owner was asked to solve it). */
    async status(s) {
      const here = await info(s);
      const check = here.ready !== 'closed' && here.url ? await humanCheck(s, here) : false;
      return { url: here.url, title: here.title, ready: here.ready || '', humanCheck: !!check, onDevice: s.ring.name,
        ...(here.ready === 'closed' ? { notice: `the Ghost Browser app on ${s.ring.name} is closed; it opens again on the next command` } : {}) };
    },
    /* Wait until a text is on the page (at most 60 s), then where it is and the link nearest to it. */
    async waitFor(s, text, timeoutMs = 20000) {
      const until = now() + Math.max(1000, Math.min(60000, Number(timeoutMs) || 20000));
      let r = null;
      do {
        r = await askObj(s, page.waitTextJs(text), 10000);
        if (r && r.found) return { found: true, url: r.url || '', ...(r.link ? { link: r.link } : {}), ...(r.near ? { near: r.near } : {}), onDevice: s.ring.name };
        if (now() >= until) break;
        await wait(1000);
      } while (now() < until);
      return { found: false, url: (r && r.url) || (await info(s)).url, onDevice: s.ring.name, error: `"${String(text).slice(0, 80)}" did not appear on the page within ${Math.round((Number(timeoutMs) || 20000) / 1000)} s` };
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
      // Disabled, value, placeholder, ticked, on screen: per element of the top page (frames keep the scan's).
      const st = await askObj(s, page.fieldsJs(s.ring.mode), 20000);
      if (st && Array.isArray(st.fields)) elements = elements.map((e, n) => withField(e, st.fields[n], Number(st.ih)));
      s.ring.elements = elements;   // the full list: a click by number resolves against it
      const { kept, merged } = require('./repeats').collapseRepeats(elements);
      const here = await info(s);
      const summary = kept.slice(0, 150).map((e) => `[${e.index}] ${e.tag}${e.role ? `(${e.role})` : ''} ${e.text || e.label || e.placeholder || ''}`.trim()
        + (e.value ? ` = "${String(e.value).slice(0, 60)}"` : '') + (e.password ? (e.filled ? ' (filled)' : ' (empty)') : '')
        + (e.checked ? ' (checked)' : '') + (e.disabled ? ' (disabled)' : '')).join('\n');
      const files = st && Number(st.fileInputs) > 0 ? Number(st.fileInputs) : 0;
      return { url: here.url, title: here.title, elementCount: kept.length, elements: kept, summary, screenshot: null, onDevice: s.ring.name,
        ...(merged.length ? { repeatsMerged: merged.length } : {}),
        ...(files ? { fileInputs: files, hint: `${files} file field(s) on this page, maybe hidden behind an upload button: browser_upload_file with the number of that button puts a kept file in.` } : {}) };
    },
    async click(s, { index, text }) {
      const before = (await info(s)).url;
      let how = '';
      const at = (r) => ({ ...r, onDevice: s.ring.name });
      if (text) {
        // The copy that is shown and on top (ringPage.findTextJs), tapped by the app; frames go the old way.
        const found = s.ring.mode === 'dom' ? null : await askObj(s, page.findTextJs(String(text)));
        if (found && found.found) {
          const seen = {};
          const no = await refusal(s, page.slotRef(page.PICK), `"${text}"`, seen);
          if (no) return at(no);
          const done = await press(s, page.slotRef(page.PICK), page.PICK, seen.st);
          if (done.no) return at(done.no);
          how = done.how || '';
        } else if (found && found.covered) {
          return at({ error: `every shown copy of "${text}" is covered by <${found.covered}>: a dialog, banner or overlay is on top. Close it first, or call browser_analyze.` });
        } else if (found && found.notfound && found.hidden > 0) {
          return at({ error: `"${text}" is on the page only in copies that are hidden (another layout or a closed panel). Call browser_analyze and click the shown one by its number.` });
        } else {
          const r = await call(s, '/v1/click_text', { text: String(text) });
          if (r && typeof r === 'object' && (r.err || r.error)) {
            return at({ error: /notfound/.test(String(r.err || r.error)) ? `nothing showing "${text}" was found on the page` : `the device could not click "${text}" (${r.err || r.error})` });
          }
        }
      } else {
        const i = Number(index) - 1;
        const seen = {};
        const no = await refusal(s, page.elementRef(s.ring.mode, i), `element [${index}]`, seen);
        if (no) return at({ ...no, index: Number(index) });
        if (s.ring.mode === 'dom') await call(s, '/v1/eval', { code: domClickJs(i) });
        else {
          const done = await press(s, page.elementRef(s.ring.mode, i), i, seen.st);
          if (done.no) return at({ ...done.no, index: Number(index) });
          how = done.how || '';
        }
      }
      await wait(1500);
      let here = await info(s);
      /*
       * A LINK THAT WAS CLICKED GOES WHERE IT POINTS. Measured 2026-10-31 on the phone's invisible service
       * browser: a tap on an AliExpress product card left the search page as it was (shops open products in
       * a new tab or behind script handlers). When a click on a link changed nothing, open its address —
       * what a person achieves by clicking it.
       */
      const el = !text && (s.ring.elements || [])[Number(index) - 1];
      // Shops write links without a scheme (AliExpress: "//nl.aliexpress.com/item/…") or relative to the page.
      let target = '';
      try { target = el && el.href ? new URL(el.href, before || undefined).href : ''; } catch (_) { target = ''; }
      if (/^https?:\/\//i.test(target) && here.url === before) {
        await call(s, '/v1/navigate', { url: target }, 40000);
        await loaded(s, 12000);
        here = await info(s);
      }
      const said = how ? { how } : {};
      if (await humanCheck(s, here)) return { clicked: text ? { text } : { index: Number(index) }, url: here.url, onDevice: s.ring.name, ...said, notice: checkNotice(s) };
      return { clicked: text ? { text } : { index: Number(index) }, url: here.url, onDevice: s.ring.name, ...said };
    },
    async type(s, { index, text = '', submit = false, commit = true }) {
      const txt = String(text);
      let inserted = null;
      if (s.ring.mode === 'dom') await call(s, '/v1/eval', { code: domTypeJs(Number(index) - 1, txt) });
      else if (keyable(txt)) await call(s, '/v1/type', { index: Number(index) - 1, text: txt });
      else {
        inserted = await insertText(s, Number(index) - 1, txt);
        if (inserted.error) return { ...inserted, index: Number(index), onDevice: s.ring.name };
      }
      /* The form hears that the field was left (ringPage.COMMIT_JS), so a check on blur runs and a button it
         holds disabled comes free; the cursor stays, so an Enter after this still goes into the field. */
      const committed = commit !== false || submit ? await ask(s, page.COMMIT_JS) : null;
      if (submit) {
        if (committed === 'committed') await wait(300);
        /* A real Enter on the phone (app 0.95+), into whatever has focus — a form in a frame included.
           Measured 2026-11-10: the script below runs in the top page only, so on Google's profile editor
           its Enter went into Google's own search box. An older app has no key: then do what Enter does —
           submit the field's form; a search bar that is no form (AliExpress) gets the key events, then its
           own search button is pressed. */
        const pressed = await call(s, '/v1/key', { key: 'Enter' }, 30000).then(() => true).catch(() => false);
        if (!pressed) await call(s, '/v1/eval', { code: SUBMIT_JS }).catch(() => null);
        await wait(SETTLE_MS);
        await acceptCookies(s);
      }
      const here = await info(s);
      return { typed: txt.length, mode: inserted ? 'insert' : 'type', url: here.url, onDevice: s.ring.name,
        ...(inserted ? { landed: inserted.landed } : {}), ...(typeof committed === 'string' ? { committed } : {}) };
    },
    /*
     * One real key on the phone (Enter, Tab, Escape, ArrowDown …), into whatever has focus. The phone has no
     * modifier keys: Control+A and Shift+Tab are done the way the page would see them, a single character is
     * typed at the cursor, and any other combination is refused with what does work.
     */
    async key(s, key) {
      const k = String(key);
      const parts = k === '+' ? ['+'] : k.split('+');
      let name = parts.pop(); const mods = parts.map((m) => m.toLowerCase());
      if (name === ' ') name = 'Space';
      const done = async (extra = {}) => ({ url: (await info(s)).url, pressed: k, onDevice: s.ring.name, ...extra });
      if (mods.length) {
        if (/^a$/i.test(name) && mods.every((m) => m === 'control' || m === 'meta')) return done({ did: await ask(s, page.SELECT_ALL_JS) });
        if (/^tab$/i.test(name) && mods.length === 1 && mods[0] === 'shift') return done({ did: await ask(s, page.FOCUS_PREVIOUS_JS) });
        return { error: `${k} cannot be pressed on ${s.ring.name}: of the key combinations only Control+A and Shift+Tab work on a device. Use one key (Tab, Enter, Escape, Back, Backspace, the arrows, Space …), or give text to type.`, onDevice: s.ring.name };
      }
      /* The phone's Back button (2026-11-20): on a mobile site it closes the sheet, dialog or menu that is open
         (they put themselves in the history so Back can), else goes back a page. Escape closes none of those. */
      if (/^(back|browserback|goback)$/i.test(name)) {
        const did = await ask(s, page.BACK_JS);
        await wait(1200);
        return done({ did: did || 'went back' });
      }
      if (name.length === 1) return { ...(await this.keyText(s, name)), pressed: k };
      await call(s, '/v1/key', { key: name }, 30000);
      return done();
    },
    /** Text typed at the cursor of whatever has focus (press_key { text }). */
    async keyText(s, text) {
      const r = await askObj(s, page.insertTextJs(String(text)));
      if (!r) return { error: `the page on ${s.ring.name} could not be asked; type into a numbered field with browser_type`, onDevice: s.ring.name };
      if (r.error) return { error: r.error, onDevice: s.ring.name };
      const here = await info(s);
      return { url: here.url, into: r.into, changed: !!r.changed, length: Number(r.length) || 0, onDevice: s.ring.name };
    },
    /*
     * FOR CODE THAT DRIVES A PAGE ITSELF (ringPlaywright.js, 2026-11-21): the post watcher runs on the phone that
     * holds the login instead of on the cluster with a copy of it. A script's value (null when the page could not
     * answer), and the app's own tap on an element a script put in slot `n`, with the same checks as a click.
     */
    async evaluate(s, code, ms = 30000) { return ask(s, code, ms); },
    async pressSlot(s, n, what = 'element') {
      const seen = {};
      const no = await refusal(s, page.slotRef(n), what, seen);
      if (no) return no;
      const done = await press(s, page.slotRef(n), n, seen.st);
      return done.no || { pressed: true, ...(done.how ? { how: done.how } : {}) };
    },
    /** A tap at a spot of the last screenshot (its pixels), by the app's own tap. */
    async clickAt(s, x, y) {
      if (s.ring.mode === 'dom') return { error: `the page on ${s.ring.name} is not drawn on its screen, so there is no spot to tap. Click a numbered element instead.`, onDevice: s.ring.name };
      const spot = await askObj(s, page.spotJs(x, y, s.ring.shotWidth));
      if (!spot) return { error: `the page on ${s.ring.name} could not be asked. Click a numbered element, or by its text.`, onDevice: s.ring.name };
      if (spot.error === 'outside') return { error: `(${x}, ${y}) is outside the page on the screen: take browser_screenshot and use its pixels.`, onDevice: s.ring.name };
      if (spot.error) return { error: `cannot tap a spot on ${s.ring.name} (${spot.error})`, onDevice: s.ring.name };
      const missed = await tap(s, page.SPOT);
      if (missed) return { ...missed, onDevice: s.ring.name };
      await wait(1200);
      const here = await info(s);
      return { clicked: { x: Number(x), y: Number(y) }, at: spot.at || '', url: here.url, onDevice: s.ring.name };
    },
    /** The page's pictures, numbered as browser_images numbers them on the server. */
    async images(s) {
      const list = await ask(s, page.IMAGES_JS);
      const here = await info(s);
      const images = (Array.isArray(list) ? list : []).map((i) => ({ ...i, src: i.inline ? 'data: (inline picture: save it by its number)' : i.src }));
      return { url: here.url, images, onDevice: s.ring.name, hint: 'browser_save_image with image=<number> keeps one and returns its fileId' };
    },
    /** Where picture `n` comes from: an address the server can fetch, or the picture itself when it lives only in the page. */
    async imageSource(s, n) {
      const list = await ask(s, page.IMAGES_JS);
      const it = (Array.isArray(list) ? list : []).find((i) => i.image === Number(n));
      if (!it) return null;
      if (!it.inline) return { src: it.src, referer: (await info(s)).url };
      const data = await ask(s, page.imageDataJs(n), 60000);
      return typeof data === 'string' ? { src: data } : null;
    },
    /*
     * A KEPT FILE INTO A FILE FIELD (ringPage.upload*). Without a picker to answer, the file is sent to the
     * page in pieces and handed to the field the way a picker does (its files, then input and change).
     */
    async upload(s, { index, name, mime, bytes }) {
      const where = s.ring.name;
      const t = await askObj(s, page.uploadTargetJs(page.elementRef(s.ring.mode, Number(index) - 1)));
      if (!t) return { error: `the page on ${where} could not be asked (an older Ghost Browser app?)`, onDevice: where };
      if (t.error) return { error: `${t.error} (element [${index}])`, onDevice: where };
      const b64 = Buffer.from(bytes).toString('base64');
      for (let o = 0; o < b64.length; o += UPLOAD_CHUNK) {
        const got = await ask(s, page.uploadChunkJs(b64.slice(o, o + UPLOAD_CHUNK)), 60000);
        if (typeof got !== 'number') return { error: `the file did not reach the page on ${where}`, onDevice: where };
      }
      const r = await askObj(s, page.uploadFinishJs(name, mime), 60000);
      if (!r || r.error) return { error: (r && r.error) || `the page on ${where} did not take the file`, onDevice: where };
      await wait(1200);
      const here = await info(s);
      return { uploaded: { bytes: Number(r.bytes) || 0, files: Number(r.files) || 0 }, url: here.url, onDevice: where,
        ...(t.accept && mime && !String(t.accept).split(',').some((a) => { a = a.trim().toLowerCase(); return a === mime || (a.endsWith('/*') && mime.startsWith(a.slice(0, -1))) || (a.startsWith('.') && String(name).toLowerCase().endsWith(a)); })
          ? { notice: `the field accepts ${t.accept}; the file is ${mime}` } : {}) };
    },
    /*
     * The page's console and failed requests (browser_console), for the account's own apps only. The 0.98 app
     * keeps them natively; an older one is asked through the page (uncaught errors from the first call on).
     */
    async console(s, { since = 0 } = {}) {
      const here = await info(s);
      if (!consoleAllowed(here.url)) return { error: consoleRefusal(here.url), onDevice: s.ring.name };
      s.ring.console = true;
      let entries = null; let native = false;
      try {
        const r = await call(s, '/v1/console', { since: Number(since) || 0 }, 20000);
        if (r && Array.isArray(r.entries)) { entries = r.entries; native = true; }
      } catch (_) { /* an older app: below */ }
      if (!entries) { const r = await askObj(s, page.CONSOLE_JS); entries = (r && Array.isArray(r.entries)) ? r.entries : []; }
      entries = entries.filter((e) => e && Number(e.t || 0) > (Number(since) || 0)).sort((a, b) => (a.t || 0) - (b.t || 0));
      const pick = (kinds) => entries.filter((e) => kinds.includes(e.kind)).slice(-100).map(({ kind, ...e }) => e);
      return { url: here.url, console: pick(['console']), failedRequests: pick(['http', 'network']), pages: pick(['page']).slice(-20),
        until: entries.length ? entries[entries.length - 1].t : Number(since) || 0, onDevice: s.ring.name,
        ...(native ? {} : { notice: `The Ghost Browser app on ${s.ring.name} is older than 0.98: only uncaught errors from now on and requests the page itself recorded as failed are shown. Update the app for the whole console.` }) };
    },
    async scroll(s, dy) {
      await call(s, '/v1/scroll', { dy: Number(dy) || 400 });
      const here = await info(s);
      return { url: here.url, onDevice: s.ring.name };
    },
    /** { type, data }: the app's own screen sends PNG, the service browser a scaled JPEG. */
    async screenshot(s) {
      const r = await call(s, '/v1/screenshot', {}, 60000);
      const jpeg = r && r.jpeg_base64;
      const b64 = jpeg || (r && (r.png_base64 || r.png)) || '';
      if (!b64) throw new Error('the device returned no screenshot');
      const data = Buffer.from(b64, 'base64');
      // click_at's x and y are in this picture's pixels (the service browser scales it to 720 px wide).
      const w = imageWidth(data); if (w) s.ring.shotWidth = w;
      return { type: jpeg ? 'jpeg' : 'png', data };
    },
    /** The product on the page: schema.org markup when it has it, else its meta tags, visible prices and large images. */
    async product(s) {
      await acceptCookies(s);
      const r = await call(s, '/v1/eval', { code: PRODUCT_JS });
      return { ...(r && typeof r === 'object' ? r : { raw: r }), onDevice: s.ring.name };
    },
  };
}

module.exports = { createSessionRing, signInPage, looksWalled, unwrap, toElements, withField, imageWidth, consoleAllowed, consoleRefusal, keyable, pieces, arrived, hostOf, regionScriptFor, marketUrl, WALL_STATUS, CONSENT_JS, PRODUCT_JS };
