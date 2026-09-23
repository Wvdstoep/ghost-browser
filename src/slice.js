/*
 * slice.js — WHICH TURNS A PARTICULAR ROUND GETS, DECIDED HERE AND NOT ON THE DEVICE.
 *
 * The obvious arrangement is to hand every trainer the whole set and let it sample. It is wrong for
 * two reasons, and the second one is the expensive kind of wrong:
 *
 *   STORAGE.   The set is 141 MB and a round reaches about seven hundred turns of it. Shipping
 *              141 MB so a machine can use three percent is absurd on a big disk and impossible on
 *              a laptop with four gigabytes free — and "whichever laptop is connected" has to mean
 *              the small one too.
 *   OVERLAP.   Two devices each drawing their own random sample train on overlapping turns. You
 *              would run two machines, get well under twice the work, and nothing anywhere would
 *              say so: both rounds report turns trained, both losses fall, and the corpus is
 *              covered far more slowly than the arithmetic suggests. Assigning the slices from one
 *              place makes them disjoint by construction.
 *
 * So this draws the slice, remembers what went out, and never hands the same turn to two rounds
 * until the whole set has been through.
 *
 * HOW THE DRAW IS SHAPED, AND THE MISTAKE THAT COST ROUND ONE.
 *
 * The first version round-robinned over tools: every tool got its first example before any tool got
 * its second. It was guarding against a real problem — `open` and `read` are a third of every call
 * ever recorded, and a slice that mirrors that teaches a model which is excellent at opening pages
 * and has seen `finish` four times.
 *
 * It overshot completely. With 685 turns across 66 tools, equal shares means about ten examples
 * each, so the model was taught that all 66 tools are equally likely. Measured result: it collapsed
 * onto `diagnostics`, scored 0/15 on `read`, 0/11 on `look`, 0/9 on `click` and 0/7 on `type` — the
 * four tools that matter most — while reaching 100% on `save_keywords`, whose goal text gives the
 * answer away. Overall agreement went 5% to 20% and the round looked like a win.
 *
 * So: PROPORTIONAL to the real distribution, with a FLOOR so a rare tool is never invisible, and a
 * CAP so no tool can take the slice. The prior is information the model needs; flattening it is
 * throwing away the most reliable thing in the data.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const LEDGER = () => path.join(DIR(), 'slices.json');

/** A tool with fewer than this many examples in a slice may as well be absent. */
const FLOOR = 4;

/** No single tool may exceed this share of a slice, however common it really is. */
const CAP_SHARE = 0.15;

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(v));
  fs.renameSync(p + '.tmp', p);
};

/* The tool a line answers with, read off the raw text. Parsing 23,233 lines into objects to pick
   seven hundred of them costs hundreds of megabytes for nothing. */
const TOOL = /\{\\"tool\\":\\"([a-z_]+)\\"/;
const toolOf = (line) => { const m = TOOL.exec(line); return m ? m[1] : null; };
const isGold = (line) => line.includes('"tier":"gold"') || line.includes('"tier": "gold"');

/**
 * The ledger of what has already been handed out.
 *
 * Keyed by the set's `builtAt`: a rebuilt set is a different set, line numbers no longer mean the
 * same rows, and carrying the old marks across would skip turns that were never trained on while
 * claiming coverage. A new build starts the ledger again, deliberately.
 */
function ledgerFor(builtAt) {
  const l = readJson(LEDGER(), null);
  if (!l || l.builtAt !== builtAt) return { builtAt, taken: {}, handed: 0 };
  return l;
}

/**
 * Draw the next slice.
 *
 * @param file     the train.jsonl to draw from
 * @param builtAt  the set's manifest timestamp, so a rebuild resets the ledger
 * @param want     how many turns this round should get
 * @param roundId  who it went to, for the record
 * @returns { jsonl, count, tools, remaining, exhausted }
 */
function draw({ file, builtAt, want = 700, roundId = '' } = {}) {
  const lines = [];
  const raw = fs.readFileSync(file, 'utf8');
  /* Split once; the file is large but this runs a handful of times a day, not per request. */
  for (const ln of raw.split('\n')) { if (ln.trim()) lines.push(ln); }

  const ledger = ledgerFor(builtAt);
  const taken = ledger.taken || {};

  /* Group the ones still available, by tool. */
  const byTool = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (taken[i]) continue;
    const tool = toolOf(lines[i]);
    if (!tool) continue;
    if (!byTool.has(tool)) byTool.set(tool, []);
    byTool.get(tool).push(i);
  }

  /* Gold first inside each tool: gold means something outside the run's own report agreed the work
     happened, and a slice should spend its budget on the best evidence available. */
  for (const idxs of byTool.values()) idxs.sort((a, b) => (isGold(lines[b]) ? 1 : 0) - (isGold(lines[a]) ? 1 : 0));

  const available = [...byTool.values()].reduce((n, v) => n + v.length, 0);
  if (!available) return { jsonl: '', count: 0, tools: {}, remaining: 0, exhausted: true };

  /*
   * A quota per tool: its real share of what is left, but never fewer than FLOOR and never more
   * than CAP of the slice. The floor is what stops `finish` from being invisible; the cap is what
   * stops `open` from being the whole round. Between them the model still learns that looking and
   * reading are what you mostly do, which is true and is the single most reliable signal in the set.
   */
  const cap = Math.max(FLOOR, Math.floor(want * CAP_SHARE));
  const quota = new Map();
  for (const [tool, idxs] of byTool) {
    const share = Math.round(want * (idxs.length / available));
    quota.set(tool, Math.min(idxs.length, Math.max(Math.min(FLOOR, idxs.length), Math.min(share, cap))));
  }

  const picked = [];
  const cursor = new Map();
  const take = (tool, n) => {
    const idxs = byTool.get(tool);
    let at = cursor.get(tool) || 0;
    for (let i = 0; i < n && at < idxs.length && picked.length < want; i++, at++) picked.push(idxs[at]);
    cursor.set(tool, at);
  };

  /* Rarest first, so the floors are honoured before the budget is spent. */
  const order = [...byTool.keys()].sort((a, b) => byTool.get(a).length - byTool.get(b).length);
  for (const tool of order) take(tool, quota.get(tool));

  /* Anything left over goes to the tools that actually have more to give, in proportion — the
     rounding above leaves a remainder and it belongs with the common tools, not spread evenly. */
  const byCommon = [...byTool.keys()].sort((a, b) => byTool.get(b).length - byTool.get(a).length);
  let guard = 0;
  while (picked.length < want && guard++ < 10000) {
    const before = picked.length;
    for (const tool of byCommon) {
      if (picked.length >= want) break;
      if ((cursor.get(tool) || 0) < byTool.get(tool).length) take(tool, 1);
    }
    if (picked.length === before) break;
  }

  for (const i of picked) taken[i] = roundId || 1;
  ledger.taken = taken;
  ledger.handed = Object.keys(taken).length;
  writeJson(LEDGER(), ledger);

  const tools = {};
  for (const i of picked) { const tl = toolOf(lines[i]); tools[tl] = (tools[tl] || 0) + 1; }

  return {
    jsonl: picked.map((i) => lines[i]).join('\n'),
    count: picked.length,
    tools,
    remaining: lines.length - ledger.handed,
    /* Nothing left means the set has been through once. The planner turns to new data at that
       point rather than starting over on turns the model has already seen. */
    exhausted: picked.length === 0,
  };
}

/** How much of this set has been handed out — the honest basis for "is the corpus covered". */
function progress(builtAt, total) {
  const l = ledgerFor(builtAt);
  return { handed: l.handed || 0, total: Number(total) || 0, builtAt };
}

/** Forget the marks and start the set again — an explicit act, never a side effect of a build. */
function reset(builtAt) { writeJson(LEDGER(), { builtAt, taken: {}, handed: 0 }); }

module.exports = { draw, progress, reset, toolOf, isGold, LEDGER, FLOOR, CAP_SHARE };
