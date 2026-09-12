// THE VERIFY STEP COULD NEVER PASS — the reason the library stayed empty through seven builds.
//
// Watched live on 2026-09-11, build run#33. Its flow ran flawlessly: the login check said signedIn,
// the branch took the signed-in path, the agent read the page and its own report quoted the title
// "Praca Zdalna ... Zlecenia dla freelancerow" and twenty job listings. On the very same url, the
// verify step returned found=false. Four redesigns later it was still false.
//
// The verify step was asking confirmPosted, which answers a different question: "is the comment I
// just typed actually posted?" For THAT, demanding a long distinctive string and refusing to guess
// below 40 alphanumerics is correct. But makeRunVerify reads `found === true`, so the null that means
// "too short to tell" arrived as "not on the page". Every proof a builder would sensibly pick is
// short — a currency code, a heading, a price — so the verify contract was unsatisfiable, no flow
// could be filed, and the builds were not confused: they were being told plain text was absent.
//
// These tests pin the two questions apart, and the first one is the regression: it fails outright
// against confirmPosted.
import { describe, it, expect } from 'vitest';
import agent from '../src/agent.js';

const { pageHasText, confirmPosted, flatten, stripMarks, readableText } = agent;

/* A stand-in page: page.evaluate(readableText) is the only thing either function asks of it. */
const pageShowing = (text, { failEvaluate = false } = {}) => ({
  evaluate: async (fn) => {
    if (failEvaluate) throw new Error('the page went away');
    expect(fn).toBe(readableText);          // both must read the same visible-text walk
    return text;
  },
});

const USEME = 'Praca Zdalna » Praca Online Oferty » Zlecenia dla freelancerów '
  + 'Sklep internetowy WooCommerce 2 500 PLN Strona wizytówka dla kancelarii 1 200 PLN';

describe('the verify step asks whether the page says this', () => {
  it('THE REGRESSION — a short, sensible proof is FOUND, where confirmPosted could only say null', async () => {
    for (const proof of ['PLN', 'Zlecenia dla freelancerów', 'WooCommerce', '2 500 PLN']) {
      expect(await pageHasText(pageShowing(USEME), proof), proof).toBe(true);
      // the old route: too short to identify, so null — which makeRunVerify read as "not found"
      expect(await confirmPosted(pageShowing(USEME), proof, [0]), proof).toBeNull();
    }
  });

  it('says false, not true, when the page genuinely does not say it', async () => {
    expect(await pageHasText(pageShowing(USEME), 'Zapisane oferty', [0])).toBe(false);
    expect(await pageHasText(pageShowing(''), 'PLN', [0])).toBe(false);
  });

  it('accents, case and line breaks cannot hide a match', async () => {
    // the builder typed the diacritics; the page has them too, but neither side may depend on it
    expect(await pageHasText(pageShowing('ZLECENIA DLA FREELANCEROW'), 'Zlecenia dla freelancerów', [0])).toBe(true);
    expect(await pageHasText(pageShowing('Zlecenia dla freelancerów'), 'zlecenia dla freelancerow', [0])).toBe(true);
    // markup spacing: a heading split across lines is still that heading
    expect(await pageHasText(pageShowing('Zlecenia' + String.fromCharCode(10) + '   dla  freelancerów'), 'Zlecenia dla freelancerów', [0])).toBe(true);
  });

  it('refuses to answer on something that could not be evidence, and never says yes', async () => {
    expect(await pageHasText(pageShowing(USEME), 'PL', [0])).toBeNull();
    expect(await pageHasText(pageShowing(USEME), '', [0])).toBeNull();
    expect(await pageHasText(pageShowing(USEME), null, [0])).toBeNull();
  });

  it('a page it cannot read is "cannot tell", not "not there"', async () => {
    expect(await pageHasText(pageShowing(USEME, { failEvaluate: true }), 'PLN', [0])).toBeNull();
  });

  it('retries a page that is still settling, and stops as soon as it sees it', async () => {
    let look = 0;
    const settling = { evaluate: async () => { look += 1; return look < 3 ? 'Ładowanie…' : USEME; } };
    expect(await pageHasText(settling, 'PLN', [0, 0, 0])).toBe(true);
    expect(look).toBe(3);                    // it kept looking, and stopped on success
  });
});

describe('confirmPosted is left exactly as it was', () => {
  // It answers a different question and its floor is right for that one: a typed-but-unsent reply
  // once read as posted, which is the bug its 40-character floor and middle-slice exist to prevent.
  const reply = 'Thanks for flagging this — I have run into the same thing on two other projects and the fix was in the build step, not the config.';

  it('still confirms a long distinctive string that is on the page', async () => {
    expect(await confirmPosted(pageShowing('Some thread ' + reply + ' 2h ago'), reply, [0])).toBe(true);
  });

  it('still refuses to guess below its floor, and still says false when absent', async () => {
    expect(await confirmPosted(pageShowing('anything'), 'too short', [0])).toBeNull();
    expect(await confirmPosted(pageShowing('No comments, yet.'), reply, [0])).toBe(false);
  });
});

describe('flattening', () => {
  it('folds case, drops accents without gluing or splitting words, collapses the rest to spaces', () => {
    expect(flatten('Zlecenia dla freelancerów')).toBe('zlecenia dla freelancerow');
    expect(flatten('2 500 PLN')).toBe('2 500 pln');
    expect(flatten('  a — b  ')).toBe('a b');
    expect(flatten(null)).toBe('');
    // the mark is removed, never turned into a space: that would split the word in two
    expect(stripMarks('é').length).toBe(1);
  });
});
