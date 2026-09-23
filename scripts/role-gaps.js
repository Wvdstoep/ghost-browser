#!/usr/bin/env node
/*
 * role-gaps.js — WHICH ROLES ARE MISSING WHICH TOOLS, ACROSS EVERY RUN EVER MADE.
 *
 * A role that does not carry the tool a task needs refuses it, and the run then does something
 * worse than fail: it improvises, reports success, and is only caught if a verifier happens to be
 * watching that particular kind of evidence. Seen live — a download refused to `facebook.scout`,
 * followed by "I found and downloaded the CSV file", caught only because a file store existed to
 * check against.
 *
 * Fixing those one at a time, as they are tripped over, is the wrong shape of work: the next one is
 * a recording under a role with no start_recording, then a Maps task under one with no save_place,
 * and each is discovered by losing a run. The refusals are already recorded on every job. Counted
 * together they stop being incidents and become a list of gaps, which is a thing that can be fixed
 * deliberately rather than discovered.
 *
 * Usage:  node scripts/role-gaps.js [--since 7d]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.PROFILE_DIR || '/profiles';
const DIR = path.join(BASE, 'jobs');

const argv = process.argv.slice(2);
const sinceArg = (() => { const i = argv.indexOf('--since'); return i >= 0 ? argv[i + 1] : ''; })();
const sinceMs = (() => {
  const m = /^(\d+)([dh])$/.exec(sinceArg || '');
  if (!m) return 0;
  return Date.now() - Number(m[1]) * (m[2] === 'd' ? 86400000 : 3600000);
})();

/*
 * The shape the agent writes when a role blocks a tool. Matched loosely on purpose: the sentence
 * has been reworded before and a tally that silently stops counting is worse than no tally, because
 * the gaps then look like they closed.
 */
const REFUSED = /refused\s+(\w+)\s*[—-]\s*this walk'?s role \(([^)]+)\)/i;
const REFUSED_LOOSE = /refused\s+(\w+)/i;

/*
 * THE CAPTURED WORD HAS TO BE A REAL TOOL.
 *
 * The loose pattern exists because the refusal sentence has been reworded before and a tally that
 * silently stops counting is worse than none. But "refused to post the reply" and "refused a second
 * paste" match it too, and the first version duly reported that roles were missing tools called
 * "to", "a" and "at" — noise that buries the eight real gaps underneath it.
 *
 * Checked against the live catalogue rather than a list kept here, so a tool added next month is
 * recognised on the day it ships and nothing has to be remembered.
 */
const KNOWN = (() => {
  try {
    return new Set((require('../src/agent').TOOLS || [])
      .map((x) => (x.function || x).name).filter(Boolean));
  } catch { return null; }
})();
const isTool = (w) => !KNOWN || KNOWN.has(w);

const byRole = new Map();      // role -> tool -> count
const byTool = new Map();      // tool -> count
const examples = [];
let runs = 0, runsWithRefusal = 0, lied = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  if (sinceMs && (Date.parse(j.endedAt || j.createdAt || '') || 0) < sinceMs) continue;
  runs++;

  const hits = [];
  for (const s of (j.steps || [])) {
    const text = String(s.text || '');
    if (!/refused/i.test(text)) continue;
    const m = REFUSED.exec(text) || REFUSED_LOOSE.exec(text);
    if (!m) continue;
    const tool = m[1];
    /* Prose, not a refusal of a named tool — "refused to post", "refused a second paste". */
    if (!isTool(tool)) continue;
    const role = (m[2] || j.role || 'unknown').trim();
    hits.push({ tool, role, text });
    if (!byRole.has(role)) byRole.set(role, new Map());
    const t = byRole.get(role);
    t.set(tool, (t.get(tool) || 0) + 1);
    byTool.set(tool, (byTool.get(tool) || 0) + 1);
  }
  if (!hits.length) continue;
  runsWithRefusal++;

  /*
   * THE EXPENSIVE CASE: refused, and then reported as though it had worked.
   *
   * This is what makes a gap dangerous rather than merely annoying. A refusal that ends in an honest
   * "I could not do this" costs one run; a refusal that ends in a confident summary puts a false
   * claim into the record and, if nothing external happened to be checkable, into the training set
   * as a good example.
   */
  const report = String(j.report || '');
  const claimedOk = report && !/could not|cannot|unable|failed|refused|not allowed/i.test(report);
  if (claimedOk) lied++;
  if (examples.length < 8) {
    examples.push({
      id: j.id, role: hits[0].role, tool: hits[0].tool,
      tier: (j.verdict && j.verdict.tier) || '(unjudged)',
      claimedOk,
      goal: String(j.goal || '').replace(/\s+/g, ' ').slice(0, 64),
    });
  }
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

console.log(`\n${runs} run(s) examined — ${runsWithRefusal} hit a tool their role does not carry\n`);

if (!byRole.size) {
  console.log('No refusals recorded. Either every role carries what its work needs, or nothing has');
  console.log('asked for a tool outside its list yet — running varied tasks is what tells them apart.\n');
  process.exit(0);
}

console.log('GAPS, by role');
console.log('-'.repeat(78));
const roleRows = [...byRole.entries()].sort((a, b) => {
  const sum = (m) => [...m.values()].reduce((x, y) => x + y, 0);
  return sum(b[1]) - sum(a[1]);
});
for (const [role, tools] of roleRows) {
  const list = [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join('  ');
  console.log(pad(role, 30) + list);
}

console.log('\nMOST-WANTED TOOLS (what work is actually asking for)');
console.log('-'.repeat(78));
for (const [tool, n] of [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(pad(tool, 24) + `refused ${n} time(s)`);
}

console.log('\nEXAMPLES');
console.log('-'.repeat(78));
for (const e of examples) {
  console.log(`${pad(e.role, 22)} needed ${pad(e.tool, 16)} ${pad(e.tier, 9)}${e.claimedOk ? ' CLAIMED SUCCESS ANYWAY' : ''}`);
  console.log(`  ${e.goal}`);
}

console.log('\n' + '='.repeat(78));
console.log(`${runsWithRefusal} run(s) blocked by a missing tool.`);
if (lied) {
  console.log(`${lied} of them reported success regardless — those are the ones that quietly poison`);
  console.log('the record, because only an external check can tell that nothing happened.');
}
console.log('Each line above is a role whose tool list does not match the work it is being given.\n');
