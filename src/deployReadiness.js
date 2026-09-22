/*
 * deployReadiness.js — ONE HONEST ANSWER TO "IS THE BROWSER ACTUALLY WORKING RIGHT NOW?"
 *
 * The auto-deployer must not roll the pod out from under a live walk, so it asks first. It asked by
 * reimplementing GB's idea of "busy" in three Node one-liners over three endpoints, added the three
 * numbers together, and printed the total. That went wrong in three separate ways at once:
 *
 *   1. A SESSION WITH NO JOB COUNTED AS BUSY, FOREVER. The rule was "no job means the owner is in
 *      their own browser, and a roll would cut them out" — true while someone is actually there. But
 *      a session's job is looked up in the job store, and once that record ages out the lookup
 *      answers null, so a session nobody has touched for an hour read exactly like a person typing
 *      in it. Nothing ever cleared it; it took the pool's two-hour absolute TTL.
 *   2. A PARKED JOB IS NOT WORK. `idle` in GB means "finished, waiting for you to say carry on", and
 *      the agent loop deliberately keeps that session alive for half an hour. That is a parked
 *      conversation, not a browser mid-click. Rolling costs it nothing that is not already written.
 *   3. THE LOG SAID A NUMBER AND NOT A NAME. "GB has 1 active session(s)" with the three counts
 *      already added together cannot tell you whether that was a session, a watcher or a chat — so
 *      every diagnosis started by asking the cluster the same three questions again by hand.
 *
 * So the question is answered HERE, where the facts live, as one function over one snapshot, and the
 * answer carries its reasons. A holder that does not block is still reported, because "nothing is
 * blocking and here is what is parked" is the sentence that was missing.
 *
 * This is deliberately a pure function: no pool, no clock, no express. The gate that protects a
 * production roll is the last thing that should only be testable against a running browser.
 */
'use strict';

/** A session with no job blocks only while someone is plausibly still in it. */
const FRESH_MS = 2 * 60 * 1000;
/** A chat turn that has run longer than this is stuck, not busy — same reasoning as the watcher flag. */
const CHAT_STUCK_MS = 30 * 60 * 1000;

/** GB's parked states. `idle` is the important one: finished and waiting for a person. */
const PARKED = new Set(['idle', 'done', 'failed', 'stopped', 'interrupted']);

const mins = (ms) => Math.round(ms / 60000);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

/**
 * Who is holding the browser, and which of them should stop a roll.
 *
 * @param {object} snap
 *   sessions:   [{ sessionId, profile, lastUsed, job }]  job = { jobId, role, status } | null
 *   watchers:   [string]            keys of passes running now (already TTL-reaped by the caller)
 *   recordings: [string]            recorder ids running now
 *   chats:      [{ id, title, startedAt }]  assistant turns live in this process
 * @returns {{ busy: number, blocking: object[], parked: object[], holders: object[] }}
 */
function readiness(snap = {}, now = Date.now(), opts = {}) {
  const freshMs = num(opts.freshMs, FRESH_MS);
  const chatStuckMs = num(opts.chatStuckMs, CHAT_STUCK_MS);
  const holders = [];

  for (const s of (snap.sessions || [])) {
    if (!s || !s.sessionId) continue;
    const where = s.profile ? `profile ${s.profile}` : 'anonymous';
    const idleFor = mins(Math.max(0, now - num(s.lastUsed, now)));
    const job = s.job || null;

    if (job && job.status === 'running') {
      holders.push({ kind: 'session', id: s.sessionId, blocking: true, ageMinutes: idleFor,
        why: `driving job ${job.jobId || '?'} (${job.role || 'a step'}) in ${where}` });
      continue;
    }
    if (job) {
      /* Parked: the job reached an end state, or is waiting to be told to carry on. */
      holders.push({ kind: 'session', id: s.sessionId, blocking: false, ageMinutes: idleFor,
        why: `parked in ${where} — job ${job.jobId || '?'} is ${job.status}, not running` });
      continue;
    }
    /*
     * No job. This is either a person in their own browser — which a roll must not cut — or the
     * leftover of a job whose record has aged out, which is what held a built image for two hours.
     * The only thing that separates them is whether it is still being touched.
     */
    if (now - num(s.lastUsed, 0) <= freshMs) {
      holders.push({ kind: 'session', id: s.sessionId, blocking: true, ageMinutes: idleFor,
        why: `open in ${where} and in use ${idleFor === 0 ? 'right now' : `${idleFor} min ago`} — someone is probably in it` });
    } else {
      holders.push({ kind: 'session', id: s.sessionId, blocking: false, ageMinutes: idleFor,
        why: `open in ${where} but untouched for ${idleFor} min and holding no job — the pool will reap it` });
    }
  }

  for (const key of (snap.watchers || [])) {
    if (!key) continue;
    holders.push({ kind: 'watcher', id: String(key), blocking: true, ageMinutes: null,
      why: `a watcher pass is running (${key})` });
  }

  for (const id of (snap.recordings || [])) {
    if (!id) continue;
    holders.push({ kind: 'recording', id: String(id), blocking: true, ageMinutes: null,
      why: `a recording is being written (${id}) — a roll would truncate the file` });
  }

  for (const c of (snap.chats || [])) {
    if (!c || !c.id) continue;
    const age = mins(Math.max(0, now - num(c.startedAt, now)));
    const stuck = num(c.startedAt, now) > 0 && now - num(c.startedAt, now) > chatStuckMs;
    holders.push({ kind: 'chat', id: c.id, blocking: !stuck, ageMinutes: age,
      why: stuck
        ? `an assistant turn has been running ${age} min (${String(c.title || '').slice(0, 40)}) — longer than any real turn, treating it as stuck`
        : `an assistant turn is running (${String(c.title || '').slice(0, 40)}), started ${age} min ago` });
  }

  const blocking = holders.filter((h) => h.blocking);
  return { busy: blocking.length, blocking, parked: holders.filter((h) => !h.blocking), holders };
}

/** One line per holder, for a deploy log that has to be readable a week later. */
function explain(r) {
  if (!r.holders.length) return 'nothing is holding the browser';
  return r.holders.map((h) => `${h.blocking ? 'BLOCKS' : 'parked'} ${h.kind} ${h.id}: ${h.why}`).join('\n');
}

module.exports = { readiness, explain, FRESH_MS, CHAT_STUCK_MS, PARKED };
