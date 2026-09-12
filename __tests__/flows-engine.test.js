/**
 * FLOWS FOR THE ORGANS — the four engine additions.
 *
 * Herald and the master send single open-ended walks, and every failure this week had the same shape:
 * one walk handed a big goal, drifting a defensible page at a time, then inventing when it could not
 * tell what had happened. The browser already has a workflow engine — steps as data, outputs threaded
 * into the next goal, filter/branch/collect/for-each, a journalled run that resumes — and only the
 * Automation canvas used it. These four additions are what an organ needs to drive it:
 *
 *   1. a run can be handed its INPUT      (a reply needs its thread URL and its approved text)
 *   2. a step carries its own BUDGET      (per-job since v199; the engine never set it)
 *   3. a step's OUTCOME is data           (posted / unconfirmed / blocked, not a paragraph of prose)
 *   4. a `verify` step                    (the act gate's own confirmation, placed as a step)
 *
 * The whole point of the engine is that the scheduler is pure: runAgent and runVerify are injected,
 * so all of this is tested without a browser.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-flows-'));
process.env.PROFILE_DIR = TMP;
const wf = await import('../src/workflows.js');
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const ROLE_NAMES = ['general', 'herald.facebook.groups.engage'];

/* The reply flow, in miniature: open the post, send, verify, decide. */
const replyFlow = () => ({
  name: 'reply to a thread',
  nodes: [
    { id: 'start', type: 'trigger', trigger: { type: 'manual' } },
    { id: 'send', type: 'agent', role: 'general', profile: 'facebook', outKey: 'send',
      goal: 'Open {{input.threadUrl}} and post this comment: {{input.text}}', maxPages: 3, maxSteps: 15 },
    { id: 'check', type: 'verify', profile: 'facebook', outKey: 'check',
      url: '{{input.threadUrl}}', text: '{{input.text}}' },
  ],
  edges: [{ from: 'start', to: 'send' }, { from: 'send', to: 'check' }],
});

describe('a run can be handed its input', () => {
  it('seeds {{input.*}} into every goal', async () => {
    const goals = [];
    const run = await wf.drive(replyFlow(), {
      runAgent: async ({ goal }) => { goals.push(goal); return { outcome: 'posted' }; },
      runVerify: async () => ({ found: true }),
      input: { threadUrl: 'https://x/1', text: 'Own the database first.' },
      now: () => 't', runId: 'r-input',
    });
    expect(run.status).toBe('done');
    expect(goals[0]).toBe('Open https://x/1 and post this comment: Own the database first.');
  });

  /* Every workflow that exists today runs without one, and must be untouched. */
  it('a run with no input is exactly as it was', async () => {
    const goals = [];
    const run = await wf.drive(replyFlow(), {
      runAgent: async ({ goal }) => { goals.push(goal); return {}; },
      runVerify: async () => ({ found: false }),
      now: () => 't', runId: 'r-noinput',
    });
    expect(run.status).toBe('done');
    expect(goals[0]).toBe('Open  and post this comment: ');   // the templates fill with nothing
  });

  /* A restart mid-run must not lose what the run was about. */
  it('the input is kept on the run, so a resume still knows the thread', async () => {
    const run = await wf.drive(replyFlow(), {
      runAgent: async () => ({ outcome: 'posted' }), runVerify: async () => ({ found: true }),
      input: { threadUrl: 'https://x/2', text: 'hello' }, now: () => 't', runId: 'r-keep',
    });
    expect(run.input).toEqual({ threadUrl: 'https://x/2', text: 'hello' });

    const goals = [];
    await wf.drive(replyFlow(), {
      runAgent: async ({ goal }) => { goals.push(goal); return {}; }, runVerify: async () => ({ found: true }),
      resume: { ...run, steps: run.steps.slice(0, 1) }, now: () => 't', runId: 'r-keep',
    });
    expect(goals[0]).toContain('https://x/2');
  });
});

describe('a step carries its own budget', () => {
  it('stores the page and step budget on an agent node', () => {
    const saved = wf.save({ ...replyFlow(), name: 'budgeted flow' }, ROLE_NAMES);
    const send = saved.nodes.find((n) => n.id === 'send');
    expect(send.maxPages).toBe(3);
    expect(send.maxSteps).toBe(15);
  });

  /* A budget is a promise about cost: a caller must not buy an unbounded walk by typing a big one. */
  it('clamps them, and leaves them off when they are not set', () => {
    const f = replyFlow();
    f.nodes[1].maxPages = 9999; f.nodes[1].maxSteps = 9999;
    const send = wf.save({ ...f, name: 'clamped flow' }, ROLE_NAMES).nodes.find((n) => n.id === 'send');
    expect(send.maxPages).toBe(200);
    expect(send.maxSteps).toBe(300);

    const plain = replyFlow(); delete plain.nodes[1].maxPages; delete plain.nodes[1].maxSteps;
    const n = wf.save({ ...plain, name: 'default flow' }, ROLE_NAMES).nodes.find((x) => x.id === 'send');
    expect('maxPages' in n).toBe(false);   // absent = the browser's own default, as before
    expect('maxSteps' in n).toBe(false);
  });

  it('and the runner hands them to the job', () => {
    const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    expect(src).toMatch(/maxSteps: Number\(node\.maxSteps\) \|\| 0, maxPages: Number\(node\.maxPages\) \|\| 0 \}\);/);
  });
});

describe("what happened, as one word", () => {
  /* Read off the job's own steps — the same kinds the act gate writes. */
  it('reads the outcome from the walk itself', () => {
    expect(wf.outcomeOf([{ kind: 'tool' }, { kind: 'acted' }])).toBe('posted');
    expect(wf.outcomeOf([{ kind: 'unconfirmed' }])).toBe('unconfirmed');
    expect(wf.outcomeOf([{ kind: 'blocked' }])).toBe('blocked');
    expect(wf.outcomeOf([{ kind: 'look' }, { kind: 'read' }])).toBe('none');
    expect(wf.outcomeOf()).toBe('none');
  });

  /* An act that landed outranks an earlier refusal: the walk got there in the end. */
  it('posted wins over a refusal earlier in the same walk', () => {
    expect(wf.outcomeOf([{ kind: 'blocked' }, { kind: 'unconfirmed' }, { kind: 'acted' }])).toBe('posted');
  });

  it('a branch can test it, which is the whole point', async () => {
    const flow = {
      name: 'branch on the outcome',
      nodes: [
        { id: 'start', type: 'trigger', trigger: { type: 'manual' } },
        { id: 'send', type: 'agent', role: 'general', outKey: 'send', goal: 'send it' },
        { id: 'gate', type: 'branch', inKey: 'send.outcome', op: 'eq', value: 'posted' },
        { id: 'yes', type: 'store', key: 'said', value: 'it posted' },
        { id: 'no', type: 'store', key: 'said', value: 'a person must look' },
      ],
      edges: [{ from: 'start', to: 'send' }, { from: 'send', to: 'gate' },
        { from: 'gate', to: 'yes', fromPort: 'true' }, { from: 'gate', to: 'no', fromPort: 'false' }],
    };
    const runWith = (outcome) => wf.drive(flow, { runAgent: async () => ({ outcome }), now: () => 't', runId: 'r-' + outcome });

    const posted = await runWith('posted');
    expect(posted.steps.find((s) => s.node_id === 'yes').status).toBe('done');
    expect(posted.steps.find((s) => s.node_id === 'no').status).toBe('skipped');

    const unconfirmed = await runWith('unconfirmed');
    expect(unconfirmed.steps.find((s) => s.node_id === 'no').status).toBe('done');
    expect(unconfirmed.steps.find((s) => s.node_id === 'yes').status).toBe('skipped');
  });

  it('and the runner puts the report, note and url beside the records', () => {
    const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    expect(src).toMatch(/outcome: workflows\.outcomeOf\(v\.steps\)/);
    expect(src).toMatch(/report: v\.report \? String\(v\.report\)\.slice\(0, 4000\) : undefined/);
  });
});

describe('a verify step answers whether the words are on the page', () => {
  it('is a real node type, validated on the two things it needs', () => {
    expect(wf.NODE_TYPES).toContain('verify');
    const errs = wf.validate({ name: 'bad verify', nodes: [
      { id: 'start', type: 'trigger' }, { id: 'v', type: 'verify', label: 'check' },
    ] }, ROLE_NAMES);
    expect(errs.join(' ')).toMatch(/needs a url to open/);
    expect(errs.join(' ')).toMatch(/needs the text to look for/);
  });

  it('templates its url and its text from the run, and hands back data', async () => {
    let seen = null;
    const run = await wf.drive(replyFlow(), {
      runAgent: async () => ({ outcome: 'unconfirmed' }),
      runVerify: async (a) => { seen = a; return { found: true }; },
      input: { threadUrl: 'https://x/9', text: 'the exact words' }, now: () => 't', runId: 'r-verify',
    });
    expect(seen.url).toBe('https://x/9');
    expect(seen.text).toBe('the exact words');
    expect(run.steps.find((s) => s.node_id === 'check').output).toMatchObject({ found: true, url: 'https://x/9' });
  });

  /* The point of the step: the walk said unconfirmed, the page says otherwise, and the flow believes
     the page. That is the false "replied" this fixes, decided without asking a model. */
  it('the page outranks the walk, and no model is asked', async () => {
    const flow = { ...replyFlow(), name: 'trust the page' };
    flow.nodes.push({ id: 'gate', type: 'branch', inKey: 'check.found', op: 'eq', value: 'true' });
    flow.nodes.push({ id: 'ok', type: 'store', key: 'verdict', value: 'posted' });
    flow.edges.push({ from: 'check', to: 'gate' }, { from: 'gate', to: 'ok', fromPort: 'true' });
    const run = await wf.drive(flow, {
      runAgent: async () => ({ outcome: 'unconfirmed' }),
      runVerify: async () => ({ found: true }),
      input: { threadUrl: 'https://x/1', text: 'words' }, now: () => 't', runId: 'r-trust',
    });
    expect(run.steps.find((s) => s.node_id === 'ok').status).toBe('done');
  });

  it('a browser that cannot verify fails the step rather than guessing', async () => {
    const run = await wf.drive(replyFlow(), {
      runAgent: async () => ({}), input: { threadUrl: 'https://x/1', text: 'w' }, now: () => 't', runId: 'r-noverify',
    });
    expect(run.status).toBe('error');
    expect(run.steps.find((s) => s.node_id === 'check').error).toMatch(/cannot run a verify step/);
  });

  it('and it resumes like every other step', async () => {
    const done = { node_id: 'check', type: 'verify', status: 'done', output: { found: true, url: 'https://x/1' } };
    const context = {};
    expect(wf.seedFromStep({ id: 'check', type: 'verify', outKey: 'check' }, done, context, {})).toBe(true);
    expect(context.check).toMatchObject({ found: true });
    /* A step whose output cannot rebuild the context must re-run rather than be trusted. */
    expect(wf.seedFromStep({ id: 'check', type: 'verify' }, { output: null }, {}, {})).toBe(false);
  });
});

describe('the verify step in the browser is the act gate\'s own check', () => {
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  /*
   * It used to reuse confirmPosted, on the reasoning that both ask "is this text on the page". They
   * do not. confirmPosted asks whether the comment the agent just typed actually POSTED, so it
   * demands a long distinctive string and returns null below 40 alphanumerics rather than guess —
   * correct for that, fatal here, because makeRunVerify reads `found === true` and a short proof
   * ("PLN", a page heading) therefore came back as "not on the page" every single time. No flow
   * could ever be verified and the library stayed empty through seven builds. See verify-text.test.js.
   */
  it('asks pageHasText, NOT confirmPosted — a short proof must be answerable', () => {
    expect(src).toMatch(/const found = await agent\.pageHasText\(s\.page, String\(text\)\);/);
    const fn = src.slice(src.indexOf('function makeRunVerify'), src.indexOf('function makeRunAgent'));
    expect(fn).not.toMatch(/await agent[.]confirmPosted/);
  });

  it('opens the page and nothing else — no model, no act, nothing typed', () => {
    const fn = src.slice(src.indexOf('function makeRunVerify'), src.indexOf('function makeRunAgent'));
    expect(fn).toMatch(/waitUntil: 'domcontentloaded'/);
    expect(fn).not.toMatch(/agent\.run\(|jobs\.create\(|typeInto|autoAct/);
  });

  it('refuses anything that is not an http url', () => {
    expect(src).toMatch(/a verify step needs an http\(s\) url/);
  });
});
