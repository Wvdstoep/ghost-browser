/*
 * ONE ADAPTER PER PLATFORM, ONE PER ROLE WHEN IT HAS EARNED IT — AND THE CHAIN THAT SERVES THEM.
 *
 * Every test here is a way the three-scope pipeline quietly turns back into one model:
 *   - a role lands on the wrong platform and its turns train the wrong adapter;
 *   - a platform round draws base's lines, or base's marks hide a platform's lines for ever;
 *   - the paper changes between two rounds of the same platform, and the difference reads as progress;
 *   - the planner keeps training base while a platform holds a slice nobody has used;
 *   - a promotion overwrites another scope's pointer, or serves a four-turn paper as a win;
 *   - the serving chain asks a model that has not earned its stage, or forgets the teacher.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import platforms from '../src/trainScopes.js';
import { draw, exam, progress } from '../src/slice.js';
import training from '../src/training.js';
import { decide, pickScope, coveredFor } from '../src/trainingPlan.js';
import autopilot from '../src/autopilot.js';
import shadow from '../src/shadow.js';
import coverage from '../src/coverage.js';
import { splitByRole } from '../src/traceset.js';
import harvest from '../src/harvest.js';
import platformMap from '../src/platformMap.js';

const EOL = String.fromCharCode(10);

describe('which platform a role works on', () => {
  it('reads the site off the record first — a role is data', () => {
    expect(platforms.platformOf('x', { site: 'news.ycombinator.com' })).toBe('hackernews');
    expect(platforms.platformOf('x', { site: 'https://www.facebook.com/groups' })).toBe('facebook');
    expect(platforms.platformOf('x', { site: 'useme' })).toBe('useme');
    expect(platforms.platformOf('x', { platform: 'Reddit' })).toBe('reddit');
  });
  it('reads the name when the record names no site, and the open web otherwise', () => {
    expect(platforms.platformOf('reddit-old-form-for-hire-poster', {})).toBe('reddit');
    expect(platforms.platformOf('hn-keyword-thread-scout', {})).toBe('hackernews');
    expect(platforms.platformOf('olx-create-account', {})).toBe('olx');
    expect(platforms.platformOf('video-voiceover-elevenlabs', {})).toBe('studio');
    expect(platforms.platformOf('research.company', {})).toBe(platforms.BASE);
    expect(platforms.platformOf('general')).toBe(platforms.BASE);
  });
  it('knows the built-in roles by their site', () => {
    expect(platforms.platformOf('research.reviews')).toBe('google');
    expect(platforms.platformOf('facebook.scout')).toBe('facebook');
    expect(platforms.platformOf('useme.proposal')).toBe('useme');
  });
  it('chains a role to its platform to base, and a base-platform role straight to base', () => {
    expect(platforms.chainOf('facebook.scout').map((s) => s.key)).toEqual(['role:facebook.scout', 'platform:facebook', 'base']);
    expect(platforms.chainOf('research.company').map((s) => s.key)).toEqual(['role:research.company', 'base']);
    expect(platforms.chainOf('general').map((s) => s.key)).toEqual(['base']);
    expect(platforms.parentOf('role:facebook.scout').key).toBe('platform:facebook');
    expect(platforms.parentOf('platform:facebook').key).toBe('base');
    expect(platforms.parentOf('base')).toBe(null);
  });
  it('reads the role and the platform off a set line without parsing it', () => {
    const line = JSON.stringify({ messages: [{ role: 'system', content: 'x "role":"trap"' }, { role: 'user', content: 'g' }, { role: 'assistant', content: '{}' }], meta: { jobId: 'j', role: 'facebook.scout', platform: 'facebook', sighted: true } });
    expect(platforms.roleOfLine(line)).toBe('facebook.scout');
    expect(platforms.platformOfLine(line)).toBe('facebook');
    expect(platforms.matches('platform:facebook', line)).toBe(true);
    expect(platforms.matches('platform:google', line)).toBe(false);
    expect(platforms.matches('role:facebook.scout', line)).toBe(true);
    expect(platforms.matches('base', line)).toBe(true);
    /* An older set without the platform written on the line: derived from the role. */
    const old = JSON.stringify({ messages: [], meta: { role: 'research.reviews', sighted: true } });
    expect(platforms.platformOfLine(old)).toBe('google');
  });
  it('makes a tag-safe slug', () => {
    expect(platforms.slug('base')).toBe('base');
    expect(platforms.slug('platform:facebook')).toBe('facebook');
    expect(platforms.slug('role:facebook.scout')).toBe('facebook-scout');
  });
});

/* ── the draw and the paper, per scope ──────────────────────────────────────────────────────── */

const line = (tool, role, platform, n, sighted = true) => JSON.stringify({
  messages: [
    { role: 'system', content: `You are Ghost Browser working as ${role}.` },
    { role: 'user', content: `GOAL: thing ${n}${EOL}${EOL}SEEN SO FAR:${EOL}- look: You are on: https://${platform}.com/groups/123/posts/4${EOL}[1] button "Join group"${EOL}[2] link Home` },
    { role: 'assistant', content: JSON.stringify({ tool, args: tool === 'click' ? { index: 1 } : {} }) },
  ],
  meta: { jobId: `j-${n}`, tier: 'gold', role, platform, sighted },
});

describe('the draw and the paper, per scope', () => {
  let dir, file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-scopes-'));
    process.env.PROFILE_DIR = dir;
    file = path.join(dir, 'train.jsonl');
    const rows = [];
    let n = 0;
    for (let i = 0; i < 30; i++) rows.push(line(i % 3 === 0 ? 'click' : 'open', 'facebook.scout', 'facebook', n++));
    for (let i = 0; i < 30; i++) rows.push(line('open', 'research.reviews', 'google', n++));
    for (let i = 0; i < 10; i++) rows.push(line('look', 'general', 'web', n++));
    fs.writeFileSync(file, rows.join(EOL));
  });
  afterEach(() => { delete process.env.PROFILE_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it('a platform round draws only that platform, base draws everything', () => {
    const fb = draw({ file, builtAt: 'b1', want: 100, roundId: 'r1', scope: 'platform:facebook' });
    expect(fb.count).toBe(30);
    expect(fb.jsonl.split(EOL).every((l) => l.includes('"platform":"facebook"'))).toBe(true);
    expect(fb.remaining).toBe(0);
    const all = draw({ file, builtAt: 'b1', want: 100, roundId: 'r2', scope: 'base' });
    expect(all.count).toBe(70);
  });
  it('a line base took is still there for its platform, and never twice for one scope', () => {
    draw({ file, builtAt: 'b1', want: 100, roundId: 'r-base', scope: 'base' });
    const fb = draw({ file, builtAt: 'b1', want: 100, roundId: 'r-fb', scope: 'platform:facebook' });
    expect(fb.count).toBe(30);
    const again = draw({ file, builtAt: 'b1', want: 100, roundId: 'r-fb2', scope: 'platform:facebook' });
    expect(again.count).toBe(0);
    expect(again.exhausted).toBe(true);
    expect(progress('b1', 70, 'platform:facebook').handed).toBe(30);
    expect(progress('b1', 70, 'base').handed).toBe(70);
  });
  it('a role round draws that role alone', () => {
    const r = draw({ file, builtAt: 'b1', want: 100, roundId: 'r', scope: 'role:research.reviews' });
    expect(r.count).toBe(30);
    expect(r.scope).toBe('role:research.reviews');
  });
  it('the paper is per scope and the same every time, and a different scope is a different paper', () => {
    const a = exam({ file, want: 10, scope: 'platform:facebook' });
    const b = exam({ file, want: 10, scope: 'platform:facebook' });
    expect(a.jsonl).toBe(b.jsonl);
    expect(a.count).toBeGreaterThanOrEqual(8);
    expect(a.jsonl.split(EOL).every((l) => l.includes('"platform":"facebook"'))).toBe(true);
    const g = exam({ file, want: 10, scope: 'platform:google' });
    expect(g.jsonl).not.toBe(a.jsonl);
    /* Base keeps the paper it always had: the seed did not move. */
    const base1 = exam({ file, want: 10 });
    const base2 = exam({ file, want: 10, scope: 'base' });
    expect(base1.jsonl).toBe(base2.jsonl);
  });
  it('the coverage scan counts per platform and per role', () => {
    const cov = coverage.scan(file);
    expect(cov.perPlatform.facebook).toEqual({ all: 30, sighted: 30 });
    expect(cov.perRole['research.reviews']).toMatchObject({ all: 30, sighted: 30, platform: 'google' });
    expect(cov.perPlatform.web.all).toBe(10);
  });
});

/* ── the exam split, per role ───────────────────────────────────────────────────────────────── */

describe('the exam is cut per role, by job', () => {
  it('gives every role with four jobs a paper, and a role with two none', () => {
    const kept = [];
    for (let i = 0; i < 12; i++) kept.push({ job: { id: `a${i}` }, outcome: {}, role: 'seo.audit' });
    for (let i = 0; i < 2; i++) kept.push({ job: { id: `b${i}` }, outcome: {}, role: 'useme.proposal' });
    const train = [], ev = [];
    splitByRole(kept, 0.15, train, ev);
    expect(ev.filter((x) => x.job.id.startsWith('a')).length).toBe(2);
    expect(ev.filter((x) => x.job.id.startsWith('b')).length).toBe(0);
    expect(train.length + ev.length).toBe(14);
    /* The same jobs on the same side next time. */
    const train2 = [], ev2 = [];
    splitByRole(kept, 0.15, train2, ev2);
    expect(ev2.map((x) => x.job.id)).toEqual(ev.map((x) => x.job.id));
  });
});

/* ── the planner's choice ───────────────────────────────────────────────────────────────────── */

describe('which scope the next round trains', () => {
  const scopes = () => ([
    { level: 'base', name: '', key: 'base', sighted: 1700, seen: 0, adapter: '', parentAdapter: '' },
    { level: 'platform', name: 'facebook', key: 'platform:facebook', sighted: 100, seen: 0, adapter: '', parentAdapter: '' },
    { level: 'platform', name: 'google', key: 'platform:google', sighted: 1500, seen: 0, adapter: '', parentAdapter: '' },
    { level: 'role', name: 'research.reviews', key: 'role:research.reviews', sighted: 989, seen: 0, adapter: '', parentAdapter: '' },
  ]);
  it('base first, while nothing serves', () => {
    const p = pickScope(scopes(), 120);
    expect(p.pick.key).toBe('base');
    expect(p.why).toContain('nothing serves yet');
  });
  it('then the largest platform that holds a slice and has no adapter — a thin one waits', () => {
    const s = scopes(); s[0].adapter = 'base-v1'; s[0].seen = 1700;
    const p = pickScope(s, 120);
    expect(p.pick.key).toBe('platform:google');
    /* facebook has 100 sighted turns and a slice is 120: it rides with base for now. */
    const s2 = scopes(); s2[0].adapter = 'base-v1'; s2[0].seen = 1700; s2[2].adapter = 'g-v1'; s2[2].seen = 1500; s2[3].adapter = 'r-v1'; s2[3].seen = 989;
    const p2 = pickScope(s2, 120);
    expect(p2.pick).toBe(null);
  });
  it('a platform before a role of the same standing, and a role chains from its platform', () => {
    const s = scopes(); s[0].adapter = 'base-v1'; s[0].seen = 1700; s[2].adapter = 'g-v1'; s[2].seen = 1500; s[3].parentAdapter = 'g-v1';
    const p = pickScope(s, 120);
    expect(p.pick.key).toBe('role:research.reviews');
    const d = decide({
      corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: [],
      trainers: [{ name: 'laptop', deviceId: 'd1', online: true }], auto: true, serving: { adapter: 'base-v1' },
      scopes: s, sliceTurns: 120,
    });
    expect(d.run).toBe(true);
    expect(d.scope.key).toBe('role:research.reviews');
    expect(d.base).toBe('g-v1');
    expect(d.why).toContain('research.reviews');
  });
  it('then whichever has the most untrained turns, and waits when every scope is covered', () => {
    const s = scopes();
    s[0].adapter = 'b'; s[0].seen = 1000; s[1].seen = 100; s[2].adapter = 'g'; s[2].seen = 1400; s[3].adapter = 'r'; s[3].seen = 989;
    expect(pickScope(s, 120).pick.key).toBe('base');
    const covered = scopes().map((x) => ({ ...x, adapter: 'a', seen: x.sighted }));
    const d = decide({
      corpus: { usableSinceLastRound: 12, scanning: false }, dataset: { train: 12000 }, rounds: [],
      trainers: [{ name: 'laptop', deviceId: 'd1', online: true }], auto: true, serving: { adapter: 'a' },
      scopes: covered, sliceTurns: 120,
    });
    expect(d.run).toBe(false);
    expect(d.why).toContain('every scope is covered');
  });
  it('TWO MACHINES TRAIN AT ONCE — the second joins the first scope as its pair, and never two on one machine', () => {
    const s = scopes(); s[0].adapter = 'base-v1'; s[0].seen = 1700;
    const two = [{ name: 'WojMagEmi', deviceId: 'd1', online: true }, { name: 'Second', deviceId: 'd2', online: true }];
    const running = [{ id: 'r-g1', status: 'running', device: 'WOJMAGEMI', startedAt: new Date().toISOString(), lastAt: new Date().toISOString(), scope: { key: 'platform:google' } }];
    const d = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: running, trainers: two, auto: true, serving: { adapter: 'base-v1' }, scopes: s, sliceTurns: 120 });
    expect(d.run).toBe(true);
    expect(d.device).toBe('Second');
    /* Two machines share one scope now: the second takes the other half of google's slice. */
    expect(d.scope.key).toBe('platform:google');
    expect(d.batch).toBe(running[0].id);
    /* One machine, one round: the same picture with only the busy laptop waits and says why. */
    const one = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: running, trainers: [two[0]], auto: true, serving: { adapter: 'base-v1' }, scopes: s, sliceTurns: 120 });
    expect(one.run).toBe(false);
    expect(one.why).toContain('busy');
    /* Base running on the first machine: the second takes the other share of base. */
    const fresh = scopes();
    const baseRunning = [{ id: 'r-b1', status: 'running', device: 'WOJMAGEMI', startedAt: new Date().toISOString(), lastAt: new Date().toISOString(), scope: { key: 'base' } }];
    const d2 = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: baseRunning, trainers: two, auto: true, serving: null, scopes: fresh, sliceTurns: 120, share: 2 });
    expect(d2.run).toBe(true);
    expect(d2.scope.key).toBe('base');
    expect(d2.batch).toBe('r-b1');
    expect(d2.device).toBe('Second');
  });

  it('A MACHINE WHOSE ROUNDS CRASHED TWICE IN AN HOUR RESTS, and the other one carries on', () => {
    const s = scopes(); s[0].adapter = 'base-v1'; s[0].seen = 1700;
    const two = [{ name: 'WojMagEmi', deviceId: 'd1', online: true }, { name: 'Karolina', deviceId: 'd2', online: true }];
    const now = new Date().toISOString();
    const crashed = [
      { status: 'failed', device: 'KAROLINA', startedAt: now, endedAt: now, why: 'the trainer process died' },
      { status: 'failed', device: 'KAROLINA', startedAt: now, endedAt: now, why: 'the trainer process died' },
    ];
    const d = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: crashed, trainers: two, auto: true, serving: { adapter: 'base-v1' }, scopes: s, sliceTurns: 120 });
    expect(d.run).toBe(true);
    expect(d.device).toBe('WojMagEmi');
    const only = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: crashed, trainers: [two[1]], auto: true, serving: { adapter: 'base-v1' }, scopes: s, sliceTurns: 120 });
    expect(only.run).toBe(false);
    expect(only.why).toContain('resting');
    /* One failure is a failure, not a pattern. */
    expect(decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: [crashed[0]], trainers: [two[1]], auto: true, serving: { adapter: 'base-v1' }, scopes: s, sliceTurns: 120 }).run).toBe(true);
  });

  it('TWO MACHINES TAKE THE TWO HALVES OF ONE SCOPE, and a third would not', () => {
    const s = scopes();
    const two = [{ name: 'WojMagEmi', deviceId: 'd1', online: true }, { name: 'Karolina', deviceId: 'd2', online: true }];
    const now = new Date().toISOString();
    const live = [{ id: 'r-half-a', status: 'running', device: 'KAROLINA', startedAt: now, lastAt: now, scope: { key: 'base' } }];
    const d = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: live, trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2 });
    expect(d.run).toBe(true);
    expect(d.scope.key).toBe('base');
    expect(d.device).toBe('WojMagEmi');
    expect(d.batch).toBe('r-half-a');
    /* Two of two on base and no base adapter yet: a third machine WAITS for base - never Google first. */
    const both = live.concat([{ id: 'r-half-b', status: 'running', device: 'WOJMAGEMI', startedAt: now, lastAt: now, scope: { key: 'base' }, batch: 'r-half-a' }]);
    const three = two.concat([{ name: 'Third', deviceId: 'd3', online: true }]);
    const d2 = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: both, trainers: three, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2 });
    expect(d2.run).toBe(false);
    expect(d2.why).toContain('base is being trained');
    /* With three allowed to share, the third joins base. */
    const d3 = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: both, trainers: three, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 3 });
    expect(d3.scope.key).toBe('base');
    expect(d3.batch).toBe('r-half-a');
    /* Once base has an adapter, the machines move on to the next scope, sharing it the same way. */
    const served = scopes(); served[0].adapter = 'base-v1'; served[0].seen = 1700;
    const g = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: [], trainers: two, auto: true, serving: { adapter: 'base-v1' }, scopes: served, sliceTurns: 120, share: 2 });
    expect(g.scope.key).toBe('platform:google');
  });

  it('A DISPATCH NOBODY REGISTERED YET HOLDS ITS MACHINE AND ITS SCOPE, so the second share goes to the other laptop', () => {
    const s = scopes();
    const two = [{ name: 'WojMagEmi', deviceId: 'd1', online: true }, { name: 'Karolina', deviceId: 'd2', online: true }];
    const pending = [{ device: 'WojMagEmi', scope: { key: 'base', level: 'base', name: '' }, batch: 'b-1', share: 2, at: new Date().toISOString() }];
    const d = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: [], trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2, pending });
    expect(d.run).toBe(true);
    expect(d.device).toBe('Karolina');
    expect(d.scope.key).toBe('base');
    expect(d.batch).toBe('b-1');
    /* Both machines pending: nothing is free. */
    const both = pending.concat([{ device: 'Karolina', scope: { key: 'base', level: 'base', name: '' }, batch: 'b-1', share: 2, at: new Date().toISOString() }]);
    const d2 = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: [], trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2, pending: both });
    expect(d2.run).toBe(false);
    expect(d2.why).toContain('busy');
  });

  it('sums coverage per scope, and counts rounds from before the scopes as base', () => {
    const rounds = [{ trained: 100 }, { trained: 50, scope: { key: 'platform:facebook' } }, { trained: 20, scope: { key: 'base' } }];
    expect(coveredFor(rounds, 'base')).toBe(120);
    expect(coveredFor(rounds, 'platform:facebook')).toBe(50);
  });
  it('decides as it always did when nobody measured the scopes', () => {
    const d = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 1000 }, rounds: [{ status: 'done', trained: 10 }], trainers: [{ name: 'l', deviceId: 'd', online: true }], auto: true });
    expect(d.run).toBe(true);
    expect(d.scope).toBe(null);
    expect(d.why).toContain('990');
  });
});

/* ── the rounds, the pending dispatch and the promotion map ─────────────────────────────────── */

describe('the pending dispatch and the promotion map', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-map-')); process.env.PROFILE_DIR = dir; });
  afterEach(() => { delete process.env.PROFILE_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  const win = (over = {}) => {
    const r = training.startRound({ device: 'laptop', base: '', turns: 100, ...over });
    return training.endRound(r.id, { baseline: { agreement_pct: 10, turns: 150 }, result: { agreement_pct: 30, turns: 150 }, adapter: `a-${r.id}`, trained: 100 });
  };

  it('a round takes the scope the hub wrote at dispatch, and the device never has to say it', () => {
    training.setPending({ scope: 'platform:facebook', device: 'laptop', base: 'b-v1' });
    expect(training.scopeOfRound('').key).toBe('platform:facebook');
    const r = training.startRound({ device: 'LAPTOP', turns: 30 });
    expect(r.scope.key).toBe('platform:facebook');
    expect(training.scopeOfRound(r.id).key).toBe('platform:facebook');
    /* Taken: the next round without a dispatch is base. */
    expect(training.peekPending()).toBe(null);
    expect(training.startRound({ device: 'x' }).scope.key).toBe('base');
  });

  it('one pending dispatch per machine: each round takes its own, whatever order they register in', () => {
    training.setPending({ scope: 'base', device: 'WojMagEmi', batch: 'b-9', share: 2, turns: 60 });
    training.setPending({ scope: 'base', device: 'Karolina', batch: 'b-9', share: 2, turns: 60 });
    expect(training.pendingList().length).toBe(2);
    const k = training.startRound({ device: 'KAROLINA', turns: 60 });
    expect(k.batch).toBe('b-9');
    expect(training.pendingList().map((p) => p.device)).toEqual(['WojMagEmi']);
    const w = training.startRound({ device: 'WOJMAGEMI', turns: 60 });
    expect(w.batch).toBe('b-9');
    expect(training.pendingList().length).toBe(0);
    /* A refusal clears the machine's entry. */
    training.setPending({ scope: 'base', device: 'Karolina', batch: 'b-10', share: 2 });
    training.clearPending('karolina');
    expect(training.pendingList().length).toBe(0);
  });
  it('a dispatch nobody picked up for three hours is not a scope for the next round', () => {
    training.setPending({ scope: 'role:facebook.scout', device: 'laptop' });
    expect(training.peekPending('', Date.now() + 4 * 3600 * 1000)).toBe(null);
  });
  it('promotion writes the scope into the map without touching the others, and base at the top level too', () => {
    const b = win();
    expect(training.promote(b.id)).toEqual({ promoted: b.id, scope: 'base' });
    expect(training.current().adapter).toBe(`a-${b.id}`);
    const fb = win({ scope: 'platform:facebook' });
    expect(training.promote(fb.id)).toEqual({ promoted: fb.id, scope: 'platform:facebook' });
    const cur = training.current();
    expect(cur.adapter).toBe(`a-${b.id}`);
    expect(cur.scopes.base.adapter).toBe(`a-${b.id}`);
    expect(cur.scopes['platform:facebook'].adapter).toBe(`a-${fb.id}`);
    /* The chain: a facebook role chains from the facebook adapter, a google one from base. */
    expect(training.adapterFor('role:facebook.scout')).toMatchObject({ adapter: `a-${fb.id}`, from: 'platform:facebook' });
    expect(training.adapterFor('role:research.reviews')).toMatchObject({ adapter: `a-${b.id}`, from: 'base' });
    expect(training.adapterFor('platform:google').from).toBe('base');
  });
  it('a batch is remembered on every member, and the merge is due once all are done and on the hub', () => {
    training.setPending({ scope: 'base', device: 'a', share: 2, turns: 60 });
    const a = training.startRound({ device: 'A', turns: 60 });
    expect(a.batch).toBe(a.id);
    training.setPending({ scope: 'base', device: 'b', batch: a.id, share: 2, turns: 60 });
    const b = training.startRound({ device: 'B', turns: 60 });
    expect(b.batch).toBe(a.id);
    expect(training.inBatch(a)).toBe(true);
    expect(training.batchReadyToMerge(a.id)).toBe(null);
    training.endRound(a.id, { baseline: { agreement_pct: 5, turns: 150 }, result: { agreement_pct: 9, turns: 150 }, adapter: 'pa', trained: 60 });
    training.endRound(b.id, { baseline: { agreement_pct: 5, turns: 150 }, result: { agreement_pct: 8, turns: 150 }, adapter: 'pb', trained: 60 });
    expect(training.batchReadyToMerge(a.id)).toBe(null);
    training.setAdapterHub(a.id, `hub:${a.id}`); training.setAdapterHub(b.id, `hub:${b.id}`);
    const members = training.batchReadyToMerge(b.id);
    expect(members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    /* Not twice: once a merge is pending on the batch, the batch is not ready again. */
    training.setPending({ scope: 'base', device: 'merger', base: `merge:hub:${a.id},hub:${b.id}`, merge: true, batch: a.id });
    expect(training.batchReadyToMerge(a.id)).toBe(null);
    training.dropPending('merger');
    /* A machine that shared a scope nobody joined is an ordinary round: no batch, no merge. */
    training.setPending({ scope: 'platform:google', device: 'c', share: 1 });
    const c = training.startRound({ device: 'C', turns: 100 });
    expect(c.batch).toBe('');
    expect(training.inBatch(c)).toBe(false);
  });

  it('REFUSES A WIN ON A PAPER OF FOUR TURNS', () => {
    const r = training.startRound({ device: 'l', scope: 'platform:seo' });
    training.endRound(r.id, { baseline: { agreement_pct: 0, turns: 4 }, result: { agreement_pct: 100, turns: 4 }, adapter: 'a' });
    expect(training.promote(r.id).error).toContain('4 turn');
  });
  it('carries the scope on the round rows and the device rows', () => {
    win({ scope: 'platform:google' });
    const st = training.state({ corpus: {}, manifest: null, trainers: [] });
    expect(st.rounds[0].scope.key).toBe('platform:google');
    expect(training.byDevice().laptop.scope.key).toBe('platform:google');
  });
});

/* ── the serving chain ──────────────────────────────────────────────────────────────────────── */

describe('who answers a step, and what it has earned', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-auto-')); process.env.PROFILE_DIR = dir; });
  afterEach(() => { delete process.env.PROFILE_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  const ledger = ({ seen = 0, agree = 0, steps = 0, fallbacks = 0, jobs = 0, gold = 0, silver = 0 } = {}) => ({
    seen, agree, driven: { steps, fallbacks, jobs: {} }, outcomes: { jobs, gold, silver, bronze: jobs - gold - silver, void: 0 },
  });

  it('a new model is a shadow until it has two hundred steps and agrees more than half the time', () => {
    expect(autopilot.stageOf(ledger({ seen: 50, agree: 50 })).stage).toBe('shadow');
    expect(autopilot.stageOf(ledger({ seen: 200, agree: 80 })).stage).toBe('shadow');
    expect(autopilot.stageOf(ledger({ seen: 200, agree: 120 })).stage).toBe('canary');
  });
  it('a canary becomes primary on thirty judged jobs with a good rate, and falls back when it stops being good', () => {
    expect(autopilot.stageOf(ledger({ seen: 300, agree: 200, steps: 100, fallbacks: 5, jobs: 30, gold: 20, silver: 2 })).stage).toBe('primary');
    expect(autopilot.stageOf(ledger({ seen: 300, agree: 200, steps: 100, fallbacks: 40, jobs: 30, gold: 25 })).stage).toBe('canary');
    expect(autopilot.stageOf(ledger({ seen: 300, agree: 200, steps: 100, fallbacks: 5, jobs: 30, gold: 5 })).stage).toBe('shadow');
  });
  it('picks the most specific model that has earned its stage, and shadows the one still learning', () => {
    const models = { base: 'gb-base', 'platform:facebook': 'gb-fb', 'role:facebook.scout': 'gb-scout' };
    const ledgers = { 'gb-base': ledger({ seen: 300, agree: 200, steps: 100, fallbacks: 5, jobs: 30, gold: 25 }), 'gb-fb': ledger({ seen: 250, agree: 160 }), 'gb-scout': ledger({ seen: 10 }) };
    const p = autopilot.pick({ role: 'facebook.scout', models, ledgers, settings: { autopilot: true } });
    expect(p.model).toBe('gb-fb');
    expect(p.mode).toBe('canary');
    expect(p.shadowModel).toBe('gb-scout');
    const g = autopilot.pick({ role: 'research.reviews', models, ledgers, settings: { autopilot: true } });
    expect(g.model).toBe('gb-base');
    expect(g.mode).toBe('primary');
  });
  it('is off when nothing is configured, and follows the hand when autopilot is off', () => {
    expect(autopilot.pick({ role: 'general', models: {}, ledgers: {}, settings: { autopilot: true } }).mode).toBe('off');
    const p = autopilot.pick({ role: 'facebook.scout', models: { base: 'gb-base' }, ledgers: {}, settings: { autopilot: false, studentMode: 'canary' } });
    expect(p).toMatchObject({ model: 'gb-base', mode: 'canary' });
    /* The single-model setting from before the map, still honoured. */
    expect(autopilot.pick({ role: 'general', models: {}, ledgers: {}, settings: { autopilot: true, studentModel: 'old' } }).model).toBe('old');
  });
  it('keeps one ledger per model, so three models serving at once never reset each other', () => {
    shadow.record({ teacher: { name: 'look', args: {} }, student: { name: 'look', args: {} }, agree: true, model: 'gb-base' });
    shadow.record({ teacher: { name: 'look', args: {} }, student: null, model: 'gb-fb' });
    shadow.record({ teacher: { name: 'open', args: {} }, student: { name: 'open', args: {} }, agree: true, model: 'gb-base' });
    expect(shadow.state('gb-base').seen).toBe(2);
    expect(shadow.state('gb-fb').seen).toBe(1);
    expect(shadow.state().models.length).toBe(2);
    shadow.drove({ jobId: 'j1', model: 'gb-base' });
    shadow.outcome({ model: 'gb-base', jobId: 'j1', tier: 'gold' });
    expect(shadow.state('gb-base').outcomes).toMatchObject({ jobs: 1, gold: 1, goodPct: 100 });
    expect(autopilot.stages({ models: { base: 'gb-base', 'platform:facebook': 'gb-fb' }, ledgers: shadow.all() }).map((s) => s.stage)).toEqual(['shadow', 'shadow']);
  });
});

/* ── the collector's role gaps ──────────────────────────────────────────────────────────────── */

describe('a role added this morning is a gap by noon', () => {
  it('lists the thin roles thinnest first, and marks the ones only real use can fill', () => {
    const rows = harvest.roleGapsFrom({
      perRole: { 'hacker-news-freelance-job-scout': { sighted: 29 }, 'facebook-thread-reply': { sighted: 14 }, 'research.reviews': { sighted: 989 } },
      roles: [
        { name: 'hacker-news-freelance-job-scout', platform: 'hackernews', description: 'Reads the Who is hiring thread and records freelance postings.' },
        { name: 'facebook-thread-reply', platform: 'facebook', description: 'Drafts one reply to a comment thread.' },
        { name: 'research.reviews', platform: 'google', description: 'Reads reviews.' },
        { name: 'brand-new-scout', platform: 'web', description: 'Finds public tenders and records them.' },
      ],
      floor: 120,
    });
    expect(rows.map((r) => r.role)).toEqual(['brand-new-scout', 'facebook-thread-reply', 'hacker-news-freelance-job-scout']);
    expect(rows.find((r) => r.role === 'facebook-thread-reply').needsRealUse).toBe(true);
    expect(rows.find((r) => r.role === 'hacker-news-freelance-job-scout').needsRealUse).toBe(false);
  });
  it('puts the collectable specialists in the brief and reads the specialist back off each line', () => {
    const msgs = harvest.askFor({ gaps: [], roleGaps: [{ role: 'hn-scout', platform: 'hackernews', examples: 3, description: 'x', needsRealUse: false }, { role: 'fb-reply', examples: 0, needsRealUse: true }] });
    expect(msgs[1].content).toContain('hn-scout (3 examples)');
    expect(msgs[1].content).not.toContain('fb-reply');
    const { kept, roleOf } = harvest.vet(['[hn-scout] Find this week\'s Who is hiring thread on Hacker News and record the freelance-friendly postings with their links.', '[nobody] Read the Dutch weather warnings page and record the provinces on alert today.'], { roles: new Set(['hn-scout']) });
    expect(kept.length).toBe(2);
    expect(roleOf[kept[0]]).toBe('hn-scout');
    expect(roleOf[kept[1]]).toBe(undefined);
  });
});

/* ── the platform map ───────────────────────────────────────────────────────────────────────── */

describe('the platform map is a reading of the set', () => {
  it('folds ids out of addresses and names what was pressed', () => {
    expect(platformMap.pagePattern('https://www.facebook.com/groups/123456/posts/98765?x=1')).toBe('facebook.com/groups/*/posts/*');
    const map = platformMap.build.length ? null : null;
    void map;
    const rows = [line('click', 'facebook.scout', 'facebook', 1), line('click', 'facebook.scout', 'facebook', 2), line('open', 'research.reviews', 'google', 3)];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-pmap-'));
    const file = path.join(dir, 'train.jsonl');
    fs.writeFileSync(file, rows.join(EOL));
    const m = platformMap.build(file);
    expect(m.platforms.facebook.turns).toBe(2);
    const text = platformMap.textOf(m, 'facebook');
    expect(text).toContain('PLATFORM NOTES (facebook');
    expect(text).toContain('facebook.com/groups/*/posts/*');
    expect(text).toContain('Join group ×2');
    expect(platformMap.textOf(m, 'nowhere')).toBe('');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});


/* ── a void run gives its judged-good steps, and nothing else ──────────────────────────────── */
import { build as buildSet } from '../src/traceset.js';
describe('a void run contributes exactly the steps somebody judged good', () => {
  const voidJob = (id, judged) => ({
    id, goal: 'find three yoga studios in Rotterdam and record them', role: 'general', status: 'stopped', createdAt: '2026-09-24T10:00:00Z',
    steps: [
      { n: 1, kind: 'goal', text: 'find three yoga studios' },
      { n: 2, kind: 'tool', tool: 'open', args: { url: 'https://example.com/yoga' }, text: 'open', ...(judged[0] ? { judged: { verdict: judged[0] } } : {}) },
      { n: 3, kind: 'read', text: 'read the page', content: 'Yoga studios in Rotterdam: A, B, C', url: 'https://example.com/yoga' },
      { n: 4, kind: 'tool', tool: 'note', args: { text: 'A, B, C' }, text: 'note', ...(judged[1] ? { judged: { verdict: judged[1] } } : {}) },
      { n: 5, kind: 'read', text: 'read again', content: 'more', url: 'https://example.com/yoga' },
      { n: 6, kind: 'tool', tool: 'finish', args: {}, text: 'finish', ...(judged[2] ? { judged: { verdict: judged[2] } } : {}) },
    ],
    /* stopped by the owner, no report: void */
  });
  it('keeps the judged-good steps of a void run in training, never in the paper, and drops the rest', () => {
    const out = buildSet([voidJob('v1', ['good', 'wrong', null]), voidJob('v2', [null, null, null])], {}, { evalFraction: 0.5 });
    expect(out.manifest.recovered.jobs).toBe(1);
    expect(out.manifest.recovered.turns).toBe(1);
    expect(out.train.filter((t) => t.jobId === 'v1').map((t) => t.action.tool)).toEqual(['open']);
    expect(out.train.find((t) => t.jobId === 'v1').grade).toBe('judged');
    expect(out.eval.some((t) => t.jobId === 'v1')).toBe(false);
    expect(out.train.some((t) => t.jobId === 'v2')).toBe(false);
    expect(out.manifest.droppedTurns['a step in a void run nobody judged good']).toBe(2);
  });
});

describe('the merge round and its batch', () => {
  it('carries the batch id, points the shares at itself, and is listed for retry only until it starts', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-merge-'));
    const prev = process.env.PROFILE_DIR; process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    const training = require('../src/training');
    try {
      training.setPending({ scope: 'base', device: 'A', batch: 'b-1', share: 2, turns: 60 });
      const a = training.startRound({ device: 'A', turns: 60 });
      training.setPending({ scope: 'base', device: 'B', batch: 'b-1', share: 2, turns: 60 });
      const b = training.startRound({ device: 'B', turns: 60 });
      for (const r of [a, b]) { training.endRound(r.id, { status: 'done', result: 10, baseline: 5 }); training.setAdapterHub(r.id, `hub:${r.id}`); }
      expect(training.batchesAwaitingMerge()).toHaveLength(1);
      expect([a.id, b.id]).toContain(training.batchesAwaitingMerge()[0]);
      const members = training.batchReadyToMerge(a.id);
      expect(members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
      training.setPending({ scope: 'base', device: 'A', base: `merge:hub:${a.id},hub:${b.id}`, merge: true, batch: 'b-1' });
      expect(training.batchesAwaitingMerge()).toEqual([]);
      expect(training.batchReadyToMerge(a.id)).toBeNull();
      const m = training.startRound({ device: 'A', base: `merge:hub:${a.id},hub:${b.id}` });
      expect(m.merge).toBe(true);
      expect(m.batch).toBe('b-1');
      const rows = training.allRounds();
      expect(rows.find((r) => r.id === a.id).mergedInto).toBe(m.id);
      expect(rows.find((r) => r.id === b.id).mergedInto).toBe(m.id);
      expect(training.batchesAwaitingMerge()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = prev;
      delete require.cache[require.resolve('../src/training')];
    }
  });
});

describe('stopping a round', () => {
  it('marks it stopped, drops its pending share, and a late end call cannot revive it', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-stop-'));
    const prev = process.env.PROFILE_DIR; process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    const training = require('../src/training');
    try {
      training.setPending({ scope: 'base', device: 'A', batch: 'b-1', share: 2, turns: 60 });
      const a = training.startRound({ device: 'A', turns: 60 });
      training.setPending({ scope: 'base', device: 'B', batch: 'b-1', share: 2, turns: 60 });
      expect(training.pendingList().map((p) => p.device)).toEqual(['B']);
      const s = training.stopRound(a.id, 'stopped by the owner');
      expect(s.status).toBe('stopped');
      expect(s.why).toBe('stopped by the owner');
      /* The machine's late end call: the adapter is kept, the status is not. */
      const e = training.endRound(a.id, { status: 'done', result: { agreement_pct: 9, turns: 150 }, baseline: { agreement_pct: 5, turns: 150 }, adapter: 'ckpt-1', trained: 20 });
      expect(e.status).toBe('stopped');
      expect(e.adapter).toBe('ckpt-1');
      expect(e.result).toBe(null);
      expect(training.stopRound(a.id).status).toBe('stopped');
      /* Only the stopped machine's share is dropped. */
      training.setPending({ scope: 'base', device: 'A', batch: 'b-1', share: 2, turns: 60 });
      training.dropPending('a');
      expect(training.pendingList().map((p) => p.device)).toEqual(['B']);
      expect(training.stopRound('r-nope')).toBe(null);
    } finally {
      if (prev === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = prev;
      delete require.cache[require.resolve('../src/training')];
    }
  });
  it('a failed merge is retried, and three failed merges free the scope', () => {
    const { decide, MERGE_TRIES } = require('../src/trainingPlan');
    const now = new Date().toISOString();
    const two = [{ name: 'KAROLINA', online: true }, { name: 'WOJMAGEMI', online: true }];
    const s = [{ key: 'base', level: 'base', name: '', sighted: 2000, seen: 0, adapter: '', paper: 150 }];
    const corpus = { usableSinceLastRound: 0, scanning: false };
    const members = [
      { id: 'r-a', status: 'done', device: 'WOJMAGEMI', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 2, adapterHub: 'hub:r-a', mergedInto: 'r-m1' },
      { id: 'r-b', status: 'done', device: 'KAROLINA', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 2, adapterHub: 'hub:r-b', mergedInto: 'r-m1' },
    ];
    const dead = (i) => ({ id: `r-m${i}`, status: 'failed', device: 'WOJMAGEMI', startedAt: now, lastAt: now, endedAt: now, scope: { key: 'base' }, batch: 'r-a', share: 1, merge: true, why: 'died' });
    const one = decide({ corpus, dataset: { train: 12000 }, rounds: members.concat([dead(1)]), trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2 });
    expect(one.run).toBe(false);
    const three = decide({ corpus, dataset: { train: 12000 }, rounds: members.concat([1, 2, 3].map(dead)), trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2 });
    expect(MERGE_TRIES).toBe(3);
    expect(three.run).toBe(true);
  });
});

describe('one measurer per start', () => {
  it('the first machine to ask claims the baseline, the second is told who has it, the number spends the claim', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-claim-'));
    const prev = process.env.PROFILE_DIR; process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    const training = require('../src/training');
    try {
      const q = { scope: 'base', base: '', paper: '2026-09-25T04:00:00Z', turns: 150 };
      const a = training.claimBaseline(q, 'WojMagEmi');
      expect(a.mine).toBe(true);
      expect(a.device).toBe('WojMagEmi');
      const b = training.claimBaseline(q, 'Karolina');
      expect(b.mine).toBe(false);
      expect(b.device).toBe('WojMagEmi');
      /* The claimant asking again is still the one. A caller without a name measures. */
      expect(training.claimBaseline(q, 'wojmagemi').mine).toBe(true);
      expect(training.claimBaseline(q, '').mine).toBe(true);
      /* A claim older than three hours is dead: the next asker takes it over. */
      const later = Date.now() + training.CLAIM_MS + 1000;
      expect(training.claimBaseline(q, 'Karolina', later)).toMatchObject({ mine: true, device: 'Karolina' });
      /* The number arrives: the claim is spent, the next asker is simply told the number. */
      training.rememberBaseline(q, { agreement_pct: 5.6, turns: 150 });
      expect(training.baselineFor(q).agreement_pct).toBe(5.6);
      const all = JSON.parse(fs.readFileSync(path.join(dir, 'training', 'baselines.json'), 'utf8'));
      expect(Object.keys(all._claims || {})).toEqual([]);
      /* Another paper is another claim. */
      expect(training.claimBaseline({ ...q, paper: 'other' }, 'Karolina').mine).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = prev;
      delete require.cache[require.resolve('../src/training')];
    }
  });
});

describe('a collapsed share is left out of the average', () => {
  const setup = () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-collapse-'));
    const prev = process.env.PROFILE_DIR; process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    const training = require('../src/training');
    const done = (r, ratio) => {
      training.endRound(r.id, { baseline: { agreement_pct: 5, turns: 150 }, result: { agreement_pct: 8, turns: 150, collapse: { tool: 'look', said_pct: 40, correct_pct: 10, ratio } }, adapter: 'x', trained: 60 });
      training.setAdapterHub(r.id, `hub:${r.id}`);
    };
    training.setPending({ scope: 'base', device: 'A', batch: 'b-1', share: 2, turns: 60 });
    const a = training.startRound({ device: 'A', turns: 60 });
    training.setPending({ scope: 'base', device: 'B', batch: 'b-1', share: 2, turns: 60 });
    const b = training.startRound({ device: 'B', turns: 60 });
    const restore = () => { if (prev === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = prev; delete require.cache[require.resolve('../src/training')]; };
    return { training, a, b, done, restore };
  };
  it('merges the sound share alone when the other collapsed', () => {
    const { training, a, b, done, restore } = setup();
    try {
      done(a, 1.2); done(b, 3.6);
      const members = training.batchReadyToMerge(a.id);
      expect(members.map((m) => m.id)).toEqual([a.id]);
      const rows = training.allRounds();
      expect(rows.find((r) => r.id === b.id).mergedInto).toBe('left out');
      training.setPending({ scope: 'base', device: 'A', base: `merge:hub:${a.id}`, merge: true, batch: 'b-1' });
      const m = training.startRound({ device: 'A', base: `merge:hub:${a.id}` });
      const after = training.allRounds();
      expect(after.find((r) => r.id === a.id).mergedInto).toBe(m.id);
      expect(after.find((r) => r.id === b.id).mergedInto).toBe('left out');
    } finally { restore(); }
  });
  it('abandons a batch whose every share collapsed, and the planner opens the scope again', () => {
    const { training, a, b, done, restore } = setup();
    try {
      done(a, 2.5); done(b, 3.6);
      expect(training.batchReadyToMerge(a.id)).toBe(null);
      const rows = training.allRounds();
      expect(rows.find((r) => r.id === a.id).mergedInto).toBe('abandoned');
      expect(rows.find((r) => r.id === b.id).mergedInto).toBe('abandoned');
      expect(training.batchesAwaitingMerge()).toEqual([]);
      expect(training.batchReadyToMerge(a.id)).toBe(null);
      const { decide } = require('../src/trainingPlan');
      const two = [{ name: 'A', online: true }, { name: 'B', online: true }];
      const s = [{ key: 'base', level: 'base', name: '', sighted: 2000, seen: 0, adapter: '', paper: 150 }];
      const d = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: rows, trainers: two, auto: true, serving: null, scopes: s, sliceTurns: 120, share: 2 });
      expect(d.run).toBe(true);
    } finally { restore(); }
  });
});

describe('learned, not trained on', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  let dir, file;
  const EOL = '\n';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-learned-'));
    process.env.PROFILE_DIR = dir;
    fs.mkdirSync(path.join(dir, 'traceset'), { recursive: true });
    file = path.join(dir, 'traceset', 'train.jsonl');
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(JSON.stringify({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' + i }, { role: 'assistant', content: JSON.stringify({ tool: i % 2 ? 'open' : 'click', args: {} }) }], meta: { jobId: `j-${Math.floor(i / 4)}`, at: i % 4, tier: 'gold', role: 'general', platform: 'web', sighted: true } }));
    fs.writeFileSync(file, rows.join(EOL));
    delete require.cache[require.resolve('../src/learned')];
    delete require.cache[require.resolve('../src/slice')];
    delete require.cache[require.resolve('../src/training')];
  });
  afterEach(() => { delete process.env.PROFILE_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it('identifies a turn by its job and step, so the identity survives a rebuild', () => {
    const learned = require('../src/learned');
    const a = JSON.stringify({ messages: [], meta: { jobId: 'j-1', at: 3 } });
    const b = JSON.stringify({ messages: [{ role: 'user', content: 'rebuilt differently' }], meta: { jobId: 'j-1', at: 3 } });
    expect(learned.idOf(a)).toBe('j-1#3');
    expect(learned.idOf(b)).toBe('j-1#3');
    expect(learned.idOf('{"x":1}')).toMatch(/^h:/);
  });

  it('nothing is learned until a round is promoted; then its drawn turns are, and the draw skips them in the next build', () => {
    const learned = require('../src/learned');
    const slice = require('../src/slice');
    const training = require('../src/training');
    expect(learned.count('base')).toBe(0);
    /* A share fetches before it registers: marked `<batch>@<device>` for base. */
    training.setPending({ scope: 'base', device: 'WojMagEmi', batch: 'b-1', share: 2, turns: 10 });
    const d1 = slice.draw({ file, builtAt: 'build-1', want: 10, roundId: 'b-1@WojMagEmi', scope: 'base' });
    expect(d1.count).toBe(10);
    const a = training.startRound({ device: 'WojMagEmi', turns: 10 });
    training.setPending({ scope: 'base', device: 'Karolina', batch: 'b-1', share: 2, turns: 10 });
    const d2 = slice.draw({ file, builtAt: 'build-1', want: 10, roundId: 'b-1@Karolina', scope: 'base' });
    const b = training.startRound({ device: 'Karolina', turns: 10 });
    for (const r of [a, b]) {
      training.endRound(r.id, { baseline: { agreement_pct: 5, turns: 150 }, result: { agreement_pct: 8, turns: 150 }, adapter: 'x', trained: 10 });
      training.setAdapterHub(r.id, `hub:${r.id}`);
    }
    /* Trained, not learned: the state says 0 learned and 20 attempted. */
    expect(training.state().covered).toBe(0);
    expect(training.state().attempted).toBe(20);
    /* The merge is promoted: both shares' turns are learned. */
    training.batchReadyToMerge(a.id);
    training.setPending({ scope: 'base', device: 'WojMagEmi', base: `merge:hub:${a.id},hub:${b.id}`, merge: true, batch: 'b-1' });
    const m = training.startRound({ device: 'WojMagEmi', base: `merge:hub:${a.id},hub:${b.id}` });
    training.endRound(m.id, { baseline: { agreement_pct: 5, turns: 150 }, result: { agreement_pct: 9, turns: 150 }, adapter: 'hub:merged', trained: 0 });
    const p = training.promote(m.id);
    expect(p.error).toBeUndefined();
    expect(learned.count('base')).toBe(20);
    expect(training.state().covered).toBe(20);
    expect(training.allRounds().find((r) => r.id === m.id).learned).toMatchObject({ added: 20, matched: 20 });
    /* A rebuilt set (new builtAt, fresh slice ledger): the learned turns are not drawn again. */
    const d3 = slice.draw({ file, builtAt: 'build-2', want: 100, roundId: 'r-next', scope: 'base' });
    expect(d3.count).toBe(20);
    const drawn = new Set(d3.jsonl.split(EOL).map((l) => learned.idOf(l)));
    for (const l of (d1.jsonl + EOL + d2.jsonl).split(EOL)) expect(drawn.has(learned.idOf(l))).toBe(false);
    /* Another scope has learned nothing from it. */
    expect(learned.count('platform:google')).toBe(0);
  });

  it('a round that failed the gates leaves nothing learned', () => {
    const learned = require('../src/learned');
    const slice = require('../src/slice');
    const training = require('../src/training');
    training.setPending({ scope: 'base', device: 'Solo', share: 1, turns: 10 });
    slice.draw({ file, builtAt: 'build-1', want: 10, roundId: 'single@Solo', scope: 'base' });
    const r = training.startRound({ device: 'Solo', turns: 10 });
    training.endRound(r.id, { baseline: { agreement_pct: 5, turns: 150 }, result: { agreement_pct: 4, turns: 150 }, adapter: 'x', trained: 10 });
    expect(training.promote(r.id).error).toMatch(/did not beat/);
    expect(learned.count('base')).toBe(0);
    expect(training.state().attempted).toBe(10);
  });

  it('the planner counts learned turns as covered, not attempted ones', () => {
    const { decide } = require('../src/trainingPlan');
    const now = new Date().toISOString();
    const rounds = [{ id: 'r-old', status: 'done', device: 'A', startedAt: now, lastAt: now, endedAt: now, trained: 870, result: { agreement_pct: 4 }, baseline: { agreement_pct: 5 } }];
    const d = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 1000 }, rounds, trainers: [{ name: 'A', online: true }], auto: true, serving: null, learned: 0 });
    expect(d.run).toBe(true);
    expect(d.coverage).toEqual({ seen: 0, total: 1000 });
    expect(d.why).toMatch(/1000 of 1000/);
  });
});

describe('continue from a sound adapter, and the bar stays what serves', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  let dir, training;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-warm-'));
    process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    training = require('../src/training');
  });
  afterEach(() => { delete process.env.PROFILE_DIR; delete require.cache[require.resolve('../src/training')]; fs.rmSync(dir, { recursive: true, force: true }); });
  const finish = (r, { before, after, ratio = 1.0, paper = 'P1' }) => {
    training.endRound(r.id, { baseline: { agreement_pct: before, turns: 150 }, result: { agreement_pct: after, turns: 150, collapse: { tool: 'look', ratio } }, adapter: '/x', trained: 20, paper });
    training.setAdapterHub(r.id, `hub:${r.id}`);
  };
  it('picks the newest sound unpromoted adapter: not a collapsed one, not one below its start, not a share', () => {
    const bad = training.startRound({ device: 'A', turns: 20 }); finish(bad, { before: 7, after: 9, ratio: 3.5 });
    const worse = training.startRound({ device: 'A', turns: 20 }); finish(worse, { before: 7, after: 5 });
    const ok = training.startRound({ device: 'A', turns: 20 }); finish(ok, { before: 7, after: 7 });
    training.setPending({ scope: 'base', device: 'B', batch: 'b-9', share: 2, turns: 20 });
    const share = training.startRound({ device: 'B', turns: 20 }); finish(share, { before: 7, after: 12 });
    expect(training.warmStartFor('base')).toMatchObject({ adapter: `hub:${ok.id}`, roundId: ok.id });
    expect(training.warmStartFor('platform:google')).toBe(null);
  });
  it('a round that beat its warm start but not the bare model on the same paper is refused; one that beat both is promoted', () => {
    training.rememberBaseline({ scope: 'base', base: '', paper: 'P1', turns: 150 }, { agreement_pct: 9, turns: 150 });
    const warm = training.startRound({ device: 'A', turns: 20, base: 'hub:r-warm' }); finish(warm, { before: 6, after: 8 });
    expect(training.promote(warm.id).error).toMatch(/not what serves: 8% against 9%/);
    const good = training.startRound({ device: 'A', turns: 20, base: 'hub:r-warm' }); finish(good, { before: 6, after: 11 });
    expect(training.promote(good.id).error).toBeUndefined();
    /* Another paper: no number for the bare model, the start comparison is all there is. */
    const other = training.startRound({ device: 'A', turns: 20, base: 'hub:r-warm' }); finish(other, { before: 6, after: 8, paper: 'P2' });
    expect(training.servingBar(training.allRounds().find((r) => r.id === other.id))).toBe(null);
  });
  it('a trial never takes the slot of a promoted model', () => {
    const p = training.startRound({ device: 'A', turns: 20 }); finish(p, { before: 5, after: 12 });
    expect(training.promote(p.id).error).toBeUndefined();
    const models = [{ tag: 'gb-base-promoted', roundId: p.id }, { tag: 'gb-base-old', roundId: 'r-gone' }];
    expect(training.slotFree('base', 'gb-base-promoted', models)).toBe(false);
    expect(training.slotFree('base', 'gb-base-old', models)).toBe(true);
    expect(training.slotFree('base', '', models)).toBe(true);
    const t = training.startRound({ device: 'A', turns: 20 }); finish(t, { before: 5, after: 4 });
    expect(training.markTrial(t.id, 'gb-base-trial').trial).toBe('gb-base-trial');
    expect(training.state().rounds.find((r) => r.id === t.id).trial).toBe('gb-base-trial');
  });
  it('the planner starts a scope from its sound adapter when nothing is promoted', () => {
    const { decide } = require('../src/trainingPlan');
    const s = [{ key: 'base', level: 'base', name: '', sighted: 2000, seen: 0, adapter: '', warmStart: 'hub:r-ok', paper: 150 }];
    const d = decide({ corpus: { usableSinceLastRound: 0, scanning: false }, dataset: { train: 12000 }, rounds: [], trainers: [{ name: 'A', online: true }], auto: true, serving: null, scopes: s, sliceTurns: 40, share: 1 });
    expect(d.run).toBe(true);
    expect(d.base).toBe('hub:r-ok');
  });
});

describe('a discarded round', () => {
  it('is never a warm start', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-discard-'));
    const prev = process.env.PROFILE_DIR; process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    const training = require('../src/training');
    try {
      const r = training.startRound({ device: 'A', turns: 20 });
      training.endRound(r.id, { baseline: { agreement_pct: 7, turns: 150 }, result: { agreement_pct: 8, turns: 150 }, adapter: '/x', trained: 20, paper: 'P' });
      training.setAdapterHub(r.id, `hub:${r.id}`);
      expect(training.warmStartFor('base')).toMatchObject({ roundId: r.id });
      expect(training.discardRound(r.id).discarded).toBe(true);
      expect(training.warmStartFor('base')).toBe(null);
      expect(training.state().rounds.find((x) => x.id === r.id).discarded).toBe(true);
      expect(training.discardRound('r-nope')).toBe(null);
    } finally {
      if (prev === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = prev;
      delete require.cache[require.resolve('../src/training')];
    }
  });
});

describe('refused is discarded', () => {
  it('a round refused at the gates is marked discarded and is no warm start', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-refused-'));
    const prev = process.env.PROFILE_DIR; process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    const training = require('../src/training');
    try {
      const r = training.startRound({ device: 'A', turns: 20 });
      training.endRound(r.id, { baseline: { agreement_pct: 7.33, turns: 150 }, result: { agreement_pct: 4, turns: 150 }, adapter: '/x', trained: 48, paper: 'P' });
      training.setAdapterHub(r.id, `hub:${r.id}`);
      const p = training.promote(r.id);
      expect(p.error).toMatch(/did not beat/);
      /* What the end handler does with a refusal: */
      training.discardRound(r.id);
      expect(training.warmStartFor('base')).toBe(null);
      expect(training.state().rounds.find((x) => x.id === r.id).discarded).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = prev;
      delete require.cache[require.resolve('../src/training')];
    }
  });
});

describe('a batch with a dead share', () => {
  it('merges the shares that made it, and abandons a batch where none did', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-dead-'));
    const prev = process.env.PROFILE_DIR; process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    const training = require('../src/training');
    try {
      training.setPending({ scope: 'base', device: 'A', batch: 'b-1', share: 2, turns: 60 });
      const a = training.startRound({ device: 'A', turns: 60 });
      training.setPending({ scope: 'base', device: 'B', batch: 'b-1', share: 2, turns: 60 });
      const b = training.startRound({ device: 'B', turns: 60 });
      training.endRound(a.id, { baseline: { agreement_pct: 7, turns: 150 }, result: { agreement_pct: 5, turns: 150 }, adapter: '/x', trained: 48 });
      training.setAdapterHub(a.id, `hub:${a.id}`);
      /* B still running: nothing yet. */
      expect(training.batchReadyToMerge(a.id)).toBe(null);
      expect(training.batchesAwaitingMerge()).toEqual([]);
      /* B dies on a full disk: the merge is of A alone. */
      training.endRound(b.id, { status: 'failed', why: 'the trainer process died' });
      expect(training.batchesAwaitingMerge()).toHaveLength(1);
      const members = training.batchReadyToMerge(a.id);
      expect(members.map((m) => m.id)).toEqual([a.id]);
      expect(training.allRounds().find((r) => r.id === b.id).mergedInto).toBe('left out');
      /* A batch where every share died is abandoned. */
      training.setPending({ scope: 'base', device: 'A', batch: 'b-2', share: 2, turns: 60 });
      const c = training.startRound({ device: 'A', turns: 60 });
      training.setPending({ scope: 'base', device: 'B', batch: 'b-2', share: 2, turns: 60 });
      const d = training.startRound({ device: 'B', turns: 60 });
      training.endRound(c.id, { status: 'failed', why: 'died' });
      training.stopRound(d.id);
      expect(training.batchReadyToMerge(c.id)).toBe(null);
      expect(training.allRounds().find((r) => r.id === c.id).mergedInto).toBe('abandoned');
      expect(training.batchesAwaitingMerge()).toHaveLength(1);   // b-1 still awaits its merge
    } finally {
      if (prev === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = prev;
      delete require.cache[require.resolve('../src/training')];
    }
  });
});
