/*
 * shadow.js — WHAT THE STUDENT SAID BESIDE WHAT THE TEACHER DID, ON REAL JOBS.
 *
 * The exam is a frozen paper of three hundred turns. This is the live one: every step where the
 * student was asked, its answer against the teacher's, per tool and per role, with the last two
 * hundred kept whole so a person can read what it got wrong. It is the number that decides
 * whether the student may drive a share of the jobs, and it is written to disk because a restart
 * must not erase a week of evidence.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'shadow.json');
const KEEP = 200;

const EMPTY = () => ({ since: new Date().toISOString(), model: '', seen: 0, agree: 0, argsAgree: 0, unusable: 0, perTool: {}, perRole: {}, recent: [], driven: { steps: 0, fallbacks: 0, jobs: {} } });

function load() {
  try { return { ...EMPTY(), ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; } catch { return EMPTY(); }
}
function save(st) { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(st, null, 1)); return st; }

/** Start over - when the student model changes, the old numbers are about another model. */
function reset(model = '') { const st = EMPTY(); st.model = String(model || ''); return save(st); }

/** One comparison. `teacher`/`student` are {name, args} or null. */
function record({ jobId = '', role = 'general', step = 0, tool = '', teacher = null, student = null, agree = false, argsAgree = false, model = '' } = {}) {
  const st = load();
  if (model && st.model && st.model !== model) { Object.assign(st, EMPTY()); st.model = model; }
  if (model && !st.model) st.model = model;
  st.seen++;
  if (!student) st.unusable++;
  if (agree) st.agree++;
  if (argsAgree) st.argsAgree++;
  const t = tool || (teacher && teacher.name) || '?';
  const pt = st.perTool[t] || (st.perTool[t] = { seen: 0, agree: 0, argsAgree: 0 });
  pt.seen++; if (agree) pt.agree++; if (argsAgree) pt.argsAgree++;
  const pr = st.perRole[role] || (st.perRole[role] = { seen: 0, agree: 0, argsAgree: 0 });
  pr.seen++; if (agree) pr.agree++; if (argsAgree) pr.argsAgree++;
  st.recent = [...st.recent, {
    at: new Date().toISOString(), jobId, role, step,
    teacher: teacher ? `${teacher.name}(${JSON.stringify(teacher.args || {}).slice(0, 120)})` : '',
    student: student ? `${student.name}(${JSON.stringify(student.args || {}).slice(0, 120)})` : '(nothing usable)',
    agree, argsAgree,
  }].slice(-KEEP);
  return save(st);
}

/** A step the student drove, or a fallback to the teacher on one. */
function drove({ jobId = '', fallback = false, why = '' } = {}) {
  const st = load();
  st.driven.steps++;
  if (fallback) st.driven.fallbacks++;
  const j = st.driven.jobs[jobId] || (st.driven.jobs[jobId] = { steps: 0, fallbacks: 0, why: '' });
  j.steps++; if (fallback) { j.fallbacks++; j.why = String(why || '').slice(0, 160); }
  const ids = Object.keys(st.driven.jobs);
  if (ids.length > 300) for (const id of ids.slice(0, ids.length - 300)) delete st.driven.jobs[id];
  return save(st);
}

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);
/** For the screen. */
function state() {
  const st = load();
  const rows = (m) => Object.entries(m).map(([k, v]) => ({ name: k, seen: v.seen, agree: v.agree, argsAgree: v.argsAgree, pct: pct(v.agree, v.seen), argsPct: pct(v.argsAgree, v.seen) })).sort((a, b) => b.seen - a.seen);
  return {
    since: st.since, model: st.model, seen: st.seen,
    agreePct: pct(st.agree, st.seen), argsPct: pct(st.argsAgree, st.seen), unusablePct: pct(st.unusable, st.seen),
    perTool: rows(st.perTool).slice(0, 40), perRole: rows(st.perRole).slice(0, 20),
    recent: st.recent.slice(-30).reverse(),
    driven: { steps: st.driven.steps, fallbacks: st.driven.fallbacks, fallbackPct: pct(st.driven.fallbacks, st.driven.steps), jobs: Object.keys(st.driven.jobs).length },
  };
}

module.exports = { load, save, reset, record, drove, state, FILE, KEEP };
