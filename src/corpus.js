/*
 * corpus.js — HOW MUCH TRAINING DATA THERE IS, WITHOUT READING IT ALL EVERY TIME.
 *
 * The status screen needs one honest number: how many finished jobs carry a verdict, by tier, and
 * how many of those arrived since the last training round. The naive way to get it is to read every
 * job file and count. That is 2,240 files and 284 MB today, on a node that is already the busiest
 * thing in the cluster, for a screen somebody leaves open and polls.
 *
 * So the tally is kept, not recomputed:
 *
 *   PER JOB, NOT PER TIER.   The cache remembers each job's id -> {tier, at}, and the tier counts
 *                            are summed from that. Keeping only the counts would be smaller and
 *                            wrong: a job re-judged from silver to gold would be counted twice, and
 *                            the number would drift upward for ever with no way to notice.
 *   BY MTIME.                A file is re-read only if it changed since the last scan, so the
 *                            steady-state cost is one stat per file and no parsing at all.
 *   BOUNDED PER CALL.        The first scan cannot be paid in one request without blocking the node
 *                            for half a minute, so each call reads at most a slice and says so. The
 *                            screen shows it filling in, which is the truth, instead of hanging on
 *                            a spinner and then showing a number that looks instant.
 *
 * A job with no verdict is not an error and not a tier — it simply has not been judged, usually
 * because it is still running. It is counted as `unjudged` so the screen can show that the corpus
 * and the job list do not have to match.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TIERS = ['gold', 'silver', 'bronze', 'void'];
const EMPTY = () => ({ gold: 0, silver: 0, bronze: 0, void: 0 });

/** How many changed files one call is willing to parse. Roughly a second of work on this node. */
const SLICE = 400;

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

const writeJson = (p, v) => {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + '.tmp', JSON.stringify(v));
    fs.renameSync(p + '.tmp', p);
  } catch { /* a cache that cannot be written costs speed, never correctness */ }
};

/**
 * The verdict a job carries, or null if it has not been judged.
 *
 * Read off the job itself rather than re-derived here. The verdict was decided once, by the
 * verifiers, against evidence that existed at the time; deriving it a second time from a different
 * place is how two parts of a system come to disagree about whether a run worked.
 */
function verdictOf(job, judge = null) {
  const v = job && job.verdict;
  if (v && TIERS.includes(v.tier)) return { tier: v.tier, at: v.at || job.endedAt || job.createdAt || '' };

  /*
   * A JOB THAT PREDATES THE VERIFIER STILL HAS AN ANSWER — IT JUST WAS NEVER ASKED.
   *
   * Verdicts are written onto a job when it finishes, so only jobs that ran after the verifiers
   * shipped carry one. Every older job — which is nearly all 2,240 of them — has none, and reading
   * `job.verdict` alone would report a corpus of zero while the training set built from the same
   * directory counts 1,147 gold. Two screens, same data, opposite answers.
   *
   * So when a job carries no verdict, judge it here with the same function the set builder uses. It
   * costs one evaluation per job, once, because the answer is then cached like any other.
   */
  if (!judge || !job) return null;
  try {
    const o = judge(job);
    if (!o || !TIERS.includes(o.tier)) return null;
    return { tier: o.tier, at: job.endedAt || job.createdAt || '' };
  } catch { return null; }
}

/**
 * Bring the tally up to date and return it.
 *
 * `slice` bounds the parsing; when more files are waiting the answer says `pending`, which is the
 * screen's cue that the number is still climbing and not yet the whole truth.
 */
function tally({ dir, cacheFile, slice = SLICE, judge = null } = {}) {
  /* Bump this whenever what is STORED per job changes meaning. A cache written by an older build
     is not merely stale, it is confidently wrong: entries recorded as "read, no verdict" are never
     revisited, because each file is compared against its own mtime. Version 3 is the arrival of the
     judge below, which gives the thousands of jobs that predate stored verdicts a tier at last. */
  const cache = readJson(cacheFile, null) || { v: 3, ids: {} };
  if (cache.v !== 3 || !cache.ids) { cache.v = 3; cache.ids = {}; }

  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); }
  catch { return { tiers: EMPTY(), unjudged: 0, jobs: 0, pending: 0, scanning: false, ids: {} }; }

  const present = new Set();
  const stale = [];

  for (const f of names) {
    const id = f.slice(0, -5);
    present.add(id);
    let m = 0;
    try { m = fs.statSync(path.join(dir, f)).mtimeMs; } catch { continue; }
    /*
     * EACH FILE REMEMBERS ITS OWN MTIME. There is deliberately no single "last scanned" watermark.
     *
     * With one shared watermark a partial slice has no safe value to advance it to: leave it and
     * every already-read file still looks newer than it, so the same first slice is re-read on
     * every call and the count sticks for ever; advance it and the files the slice never reached
     * are marked as seen and are never read at all. Both failures are silent and one of them
     * settles on a plausible wrong number. Per-file mtimes make the question local and exact.
     */
    const known = cache.ids[id];
    if (!known || m > known.m) stale.push({ id, f, m });
  }

  /* Oldest first, so a long first scan fills in chronologically rather than at random. */
  stale.sort((a, b) => a.m - b.m);
  const take = stale.slice(0, slice);

  for (const { id, f, m } of take) {
    const job = readJson(path.join(dir, f), null);
    const v = job ? verdictOf(job, judge) : null;
    /* `tier: null` means read and not judged — distinct from an absent entry, which means never
       read. Collapsing the two would make every unjudged job look like unread backlog for ever. */
    cache.ids[id] = { m, tier: (v && v.tier) || null, at: (v && v.at) || '' };
  }

  /* A job file that is gone should stop being counted; otherwise the corpus only ever grows. */
  for (const id of Object.keys(cache.ids)) if (!present.has(id)) delete cache.ids[id];

  const pending = stale.length - take.length;
  writeJson(cacheFile, cache);

  const tiers = EMPTY();
  let unjudged = 0;
  for (const v of Object.values(cache.ids)) {
    if (v && v.tier) tiers[v.tier]++;
    else unjudged++;
  }

  return {
    tiers,
    unjudged,
    jobs: names.length,
    pending,
    scanning: pending > 0,
    read: Object.keys(cache.ids).length,
    ids: cache.ids,
  };
}

/** How much usable work landed after a moment — the number that decides whether tonight is worth it. */
function usableSince(ids, sinceIso) {
  const since = Date.parse(sinceIso || '') || 0;
  if (!since) return 0;
  let n = 0;
  for (const v of Object.values(ids || {})) {
    /* Bronze and void are kept and trained against differently; neither makes a round worth running,
       so neither counts towards the threshold. */
    if (!v || (v.tier !== 'gold' && v.tier !== 'silver')) continue;
    if ((Date.parse(v.at) || 0) > since) n++;
  }
  return n;
}

module.exports = { tally, usableSince, verdictOf, SLICE };
