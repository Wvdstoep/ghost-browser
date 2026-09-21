/*
 * THE QUOTE MAY NEVER EXCEED THE PROMISE.
 *
 * The bug this covers: `hoursBySize` was decoupled from MAX_WORK_DAYS. An `xl` gig billed its full
 * band of 110 hours (about 14 working days at 8h/day) while the form committed to 7 days, so the
 * offer sold a fortnight of labour with a one-week delivery date on it. Separately, the prompt told
 * the model to price "the whole project" while the delivery rule told it to promise only a working
 * first part, so a CORRECT model produced a commercially incoherent offer: stage one in 7 days,
 * all three stages at one number. Caught on a live useme gig before it was sent.
 *
 * llm is stubbed through require.cache rather than vi.mock: gigWatch is CommonJS and pulls llm with
 * a lazy require() inside offerFor, so seeding the cache is both simpler and closer to reality.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let reply = "";
let seenUser = [];
/* The system message carries every rule we teach the model. Untestable while the stub dropped it. */
let seenSystem = [];
const llmPath = require.resolve("../src/llm");
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true, children: [], paths: [],
  exports: {
    chat: async (a) => {
      seenSystem.push(a.messages[0].content);
      seenUser.push(a.messages[1].content);
      return { content: reply };
    },
  },
};

const gigWatch = require("../src/gigWatch");

const gig = (desc) => ({ title: "t", fields: { desc, offers: 19, budget: "do negocjacji" } });
const model = (size, days) =>
  JSON.stringify({ size, work_days: days, message: "tresc {PRICE} zl", message_en: "text {PRICE} PLN" });

describe("offerFor: the quote may not exceed the promise", () => {
  beforeEach(() => { reply = ""; });

  it("caps an xl band at what the committed days can hold", async () => {
    reply = model("xl", 7);
    const o = await gigWatch.offerFor(gig("big multi system integration"), { pricing: {} });
    expect(o.workDays).toBe(7);
    expect(o.bandHours).toBe(110);
    expect(o.hours).toBe(56);          // 7 days x 8h, NOT the 110h band
    expect(o.scoped).toBe(true);
    expect(o.payment).toBe(6400);      // 56 x 130 x 0.88 = 6406.4 -> nearest 50
  });

  it("leaves a small gig inside the day budget untouched", async () => {
    reply = model("small", 2);
    const o = await gigWatch.offerFor(gig("upload one csv"), { pricing: {} });
    expect(o.hours).toBe(8);
    expect(o.scoped).toBe(false);
  });

  it("never returns more hours than the committed days allow, for any band", async () => {
    for (const size of ["small", "medium", "large", "xl"]) {
      for (const days of [1, 3, 7, 21]) {
        reply = model(size, days);
        const o = await gigWatch.offerFor(gig("x"), { pricing: {} });
        expect(o.workDays).toBeLessThanOrEqual(7);
        expect(o.hours).toBeLessThanOrEqual(o.workDays * 8);
      }
    }
  });

  it("honours a pinned price so redrafting the words cannot move the quote", async () => {
    reply = model("xl", 7);
    const o = await gigWatch.offerFor(gig("big"), { pricing: {}, pinnedPayment: 6850 });
    expect(o.payment).toBe(6850);
  });

  it("takes hoursPerDay from the owners config, not a hardcoded 8", async () => {
    reply = model("xl", 5);
    const o = await gigWatch.offerFor(gig("big"), { pricing: { hoursPerDay: 6 } });
    /*
     * 7 days, not the 5 the model asked for: useme refuses work_days under 7 (measured live - 1, 2,
     * 3 and 5 were each rejected with "Podaj poprawna liczbe dni" while 7 submitted at once), so the
     * floor applies before hours are derived. 7 days x 6h = 42, still under the 110h xl band.
     */
    expect(o.workDays).toBe(7);
    expect(o.hours).toBe(42);
  });
});

/*
 * THE TERM IS PINNED LIKE THE PRICE.
 *
 * The price pin alone was not stability. The same gig came back `xl` at 7 days on one run and
 * `large` at 5 days on the next, and because the price was held at 6850 while the scope shrank
 * from 56 to 40 hours, the offer silently drifted to 171 zl/h against a 130 rate. Pinning the
 * days closes that. The prompt must also LEARN the pinned term, otherwise clamping it after the
 * model has written its message reproduces the original defect: prose describing one scope while
 * the form commits to another.
 */
describe("offerFor: a pinned term holds, and the model is told about it", () => {
  beforeEach(() => { reply = ""; seenUser = []; });

  it("keeps the agreed term instead of the model's answer", async () => {
    reply = model("large", 5);
    const o = await gigWatch.offerFor(gig("x"), { pricing: {}, pinnedWorkDays: 7 });
    expect(o.workDays).toBe(7);
    expect(o.daysPinned).toBe(true);
    expect(o.hours).toBe(56);          // 7 x 8, not the 5-day 40
  });

  it("tells the model the term is fixed, so the words match the form", async () => {
    reply = model("large", 5);
    await gigWatch.offerFor(gig("x"), { pricing: {}, pinnedWorkDays: 7 });
    const sent = seenUser[seenUser.length - 1];
    expect(sent).toContain("TERMIN JEST JUZ USTALONY");
    expect(sent).toContain("work_days = 7");
  });

  it("says nothing about a term when none is pinned", async () => {
    reply = model("large", 5);
    const o = await gigWatch.offerFor(gig("x"), { pricing: {} });
    /* Unpinned means the FLOOR, not the model's number: 5 is not a window useme will accept. */
    expect(o.workDays).toBe(7);
    expect(o.daysPinned).toBe(false);
    expect(seenUser[seenUser.length - 1]).not.toContain("TERMIN JEST JUZ USTALONY");
  });

  it("will not let a pinned term break the one week rule", async () => {
    reply = model("xl", 3);
    const o = await gigWatch.offerFor(gig("x"), { pricing: {}, pinnedWorkDays: 30 });
    expect(o.workDays).toBe(7);
  });
});

/*
 * -- USEME WILL NOT TAKE A WINDOW UNDER SEVEN DAYS, AND A QUICK JOB IS NOT PRICED AS A DAY --------
 *
 * Measured by sending real offers. work_days of 1, 2, 3 and 5 were each refused with "Podaj poprawna
 * liczbe dni" - the value WAS in the field and the field still errored - and 7 submitted at once.
 * The first offer only went through because the ceiling happened to sit exactly on that floor, so
 * nothing in the code knew the floor existed.
 *
 * And a client who wrote "praca przewidziana na okolo 30-45 minut" was quoted 900 zl, because the
 * smallest band was a full day. A quote ten times the work loses the gigs that are easiest to win
 * and reads as not having read the job.
 */
describe('the window useme accepts, and the price a quick job deserves', () => {
  beforeEach(() => { reply = ""; seenUser = []; seenSystem = []; });

  it('never files a window under seven days, whatever the model answers', async () => {
    for (const d of [1, 2, 3, 5]) {
      reply = model("tiny", d);
      const o = await gigWatch.offerFor(gig("quick"), { pricing: {} });
      expect(o.workDays, `model asked for ${d}`).toBe(7);
    }
  });

  /* The whole point of the tiny band. */
  it('a sub-hour job is a minimum engagement, not a day of work', async () => {
    reply = model("tiny", 1);
    const o = await gigWatch.offerFor(gig("dwie konwersje, 30-45 minut przez AnyDesk"), { pricing: {} });
    expect(o.size).toBe("tiny");
    expect(o.payment).toBe(200);
  });

  it('while a real day of work still prices as one', async () => {
    reply = model("small", 7);
    const o = await gigWatch.offerFor(gig("wgranie pliku csv"), { pricing: {} });
    expect(o.payment).toBe(900);
  });

  /* The minimum engagement is data: a board with a different economy is a config line, not a deploy. */
  it('and the minimum engagement is the owners to set', async () => {
    reply = model("tiny", 1);
    const o = await gigWatch.offerFor(gig("quick"), { pricing: { minPricePln: 350 } });
    expect(o.payment).toBe(350);
  });

  /*
   * THE FORM WINDOW MUST NEVER BE READ AS THE DELIVERY PROMISE. A 45-minute job that files 7 days and
   * says nothing about timing reads as a week's wait, which loses it to whoever said "today".
   */
  it('tells the model the seven days are a ceiling, not when the work lands', async () => {
    reply = model("tiny", 1);
    await gigWatch.offerFor(gig("quick"), { pricing: {} });
    const sys = seenSystem[seenSystem.length - 1] || "";
    expect(sys).toContain("Formularz useme przyjmuje tylko 7 dni");
    expect(sys).toContain("TYLKO gorna");
  });

  it('and offers the tiny band as a choice at all', async () => {
    reply = model("tiny", 1);
    await gigWatch.offerFor(gig("quick"), { pricing: {} });
    expect(seenSystem[seenSystem.length - 1]).toContain('"tiny"');
  });
});
