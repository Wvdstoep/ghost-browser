/*
 * THE REST OF A DAY ON FACEBOOK THROUGH THE PHONE (2026-11-20). After the typing and tapping fixes, the
 * cloud session's report listed: one comment listed three or four times in analyze; a read that looked cut
 * off (Facebook folds long posts behind "See more"); no way to tell a human check had been solved; no link
 * to what was just posted; and comments found by polling the notifications page. These hold each fix.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { collapseRepeats, dropSummaryLines } = require('../src/repeats');
const { readPart } = require('../src/readPart');
const { createSessionRing } = require('../src/sessionRing');
const mcp = require('../src/mcp');
const src = (f) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');

const device = { deviceId: 'd1', name: 'SM-F926B' };
const onPage = (spec, re) => spec.path === '/v1/eval' && re.test(spec.body.code || '');
function ringWith(answer) {
  const calls = [];
  const run = async (id, spec) => { calls.push(spec); const v = answer(spec); return { result: { result: JSON.stringify(v === undefined ? null : v) } }; };
  const ring = createSessionRing({ run, pickDevice: () => device, log: {}, wait: async () => {} });
  const s = { id: 'fb' }; ring.attach(s, ['me']);
  return { calls, ring, s };
}

describe('one comment is listed once', () => {
  const box = (index, tag, text, left, top, width, height, extra = {}) => ({ index, tag, text, left, top, width, height, ...extra });
  it('folds nested boxes with the same text into the one that takes clicks, keeping its number', () => {
    const els = [
      box(1, 'div', 'Michael: great post, how do you host it?', 0, 100, 400, 80),
      box(2, 'div', 'Michael: great post, how do you host it?', 10, 110, 380, 60),
      box(3, 'a', 'Michael: great post, how do you host it?', 20, 120, 300, 40, { href: 'https://www.facebook.com/x?comment_id=1' }),
      box(4, 'div', 'Beantwoorden', 20, 170, 80, 16, { role: 'button' }),
      box(5, 'input', '', 0, 300, 400, 40, { editable: true }),
    ];
    const { kept, merged } = collapseRepeats(els);
    expect(merged).toEqual([1, 2]);
    expect(kept.map((e) => e.index)).toEqual([3, 4, 5]);
  });
  it('keeps two links that go to two places, and two copies far apart', () => {
    const { merged } = collapseRepeats([
      box(1, 'a', 'Reply', 0, 0, 50, 20, { href: 'https://a/1' }), box(2, 'a', 'Reply', 0, 0, 50, 20, { href: 'https://a/2' }),
      box(3, 'div', 'Like', 0, 100, 40, 20), box(4, 'div', 'Like', 0, 500, 40, 20),
    ]);
    expect(merged).toEqual([]);
  });
  it('without boxes (the page list), folds only neighbours, and drops their summary lines', () => {
    const { kept, merged } = collapseRepeats([{ index: 1, tag: 'div', text: 'Same thing' }, { index: 2, tag: 'a', text: 'Same thing' }, { index: 3, tag: 'div', text: 'Other' }]);
    expect(merged).toEqual([1]);
    expect(kept.map((e) => e.index)).toEqual([2, 3]);
    expect(dropSummaryLines('A DIALOG IS OPEN\n[1] div — "Same thing"\n[2] a — "Same thing"\n[3] div — "Other"', merged))
      .toBe('A DIALOG IS OPEN\n[2] a — "Same thing"\n[3] div — "Other"');
  });
  it('the phone answers with the folded list, while a click by number still resolves against the full one', async () => {
    const scan = [
      { tag: 'div', text: 'Joanna: super', x: 0, y: 100, w: 400, h: 80 },
      { tag: 'a', text: 'Joanna: super', x: 10, y: 110, w: 300, h: 40, href: 'https://www.facebook.com/x?comment_id=9' },
      { tag: 'div', text: 'Beantwoorden', role: 'button', x: 10, y: 160, w: 80, h: 16 },
      { tag: 'div', text: 'a', x: 0, y: 0, w: 1, h: 1 }, { tag: 'div', text: 'b', x: 0, y: 0, w: 1, h: 1 },
    ];
    const { ring, s } = ringWith((spec) => (spec.path === '/v1/analyze' ? scan : spec.path === '/v1/info' ? { url: 'https://www.facebook.com/x', title: 'FB', ready: 'complete' } : null));
    const r = await ring.analyze(s);
    expect(r.repeatsMerged).toBe(1);
    expect(r.elements.map((e) => e.index)).toEqual([2, 3, 4, 5]);
    expect(r.summary).not.toMatch(/^\[1\]/m);
    expect(s.ring.elements).toHaveLength(5);
  });
  it('the cluster analyze folds the same way', () => {
    expect(src('server.js')).toMatch(/collapseRepeats\(analysis\.elements\)[\s\S]{0,200}dropSummaryLines\(analysis\.summary, merged\)/);
  });
});

describe('a read in parts, and text a site folds away', () => {
  it('comes in parts that say truncated and where the next one starts', () => {
    const page = { url: 'u', content: 'x'.repeat(1500) };
    expect(readPart(page, { maxChars: 600 })).toMatchObject({ chars: 1500, offset: 0, truncated: true, nextOffset: 600 });
    const last = readPart(page, { offset: 1200, maxChars: 600 });
    expect(last.content).toHaveLength(300);
    expect(last.truncated).toBeUndefined();
    expect(readPart(page, {}).content).toHaveLength(1500);
  });
  it('says when the page folds text behind "See more", in the languages it is read in', () => {
    for (const t of ['…Meer weergeven', 'post text... See more', 'tekst Zobacz więcej', 'Mehr anzeigen']) expect(readPart({ content: t }).folded, t).toBe(true);
    expect(readPart({ content: 'a normal page about seeing more of the world' }).folded).toBeUndefined();
  });
});

describe('a human check: the phone hears it, and the session can see when it is solved', () => {
  const walled = (spec) => {
    if (spec.path === '/v1/info') return { url: 'https://www.facebook.com/checkpoint/', title: 'Security check', ready: 'complete' };
    if (spec.path === '/v1/eval' && /innerText\.slice\(0,1500\)/.test(spec.body.code)) return 'Security check\nPlease verify you are human';
    if (spec.path === '/v1/notify') return { notified: true };
    return null;
  };
  it('status says the check is still up', async () => {
    const { ring, s } = ringWith(walled);
    expect(await ring.status(s)).toMatchObject({ humanCheck: true, url: 'https://www.facebook.com/checkpoint/' });
  });
  it('a check found on navigate sends one notification to the phone, not one per call', async () => {
    const { calls, ring, s } = ringWith(walled);
    const r = await ring.navigate(s, 'https://www.facebook.com/groups/x');
    expect(r.notice).toMatch(/sent a notification on SM-F926B/);
    await ring.navigate(s, 'https://www.facebook.com/groups/x');
    await new Promise((ok) => setTimeout(ok, 0));
    const sent = calls.filter((c) => c.path === '/v1/notify');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ tag: 'check', title: 'A site wants a check' });
    expect(sent[0].body.text).toMatch(/^facebook\.com asks to verify/);
  });
});

describe('waiting for what was posted', () => {
  it('returns where the text is and the link next to it', async () => {
    let looks = 0;
    const { ring, s } = ringWith((spec) => {
      if (onPage(spec, /createTreeWalker/)) { looks += 1; return looks < 3 ? { found: false, url: 'https://m.facebook.com/groups/x' } : { found: true, url: 'https://m.facebook.com/groups/x', link: 'https://m.facebook.com/groups/x/posts/123/', near: 'Disclaimer first' }; }
      return null;
    });
    expect(await ring.waitFor(s, 'Disclaimer first', 10000)).toMatchObject({ found: true, link: 'https://m.facebook.com/groups/x/posts/123/' });
    expect(looks).toBe(3);
  });
  it('says so when it never appears', async () => {
    let t = 0;
    const calls = [];
    const run = async (id, spec) => { calls.push(spec); return { result: { result: JSON.stringify(spec.path === '/v1/eval' ? { found: false, url: 'u' } : { url: 'u' }) } }; };
    const ring = createSessionRing({ run, pickDevice: () => device, log: {}, now: () => t, wait: async (ms) => { t += ms; } });
    const s = { id: 'w' }; ring.attach(s, ['me']);
    const r = await ring.waitFor(s, 'never', 3000);
    expect(r).toMatchObject({ found: false });
    expect(r.error).toMatch(/did not appear on the page within 3 s/);
  });
});

describe('the connector has the new tools', () => {
  const names = (mcp.tools || mcp.TOOLS || []).map((t) => t.name);
  it('browser_status, browser_wait_for and watcher_watch_post, routed', () => {
    const list = names.length ? names : (src('mcp.js').match(/\['(browser_[a-z_]+|watcher_[a-z_]+)'/g) || []).map((x) => x.slice(2, -1));
    for (const n of ['browser_status', 'browser_wait_for', 'watcher_watch_post']) expect(list).toContain(n);
    const m = src('mcp.js');
    expect(m).toContain("browser_status: ['GET', `${base}/status`]");
    expect(m).toContain("browser_wait_for: ['POST', `${base}/wait`");
    expect(m).toContain("watcher_watch_post: ['POST', '/v1/watchers/posts'");
  });
  it('a post watcher made here notifies the phone when new comments wait', () => {
    const s = src('server.js');
    expect(s).toMatch(/app\.post\('\/v1\/watchers\/posts'/);
    expect(s).toMatch(/notifyPhone: b\.notify !== false/);
    expect(s).toMatch(/cfg\.notifyPhone && health\.waiting > before/);
    expect(s).toMatch(/path: '\/v1\/notify'/);
  });
});
