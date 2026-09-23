/**
 * A LIST OF RESULTS IS NOT ONE CONTROL DRAWN LARGE.
 *
 * look() keeps the biggest box in a cluster of overlapping ones, which is right and was itself a
 * fix: an <a> wrapper and its inner spans all cover the same place, and numbering each of them drew
 * five boxes for one button and produced dozens of phantom clicks.
 *
 * It is exactly wrong the other way round. Overlap is measured against the SMALLER box, so a card
 * inside a panel scores ~1.0 and is dropped in favour of the panel. Measured on Google Maps: look()
 * returned six elements and the fifth was one div holding every search result concatenated. The
 * agent could not click a single plumber, looked three times, and was forced to act by the observe
 * limiter with nothing to act on.
 *
 * Both halves are tested here, because a fix to one that breaks the other is not a fix.
 */
import { describe, it, expect } from 'vitest';
import { extractElements } from '../src/inspector.js';

const box = (text, top, left, width, height, extra = {}) => ({
  tag: 'a', type: null, id: null, selector: null, ariaLabel: '', placeholder: null, role: null,
  text, href: 'https://example.com', editable: false, on: false,
  left, top, width, height, ...extra,
});

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

const textsOf = (els) => els.map((e) => e.text);

describe('a panel of results', () => {
  it('OFFERS EVERY CARD, NOT THE PANEL THAT HOLDS THEM', async () => {
    /* Five plumbers stacked down a side panel, exactly the Maps shape: the panel wraps them all and
       each card sits wholly inside it. */
    const raw = [
      box('Hydraulik A Hydraulik B Hydraulik C Hydraulik D Hydraulik E', 100, 0, 400, 500, { tag: 'div' }),
      box('Hydraulik A', 100, 0, 380, 90),
      box('Hydraulik B', 200, 0, 380, 90),
      box('Hydraulik C', 300, 0, 380, 90),
      box('Hydraulik D', 400, 0, 380, 90),
      box('Hydraulik E', 500, 0, 380, 90),
    ];
    const got = textsOf(await extractElements(mkPage(raw)));
    expect(got).toContain('Hydraulik A');
    expect(got).toContain('Hydraulik E');
    /* And the container full of concatenated names is gone — it is not a thing you can click. */
    expect(got.some((t) => /Hydraulik A Hydraulik B/.test(t))).toBe(false);
  });
});

describe('one control drawn as several boxes', () => {
  it('stays ONE number — the behaviour that stopped the phantom clicks', async () => {
    /* A join button: the <a> wrapper and its inner spans all cover the same place. Numbering each
       made the agent read five indices as five buttons. */
    const raw = [
      box('Lid worden', 100, 100, 120, 40),
      box('Lid worden', 102, 102, 116, 36, { tag: 'span' }),
      box('Lid', 104, 104, 40, 32, { tag: 'span' }),
      box('worden', 104, 150, 60, 32, { tag: 'span' }),
    ];
    /* One NUMBER for the control, which is the property that matters. Counting every element
       returned would also be asserting things about decorative spans this fix never touched — and
       the original code answers those identically, so a count here tests the wrong thing. */
    const got = await extractElements(mkPage(raw));
    expect(got.filter((e) => e.text === 'Lid worden').length).toBe(1);
  });

  it('does not split a button into its icon and its label', async () => {
    /* The trap in the obvious fix. An icon and a label do not overlap EACH OTHER, so "children that
       sit apart" alone would cut every button in half. A stack has one place; a list has several,
       and the parent of a list is far bigger than any one of its children. */
    const raw = [
      box('Download', 100, 100, 140, 40),
      box('', 108, 106, 24, 24, { tag: 'span' }),
      box('Download', 108, 136, 90, 24, { tag: 'span' }),
    ];
    const got = await extractElements(mkPage(raw));
    expect(got.filter((e) => e.text === 'Download').length).toBe(1);
  });

  it('keeps a tall wrapper that only holds one real control', async () => {
    /* Three children, but the wrapper is barely bigger than the largest of them — a stack, not a
       list, and splitting it would hand back fragments of one button. */
    const raw = [
      box('Publiceren', 100, 100, 200, 60),
      box('Publiceren', 105, 105, 190, 50, { tag: 'span' }),
      box('', 110, 110, 20, 20, { tag: 'span' }),
      box('nu', 110, 260, 20, 20, { tag: 'span' }),
    ];
    const got = await extractElements(mkPage(raw));
    expect(got.filter((e) => e.text === 'Publiceren').length).toBe(1);
  });
});
