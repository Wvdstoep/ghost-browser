/*
 * THE WATCHER MUST NOTICE BAD POLISH ITSELF.
 *
 * The first real useme offer came back with no Polish diacritics anywhere ("magazynow",
 * "obsluga", "dzialajacy"), a typo, and a bare "to 6850" with no currency. Nothing in the
 * pipeline noticed. The owner did, reading the draft, which is the wrong place to catch it.
 *
 * Root cause of the diacritics: VOICE_PL was ITSELF written without them, so it taught the
 * model diacritic-free Polish by example. Fixing the prompt is necessary but it is only a
 * request, so these tests cover the CHECK: detection, one corrective retry, and reporting
 * whatever still fails instead of shipping it silently.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let queue = [];
let seenSystem = [];
const llmPath = require.resolve("../src/llm");
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true, children: [], paths: [],
  exports: {
    chat: async (a) => {
      seenSystem.push(a.messages[0].content);
      return { content: queue.shift() || "" };
    },
  },
};

const gigWatch = require("../src/gigWatch");

const gig = () => ({ title: "t", fields: { desc: "integracja", offers: 19, budget: "x" } });
const say = (message) => JSON.stringify({ size: "medium", work_days: 5, message, message_en: "en" });

const GOOD = "Potrzebujecie integracji SAP z BaseLinkerem. Zaprojektuję przepływ danych i wdrożę "
  + "synchronizację stanów magazynowych. Cena pierwszego etapu to {PRICE} zl. Czy macie dostęp do API?";
const NO_MARKS = "Potrzebujecie integracji SAP z BaseLinkerem. Zaprojektuje przeplyw danych i wdroze "
  + "synchronizacje stanow magazynowych. Cena pierwszego etapu to {PRICE} zl. Czy macie dostep do API?";

describe("voiceIssues: the three faults that are cheap to catch", () => {
  it("flags Polish of real length carrying no diacritics at all", () => {
    expect(gigWatch.voiceIssues(NO_MARKS)).toContain("brak-polskich-znakow");
    expect(gigWatch.voiceIssues(GOOD)).not.toContain("brak-polskich-znakow");
  });

  it("flags a price token with no currency after it", () => {
    expect(gigWatch.voiceIssues("Cena to {PRICE}.")).toContain("cena-bez-waluty");
    expect(gigWatch.voiceIssues("Cena to {PRICE} zl.")).not.toContain("cena-bez-waluty");
    expect(gigWatch.voiceIssues("Cena to {PRICE} zł.")).not.toContain("cena-bez-waluty");
  });

  it("flags plural and singular address mixed in one offer", () => {
    expect(gigWatch.voiceIssues("Potrzebujecie tego, wiec masz problem."))
      .toContain("mieszana-forma-adresu");
    expect(gigWatch.voiceIssues("Potrzebujecie tego, wiec macie problem."))
      .not.toContain("mieszana-forma-adresu");
  });

  it("does not punish a short line for having no diacritics", () => {
    expect(gigWatch.voiceIssues("Zrobie to w 3 dni.")).toEqual([]);
  });
});

describe("offerFor: one corrective retry, then report what survives", () => {
  beforeEach(() => { queue = []; seenSystem = []; });

  it("retries when the Polish comes back without diacritics, and keeps the good one", async () => {
    queue = [say(NO_MARKS), say(GOOD)];
    const o = await gigWatch.offerFor(gig(), { pricing: {} });
    expect(seenSystem.length).toBe(2);                      // it actually retried
    expect(seenSystem[1]).toContain("POPRAWKA");            // and told the model what was wrong
    expect(seenSystem[1]).toContain("brak-polskich-znakow");
    expect(o.voiceIssues).toEqual([]);
    expect(o.text).toContain("Zaprojektuję");
  });

  it("does not retry when the first answer is already clean", async () => {
    queue = [say(GOOD)];
    const o = await gigWatch.offerFor(gig(), { pricing: {} });
    expect(seenSystem.length).toBe(1);
    expect(o.voiceIssues).toEqual([]);
  });

  it("reports the fault instead of hiding it when both attempts are bad", async () => {
    queue = [say(NO_MARKS), say(NO_MARKS)];
    const o = await gigWatch.offerFor(gig(), { pricing: {} });
    expect(seenSystem.length).toBe(2);
    expect(o.voiceIssues).toContain("brak-polskich-znakow");
  });

  it("substitutes the price and leaves the currency the model wrote", async () => {
    queue = [say(GOOD)];
    const o = await gigWatch.offerFor(gig(), { pricing: {} });
    expect(o.text).toContain(String(o.payment) + " zl");
    expect(o.text).not.toContain("{PRICE}");
  });
});

describe("the voice is the owners data, not the codes", () => {
  beforeEach(() => { queue = []; seenSystem = []; });

  it("uses a voice from watcher config when one is set", async () => {
    queue = [say(GOOD)];
    await gigWatch.offerFor(gig(), { pricing: { voice: "PISZ PO KASZUBSKU" } });
    expect(seenSystem[0]).toContain("PISZ PO KASZUBSKU");
  });

  it("falls back to the built in voice, which is itself spelled with diacritics", async () => {
    queue = [say(GOOD)];
    await gigWatch.offerFor(gig(), { pricing: {} });
    // the regression that caused this whole class of bug: an ASCII-only prompt
    expect(seenSystem[0]).toMatch(/[ąćęłńóśźż]/);
    expect(seenSystem[0]).toContain("ORTOGRAFIA");
  });
});
