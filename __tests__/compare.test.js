import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

/*
 * The side-by-side view is the thing that told us WHERE a model fails, which no percentage ever
 * did. Two halves: a recorded job replayed against a model, and a typed prompt worked live by the
 * teacher with the model answering beside it. The live half reads the shadow's own record, so the
 * shape of that reading is what must not drift.
 */
describe('side by side', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const lift = (name, deps = {}) => {
    const at = src.indexOf(`function ${name}(`);
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', at) + 2;
    const keys = Object.keys(deps);
    // eslint-disable-next-line no-new-func
    return new Function(...keys, `${src.slice(at, end)}; return ${name};`)(...keys.map((k) => deps[k]));
  };

  it('reads a live step out of the shadow as two actions and a verdict', () => {
    const shadow = { load: () => ({ recent: [
      { jobId: 'j-1', step: 2, teacher: 'open {"url":"https://maps.google.com"}', student: 'read {}', agree: false },
      { jobId: 'j-1', step: 1, teacher: 'look {}', student: 'look {}', agree: true },
      { jobId: 'j-other', step: 1, teacher: 'read {}', student: 'read {}', agree: true },
    ] }) };
    const liveSteps = lift('liveSteps', { shadow });
    const steps = liveSteps({ model: 'gb-base', jobId: 'j-1' });
    /* Only this job, and in the order the job took them. */
    expect(steps.map((s) => s.n)).toEqual([1, 2]);
    expect(steps[1].teacherTool).toBe('open');
    expect(steps[1].teacherArgs).toContain('maps.google.com');
    expect(steps[1].modelTool).toBe('read');
    expect(steps[1].same).toBe(false);
    expect(steps[0].same).toBe(true);
  });

  it('an unusable answer is shown as one, not as a tool called nothing', () => {
    const shadow = { load: () => ({ recent: [
      { jobId: 'j-2', step: 1, teacher: 'finish {"summary":"..."}', student: '(nothing usable)', agree: false },
    ] }) };
    const liveSteps = lift('liveSteps', { shadow });
    const s = liveSteps({ model: 'gb-base', jobId: 'j-2' })[0];
    expect(s.modelTool).toBe('');
    expect(s.raw).toBe('(nothing usable)');
    expect(s.same).toBe(false);
  });

  it('a model the shadow will not ask is refused with the ones it will', () => {
    /* The live route states its precondition rather than comparing nothing. */
    expect(src).toContain('the shadow asks the serving model');
    expect(src).toContain('set it as the served model for its scope first');
  });

  it('the recorded walk is teacher-forced and keeps what the model actually said', () => {
    const walk = src.slice(src.indexOf('async function walkComparison'), src.indexOf('async function walkComparison') + 2600);
    /* The assistant turn is removed before asking: the model must not be shown the answer. */
    expect(walk).toMatch(/filter\(\(m\) => m\.role !== 'assistant'\)/);
    expect(walk).toContain('teacherTool');
    expect(walk).toContain('modelTool');
    /* An unparseable answer is kept verbatim - that is how we found the truncated `finish`. */
    expect(walk).toMatch(/raw: mine \? '' : said/);
  });

  it('the jobs offered are the longest trails, because a long one shows more', () => {
    const fn = src.slice(src.indexOf('function comparableJobs'), src.indexOf('function comparableJobs') + 1800);
    expect(fn).toMatch(/sort\(\(a, b\) => b\.turns - a\.turns\)/);
    expect(fn).toContain('goal');
  });
});
