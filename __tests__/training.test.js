/*
 * THE STATUS SCREEN, AND THE FOUR WAYS A STATUS SCREEN QUIETLY LIES.
 *
 * This module exists so an unattended nightly loop is not indistinguishable from a broken one. That
 * only holds if the screen is right when it matters, so every test here is one way it could be
 * wrong while still looking fine:
 *
 *   - a worse adapter reaches serving because the round that produced it was simply the most recent
 *     one to finish;
 *   - a device that died overnight still reads "training", because the round it never closed stays
 *     `running` for ever;
 *   - a round is offered for tonight over data that has not changed since the last one, costing a
 *     night of somebody's laptop to reproduce the same adapter;
 *   - the pipeline screen and the device hub disagree about the same device, because each worked the
 *     answer out for itself.
 *
 * None of these throw. They all produce a screen that is confidently wrong.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import training from '../src/training.js';

const { startRound, noteRound, endRound, promote, current, byDevice, state } = training;

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-training-'));
  process.env.PROFILE_DIR = dir;
});
afterEach(() => {
  delete process.env.PROFILE_DIR;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone already */ }
});

const finished = (over = {}) => {
  const r = startRound({ device: 'laptop', base: 'qwen2.5-0.5b', turns: 9000 });
  return endRound(r.id, {
    baseline: { agreement_pct: 41.2 },
    result: { agreement_pct: 58.9 },
    adapter: 'gb-role-lora-v1',
    ...over,
  });
};

describe('rounds', () => {
  it('records a round as running until the device says otherwise', () => {
    const r = startRound({ device: 'laptop', base: 'qwen2.5-0.5b', turns: 100 });
    expect(r.status).toBe('running');
    expect(r.endedAt).toBe(null);
    /* A round recorded at dispatch and never picked up looks identical to one that ran and
       vanished. Telling those two apart is the entire job of this file. */
    expect(training.allRounds().map((x) => x.id)).toEqual([r.id]);
  });

  it('keeps the device progress lines in order and bounded', () => {
    const r = startRound({ device: 'laptop' });
    for (let i = 0; i < 50; i++) noteRound(r.id, `step ${i}`);
    const kept = training.allRounds()[0].lines;
    expect(kept).toHaveLength(40);
    expect(kept[kept.length - 1].text).toBe('step 49');
  });

  it('ignores progress for a round it has never heard of', () => {
    expect(noteRound('r-nope', 'hello')).toBe(null);
  });

  it('keeps a round that made the model worse', () => {
    /* The losing rounds are the evidence the gate works. Dropping them would leave a history in
       which the model only ever improves, which is the history of a broken gate. */
    const r = finished({ result: { agreement_pct: 22.0 } });
    expect(r.status).toBe('done');
    expect(training.allRounds()).toHaveLength(1);
  });
});

describe('promotion', () => {
  it('refuses a round that is still running', () => {
    const r = startRound({ device: 'laptop' });
    expect(promote(r.id).error).toMatch(/running/);
    expect(current()).toBe(null);
  });

  it('refuses a round that was never measured', () => {
    const r = startRound({ device: 'laptop' });
    endRound(r.id, {});
    expect(promote(r.id).error).toMatch(/no measurement/);
    expect(current()).toBe(null);
  });

  it('REFUSES A ROUND THAT DID NOT BEAT ITS OWN BASELINE', () => {
    /* The whole reason promotion is a separate act. A round that finished is not a round that won,
       and the failure mode of conflating them is silent: the freshest adapter wins by being fresh,
       the model gets worse, and every later round is measured against the worse model. */
    const r = finished({ baseline: { agreement_pct: 58.0 }, result: { agreement_pct: 57.9 } });
    expect(promote(r.id).error).toMatch(/did not beat the baseline/);
    expect(current()).toBe(null);
  });

  it('refuses a tie, because a tie is not evidence', () => {
    const r = finished({ baseline: { agreement_pct: 58.0 }, result: { agreement_pct: 58.0 } });
    expect(promote(r.id).error).toMatch(/did not beat/);
  });

  it('promotes a measured win and records what it beat', () => {
    const r = finished();
    expect(promote(r.id)).toEqual({ promoted: r.id });
    const live = current();
    expect(live.adapter).toBe('gb-role-lora-v1');
    expect(live.agreement).toBe(58.9);
    /* What it beat travels with the pointer, so a rollback decision does not need the round list. */
    expect(live.beat).toBe(41.2);
    expect(live.device).toBe('laptop');
  });

  it('refuses a round it has never heard of', () => {
    expect(promote('r-nope').error).toBe('no such round');
  });
});

describe('what each device is doing', () => {
  it('reports the latest round per device, not the latest running one', () => {
    /* A round only becomes `done` because the device called endRound. A round killed by a closed
       lid stays `running` for ever, so ranking `running` above `done` would let one dead round mask
       every real round after it on that row — for ever, and silently. */
    const dead = startRound({ device: 'laptop' });
    expect(dead.status).toBe('running');
    const later = finished();

    const row = byDevice()['laptop'];
    expect(row.roundId).toBe(later.id);
    expect(row.status).toBe('done');
    expect(row.result).toBe(58.9);
  });

  it('flags a running round that has gone silent rather than calling it progress', () => {
    const r = startRound({ device: 'laptop' });
    noteRound(r.id, 'epoch 1, step 200');
    const row = byDevice(Date.now() + 91 * 60 * 1000)['laptop'];
    expect(row.status).toBe('running');
    expect(row.stale).toBe(true);
    expect(row.silentForMin).toBe(91);
  });

  it('does not flag a round that is merely slow', () => {
    const r = startRound({ device: 'laptop' });
    noteRound(r.id, 'epoch 1, step 200');
    const row = byDevice(Date.now() + 9 * 60 * 1000)['laptop'];
    expect(row.stale).toBe(false);
  });

  it('carries the last thing the device said, which is the point of the row', () => {
    const r = startRound({ device: 'laptop' });
    noteRound(r.id, 'epoch 1, step 200');
    noteRound(r.id, 'epoch 1, step 400, loss 0.71');
    expect(byDevice()['laptop'].last.text).toBe('epoch 1, step 400, loss 0.71');
  });

  it('keeps devices apart', () => {
    endRound(startRound({ device: 'laptop-a' }).id, { baseline: { agreement_pct: 1 }, result: { agreement_pct: 2 } });
    startRound({ device: 'laptop-b' });
    const rows = byDevice();
    expect(rows['laptop-a'].status).toBe('done');
    expect(rows['laptop-b'].status).toBe('running');
  });
});

describe('the one answer both screens read', () => {
  /* Shaped as the tally hands it over, because that is what the endpoint passes in. */
  const corpusOf = (ids) => ({
    tiers: Object.values(ids).reduce((acc, v) => {
      if (v && v.tier) acc[v.tier] = (acc[v.tier] || 0) + 1;
      return acc;
    }, { gold: 0, silver: 0, bronze: 0, void: 0 }),
    ids,
    unjudged: 0,
    jobs: Object.keys(ids).length,
  });

  it('counts only usable work recorded since the last round', () => {
    const r = finished();
    const after = new Date(Date.parse(r.startedAt) + 60000).toISOString();
    const before = new Date(Date.parse(r.startedAt) - 60000).toISOString();
    const s = state({
      corpus: corpusOf({
        a: { tier: 'gold', at: after }, b: { tier: 'silver', at: after },
        /* Bronze and void are evidence of what NOT to do; they do not make a round worth running. */
        c: { tier: 'bronze', at: after }, d: { tier: 'void', at: after },
        e: { tier: 'gold', at: before },
      }),
    });
    expect(s.corpus.tiers).toEqual({ gold: 2, silver: 1, bronze: 1, void: 1 });
    expect(s.corpus.usableSinceLastRound).toBe(2);
    /* Two new jobs is not a night of somebody's laptop. */
    expect(s.corpus.enoughForARound).toBe(false);
  });

  it('says yes the first time, when there is no last round to compare against', () => {
    const s = state({ corpus: corpusOf({ a: { tier: 'gold', at: new Date().toISOString() } }) });
    expect(s.corpus.enoughForARound).toBe(true);
  });

  it('passes on that the history is still being read, rather than showing a number as final', () => {
    const s = state({ corpus: { ...corpusOf({}), scanning: true, pending: 1800 } });
    expect(s.corpus.scanning).toBe(true);
    expect(s.corpus.pending).toBe(1800);
  });

  it('hands the device hub the same rows as the pipeline screen', () => {
    /* Both screens read one answer. Deriving it twice is how two screens end up disagreeing about
       the same device in front of the person who has to trust them. */
    const r = startRound({ device: 'laptop' });
    noteRound(r.id, 'epoch 1');
    const s = state({ trainers: [{ name: 'laptop', online: true }, { name: 'phone', online: true }] });
    expect(s.trainers[0].training.roundId).toBe(r.id);
    expect(s.trainers[0].training).toEqual(s.byDevice['laptop']);
    /* A trainer with no round says so, rather than being left off. */
    expect(s.trainers[1].training).toBe(null);
  });

  it('survives an empty machine', () => {
    const s = state({});
    expect(s.corpus.jobsWithVerdict).toBe(0);
    expect(s.rounds).toEqual([]);
    expect(s.serving).toBe(null);
    expect(s.trainers).toEqual([]);
  });
});
