// Reading a page means reading the page, not the banner over it.
//
// Live, 2026-09-11: useme.com/pl/projects/ sits behind a Polish CookieScript dialog. A probe read
// 2044 characters and every one of them was the banner's own cookie categories; the flow's reader
// role then spent its whole budget and returned no page text, so the verify step failed. Three
// Workshop builds died on that exact shape. The cause was not the site: dismissConsent lived only
// inside analyzePage, so a cookie wall was cleared when the agent called look() and never when it
// called read() — and "open then read" is precisely what a data flow does.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import inspector from '../src/inspector.js';

const perceive = readFileSync(fileURLToPath(new URL('../src/tools/perceive.js', import.meta.url)), 'utf8');

describe('read() clears a consent wall before taking the text', () => {
  it('pulls dismissConsent from the inspector rather than reimplementing it', () => {
    expect(perceive).toMatch(/const \{ dismissConsent \} = require\('\.\.\/inspector'\)/);
    expect(typeof inspector.dismissConsent).toBe('function');
  });

  it('dismisses BEFORE the text is taken, and never lets a missing banner throw', () => {
    const read = perceive.slice(perceive.indexOf('async read(ctx, a) {'));
    const atDismiss = read.indexOf('dismissConsent(ctx.page())');
    const atText = read.indexOf('document.body && document.body.innerText');
    expect(atDismiss).toBeGreaterThan(-1);
    expect(atText).toBeGreaterThan(-1);
    expect(atDismiss, 'the banner goes before the text is read').toBeLessThan(atText);
    expect(read).toMatch(/try \{ dismissed = await dismissConsent\(ctx\.page\(\)\); \} catch/);
    // a banner that WAS clicked needs a beat for the page under it to settle
    expect(read).toMatch(/if \(dismissed\) await ctx\.settle\(600\);/);
  });

  it('says so in the run journal, so a changed reading is explainable', () => {
    expect(perceive).toMatch(/cleared a consent banner first/);
  });

  it('look() still does it too — the two paths agree', () => {
    const insp = readFileSync(fileURLToPath(new URL('../src/inspector.js', import.meta.url)), 'utf8');
    const analyze = insp.slice(insp.indexOf('async function analyzePage'));
    expect(analyze).toMatch(/await dismissConsent\(page\)/);
  });

  it('the phrase list covers the markets the company ships into', () => {
    const insp = readFileSync(fileURLToPath(new URL('../src/inspector.js', import.meta.url)), 'utf8');
    // Polish first: it is the home market, and its absence is what cost three builds.
    for (const phrase of ['akceptuję', 'zgadzam się', 'accept all', 'alle akzeptieren', 'tout accepter', 'accetta tutto', 'hyväksy kaikki']) {
      expect(insp, phrase).toContain(phrase);
    }
  });
});
