/*
 * A FACEBOOK POST FROM THE PHONE (2026-11-20). A Claude session posted in a group through the owner's phone:
 * typing key by key stopped after about 2,000 characters (each key ~60 ms in Facebook's post box, the call
 * ran out at 120 s) and at the Polish "ę" (no key on the phone's keymap), and "Edit post" in a menu that
 * opened below the screen was tapped outside the browser. A stubbed phone holds sessionRing to the fixes:
 * long or non-keyboard text is inserted and checked, an element sticking out of the screen is tapped on its
 * shown part, and one with nothing on screen is clicked by script, saying so.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createSessionRing, keyable, pieces, arrived } = require('../src/sessionRing');

const device = { deviceId: 'd1', name: 'SM-F926B' };
const onPage = (spec, re) => spec.path === '/v1/eval' && re.test(spec.body.code || '');
const info = { url: 'https://www.facebook.com/groups/x', title: 'Facebook', ready: 'complete' };
function ringWith(answer) {
  const calls = [];
  const run = async (id, spec) => { calls.push(spec); const v = answer(spec); return { result: { result: JSON.stringify(v === undefined ? null : v) } }; };
  const ring = createSessionRing({ run, pickDevice: () => device, log: {}, wait: async () => {} });
  const s = { id: 'fb' }; ring.attach(s, ['me']);
  return { calls, ring, s };
}
const INSERT = /execCommand\('insertText',false,t\)/;
const BREAK = /insertLineBreak/;
const FOCUS = /focused:inside\(\)/;
const FIELD = /\{text:null\}/;
const STATE = /aria-disabled/;
const SCRIPT_CLICK = /new MouseEvent\('mousedown'/;
const POINT = /_els\[99998\]=\{el:/;
const textOf = (code) => JSON.parse(code.match(/t=("(?:[^"\\]|\\.)*")/)[1]);

/* A post box that keeps what is inserted, and can be told to stop taking text after some characters. */
function postBox({ takes = Infinity } = {}) {
  let held = '';
  return {
    get held() { return held; },
    answer(spec) {
      if (spec.path === '/v1/info') return info;
      if (spec.path === '/v1/type') return 'ok';
      if (onPage(spec, FOCUS)) return { focused: true };
      if (onPage(spec, INSERT)) {
        const t = textOf(spec.body.code);
        if (held.length >= takes) return { into: 'div', changed: false, length: held.length };
        held += t.slice(0, Math.max(0, takes - held.length)); return { into: 'div', changed: true, length: held.length };
      }
      if (onPage(spec, BREAK)) { held += '\n'; return { ok: true }; }
      if (onPage(spec, FIELD)) return { text: held };
      return 'committed';
    },
  };
}
const POST = ('Disclaimer first: Hi, I am Claude.\n\n' + 'A line about the setup that goes on for a while. '.repeat(50) + '\n'
  + 'A restaurant replied "tak poproszę" (yes please).\n' + 'The rest of the post. '.repeat(40)).trim();

describe('typing on the phone: keys for short plain text, insert for the rest', () => {
  it('chooses by length and by letters the keymap has', () => {
    expect(keyable('pizza warszawa')).toBe(true);
    expect(keyable('a\nb')).toBe(true);
    expect(keyable('tak poproszę')).toBe(false);
    expect(keyable('x'.repeat(301))).toBe(false);
    expect(pieces('ab😀cd', 3)).toEqual(['ab😀', 'cd']);
    expect(arrived('one  two\nthree', 'one two three')).toBe(true);
    expect(arrived('one two', 'one two three')).toBe(false);
  });
  it('a long post with Polish letters arrives whole: a real tap empties the field, then lines and pieces are inserted', async () => {
    const box = postBox();
    const { calls, ring, s } = ringWith(box.answer);
    const r = await ring.type(s, { index: 4, text: POST, commit: false });
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe('insert');
    expect(box.held).toBe(POST);
    expect(r.landed.length).toBe(POST.length);
    const typed = calls.filter((c) => c.path === '/v1/type');
    expect(typed.map((c) => c.body)).toEqual([{ index: 3, text: '' }]);                    // never key by key
    expect(calls.filter((c) => onPage(c, BREAK))).toHaveLength(POST.split('\n').length - 1);  // Shift+Enter, never Enter
    expect(calls.some((c) => c.path === '/v1/key')).toBe(false);
    expect(Math.max(...calls.filter((c) => onPage(c, INSERT)).map((c) => textOf(c.body.code).length))).toBeLessThanOrEqual(800);
  });
  it('a field that stops taking text is an error that says how much arrived, never "typed"', async () => {
    const box = postBox({ takes: 2000 });
    const { ring, s } = ringWith(box.answer);
    const r = await ring.type(s, { index: 4, text: POST });
    expect(r.error).toMatch(/typing stopped at line \d+ of \d+: the field took no more text/);
    expect(r.landed.length).toBe(box.held.length);
    expect(r.typed).toBeUndefined();
  });
  it('what the field holds is checked at the end', async () => {
    const box = postBox();
    const { ring, s } = ringWith((spec) => (onPage(spec, FIELD) ? { text: 'Disclaimer first' } : box.answer(spec)));
    const r = await ring.type(s, { index: 4, text: POST });
    expect(r.error).toMatch(new RegExp(`only 16 of ${POST.length} characters arrived`));
  });
  it('refuses when the field cannot be focused, before inserting anything', async () => {
    const box = postBox();
    const { calls, ring, s } = ringWith((spec) => (onPage(spec, FOCUS) ? { focused: false } : box.answer(spec)));
    expect((await ring.type(s, { index: 4, text: 'tak poproszę' })).error).toMatch(/could not be focused/);
    expect(calls.some((c) => onPage(c, INSERT))).toBe(false);
  });
  it('short plain text still goes key by key', async () => {
    const box = postBox();
    const { calls, ring, s } = ringWith(box.answer);
    const r = await ring.type(s, { index: 2, text: 'pizza warszawa' });
    expect(r.mode).toBe('type');
    expect(calls.find((c) => c.path === '/v1/type').body).toEqual({ index: 1, text: 'pizza warszawa' });
    expect(calls.some((c) => onPage(c, INSERT))).toBe(false);
  });
});

describe('a menu item that opens below the screen', () => {
  const base = (state) => (spec) => {
    if (spec.path === '/v1/info') return info;
    if (onPage(spec, STATE)) return state;
    if (onPage(spec, POINT)) return { x: 180, y: 700 };
    if (onPage(spec, SCRIPT_CLICK)) return { clicked: 'div "Bericht bewerken"' };
    return { ok: true };
  };
  it('is tapped on the part of it that is on screen', async () => {
    const { calls, ring, s } = ringWith(base({ ok: true, cover: '', part: { x: 180, y: 700 } }));
    const r = await ring.click(s, { index: 12 });
    expect(r.error).toBeUndefined();
    expect(r.how).toMatch(/part of it that is on screen/);
    expect(calls.find((c) => onPage(c, POINT)).body.code).toContain('left:180,top:700');
    expect(calls.find((c) => c.path === '/v1/click').body).toEqual({ index: 99998 });
  });
  it('with nothing on screen, is clicked by script and the answer says so', async () => {
    const { calls, ring, s } = ringWith(base({ ok: true, cover: '', offscreen: true }));
    const r = await ring.click(s, { index: 12 });
    expect(r.error).toBeUndefined();
    expect(r.how).toMatch(/clicked by script/);
    expect(calls.some((c) => c.path === '/v1/click')).toBe(false);
    expect(calls.some((c) => onPage(c, SCRIPT_CLICK))).toBe(true);
  });
  it('a reply label that takes no clicks is tapped where a finger would, naming what that reaches', async () => {
    const { calls, ring, s } = ringWith(base({ inert: true, reach: 'div[role=button]', point: { x: 70, y: 310 } }));
    const r = await ring.click(s, { index: 5 });
    expect(r.error).toBeUndefined();
    expect(r.how).toMatch(/pointer-events: none.*reaches <div\[role=button\]>/);
    expect(calls.find((c) => onPage(c, POINT)).body.code).toContain('left:70,top:310');
    expect(calls.find((c) => c.path === '/v1/click').body).toEqual({ index: 99998 });
    expect(calls.filter((c) => onPage(c, STATE))).toHaveLength(1);   // no waiting for it to come free
  });
  it('one that takes no clicks with nothing under it is still refused', async () => {
    const { calls, ring, s } = ringWith(base({ inert: true }));
    expect((await ring.click(s, { index: 5 })).error).toMatch(/nothing under it on screen does/);
    expect(calls.some((c) => c.path === '/v1/click')).toBe(false);
  });
  it('a row with its own button over the centre is tapped on a free spot', async () => {
    const { calls, ring, s } = ringWith(base({ ok: true, cover: '', part: { x: 60, y: 140 }, nested: 'div[role=button] "..."' }));
    const r = await ring.click(s, { index: 1 });
    expect(r.how).toMatch(/sits over its centre, so a free spot of it was tapped/);
    expect(calls.find((c) => c.path === '/v1/click').body).toEqual({ index: 99998 });
  });
  it('click by text gets the same treatment', async () => {
    const { calls, ring, s } = ringWith((spec) => (onPage(spec, /var want="bericht bewerken"/)
      ? { found: 1, tag: 'div', text: 'bericht bewerken', hiddenCopies: 0 }
      : base({ ok: true, cover: '', part: { x: 100, y: 760 } })(spec)));
    const r = await ring.click(s, { text: 'Bericht bewerken' });
    expect(r.how).toMatch(/on screen/);
    expect(calls.find((c) => c.path === '/v1/click').body).toEqual({ index: 99998 });
  });
});

describe('Back, and a phone stuck on one page', () => {
  it('Back goes back in the page (that closes a sheet on a mobile site), never an unknown key', async () => {
    const { calls, ring, s } = ringWith((spec) => (spec.path === '/v1/info' ? info : onPage(spec, /history\.back\(\)/) ? 'went back' : 'ok'));
    const r = await ring.key(s, 'Back');
    expect(r).toMatchObject({ did: 'went back', pressed: 'Back' });
    expect(calls.some((c) => c.path === '/v1/key')).toBe(false);
  });
  it('a navigate that stays twice lets the page itself go, and answers stuck when even that does not take', async () => {
    let loadedAt = 111; let replaced = 0;
    const answer = (spec) => {
      if (spec.path === '/v1/info') return { url: 'https://www.facebook.com/search/', title: 'Facebook', ready: 'complete' };
      if (onPage(spec, /timeOrigin/)) return loadedAt;
      if (onPage(spec, /location\.replace/)) { replaced += 1; return 'going'; }
      return 'ok';
    };
    const a = ringWith(answer);
    const r = await a.ring.navigate(a.s, 'https://gb-debug.mavicpro-fan.my-app.engineer/');
    expect(r).toMatchObject({ stuck: true, url: 'https://www.facebook.com/search/' });
    expect(r.error).toMatch(/also when the page itself was told to go/);
    expect(a.calls.filter((c) => c.path === '/v1/navigate')).toHaveLength(2);
    expect(replaced).toBe(1);
    // the page's own navigation takes: no error
    const b = ringWith((spec) => (onPage(spec, /location\.replace/) ? ((loadedAt = 222), 'going') : answer(spec)));
    loadedAt = 111;
    expect((await b.ring.navigate(b.s, 'https://gb-debug.mavicpro-fan.my-app.engineer/')).error).toBeUndefined();
  });
});
