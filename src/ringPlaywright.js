'use strict';
/*
 * THE POST WATCHER ON THE PHONE THAT HOLDS THE LOGIN (2026-11-21).
 *
 * Owner: "for now I didn't experience a verify you are human at all on mobile, only on the cloud IP, while
 * mobile works just fine". The posts watcher read Facebook from the cluster, every hour, in a copy of the
 * phone's login: the same session from the phone's home IP and from the datacenter, which is the pattern that
 * gets a login checked. It now runs on the phone itself.
 *
 * The watcher's code (postWatch.js: crawl, verify, discover, postReply) drives a Playwright page. This is that
 * page, made of the device ring's own steps, so the SAME code runs on the phone without a second copy of it to
 * drift apart: goto = the ring's navigate, evaluate = a script in the page, an element handle = a slot the app
 * taps with its own trusted tap (the checks of a click included), keyboard = the ring's typing and keys, the
 * mouse wheel = the ring's scroll. Only what postWatch uses is here; anything else throws, and postWatch already
 * treats a failing optional step (the cookie banner, settle) as skippable.
 */

const SLOT_BASE = 90000;   // far from gb.js's own numbers and from PICK/SPOT (99999/99998)
const SLOT_MAX = 600;

const fnSource = (fn) => (typeof fn === 'function' ? fn.toString() : `(function(){return (${String(fn)})})`);
const argsSource = (args) => args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(',');
const slotEl = (n) => `(window.__gb&&window.__gb._els&&window.__gb._els[${n}]&&window.__gb._els[${n}].el)`;

function ringPage(ring, s, { wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let next = 0;
  const take = () => { const n = SLOT_BASE + (next % SLOT_MAX); next += 1; return n; };

  const ev = async (code, ms) => {
    const v = await ring.evaluate(s, code, ms);
    return v && typeof v === 'object' && v.__err ? Promise.reject(new Error(v.__err)) : v;
  };
  /* Run fn(...args) in the page; an exception there comes back as an error here, as Playwright's does. */
  const run = (fn, args, prefix = '') => ev(`(function(){try{${prefix}return (${fnSource(fn)})(${argsSource(args)});}catch(e){return {__err:String(e&&e.message||e)}}})()`);

  function handle(n) {
    const h = {
      slot: n,
      asElement: () => h,
      innerText: async () => {
        const t = await ev(`(function(){var e=${slotEl(n)};return e?String(e.innerText||''):{__err:'element is gone'}})()`);
        return String(t == null ? '' : t);
      },
      evaluate: async (fn, arg) => {
        const v = await ev(`(function(){var e=${slotEl(n)};if(!e)return {__err:'element is gone'};try{return (${fnSource(fn)})(e${arg === undefined ? '' : ',' + JSON.stringify(arg)});}catch(x){return {__err:String(x&&x.message||x)}}})()`);
        return v;
      },
      evaluateHandle: async (fn) => {
        const m = take();
        const ok = await ev(`(function(){var e=${slotEl(n)};if(!e)return false;var r=(${fnSource(fn)})(e);if(!r||r.nodeType!==1)return false;window.__gb._els[${m}]={el:r};return true})()`);
        return ok ? handle(m) : nothing;
      },
      click: async () => {
        const r = await ring.pressSlot(s, n);
        if (r && r.error) throw new Error(r.error);
        await wait(400);
      },
      dispatchEvent: async (type) => {
        const ok = await ev(`(function(){var e=${slotEl(n)};if(!e)return false;${type === 'click' ? 'e.click()' : `e.dispatchEvent(new Event(${JSON.stringify(String(type))},{bubbles:true}))`};return true})()`);
        if (!ok) throw new Error('element is gone');
      },
    };
    return h;
  }
  const nothing = { asElement: () => null };

  const page = {
    onDevice: true,
    url: () => String((s.ring && s.ring.lastUrl) || ''),
    isClosed: () => false,
    waitForTimeout: (ms) => wait(ms),
    async goto(url) {
      const r = await ring.navigate(s, String(url));
      if (r && r.error) throw new Error(r.error);
      if (r && r.url && s.ring) s.ring.lastUrl = r.url;
      return { status: () => null };
    },
    evaluate: (fn, ...args) => run(fn, args),
    async evaluateHandle(fn, ...args) {
      const m = take();
      const placed = await ev(`(function(){if(!(window.__gb&&window.__gb._els))return false;var r=(${fnSource(fn)})(${argsSource(args)});if(!r||r.nodeType!==1)return false;window.__gb._els[${m}]={el:r};return true})()`);
      return placed ? handle(m) : nothing;
    },
    async $$(selector) {
      const first = SLOT_BASE + (next % SLOT_MAX);
      const count = await ev(`(function(){if(!(window.__gb&&window.__gb._els))return 0;var l=Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(String(selector))}),0,${SLOT_MAX >> 1});for(var i=0;i<l.length;i++)window.__gb._els[${SLOT_BASE}+((${first - SLOT_BASE}+i)%${SLOT_MAX})]={el:l[i]};return l.length})()`);
      const out = [];
      for (let i = 0; i < (Number(count) || 0); i += 1) out.push(handle(take()));
      return out;
    },
    keyboard: {
      async type(text) {
        const r = await ring.keyText(s, String(text));
        if (r && r.error) throw new Error(r.error);
      },
      async press(key) {
        const r = await ring.key(s, String(key));
        if (r && r.error) throw new Error(r.error);
      },
    },
    mouse: {
      async wheel(_x, dy) { await ring.scroll(s, Number(dy) || 600); },
    },
  };
  return page;
}

module.exports = { ringPage, SLOT_BASE, SLOT_MAX };
