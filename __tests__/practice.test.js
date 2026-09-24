/*
 * THE PLATFORM AND ROLE COLLECTOR - and the ways it could quietly become dangerous or useless:
 *   - it runs while automatic acting is on, and a "reply" task actually replies;
 *   - it accepts an account task because the role's own prompt is about accounts;
 *   - it practises a role whose platform has no login, and every run is a login wall;
 *   - one role takes the whole hour while the other thin roles wait for ever;
 *   - two walks share a signed-in profile.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import practice from '../src/practice.js';
import { normalizeSite } from '../src/trainScopes.js';

describe('which role to practise', () => {
  const gaps = [
    { role: 'facebook-thread-reply', platform: 'facebook', examples: 14, needsRealUse: true },
    { role: 'useme.proposal', platform: 'useme', examples: 27, needsRealUse: true },
    { role: 'hn-scout', platform: 'hackernews', examples: 2, needsRealUse: false },
    { role: 'plain-scout', platform: 'web', examples: 0, needsRealUse: false },
  ];
  it('takes the thinnest role whose platform holds a login, never the open web', () => {
    const p = practice.planFor({ gaps, logins: [{ profile: 'facebook', platform: 'facebook' }, { profile: 'useme', platform: 'useme' }] });
    expect(p.role).toBe('facebook-thread-reply');
    expect(p.profile).toBe('facebook');
  });
  it('skips a platform with no signed-in profile, and rests a role for an hour after a run', () => {
    const p = practice.planFor({ gaps, logins: [{ profile: 'useme', platform: 'useme' }] });
    expect(p.role).toBe('useme.proposal');
    const rested = practice.planFor({ gaps, logins: [{ profile: 'useme', platform: 'useme' }], perRole: { 'useme.proposal': { lastAt: new Date().toISOString() } } });
    expect(rested.role).toBe(null);
    expect(rested.why).toContain('within the hour');
  });
  it('reads the platform off a profile name, aliases included', () => {
    expect(practice.platformOfProfile('facebook', normalizeSite)).toBe('facebook');
    expect(practice.platformOfProfile('hn', normalizeSite)).toBe('hackernews');
    expect(practice.platformOfProfile('linkdin', normalizeSite)).toBe('linkedin');
    expect(practice.platformOfProfile('google-watch', normalizeSite)).toBe('google');
  });
});

describe('what it refuses, in code', () => {
  it('NEVER runs while automatic acting is on', () => {
    expect(practice.decide({ on: true, autoAct: true, queued: 3 }).run).toBe(false);
    expect(practice.decide({ on: true, autoAct: true, queued: 3 }).why).toContain('automatic acting');
  });
  it('one walk at a time, a cap an hour, and nothing without a task', () => {
    expect(practice.decide({ on: true, busy: true, queued: 3 }).run).toBe(false);
    expect(practice.decide({ on: true, live: 1, queued: 3 }).run).toBe(false);
    expect(practice.decide({ on: true, queued: 3, recent: Array(6).fill(Date.now()) }).run).toBe(false);
    expect(practice.decide({ on: true, queued: 0 }).run).toBe(false);
    expect(practice.decide({ on: true, queued: 2 }).run).toBe(true);
    expect(practice.decide({ on: false, queued: 2 }).why).toContain('off');
  });
  it('throws away account tasks whatever the role, and keeps outward ones for the gate', () => {
    const { kept, rejected } = practice.vet([
      'Open the notification about Piet\'s comment on the group post and draft one reply to him.',
      'Log in to the account and change the password.',
      'Use run_script to read the page.',
      'Read the three newest posts in the Ecom Nederland group and record who asked for a webshop.',
    ]);
    expect(kept.length).toBe(2);
    expect(rejected.map((r) => r.why)).toEqual(['an account task — never', 'names a tool, which no person would type']);
  });
  it('puts the specialist and the gate rule into the brief', () => {
    const m = practice.askFor({ role: { name: 'facebook-thread-reply', description: 'Continues one thread.', prompt: 'You continue ONE thread.' }, platform: 'facebook', want: 4 });
    expect(m[0].content).toContain('a person approves it');
    expect(m[0].content).toContain('NEVER an account task');
    expect(m[1].content).toContain('facebook-thread-reply on facebook');
    expect(m[1].content).toContain('Write 4 tasks');
  });
});

describe('the queue takes turns', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-practice-')); process.env.PROFILE_DIR = dir; });
  afterEach(() => { delete process.env.PROFILE_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it('queues per role, hands out per role, and records the run against the role', () => {
    expect(practice.push('fb-reply', 'facebook', 'facebook', ['a task one two three four', 'b task one two three four'])).toBe(2);
    expect(practice.push('fb-reply', 'facebook', 'facebook', Array(10).fill('x task one two three four'))).toBe(4);
    expect(practice.take('useme.proposal')).toBe(null);
    const t = practice.take('fb-reply');
    expect(t.prompt).toBe('a task one two three four');
    practice.attachJob('j-1');
    const s = practice.state();
    expect(s.queued).toBe(5);
    expect(s.current).toMatchObject({ role: 'fb-reply', jobId: 'j-1' });
    expect(s.perRole['fb-reply'].runs).toBe(1);
    expect(s.history[0].jobId).toBe('j-1');
  });
  it('is off until switched on, and remembers why it stopped', () => {
    expect(practice.on()).toBe(false);
    practice.setOn(true);
    expect(practice.on()).toBe(true);
    practice.stop('every key is out of allowance');
    expect(practice.state()).toMatchObject({ on: false, stoppedBecause: 'every key is out of allowance' });
  });
});
