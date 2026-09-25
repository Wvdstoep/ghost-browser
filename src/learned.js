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

function all() {
  const l = readJson(FILE(), null);
  return l && typeof l === 'object' && l.by ? l : { by: {} };
}
/** The learned ids of one scope, as a Set - loaded once per draw. */
function setFor(key = 'base') { return new Set(Object.keys((all().by || {})[key] || {})); }
function count(key = 'base') { return Object.keys((all().by || {})[key] || {}).length; }
function has(key, line) { return setFor(key).has(idOf(line)); }

/** Record lines as learned for a scope by the round that earned it. Returns how many were new. */
function record({ key = 'base', roundId = '', lines = [] } = {}) {
  const l = all();
  const by = l.by[key] || (l.by[key] = {});
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
function recordFromLedger({ key = 'base', roundId = '', marks = [], file = '', ledger = null } = {}) {
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
  return { added: record({ key, roundId, lines: picked }), matched: idx.length };
}

function reset(key = null) {
  if (!key) { writeJson(FILE(), { by: {} }); return; }
  const l = all(); delete l.by[key]; writeJson(FILE(), l);
}

module.exports = { idOf, all, setFor, count, has, record, recordFromLedger, reset, FILE };
