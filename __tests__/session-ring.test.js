/*
 * A SESSION THAT HITS A WALL MOVES TO A DEVICE.
 *
 * Measured 2026-10-30: through the BIAB connector, bol.com answered 403, Google Trends 429 and CJ a
 * "verify you are human" page — all because a session runs on the cluster's datacenter address,
 * while the owner's phone sat connected on a home line the whole time. The ring took jobs, never
 * sessions. These tests hold the handover to its promise with a stubbed phone.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createSessionRing, looksWalled, unwrap, toElements, regionScriptFor } = require('../src/sessionRing');

function phone() {
  const calls = [];
  const answers = {
    '/v1/navigate': { url: 'https://www.bol.com/nl/' },
    '/v1/info': JSON.stringify({ url: 'https://www.bol.com/nl/', title: 'bol.com | de winkel van ons allemaal' }),
    '/v1/content': JSON.stringify('Bestsellers\nWekkerlicht €39,99'),
    '/v1/analyze': JSON.stringify([{ i: 0, tag: 'a', text: 'Bestsellers', href: '/bestsellers' }, { i: 1, tag: 'input', label: 'Zoeken' }]),
    '/v1/click': '"ok"', '/v1/type': '"ok"', '/v1/scroll': '"ok"',
    '/v1/screenshot': { png_base64: Buffer.from('png').toString('base64') },
  };
  // The hub hands back the device's own POST body: { id, result: <string> }.
  const run = async (deviceId, spec) => { calls.push({ deviceId, ...spec }); return { id: 'c1', result: { id: 'c1', result: answers[spec.path] } }; };
  return { run, calls };
}
const device = { deviceId: 'd1', name: 'SM-F926B' };

describe('telling a wall from a page', () => {
  it('reads refusals and challenges as walls', () => {
    expect(looksWalled({ status: 403 })).toMatch(/403/);
    expect(looksWalled({ status: 429 })).toMatch(/429/);
    expect(looksWalled({ status: 200, title: 'Just a moment...' })).toMatch(/challenge/);
    expect(looksWalled({ status: 200, sample: 'Please verify you are a human to continue' })).toMatch(/challenge/);
  });
  it('does not mistake a real page for one', () => {
    expect(looksWalled({ status: 200, title: 'Wekkerlicht kopen', sample: 'x'.repeat(5000) })).toBe('');
    expect(looksWalled({ status: 200, title: 'Blog', sample: 'How captcha works. ' + 'y'.repeat(5000) })).toBe('');
    expect(looksWalled({ status: 404 })).toBe('');
  });
});

describe('the phone answers in wrappers', () => {
  it('unwraps the hub and device envelopes and JSON strings', () => {
    expect(unwrap({ id: 'c', result: { id: 'c', result: '{"a":1}' } })).toEqual({ a: 1 });
    expect(unwrap({ id: 'c', result: '"ok"' })).toBe('ok');
    expect(() => unwrap({ id: 'c', error: 'no webview' })).toThrow(/no webview/);
  });
  it('numbers the phone list the way the cluster does', () => {
    const els = toElements([{ i: 0, tag: 'a', text: 'A' }, { i: 1, tag: 'button', text: 'B' }]);
    expect(els.map((e) => e.index)).toEqual([1, 2]);
  });
});

describe('a session on the device', () => {
  it('attaches only when a device with a home connection is online', () => {
    const ring = createSessionRing({ run: phone().run, pickDevice: () => null, log: {} });
    const s = { id: 's1' };
    expect(ring.attach(s, ['me'])).toBe(null);
    expect(s.ring).toBeUndefined();
  });
  it('navigates, reads, analyzes and clicks on the phone, with the cluster numbering', async () => {
    const p = phone();
    const ring = createSessionRing({ run: p.run, pickDevice: () => device, log: {}, wait: async () => {} });
    const s = { id: 's1' };
    ring.attach(s, ['me']);
    const nav = await ring.navigate(s, 'https://www.bol.com/nl/');
    expect(nav).toMatchObject({ url: 'https://www.bol.com/nl/', title: expect.stringMatching(/bol\.com/), onDevice: 'SM-F926B' });
    expect((await ring.content(s)).content).toMatch(/Wekkerlicht/);
    const a = await ring.analyze(s);
    expect(a.elements[0]).toMatchObject({ index: 1, text: 'Bestsellers' });
    await ring.click(s, { index: 2 });
    expect(p.calls.find((c) => c.path === '/v1/click').body).toEqual({ index: 1 });
    await ring.type(s, { index: 2, text: 'wekkerlicht' });
    expect(p.calls.find((c) => c.path === '/v1/type').body).toEqual({ index: 1, text: 'wekkerlicht' });
    expect((await ring.screenshot(s)).data.toString()).toBe('png');
    expect(p.calls.every((c) => c.deviceId === 'd1')).toBe(true);
  });
  it('remembers a host that walled the server, for a while', () => {
    let t = 1000;
    const ring = createSessionRing({ run: phone().run, pickDevice: () => device, log: {}, now: () => t });
    ring.remember('https://www.wholesale-shop.example/nl/s/?q=x', 'HTTP 403');
    expect(ring.knownWall('https://wholesale-shop.example/nl/')).toBe('HTTP 403');
    t += 7 * 60 * 60 * 1000;
    expect(ring.knownWall('https://wholesale-shop.example/nl/')).toBe('');
  });
});

describe('working the page like a person', () => {
  it('accepts the cookie banner after loading a page, and says so', async () => {
    const p = phone();
    const run = async (id, spec) => (spec.path === '/v1/eval'
      ? { result: { result: JSON.stringify('Akceptuj pliki cookie') } }
      : p.run(id, spec));
    const ring = createSessionRing({ run, pickDevice: () => device, log: {}, wait: async () => {} });
    const s = { id: 's2' }; ring.attach(s, ['me']);
    const nav = await ring.navigate(s, 'https://www.bol.com/nl/');
    expect(nav.acceptedCookies).toBe('Akceptuj pliki cookie');
  });
  it('sets AliExpress to the shop market and loads the page again with it', async () => {
    const calls = [];
    const run = async (id, spec) => {
      calls.push(spec);
      if (spec.path === '/v1/eval') return { result: { result: JSON.stringify(/aep_usuc_f/.test(spec.body.code) ? 'set' : '') } };
      return { result: { result: JSON.stringify({ url: 'https://nl.aliexpress.com/w/x.html', title: 'x' }) } };
    };
    const ring = createSessionRing({ run, pickDevice: () => device, log: {}, wait: async () => {} });
    const s = { id: 's3' }; ring.attach(s, ['me']);
    await ring.navigate(s, 'https://www.aliexpress.com/w/wholesale-derma-roller.html');
    expect(calls.filter((c) => c.path === '/v1/navigate')).toHaveLength(2);
    expect(calls.find((c) => /aep_usuc_f/.test(c.body.code || '')).body.code).toMatch(/region=NL/);
  });
  it('leaves other sites alone', () => {
    expect(regionScriptFor('https://www.bol.com/nl/')).toBe('');
    expect(regionScriptFor('https://nl.aliexpress.com/item/1.html')).toMatch(/aep_usuc_f/);
  });
});

describe('marketplaces go to the device first', () => {
  it('sends AliExpress, bol.com and Amazon to the device even when the server is let in', () => {
    const ring = createSessionRing({ run: phone().run, pickDevice: () => device, log: {} });
    expect(ring.knownWall('https://www.aliexpress.com/w/x.html')).toMatch(/home connection/);
    expect(ring.knownWall('https://nl.aliexpress.com/item/1.html')).toMatch(/home connection/);
    expect(ring.knownWall('https://www.bol.com/nl/')).toMatch(/home connection/);
    expect(ring.knownWall('https://www.amazon.nl/s?k=x')).toMatch(/home connection/);
    expect(ring.knownWall('https://example.com/')).toBe('');
  });
});

describe('a page that never finishes loading on the device', () => {
  it('says the app must be open instead of returning an empty page', async () => {
    let t = 0;
    const run = async (id, spec) => (spec.path === '/v1/info'
      ? { result: { result: JSON.stringify({ url: 'https://nl.aliexpress.com/w/x.html', title: '', ready: 'loading' }) } }
      : { result: { result: '""' } });
    const ring = createSessionRing({ run, pickDevice: () => device, log: {}, now: () => t, wait: async (ms) => { t += ms; } });
    const s = { id: 's9' }; ring.attach(s, ['me']);
    const nav = await ring.navigate(s, 'https://www.aliexpress.com/w/x.html');
    expect(nav.notice).toMatch(/Still loading on SM-F926B/);
    const a = await ring.analyze(s);
    expect(a.elementCount).toBe(0);
    expect(a.notice).toMatch(/still loading/);
  });
});

describe('the app on the device is closed', () => {
  it('says the app must be opened instead of returning an empty page', async () => {
    let t = 0;
    const run = async (id, spec) => ({ result: { result: 'null' } });
    const ring = createSessionRing({ run, pickDevice: () => device, log: {}, now: () => t, wait: async (ms) => { t += ms; } });
    const s = { id: 's10' }; ring.attach(s, ['me']);
    const nav = await ring.navigate(s, 'https://www.bol.com/nl/');
    expect(nav.notice).toMatch(/app on SM-F926B is closed/);
    expect((await ring.content(s)).notice).toMatch(/closed/);
  });
});

describe('a phone browser nobody has drawn', () => {
  it('lists the page from the DOM when the screen scan finds next to nothing, and clicks through the page', async () => {
    const calls = [];
    const run = async (id, spec) => {
      calls.push(spec);
      if (spec.path === '/v1/analyze') return { result: { result: JSON.stringify([{ i: 0, tag: 'div', text: 'x' }]) } };
      if (spec.path === '/v1/eval' && /__ringEls=keep/.test(spec.body.code)) return { result: { result: JSON.stringify([{ tag: 'a', text: 'Haargroei serum €3,99', href: 'https://nl.aliexpress.com/item/1.html' }, { tag: 'a', text: 'b' }, { tag: 'a', text: 'c' }, { tag: 'a', text: 'd' }, { tag: 'a', text: 'e' }, { tag: 'button', text: 'Zoeken' }]) } };
      if (spec.path === '/v1/info') return { result: { result: JSON.stringify({ url: 'https://nl.aliexpress.com/w/x.html', title: 't', ready: 'complete' }) } };
      return { result: { result: '""' } };
    };
    const ring = createSessionRing({ run, pickDevice: () => device, log: {}, wait: async () => {} });
    const s = { id: 's11' }; ring.attach(s, ['me']);
    const a = await ring.analyze(s);
    expect(a.elementCount).toBe(6);
    expect(a.elements[0]).toMatchObject({ index: 1, href: 'https://nl.aliexpress.com/item/1.html' });
    await ring.click(s, { index: 1 });
    expect(calls.some((c) => c.path === '/v1/eval' && /__ringEls\[0\]/.test(c.body.code))).toBe(true);
    expect(calls.some((c) => c.path === '/v1/click')).toBe(false);
  });
});

describe('a clicked link goes where it points', () => {
  it('opens the link when the tap left the page unchanged', async () => {
    const calls = []; let url = 'https://nl.aliexpress.com/w/x.html';
    const run = async (id, spec) => {
      calls.push(spec);
      if (spec.path === '/v1/navigate') url = spec.body.url;
      if (spec.path === '/v1/info') return { result: { result: JSON.stringify({ url, title: 't', ready: 'complete' }) } };
      if (spec.path === '/v1/analyze') return { result: { result: JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ i, tag: 'a', text: 'p' + i, href: `//nl.aliexpress.com/item/${i}.html` }))) } };
      return { result: { result: '"ok"' } };
    };
    const ring = createSessionRing({ run, pickDevice: () => device, log: {}, wait: async () => {} });
    const s = { id: 's12' }; ring.attach(s, ['me']);
    await ring.analyze(s);
    const c = await ring.click(s, { index: 3 });
    expect(c.url).toBe('https://nl.aliexpress.com/item/2.html');
  });
});

describe('a human check on the device', () => {
  it('is reported as one, never read as an empty product', async () => {
    let url = 'https://nl.aliexpress.com/w/x.html';
    const run = async (id, spec) => {
      if (spec.path === '/v1/navigate') url = 'https://nl.aliexpress.com//item/1.html/_____tmd_____/punish?x5secdata=abc';
      if (spec.path === '/v1/info') return { result: { result: JSON.stringify({ url, title: '', ready: 'complete' }) } };
      if (spec.path === '/v1/analyze') return { result: { result: JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ i, tag: 'a', text: 'p', href: `//nl.aliexpress.com/item/${i}.html` }))) } };
      return { result: { result: '""' } };
    };
    const ring = createSessionRing({ run, pickDevice: () => device, log: {}, wait: async () => {} });
    const s = { id: 's13' }; ring.attach(s, ['me']);
    await ring.analyze(s);
    const c = await ring.click(s, { index: 2 });
    expect(c.notice).toMatch(/verify you are human/);
    expect(c.notice).toMatch(/Do not try to solve it/);
  });
});

describe('the session profile on the device', () => {
  it('sends the profile the session was opened with (p_ on the phone), none for default', async () => {
    const seen = [];
    const run = async (id, spec) => { seen.push(spec.body); return { result: { result: JSON.stringify({ url: 'u', title: 't', ready: 'complete' }) } }; };
    const ring = createSessionRing({ run, pickDevice: () => device, log: {}, wait: async () => {} });
    const a = { id: 'a', profile: 'linkedin' }; ring.attach(a, ['me']); await ring.scroll(a, 100);
    expect(seen.every((b) => b.profile === 'p_linkedin')).toBe(true);
    seen.length = 0;
    const b = { id: 'b', profile: 'default' }; ring.attach(b, ['me']); await ring.scroll(b, 100);
    expect(seen.every((x) => x.profile === undefined)).toBe(true);
  });
});
