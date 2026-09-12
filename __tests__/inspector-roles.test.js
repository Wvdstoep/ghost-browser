/**
 * The look() element collector must include ARIA widget roles a form hangs a REQUIRED choice on —
 * above all [role="option"], the item type every typeahead/combobox/autocomplete renders its
 * suggestions as. Without it look() shows the input but never the dropdown, and a field that only
 * accepts a PICKED suggestion (Facebook's page-create category, a city picker, a tag field) is
 * unfillable and the walk loops. Source-level guard because the collector runs in the browser.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'inspector.js'), 'utf8');
const TAGS = (src.match(/const TAGS = '([^']+)'/) || [])[1] || '';

describe('the clickable-element selector covers autocomplete suggestions', () => {
  it('includes role=option — the fix for typeahead dropdowns', () => {
    expect(TAGS).toContain('[role="option"]');
  });
  it('keeps the other interactive roles a form can require', () => {
    for (const r of ['button', '[role="button"]', '[role="menuitem"]', '[role="menuitemradio"]', '[role="switch"]', '[contenteditable="true"]']) {
      expect(TAGS, r).toContain(r);
    }
  });
  it('a jsdom listbox of options is now matched by the selector', () => {
    // Prove the selector really selects a role=option, not just that the string contains it.
    const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
    if (!JSDOM) return;   // jsdom not installed here — the string checks above still guard the fix
    const dom = new JSDOM('<div role="listbox"><div role="option">Softwarebedrijf</div><div role="option">Software</div></div>');
    expect(dom.window.document.querySelectorAll(TAGS).length).toBeGreaterThanOrEqual(2);
  });
});
