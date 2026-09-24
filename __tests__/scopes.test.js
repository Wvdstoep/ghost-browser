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
    const r = training.startRound({ device: 'WOJMAGEMI', turns: 30 });
    expect(r.scope.key).toBe('platform:facebook');
    expect(training.scopeOfRound(r.id).key).toBe('platform:facebook');
    /* Taken: the next round without a dispatch is base. */
    expect(training.peekPending()).toBe(null);
    expect(training.startRound({ device: 'x' }).scope.key).toBe('base');
  });
  it('a dispatch nobody picked up for three hours is not a scope for the next round', () => {
    training.setPending({ scope: 'role:facebook.scout', device: 'laptop' });
    expect(training.peekPending(Date.now() + 4 * 3600 * 1000)).toBe(null);
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
