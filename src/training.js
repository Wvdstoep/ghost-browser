/*
 * training.js — THE PIPELINE AS SOMETHING YOU CAN LOOK AT.
 *
 * The loop is meant to improve the model every night without anybody driving it, and that is exactly
 * why it needs a face. An unattended process with no surface is indistinguishable from a broken one:
 * the model either gets better or it does not, and nobody finds out which for weeks.
 *
 * So this holds three things and nothing else:
 *
 *   WHAT HAS BEEN COLLECTED   the corpus as it stands, by tier, and how much of it is new since the
 *                             last round — which is the honest answer to "is there anything to train
 *                             on tonight".
 *   WHAT EACH ROUND DID       every round kept forever, with the score before and after and whether
 *                             it was promoted. A round that made the model worse is as important to
 *                             keep as one that helped: it is the evidence the gate is working.
 *   WHAT IS SERVING NOW       which adapter is live, when it was promoted, and what it scored. One
 *                             pointer, so a rollback is moving it back.
 *
 * Deliberately NOT here: the training itself. That happens on a device with a CPU to spare, because
 * this node has none — it is the controller, and the one time it held eleven gigabytes for an idle
 * service nobody noticed for three weeks.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const corpusLib = require('./corpus');

/*
 * The paths are resolved per call, not frozen at import.
 *
 * Freezing them at module load makes the store depend on WHEN this file is first required relative
 * to the environment being set up — a difference that does not show in any test and shows in
 * production as an empty history nobody can explain. Resolving per call costs a string join.
 */
const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const ROUNDS = () => path.join(DIR(), 'rounds.json');
const CURRENT = () => path.join(DIR(), 'current.json');

const ensure = () => { try { fs.mkdirSync(DIR(), { recursive: true }); } catch { /* already there */ } };
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => { ensure(); fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(p + '.tmp', p); };

/* ── rounds ─────────────────────────────────────────────────────────────────────────────────── */

const allRounds = () => readJson(ROUNDS(), []);

/**
 * A round starts when a device takes it, not when it is dispatched.
 *
 * The difference matters: a round recorded at dispatch and never picked up looks identical to one
 * that ran and vanished, and telling those apart is the whole job of a status page.
 */
function startRound({ device = '', base = '', turns = 0, note = '' } = {}) {
  const r = {
    id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    device: String(device || 'unknown'),
    base: String(base || ''),
    turns: Number(turns) || 0,
    status: 'running',
    note: String(note || '').slice(0, 300),
    baseline: null,     // what the model scored BEFORE this round
    result: null,       // and after
    promoted: false,
    why: '',
  };
  const rows = allRounds();
  rows.unshift(r);
  writeJson(ROUNDS(), rows.slice(0, 200));
  return r;
}

/** Progress from the device while it works — one line, so the UI is never silent for an hour. */
function noteRound(id, line) {
  const rows = allRounds();
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  r.lines = [...(r.lines || []), { at: new Date().toISOString(), text: String(line || '').slice(0, 300) }].slice(-40);
  writeJson(ROUNDS(), rows);
  return r;
}

/**
 * END A ROUND, AND DECIDE NOTHING HERE.
 *
 * Whether the new adapter is better is the device's measurement, taken on the frozen evaluation
 * split; this only records it. Promotion is a separate, explicit act — a round that finished is not
 * a round that won, and conflating them is how a worse model reaches production quietly.
 */
function endRound(id, { status = 'done', baseline = null, result = null, why = '', adapter = '' } = {}) {
  const rows = allRounds();
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  r.endedAt = new Date().toISOString();
  r.status = status;
  r.baseline = baseline;
  r.result = result;
  r.why = String(why || '').slice(0, 400);
  if (adapter) r.adapter = String(adapter).slice(0, 200);
  writeJson(ROUNDS(), rows);
  return r;
}

/**
 * Promote an adapter to serving. Explicit, and only ever after a measured win.
 *
 * Every version is kept — an adapter is a few megabytes — so rolling back is moving this pointer,
 * not rebuilding anything.
 */
function promote(roundId) {
  const rows = allRounds();
  const r = rows.find((x) => x.id === roundId);
  if (!r) return { error: 'no such round' };
  if (r.status !== 'done') return { error: `round ${roundId} is ${r.status}, not done` };
  if (!r.result || !r.baseline) return { error: 'that round has no measurement, so there is nothing to promote on' };
  if (Number(r.result.agreement_pct) <= Number(r.baseline.agreement_pct)) {
    return { error: `it did not beat the baseline (${r.result.agreement_pct}% against ${r.baseline.agreement_pct}%)` };
  }
  r.promoted = true;
  writeJson(ROUNDS(), rows);
  writeJson(CURRENT(), {
    roundId: r.id,
    adapter: r.adapter || '',
    base: r.base,
    agreement: r.result.agreement_pct,
    beat: r.baseline.agreement_pct,
    promotedAt: new Date().toISOString(),
    device: r.device,
  });
  return { promoted: r.id };
}

const current = () => readJson(CURRENT(), null);

/* ── the view ───────────────────────────────────────────────────────────────────────────────── */

/**
 * WHAT EACH DEVICE IS DOING, KEYED BY THE NAME THE DEVICE HUB ALREADY USES.
 *
 * A training round is work, and work belongs on the row of the device doing it — the same place a
 * goal run shows up. Without this the hub would say a laptop is "online, idle" while it is four
 * hours into a round, which is worse than saying nothing: it invites somebody to close the lid.
 *
 * Returned as a map so a screen can look a device up by name instead of scanning the round list and
 * re-deriving the answer, which is how two screens end up disagreeing about the same fact.
 */
const SILENT_MS = 30 * 60 * 1000;

function byDevice(now = Date.now()) {
  const out = {};
  for (const r of allRounds()) {
    /* Rounds are stored newest-first, so the first one seen for a device is simply its latest.
     *
     * The tempting rule — let a `running` round outrank a finished one — is a trap. A round only
     * becomes `done` because the device called endRound, so a round killed by a closed lid, a lost
     * connection or a crash stays `running` for ever. Under that rule one dead round from weeks ago
     * would permanently mask every real round after it on this device's row. Newest wins, and
     * staleness is reported rather than ranked on. */
    if (out[r.device]) continue;
    const lines = r.lines || [];
    const last = lines.length ? lines[lines.length - 1] : null;

    /* A round that claims to be running and has said nothing for half an hour is the honest
     * definition of a round nobody should still be waiting for. Saying "training" next to a device
     * that died overnight is worse than saying nothing: it is the one thing this screen exists to
     * prevent. The thirty minutes is generous on purpose — a slow CPU deep in an epoch is normal. */
    const heard = Date.parse((last && last.at) || r.startedAt) || 0;
    const stale = r.status === 'running' && heard > 0 && (now - heard) > SILENT_MS;

    out[r.device] = {
      roundId: r.id,
      status: r.status,
      stale,
      silentForMin: r.status === 'running' && heard ? Math.floor((now - heard) / 60000) : null,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      turns: r.turns,
      promoted: r.promoted,
      /* The most recent thing the device said about itself, which is the whole point of the row. */
      last,
      baseline: r.baseline ? r.baseline.agreement_pct : null,
      result: r.result ? r.result.agreement_pct : null,
    };
  }
  return out;
}

/**
 * Everything the settings screen shows, in one answer.
 *
 * `newSinceLastRound` is the number that decides whether tonight is worth running at all: a round
 * over the same data produces the same adapter and costs a night of somebody's laptop.
 */
function state({ corpus, manifest, preflight, trainers } = {}) {
  const rounds = allRounds();
  const work = byDevice();
  /*
   * "Since the last round" means since the last round STARTED, not since it finished. A round trains
   * on the data as it stood when it began, so work recorded while it ran has not been learnt from
   * yet and must still count towards the next one.
   */
  const last = rounds.find((r) => r.status === 'done') || rounds[0] || null;

  const c = corpus || {};
  const tiers = c.tiers || { gold: 0, silver: 0, bronze: 0, void: 0 };
  const fresh = last ? corpusLib.usableSince(c.ids, last.startedAt) : 0;

  return {
    corpus: {
      jobsWithVerdict: Object.values(tiers).reduce((a, b) => a + b, 0),
      tiers,
      unjudged: c.unjudged || 0,
      jobs: c.jobs || 0,
      /* The history is read in slices, so early on this number is still climbing. Saying so is the
         difference between a screen that is filling in and a screen that is simply wrong. */
      scanning: !!c.scanning,
      pending: c.pending || 0,
      usableSinceLastRound: fresh,
      /* Below this a round is not worth a night of somebody's machine — the adapter would barely
         move and the measurement could not tell the difference from noise. */
      enoughForARound: fresh >= 200 || !last,
    },
    dataset: manifest ? {
      builtAt: manifest.builtAt,
      turns: manifest.turns,
      tiers: manifest.tiers,
      dropped: manifest.droppedTurns || {},
    } : null,
    preflight: preflight || null,
    serving: current(),
    rounds: rounds.slice(0, 20).map((r) => ({
      id: r.id, startedAt: r.startedAt, endedAt: r.endedAt, device: r.device, status: r.status,
      turns: r.turns, promoted: r.promoted, why: r.why,
      baseline: r.baseline ? r.baseline.agreement_pct : null,
      result: r.result ? r.result.agreement_pct : null,
      lines: (r.lines || []).slice(-6),
    })),
    /*
     * The trainers carry their own round with them, so the device hub renders a row straight from
     * this without joining two lists itself. Same numbers as the pipeline screen, by construction.
     */
    trainers: (trainers || []).map((t) => ({ ...t, training: work[t.name] || null })),
    byDevice: work,
  };
}

module.exports = { startRound, noteRound, endRound, promote, current, allRounds, state, byDevice, DIR };
