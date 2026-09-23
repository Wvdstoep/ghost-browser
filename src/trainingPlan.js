/*
 * trainingPlan.js — WHETHER TO START A ROUND RIGHT NOW, AND ON WHICH MACHINE.
 *
 * Every round so far was started by hand. That was fine while the pipeline was being built and is
 * useless as a system: the whole point was a loop that improves the model without anybody driving
 * it, and a loop that needs a person to type the command is a person, not a loop.
 *
 * So this is the decision, written once, as a pure function of what is known. It is deliberately
 * not a scheduler: nothing here knows the time of day, because "train at 2am" is the wrong rule
 * for a ring of machines in unknown places. The rule is "train when there is something to learn and
 * a machine free to learn it", which is true at any hour.
 *
 * THERE ARE TWO REASONS TO RUN A ROUND, AND ONLY ONE OF THEM IS OBVIOUS.
 *
 *   NEW DATA ARRIVED.  The nightly-learning case: enough runs have been recorded since the last
 *                      round that the model would learn something it has not seen.
 *   THE CORPUS IS NOT COVERED YET.  The catch-up case, and the one that actually matters today. The
 *                      set holds 23,233 turns and the first round reached 685 of them. Waiting for
 *                      "200 new runs" before running the second round would leave 98% of what we
 *                      already have unlearned, for ever, while the gate reported everything fine.
 *
 * Missing the second reason is how a pipeline ends up technically working and practically idle.
 */
'use strict';

/** Below this, a round is not worth a machine: the adapter barely moves and the measurement cannot
 *  tell the difference from noise. Only applies once the corpus has been covered. */
const ENOUGH_NEW = 200;

/** A round that has said nothing for this long is not holding the slot any more. Matches the
 *  staleness rule the device rows use, so the screen and the scheduler never disagree. */
const SILENT_MS = 30 * 60 * 1000;

/**
 * How much of the set has actually been trained on, across every round that reported it.
 *
 * Summed from what each round SAYS IT TRAINED, not from what was available to it. Those are wildly
 * different numbers — a round with 23,233 turns available reached 685 — and confusing them would
 * report the corpus as covered after the first night.
 */
function covered(rounds) {
  let n = 0;
  for (const r of rounds || []) n += Number(r.trained) || 0;
  return n;
}

/**
 * Decide.
 *
 * @param corpus    the tally: usableSinceLastRound, scanning, pending
 * @param dataset   the built set's manifest turns, or null when no set exists yet
 * @param rounds    every round, newest first
 * @param trainers  devices advertising that they can train
 * @param auto      the owner's switch. Off means off — no rule below overrides it.
 * @param serving   the adapter currently in service, to carry on from
 */
function decide({ corpus = {}, dataset = null, rounds = [], trainers = [], auto = true, serving = null, now = Date.now() } = {}) {
  const no = (why) => ({ run: false, why });

  /* The owner's switch comes first and is absolute. A machine that decides to train anyway because
     it judged the reasons good is a machine nobody leaves running. */
  if (!auto) return no('automatic rounds are switched off');

  /*
   * A round that is already going holds the slot — unless it has gone silent, in which case it is
   * almost certainly a closed lid or a crash and its slot should not be held for ever. Three rounds
   * died with SIGSEGV while this was being built; without this clause the first one would have
   * blocked every round after it, permanently, and the screen would have read "training".
   */
  const live = (rounds || []).find((r) => r.status === 'running');
  if (live) {
    const heard = Date.parse((live.lastAt || live.startedAt) || '') || 0;
    if (!heard || (now - heard) < SILENT_MS) return no(`a round is already running on ${live.device || 'a device'}`);
  }

  if (!(trainers || []).some((t) => t.online)) return no('no machine is connected that can train');

  if (!dataset || !dataset.train) return no('no training set has been built yet');

  /* Never decide on a partial count. The corpus is read in slices, so early on the numbers are
     still climbing and "not enough new data" would be a statement about the scan, not the data. */
  if (corpus.scanning) return no(`still reading the history — ${corpus.pending || 0} job(s) to go`);

  const seen = covered(rounds);
  const total = Number(dataset.train) || 0;
  const fresh = Number(corpus.usableSinceLastRound) || 0;

  const device = (trainers || []).find((t) => t.online);
  const go = (why) => ({
    run: true,
    why,
    device: device.name,
    deviceId: device.deviceId,
    /* Carry on from what is SERVING, not from the last round that finished. A round that made the
       model worse is not promoted, and chaining from it anyway would push that damage into every
       round after it. Starting from the serving adapter costs a bad round exactly one round. */
    base: (serving && serving.adapter) || '',
    coverage: { seen, total },
  });

  if (total > 0 && seen < total) {
    return go(`${total - seen} of ${total} turns in the set have not been trained on yet`);
  }
  if (fresh >= ENOUGH_NEW) {
    return go(`${fresh} new usable run(s) since the last round`);
  }
  return no(`the set is covered and only ${fresh} new usable run(s) have arrived — a round wants ${ENOUGH_NEW}`);
}

module.exports = { decide, covered, ENOUGH_NEW, SILENT_MS };
