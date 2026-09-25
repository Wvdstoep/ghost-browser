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

describe('no round on painted cards', () => {
  /*
   * Two rounds trained on a set where 58% of the turns followed a read whose content was never
   * recorded, and both collapsed onto look. A round now waits until the set holds at least a
   * slice's worth of turns that can see the page they decide on.
   */
  const ready = () => ({
    corpus: { usableSinceLastRound: 0 }, dataset: { train: 21000 }, rounds: [],
    trainers: [{ name: 'lap', deviceId: 'd1', online: true }], auto: true, serving: null,
  });

  it('waits while fewer sighted turns exist than a round draws, and says how many', () => {
    const d = decide({ ...ready(), sighted: 218, sliceTurns: 3600 });
    expect(d.run).toBe(false);
    expect(d.why).toMatch(/only 218 turn\(s\)/);
    expect(d.why).toMatch(/draws 3600/);
  });

  it('runs once the set can fill a slice with sighted turns', () => {
    expect(decide({ ...ready(), sighted: 3600, sliceTurns: 3600 }).run).toBe(true);
  });

  it('treats a manifest that never counted as unknown, not as zero', () => {
    /* An old manifest must not lock the loop shut on a number nobody took. */
    expect(decide({ ...ready(), sighted: null, sliceTurns: 3600 }).run).toBe(true);
  });
});

describe('a batch is closed once it has its machines', () => {
  const { decide } = require('../src/trainingPlan');
  const now = new Date().toISOString();
  const two = [{ name: 'KAROLINA', online: true }, { name: 'WOJMAGEMI', online: true }];
  const s = [{ key: 'base', level: 'base', name: '', sighted: 2000, seen: 0, adapter: '', paper: 150 }];
  const corpus = { usableSinceLastRound: 0, scanning: false };
  it('does not hand a third share of a two-machine batch to the machine whose share finished', () => {
    const rounds = [
      { id: 'r-a', status: 'done', device: 'WOJMAGEMI', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 2, adapterHub: 'hub:r-a', result: 12, baseline: 5 },
      { id: 'r-b', status: 'running', device: 'KAROLINA', startedAt: now, lastAt: now, scope: { key: 'base' }, batch: 'r-a', share: 2 },
    ];
    const d = decide({ corpus, dataset: { train: 12000 }, rounds, trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2 });
    expect(d.run).toBe(false);
    expect(d.why).toMatch(/base is being trained/);
  });
  it('holds the scope while the merge round runs, and while it is pending', () => {
    const rounds = [
      { id: 'r-a', status: 'done', device: 'WOJMAGEMI', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 2, adapterHub: 'hub:r-a', mergedInto: 'r-m' },
      { id: 'r-b', status: 'done', device: 'KAROLINA', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 2, adapterHub: 'hub:r-b', mergedInto: 'r-m' },
      { id: 'r-m', status: 'running', device: 'WOJMAGEMI', startedAt: now, lastAt: now, scope: { key: 'base' }, batch: 'r-a', share: 1, merge: true },
    ];
    const d = decide({ corpus, dataset: { train: 12000 }, rounds, trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2 });
    expect(d.run).toBe(false);
    const pend = [{ device: 'WOJMAGEMI', scope: { key: 'base', level: 'base', name: '' }, batch: 'r-a', share: 1, merge: true, at: now }];
    const d2 = decide({ corpus, dataset: { train: 12000 }, rounds: rounds.slice(0, 2), trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2, pending: pend });
    expect(d2.run).toBe(false);
  });
  it('waits for the merge when every share is in and none has started', () => {
    const rounds = [
      { id: 'r-a', status: 'done', device: 'WOJMAGEMI', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 2, adapterHub: 'hub:r-a', mergedInto: 'pending' },
      { id: 'r-b', status: 'done', device: 'KAROLINA', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 2, adapterHub: 'hub:r-b', mergedInto: 'pending' },
    ];
    const d = decide({ corpus, dataset: { train: 12000 }, rounds, trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2 });
    expect(d.run).toBe(false);
  });
  it('opens the scope again once the merge round is done', () => {
    const rounds = [
      { id: 'r-a', status: 'done', device: 'WOJMAGEMI', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 2, adapterHub: 'hub:r-a', mergedInto: 'r-m' },
      { id: 'r-b', status: 'done', device: 'KAROLINA', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 2, adapterHub: 'hub:r-b', mergedInto: 'r-m' },
      { id: 'r-m', status: 'done', device: 'WOJMAGEMI', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 1, merge: true, result: 12, baseline: 5 },
    ];
    const d = decide({ corpus, dataset: { train: 12000 }, rounds, trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2 });
    expect(d.run).toBe(true);
  });
});

describe('the batch is cut to the hours at three epochs', () => {
  const sizing = require('../src/sizing');
  it('turns follow from hours and speed; the epochs never give', () => {
    expect(sizing.EPOCHS).toBe(3);
    /* 1.5 h at 87.5 s a turn: 1.5*3600*0.9 / (87.5*3) = 18.5 -> the floor of 20 */
    expect(sizing.turnsFor({ hours: 1.5, secPerTurn: 87.5 })).toBe(20);
    /* 12 h at 90 s: 12*3600*0.9/(90*3) = 144 */
    expect(sizing.turnsFor({ hours: 12, secPerTurn: 90 })).toBe(144);
    /* 3 h at 90 s: 36 */
    expect(sizing.turnsFor({ hours: 3 })).toBe(36);
    expect(sizing.turnsFor({ hours: 0 })).toBe(sizing.MIN_TURNS);
  });
  it('reads the speed off the trainer lines', () => {
    expect(sizing.speedOf('at 87.5s a turn the hours allow 3 of 12 planned steps — schedule shortened')).toBe(87.5);
    expect(sizing.speedOf('32/180 turn-passes · epoch 1/3 · step 2/3 (0/16 turns into the next) · loss 1.61 · lr 2.00e-04 · 48 min in, about 42 min left, 3.8 GB')).toBe(90);
    expect(sizing.speedOf('3/180 turn-passes · epoch 1/3 · step 0/12 · loss 1.8 · 2 min in, about 88 min left')).toBe(null);
    expect(sizing.speedOf('10/150  agreement 0.0%  0.06 turns/s')).toBe(null);
  });
  it('a machine gets its own speed, the batch the typical one, and the mode splits the hours', () => {
    const rounds = [
      { id: 'r3', device: 'Karolina', secPerTurn: 120 },
      { id: 'r2', device: 'WojMagEmi', secPerTurn: 87.5 },
      { id: 'r1', device: 'WojMagEmi', secPerTurn: 200 },
    ];
    expect(sizing.secPerTurnFor('wojmagemi', rounds)).toBe(87.5);
    expect(sizing.secPerTurnFor('Third', rounds)).toBe(sizing.DEFAULT_SEC);
    expect(sizing.typicalSpeed(rounds)).toBe(120);
    const time = sizing.forSettings({ hours: 3, mode: 'time', share: 2, secPerTurn: 90 });
    expect(time).toMatchObject({ hoursEach: 1.5, turnsEach: 20, batchTurns: 40, epochs: 3 });
    const work = sizing.forSettings({ hours: 3, mode: 'work', share: 2, secPerTurn: 90 });
    expect(work).toMatchObject({ hoursEach: 3, turnsEach: 36, batchTurns: 72 });
    const long = sizing.forSettings({ hours: 12, mode: 'work', share: 2, secPerTurn: 90 });
    expect(long.turnsEach).toBe(144);
  });
  it('a round remembers the speed its lines report', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-speed-'));
    const prev = process.env.PROFILE_DIR; process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    const training = require('../src/training');
    try {
      const r = training.startRound({ device: 'WojMagEmi', turns: 60 });
      training.noteRound(r.id, '3/180 turn-passes · epoch 1/3 · step 0/12 · loss 1.8 · 2 min in, about 88 min left');
      expect(training.allRounds().find((x) => x.id === r.id).secPerTurn).toBeUndefined();
      training.noteRound(r.id, 'at 87.5s a turn the hours allow 3 of 12 planned steps — schedule shortened');
      expect(training.allRounds().find((x) => x.id === r.id).secPerTurn).toBe(87.5);
      expect(sizing.secPerTurnFor('WOJMAGEMI', training.allRounds())).toBe(87.5);
    } finally {
      if (prev === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = prev;
      delete require.cache[require.resolve('../src/training')];
    }
  });
});
