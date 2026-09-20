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
const llmPath = require.resolve("../src/llm");
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true, children: [], paths: [],
  exports: { chat: async () => ({ content: reply }) },
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
    expect(o.hours).toBe(30);
  });
});
