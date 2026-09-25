/*
 * students.js — WHO SHOULD BE THE STUDENT, DECIDED BY MEASUREMENT.
 *
 * Qwen2.5-0.5B was a pragmatic default when this pipeline was built: the smallest thing that could
 * hold a 4,096-token page and still emit a structured tool call, small enough to train on a free
 * GPU and to serve on a processor-only sidecar. Whether it is the RIGHT student was never measured,
 * and it is the one question the corpus can answer on its own: every candidate sits the same paper
 * the rounds are scored on, bare, and the numbers decide.
 *
 * A trial is a round that measures and trains nothing (train_round.py --measure-only). It asks for
 * no slice, so it claims no turns; it writes no adapter, so the serving chain cannot change under
 * it. That is what makes it safe to run candidates against a corpus we cannot currently replace.
 *
 * WHAT A TRIAL DOES NOT SETTLE. It scores the STARTING point. A student that starts higher usually
 * finishes higher, but an adapter is tied to the model underneath it: switching student throws away
 * every adapter we hold. So a trial nominates, and one full round on the same turns decides.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'students.json');

/*
 * The field. The incumbent stands in it as the control: its old 5.86% was measured on a different
 * paper, and a comparison against a number from another paper is not a comparison. Qwen3-0.6B is
 * there to separate "newer" from "bigger", which is the whole reason to run four and not two.
 */
const CANDIDATES = [
  { id: 'Qwen/Qwen2.5-0.5B-Instruct', name: 'Qwen2.5 0.5B', params: '0.5B',
    why: 'the incumbent, and the control: the same paper, so the other has something to beat' },
  { id: 'Qwen/Qwen2.5-1.5B-Instruct', name: 'Qwen2.5 1.5B', params: '1.5B',
    why: 'three times the size, the same architecture and chat template — nothing in serving changes' },
  { id: 'Qwen/Qwen3-0.6B', name: 'Qwen3 0.6B', params: '0.6B',
    why: 'the same size a generation on — separates what the model is worth from what the parameters are worth' },
  { id: 'Qwen/Qwen3-1.7B', name: 'Qwen3 1.7B', params: '1.7B',
    why: 'the newer generation at three times the size; thinking is switched off so it answers with the tool call' },
];

/*
 * NOT YET, AND WHY. These are not worse candidates; they are candidates that cost more than a
 * trial. Each line is what would have to be built before its trial would mean anything, so the
 * postponement stays a decision. Qwen2.5-3B is absent for a different reason: its licence is
 * Qwen's research licence, not Apache, and this browser is meant to be sold.
 */
const LATER = [
  { id: 'google/gemma-4-E4B-it', name: 'Gemma 4 E4B',
    needs: 'a served Modelfile with Gemma turn markers instead of ChatML — serving a model with the wrong template is the fault that made every export write prose' },
];

function read() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { return { queue: [], at: '' }; }
}
function write(v) {
  try { fs.mkdirSync(DIR(), { recursive: true }); } catch (e) { /* the dir is there or the write says so */ }
  fs.writeFileSync(FILE(), JSON.stringify(v, null, 1));
  return v;
}

/** Is this round a student trial rather than a training round? */
const isTrial = (r) => !!(r && r.recipe && r.recipe.trial);

/** The newest finished trial of one model, from the rounds themselves — one store, not two. */
function trialOf(rounds, id) {
  const mine = (rounds || []).filter((r) => isTrial(r) && String(r.recipe.base || '') === id);
  const done = mine.find((r) => r.status === 'done' && r.result);
  const any = mine[0] || null;
  const r = done || any;
  if (!r) return null;
  const res = r.result || null;
  return {
    round: r.id,
    at: r.endedAt || r.startedAt || '',
    status: r.status,
    paper: r.paper || '',
    turns: res ? res.turns : null,
    agreement: res ? res.agreement_pct : null,
    args: res ? res.args_agreement_pct : null,
    unusable: res ? res.unusable_pct : null,
    collapse: res && res.collapse ? res.collapse.ratio : null,
    collapseTool: res && res.collapse ? String(res.collapse.tool || '') : '',
    why: String(r.why || ''),
    running: r.status === 'running',
  };
}

/** Every candidate with its newest trial, best first, and the queue still waiting. */
function list(rounds = []) {
  const q = read().queue || [];
  const rows = CANDIDATES.map((c) => ({ ...c, trial: trialOf(rounds, c.id), queued: q.includes(c.id) }));
  const scored = rows.filter((r) => r.trial && typeof r.trial.agreement === 'number');
  const best = scored.sort((a, b) => b.trial.agreement - a.trial.agreement)[0] || null;
  return {
    candidates: rows,
    later: LATER,
    queue: q,
    /* The winner is only ever a nomination: see the note at the top of this file. */
    leader: best ? { id: best.id, name: best.name, agreement: best.trial.agreement } : null,
    running: (rounds || []).some((r) => isTrial(r) && r.status === 'running'),
  };
}

/** Queue candidates for a trial. Unknown ids are refused by name, not silently dropped. */
function queue(ids = []) {
  const known = new Set(CANDIDATES.map((c) => c.id));
  const want = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  const bad = want.filter((i) => !known.has(i));
  if (bad.length) throw new Error(`not a candidate: ${bad.join(', ')}`);
  const cur = read().queue || [];
  const next = [...cur];
  for (const i of want) if (!next.includes(i)) next.push(i);
  write({ queue: next, at: new Date().toISOString() });
  return next;
}

/** The next candidate waiting, or ''. */
function next() { return (read().queue || [])[0] || ''; }

/** Take one off the front — it has been handed to a machine. */
function shift(id) {
  const cur = read().queue || [];
  write({ queue: cur.filter((x) => x !== id), at: new Date().toISOString() });
  return read().queue;
}

/** Forget everything waiting. A trial already running is a round, and is stopped like one. */
function clear() { write({ queue: [], at: new Date().toISOString() }); return []; }

module.exports = { CANDIDATES, LATER, isTrial, list, queue, next, shift, clear, trialOf };
