/*
 * THE TEACHER'S JUDGEMENTS, AND THE WAYS THEY COULD DO HARM: a judgement landing on the wrong
 * step, a run asked about twice, the teacher outranking the record or a person.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import judge from '../src/judge.js';
import traceset from '../src/traceset.js';

const step = (kind, text, extra = {}) => ({ kind, text, at: 'x', ...extra });
const job = () => ({ id: 'j-judge', goal: 'Find the cheapest bakfiets', role: 'general', status: 'done', report: 'Found one at 250.', verdict: { tier: 'silver' }, steps: [
  step('you', 'Find the cheapest bakfiets'),
  step('tool', 'open()', { tool: 'open', args: { url: 'https://m.nl' } }), step('open', 'https://m.nl'),
  step('tool', 'read()', { tool: 'read', args: {} }), step('read', 'read the page (900 characters)', { content: 'You are on: https://m.nl\n\nPage text:\nBakfiets 250' }),
  step('tool', 'look()', { tool: 'look', args: {} }), step('look', 'M — 3 things to click', { marks: '[1] a\n[2] b\n[3] c' }),
  step('tool', 'finish()', { tool: 'finish', args: { summary: 'Found one at 250.' } }), step('done', 'done'),
] });

describe('the question and the answer', () => {
  it('numbers the tool steps and shows what each saw', () => {
    const t = judge.trail(job());
    expect(t.map((s) => `${s.n}:${s.tool}`)).toEqual(['1:open', '2:read', '3:look', '4:finish']);
    expect(t[1].seen[0]).toMatch(/^read: read the page/);
    const p = judge.promptFor(job());
    expect(p[1].content).toContain('GOAL: Find the cheapest bakfiets');
    expect(p[1].content).toContain('4. finish(');
  });

  it('reads the array out of prose and drops nonsense', () => {
    const out = judge.parse('Sure:\n[{"n":1,"verdict":"good","why":"right site","reason":"I open the listing site the goal names."},{"n":2,"verdict":"wrong","why":"read twice"},{"n":"x","verdict":"good"},{"n":3,"verdict":"meh"}]\nDone.');
    expect(out.map((o) => [o.n, o.verdict])).toEqual([[1, 'good'], [2, 'wrong'], [3, 'unclear']]);
    expect(judge.parse('no json here')).toEqual([]);
  });

  it('writes each judgement on its own step, by number', () => {
    const j = job();
    const r = judge.apply(j, judge.parse('[{"n":2,"verdict":"wrong","why":"read before looking"},{"n":4,"verdict":"good","why":"","reason":"I have the price, so I report it."}]'), { model: 'glm' });
    expect(r).toEqual({ landed: 2, wrong: 1, asked: 4 });
    expect(j.steps[3].judged.verdict).toBe('wrong');
    expect(j.steps[7].judged.reason).toMatch(/report it/);
    expect(j.steps[1].judged).toBeUndefined();
  });
});

describe('who outranks whom in the set', () => {
  it('a person beats the record, the record beats the teacher', () => {
    const j = job();
    /* The record refuses step 1... */
    j.steps.splice(2, 0, step('blocked', 'open refused: not a real link'));
    /* ...the teacher calls step 2 (read) wrong, and a person calls step 1 good. */
    j.steps[4].judged = { verdict: 'wrong', why: 'x' };
    j.steps[1].human = { verdict: 'good', at: 'x' };
    const turns = traceset.turnsOf(j);
    expect(turns.map((t) => `${t.action.tool}:${t.step}`)).toEqual(['open:good', 'read:wrong', 'look:unknown', 'finish:unknown']);
    expect(turns[1].stepWhy).toMatch(/teacher/);
    expect(turns[0].stepWhy).toMatch(/person/);
  });

  it('carries the teacher\'s reason on a good step', () => {
    const j = job();
    j.steps[7].judged = { verdict: 'good', reason: 'I have the price, so I report it.' };
    const t = traceset.turnsOf(j).find((x) => x.action.tool === 'finish');
    expect(t.step).toBe('good');
    expect(t.reason).toBe('I have the price, so I report it.');
  });
});

describe('the loop\'s bookkeeping', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-judge-')); process.env.PROFILE_DIR = dir; });
  afterEach(() => { delete process.env.PROFILE_DIR; try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

  it('wants a sighted, usable, unjudged run and nothing else', () => {
    expect(judge.wants(job())).toBe(true);
    const blind = job(); delete blind.steps[4].content; expect(judge.wants(blind)).toBe(false);
    const done = job(); for (const s of done.steps) if (s.kind === 'tool') s.judged = { verdict: 'good' }; expect(judge.wants(done)).toBe(false);
    /* A void run is judged too: the set takes exactly its judged-good steps (traceset.js). */
    const v = job(); v.verdict = { tier: 'void' }; expect(judge.wants(v)).toBe(true);
    expect(judge.wants(job(), { 'j-judge': 'x' })).toBe(false);
  });

  it('scans the runs on disk gold first and keeps its tallies', () => {
    const jdir = path.join(dir, 'jobs'); fs.mkdirSync(jdir, { recursive: true });
    const g = job(); g.id = 'g'; g.verdict = { tier: 'gold' };
    const s = job(); s.id = 's';
    fs.writeFileSync(path.join(jdir, 'g.json'), JSON.stringify(g)); fs.writeFileSync(path.join(jdir, 's.json'), JSON.stringify(s));
    const r = judge.scan(jdir, { doneJobs: {} }, { from: 0, limit: 10 });
    expect(judge.order(r.found).map((e) => e.id)).toEqual(['g', 's']);
    judge.setOn(true);
    const st = judge.load(); st.runs = 2; st.wrong = 1; judge.save(st);
    expect(judge.state()).toMatchObject({ on: true, runs: 2, wrong: 1 });
  });
});
