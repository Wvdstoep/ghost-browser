/*
 * THE DECISION TO TRAIN, AND THE WAYS AN AUTOMATIC LOOP QUIETLY STOPS BEING ONE.
 *
 * None of these throw. Each produces a pipeline that looks healthy and does nothing, or one that
 * does the wrong thing enthusiastically:
 *
 *   - the gate waits for "new data" while 98% of the set it already has sits unlearned;
 *   - a round that segfaulted holds the slot for ever, so no round ever starts again;
 *   - coverage is summed from turns AVAILABLE rather than turns TRAINED, so the corpus reads as
 *     finished after one night;
 *   - a losing round becomes the base for the next one, and the damage compounds;
 *   - the owner's switch is overridden by a rule that judged the reasons good.
 */
import { describe, it, expect } from 'vitest';
import { decide, covered, ENOUGH_NEW } from '../src/trainingPlan.js';

const ready = (over = {}) => ({
  corpus: { usableSinceLastRound: 0, scanning: false, pending: 0 },
  dataset: { train: 23233 },
  rounds: [],
  trainers: [{ name: 'laptop-carla', deviceId: 'd1', online: true }],
  auto: true,
  serving: null,
  ...over,
});

describe('reasons to run', () => {
  it('RUNS WHILE THE SET IS NOT COVERED, without waiting for new data', () => {
    /* The reason that is easy to miss. The first round reached 685 of 23,233 turns; a gate that
       only fires on "200 new runs" would leave the other 22,548 unlearned for ever while
       reporting that everything was fine. */
    const d = decide(ready({ rounds: [{ status: 'done', trained: 685 }] }));
    expect(d.run).toBe(true);
    expect(d.why).toContain('22548');
    expect(d.coverage).toEqual({ seen: 685, total: 23233 });
  });

  it('runs on new data once the set IS covered', () => {
    const d = decide(ready({
      rounds: [{ status: 'done', trained: 23233 }],
      corpus: { usableSinceLastRound: 240, scanning: false },
    }));
    expect(d.run).toBe(true);
    expect(d.why).toContain('240 new usable');
  });

  it('waits when the set is covered and barely anything new has arrived', () => {
    const d = decide(ready({
      rounds: [{ status: 'done', trained: 23233 }],
      corpus: { usableSinceLastRound: 12, scanning: false },
    }));
    expect(d.run).toBe(false);
    expect(d.why).toContain(`wants ${ENOUGH_NEW}`);
  });

  it('counts turns TRAINED, not turns that were available', () => {
    /* Each round records the whole set as available (23,233) and trains a few hundred. Summing the
       wrong field reports the corpus as covered after a single night. */
    expect(covered([{ trained: 685, turns: 23233 }, { trained: 700, turns: 23233 }])).toBe(1385);
    /* A round that never reported what it trained contributes nothing rather than guessing. */
    expect(covered([{ turns: 23233 }])).toBe(0);
  });
});

describe('reasons not to run', () => {
  it('never overrides the owner switch', () => {
    const d = decide(ready({ auto: false, rounds: [{ status: 'done', trained: 0 }] }));
    expect(d.run).toBe(false);
    expect(d.why).toContain('switched off');
  });

  it('waits for a round that is genuinely running', () => {
    const d = decide(ready({
      rounds: [{ status: 'running', device: 'laptop-carla', startedAt: new Date().toISOString() }],
    }));
    expect(d.run).toBe(false);
    expect(d.why).toContain('already running on laptop-carla');
  });

  it('DOES NOT LET A DEAD ROUND HOLD THE SLOT FOR EVER', () => {
    /* Three rounds died with SIGSEGV while this was written. A crashed round never calls endRound,
       so it stays `running` permanently — and without this clause the first crash would block every
       round after it while the screen read "training". */
    const longAgo = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const d = decide(ready({
      rounds: [{ status: 'running', device: 'laptop-carla', startedAt: longAgo, lastAt: longAgo, trained: 0 }],
    }));
    expect(d.run).toBe(true);
  });

  it('will not start without a machine that can train', () => {
    expect(decide(ready({ trainers: [] })).why).toContain('no machine');
    expect(decide(ready({ trainers: [{ name: 'x', online: false }] })).why).toContain('no machine');
  });

  it('will not start without a set', () => {
    expect(decide(ready({ dataset: null })).why).toContain('no training set');
  });

  it('will not decide on a corpus that is still being read', () => {
    /* The history arrives in slices, so early on "not enough new data" is a statement about the
       scan rather than about the data. */
    const d = decide(ready({ corpus: { usableSinceLastRound: 0, scanning: true, pending: 1826 } }));
    expect(d.run).toBe(false);
    expect(d.why).toContain('1826');
  });
});

describe('what a new round carries on from', () => {
  it('CHAINS FROM WHAT IS SERVING, not from the last round that finished', () => {
    /* A round that made the model worse is not promoted. Chaining from it anyway would push that
       damage into every round after it; chaining from the serving adapter costs one round. */
    const d = decide(ready({
      rounds: [{ status: 'done', trained: 685, promoted: false }],
      serving: { adapter: 'D:/gb-train/rounds/round-A/adapter' },
    }));
    expect(d.base).toBe('D:/gb-train/rounds/round-A/adapter');
  });

  it('starts from the bare base when nothing has been promoted yet', () => {
    expect(decide(ready({ rounds: [{ status: 'done', trained: 1 }] })).base).toBe('');
  });

  it('names the machine it picked, so the dispatch has somewhere to go', () => {
    const d = decide(ready({ rounds: [{ status: 'done', trained: 1 }] }));
    expect(d.device).toBe('laptop-carla');
    expect(d.deviceId).toBe('d1');
  });
});
