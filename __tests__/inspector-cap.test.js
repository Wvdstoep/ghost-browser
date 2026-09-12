/**
 * The look() element list is capped so a pathological page can't flood the model — but the cap must
 * NEVER drop the one button the walk exists to click. A page's primary CTA (Generate, Publish,
 * Publiceren, Download, Save…) is almost always a bottom-right or sticky button that sorts LAST in
 * reading order, so an early top-left cap sliced it off and the agent looped "60 things to click"
 * forever while a human saw the button plainly (ElevenLabs Generate, YouTube Studio Publiceren).
 * Proven to be the cap and not the model: a weak model and a strong model both typed the text then
 * failed to click the exact same missing button. This guards the fix: action buttons and text
 * fields are kept regardless of the cap; ordinary clickables past the cap are still pruned.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { extractElements, dismissConsent } from '../src/inspector.js';

const el = (text, top, left, extra = {}) => ({
  tag: 'button', type: null, id: null, selector: null, ariaLabel: '', placeholder: null, role: null,
  text, href: null, editable: false, on: false, left, top, width: 80, height: 30, ...extra,
});

// A fake page: one main frame whose FRAME_EXTRACTOR returns `raw`, and a page.evaluate that answers
// the viewport-size probes. extractElements maps + clips + caps this exactly as it would a real page.
const mkPage = (raw) => {
  const main = { evaluate: async () => raw };
  return {
    mainFrame: () => main,
    frames: () => [main],
    evaluate: async (fn) => {
      const s = String(fn);
      if (s.includes('innerWidth')) return 1280;
      if (s.includes('innerHeight')) return 800;
      return undefined;
    },
  };
};

describe('the look() cap never drops the primary action button', () => {
  it('keeps a Generate CTA that sorts dead-last, past the cap', async () => {
    const raw = [];
    for (let i = 0; i < 92; i++) raw.push(el(`item ${i}`, i * 8, 10)); // 92 generics, tops 0..728
    raw.push(el('↑ Generate', 790, 1100));                             // the CTA, sorts LAST
    const out = await extractElements(mkPage(raw));

    const gen = out.find((e) => /generate/i.test(e.text));
    expect(gen, 'Generate must survive the cap').toBeTruthy();
    expect(typeof gen.index).toBe('number');
    expect(out.length).toBeLessThanOrEqual(90);           // cap still bounds the list
    // …and the cap still prunes ordinary clickables that fall past it, so this isn't just "keep all".
    expect(out.find((e) => e.text === 'item 90'), 'a generic button past the cap is still pruned').toBeUndefined();
  });

  it('recognises Dutch and other real CTAs, not only English "Generate"', async () => {
    for (const cta of ['Publiceren', 'Download', 'Opslaan', 'Volgende', 'Gereed']) {
      const raw = [];
      for (let i = 0; i < 95; i++) raw.push(el(`row ${i}`, i * 8, 10));
      raw.push(el(cta, 790, 1100));
      const out = await extractElements(mkPage(raw));
      expect(out.find((e) => e.text === cta), `${cta} must survive the cap`).toBeTruthy();
    }
  });

  it('a long paragraph that happens to contain an action word is NOT treated as a CTA', async () => {
    const raw = [];
    for (let i = 0; i < 95; i++) raw.push(el(`row ${i}`, i * 8, 10));
    // A blurb, not a button — must not sneak past the cap just because it says "generate".
    raw.push(el('Our studio can generate a full video for you in minutes with AI voiceover', 790, 1100));
    const out = await extractElements(mkPage(raw));
    expect(out.find((e) => /Our studio/.test(e.text))).toBeUndefined();
  });

  it('still keeps text fields even when scrolled off-screen (existing guarantee intact)', async () => {
    const raw = [];
    for (let i = 0; i < 95; i++) raw.push(el(`row ${i}`, i * 8, 10));
    raw.push(el('', 2000, 10, { editable: true, tag: 'textarea', text: 'message' })); // off-screen field
    const out = await extractElements(mkPage(raw));
    expect(out.find((e) => e.editable), 'an off-screen field is never dropped').toBeTruthy();
  });

  it('keeps a Run button that has scrolled ABOVE the viewport (AI Studio top-right case)', async () => {
    const raw = [];
    for (let i = 0; i < 50; i++) raw.push(el(`item ${i}`, i * 10, 10));    // all in view
    raw.push(el('Run Ctrl ↵', -80, 1100));                                 // scrolled off the TOP
    const out = await extractElements(mkPage(raw));
    expect(out.find((e) => /run/i.test(e.text)), 'off-screen Run must survive').toBeTruthy();
  });

  it('keeps a Generate below the fold (off-screen from the start)', async () => {
    const raw = [];
    for (let i = 0; i < 95; i++) raw.push(el(`item ${i}`, i * 8, 10));     // fill the viewport
    raw.push(el('Generate', 5000, 1100));                                  // far below the fold
    const out = await extractElements(mkPage(raw));
    expect(out.find((e) => e.text === 'Generate'), 'below-the-fold Generate must survive').toBeTruthy();
  });

  it('treats an input styled as submit/button as an action', async () => {
    const raw = [];
    for (let i = 0; i < 95; i++) raw.push(el(`item ${i}`, i * 8, 10));
    raw.push(el('', 5000, 1100, { tag: 'input', type: 'submit', text: '' })); // labelless submit, off-screen
    const out = await extractElements(mkPage(raw));
    expect(out.find((e) => e.tag === 'input' && e.type === 'submit'), 'a submit input must survive').toBeTruthy();
  });

  it('keeps EVERY "Lid worden" join button on a groups results page, not just the first (batch-join)', async () => {
    // The live bug: a Facebook groups search is a page of "Lid worden" buttons. The top nav + left
    // filters fill the reading-order budget first, so a plain cap kept only the FIRST row's join
    // button — the agent could not click the rest and kept RE-SEARCHING. As actions, all must survive.
    const raw = [];
    for (let i = 0; i < 85; i++) raw.push(el(`chrome ${i}`, 10 + (i % 20) * 5, 120)); // nav + filters
    for (let r = 0; r < 6; r++) raw.push(el('Lid worden', 200 + r * 90, 1500));        // six group rows
    const out = await extractElements(mkPage(raw));
    const joins = out.filter((e) => e.text === 'Lid worden');
    expect(joins.length, 'all six join buttons must survive the cap').toBe(6);
  });

  it('collapses a nested button (wrapper + inner spans) into ONE numbered box', async () => {
    const raw = [];
    for (let i = 0; i < 20; i++) raw.push(el(`row ${i}`, i * 8, 10));
    // one "Lid worden" control rendered as 4 overlapping nested boxes at the same spot
    raw.push(el('Lid worden', 300, 1500, { width: 120, height: 40 })); // wrapper (largest)
    raw.push(el('Lid worden', 302, 1508, { width: 90, height: 24 }));  // inner span
    raw.push(el('Lid worden', 305, 1510, { width: 60, height: 20 }));  // inner text
    raw.push(el('Lid worden', 306, 1512, { width: 40, height: 16 }));  // icon+label
    // a DISTINCT join button on another row, far away — must NOT be merged
    raw.push(el('Lid worden', 520, 1500, { width: 120, height: 40 }));
    const out = await extractElements(mkPage(raw));
    const joins = out.filter((e) => e.text === 'Lid worden');
    expect(joins.length, 'nested cluster collapses to one; distinct button kept').toBe(2);
  });

  it('recognises join/follow/connect labels across languages (Deelnemen, Volgen, Connect)', async () => {
    for (const cta of ['Deelnemen', 'Volgen', 'Connect', 'Abonneren']) {
      const raw = [];
      for (let i = 0; i < 95; i++) raw.push(el(`row ${i}`, i * 8, 10));
      raw.push(el(cta, 790, 1100));
      const out = await extractElements(mkPage(raw));
      expect(out.find((e) => e.text === cta), `${cta} must survive the cap`).toBeTruthy();
    }
  });
});

describe('consent banners are dismissed so they cannot cover the main button', () => {
  const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
  // A fake page whose one frame runs the clicker with `document` bound to a jsdom doc holding a bar.
  const mkConsentPage = (html) => {
    if (!JSDOM) return null;
    const dom = new JSDOM(html);
    const g = dom.window;
    // jsdom has no layout, so getBoundingClientRect is all-zero — stub a real size so the guard passes.
    g.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 120, height: 40, top: 700, left: 10, right: 130, bottom: 740 }; };
    const frame = { evaluate: async (fn) => { global.document = g.document; try { return fn(); } finally { delete global.document; } } };
    return { frames: () => [frame], _doc: g.document };
  };

  it('clicks an exact consent phrase (OK, got it) and leaves other buttons alone', async () => {
    const page = mkConsentPage('<div><button id="consent">OK, got it</button><button id="run">Run</button></div>');
    if (!page) return; // jsdom absent — the extract tests above still guard the cap/off-screen fixes
    let clicked = null;
    page._doc.getElementById('consent').addEventListener('click', () => { clicked = 'consent'; });
    page._doc.getElementById('run').addEventListener('click', () => { clicked = 'run'; });
    const hit = await dismissConsent(page);
    expect(hit).toBe('ok, got it');
    expect(clicked, 'only the consent button is clicked, never Run').toBe('consent');
  });

  it('returns null when there is no consent banner', async () => {
    const page = mkConsentPage('<div><button id="run">Run</button><button id="save">Save</button></div>');
    if (!page) return;
    const hit = await dismissConsent(page);
    expect(hit).toBeNull();
  });
});

describe('source guards: the cap was raised and CTAs are recognised', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'inspector.js'), 'utf8');
  it('the cap is 90, not the old 60', () => {
    expect(src).toContain('const CAP = 90');
  });
  it('the action-word set covers the buttons that were being missed', () => {
    const low = src.toLowerCase();
    for (const w of ['generate', 'publish', 'publiceren', 'download', 'save', 'opslaan']) {
      expect(low, w).toContain(`'${w}'`);
    }
  });
});

/*
 * THE WALK WENT BLIND THE MOMENT A DIALOG OPENED.
 *
 * Measured live on the cover-photo flow. The walk clicked "Wijzigen", Facebook opened its cover
 * editor over the page, and the next read said "48 things to click" — of which the editor's own
 * controls were almost none. The numbers had gone on what was BEHIND the modal: the left rail, the
 * tabs, the composer, the whole page chrome, every bit of it inert and every bit of it sorting first
 * in reading order. The one thing inside the dialog the reader did surface was "Annuleren", so the
 * walk pressed it, reopened the dialog, and pressed it again. Twice in the transcript, on its way to
 * forever.
 *
 * Raising the cap would not have fixed it. The background is not lower-priority, it is UNCLICKABLE
 * while a modal is up — which the browser knows, a person knows, and the accessibility tree states
 * outright. The reader now states it too: when a dialog is open, the dialog is the page.
 */
const modalPage = (raw, { modal = false, title = '' } = {}) => {
  const main = { evaluate: async () => ({ elements: raw, modal, title }) };
  return {
    mainFrame: () => main,
    frames: () => [main],
    evaluate: async (fn) => {
      const s = String(fn);
      if (s.includes('innerWidth')) return 1280;
      if (s.includes('innerHeight')) return 800;
      return undefined;
    },
  };
};

describe('when a dialog owns the screen, the read says so', () => {
  it('the list carries the flag through, and the dialog is named', async () => {
    const out = await extractElements(modalPage([el('Opslaan', 300, 500), el('Annuleren', 300, 620)],
      { modal: true, title: 'Omslagfoto bewerken' }));
    expect(out.modal).toBe(true);
    expect(out.modalTitle).toBe('Omslagfoto bewerken');
    expect(out).toHaveLength(2);
  });

  it('and an ordinary page is untouched — no flag, nothing hidden', async () => {
    const out = await extractElements(modalPage([el('Home', 10, 10), el('Opslaan', 300, 500)]));
    expect(out.modal).toBeFalsy();
    expect(out).toHaveLength(2);
  });

  /* The old shape must still read, or a frame answering either way is dropped entirely. */
  it('a frame that answers with a bare list is still read', async () => {
    const out = await extractElements(mkPage([el('Home', 10, 10)]));
    expect(out).toHaveLength(1);
    expect(out.modal).toBeFalsy();
  });
});

/*
 * AND THE MODEL IS TOLD, because a read that drops from 50 controls to 12 looks like a broken page,
 * and the walk's next move is to go hunting for what it "lost" — which is the same loop by another
 * route. The scoping is only half the fix; saying why is the other half.
 */
describe('the source says what the reader promises', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'inspector.js'), 'utf8');

  it('the scope is the topmost dialog', () => {
    expect(src).toMatch(/const top = open\[open\.length - 1\];/);
    expect(src).toMatch(/\[aria-modal="true"\], dialog\[open\], \[role="dialog"\], \[role="alertdialog"\]/);
  });

  /* A hidden dialog is not open, and a tooltip-sized one is not a dialog. Both would blind the walk. */
  it('a hidden or tiny role=dialog is not treated as one', () => {
    expect(src).toMatch(/if \(d\.closest\('\[aria-hidden="true"\],\[inert\]'\)\) return false;/);
    expect(src).toMatch(/if \(r\.width < 200 \|\| r\.height < 120\) return false;/);
  });

  /* A select inside a modal renders its listbox in a portal at the end of body, OUTSIDE the dialog. */
  it('a popup layer opened after the dialog is included with it', () => {
    expect(src).toMatch(/role="listbox"/);
    expect(src).toMatch(/DOCUMENT_POSITION_FOLLOWING/);
  });

  it('and the summary tells the model the page behind is unclickable', () => {
    expect(src).toMatch(/A DIALOG IS OPEN/);
    expect(src).toMatch(/the page behind it cannot be clicked while it is up/);
  });
});

/*
 * ── A DIALOG THAT IS BUILT BUT NOT SHOWN MUST NOT BECOME THE PAGE ────────────────────────────────
 *
 * `display: none` and `visibility: hidden` were the only two ways of being hidden this knew about,
 * and a single-page application has several more. Search Console keeps its panels in the document
 * and hides them with opacity, or parks them outside the window. So every read of the performance
 * report came back as "Verwijderingen — 14 things to click (inside the open dialog)": the walk
 * opened the right address, was told a Removals dialog covered it, closed a dialog that was not
 * there, looked again, got the same answer. Twenty steps of a loop with nothing wrong on screen.
 *
 * The scoping itself is right and stays — a real modal must blind the walk to the page behind it,
 * which is why it was written. What was missing is the difference between present and shown.
 */
describe('a dialog must actually be in front to become the page', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/inspector.js'), 'utf8');

  it('faded out or unclickable is not shown', () => {
    expect(src).toMatch(/if \(Number\(st\.opacity\) === 0\) return false;/);
    expect(src).toMatch(/if \(st\.pointerEvents === 'none'\) return false;/);
  });

  it('and parked outside the window is not covering anything', () => {
    expect(src).toMatch(/if \(r\.right <= 0 \|\| r\.bottom <= 0 \|\| r\.left >= vw \|\| r\.top >= vh\) return false;/);
  });

  /* The deciding test: a modal covers the page, so the point at its centre belongs to it. */
  it('the centre of a real modal hits the modal', () => {
    expect(src).toMatch(/const at = document\.elementFromPoint\(cx, cy\);/);
    expect(src).toMatch(/if \(at && at !== d && !d\.contains\(at\) && !at\.contains\(d\)\) return false;/);
  });

  /*
   * ONLY A DEFINITE ANSWER EXCLUDES IT. Wrongly ignoring a real modal is how the walk went blind on
   * Facebook, which is the failure this whole scope exists to prevent — so an unanswerable hit test
   * keeps the dialog rather than dropping it.
   */
  it('and an unanswerable hit test keeps the dialog rather than dropping it', () => {
    expect(src).toMatch(/the dialog is kept, because wrongly/);
    /* `at &&` is the guard: a null answer never reaches the exclusion. */
    expect(src).toMatch(/if \(at &&/);
  });
});

/*
 * ── A NAVIGATION DRAWER IS NOT A MODAL ───────────────────────────────────────────────────────────
 *
 * Every visibility test asks "is this thing on screen and in front", and a permanent left-hand
 * navigation passes all of them: visible, opaque, clickable, bigger than the size floor. Search
 * Console's nav carries a dialog role, so the reader kept answering "a dialog is open — 14 things to
 * click", handed the walk the fourteen nav links, and hid the report it was already standing on.
 * Three walks spent 130, 159 and 166 steps trying to close a drawer that covered nothing.
 *
 * The separating question is not visibility but whether it has TAKEN OVER. A modal makes the rest of
 * the page unreachable; a drawer leaves it exactly where it was.
 */
describe('a dialog must have taken the page over, not merely be on it', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/inspector.js'), 'utf8');

  /* The two things a platform says when it means it beyond doubt. */
  it('aria-modal and an open <dialog> are taken at their word', () => {
    expect(src).toMatch(/const declared = d\.getAttribute\('aria-modal'\) === 'true'/);
    expect(src).toMatch(/\|\| \(d\.tagName === 'DIALOG' && d\.hasAttribute\('open'\)\)/);
  });

  /*
   * A role alone proves nothing — it is the most-guessed-at attribute on the web — so anything not
   * declared has to prove it by the page behind actually being inert.
   */
  it('anything else must prove it by the page behind being inert', () => {
    expect(src).toMatch(/if \(!declared\) \{/);
    expect(src).toMatch(/!!main\.closest\('\[aria-hidden="true"\],\[inert\]'\)/);
    expect(src).toMatch(/if \(!blocked\) return false;/);
  });

  /* A page with no main landmark still gets an answer rather than a crash or a guess. */
  it('and a page with no main landmark is still decided, not assumed', () => {
    expect(src).toMatch(/body > \[aria-hidden="true"\], body > \[inert\]/);
  });

  /* The failure this cost, named, so the next person loosening it knows the price. */
  it('the drawer that caused it is named in the reasoning', () => {
    expect(src).toMatch(/A NAVIGATION DRAWER IS NOT A MODAL/);
    expect(src).toMatch(/130, 159 and 166/);
  });
});
