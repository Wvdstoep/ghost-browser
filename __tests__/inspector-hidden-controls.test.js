import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { extractElements } from '../src/inspector.js';

// 2026-11-13, Business Suite's post scheduler, through the connector: "The scheduling switch isn't
// exposed as a clickable element" and "the time field isn't exposed as an element". The shape of
// both, rebuilt here and read by the real extractor in a real browser.
const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:20px">
  <label id="sw-label" style="display:inline-flex;align-items:center;gap:8px;padding:6px">
    <input id="sw" type="checkbox" role="switch" aria-label="Plannen" style="position:absolute;width:1px;height:1px;opacity:0">
    <span style="display:inline-block;width:40px;height:22px;border-radius:11px;background:#ccc"></span>
    <span>Plannen</span>
  </label>
  <div style="margin-top:20px">
    <div role="spinbutton" aria-label="Uur" aria-valuenow="20" aria-valuetext="20" tabindex="-1" style="display:inline-block;width:30px;height:24px">20</div>:
    <div role="spinbutton" aria-label="Minuut" aria-valuenow="29" tabindex="-1" style="display:inline-block;width:30px;height:24px">29</div>
  </div>
  <input type="time" aria-label="Tijd" value="20:29" style="margin-top:20px">
  <div role="combobox" aria-label="Tijdzone" tabindex="-1" style="margin-top:20px;width:160px;height:24px">CET</div>
  <div role="radio" aria-label="Nu publiceren" aria-checked="true" style="width:120px;height:24px">Nu publiceren</div>
</body></html>`;

let browser, page, els;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent(PAGE);
  els = await extractElements(page);
  els = Array.isArray(els) ? els : els.elements;
}, 60000);
afterAll(async () => { await browser?.close(); });

const find = (re) => els.find((e) => re.test(e.text || e.ariaLabel || ''));

describe('controls a page draws over or builds from roles', () => {
  it('a switch whose real input is 1px and transparent is listed at its label, and clicking there toggles it', async () => {
    const sw = find(/^Plannen$/);
    expect(sw, JSON.stringify(els.map((e) => e.text))).toBeTruthy();
    expect(sw.width).toBeGreaterThan(40);                       // the label's box, not the 1px input
    await page.mouse.click(sw.x, sw.y);
    expect(await page.$eval('#sw', (i) => i.checked)).toBe(true);
  });

  it('a time picker made of spin buttons shows each box with its value, as a field', () => {
    const h = find(/^Uur/); const m = find(/^Minuut/);
    expect(h).toMatchObject({ role: 'spinbutton', editable: true });
    expect(h.text).toBe('Uur = 20');
    expect(m.text).toBe('Minuut = 29');
  });

  it('a native time input, a combobox and a radio are listed; the time input is a field', () => {
    expect(find(/^Tijd$/)).toMatchObject({ type: 'time', editable: true });
    expect(find(/^Tijdzone/)).toMatchObject({ role: 'combobox', editable: true });
    expect(find(/^Nu publiceren/)).toMatchObject({ role: 'radio', on: true });
  });
});

// Found live on v720 the same day: an app that scrolls an inner PANE (Business Suite, most docs) — a
// click on an off-screen element wheeled the window, nothing moved, and the click hit mid-screen.
describe('a click on something below the fold of a scrolling pane', () => {
  it('scrolls that pane (not the window) and clicks the thing itself', async () => {
    const { bringIntoView, clickByIndex } = await import('../src/inspector.js');
    const p = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await p.setContent(`<!doctype html><html><body style="margin:0;overflow:hidden;height:100vh;display:flex">
      <nav style="width:200px;height:100vh;overflow:auto">${'<a href="#">link</a><br>'.repeat(5)}</nav>
      <main id="pane" style="flex:1;height:100vh;overflow:auto">
        <div style="height:1800px"></div>
        <input id="far" aria-label="Uur" onclick="window.hit=(window.hit||0)+1">
        <div style="height:600px"></div>
      </main></body></html>`);
    let list = await extractElements(p); list = Array.isArray(list) ? list : list.elements;
    const { analyzePage } = await import('../src/inspector.js');
    const a = await analyzePage(p);
    const far = a.elements.find((e) => e.id === 'far');
    expect(far, 'an off-screen field is still listed').toBeTruthy();
    expect(far.y).toBeGreaterThan(700);
    await p.mouse.move(100, 100);                                  // the pointer over the OTHER pane, as it is after a nav click
    const t = await bringIntoView(p, await clickByIndex(p, far.index, a.elements));
    expect(t.y).toBeGreaterThan(0); expect(t.y).toBeLessThan(700);
    await p.mouse.click(t.x, t.y);
    expect(await p.evaluate(() => window.hit)).toBe(1);
    expect(await p.evaluate(() => document.getElementById('pane').scrollTop)).toBeGreaterThan(1000);
    await p.close();
  }, 60000);
});
