#!/usr/bin/env node
/*
 * inspect-runs.js — WHAT DID TODAY'S RUNS ACTUALLY TEACH?
 *
 * A run that felt successful and a run that produces training data are different things, and the
 * difference is invisible from the outside. This answers the four questions that decide whether an
 * afternoon of browsing was worth anything:
 *
 *   WHAT TIER, AND WHY.     Gold means something outside the run's own report confirmed it. Silver
 *                           means the run said so and nothing could check. The words are printed,
 *                           not just the label, because "a report and no error, but nothing external
 *                           to check" tells you what to do differently next time.
 *   WAS A CLAIM CAUGHT.     A verifier contradicting the report is the single most valuable thing in
 *                           the corpus and the easiest to miss — the run looks fine and says so.
 *   DID THE LOOKS RECORD.   Until recently a look stored "2 things to click" and threw the numbered
 *                           list away, which made every click and type unlearnable. This counts how
 *                           many looks carry it now.
 *   HOW MANY TURNS SURVIVED. Turns, not steps. Thrown calls and repeated identical decisions are
 *                           dropped, so a long run can yield far less than its length suggests.
 *
 * Usage:  node scripts/inspect-runs.js [--hours 12] [--all]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { outcomeOf } = require('../src/verify');
const traceset = require('../src/traceset');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HOURS = Number(opt('--hours', 12));
const ALL = argv.includes('--all');

const BASE = process.env.PROFILE_DIR || '/profiles';
const DIR = path.join(BASE, 'jobs');

const deps = {
  files: () => { try { return require('../src/fileAssets').list(); } catch { return []; } },
  recordings: () => { try { return [...require('../src/recorder').list()]; } catch { return []; } },
  runs: (id) => { try { return require('../src/workflows').readRun(id); } catch { return null; } },
};

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const since = Date.now() - HOURS * 3600 * 1000;

const rows = [];
let scanned = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  scanned++;
  const at = Date.parse(j.endedAt || j.createdAt || '') || 0;
  if (!ALL && at < since) continue;

  const o = outcomeOf(j, deps);
  const steps = j.steps || [];
  const looks = steps.filter((s) => s.kind === 'look');
  const withMarks = looks.filter((s) => s.marks).length;
  /* What the builder would actually keep from this run — the only number that matters for training. */
  let turns = 0;
  try { turns = traceset.turnsOf(j, {}).length; } catch { turns = 0; }
  const indexTurns = (() => {
    try { return traceset.turnsOf(j, {}).filter((t) => t.action && t.action.args && t.action.args.index !== undefined).length; }
    catch { return 0; }
  })();

  rows.push({
    id: j.id,
    at: (j.endedAt || j.createdAt || '').slice(0, 16).replace('T', ' '),
    tier: o.tier,
    why: (o.why || []).join('; '),
    caught: (o.failures || []).length ? (o.failures || []).join('; ') : '',
    external: (o.external || []).join(','),
    stored: j.verdict ? j.verdict.tier : '(not stored)',
    looks: looks.length,
    marks: withMarks,
    turns,
    indexTurns,
    goal: String(j.goal || '').replace(/\s+/g, ' ').slice(0, 58),
  });
}

rows.sort((a, b) => (a.at < b.at ? 1 : -1));

const tally = { gold: 0, silver: 0, bronze: 0, void: 0 };
let looks = 0, marks = 0, turns = 0, idx = 0, caught = 0, unstored = 0;
for (const r of rows) {
  tally[r.tier]++;
  looks += r.looks; marks += r.marks; turns += r.turns; idx += r.indexTurns;
  if (r.caught) caught++;
  if (r.stored === '(not stored)') unstored++;
}

console.log(`\n${rows.length} run(s) in the last ${ALL ? 'all time' : HOURS + 'h'} (of ${scanned} on disk)\n`);
console.log(pad('WHEN', 17) + pad('TIER', 8) + pad('TURNS', 7) + pad('LOOKS', 7) + pad('WITH LIST', 11) + 'GOAL');
console.log('-'.repeat(110));
for (const r of rows) {
  console.log(
    pad(r.at, 17) + pad(r.tier, 8) + pad(r.turns, 7) + pad(r.looks, 7) +
    pad(`${r.marks}/${r.looks}`, 11) + r.goal,
  );
  console.log(pad('', 17) + `  why: ${r.why}`.slice(0, 108));
  if (r.external) console.log(pad('', 17) + `  confirmed by: ${r.external}`);
  /* The most valuable line this tool prints: the run said something the record contradicts. */
  if (r.caught) console.log(pad('', 17) + `  CLAIM CAUGHT: ${r.caught}`.slice(0, 108));
  if (r.stored === '(not stored)') console.log(pad('', 17) + '  (verdict not on the job — this run predates the fix)');
}

console.log('\n' + '='.repeat(110));
console.log(`tiers: ${JSON.stringify(tally)}`);
console.log(`usable for training: ${tally.gold + tally.silver} run(s) — gold is the one that is scarce`);
console.log(`turns these runs yield: ${turns}   (of which ${idx} are click/type)`);
console.log(`looks: ${looks}, carrying the numbered list: ${marks}` +
  (looks ? `  (${Math.round(100 * marks / looks)}%)` : ''));
if (idx && marks === 0) console.log('WARNING: click/type turns here, and no numbered lists — those turns cannot be learned');
if (caught) console.log(`claims caught by a verifier: ${caught} — keep these, they are the scarcest thing in the corpus`);
if (unstored) console.log(`${unstored} run(s) carry no stored verdict (judged live instead)`);
console.log('');
