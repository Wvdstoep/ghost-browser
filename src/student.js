/*
 * student.js — ASKING THE SMALL MODEL THE SAME QUESTION THE TEACHER GOT, IN ITS OWN WORDS.
 *
 * The student was trained on one prompt shape (localPrompt.js: the role, the catalogue, the goal,
 * what has been seen with the latest page or numbered list in full). At serving it must get
 * exactly that shape, built from the job's own record, or every measurement flatters and the live
 * model underperforms its own exam for reasons nobody can find. So the prompt is built here from
 * job.steps by the same rules traceset.js uses to build a training turn - the last few
 * observations, the newest list and the newest page - and the answer is read back as the one JSON
 * object the student was taught to emit.
 *
 * Nothing here decides who drives. router.js does that; this only asks, parses and compares.
 */
'use strict';

const localPrompt = require('./localPrompt');
const traceset = require('./traceset');

/** The observations a decision can see right now - the same window a training turn gets. */
function observedOf(job, { maxObs = 600, maxMarks = 6000, maxContent = 6000, maxHistory = 6 } = {}) {
  const steps = Array.isArray(job && job.steps) ? job.steps : [];
  const history = [];
  for (const s of steps) {
    if (!s || !traceset.OBSERVE.has(s.kind)) continue;
    const t = traceset.scrubText(String(s.text || s.detail || '')).slice(0, maxObs);
    if (!t) continue;
    history.push({
      kind: s.kind, text: t,
      marks: s.marks ? traceset.scrubText(String(s.marks)).slice(0, maxMarks) : undefined,
      content: s.content ? traceset.scrubText(String(s.content)).slice(0, maxContent) : undefined,
      url: s.url ? traceset.scrubText(String(s.url)).slice(0, 300) : undefined,
    });
    if (history.length > maxHistory) history.shift();
  }
  return history;
}

/** The two messages the student sees. `tools` is the role's catalogue, `playbook` its text. */
function promptFor(job, { role = 'general', tools = [], playbook = '', notes = '' } = {}) {
  return [
    { role: 'system', content: localPrompt.systemFor({ role, site: String((job && job.profile) || ''), tools, playbook, notes }) },
    { role: 'user', content: localPrompt.userFor({ goal: traceset.scrubText(String((job && job.goal) || '')), observed: observedOf(job) }) },
  ];
}

/** The first complete JSON object in the text, or null. Tolerant of prose around it. */
function firstObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { const o = JSON.parse(s.slice(start, i + 1)); return o && typeof o === 'object' ? o : null; } catch { return null; } } }
  }
  return null;
}

/** {tool, args} out of the student's answer, or null when it said nothing usable. */
function parseCall(text) {
  const o = firstObject(text);
  if (!o) return null;
  const tool = o.tool || o.name;
  if (typeof tool !== 'string' || !tool.trim()) return null;
  const args = (o.args && typeof o.args === 'object' && !Array.isArray(o.args)) ? o.args
    : (o.arguments && typeof o.arguments === 'object' && !Array.isArray(o.arguments)) ? o.arguments : {};
  return { name: tool.trim(), args };
}

/* ── do two calls agree? the same comparators the exam uses ─────────────────────────────────── */
const URLISH = new Set(['url', 'href', 'link', 'address', 'postUrl']);
const INDEXISH = new Set(['index', 'n', 'i']);
const normText = (s) => String(s == null ? '' : s).toLowerCase().split(/\s+/).filter(Boolean).join(' ');
function normUrl(u) {
  let s = String(u == null ? '' : u).trim().toLowerCase().split('#')[0].split('?')[0];
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return s.replace(/\/+$/, '');
}
/** Bigram Dice similarity, 0..1 - close enough to the exam's sequence ratio for short strings. */
function similar(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let hit = 0;
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}
function argAgrees(key, want, got) {
  if (URLISH.has(key)) return normUrl(want) === normUrl(got);
  if (INDEXISH.has(key)) return Number(want) === Number(got);
  if (typeof want === 'number' || typeof want === 'boolean' || typeof got === 'number' || typeof got === 'boolean') return want == got; // eslint-disable-line eqeqeq
  if (typeof want === 'object' || typeof got === 'object') { try { return JSON.stringify(want) === JSON.stringify(got); } catch { return false; } }
  const a = normText(want), b = normText(got);
  if (!a && !b) return true;
  if (!a || !b) return false;
  return similar(a, b) >= 0.8;
}
/** Every argument the teacher gave agrees; extras the student added do not count against it. */
function argsAgree(want = {}, got = {}) {
  for (const [k, v] of Object.entries(want || {})) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (!(k in (got || {}))) return false;
    if (!argAgrees(k, v, got[k])) return false;
  }
  return true;
}
function compare(teacher, student) {
  if (!teacher || !student) return { tool: false, args: false };
  const tool = String(teacher.name) === String(student.name);
  return { tool, args: tool && argsAgree(teacher.args || {}, student.args || {}) };
}

/** One question to the student. Text in, text out; the caller parses. */
/*
 * The prompt is two to four thousand tokens (the catalogue, then the page); the default context
 * of four thousand would silently cut the page off the end. The answer is one JSON object, so
 * it is short and deterministic. Kept loaded for a day: the first call pays the load, the rest
 * pay only the prompt. On a CPU that prompt is the cost - tens of seconds - which is why the
 * shadow gets ninety seconds and a driving turn forty-five.
 */
const OPTIONS = { num_ctx: 8192, temperature: 0, num_predict: 120 };
async function ask({ chat, host, model, messages, signal, timeoutMs = 45000 }) {
  const r = await chat({ host, model, key: '', messages, tools: [], signal, timeoutMs, options: OPTIONS, keepAlive: '24h' });
  return String((r && r.content) || '');
}

module.exports = { observedOf, promptFor, parseCall, firstObject, compare, argsAgree, similar, ask };
