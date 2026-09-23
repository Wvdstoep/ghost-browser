/*
 * THE COLLECTION LOOP — what it refuses, what it aims at, and when it declines to run.
 *
 * Every run in this corpus was typed by the owner and waited for, which is why `open` has four
 * thousand examples and `choose_option` had TWO until a prompt was written by hand to exercise it.
 * This engine performs that loop instead, and the interesting parts are all about restraint: what it
 * throws away, and the four separate reasons it will decline to start a run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { decide, vet, gapsFrom, askFor, take, push, stop, setOn, state, CAP_PER_HOUR, QUEUE_MAX } from '../src/harvest.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-harvest-'));
  process.env.PROFILE_DIR = dir;
});
afterEach(() => {
  delete process.env.PROFILE_DIR;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
});

const good = 'Find the ten cheapest second hand bakfiets listings on marktplaats.nl and record each one with its price and link';

describe('what it refuses, in code rather than in an instruction', () => {
  /*
   * The generator is TOLD to produce read-and-record work. It will sometimes produce "post a reply"
   * anyway, and a rule that lives only in a prompt holds until the model has a bad day. A rejected
   * prompt costs nothing, so these err heavily towards refusing.
   */
  it('refuses anything other people would see', () => {
    const r = vet(['Post a reply to the top comment on that thread', 'Send them a message asking for a quote']);
    expect(r.kept).toEqual([]);
    expect(r.rejected.map((x) => x.why)).toEqual([
      'asks for something other people would see',
      'asks for something other people would see',
    ]);
  });

  it('refuses accounts and sign-ins, which are a person\'s job once and never a loop\'s', () => {
    expect(vet(['Sign up for a free trial on that site and tell me what you get']).kept).toEqual([]);
    expect(vet(['Log in to the portal and download the invoice list']).kept).toEqual([]);
  });

  it('refuses the sites that refuse this address', () => {
    /* LinkedIn and Upwork read the cluster's IP as a robot. A blocked walk teaches the model what a
       block page looks like and nothing else; that work belongs on the owner's own device. */
    const r = vet(['Find five recent Dutch webdesign vacancies on linkedin and record the company and the title']);
    expect(r.kept).toEqual([]);
    expect(r.rejected[0].why).toMatch(/refuses this address/);
  });

  it('refuses a prompt that names a tool, because no person types that', () => {
    /* The whole point is train/serve parity on the goal: the model is served wishes, so it must be
       trained on wishes. A prompt naming run_script is a recipe wearing a request's clothes. */
    expect(vet(['Use run_script to pull the table off that page']).kept).toEqual([]);
  });

  it('refuses one that could not have a right answer, either way', () => {
    expect(vet(['go']).rejected[0].why).toMatch(/too short/);
    expect(vet([`x${'y'.repeat(420)}`]).rejected[0].why).toMatch(/recipe, not a request/);
  });

  it('refuses a repeat, and counts a repeat within one batch too', () => {
    expect(vet([good], { history: [{ prompt: good }] }).kept).toEqual([]);
    expect(vet([good, good]).kept).toHaveLength(1);
  });

  it('keeps a good one and strips the list marker a model puts in front of it', () => {
    const r = vet([`3. ${good}`, `- ${good.replace('bakfiets', 'bakfietsen')}`]);
    expect(r.kept).toHaveLength(2);
    expect(r.kept[0]).toBe(good);
  });

  it('says why each rejection went, because a silent filter looks like a model with nothing left', () => {
    const r = vet(['Post something', 'go', good]);
    expect(r.kept).toHaveLength(1);
    expect(r.rejected.every((x) => x.why && x.prompt)).toBe(true);
  });
});

describe('what it aims at is measured, not imagined', () => {
  /*
   * A model asked for "some browser tasks" writes twenty variations of searching Google. The value
   * is in the gaps, and by COUNT rather than share: "open is 18% of the set" is interesting and not
   * actionable, "choose_option has 2 examples" writes the prompt for you.
   */
  it('names the thinnest tools first, and only the thin ones', () => {
    const gaps = gapsFrom({
      perTool: { open: 4000, look: 2711, choose_option: 2, read_table: 40 },
      known: ['open', 'look', 'choose_option', 'read_table', 'tabs'],
      floor: 200,
    });
    expect(gaps.map((g) => g.tool)).toEqual(['tabs', 'choose_option', 'read_table']);
    expect(gaps[0].examples).toBe(0);
  });

  it('reads the live catalogue, so a tool shipped next month is a gap on its first day', () => {
    const gaps = gapsFrom({ perTool: {}, known: ['brand_new_tool'], floor: 1 });
    expect(gaps).toEqual([{ tool: 'brand_new_tool', examples: 0 }]);
  });

  it('puts the gaps and the hard rules into the brief it sends', () => {
    const [sys, user] = askFor({
      gaps: [{ tool: 'choose_option', examples: 2 }],
      history: [{ prompt: good }],
      want: 6,
    });
    expect(sys.content).toMatch(/READ AND RECORD ONLY/);
    expect(sys.content).toMatch(/NO ACCOUNTS/);
    expect(sys.content).toMatch(/No tool names/);
    expect(user.content).toMatch(/choose_option \(2 examples\)/);
    expect(user.content).toMatch(/write nothing resembling these/);
    expect(user.content).toMatch(/Write 6 tasks/);
  });
});

describe('the four reasons it declines to start a run', () => {
  const queue = [good];
  it('the toggle is off, and that is absolute', () => {
    expect(decide({ on: false, queue }).run).toBe(false);
    expect(decide({ on: false, queue }).why).toMatch(/switched off/);
  });

  it('the browser is busy — one browser, one walk', () => {
    expect(decide({ on: true, busy: true, queue }).why).toMatch(/using the browser/);
  });

  it('the hourly cap is reached, because every run costs credit', () => {
    const now = Date.now();
    const recent = Array.from({ length: CAP_PER_HOUR }, (_, i) => now - i * 1000);
    const d = decide({ on: true, queue, recent, now });
    expect(d.run).toBe(false);
    expect(d.why).toMatch(new RegExp(`cap is ${CAP_PER_HOUR}`));
  });

  it('counts only the last hour, so yesterday does not hold it shut', () => {
    const now = Date.now();
    const recent = Array.from({ length: 40 }, (_, i) => now - (3600000 + i * 1000));
    expect(decide({ on: true, queue, recent, now }).run).toBe(true);
  });

  it('nothing is queued', () => {
    expect(decide({ on: true, queue: [] }).why).toMatch(/nothing queued/);
  });

  it('otherwise it runs, and hands back the prompt it will use', () => {
    const d = decide({ on: true, queue });
    expect(d.run).toBe(true);
    expect(d.prompt).toBe(good);
  });
});

describe('the queue as a record of what was collected', () => {
  it('takes the head, and remembers that it went', () => {
    setOn(true);
    push([good, 'Find the opening hours of three Dutch ceramics studios and record them']);
    expect(take('j-1')).toBe(good);
    const s = state({});
    expect(s.queued).toBe(1);
    expect(s.collected).toBe(1);
    expect(s.inLastHour).toBe(1);
    expect(s.recent[0].jobId).toBe('j-1');
  });

  it('takes nothing from an empty queue rather than inventing work', () => {
    expect(take('j-1')).toBeNull();
  });

  it('is bounded, so a generous model cannot fill the disk', () => {
    push(Array.from({ length: QUEUE_MAX + 50 }, (_, i) => `${good} number ${i}`));
    expect(state({}).queued).toBe(QUEUE_MAX);
  });

  it('switching off keeps the reason, and switching on clears it', () => {
    /* Running out of allowance stops the loop. A loop that kept dispatching into an empty account
       would fill the corpus with void runs whose only lesson is what a billing error looks like. */
    setOn(true);
    stop('every model key is out of allowance');
    expect(state({}).on).toBe(false);
    expect(state({}).stoppedBecause).toMatch(/out of allowance/);
    setOn(true);
    expect(state({}).stoppedBecause).toBe('');
  });

  it('starts switched off, because nothing should begin spending on its own', () => {
    expect(state({}).on).toBe(false);
    expect(state({}).plan.run).toBe(false);
  });
});
