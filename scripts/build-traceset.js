#!/usr/bin/env node
/*
 * build-traceset.js — TURN THE RECORDED RUNS INTO TONIGHT'S TRAINING SET.
 *
 * This runs inside the Ghost Browser pod, where the jobs actually are, and it is the first half of
 * the nightly loop: build the set, check it, write it. The second half — the training — runs on a
 * device with a CPU to spare, because this node is the controller and has none.
 *
 * IT REFUSES MORE OFTEN THAN IT RUNS, ON PURPOSE.
 *
 * A training set is the one artefact in this system whose defects are invisible: a set with a
 * credential in it, or with the evaluation split cut so that turns from the same job sit on both
 * sides, produces a model that trains cleanly, measures well and is wrong. By the time that shows
 * up in behaviour the round that caused it is weeks back. So preflight halts are fatal here and the
 * previous set is left exactly where it is — a stale set that is known-good beats a fresh set that
 * nobody checked.
 *
 * Usage:
 *   node scripts/build-traceset.js                  build, check, write
 *   node scripts/build-traceset.js --dry            build and check, write nothing
 *   node scripts/build-traceset.js --out /some/dir  somewhere other than $PROFILE_DIR/traceset
 */
'use strict';

const fs = require('fs');
const path = require('path');

const traceset = require('../src/traceset');
const preflight = require('../src/preflight');
const { TOOLS } = require('../src/agent');
const roles = require('../src/roles');

const BASE = process.env.PROFILE_DIR || '/profiles';
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT = opt('--out', path.join(BASE, 'traceset'));
const DRY = flag('--dry');

const say = (s) => process.stdout.write(`${s}\n`);

/** Every job on disk. The whole history, because tier counts over a slice are not tier counts. */
function readJobs(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); }
  catch (e) { say(`no jobs at ${dir}: ${e.message}`); return []; }
  const out = [];
  for (const f of names) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }
    catch { /* a half-written job file is not a reason to abandon the night */ }
  }
  return out;
}

function main() {
  const jobsDir = path.join(BASE, 'jobs');
  const jobs = readJobs(jobsDir);
  say(`read ${jobs.length} jobs from ${jobsDir}`);
  if (!jobs.length) { say('HALT: nothing to build from'); process.exit(2); }

  /*
   * THE EVIDENCE STORES, WIRED THE SAME WAY THE LIVE VERIFIER WIRES THEM.
   *
   * These are what separate gold from silver: gold means something OUTSIDE the agent's own report
   * agreed that the work happened — a file with bytes in it, a recording that closed, a workflow run
   * that completed. Build without them and every verifier answers "no store to check against", every
   * gold job silently becomes silver, and the set trains on the agent's own account of itself, which
   * is the one source that is never independent. Preflight halts on that collapse; this is how not
   * to cause it in the first place.
   */
  const deps = {
    files: () => { try { return require('../src/fileAssets').list(); } catch { return []; } },
    recordings: () => { try { return [...require('../src/recorder').list()]; } catch { return []; } },
    runs: (id) => { try { return require('../src/workflows').readRun(id); } catch { return null; } },
  };
  const built = traceset.build(jobs, deps);
  const m = built.manifest;
  say(`jobs judged: ${JSON.stringify(m.tiers)}`);
  say(`kept:  ${JSON.stringify(m.kept)}`);
  say(`turns: ${JSON.stringify(m.turns)}`);
  say(`claims caught by the verifiers: ${JSON.stringify(m.claimsCaught)}`);
  if (m.droppedTurns && Object.keys(m.droppedTurns).length) {
    say(`turns dropped: ${JSON.stringify(m.droppedTurns)}`);
  }

  /*
   * How much of the set carries the numbered list. This only became possible when look started
   * persisting it, so early on the answer is "almost none" and climbs as fresh runs land. It is
   * printed rather than enforced because a low number is not a defect, it is the honest age of the
   * recording — but it is the single best predictor of whether index-bearing calls will improve.
   */
  const withMarks = built.train.filter((t) => (t.observed || []).some((o) => o.marks)).length;
  const indexTurns = built.train.filter((t) => t.action && t.action.args && t.action.args.index !== undefined).length;
  const indexWithMarks = built.train.filter((t) => t.action && t.action.args && t.action.args.index !== undefined
    && (t.observed || []).some((o) => o.marks)).length;
  say(`turns carrying the numbered list: ${withMarks} of ${built.train.length}`);
  say(`index-bearing turns that can actually be learnt: ${indexWithMarks} of ${indexTurns}`);

  /* The previous manifest, so preflight can see what changed rather than only what is. */
  let last = null;
  try { last = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')); } catch { last = null; }

  /* The first argument is the NEW manifest, not a clock — the gate compares two manifests and the
     turn sets, and handing it a timestamp makes every tier read as zero, which it then correctly
     reports as a total collapse. */
  const check = preflight.preflight(m, last, built, {});
  for (const w of check.warnings || []) say(`warning: ${w}`);
  for (const n of check.notes || []) say(`note: ${n}`);
  for (const h of check.halts || []) say(`HALT: ${h}`);

  if (!check.ok) {
    say('');
    say('The set was NOT written. The previous one is untouched and still serves.');
    process.exit(3);
  }

  if (DRY) { say('--dry: checked and not written'); return; }

  fs.mkdirSync(OUT, { recursive: true });
  const write = (name, turns) => {
    const p = path.join(OUT, name);
    /* Written beside and renamed, so a build interrupted halfway never leaves a truncated set that
       looks complete. The training script reads whatever is there and cannot tell. */
    /* The same filter the live agent applies, so the prompt a turn was built with is the prompt the
       model will meet. */
    fs.writeFileSync(`${p}.tmp`, traceset.toJsonl(turns, { tools: TOOLS, toolsFor: (r) => roles.toolsFor(r, TOOLS) }));
    fs.renameSync(`${p}.tmp`, p);
    say(`${name}: ${turns.length} turns`);
  };
  write('train.jsonl', built.train);
  write('eval.jsonl', built.eval);
  write('reject.jsonl', built.reject);

  const manifest = {
    ...m,
    marks: { turnsWithMarks: withMarks, indexTurns, indexWithMarks },
    promptedWith: { tools: TOOLS.length, perRole: true },
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  say(`written to ${OUT}`);
}

main();
