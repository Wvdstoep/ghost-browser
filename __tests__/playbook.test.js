/**
 * What this account has learned about where leads are.
 *
 * Every run used to start from nothing: rediscovering that Facebook has a post search, retrying
 * phrasings somebody tried last week, sweeping a group that has produced nothing in a month. A
 * prompt cannot fix that — telling a model "you know Facebook" does not tell it that "programmeur
 * gezocht" returns recruiters while "wie kan mij helpen met een webshop" returns customers.
 *
 * The rule this file exists to enforce: the score is EARNED, never claimed. Nothing here asks the
 * agent how it did.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-pb-'));
const pb = await import('../src/playbook.js');

const search = (q) => ({ kind: 'search', what: q });

describe('keeping score', () => {
  beforeEach(() => pb.forget('facebook'));

  it('records what a place returned, not what anyone thought of it', () => {
    pb.recordSweep('facebook', search('webshop bouwen'), { posts: 12, tooOld: 3 });
    const e = pb.summary('facebook').places[0];
    expect(e).toMatchObject({ what: 'webshop bouwen', posts: 12, tooOld: 3, sweeps: 1, leads: 0 });
  });

  it('credits a lead to the place it came from', () => {
    pb.recordSweep('facebook', search('webshop bouwen'), { posts: 10 });
    pb.recordLead('facebook', search('webshop bouwen'));
    expect(pb.summary('facebook').places[0].leads).toBe(1);
  });

  it('accumulates across runs, which is the whole point', () => {
    for (let i = 0; i < 3; i++) pb.recordSweep('facebook', search('x'), { posts: 5 });
    expect(pb.summary('facebook').places[0]).toMatchObject({ sweeps: 3, posts: 15 });
  });

  it('will not credit a lead to a place it has never swept', () => {
    expect(pb.recordLead('facebook', search('never seen'))).toBeNull();
  });

  it('ignores a place it cannot name', () => {
    expect(pb.recordSweep('facebook', { kind: 'search', what: '  ' }, { posts: 3 })).toBeNull();
  });
});

describe('deciding what is worth trying again', () => {
  beforeEach(() => pb.forget('facebook'));

  /* Writing somewhere off after one quiet afternoon is how you lose the group that produces a
     customer a month. It takes real evidence. */
  it('does not write a place off on thin evidence', () => {
    pb.recordSweep('facebook', search('quiet'), { posts: 4 });
    expect(pb.summary('facebook').places[0].dead).toBe(false);
  });

  it('writes one off after enough sweeps and enough posts with nothing to show', () => {
    for (let i = 0; i < 4; i++) pb.recordSweep('facebook', search('dead end'), { posts: 20 });
    expect(pb.summary('facebook').places[0].dead).toBe(true);
  });

  it('never writes off a place that has produced somebody', () => {
    for (let i = 0; i < 9; i++) pb.recordSweep('facebook', search('slow but real'), { posts: 40 });
    pb.recordLead('facebook', search('slow but real'));
    expect(pb.summary('facebook').places[0].dead).toBe(false);
  });
});

describe('what the agent is handed', () => {
  beforeEach(() => pb.forget('facebook'));

  it('is empty before anything has been learned, rather than pretending', () => {
    expect(pb.asContext('facebook')).toBe('');
  });

  it('names what worked and what to stop trying', () => {
    pb.recordSweep('facebook', search('goede webbouwer'), { posts: 8 });
    pb.recordLead('facebook', search('goede webbouwer'));
    for (let i = 0; i < 4; i++) pb.recordSweep('facebook', search('software development'), { posts: 30 });

    const ctx = pb.asContext('facebook');
    expect(ctx).toMatch(/WHAT HAS WORKED BEFORE/);
    expect(ctx).toMatch(/goede webbouwer/);
    expect(ctx).toMatch(/NEVER PRODUCED ANYONE/);
    expect(ctx).toMatch(/software development/);
  });

  /* A search tried once that found two is a better bet for the next twenty minutes than one tried
     twenty times that found three. Ordering by total would say the opposite. */
  it('puts the best bet first, by rate rather than by total', () => {
    pb.recordSweep('facebook', search('rare gem'), { posts: 5 });
    pb.recordLead('facebook', search('rare gem'));
    pb.recordLead('facebook', search('rare gem'));
    for (let i = 0; i < 20; i++) pb.recordSweep('facebook', search('grind'), { posts: 50 });
    for (let i = 0; i < 3; i++) pb.recordLead('facebook', search('grind'));

    const ctx = pb.asContext('facebook');
    expect(ctx.indexOf('rare gem')).toBeLessThan(ctx.indexOf('grind'));
  });

  /* An average alone cannot tell "nothing here yet" from "thirty posts and never a lead", and only
     one of those deserves another try. */
  it('keeps the raw counts, so the history is readable', () => {
    pb.recordSweep('facebook', search('x'), { posts: 8 });
    pb.recordLead('facebook', search('x'));
    expect(pb.asContext('facebook')).toMatch(/1 lead\(s\) from 8 post\(s\) over 1 sweep\(s\)/);
  });
});
