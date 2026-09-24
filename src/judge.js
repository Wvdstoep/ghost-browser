/*
 * judge.js — THE TEACHER READS THE OLD RUNS BACK, ONE STEP AT A TIME.
 *
 * The record judges a step only where it is loud about it - a refused call, one look too many.
 * Most steps are quiet: the run ended well and nothing says which of its forty decisions were
 * the good ones. So the teacher is asked, offline, once per run: given the goal and the trail,
 * which steps were right, which were wrong and why, and for the right ones the one sentence that
 * explains them ("the page lists prices and the goal wants the cheapest, so open [3]"). That
 * sentence is the reasoning line a later round can be taught to emit before its answer.
 *
 * A teacher's opinion is not gold. It is stored under its own name (`judged`), beside what the
 * record said and what a person said, and the set builder ranks them: a person first, the record
 * second, the teacher last. A run is asked about once; the answer is written on its steps.
 *
 * Pure where it can be: the prompt, the parse and the pick are here; the server does the calling.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'judge.json');
/** Runs per tick, so the loop never outruns the collector's share of the allowance. */
const PER_TICK = 3;

const OBSERVE = new Set(['read', 'open', 'look', 'click', 'scroll', 'note', 'blocked', 'data', 'error']);

/** The tool steps of a run, each with what was seen right after it. */
function trail(job) {
  const steps = (job && job.steps) || [];
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || s.kind !== 'tool' || !s.tool) continue;
    const seen = [];
    for (let k = i + 1; k < steps.length && !(steps[k] && steps[k].kind === 'tool'); k++) {
      const n = steps[k];
      if (n && OBSERVE.has(n.kind)) seen.push(`${n.kind}: ${String(n.text || '').slice(0, 160)}`);
    }
    out.push({ index: i, n: out.length + 1, tool: String(s.tool), args: s.args || {}, seen: seen.slice(0, 3), judged: s.judged || null, human: s.human || null });
  }
  return out;
}

/** Does this run still want a judgement? Sighted, usable, and not yet asked about. */
function wants(job, done = {}) {
  if (!job || !job.id || done[job.id]) return false;
  if (job.status === 'running') return false;
  /* Void runs are judged too: the set takes exactly the steps judged good out of them, and a
     decision taken on a real page before a deploy cut the run short is as good as any. */
  const steps = job.steps || [];
  if (!steps.some((s) => s && s.content)) return false;
  const calls = steps.filter((s) => s && s.kind === 'tool' && s.tool);
  if (calls.length < 2) return false;
  return !calls.every((s) => s.judged);
}

/** The question. One call per run; the answer is one JSON array. */
function promptFor(job) {
  const t = trail(job);
  const lines = t.map((s) => `${s.n}. ${s.tool}(${JSON.stringify(s.args).slice(0, 160)})` + (s.seen.length ? `\n     -> ${s.seen.join(' | ')}` : ''));
  const report = String(job.report || '').slice(0, 400);
  const tier = (job.verdict && job.verdict.tier) || 'unknown';
  return [
    { role: 'system', content: [
      'You grade the steps of a browser agent\'s run, for training a smaller model. Be strict and specific.',
      'For EVERY step answer one object: {"n": <step number>, "verdict": "good"|"wrong"|"unclear", "why": "<one short clause>", "reason": "<for a good step: one sentence, in the first person, explaining why THIS action was the right next move given what was on screen; empty for wrong or unclear>"}.',
      'A step is wrong when it was refused, repeated something already done, went somewhere the goal did not need, typed into the wrong thing, or finished with a claim the trail does not support. A step is good when it moved the goal forward given what had been seen. Unclear when the trail does not show enough.',
      'Answer with ONLY a JSON array of those objects, one per step, in order. No prose.',
    ].join('\n') },
    { role: 'user', content: `GOAL: ${String(job.goal || '').slice(0, 600)}\nOUTCOME: ${tier}${report ? `\nREPORT: ${report}` : ''}\n\nSTEPS:\n${lines.join('\n')}` },
  ];
}

/** The array out of the teacher's text, tolerant of prose around it. */
function parse(text) {
  const s = String(text || '');
  const a = s.indexOf('['); const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let arr;
  try { arr = JSON.parse(s.slice(a, b + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((o) => ({
    n: Number(o && o.n), verdict: ['good', 'wrong', 'unclear'].includes(o && o.verdict) ? o.verdict : 'unclear',
    why: String((o && o.why) || '').slice(0, 200), reason: String((o && o.reason) || '').slice(0, 300),
  })).filter((o) => Number.isInteger(o.n) && o.n > 0);
}

/** Write the judgements onto the steps. Returns how many landed and how many were wrong. */
function apply(job, judgements, { model = '', annotate = null, at = new Date().toISOString() } = {}) {
  const t = trail(job);
  const byN = new Map(judgements.map((j) => [j.n, j]));
  let landed = 0, wrong = 0;
  for (const s of t) {
    const j = byN.get(s.n);
    if (!j) continue;
    const step = job.steps[s.index];
    const judged = { verdict: j.verdict, why: j.why, reason: j.reason, model, at };
    if (annotate) annotate(job, step, { judged }); else step.judged = judged;
    landed++; if (j.verdict === 'wrong') wrong++;
  }
  return { landed, wrong, asked: t.length };
}

/* ── the record ─────────────────────────────────────────────────────────────────────────────── */
const EMPTY = () => ({ on: false, runs: 0, steps: 0, wrong: 0, reasons: 0, calls: 0, failed: 0, doneJobs: {}, left: -1, lastAt: '', lastWhy: '' });
function load() { try { return { ...EMPTY(), ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; } catch { return EMPTY(); } }
function save(st) { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(st, null, 1)); return st; }
function setOn(on) { const st = load(); st.on = !!on; if (st.on) st.lastWhy = ''; return save(st); }
function state() {
  const st = load();
  return { on: st.on, runs: st.runs, steps: st.steps, wrong: st.wrong, reasons: st.reasons, calls: st.calls, failed: st.failed, left: typeof st.left === 'number' ? st.left : -1, lastAt: st.lastAt, lastWhy: st.lastWhy };
}

/** The next runs to ask about, read off the disk in a slice, gold first. */
function scan(dir, st, { from = 0, limit = 300 } = {}) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse(); } catch { files = []; }
  const end = Math.min(files.length, from + limit);
  const found = [];
  for (let i = from; i < end; i++) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, files[i]), 'utf8')); } catch { continue; }
    if (!wants(j, (st && st.doneJobs) || {})) continue;
    found.push({ id: j.id, tier: (j.verdict && j.verdict.tier) || '', createdAt: String(j.createdAt || '') });
  }
  return { found, next: end, total: files.length, done: end >= files.length };
}
const RANK = { gold: 0, silver: 1, bronze: 2 };
function order(entries) { const rank = (t) => (RANK[t] == null ? 3 : RANK[t]); return (entries || []).slice().sort((a, b) => rank(a.tier) - rank(b.tier) || b.createdAt.localeCompare(a.createdAt)); }

module.exports = { trail, wants, promptFor, parse, apply, load, save, setOn, state, scan, order, PER_TICK, FILE };
