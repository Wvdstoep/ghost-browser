/*
 * HANDING OUT THE WORK, AND THE WAYS TWO MACHINES END UP DOING ONE MACHINE'S WORK.
 *
 * Every test here is a failure with no symptom. Both rounds report turns trained, both losses fall,
 * and the corpus is covered far more slowly than the arithmetic says:
 *
 *   - two devices draw overlapping slices, so the second laptop adds almost nothing;
 *   - a rebuilt set keeps the old marks, so line numbers now point at different rows and turns are
 *     skipped while being counted as covered;
 *   - one loud tool takes the whole slice, and the model never learns to stop working;
 *   - the set runs out and the loop starts over on turns the model has already seen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { draw, exam, progress, reset, toolOf, jobOf } from '../src/slice.js';

let dir, file;

/* Built rather than written: an escaped newline has been mangled by a patch four
   times now, and a literal newline inside a string literal is a parse error that
   looks nothing like its cause. */
const EOL = String.fromCharCode(10);

/* A set shaped like the real one: `open` and `read` dominate, `finish` is rare. */
const line = (tool, tier, n) => JSON.stringify({
  messages: [
    { role: 'system', content: 'You are Ghost Browser working as general.' },
    { role: 'user', content: `GOAL: thing ${n}` },
    { role: 'assistant', content: JSON.stringify({ tool, args: {} }) },
  ],
  meta: { jobId: `j-${n}`, tier, role: 'general' },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-slice-'));
  process.env.PROFILE_DIR = dir;
  file = path.join(dir, 'train.jsonl');
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(line('open', i < 100 ? 'gold' : 'silver', i));
  for (let i = 0; i < 150; i++) rows.push(line('read', 'gold', 1000 + i));
  for (let i = 0; i < 20; i++) rows.push(line('click', 'gold', 2000 + i));
  for (let i = 0; i < 4; i++) rows.push(line('finish', 'gold', 3000 + i));
  fs.writeFileSync(file, rows.join('\n'));
});
afterEach(() => {
  delete process.env.PROFILE_DIR;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
});

describe('the exam is a sample of the split, not the top of it', () => {
  /*
   * The scoring turns were the FIRST N rows of eval.jsonl. The split is cut by job, so the rows
   * arrive job by job and the first 150 are a few whole jobs. Measured on the real set of
   * 2026-09-23: 39.3% of the exam was `dig`, and `open` — 15% of what a round trains on — never
   * appeared. A round could correct its entire tool distribution and be marked on one tool.
   */
  const evalFile = () => {
    /* Ordered by job, the way the builder writes it: every `open` first, then every `read`. */
    const rows = [];
    for (let i = 0; i < 120; i++) rows.push(line('open', 'gold', i));
    for (let i = 0; i < 60; i++) rows.push(line('read', 'gold', 1000 + i));
    for (let i = 0; i < 30; i++) rows.push(line('look', 'gold', 2000 + i));
    for (let i = 0; i < 6; i++) rows.push(line('finish', 'gold', 3000 + i));
    const p = path.join(dir, 'eval.jsonl');
    fs.writeFileSync(p, rows.join(EOL));
    return p;
  };

  it('DOES NOT hand back one tool because it came first in the file', () => {
    const p = evalFile();
    const first = fs.readFileSync(p, 'utf8').split(EOL).slice(0, 40);
    expect(new Set(first.map(toolOf)).size).toBe(1);        // the defect: 40 rows, one tool
    const e = exam({ file: p, want: 40 });
    expect(Object.keys(e.tools).length).toBeGreaterThan(2); // the fix: the split's own variety
  });

  it('gives every tool in the split a place on the paper', () => {
    const e = exam({ file: evalFile(), want: 40 });
    for (const tl of ['open', 'read', 'look', 'finish']) expect(e.tools[tl]).toBeGreaterThan(0);
  });

  it('caps the loudest tool, so no single one can be most of the marks', () => {
    const e = exam({ file: evalFile(), want: 40 });
    const worst = Math.max(...Object.values(e.tools));
    expect(worst).toBeLessThanOrEqual(Math.max(4, Math.floor(40 * 0.15)));
  });

  it('is the SAME paper every time, or two rounds are not comparable', () => {
    const p = evalFile();
    expect(exam({ file: p, want: 40 }).jsonl).toBe(exam({ file: p, want: 40 }).jsonl);
  });

  it('asks for no more than exists', () => {
    const e = exam({ file: evalFile(), want: 5000 });
    expect(e.count).toBe(216);
  });

  it('survives an empty split without pretending it set a paper', () => {
    const p = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(p, '');
    expect(exam({ file: p, want: 40 }).count).toBe(0);
  });
});
describe('drawing a slice', () => {
  it('reads the tool off the raw line without parsing the whole set', () => {
    expect(toolOf(line('finish', 'gold', 1))).toBe('finish');
    expect(toolOf('not json')).toBe(null);
  });

  it('GIVES TWO ROUNDS DISJOINT WORK', () => {
    /* The failure with no symptom: two laptops sampling independently overlap, so the second one
       adds almost nothing while both report a full round. */
    const a = draw({ file, builtAt: 't1', want: 50, roundId: 'r-a' });
    const b = draw({ file, builtAt: 't1', want: 50, roundId: 'r-b' });
    expect(a.count).toBe(50);
    expect(b.count).toBe(50);
    const setA = new Set(a.jsonl.split('\n'));
    const overlap = b.jsonl.split('\n').filter((l) => setA.has(l));
    expect(overlap).toEqual([]);
  });

  it('does not let the loud tools take the whole slice', () => {
    /* `open` is 200 of 374 rows here, as in the real set. A slice that mirrors the raw distribution
       teaches a model that is excellent at opening pages and has seen `finish` almost never. */
    const s = draw({ file, builtAt: 't1', want: 40 });
    expect(s.tools.finish).toBe(4);
    expect(s.tools.click).toBeGreaterThan(5);
    /* No single tool may dominate a round-robin draw. */
    expect(s.tools.open).toBeLessThan(20);
  });

  it('prefers gold within a tool', () => {
    /* Gold means something outside the run's own report confirmed it. A budget should be spent on
       the best evidence available, not on whatever sat at the top of the file. */
    const s = draw({ file, builtAt: 't1', want: 30 });
    const golds = s.jsonl.split('\n').filter((l) => l.includes('"tier":"gold"')).length;
    expect(golds).toBe(30);
  });

  it('tracks what is left, so coverage is counted rather than estimated', () => {
    draw({ file, builtAt: 't1', want: 100 });
    const p = progress('t1', 374);
    expect(p.handed).toBe(100);
    expect(draw({ file, builtAt: 't1', want: 100 }).remaining).toBe(174);
  });

  it('runs out rather than starting over on turns already seen', () => {
    let guard = 0;
    while (draw({ file, builtAt: 't1', want: 100 }).count > 0 && guard < 20) guard++;
    const s = draw({ file, builtAt: 't1', want: 100 });
    expect(s.count).toBe(0);
    expect(s.exhausted).toBe(true);
  });
});

describe('the shape of the slice — what cost round one', () => {
  it('KEEPS THE REAL DISTRIBUTION instead of flattening it', () => {
    /*
     * The first draw round-robinned: every tool got its first example before any got its second.
     * Across 66 tools and 685 turns that is ten each, so the model was taught that all 66 tools are
     * equally likely — and it collapsed onto `diagnostics`, scoring 0/15 on `read`, 0/11 on `look`,
     * 0/9 on `click` and 0/7 on `type` while overall agreement rose from 5% to 20% and looked like
     * a win. The prior is the most reliable signal in the set; flattening it throws that away.
     *
     * Here `open` is 200 of 374 rows and `finish` is 4. A correct slice has far more `open` than
     * `finish` — and still has some `finish`.
     */
    const s = draw({ file, builtAt: 't1', want: 120 });
    expect(s.tools.open).toBeGreaterThan(s.tools.click);
    expect(s.tools.read).toBeGreaterThan(s.tools.click);
    /* But not so much more that the rare ones vanish. */
    expect(s.tools.finish).toBeGreaterThanOrEqual(4);
    expect(s.tools.click).toBeGreaterThanOrEqual(4);
  });

  it('caps a dominant tool while alternatives still have stock', () => {
    /* `open` is 53% of the rows. Left alone it would be most of the round, which is the other
       failure: excellent at opening pages, never learns to stop working. */
    const s = draw({ file, builtAt: 't1', want: 200 });
    expect(s.tools.open / s.count).toBeLessThan(0.45);
    expect(s.tools.open).toBeGreaterThan(s.tools.finish);
  });

  it('gives every tool present at least a floor, even the rarest', () => {
    const s = draw({ file, builtAt: 't1', want: 60 });
    for (const [tool, n] of Object.entries(s.tools)) {
      expect(n, `${tool} got ${n}`).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('no single run may flood a slice', () => {
  /*
   * MEASURED, NOT FEARED. Across 1,226 usable runs holding 40,031 turns, the longest tenth supplied
   * 41% of the set and the longest quarter supplied 71%. Runs of five turns or fewer gave 595 turns
   * between them; runs of forty or more gave 28,210 — forty-seven times the weight from twice the
   * count.
   *
   * It is arithmetic, not merit: a sixty-step run yields sixty examples. And it points the wrong
   * way, because sixty steps for something achievable in five is the model struggling. Such a run is
   * gold on the strength of its ENDING while its middle is forty steps of confusion, so the set
   * over-samples the runs where the agent coped worst.
   */
  const NL = String.fromCharCode(10);
  const turn = (jobId, n) => JSON.stringify({
    messages: [
      { role: 'system', content: 'You are Ghost Browser working as general.' },
      { role: 'user', content: 'GOAL: thing ' + n },
      { role: 'assistant', content: JSON.stringify({ tool: 'read', args: {} }) },
    ],
    meta: { jobId, tier: 'gold', role: 'general' },
  });

  const withMarathon = (len) => {
    const rows = [];
    for (let i = 0; i < len; i++) rows.push(turn('j-marathon', i));
    for (let i = 0; i < 30; i++) rows.push(turn('j-short-' + i, i));
    fs.writeFileSync(file, rows.join(NL));
  };

  it('CAPS WHAT ONE RUN CAN CONTRIBUTE', () => {
    withMarathon(200);
    const s = draw({ file, builtAt: 'm1', want: 60, perRun: 12 });
    const jobs = s.jsonl.split(NL).map((l) => JSON.parse(l).meta.jobId);
    expect(jobs.filter((x) => x === 'j-marathon').length).toBeLessThanOrEqual(12);
    /* And the budget it did not take went to runs that had not been heard from. */
    expect(new Set(jobs).size).toBeGreaterThan(10);
  });

  it('leaves an ordinary run untouched', () => {
    /* The median run is twelve turns. The cap must cost the marathons their surplus and nothing
       else — a rule that trimmed normal runs would just be a smaller set. */
    withMarathon(4);
    const s = draw({ file, builtAt: 'm2', want: 40, perRun: 12 });
    const jobs = s.jsonl.split(NL).map((l) => JSON.parse(l).meta.jobId);
    expect(jobs.filter((x) => x === 'j-marathon').length).toBe(4);
  });

  it('reads the run off the line without parsing the whole set', () => {
    expect(jobOf('{"meta":{"jobId":"j-abc","tier":"gold"}}')).toBe('j-abc');
    expect(jobOf('no job here')).toBe('');
  });
});

describe('the runs worth copying come first', () => {
  /*
   * MEASURED: 693 clean runs supplied 10,468 turns and 537 messy ones supplied 29,627. Clean runs
   * are 56% of the runs and 26% of the data, because a run that stalls, gets refused a tool, or
   * never finishes produces MORE examples than one that goes straight to the answer.
   *
   * Sorting on the tier alone cannot see that: a gold run that flailed for sixty steps and a gold
   * run that took eight are the same thing to it. `best` — confirmed AND clean — is the only grade
   * worth putting above gold, and it is what a first training should mostly be made of.
   */
  const NL2 = String.fromCharCode(10);
  const graded = (jobId, grade, n) => JSON.stringify({
    messages: [
      { role: 'system', content: 'You are Ghost Browser working as general.' },
      { role: 'user', content: 'GOAL: thing ' + n },
      { role: 'assistant', content: JSON.stringify({ tool: 'read', args: {} }) },
    ],
    meta: { jobId, tier: grade === 'best' || grade === 'gold' ? 'gold' : 'silver', grade, role: 'general' },
  });

  it('PREFERS A CLEAN CONFIRMED RUN OVER AN UNTIDY CONFIRMED ONE', () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push(graded('j-messy-' + i, 'gold', i));
    for (let i = 0; i < 20; i++) rows.push(graded('j-clean-' + i, 'best', i));
    fs.writeFileSync(file, rows.join(NL2));

    const s = draw({ file, builtAt: 'g1', want: 20, perRun: 12 });
    const grades = s.jsonl.split(NL2).map((l) => JSON.parse(l).meta.grade);
    expect(grades.filter((g) => g === 'best').length).toBeGreaterThan(grades.filter((g) => g === 'gold').length);
  });

  it('still puts evidence above tidiness', () => {
    /* Method does not replace proof. A scruffy run that produced a file with bytes in it is worth
       more than a neat one nothing could check. */
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push(graded('j-tidy-' + i, 'clean', i));
    for (let i = 0; i < 20; i++) rows.push(graded('j-proof-' + i, 'gold', i));
    fs.writeFileSync(file, rows.join(NL2));

    const s = draw({ file, builtAt: 'g2', want: 20, perRun: 12 });
    const grades = s.jsonl.split(NL2).map((l) => JSON.parse(l).meta.grade);
    expect(grades.filter((g) => g === 'gold').length).toBeGreaterThan(grades.filter((g) => g === 'clean').length);
  });
});

describe('when the set is rebuilt', () => {
  it('FORGETS THE OLD MARKS, because line numbers no longer mean the same rows', () => {
    /* Carrying the ledger across a rebuild silently skips turns that were never trained on, while
       counting them as covered. The set is rebuilt daily, so this would happen every day. */
    draw({ file, builtAt: 't1', want: 300 });
    expect(progress('t1', 374).handed).toBe(300);

    const after = draw({ file, builtAt: 't2-rebuilt', want: 50 });
    expect(after.count).toBe(50);
    expect(progress('t2-rebuilt', 374).handed).toBe(50);
  });

  it('can be started again on purpose', () => {
    draw({ file, builtAt: 't1', want: 300 });
    reset('t1');
    expect(progress('t1', 374).handed).toBe(0);
    expect(draw({ file, builtAt: 't1', want: 10 }).count).toBe(10);
  });
});

describe('sighted turns only', () => {
  /* Two rounds collapsed on blind turns; the gate counts sighted ones, so the draw must too. A set
     from before the flag existed carries none and is drawn as it always was. */
  const row = (tool, sighted, job) => JSON.stringify({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: JSON.stringify({ tool, args: {} }) }], meta: { jobId: job, tier: 'gold', grade: 'gold', role: 'general', at: 1, sighted } });
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-slice-sighted-')); process.env.PROFILE_DIR = dir; });
  afterEach(() => { delete process.env.PROFILE_DIR; try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

  it('draws and examines only the sighted turns when the set has any', () => {
    const p = path.join(dir, 'train.jsonl');
    fs.writeFileSync(p, [row('look', true, 'a'), row('open', true, 'b'), row('read', true, 'c'), row('look', false, 'd'), row('open', false, 'e'), row('dig', false, 'f')].join('\n'));
    const d = draw({ file: p, builtAt: 'x', want: 10 });
    expect(d.count).toBe(3);
    expect(d.jsonl).not.toMatch(/"sighted":false/);
    const e = exam({ file: p, want: 10 });
    expect(e.count).toBe(3);
    expect(e.jsonl).not.toMatch(/"sighted":false/);
  });

  it('draws an older set, with no flag at all, as before', () => {
    const p = path.join(dir, 'train.jsonl');
    const old = (tool, job) => JSON.stringify({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: JSON.stringify({ tool, args: {} }) }], meta: { jobId: job, tier: 'gold', grade: 'gold' } });
    fs.writeFileSync(p, [old('look', 'a'), old('open', 'b')].join('\n'));
    expect(draw({ file: p, builtAt: 'y', want: 10 }).count).toBe(2);
  });
});
