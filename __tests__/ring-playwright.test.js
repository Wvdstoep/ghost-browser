// ring-playwright.test.js — the post watcher's own code, run on the phone (2026-11-21).
//
// postWatch.js drives a Playwright page. ringPlaywright.js is that page made of the device ring's steps, so the
// watcher and the poster run on the phone that holds the Facebook login instead of on the cluster with a copy.
// Here the "phone" is jsdom with the app's gb.js, as in ring-page.test.js: the page's scripts run there, a tap
// clicks the element the app was told to tap, typing goes in at the cursor.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { ringPage, SLOT_BASE } = require('../src/ringPlaywright');
const pw = require('../src/postWatch');
const GB = readFileSync(fileURLToPath(new URL('../mobile/app/src/main/assets/gb.js', import.meta.url)), 'utf8');

let win, doc, pages, ring, s, log;
function load(html, url) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  win = dom.window; doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
  win.Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }]; };
  // a phone lays everything out: the reader counts only what has a size on screen
  win.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0 }; };
  win.HTMLElement.prototype.scrollIntoView = function () {};
  win.eval(GB);
}
beforeEach(() => {
  log = [];
  pages = {};
  ring = {
    async navigate(sess, url) {
      log.push(['navigate', url]);
      const key = Object.keys(pages).find((k) => url.startsWith(k));
      load(key ? pages[key] : '<p>empty</p>', url);
      sess.ring.lastUrl = url;
      return { url, onDevice: 'SM-F926B' };
    },
    async evaluate(_s, code) {
      const v = win.eval(code);   // the app sends the value back as JSON
      return v === undefined || v === '' ? null : JSON.parse(JSON.stringify(v));
    },
    async pressSlot(_s, n) {
      const o = win.__gb._els[n];
      if (!o || !o.el) return { error: 'gone' };
      log.push(['tap', n, o.el.textContent.trim()]);
      o.el.click();
      return { pressed: true };
    },
    async keyText(_s, text) {
      const a = doc.activeElement;
      if (!a || a.getAttribute('contenteditable') !== 'true') return { error: 'no field has focus' };
      a.textContent += text; log.push(['type', text]);
      return {};
    },
    async key(_s, key) {
      log.push(['key', key]);
      (doc.activeElement || doc.body).dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }));
      return {};
    },
    async scroll(_s, dy) { log.push(['scroll', dy]); return {}; },
  };
  s = { id: 'watch-1', ring: { deviceId: 'p1', name: 'SM-F926B', profile: 'facebook' } };
});
const page = () => ringPage(ring, s, { wait: async () => {} });

describe('a Playwright page made of the phone\'s steps', () => {
  it('opens, runs a script with its argument, and says where it is', async () => {
    pages['https://www.facebook.com/x'] = '<h1>Hallo</h1>';
    const p = page();
    await p.goto('https://www.facebook.com/x');
    expect(p.url()).toBe('https://www.facebook.com/x');
    expect(await p.evaluate((sel) => document.querySelector(sel).textContent, 'h1')).toBe('Hallo');
    expect(await p.evaluate(() => ({ n: 2, a: [1, 'b'] }))).toEqual({ n: 2, a: [1, 'b'] });
  });

  it('an error in the page is an error here, as in Playwright', async () => {
    pages['https://www.facebook.com/x'] = '<p></p>';
    const p = page(); await p.goto('https://www.facebook.com/x');
    await expect(p.evaluate(() => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('$$ gives handles that read their text and are tapped by the app, in slots far from gb.js\'s numbers', async () => {
    pages['https://www.facebook.com/x'] = '<div role="button" id="a">Een</div><div role="button" id="b">Twee</div>';
    const p = page(); await p.goto('https://www.facebook.com/x');
    let clicked = '';
    doc.getElementById('b').addEventListener('click', () => { clicked = 'b'; });
    const hs = await p.$$('div[role="button"]');
    expect(hs).toHaveLength(2);
    expect(await hs[0].innerText()).toBe('Een');
    expect(hs[1].slot).toBeGreaterThanOrEqual(SLOT_BASE);
    await hs[1].click();
    expect(clicked).toBe('b');
    expect(log.find((x) => x[0] === 'tap')).toEqual(['tap', hs[1].slot, 'Twee']);
    expect(await hs[0].evaluate((el, suffix) => el.id + suffix, '!')).toBe('a!');
  });

  it('a tap the app refuses throws, so the watcher falls back the way it does on the cluster', async () => {
    pages['https://www.facebook.com/x'] = '<div role="button">Een</div>';
    const p = page(); await p.goto('https://www.facebook.com/x');
    const [h] = await p.$$('div[role="button"]');
    ring.pressSlot = async () => ({ error: 'covered by <div>' });
    await expect(h.click()).rejects.toThrow(/covered/);
    let fired = false; doc.querySelector('[role="button"]').addEventListener('click', () => { fired = true; });
    await h.dispatchEvent('click');
    expect(fired).toBe(true);
  });

  it('evaluateHandle finds an element, or none', async () => {
    pages['https://www.facebook.com/x'] = '<a id="l" href="#">x</a>';
    const p = page(); await p.goto('https://www.facebook.com/x');
    expect((await p.evaluateHandle(() => document.getElementById('l'))).asElement()).toBeTruthy();
    expect((await p.evaluateHandle(() => null)).asElement()).toBeNull();
  });
});

describe('the post watcher\'s own code on the phone', () => {
  it('discovers your posts with activity from the notifications page', async () => {
    pages['https://www.facebook.com/notifications'] = `
      <a href="https://www.facebook.com/groups/vibe/posts/111/?notif_id=1" aria-label="Jan reageerde op je bericht">x</a>
      <a href="https://www.facebook.com/groups/vibe/posts/222/?notif_id=2" aria-label="Piet antwoordde op je opmerking">y</a>
      <a href="https://www.facebook.com/somebody?notif_id=3">z</a>`;
    const urls = await pw.discoverOnPage(page(), null);
    expect([...urls]).toEqual(['https://www.facebook.com/groups/vibe/posts/111/', 'https://www.facebook.com/groups/vibe/posts/222/']);
    expect(urls.mine).toEqual(['111']);
    expect(urls.theirs).toEqual(['222']);
    expect(log.filter((x) => x[0] === 'scroll')).toHaveLength(2);   // the mouse wheel is the phone's scroll
  });

  it('posts an approved reply: opens the comment, presses its Reply, types the words, sends, and sees it', async () => {
    pages['https://www.facebook.com/groups/vibe/posts/111/'] = `
      <div role="article" aria-label="Opmerking van Jan Jansen 2 uur geleden">
        <a href="https://www.facebook.com/groups/vibe/posts/111/?comment_id=555">2 u</a>
        <p>Mooi gemaakt!</p>
        <div role="button" id="reply">Beantwoorden</div>
      </div>
      <div id="list"></div>
      <script>
        document.getElementById('reply').addEventListener('click', function () {
          var box = document.createElement('div'); box.setAttribute('contenteditable', 'true'); box.id = 'box';
          document.body.appendChild(box); box.focus();
          box.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            // a posted reply is a comment like any other: a name, the words, and its own Reply
            var a = document.createElement('div'); a.setAttribute('role', 'article');
            a.setAttribute('aria-label', 'Antwoord van Carla op de opmerking van Jan Jansen');
            a.innerHTML = '<div>Carla</div><div class="t"></div><div role="button">Beantwoorden</div>';
            a.querySelector('.t').textContent = box.textContent; document.getElementById('list').appendChild(a);
          });
        });
      </script>`;
    const r = await pw.postReply(page(), 'https://www.facebook.com/groups/vibe/posts/111/?comment_id=555', 'Dank je Jan!', { meName: 'Carla' });
    expect(r).toMatchObject({ posted: true });
    expect(log.filter((x) => x[0] === 'tap').map((x) => x[2])).toEqual(['Beantwoorden']);
    expect(log).toContainEqual(['type', 'Dank je Jan!']);
    expect(log).toContainEqual(['key', 'Enter']);
  });

  it('a dry run finds the comment and its Reply and types nothing', async () => {
    pages['https://www.facebook.com/groups/vibe/posts/111/'] = `
      <div role="article" aria-label="Opmerking van Jan"><a href="?comment_id=555">2 u</a><div role="button">Beantwoorden</div></div>`;
    const r = await pw.postReply(page(), 'https://www.facebook.com/groups/vibe/posts/111/?comment_id=555', 'Hoi', { meName: 'Carla', dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(log.some((x) => x[0] === 'type')).toBe(false);
  });
});
