/*
 * coverage.js — WHAT THE SET ACTUALLY HOLDS, PER TOOL, SIGHTED OR BLIND.
 *
 * The manifest says how many turns the set has and how many can see their page. The planner and
 * the collector need one level finer: for EACH tool, how many sighted examples exist - because a
 * set with three thousand sighted turns of `look` and none of `open` is not ready, and the
 * collector should be aiming at `open`, not at whatever has the fewest turns of any kind.
 *
 * Read off the raw lines with regular expressions, never by parsing: the set is a hundred-odd
 * megabytes and parsing it into objects beside a running browser is what killed the first trainer.
 * Cached by the file's size and mtime, so a screen polling every few seconds costs nothing.
 */
'use strict';

const fs = require('fs');
const { toolOf } = require('./slice');

const SIGHTED = '"sighted":true';
const TIER = /"tier":"(gold|silver|bronze|void)"/;
const JOB = /"jobId":"([^"]+)"/;

/** One pass over a jsonl set. */
function scan(path) {
  const out = { total: 0, sighted: 0, perTool: {}, tiers: { gold: 0, silver: 0, bronze: 0, void: 0 }, sightedTiers: { gold: 0, silver: 0, bronze: 0, void: 0 }, jobIds: new Set() };
  let text = '';
  try { text = fs.readFileSync(path, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    out.total++;
    const tool = toolOf(line) || '?';
    const sighted = line.includes(SIGHTED);
    const tier = (TIER.exec(line) || [])[1] || 'void';
    const job = (JOB.exec(line) || [])[1];
    if (job) out.jobIds.add(job);
    const row = out.perTool[tool] || (out.perTool[tool] = { all: 0, sighted: 0, gold: 0 });
    row.all++;
    out.tiers[tier] = (out.tiers[tier] || 0) + 1;
    if (sighted) {
      out.sighted++;
      row.sighted++;
      out.sightedTiers[tier] = (out.sightedTiers[tier] || 0) + 1;
      if (tier === 'gold') row.gold++;
    }
  }
  return out;
}

/** How many exam jobs also appear in the train set. Zero is the only acceptable answer. */
function overlap(train, exam) {
  let n = 0;
  for (const id of exam.jobIds) if (train.jobIds.has(id)) n++;
  return n;
}

const cache = new Map();
function stampOf(path) {
  try { const s = fs.statSync(path); return `${s.size}:${s.mtimeMs}`; } catch { return 'missing'; }
}
/** The scan, cached until the file changes. */
function cached(path) {
  const stamp = stampOf(path);
  const hit = cache.get(path);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = scan(path);
  cache.set(path, { stamp, value });
  return value;
}

/** The part of a scan a screen wants: totals and the per-tool rows, largest first. */
function summary(cov, { top = 60 } = {}) {
  const perTool = Object.entries(cov.perTool)
    .sort((a, b) => b[1].all - a[1].all)
    .slice(0, top)
    .map(([tool, v]) => ({ tool, all: v.all, sighted: v.sighted, gold: v.gold }));
  return { total: cov.total, sighted: cov.sighted, tiers: cov.tiers, sightedTiers: cov.sightedTiers, jobs: cov.jobIds.size, perTool };
}

module.exports = { scan, overlap, cached, summary, SIGHTED };
