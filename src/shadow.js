/*
 * shadow.js — WHAT EACH STUDENT SAID BESIDE WHAT THE TEACHER DID, ON REAL JOBS.
 *
 * The exam is a frozen paper of a few hundred turns. This is the live one: every step where a
 * student was asked, its answer against the teacher's, per tool and per role, with the last two
 * hundred kept whole so a person can read what it got wrong; every step it DROVE and whether it
 * had to hand the step back; and the verdict on every job it drove, once the verifiers judged it.
 * Those three are what autopilot.js reads to decide the stage a model has earned, and they are
 * written to disk because a restart must not erase a week of evidence.
 *
 * ONE LEDGER PER MODEL. With a base adapter, a platform adapter and a role adapter all serving at
 * once, a single ledger that reset whenever the tag changed would flip between them on every step
 * and never hold two hundred steps of anything. Each tag keeps its own book; `current` is the one
 * the screen opens by default.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'shadow.json');
const KEEP = 200;

const EMPTY = () => ({
  since: new Date().toISOString(), model: '', seen: 0, agree: 0, argsAgree: 0, unusable: 0,
  perTool: {}, perRole: {}, recent: [],
  driven: { steps: 0, fallbacks: 0, jobs: {} },
  outcomes: { jobs: 0, gold: 0, silver: 0, bronze: 0, void: 0 },
});

function loadAll() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { raw = null; }
  if (raw && raw.by && typeof raw.by === 'object') return { by: raw.by, current: raw.current || '' };
  /* The single-ledger file this used to write: kept as the book of the model it named. */
  if (raw && raw.model) return { by: { [raw.model]: { ...EMPTY(), ...raw } }, current: raw.model };
  return { by: {}, current: '' };
}
function saveAll(all) { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(all, null, 1)); return all; }
/* No model named and none current: the unnamed book, so a step recorded before any tag was
   configured is still counted rather than dropped. */
function bookOf(all, model) {
  const m = String(model || all.current || '');
  if (!all.by[m]) all.by[m] = { ...EMPTY(), model: m };
  return all.by[m];
}

/** The ledger of one model (the current one when none is named). */
function load(model = '') { const all = loadAll(); return { ...EMPTY(), ...bookOf(all, model) }; }

/** Save one model's ledger. */
function save(st) {
  const all = loadAll();
  const m = String((st && st.model) || all.current || '');
  if (m) { all.by[m] = st; all.current = m; }
  saveAll(all);
  return st;
}

/** Start a model's book over — when a tag is re-registered, its old numbers are about another file. */
function reset(model = '') {
  const all = loadAll();
  const m = String(model || '');
  if (m) { all.by[m] = { ...EMPTY(), model: m }; all.current = m; }
  saveAll(all);
  return all.by[m] || { ...EMPTY() };
}

/** One comparison. `teacher`/`student` are {name, args} or null. */
function record({ jobId = '', role = 'general', step = 0, tool = '', teacher = null, student = null, agree = false, argsAgree = false, model = '' } = {}) {
  const all = loadAll();
  const st = bookOf(all, model);
  if (model) all.current = String(model);
  st.seen++;
  if (!student) st.unusable++;
  if (agree) st.agree++;
  if (argsAgree) st.argsAgree++;
  const t = tool || (teacher && teacher.name) || '?';
  const pt = st.perTool[t] || (st.perTool[t] = { seen: 0, agree: 0, argsAgree: 0 });
  pt.seen++; if (agree) pt.agree++; if (argsAgree) pt.argsAgree++;
  const pr = st.perRole[role] || (st.perRole[role] = { seen: 0, agree: 0 });
  pr.seen++; if (agree) pr.agree++;
  st.recent = [...st.recent, {
    at: new Date().toISOString(), jobId, role, step, tool: t,
    teacher: teacher ? `${teacher.name} ${JSON.stringify(teacher.args || {}).slice(0, 120)}` : '',
    student: student ? `${student.name} ${JSON.stringify(student.args || {}).slice(0, 120)}` : '(nothing usable)',
    agree, argsAgree,
  }].slice(-KEEP);
  saveAll(all);
  return st;
}

/** A step the student drove — or one it was about to drive and handed back. */
function drove({ jobId = '', fallback = false, why = '', model = '' } = {}) {
  const all = loadAll();
  const st = bookOf(all, model);
  st.driven = st.driven || { steps: 0, fallbacks: 0, jobs: {} };
  st.driven.steps++;
  if (fallback) st.driven.fallbacks++;
  if (jobId) {
    const j = st.driven.jobs[jobId] || (st.driven.jobs[jobId] = { steps: 0, fallbacks: 0, last: '' });
    j.steps++; if (fallback) { j.fallbacks++; j.last = String(why || '').slice(0, 160); }
  }
  const ids = Object.keys(st.driven.jobs);
  if (ids.length > 500) for (const id of ids.slice(0, ids.length - 500)) delete st.driven.jobs[id];
  saveAll(all);
  return st;
}

/** The verifiers' verdict on a job a model drove — the number that decides canary → primary. */
function outcome({ model = '', jobId = '', tier = 'void' } = {}) {
  if (!model) return null;
  const all = loadAll();
  const st = bookOf(all, model);
  st.outcomes = st.outcomes || { jobs: 0, gold: 0, silver: 0, bronze: 0, void: 0 };
  st.outcomes.jobs++;
  const t = ['gold', 'silver', 'bronze', 'void'].includes(tier) ? tier : 'void';
  st.outcomes[t] = (st.outcomes[t] || 0) + 1;
  st.outcomes.lastJob = String(jobId || '');
  saveAll(all);
  return st;
}

const pct = (a, b) => (b > 0 ? Math.round((1000 * a) / b) / 10 : 0);

function summary(st) {
  const s = { ...EMPTY(), ...(st || {}) };
  const driven = s.driven || { steps: 0, fallbacks: 0, jobs: {} };
  const o = s.outcomes || { jobs: 0, gold: 0, silver: 0, bronze: 0, void: 0 };
  return {
    since: s.since, model: s.model, seen: s.seen,
    agreePct: pct(s.agree, s.seen), argsAgreePct: pct(s.argsAgree, s.seen), unusablePct: pct(s.unusable, s.seen),
    perTool: Object.entries(s.perTool).map(([name, v]) => ({ name, seen: v.seen, agree: v.agree, argsAgree: v.argsAgree, pct: pct(v.agree, v.seen) })).sort((a, b) => b.seen - a.seen),
    perRole: Object.entries(s.perRole).map(([name, v]) => ({ name, seen: v.seen, agree: v.agree, pct: pct(v.agree, v.seen) })).sort((a, b) => b.seen - a.seen),
    recent: s.recent.slice(-40).reverse(),
    driven: { steps: driven.steps, fallbacks: driven.fallbacks, fallbackPct: pct(driven.fallbacks, driven.steps), jobs: Object.keys(driven.jobs || {}).length },
    outcomes: { ...o, goodPct: pct((o.gold || 0) + (o.silver || 0), o.jobs) },
  };
}

/** Every model's raw book, keyed by tag — what autopilot.js reads. */
function all() { return loadAll().by; }

/** For the screen: one model in full (the current one by default), and every model in brief. */
function state(model = '') {
  const a = loadAll();
  const main = summary(bookOf(a, model));
  return {
    ...main,
    models: Object.values(a.by).filter((b) => b && b.model).map((b) => { const s = summary(b); return { model: s.model, since: s.since, seen: s.seen, agreePct: s.agreePct, argsAgreePct: s.argsAgreePct, driven: s.driven, outcomes: s.outcomes }; }),
  };
}

module.exports = { load, save, reset, record, drove, outcome, state, all, summary, FILE, KEEP };
