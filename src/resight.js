/*
 * resight.js — GIVING THE OLD RUNS BACK THEIR PAGES.
 *
 * Until v478 a read step recorded "read the page (14592 characters)" and nothing else: the teacher
 * saw six thousand characters of the page and the record kept the count. Every decision after such
 * a read - open this url, dig there, finish now - is blind in the training set, and blind turns are
 * what two rounds collapsed on. 13,056 of them were dropped on the last build.
 *
 * The page is usually still there. A read that followed an `open` of a known address can be
 * re-taken today: open the same address, take the same innerText the read tool takes, and attach it
 * to the step as if it had been recorded on the day. No model is asked anything - this costs
 * browser time and no allowance, which is why it is the thing to do on the day the allowance runs
 * out.
 *
 * WHAT MAKES A RE-SIGHT HONEST. Pages change. The record keeps one hard fact about the page as it
 * was - its length in characters - and a page fetched today is accepted only when its length is
 * within a third of that, it landed on the same site, and it is not empty. A listing page that has
 * since turned over reads about the same length and passes; that is fine, because the decision the
 * teacher took ("open the cheapest one", "finish, nothing here") was about that kind of page and not
 * about one line of it. A page that became a 404, a consent wall or a redirect fails the length and
 * is left blind. A read after a click is never re-sighted: nothing in the record says where the
 * click went.
 *
 * Pure: which steps, from which address, accepted or not. The server does the fetching.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'resight.json');

/** A read that recorded only its length. */
const BLIND = /^read the page \((\d+) characters\)/;
/** Steps after which the address is no longer known. */
const MOVES = new Set(['click', 'type']);
/** Accepted when today's length is within this share of what was recorded. */
const TOLERANCE = 0.35;
/** Rebuild the set once this many pages have been recovered since the last build. */
const REBUILD_AT = 150;

/** The address a step leaves the browser at, when the step says. */
function urlOfStep(s) {
  if (!s) return null;
  if (s.url && /^https?:\/\//.test(String(s.url))) return String(s.url);
  const text = String(s.text || '');
  if (s.kind === 'open') { const m = text.match(/https?:\/\/\S+/); return m ? m[0] : null; }
  if (s.kind === 'read') { const m = text.match(/^read (https?:\/\/\S+) \(/); return m ? m[1] : null; }
  return null;
}

/**
 * The blind reads of a run that can be re-taken: each with the address it read and the length it
 * recorded. Steps already carrying a page, or already tried, are left alone.
 */
function candidates(job) {
  const steps = (job && Array.isArray(job.steps)) ? job.steps : [];
  const out = [];
  let url = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const u = urlOfStep(s);
    if (u) url = u;
    if (MOVES.has(s.kind)) { url = null; continue; }
    if (s.kind !== 'read' || s.content || s.marks || s.resighted) continue;
    const m = BLIND.exec(String(s.text || ''));
    if (!m || !url) continue;
    out.push({ index: i, url, expected: Number(m[1]) });
  }
  return out;
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

/** Is the page fetched today the page that was read then? */
function accept({ expected = 0, got = 0, asked = '', landed = '' } = {}, { tolerance = TOLERANCE } = {}) {
  if (!got || got < 40) return { ok: false, why: 'the page came back empty' };
  if (asked && landed && host(asked) !== host(landed)) return { ok: false, why: `it redirected to ${host(landed) || 'somewhere else'}` };
  const lo = expected * (1 - tolerance);
  const hi = expected * (1 + tolerance);
  if (expected > 0 && (got < lo || got > hi)) return { ok: false, why: `${got} characters today against ${expected} recorded` };
  return { ok: true };
}

/** Exactly what the read tool hands the model, so the student sees what the teacher saw. */
function contentFor(url, text) {
  const trimmed = String(text || '').replace(/\n{3,}/g, '\n\n').slice(0, 5000);
  return `You are on: ${url}\n\nPage text:\n${trimmed}`;
}

const RANK = { gold: 0, silver: 1, bronze: 2 };
const usable = (j, done) => !!(j && j.id) && !done[j.id] && j.status !== 'running' && ((j.verdict && j.verdict.tier) || '') !== 'void';

/**
 * The next few runs to re-sight, gold first. A run is done only once every candidate it had has
 * been tried, so a run cut by the batch edge comes back and none is walked twice.
 */
function pick(jobsIter, st, { max = 25 } = {}) {
  const done = (st && st.doneJobs) || {};
  const rows = [];
  for (const j of jobsIter || []) {
    if (!usable(j, done)) continue;
    const cands = candidates(j);
    if (!cands.length) continue;
    const tier = (j.verdict && j.verdict.tier) || '';
    rows.push({ job: j, cands, rank: RANK[tier] == null ? 3 : RANK[tier] });
  }
  rows.sort((a, b) => a.rank - b.rank || String(b.job.createdAt || '').localeCompare(String(a.job.createdAt || '')));
  const out = [];
  let n = 0;
  for (const r of rows) {
    if (n >= max) break;
    const take = r.cands.slice(0, Math.max(1, max - n));
    out.push({ job: r.job, cands: take });
    n += take.length;
  }
  return out;
}

/** How many blind reads are still waiting, across every run not yet done. */
function left(jobsIter, st) {
  const done = (st && st.doneJobs) || {};
  let n = 0;
  for (const j of jobsIter || []) if (usable(j, done)) n += candidates(j).length;
  return n;
}

/*
 * THE RUNS LIVE ON DISK, NOT IN MEMORY. The server's job map holds this process's own runs; the
 * two and a half thousand on the volume are files, and parsing all of them at once stalls every
 * request the browser is serving. So the scan goes in slices - a few hundred files a tick - and
 * yields only what the batch needs: which runs have blind reads, and how many.
 */
function scan(dir, st, { from = 0, limit = 300 } = {}) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { files = []; }
  const end = Math.min(files.length, from + limit);
  const done = (st && st.doneJobs) || {};
  const found = [];
  for (let i = from; i < end; i++) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, files[i]), 'utf8')); } catch { continue; }
    if (!usable(j, done)) continue;
    const n = candidates(j).length;
    if (n) found.push({ id: j.id, tier: (j.verdict && j.verdict.tier) || '', createdAt: String(j.createdAt || ''), n });
  }
  return { found, next: end, total: files.length, done: end >= files.length };
}

/** Gold first, then the newest. */
function order(entries) {
  const rank = (t) => (RANK[t] == null ? 3 : RANK[t]);
  return (entries || []).slice().sort((a, b) => rank(a.tier) - rank(b.tier) || b.createdAt.localeCompare(a.createdAt));
}

/** One run, fresh from disk, so what is annotated is what is there. */
function loadJob(dir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); } catch { return null; }
}

const EMPTY = () => ({ on: false, accepted: 0, rejected: 0, acceptedSinceBuild: 0, batches: 0, doneJobs: {}, left: -1, lastAt: '', lastWhy: '' });

function load() {
  try { return { ...EMPTY(), ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; }
  catch { return EMPTY(); }
}
function save(st) {
  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(st, null, 1));
  return st;
}
function setOn(on) {
  const st = load();
  st.on = !!on;
  if (st.on) st.lastWhy = '';
  return save(st);
}
/** For the screen: the switch, the tallies, and what the last batch said. */
function state() {
  const st = load();
  return {
    on: st.on, accepted: st.accepted, rejected: st.rejected, batches: st.batches,
    left: typeof st.left === 'number' ? st.left : -1,
    doneJobs: Object.keys(st.doneJobs || {}).length,
    acceptedSinceBuild: st.acceptedSinceBuild, lastAt: st.lastAt, lastWhy: st.lastWhy,
  };
}

module.exports = { candidates, accept, contentFor, pick, left, scan, order, loadJob, load, save, setOn, state, urlOfStep, BLIND, TOLERANCE, REBUILD_AT, FILE };
