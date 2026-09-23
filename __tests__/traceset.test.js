/*
 * THE TRAINING SET, AND THE FOUR WAYS A TRAINING SET SILENTLY RUINS A MODEL.
 *
 * Every test here is one of them:
 *
 *   - a credential leaves with the data, because redaction was going to be a later step;
 *   - the label comes from the agent's own report, so the model learns to declare success;
 *   - the evaluation split is cut by TURN, so turns from the same job sit on both sides and every
 *     measurement afterwards flatters the model;
 *   - one loud role drowns the rest, and the model becomes a notification sweeper.
 *
 * None of these fail loudly. They all produce a model that looks fine and is not.
 */
import { describe, it, expect } from 'vitest';
import { build, turnsOf, toJsonl, scrubText, scrubValue } from '../src/traceset.js';

const job = (over = {}) => ({
  id: 'j-1', role: 'research.web', profile: 'google', goal: 'Find three suppliers',
  createdAt: '2026-09-01T10:00:00.000Z', endedAt: '2026-09-01T10:10:00.000Z',
  status: 'idle', report: 'Found three suppliers.', error: '', proposals: [], leads: [],
  steps: [
    { n: 1, kind: 'you', text: 'Find three suppliers' },
    { n: 2, kind: 'tool', tool: 'google', args: { query: 'suppliers' } },
    { n: 3, kind: 'read', text: 'google "suppliers" — 8 results', url: 'https://www.google.com/search?q=suppliers' },
    { n: 4, kind: 'tool', tool: 'open', args: { url: 'https://example.com' } },
    { n: 5, kind: 'read', text: 'Example — contact us at sales@example.com or +32 496 31 12 12' },
    { n: 6, kind: 'tool', tool: 'finish', args: { summary: 'done' } },
  ],
  ...over,
});

describe('nothing sensitive leaves with the data', () => {
  it('redacts the things actually found in this corpus', () => {
    /* 533 of 2,222 job files contain an email address; one holds a Search Console token and one a
       Facebook CSRF pair. Those are the real contents, so those are the tests. */
    expect(scrubText('write to sales@example.com')).toBe('write to <email>');
    expect(scrubText('ya29.a0AfB_veryLongTokenValue')).toBe('<token>');
    expect(scrubText('key gb_42c3f0aabbccdd')).toBe('key <key>');
    expect(scrubText('Authorization: Bearer abcdefghijklmnop')).toContain('Bearer <token>');
    expect(scrubText('call +32 496 31 12 12 now')).toBe('call <phone> now');
    expect(scrubText('{"fb_dtsg":"NAcOabcdef123"}')).toBe('{"fb_dtsg":"<token>"}');
  });

  it('drops identity and plumbing fields rather than carrying them along', () => {
    const v = scrubValue({ owner: 'someone@x.com', companyId: 'c1', sessionId: 's1', gscToken: 'abc', keep: 'yes' });
    expect(v).toEqual({ keep: 'yes' });
  });

  it('redacts by key name too, because a token does not arrive under a helpful label', () => {
    expect(scrubValue({ apiKey: 'zzzz', password: 'hunter2', cookie: 'a=b' }))
      .toEqual({ apiKey: '<redacted>', password: '<redacted>', cookie: '<redacted>' });
  });

  it('scrubs inside a tool call\'s arguments, where a person pastes things', () => {
    const t = turnsOf(job({
      steps: [
        { n: 1, kind: 'tool', tool: 'type', args: { text: 'my email is carla@example.com' } },
      ],
    }));
    expect(t[0].action.args.text).toBe('my email is <email>');
  });

  it('does not recurse forever on a self-referential record', () => {
    const a = { name: 'x' }; a.self = a;
    expect(() => scrubValue(a)).not.toThrow();
  });
});

describe('a turn is a decision, not a page dump', () => {
  it('pairs what was seen with the tool that was called next', () => {
    const t = turnsOf(job());
    expect(t).toHaveLength(3);
    expect(t[0].action.tool).toBe('google');
    expect(t[0].observed).toEqual([]);                    // nothing seen before the first call
    expect(t[1].action.tool).toBe('open');
    expect(t[1].observed[0].text).toContain('8 results'); // it saw the search result first
  });

  it('caps the observation text, so the set teaches acting and not reading', () => {
    const long = 'x'.repeat(5000);
    const t = turnsOf(job({ steps: [
      { n: 1, kind: 'read', text: long },
      { n: 2, kind: 'tool', tool: 'open', args: {} },
    ] }), { maxObs: 100 });
    expect(t[0].observed[0].text.length).toBe(100);
  });

  it('keeps only the recent history, because a fortieth step does not need the first', () => {
    const steps = [];
    for (let i = 1; i <= 20; i++) steps.push({ n: i, kind: 'read', text: `obs ${i}` });
    steps.push({ n: 21, kind: 'tool', tool: 'open', args: {} });
    const t = turnsOf(job({ steps }), { maxHistory: 4 });
    expect(t[0].observed).toHaveLength(4);
    expect(t[0].observed[3].text).toBe('obs 20');
  });

  it('produces nothing from a job with no goal', () => {
    expect(turnsOf(job({ goal: '' }))).toEqual([]);
  });
});

describe('the label comes from verifiers, never from the report', () => {
  it('a glowing report with a failed check is bronze and is left out', () => {
    /* It claimed a file. None appeared. The report says otherwise, and the report does not win. */
    const bad = job({
      report: 'Exported the video successfully.',
      steps: [
        { n: 1, kind: 'tool', tool: 'download_url', args: { url: 'https://x/v.mp4' } },
        { n: 2, kind: 'read', text: 'saved' },
      ],
    });
    const out = build([bad], { files: () => [] });
    expect(out.manifest.tiers.bronze).toBe(1);
    expect(out.manifest.claimsCaught.fileWasProduced).toBe(1);
    expect(out.train).toHaveLength(0);
  });

  it('an approved act is gold, and gold is kept', () => {
    const good = job({ proposals: [{ pid: 'p1', state: 'approved' }] });
    const out = build([good], {});
    expect(out.manifest.tiers.gold).toBe(1);
    expect(out.train.length + out.eval.length).toBeGreaterThan(0);
  });

  it('counts what the verifiers caught, because that is the number worth watching', () => {
    const lied = job({
      steps: [{ n: 1, kind: 'tool', tool: 'type', args: { text: 'a sentence that never lands' } },
              { n: 2, kind: 'read', text: 'a completely different page' }],
    });
    expect(build([lied], {}).manifest.claimsCaught.typedTextLanded).toBe(1);
  });
});

describe('a click by number needs the list the number came from', () => {
  /*
   * Every run recorded before look and open began carrying their marks drew a numbered list and
   * threw it away. The turn that survives reads: given a page you cannot see, emit 19. The
   * rebuild of 2026-09-23 had 3,073 of these and 12 that were learnable.
   */
  const clicked = (marks) => job({
    proposals: [{ pid: 'p1', state: 'approved' }],
    steps: [
      { n: 1, kind: 'you', text: 'Find three suppliers' },
      { n: 2, kind: 'tool', tool: 'look', args: {} },
      { n: 3, kind: 'look', text: 'the page', ...(marks ? { marks } : {}) },
      { n: 4, kind: 'tool', tool: 'click', args: { index: 19 } },
      { n: 5, kind: 'read', text: 'the listing' },
    ],
  });

  it('throws away an index whose list was never recorded', () => {
    const out = build([clicked(null)], {});
    const kept = [...out.train, ...out.eval];
    expect(kept.some((x) => x.action.tool === 'click')).toBe(false);
    expect(out.manifest.droppedTurns['an index with no list to read it from']).toBeGreaterThan(0);
  });

  it('keeps the same turn once the list travels with it', () => {
    const out = build([clicked('[19] Website laten maken | incl. hosting')], {});
    const kept = [...out.train, ...out.eval];
    expect(kept.some((x) => x.action.tool === 'click' && x.action.args.index === 19)).toBe(true);
  });

  it('leaves calls that name what they want alone', () => {
    /* Only an index is meaningless without the list. A url or a query carries its own subject. */
    const out = build([job({ proposals: [{ pid: 'p1', state: 'approved' }] })], {});
    const kept = [...out.train, ...out.eval];
    expect(kept.some((x) => x.action.tool === 'open')).toBe(true);
  });
});
describe('the exam does not pay for what training spent', () => {
  /*
   * The per-tool cap counter was shared between the training pass and the evaluation pass, and
   * training is built first. Measured on the real set of 2026-09-23: `open` is 15% of training
   * and the most common action there is, and the eval split held ZERO of it — 0 of 3,057 turns,
   * 1,518 dropped to that rule, 30 tools on the exam against 49 in training. The model was never
   * scored on the thing it does most.
   */
  it('still scores a tool that training used its whole quota of', () => {
    const jobs = [];
    for (let i = 0; i < 40; i++) {
      jobs.push(job({
        id: `j-${i}`, proposals: [{ pid: `p${i}`, state: 'approved' }],
        goal: `open a lot of pages ${i}`,
        steps: [
          { n: 1, kind: 'you', text: `open a lot of pages ${i}` },
          { n: 2, kind: 'tool', tool: 'open', args: { url: `https://a${i}.example` } },
          { n: 3, kind: 'read', text: `page ${i}` },
          { n: 4, kind: 'tool', tool: 'open', args: { url: `https://b${i}.example` } },
          { n: 5, kind: 'read', text: `other ${i}` },
        ],
      }));
    }
    /* A cap low enough that the training pass exhausts it outright. */
    const out = build(jobs, {}, { toolCap: 2 });
    expect(out.train.filter((x) => x.action.tool === 'open').length).toBe(2);
    expect(out.eval.length).toBeGreaterThan(0);
    expect(out.eval.some((x) => x.action.tool === 'open')).toBe(true);
  });
});
describe('the evaluation split is cut by job, before any turn exists', () => {
  it('never puts two turns from the same job on both sides', () => {
    const jobs = [];
    for (let i = 0; i < 60; i++) jobs.push(job({ id: `j-${i}`, goal: `find suppliers batch ${i}`, proposals: [{ state: 'approved' }] }));
    const out = build(jobs, {}, { evalFraction: 0.3 });
    const trainJobs = new Set(out.train.map((t) => t.jobId));
    const evalJobs = new Set(out.eval.map((t) => t.jobId));
    for (const id of evalJobs) expect(trainJobs.has(id)).toBe(false);
  });

  it('is deterministic, so a rebuild does not quietly move the exam', () => {
    const jobs = [];
    for (let i = 0; i < 40; i++) jobs.push(job({ id: `j-${i}`, goal: `find suppliers batch ${i}`, proposals: [{ state: 'approved' }] }));
    const a = build(jobs, {}, { evalFraction: 0.25 }).eval.map((t) => t.jobId);
    const b = build(jobs, {}, { evalFraction: 0.25 }).eval.map((t) => t.jobId);
    expect(a).toEqual(b);
  });

  it('actually holds some back', () => {
    /* Distinct goals, because real jobs have them — and the dedupe key includes the goal, so a
        fixture of byte-identical jobs collapses to one turn and measures nothing. */
    const jobs = [];
    for (let i = 0; i < 80; i++) jobs.push(job({ id: `j-${i}`, goal: `find suppliers batch ${i}`, proposals: [{ state: 'approved' }] }));
    const out = build(jobs, {}, { evalFraction: 0.2 });
    expect(out.eval.length).toBeGreaterThan(0);
    expect(out.train.length).toBeGreaterThan(out.eval.length);
  });
});

describe('no single role is allowed to drown the rest', () => {
  it('caps per role, because 292 notification sweeps against 84 screenshots is not a balance', () => {
    const jobs = [];
    for (let i = 0; i < 200; i++) jobs.push(job({ id: `loud-${i}`, goal: `sweep notifications ${i}`, role: 'facebook-notification-watch', proposals: [{ state: 'approved' }] }));
    for (let i = 0; i < 20; i++) jobs.push(job({ id: `quiet-${i}`, goal: `take a shot ${i}`, role: 'learn.shot', proposals: [{ state: 'approved' }] }));
    const out = build(jobs, {}, { perRoleCap: 30, evalFraction: 0 });
    const byRole = {};
    out.train.forEach((t) => { byRole[t.role] = (byRole[t.role] || 0) + 1; });
    /* Turns, not jobs — but the loud role must no longer be ten times the quiet one. */
    expect(out.manifest.roles['facebook-notification-watch']).toBeGreaterThan(30);
    const loudJobs = new Set(out.train.filter((t) => t.role === 'facebook-notification-watch').map((t) => t.jobId));
    expect(loudJobs.size).toBe(30);
  });
});

describe('the output is what a trainer eats', () => {
  it('is one JSON object per line, with the tool call as the assistant turn', () => {
    const out = build([job({ proposals: [{ state: 'approved' }] })], {}, { evalFraction: 0 });
    const lines = toJsonl(out.train).split('\n');
    expect(lines.length).toBe(out.train.length);
    const first = JSON.parse(lines[0]);
    expect(first.messages).toHaveLength(3);
    expect(first.messages[2].role).toBe('assistant');
    expect(JSON.parse(first.messages[2].content).tool).toBe('google');
    expect(first.meta.tier).toBe('gold');
  });

  it('carries the goal and the role into the prompt, since that is what a specialist needs', () => {
    const out = build([job({ proposals: [{ state: 'approved' }] })], {}, { evalFraction: 0 });
    const first = JSON.parse(toJsonl(out.train).split('\n')[0]);
    expect(first.messages[0].content).toContain('research.web');
    expect(first.messages[1].content).toContain('Find three suppliers');
  });

  it('survives an empty corpus without pretending it built something', () => {
    const out = build([], {});
    expect(out.train).toEqual([]);
    expect(out.manifest.jobsSeen).toBe(0);
  });
});
