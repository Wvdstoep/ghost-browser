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
const platforms = require('./trainScopes');
const learned = require('./learned');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const LEDGER = () => path.join(DIR(), 'slices.json');

/** The mark a turn carries when its decision could see the page (traceset.toJsonl). */
const SIGHTED = '"sighted":true';

/** A tool with fewer than this many examples in a slice may as well be absent. */
const FLOOR = 4;

/** No single tool may exceed this share of a slice, however common it really is. */
const CAP_SHARE = 0.15;

/*
 * NO SINGLE RUN MAY DOMINATE A SLICE EITHER — the same mistake, one axis over.
 *
 * Measured across 1,226 usable runs holding 40,031 turns: the longest tenth supplied 41% of the
 * set and the longest quarter supplied 71%. Runs of five turns or fewer contributed 595 turns in
 * total; runs of forty or more contributed 28,210. Long runs outweigh short ones forty-seven to
 * one, while being only twice as numerous.
 *
 * That is not a judgement about quality, it is arithmetic: a run that takes sixty steps yields
 * sixty examples and a run that takes two yields two. And it points the wrong way, because sixty
 * steps for something achievable in five is usually the model STRUGGLING. Such a run is gold on the
 * strength of its ending, while its middle is forty steps of confusion — so the set over-samples
 * precisely the runs where the agent coped worst, and teaches the next model to flail.
 *
 * The median run is twelve turns. Capping there gives every run its fair say and costs only the
 * marathons their surplus.
 */
/* How much of its natural share a tool keeps however weak its neighbours are. See the draw. */
const REHEARSE = 0.6;
const PER_RUN = 12;
/* The weight weakness.js gives a tool that is never right; a second copy is for tools near it. */
const WORST_ENOUGH = 3;
/* A learned turn is drawn again when its tool is right less than half the time. */
const AGAIN_AT = 2;

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

/* Which run a turn came from, so no one run can flood a slice. */
const JOB = /"jobId":"([^"]+)"/;
const jobOf = (line) => { const m = JOB.exec(line); return m ? m[1] : ''; };
const isGold = (line) => line.includes('"tier":"gold"') || line.includes('"tier": "gold"');

/*
 * HOW WELL THE RUN WAS CONDUCTED, not only whether it worked.
 *
 * `best` is a clean run with outside confirmation. Preferring it is the whole answer to a measured
 * problem: 537 messy runs supplied 29,627 turns against 10,468 from 693 clean ones, so three
 * quarters of the training data came from runs that stalled, were refused a tool, or never finished
 * on their own. Sorting on the tier alone cannot see the difference.
 */
const { rankOf } = require('./quality');
const GRADE = /"grade":"([a-z]+)"/;
const gradeOf = (line) => { const m = GRADE.exec(line); return m ? m[1] : (isGold(line) ? 'gold' : 'silver'); };

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
/*
 * A SCOPE, WHEN THE ROUND HAS ONE (platforms.js). A platform round draws only that platform's
 * lines; a role round only that role's; base draws everything. The ledger marks a line WITH the
 * scope that took it, so the same line is drawn once per scope and never twice for one - the base
 * adapter and the facebook adapter both learn from a Facebook turn, each in its own round.
 */
const keyOf = (scope) => (scope ? platforms.parse(scope).key : 'base');
const marksOf = (v) => String(v == null ? '' : v).split(',').filter(Boolean);
/*
 * WHOSE MARK IT IS. The shelf is the scope for the incumbent - so every mark ever written keeps
 * meaning what it meant - and `scope@student` for any other model. Two students draw the same
 * turns; two shares of one student still divide them.
 */
const takenBy = (mark, key) => marksOf(mark).some((m) => { const bar = m.indexOf('|'); return (bar < 0 ? 'base' : m.slice(0, bar)) === key; });
const withMark = (mark, key, roundId) => [...marksOf(mark), `${key}|${roundId || 1}`].join(',');

function draw({ file, builtAt, want = 700, roundId = '', perRun = PER_RUN, scope = null, weights = null, student = '' } = {}) {
  const key = keyOf(scope);
  /* The ledger shelf this student draws against. See takenBy. */
  const mine = learned.shelf(key, student);
  const lines = [];
  const raw = fs.readFileSync(file, 'utf8');
  /* Split once; the file is large but this runs a handful of times a day, not per request. */
  for (const ln of raw.split('\n')) { if (ln.trim()) lines.push(ln); }

  /* The weight of a tool, before the pool is grouped - the skip above needs it. */
  const weightOf0 = (tool) => { const w = weights && Number(weights[tool]); return Number.isFinite(w) && w > 0 ? w : 1; };
  const ledger = ledgerFor(builtAt);
  const taken = ledger.taken || {};
  /* Learned turns - trained on by an adapter that passed the gates - are never drawn again for
     this scope, in this build or any later one. The ledger above is per build; this is not. */
  /* LEARNED BY WHOM: a student that has never trained on this corpus is owed all of it. */
  const done = learned.setFor(key, student);

  /*
   * SIGHTED TURNS ONLY, once the set has any. A blind turn - a decision recorded without the page
   * it was taken on - is what two rounds collapsed on, and the readiness gate counts sighted turns
   * for exactly that reason; a draw that then filled the round with blind ones would undo the gate.
   * A set built before the flag existed has none marked, and is drawn as before.
   */
  const sightedOnly = lines.some((l) => l.includes(SIGHTED));

  /* Group the ones still available, by tool. */
  const byTool = new Map();
  let pool = 0;
  let takenHere = 0;
  for (let i = 0; i < lines.length; i++) {
    if (sightedOnly && !lines[i].includes(SIGHTED)) continue;
    if (scope && !platforms.matches(scope, lines[i])) continue;
    pool++;
    if (taken[i] && takenBy(taken[i], mine)) { takenHere++; continue; }
    /*
     * LEARNED MEANS LEARNED. A turn a promoted adapter trained on is not drawn again - unless the
     * model still fails its tool (weight at or above AGAIN_AT: right less than half the time).
     * Skipping the examples of the thing it cannot do is how a failure becomes permanent.
     */
    if (done.size && done.has(learned.idOf(lines[i])) && weightOf0(toolOf(lines[i])) < AGAIN_AT) { takenHere++; continue; }
    const tool = toolOf(lines[i]);
    if (!tool) continue;
    if (!byTool.has(tool)) byTool.set(tool, []);
    byTool.get(tool).push(i);
  }

  /* Best first inside each tool: a clean run with outside confirmation, then a confirmed one, then
     a clean unconfirmed one. Evidence still outranks tidiness — a scruffy run that produced a file
     with bytes in it beats a neat one nothing could check. */
  for (const idxs of byTool.values()) idxs.sort((a, b) => rankOf(gradeOf(lines[a])) - rankOf(gradeOf(lines[b])));

  const available = [...byTool.values()].reduce((n, v) => n + v.length, 0);
  if (!available) return { jsonl: '', count: 0, tools: {}, remaining: 0, exhausted: true, scope: key, pool };

  /*
   * A quota per tool: its real share of what is left, but never fewer than FLOOR and never more
   * than CAP of the slice. The floor is what stops `finish` from being invisible; the cap is what
   * stops `open` from being the whole round. Between them the model still learns that looking and
   * reading are what you mostly do, which is true and is the single most reliable signal in the set.
   */
  const cap = Math.max(FLOOR, Math.floor(want * CAP_SHARE));
  /*
   * AND A BIGGER SHARE FOR WHAT THE MODEL GETS WRONG (weakness.js). A tool's natural share is how
   * often it appears; its weight is how often the model that serves this scope fails it. The
   * shares are re-normalised so the round is still `want` turns, and the cap still holds, so a
   * failing tool is trained harder without becoming the whole round.
   */
  const weightOf = (tool) => { const w = weights && Number(weights[tool]); return Number.isFinite(w) && w > 0 ? w : 1; };
  let weighted = 0;
  for (const [tool, idxs] of byTool) weighted += idxs.length * weightOf(tool);
  const quota = new Map();
  for (const [tool, idxs] of byTool) {
    const natural = idxs.length / available;
    const skewed = weighted > 0 ? (idxs.length * weightOf(tool)) / weighted : natural;
    /*
     * AND A FLOOR UNDER WHAT IT ALREADY KNOWS. Weighting a weak tool up weights a strong one down,
     * and the round that proved it took `dig` from 82.5% to 2.5% while lifting the three tools it
     * was aimed at - one forgotten tool cost more than the whole round gained. However weak its
     * neighbours, a tool keeps REHEARSE of the share its own frequency earns it. The budget is
     * fixed, so what it keeps comes off the commonest tools, which have thousands of examples.
     */
    const share = Math.round(want * Math.max(skewed, natural * REHEARSE));
    quota.set(tool, Math.min(idxs.length, Math.max(Math.min(FLOOR, idxs.length), Math.min(share, cap))));
  }

  const picked = [];
  const cursor = new Map();
  /* How many turns each run has already given this slice. See PER_RUN. */
  const fromRun = new Map();
  const take = (tool, n) => {
    const idxs = byTool.get(tool);
    let at = cursor.get(tool) || 0;
    let got = 0;
    while (got < n && at < idxs.length && picked.length < want) {
      const i = idxs[at];
      at++;
      const job = jobOf(lines[i]);
      if (job) {
        const used = fromRun.get(job) || 0;
        /* A marathon run has already said what it has to say; the rest of the budget belongs to
           runs that have not been heard from. */
        if (used >= perRun) continue;
        fromRun.set(job, used + 1);
      }
      picked.push(i);
      got++;
    }
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

  /*
   * AND AGAIN, FOR WHAT THE MODEL GETS WRONG. The turns above are every turn this scope still had;
   * when the round can hold more than that (a GPU asks for thousands), the failing tools' turns are
   * repeated rather than the round being short. Twice more at most, in proportion to the weight, so
   * `open` at three times its weight is seen three times where `read` is seen once - and three
   * epochs make that nine passes against three. Duplicates are drawn from the picked turns only, so
   * nothing unlearned is spent twice and the ledger still marks each line once.
   */
  const extra = [];
  if (picked.length && picked.length < want && weights && Object.keys(weights).length) {
    const byWeight = picked
      .map((i) => ({ i, w: weightOf(toolOf(lines[i])) }))
      .filter((x) => x.w > 1.05)
      .sort((a, b) => b.w - a.w);
    for (let copy = 0; copy < 2 && extra.length + picked.length < want; copy++) {
      for (const { i, w } of byWeight) {
        if (extra.length + picked.length >= want) break;
        /* The second copy only for the tools that fail hardest. */
        if (copy === 1 && w < (1 + (WORST_ENOUGH - 1) * 0.6)) continue;
        extra.push(i);
      }
    }
  }

  for (const i of picked) taken[i] = withMark(taken[i], mine, roundId);
  ledger.taken = taken;
  ledger.handed = Object.keys(taken).length;
  writeJson(LEDGER(), ledger);

  const all = [...picked, ...extra];
  const tools = {};
  for (const i of all) { const tl = toolOf(lines[i]); tools[tl] = (tools[tl] || 0) + 1; }

  return {
    jsonl: all.map((i) => lines[i]).join('\n'),
    count: all.length,
    fresh: picked.length,
    repeated: extra.length,
    tools,
    remaining: Math.max(0, pool - takenHere - picked.length),
    scope: key,
    pool,
    /* Nothing left means the set has been through once. The planner turns to new data at that
       point rather than starting over on turns the model has already seen. */
    exhausted: picked.length === 0,
  };
}

/**
 * WHAT THE DRAW COULD STILL GIVE, per scope: the pool (sighted lines the scope matches) minus the
 * learned ones minus those taken in this build. One pass over the file for every scope asked, so
 * the planner's rows cost one read. The planner counts THIS as untrained, not the sighted total.
 */
function availability({ file, builtAt, scopes = [], student = '' } = {}) {
  const out = {};
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()); } catch { for (const s of scopes) out[keyOf(s)] = { pool: 0, learned: 0, taken: 0, free: 0 }; return out; }
  const ledger = ledgerFor(builtAt);
  const taken = ledger.taken || {};
  const sightedOnly = lines.some((l) => l.includes(SIGHTED));
  const want = scopes.map((s) => ({ scope: s, key: keyOf(s), mine: learned.shelf(keyOf(s), student), done: learned.setFor(keyOf(s), student), pool: 0, learned: 0, taken: 0 }));
  for (let i = 0; i < lines.length; i++) {
    if (sightedOnly && !lines[i].includes(SIGHTED)) continue;
    let id = null;
    for (const w of want) {
      if (w.scope && w.key !== 'base' && !platforms.matches(w.scope, lines[i])) continue;
      w.pool++;
      if (w.done.size) { if (id === null) id = learned.idOf(lines[i]); if (w.done.has(id)) { w.learned++; continue; } }
      if (taken[i] && takenBy(taken[i], w.mine)) w.taken++;
    }
  }
  for (const w of want) out[w.key] = { pool: w.pool, learned: w.learned, taken: w.taken, free: Math.max(0, w.pool - w.learned - w.taken) };
  return out;
}

/** How much of this set has been handed out — the honest basis for "is the corpus covered". */
function progress(builtAt, total, scope = null) {
  const l = ledgerFor(builtAt);
  const key = keyOf(scope);
  let handed = 0;
  for (const v of Object.values(l.taken || {})) if (takenBy(v, key)) handed++;
  return { handed, total: Number(total) || 0, builtAt, scope: key };
}

/** Forget the marks and start the set again — an explicit act, never a side effect of a build. */
function reset(builtAt) { writeJson(LEDGER(), { builtAt, taken: {}, handed: 0 }); }

/**
 * A ROUND THAT ENDED WITHOUT ITS TURNS GIVES THEM BACK. Stopped, discarded or dead, its lines are
 * free for the next round of the same build; only the marks that name this round (its id, its
 * share `<batch>@<device>`, or `single@<device>`) go, and only for its scope. Case does not matter.
 * Returns how many lines were released.
 */
function release({ scope = null, marks = [], student = '' } = {}) {
  const l = readJson(LEDGER(), null);
  if (!l || !l.taken) return 0;
  /* Give back what THIS student took, off the shelf the draw wrote to. */
  const key = learned.shelf(keyOf(scope), student);
  const want = new Set((marks || []).map((m) => String(m).toLowerCase()));
  let n = 0;
  for (const [i, v] of Object.entries(l.taken)) {
    const kept = marksOf(v).filter((m) => {
      const bar = m.indexOf('|');
      const k = bar < 0 ? 'base' : m.slice(0, bar);
      const who = (bar < 0 ? m : m.slice(bar + 1)).toLowerCase();
      return !(k === key && want.has(who));
    });
    if (kept.length !== marksOf(v).length) {
      n++;
      if (kept.length) l.taken[i] = kept.join(','); else delete l.taken[i];
    }
  }
  l.handed = Object.keys(l.taken).length;
  writeJson(LEDGER(), l);
  return n;
}

/**
 * THE EXAM — a sample of the evaluation split, not the top of it.
 *
 * The scoring turns used to be the FIRST N rows of eval.jsonl. The split is cut by job, which is
 * right — it stops a job contributing to both training and scoring — but it also means the rows
 * arrive job by job, so the first 150 of them are a handful of whole jobs rather than a sample of
 * anything. Measured on the set built 2026-09-23: 39.3% of the exam was `dig`, and `open` — 15% of
 * what the round trains on and the most common real action there is — did not appear once.
 *
 * A round could therefore correct its whole tool distribution and be scored almost entirely on one
 * research tool. The number would be honest and would measure the wrong thing, which is worse than
 * a number that is obviously wrong.
 *
 * So: proportional to the split's own distribution, with the same floor and cap the training draw
 * uses, and DETERMINISTIC — comparing two rounds is only meaningful on identical turns, so the
 * shuffle is seeded with a constant and the tools are walked in a fixed order. Rebuilding the set
 * changes the exam, which is unavoidable and is why a round records the manifest it was built
 * from; within one built set, every round sits the same exam.
 *
 * Unlike the training draw there is no ledger and no gold preference: an exam is not consumed, and
 * scoring only on the tidiest turns would flatter the model.
 */
function exam({ file, want = 150, scope = null, perRun = PER_RUN } = {}) {
  const NL = String.fromCharCode(10);
  const key = keyOf(scope);
  const lines = fs.readFileSync(file, 'utf8').split(NL).filter((l) => l.trim());

  /* The paper is sighted too, for the same reason as the slice: a blind question measures guessing. */
  const sightedOnly = lines.some((l) => l.includes(SIGHTED));
  const byTool = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (sightedOnly && !lines[i].includes(SIGHTED)) continue;
    if (scope && !platforms.matches(scope, lines[i])) continue;
    const tool = toolOf(lines[i]);
    if (!tool) continue;
    if (!byTool.has(tool)) byTool.set(tool, []);
    byTool.get(tool).push(i);
  }
  if (!byTool.size) return { jsonl: '', count: 0, tools: {}, scope: key };

  /* A seeded shuffle, so the same set always produces the same exam. Math.random here would mean
     two rounds an hour apart were marked on different papers and the difference reported as
     progress. */
  /* Base keeps the seed it always had; every other scope gets its own, so a platform's paper is
     as fixed as base's and never the same rows in the same order. */
  let seed = 7;
  if (key !== 'base') for (const c of key) seed = (seed * 31 + c.charCodeAt(0)) % 2147483647;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const tools = [...byTool.keys()].sort();
  for (const tl of tools) {
    const a = byTool.get(tl);
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  }

  /* Shares over the scope's own pool, not the whole file: a platform's paper is shaped like the platform. */
  const total = [...byTool.values()].reduce((n, v) => n + v.length, 0);
  const cap = Math.max(FLOOR, Math.floor(want * CAP_SHARE));
  const need = new Map();
  for (const tl of tools) {
    const have = byTool.get(tl).length;
    const share = Math.round((want * have) / total);
    need.set(tl, Math.min(have, Math.max(FLOOR, Math.min(cap, share))));
  }

  /* Clamping moves the total either way; settle the difference against the tools that still have
     rows, largest first, since that is where the turns belong. */
  const sum = () => [...need.values()].reduce((a, b) => a + b, 0);
  const bySize = [...tools].sort((a, b) => byTool.get(b).length - byTool.get(a).length);
  let guard = 0;
  while (sum() > want && guard++ < 10000) {
    for (let i = bySize.length - 1; i >= 0 && sum() > want; i--) {
      const tl = bySize[i];
      if (need.get(tl) > 1) need.set(tl, need.get(tl) - 1);
    }
  }
  guard = 0;
  while (sum() < want && guard++ < 10000) {
    let moved = false;
    for (const tl of bySize) {
      if (sum() >= want) break;
      if (need.get(tl) < Math.min(byTool.get(tl).length, cap)) { need.set(tl, need.get(tl) + 1); moved = true; }
    }
    if (!moved) break;
  }

    /*
   * AND NO RUN MAY OWN THE PAPER. A job three hundred steps long would otherwise fill a tool's
   * whole quota by itself. Each run gives at most `perRun` turns; when one is full, the quota
   * passes to the next run's turns of that tool, so the paper stays a sample of the corpus.
   */
  const picked = [];
  const fromRun = new Map();
  for (const tl of tools) {
    let left = need.get(tl);
    for (const i of byTool.get(tl)) {
      if (left <= 0) break;
      const run = jobOf(lines[i]) || `line-${i}`;
      const used = fromRun.get(run) || 0;
      if (perRun > 0 && used >= perRun) continue;
      fromRun.set(run, used + 1);
      picked.push(i);
      left--;
    }
  }
  picked.sort((a, b) => a - b);

  const counted = {};
  for (const i of picked) { const tl = toolOf(lines[i]); counted[tl] = (counted[tl] || 0) + 1; }
  return { jsonl: picked.map((i) => lines[i]).join(NL), count: picked.length, tools: counted, scope: key };
}

module.exports = {
  REHEARSE, draw, exam, progress, reset, release, availability, toolOf, jobOf, isGold, keyOf, takenBy, LEDGER, FLOOR, CAP_SHARE, PER_RUN, SIGHTED };
