'use strict';
/*
 * WHAT THE MODEL HAS LEARNED - as opposed to what rounds have trained on.
 *
 * Every round so far trained on turns and then threw its adapter away at the gates; summing those
 * turns and calling them "learned" reported 870 learned from when nothing was. A turn is learned for
 * a scope when the adapter that trained on it was PROMOTED - the round itself, or the shares of a
 * promoted merge. The ledger below is keyed by the turn's own identity (its job and step), not by
 * a line number in one build of the set, so it survives rebuilds: the draw skips learned turns in
 * every later build, and coverage is this count and nothing else.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'learned.json');
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + '.tmp', JSON.stringify(v)); fs.renameSync(p + '.tmp', p); };

const JOB = /"jobId":"([^"]+)"/;
const AT = /"at":(\d+|"[^"]*")/;

/** A turn's identity: its job and its step in it; failing those, a hash of the line itself. */
function idOf(line) {
  const s = String(line || '');
  const m = s.indexOf('"meta":');
  const meta = m >= 0 ? s.slice(m) : s;
  const j = JOB.exec(meta); const a = AT.exec(meta);
  if (j && a) return `${j[1]}#${a[1].replace(/"/g, '')}`;
  return 'h:' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 24);
}

/*
 * THE STUDENT THIS LEDGER IS ABOUT. Everything recorded before a second student existed belongs to
 * the incumbent, so the incumbent keeps the bare scope key and nothing already written moves. Any
 * other student gets its own shelf and therefore an empty one, which is the truth about it.
 */
const INCUMBENT = 'Qwen/Qwen2.5-0.5B-Instruct';
const shelf = (key = 'base', student = '') => (!student || String(student) === INCUMBENT ? String(key) : `${key}@${student}`);

function all() {
  const l = readJson(FILE(), null);
  return l && typeof l === 'object' && l.by ? l : { by: {} };
}
/** The learned ids of one scope FOR ONE STUDENT, as a Set - loaded once per draw. */
function setFor(key = 'base', student = '') { return new Set(Object.keys((all().by || {})[shelf(key, student)] || {})); }
function count(key = 'base', student = '') { return Object.keys((all().by || {})[shelf(key, student)] || {}).length; }
function has(key, line, student = '') { return setFor(key, student).has(idOf(line)); }

/** Record lines as learned for a scope by the round that earned it. Returns how many were new. */
function record({ key = 'base', roundId = '', lines = [], student = '' } = {}) {
  const l = all();
  const s = shelf(key, student);
  const by = l.by[s] || (l.by[s] = {});
  let added = 0;
  for (const line of lines) { const id = idOf(line); if (!by[id]) { by[id] = roundId || true; added++; } }
  writeJson(FILE(), l);
  return added;
}

/**
 * From the slice ledger: the lines a round (or the shares of a merge) drew in the current build,
 * found by the marks the draw stamped - the round's id, `<batch>@<device>` for a share that
 * fetched before it registered, `single@<device>` for a lone round. Case does not matter.
 */
function recordFromLedger({ key = 'base', roundId = '', marks = [], file = '', ledger = null, student = '' } = {}) {
  if (!ledger || !ledger.taken || !file) return { added: 0, matched: 0 };
  const want = new Set((marks || []).map((m) => String(m).toLowerCase()));
  const idx = [];
  for (const [i, v] of Object.entries(ledger.taken)) {
    for (const m of String(v || '').split(',')) {
      const bar = m.indexOf('|');
      const k = bar < 0 ? 'base' : m.slice(0, bar);
      const who = (bar < 0 ? m : m.slice(bar + 1)).toLowerCase();
      if (k === key && want.has(who)) { idx.push(Number(i)); break; }
    }
  }
  if (!idx.length) return { added: 0, matched: 0 };
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter((x) => x.trim()); } catch { return { added: 0, matched: idx.length }; }
  const picked = idx.filter((i) => i >= 0 && i < lines.length).map((i) => lines[i]);
  return { added: record({ key, roundId, lines: picked, student }), matched: idx.length };
}

function reset(key = null, student = '') {
  if (!key) { writeJson(FILE(), { by: {} }); return; }
  const l = all(); delete l.by[shelf(key, student)]; writeJson(FILE(), l);
}

module.exports = { idOf, all, setFor, count, has, record, recordFromLedger, reset, shelf, INCUMBENT, FILE };
