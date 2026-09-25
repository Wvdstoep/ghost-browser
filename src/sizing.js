'use strict';
/*
 * HOW MANY TURNS A MACHINE CAN LEARN IN ITS HOURS - at three epochs, never fewer.
 *
 * The batch used to have a floor of 120 turns. On a CPU a sighted turn-pass takes about 90 s, so
 * a 1.5 h share carries some 50 turn-passes; handed 60 turns it saw them less than once and the
 * trainer quietly shortened its schedule to 3 of 12 steps. The owner's rule is that the epochs are
 * not the thing that gives (feedback: quality over speed), so the turns are what follows from the
 * hours: each machine's share is cut to what IT can pass three times in its hours, from the speed
 * it reported last time, with a tenth kept back for the checkpoints and the validation points.
 */
const DEFAULT_SEC = 90;   // seconds per sighted turn-pass on the laptops measured so far
const EPOCHS = 3;
const MIN_TURNS = 20;     // below this a round is noise, whatever the hours say
const SAFETY = 0.9;

function turnsFor({ hours = 0, secPerTurn = DEFAULT_SEC, epochs = EPOCHS } = {}) {
  const sec = Number(secPerTurn) > 0 ? Number(secPerTurn) : DEFAULT_SEC;
  return Math.max(MIN_TURNS, Math.floor((Number(hours) || 0) * 3600 * SAFETY / (sec * epochs)));
}

/** Seconds per turn-pass read off one progress line, or null when the line says nothing about it. */
function speedOf(line) {
  const s = String(line || '');
  let m = /at ([\d.]+)s a turn/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d+)\/(\d+) turn-passes.*?(\d+) min in/.exec(s);
  if (m && Number(m[1]) >= 8 && Number(m[3]) > 0) return Number(m[3]) * 60 / Number(m[1]);
  return null;
}

/** The last speed a machine reported (rounds newest first), else the default. */
function secPerTurnFor(device, rounds = []) {
  const d = String(device || '').toLowerCase();
  for (const r of rounds || []) {
    if (String(r.device || '').toLowerCase() !== d) continue;
    if (Number(r.secPerTurn) > 0) return Number(r.secPerTurn);
  }
  return DEFAULT_SEC;
}

/** The typical speed across the machines seen lately - the median of the last reports, else the default. */
function typicalSpeed(rounds = []) {
  const seen = new Map();
  for (const r of rounds || []) {
    const d = String(r.device || '').toLowerCase();
    if (!d || seen.has(d) || !(Number(r.secPerTurn) > 0)) continue;
    seen.set(d, Number(r.secPerTurn));
  }
  const v = [...seen.values()].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : DEFAULT_SEC;
}

/** The whole picture for the owner's settings: hours each, turns each, the batch, the epochs. */
function forSettings({ hours = 0, mode = 'time', share = 1, secPerTurn = DEFAULT_SEC } = {}) {
  const n = Math.max(1, Number(share) || 1);
  const hoursEach = mode === 'work' ? Number(hours) || 0 : (Number(hours) || 0) / n;
  const turnsEach = turnsFor({ hours: hoursEach, secPerTurn });
  return { mode: mode === 'work' ? 'work' : 'time', share: n, hours: Number(hours) || 0, hoursEach, turnsEach, batchTurns: turnsEach * n, epochs: EPOCHS, secPerTurn: Number(secPerTurn) > 0 ? Number(secPerTurn) : DEFAULT_SEC };
}

module.exports = { DEFAULT_SEC, EPOCHS, MIN_TURNS, SAFETY, turnsFor, speedOf, secPerTurnFor, typicalSpeed, forSettings };
