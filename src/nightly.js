/**
 * THE NIGHTLY SELF-CHECK — the Heal loop with a clock (roadmap Phase 1/E). Once a night, at a quiet
 * hour, the assistant gets a turn of its own: read every watcher's health and the day's runs and
 * errors, fix what is a config / role / flow matter the operator way and prove it with a run, never
 * act outward, and leave a report the owner reads in the chat history ("Nightly check") next morning.
 *
 * Pure scheduling here (testable); server.js owns the clock and the assistant.
 */
const fs = require('fs');
const path = require('path');

const STATE = path.join(process.env.PROFILE_DIR || '/profiles', 'operator', 'nightly.json');
const HOUR_UTC = 3;   // 03:00 UTC ≈ 05:00 in the owner's summer time — the platforms are quiet, the owner asleep

const GOAL = `NIGHTLY SELF-CHECK. You run once a night on your own, unattended. In order:
1. gb_watchers and gb_watcher_health for each: is every active watcher passing on schedule (not stale)? Did the last passes read what they should (messages, waiting, drafts) or end with errors?
2. gb_runs_recent (last 24 h) and gb_logs grep:"ERROR" since_minutes:1440 — what failed, how often, why.
3. gb_people leadsOnly:true — anyone new with buying interest since yesterday, and any promise of the owner's older than 3 days that no later reply of theirs mentions (gb_people with the name).
4. For anything wrong that a config, role or flow change fixes: fix it the operator way (smallest change, run, read the evidence). Nothing outward — no posting, no replies, no joins; drafts only.
5. reply with the night's report in the owner's words: what ran, what was wrong, what you changed and proved, what needs code (with the evidence), the leads and promises worth attention. Cards: {kind:"results"} for watchers with drafts waiting, {kind:"approvals"} if anything waits at the gate. Keep the lessons in gb_memory_write.`;

function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); } catch { /* best effort */ } }

/** Is it time? True once per UTC day, only in the quiet hour, and never twice for the same day. */
function due(now = Date.now(), state = readState(), hour = HOUR_UTC) {
  const d = new Date(now); if (d.getUTCHours() !== hour) return false;
  const day = d.toISOString().slice(0, 10);
  return state.lastDay !== day;
}
function markRun(now = Date.now(), state = readState()) { const day = new Date(now).toISOString().slice(0, 10); writeState({ ...state, lastDay: day, lastRunAt: now }); return day; }

module.exports = { due, markRun, readState, GOAL, HOUR_UTC, STATE };
