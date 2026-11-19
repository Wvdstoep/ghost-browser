/*
 * THE PHONE'S TOOLS LOOK BEFORE THEY ACT (2026-11-19).
 *
 * A Claude session drove Product Hunt on the owner's SM-F926B through the my-app-full connector, then a test
 * page that logged every event. Taps and typing were real, but: a tap on a disabled "Get started" answered
 * "clicked"; typing never left the field, so the form never checked it and the button stayed disabled; a click
 * by text hit a hidden copy; the first navigate of a session answered with the previous session's page;
 * analyze showed no value and no disabled state; pictures, uploads, a click at a spot, Control+A and text by
 * key were refused; nothing showed the console. A stubbed phone whose page answers ringPage.js's scripts by
 * what they ask for holds sessionRing to each fix.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createSessionRing, imageWidth, consoleAllowed } = require('../src/sessionRing');

const device = { deviceId: 'd1', name: 'SM-F926B' };
function scripted(answer) {
  const calls = [];
  const run = async (id, spec) => {
    calls.push(spec);
    const v = answer(spec);
    return { result: { result: JSON.stringify(v === undefined ? null : v) } };
  };
  return { run, calls };
}
const onPage = (spec, re) => spec.path === '/v1/eval' && re.test(spec.body.code || '');
const infoOf = (url = 'https://www.producthunt.com/posts/new') => ({ url, title: 'Product Hunt', ready: 'complete' });
function ringWith(answer, id = 'k') {
  const p = scripted(answer);
  const ring = createSessionRing({ run: p.run, pickDevice: () => device, log: {}, wait: async () => {} });
  const s = { id }; ring.attach(s, ['me']);
  return { p, ring, s };
}
const STATE = /aria-disabled/;   // ringPage.stateJs
const COMMIT = /nothing focused/; // ringPage.COMMIT_JS

describe('a click on the device looks before it taps', () => {
  it('refuses a disabled button after leaving the field and watching it, instead of answering clicked', async () => {
    const { p, ring, s } = ringWith((spec) => {
      if (spec.path === '/v1/info') return infoOf();
      if (onPage(spec, STATE)) return { disabled: true, released: /if\(true&&/.test(spec.body.code) };
      return 'ok';
    });
    const r = await ring.click(s, { index: 9 });
    expect(r.error).toMatch(/element \[9\] is disabled, also after leaving the field/);
    expect(r.index).toBe(9);
    expect(p.calls.some((c) => c.path === '/v1/click')).toBe(false);
    expect(p.calls.filter((c) => onPage(c, STATE))).toHaveLength(5);   // the release, then four looks
  });
  it('taps once the button comes free', async () => {
    let looks = 0;
    const { p, ring, s } = ringWith((spec) => {
      if (spec.path === '/v1/info') return infoOf();
      if (onPage(spec, STATE)) { looks += 1; return looks < 2 ? { disabled: true, released: true } : { ok: true, cover: '' }; }
      return { ok: true };
    });
    const r = await ring.click(s, { index: 9 });
    expect(r.error).toBeUndefined();
    expect(p.calls.find((c) => c.path === '/v1/click').body).toEqual({ index: 8 });
  });
  it('names what covers the element, and says when the tap found nothing', async () => {
    const a = ringWith((spec) => (spec.path === '/v1/info' ? infoOf() : onPage(spec, STATE) ? { ok: true, cover: 'div.cookie-wall' } : 'ok'));
    expect((await a.ring.click(a.s, { index: 2 })).error).toMatch(/covered by <div\.cookie-wall>/);
    const b = ringWith((spec) => (spec.path === '/v1/info' ? infoOf() : spec.path === '/v1/click' ? { err: 'no-element' } : null));
    expect((await b.ring.click(b.s, { index: 2 })).error).toMatch(/nothing to tap there/);
  });
  it('clicks the shown copy of a text through the app\'s own tap, never a hidden one', async () => {
    const a = ringWith((spec) => {
      if (spec.path === '/v1/info') return infoOf();
      if (onPage(spec, /var want="done"/)) return { found: 1, tag: 'button', text: 'done', hiddenCopies: 2 };
      if (onPage(spec, STATE)) return { ok: true, cover: '' };
      return { ok: true };
    });
    const r = await a.ring.click(a.s, { text: 'Done' });
    expect(r.clicked).toEqual({ text: 'Done' });
    expect(a.p.calls.find((c) => c.path === '/v1/click').body).toEqual({ index: 99999 });
    expect(a.p.calls.some((c) => c.path === '/v1/click_text')).toBe(false);

    const b = ringWith((spec) => (spec.path === '/v1/info' ? infoOf() : onPage(spec, /var want=/) ? { notfound: 1, hidden: 2 } : 'ok'));
    expect((await b.ring.click(b.s, { text: 'Add pricing' })).error).toMatch(/only in copies that are hidden/);
    expect(b.p.calls.some((c) => c.path === '/v1/click_text' || c.path === '/v1/click')).toBe(false);
  });
  it('still reaches a text inside a frame the old way, and says when nothing shows it', async () => {
    const a = ringWith((spec) => (spec.path === '/v1/info' ? infoOf() : onPage(spec, /var want=/) ? { notfound: 1, hidden: 0 } : spec.path === '/v1/click_text' ? { err: 'notfound' } : 'ok'));
    expect((await a.ring.click(a.s, { text: 'Opslaan' })).error).toMatch(/nothing showing "Opslaan"/);
    expect(a.p.calls.some((c) => c.path === '/v1/click_text')).toBe(true);
  });
});

describe('a navigate on the device opens the page it was asked for', () => {
  it('asks again when the page did not change, and says so when it still did not', async () => {
    const { p, ring, s } = ringWith((spec) => {
      if (spec.path === '/v1/info') return infoOf();
      if (onPage(spec, /timeOrigin/)) return 1763500000000;   // the same document, every time
      return '';
    });
    const r = await ring.navigate(s, 'https://gb-debug.mavicpro-fan.my-app.engineer/');
    expect(p.calls.filter((c) => c.path === '/v1/navigate')).toHaveLength(2);
    expect(r.error).toMatch(/stayed on https:\/\/www\.producthunt\.com\/posts\/new and did not open https:\/\/gb-debug/);
  });
  it('answers normally when a new page loaded', async () => {
    let t = 1763500000000; let url = 'https://www.producthunt.com/posts/new';
    const { p, ring, s } = ringWith((spec) => {
      if (spec.path === '/v1/navigate') { t += 5000; url = spec.body.url; return { url }; }
      if (spec.path === '/v1/info') return infoOf(url);
      if (onPage(spec, /timeOrigin/)) return t;
      return '';
    });
    const r = await ring.navigate(s, 'https://gb-debug.mavicpro-fan.my-app.engineer/');
    expect(r.error).toBeUndefined();
    expect(r.url).toBe('https://gb-debug.mavicpro-fan.my-app.engineer/');
    expect(p.calls.filter((c) => c.path === '/v1/navigate')).toHaveLength(1);
  });
});

describe('typing on the device lets the form check the field', () => {
  it('commits after typing unless asked not to, and before a submit', async () => {
    const { p, ring, s } = ringWith((spec) => (spec.path === '/v1/info' ? infoOf() : onPage(spec, COMMIT) ? 'committed' : 'ok'));
    expect((await ring.type(s, { index: 1, text: 'https://my-app.engineer' })).committed).toBe('committed');
    const n = p.calls.filter((c) => onPage(c, COMMIT)).length;
    expect((await ring.type(s, { index: 1, text: 'x', commit: false })).committed).toBeUndefined();
    expect(p.calls.filter((c) => onPage(c, COMMIT))).toHaveLength(n);
    await ring.type(s, { index: 1, text: 'x', commit: false, submit: true });
    const order = p.calls.map((c) => (onPage(c, COMMIT) ? 'commit' : c.path)).filter((x) => x === 'commit' || x === '/v1/key');
    expect(order.slice(-2)).toEqual(['commit', '/v1/key']);
  });
});

describe('analyze on the device says what each element holds', () => {
  it('adds disabled, value, placeholder and position, and never shows a password as text', async () => {
    const { ring, s } = ringWith((spec) => {
      if (spec.path === '/v1/info') return infoOf();
      if (spec.path === '/v1/analyze') return [
        { i: 0, tag: 'input', text: 'https://my-app.engineer', label: '', x: 10, y: 100, w: 300, h: 40 },
        { i: 1, tag: 'input', type: 'password', text: 'hunter2', label: 'Password', x: 10, y: 150, w: 300, h: 40 },
        { i: 2, tag: 'button', text: 'Get started', x: 10, y: 200, w: 120, h: 40 },
        { i: 3, tag: 'a', text: 'a' }, { i: 4, tag: 'a', text: 'b' }];
      if (onPage(spec, /fileInputs/)) return { ih: 800, fileInputs: 2, fields: [
        { disabled: false, placeholder: 'Link to the product', value: 'https://my-app.engineer' },
        { disabled: false, placeholder: '', password: true, filled: true }, { disabled: true }] };
      return '';
    });
    const a = await ring.analyze(s);
    expect(a.elements[0]).toMatchObject({ text: 'Link to the product', value: 'https://my-app.engineer', placeholder: 'Link to the product', disabled: false, left: 10, top: 100, x: 160, y: 120, visible: true });
    expect(a.elements[1]).toMatchObject({ text: 'Password', filled: true });
    expect(JSON.stringify(a)).not.toContain('hunter2');
    expect(a.elements[2].disabled).toBe(true);
    expect(a.summary).toMatch(/\[3\] button Get started \(disabled\)/);
    expect(a.fileInputs).toBe(2);
    expect(a.hint).toMatch(/browser_upload_file/);
  });
});

describe('keys, spots, pictures, files and the console on the device', () => {
  it('does Control+A and Shift+Tab in the page, types a character, and refuses other combinations', async () => {
    const { p, ring, s } = ringWith((spec) => (spec.path === '/v1/info' ? infoOf() : onPage(spec, /insertText/) ? { into: 'q', changed: true, length: 1 } : 'selected field'));
    expect((await ring.key(s, 'Control+A')).did).toBe('selected field');
    expect((await ring.key(s, 'Shift+Tab')).pressed).toBe('Shift+Tab');
    expect((await ring.key(s, 'x')).changed).toBe(true);
    expect((await ring.key(s, 'Control+C')).error).toMatch(/only Control\+A and Shift\+Tab/);
    expect(p.calls.some((c) => c.path === '/v1/key')).toBe(false);
    expect((await ring.keyText(s, 'hello')).into).toBe('q');
    await ring.key(s, 'Tab');
    expect(p.calls.find((c) => c.path === '/v1/key').body).toEqual({ key: 'Tab' });
  });
  it('taps a spot of the last screenshot, in its pixels', async () => {
    const png = Buffer.alloc(32); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(720, 16);
    const { p, ring, s } = ringWith((spec) => {
      if (spec.path === '/v1/info') return infoOf();
      if (spec.path === '/v1/screenshot') return { jpeg_base64: png.toString('base64') };
      if (onPage(spec, /_els\[99998\]=/)) return { x: 512, y: 142, at: 'canvas' };
      return { ok: true };
    });
    await ring.screenshot(s);
    expect(s.ring.shotWidth).toBe(720);
    const r = await ring.clickAt(s, 360, 100);
    expect(r).toMatchObject({ clicked: { x: 360, y: 100 }, at: 'canvas' });
    expect(p.calls.find((c) => onPage(c, /_els\[99998\]=/)).body.code).toMatch(/innerWidth\/720/);
    expect(p.calls.find((c) => c.path === '/v1/click').body).toEqual({ index: 99998 });
  });
  it('lists the pictures and sends a kept file into a file field in pieces', async () => {
    const { p, ring, s } = ringWith((spec) => {
      if (spec.path === '/v1/info') return infoOf();
      if (onPage(spec, /document\.images/)) return [{ image: 1, src: 'https://ph-files.imgix.net/a.png', inline: false, alt: 'a', width: 800, height: 600, visible: true }, { image: 2, src: 'data:image/png;base64,AAAA', inline: true, alt: '', width: 300, height: 300, visible: true }];
      if (onPage(spec, /__gbUpTarget=f;/)) return { ok: true, accept: 'image/*', multiple: true };
      if (onPage(spec, /window\.__gbUp=\(window\.__gbUp/)) return 100;
      if (onPage(spec, /new DataTransfer/)) return { ok: true, files: 3, bytes: 900000 };
      return '';
    });
    const imgs = await ring.images(s);
    expect(imgs.images[1].src).toMatch(/^data: \(inline picture/);
    expect(await ring.imageSource(s, 1)).toEqual({ src: 'https://ph-files.imgix.net/a.png', referer: 'https://www.producthunt.com/posts/new' });
    const up = await ring.upload(s, { index: 4, name: 'gallery.png', mime: 'image/png', bytes: Buffer.alloc(900000) });
    expect(up.uploaded).toEqual({ bytes: 900000, files: 3 });
    expect(p.calls.filter((c) => onPage(c, /window\.__gbUp=\(window\.__gbUp/))).toHaveLength(3);   // 1.2 MB of base64 in 512 KB pieces
    expect(up.notice).toBeUndefined();
  });
  it('shows the console of the account\'s own app, natively, and refuses any other site', async () => {
    let url = 'https://gb-debug.mavicpro-fan.my-app.engineer/';
    const { ring, s } = ringWith((spec) => {
      if (spec.path === '/v1/info') return infoOf(url);
      if (spec.path === '/v1/console') return { native: true, entries: [
        { t: 5, kind: 'page', url }, { t: 6, kind: 'console', level: 'error', text: 'Uncaught TypeError' }, { t: 7, kind: 'http', status: 404, url: url + 'api/x' }] };
      return '';
    });
    const r = await ring.console(s);
    expect(r.console).toEqual([{ t: 6, level: 'error', text: 'Uncaught TypeError' }]);
    expect(r.failedRequests[0]).toMatchObject({ status: 404 });
    expect(r.until).toBe(7);
    expect(r.notice).toBeUndefined();
    url = 'https://www.producthunt.com/posts/new';
    expect((await ring.console(s)).error).toMatch(/only for your own apps on my-app\.engineer/);
  });
  it('falls back to the page on an app without a console', async () => {
    const { ring, s } = ringWith((spec) => {
      if (spec.path === '/v1/info') return infoOf('https://shop.mavicpro-fan.my-app.engineer/');
      if (spec.path === '/v1/console') return { error: 'unsupported' };
      if (onPage(spec, /__gbErr/)) return { since: 1, entries: [{ t: 2, kind: 'console', level: 'error', text: 'boom' }] };
      return '';
    });
    const r = await ring.console(s);
    expect(r.console[0].text).toBe('boom');
    expect(r.notice).toMatch(/older than 0\.98/);
  });
});

describe('small helpers', () => {
  it('reads a screenshot\'s width from a PNG or a JPEG header', () => {
    const png = Buffer.alloc(32); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1768, 16);
    expect(imageWidth(png)).toBe(1768);
    // SOI, an APP0 segment, then SOF0: precision 8, height 1280, width 720
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x00, 0x02, 0xd0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageWidth(jpg)).toBe(720);
    expect(imageWidth(Buffer.from('nope'))).toBe(0);
  });
  it('allows the console on an app of an account, never the platform itself or other sites', () => {
    expect(consoleAllowed('https://gb-debug.mavicpro-fan.my-app.engineer/x', '')).toBe(true);
    expect(consoleAllowed('https://my-app.engineer/#workspace', '')).toBe(false);
    expect(consoleAllowed('https://ghost.my-app.engineer/', '')).toBe(false);
    expect(consoleAllowed('https://www.producthunt.com/', '')).toBe(false);
    expect(consoleAllowed('https://shop.example.nl/', 'example.nl')).toBe(true);
  });
});
