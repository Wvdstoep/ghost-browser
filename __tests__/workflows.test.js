/**
 * Automations as data, and the engine that runs them.
 *
 * The orchestration is what these pin: steps run in the order the edges give, each step's output lands
 * in a context bag, and the NEXT step's goal is templated against it — the data seam the whole feature
 * exists for. The browser work is injected, so the loop is tested without a browser; a failing step
 * stops the run and is recorded, never thrown.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-wf-'));
process.env.PROFILE_DIR = dir;
const wf = await import('../src/workflows.js');

const ROLE_NAMES = ['general', 'reddit.scout', 'facebook.scout'];

const good = () => ({
  name: 'Reddit complaint → outreach',
  trigger: { type: 'manual' },
  nodes: [
    { id: 't', type: 'trigger', trigger: { type: 'manual' } },
    { id: 'collect', type: 'agent', role: 'reddit.scout', profile: 'reddit', goal: 'Find people complaining about {{topic}}', outKey: 'leads' },
    { id: 'draft', type: 'agent', role: 'general', goal: 'Draft a reply for each of: {{collect.leads}}', outKey: 'drafts' },
  ],
  edges: [{ from: 't', to: 'collect' }, { from: 'collect', to: 'draft' }],
});

beforeEach(() => { fs.rmSync(path.join(dir, 'workflows'), { recursive: true, force: true }); fs.rmSync(path.join(dir, 'workflow-runs'), { recursive: true, force: true }); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('storing an automation', () => {
  it('saves a valid one and mints a stable id from the name', () => {
    const w = wf.save(good(), ROLE_NAMES);
    expect(w.id).toBe('reddit-complaint-outreach');
    expect(wf.read(w.id).nodes).toHaveLength(3);
  });
  it('refuses the ways a draft is not runnable', () => {
    expect(() => wf.save({ ...good(), name: 'x' }, ROLE_NAMES)).toThrow(/name of at least/);
    expect(() => wf.save({ ...good(), nodes: [{ id: 'a', type: 'agent', goal: 'go' }] }, ROLE_NAMES)).toThrow(/trigger/);
    const noGoal = good(); noGoal.nodes[1].goal = '';
    expect(() => wf.save(noGoal, ROLE_NAMES)).toThrow(/needs a goal/);
    const badRole = good(); badRole.nodes[1].role = 'nope.role';
    expect(() => wf.save(badRole, ROLE_NAMES)).toThrow(/role that does not exist/);
    const badEdge = good(); badEdge.edges = [{ from: 't', to: 'ghost' }];
    expect(() => wf.save(badEdge, ROLE_NAMES)).toThrow(/not there/);
  });
  it('keeps the per-node record flag through save (builder "🎥 Record this step")', () => {
    const w = good(); w.nodes[1].record = true;   // tick record on the collect step
    const saved = wf.save(w, ROLE_NAMES);
    const back = wf.read(saved.id);
    expect(back.nodes.find((n) => n.id === 'collect').record).toBe(true);
    // a step left un-ticked carries no record flag (so the driver never films it)
    expect(back.nodes.find((n) => n.id === 'draft').record).toBeUndefined();
  });
  it('lists, deletes, and round-trips a pack', () => {
    const w = wf.save(good(), ROLE_NAMES);
    expect(wf.all().map((x) => x.id)).toContain(w.id);
    const pack = wf.exportPack(w.id);
    expect(pack.kind).toBe('ghost-workflow');
    expect(pack).not.toHaveProperty('id');
    const back = wf.importPack(pack, ROLE_NAMES);
    expect(back.name).toBe(w.name);
    expect(wf.remove(w.id)).toBe(true);
    expect(wf.read(w.id)).toBeNull();
  });
});

describe('order — the line the steps run in', () => {
  it('follows the edges from the trigger', () => {
    expect(wf.order(good()).map((n) => n.id)).toEqual(['t', 'collect', 'draft']);
  });
  it('still runs a step nothing points at, rather than dropping it silently', () => {
    const w = good(); w.nodes.push({ id: 'orphan', type: 'store', key: 'x', value: 'y' });
    expect(wf.order(w).map((n) => n.id)).toContain('orphan');
  });
});

describe('template — the data seam', () => {
  const ctx = { topic: 'slow invoicing', collect: { leads: [{ who: 'a' }, { who: 'b' }] } };
  it('fills a plain key', () => { expect(wf.template('about {{topic}}', ctx)).toBe('about slow invoicing'); });
  it('fills a nested path, JSON-encoding an object or list', () => {
    expect(wf.template('{{collect.leads}}', ctx)).toBe('[{"who":"a"},{"who":"b"}]');
  });
  it('resolves a missing key to empty rather than leaving the braces', () => {
    expect(wf.template('x {{nope}} y', ctx)).toBe('x  y');
  });
});

describe('drive — running the line', () => {
  it('threads each step\'s output into the next step\'s goal, and journals every step', async () => {
    const seenGoals = [];
    const runAgent = async ({ node, goal }) => {
      seenGoals.push(goal);
      // The collect step "finds" two leads; the draft step returns drafts.
      if (node.id === 'collect') return { leads: [{ who: 'ann' }, { who: 'ben' }], __jobId: 'j1' };
      return { drafts: ['hi ann', 'hi ben'], __jobId: 'j2' };
    };
    const saved = [];
    const run = await wf.drive(wf.read(wf.save(good(), ROLE_NAMES).id) || good(),
      { runAgent, persist: (r) => saved.push(JSON.parse(JSON.stringify(r))), now: () => '2026-01-01T00:00:00Z', runId: 'r1' });

    expect(run.status).toBe('done');
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    // topic was never set, so the collect goal has an empty {{topic}}; the point is the SECOND goal
    // carries the FIRST step's output — the seam.
    expect(seenGoals[1]).toContain('ann');
    expect(seenGoals[1]).toContain('ben');
    expect(run.steps[1].job_id).toBe('j1');
    expect(saved.length).toBeGreaterThan(3);   // persisted before + after each step
  });

  it('a failing step stops the run and records the error, never throws', async () => {
    const runAgent = async ({ node }) => { if (node.id === 'collect') throw new Error('no session'); return {}; };
    const run = await wf.drive(good(), { runAgent, now: () => 't', runId: 'r2' });
    expect(run.status).toBe('error');
    const collect = run.steps.find((s) => s.node_id === 'collect');
    expect(collect.status).toBe('error');
    expect(collect.error).toMatch(/no session/);
    // the draft step never ran
    expect(run.steps.find((s) => s.node_id === 'draft')).toBeUndefined();
  });

  it('a store step stashes a templated value for later steps', async () => {
    const w = good();
    w.nodes = [{ id: 't', type: 'trigger' }, { id: 's', type: 'store', key: 'note', value: 'topic is {{topic}}' }];
    w.edges = [{ from: 't', to: 's' }];
    const run = await wf.drive(w, { runAgent: async () => ({}), now: () => 't', runId: 'r3' });
    expect(run.steps[1].output).toEqual({ note: 'topic is ' });
  });

  it('a filter node keeps only the items that match, and a for-each step runs once per kept item', async () => {
    const w = {
      name: 'collect filter draft', trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'collect', type: 'agent', role: 'reddit.scout', goal: 'find', outKey: 'collect' },
        { id: 'keep', type: 'filter', inKey: 'collect.leads', field: 'budget', op: 'exists', outKey: 'hot' },
        { id: 'draft', type: 'agent', role: 'general', goal: 'reply to {{item.who}}', forEach: 'hot', outKey: 'drafts' },
      ],
      edges: [{ from: 't', to: 'collect' }, { from: 'collect', to: 'keep' }, { from: 'keep', to: 'draft' }],
    };
    const perItemGoals = [];
    const runAgent = async ({ node, goal }) => {
      if (node.id === 'collect') return { leads: [{ who: 'ann', budget: '5k' }, { who: 'ben' }, { who: 'cat', budget: '2k' }], __jobId: 'j' };
      perItemGoals.push(goal); return { sent: true };
    };
    const run = await wf.drive(w, { runAgent, now: () => 't', runId: 'r4' });
    expect(run.status).toBe('done');
    // 3 leads → filter keeps the 2 with a budget → the draft step runs twice, once per kept lead.
    expect(run.steps.find((s) => s.node_id === 'keep').output).toEqual({ kept: 2, of: 3 });
    expect(perItemGoals).toEqual(['reply to ann', 'reply to cat']);
    expect(run.steps.find((s) => s.node_id === 'draft').output.count).toBe(2);
  });

  it('a collect node maps a fan-out\'s items into a clean ordered list for the next step', async () => {
    const w = {
      name: 'fanout collect assemble', trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'scenes', type: 'agent', role: 'general', goal: 'plan', outKey: 'scenes' },
        { id: 'clips', type: 'agent', role: 'general', goal: 'clip {{item.i}}', forEach: 'scenes.data.list', outKey: 'clips' },
        { id: 'ids', type: 'collect', inKey: 'clips.items', field: 'data.clip', outKey: 'clip_ids' },
        { id: 'assemble', type: 'agent', role: 'general', goal: 'use {{clip_ids}}', outKey: 'assemble' },
      ],
      edges: [{ from: 't', to: 'scenes' }, { from: 'scenes', to: 'clips' }, { from: 'clips', to: 'ids' }, { from: 'ids', to: 'assemble' }],
    };
    let assembleGoal = '';
    const runAgent = async ({ node, goal }) => {
      if (node.id === 'scenes') return { data: { list: [{ i: 1 }, { i: 2 }, { i: 3 }] } };
      if (node.id === 'clips') return { data: { clip: 'f' + (goal.match(/clip (\d+)/) || [])[1] } };  // one clip per scene
      if (node.id === 'assemble') { assembleGoal = goal; return {}; }
      return {};
    };
    const run = await wf.drive(w, { runAgent, now: () => 't', runId: 'rc' });
    expect(run.status).toBe('done');
    // three scenes → three clips → collect flattens each item's data.clip into an ordered id list
    expect(run.steps.find((s) => s.node_id === 'ids').output).toEqual({ clip_ids: ['f1', 'f2', 'f3'] });
    // …and the assemble step receives that clean list in its goal, not a wall of JSON.
    expect(assembleGoal).toBe('use ["f1","f2","f3"]');
  });

  it('filterMatch covers the operators', () => {
    expect(wf.filterMatch({ t: 'has budget now' }, 't', 'contains', 'budget')).toBe(true);
    expect(wf.filterMatch({ t: 'nope' }, 't', 'contains', 'budget')).toBe(false);
    expect(wf.filterMatch({ n: 5 }, 'n', 'gt', '3')).toBe(true);
    expect(wf.filterMatch({ n: 2 }, 'n', 'gt', '3')).toBe(false);
    expect(wf.filterMatch({ x: 'v' }, 'missing', 'exists', '')).toBe(false);
    expect(wf.filterMatch({ x: 'v' }, 'x', 'exists', '')).toBe(true);
  });
});

describe('drive — the graph (branch + parallel)', () => {
  it('a branch runs only the matching path and skips the other (cascading)', async () => {
    const w = {
      name: 'branch', trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'collect', type: 'agent', role: 'reddit.scout', goal: 'find', outKey: 'collect' },
        { id: 'gate', type: 'branch', inKey: 'collect.leads', op: 'exists', value: '' },
        { id: 'yes', type: 'agent', role: 'general', goal: 'act on {{collect.leads}}', outKey: 'acted' },
        { id: 'no', type: 'agent', role: 'general', goal: 'nothing', outKey: 'idle' },
        { id: 'after', type: 'agent', role: 'general', goal: 'downstream of the no path', outKey: 'after' },
      ],
      edges: [
        { from: 't', to: 'collect' }, { from: 'collect', to: 'gate' },
        { from: 'gate', to: 'yes', fromPort: 'true' }, { from: 'gate', to: 'no', fromPort: 'false' },
        { from: 'no', to: 'after' },
      ],
    };
    const ran = [];
    const runAgent = async ({ node }) => { ran.push(node.id); return node.id === 'collect' ? { leads: [{ who: 'a' }] } : {}; };
    const run = await wf.drive(w, { runAgent, now: () => 't', runId: 'rb' });
    expect(run.status).toBe('done');
    expect(ran).toContain('yes');            // leads exist → the true path runs
    expect(ran).not.toContain('no');         // the false path is skipped
    expect(ran).not.toContain('after');      // and the skip cascades downstream
    expect(run.steps.find((s) => s.node_id === 'no').status).toBe('skipped');
    expect(run.steps.find((s) => s.node_id === 'after').status).toBe('skipped');
  });

  it('runs independent branches in parallel', async () => {
    const w = {
      name: 'parallel', trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a', type: 'agent', role: 'reddit.scout', goal: 'reddit', outKey: 'a' },
        { id: 'b', type: 'agent', role: 'facebook.scout', goal: 'facebook', outKey: 'b' },
      ],
      edges: [{ from: 't', to: 'a' }, { from: 't', to: 'b' }],
    };
    let active = 0, peak = 0;
    const runAgent = async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active -= 1; return {}; };
    const run = await wf.drive(w, { runAgent, now: () => 't', runId: 'rp' });
    expect(run.status).toBe('done');
    expect(peak).toBe(2);                     // a and b were in flight at the same time — real parallelism
    expect(run.steps.filter((s) => s.type === 'agent' && s.status === 'done')).toHaveLength(2);
  });

  it('condMatch gates a branch', () => {
    expect(wf.condMatch([1, 2], 'exists', '')).toBe(true);
    expect(wf.condMatch([], 'exists', '')).toBe(false);
    expect(wf.condMatch([1, 2, 3], 'gt', '2')).toBe(true);
    expect(wf.condMatch('has budget', 'contains', 'budget')).toBe(true);
  });
});

describe('drive — resuming a run a restart interrupted', () => {
  const waitFor = async (fn, ms = 800) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); } return fn(); };

  it('re-runs only the unfinished step and restores context from the finished ones', async () => {
    const w = wf.save(good(), ROLE_NAMES);
    const interrupted = {
      id: 'rr1', workflow_id: w.id, name: w.name, status: 'running', started_at: 't', ended_at: null,
      steps: [
        { node_id: 't', type: 'trigger', status: 'done', output: null },
        { node_id: 'collect', type: 'agent', status: 'done', output: { leads: [{ who: 'kris' }], __jobId: 'j1' } },
        { node_id: 'draft', type: 'agent', status: 'running', output: null },   // was in flight when it died
      ],
    };
    const called = [];
    const runAgent = async ({ node, goal }) => { called.push({ id: node.id, goal }); return {}; };
    const run = await wf.drive(w, { runAgent, now: () => 't', runId: 'rr1', resume: interrupted });
    expect(called.map((c) => c.id)).toEqual(['draft']);          // 'collect' was NOT re-run
    expect(called[0].goal).toContain('kris');                     // context restored from collect's output
    expect(run.status).toBe('done');
    expect(run.steps.filter((s) => s.node_id === 'collect')).toHaveLength(1);  // finished step kept, not duplicated
  });

  it('recoverRuns picks up a run left "running" and finishes it', async () => {
    const w = wf.save(good(), ROLE_NAMES);
    wf.persistRun({ id: 'rr2', workflow_id: w.id, name: w.name, status: 'running', started_at: 't', steps: [
      { node_id: 't', type: 'trigger', status: 'done', output: null },
      { node_id: 'collect', type: 'agent', status: 'done', output: { leads: [{ who: 'a' }] } },
    ] });
    const called = [];
    const n = wf.recoverRuns({ runAgent: async ({ node }) => { called.push(node.id); return {}; }, persist: wf.persistRun });
    expect(n).toBe(1);
    await waitFor(() => wf.readRun('rr2').status === 'done');
    expect(called).toEqual(['draft']);
    expect(wf.readRun('rr2').status).toBe('done');
    expect(wf.readRun('rr2').resumes).toBe(1);
  });

  it('resumes only the newest interrupted run of an automation, superseding older ones', async () => {
    const w = wf.save(good(), ROLE_NAMES);
    const step = { node_id: 'collect', type: 'agent', status: 'done', output: { leads: [{ who: 'a' }] } };
    wf.persistRun({ id: 'old', workflow_id: w.id, name: w.name, status: 'running', started_at: '2026-01-01T00:00:00Z', steps: [step] });
    wf.persistRun({ id: 'new', workflow_id: w.id, name: w.name, status: 'running', started_at: '2026-01-02T00:00:00Z', steps: [step] });
    const called = [];
    const n = wf.recoverRuns({ runAgent: async () => { called.push(1); return {}; }, persist: wf.persistRun });
    expect(n).toBe(1);                                  // only one resumed
    await waitFor(() => wf.readRun('new').status === 'done');
    expect(wf.readRun('old').status).toBe('interrupted');   // older one retired
    expect(wf.readRun('old').error).toMatch(/superseded/);
  });

  it('marks a run interrupted when its automation no longer exists', () => {
    wf.persistRun({ id: 'rr3', workflow_id: 'deleted-wf', status: 'running', started_at: 't', steps: [] });
    wf.recoverRuns({ runAgent: async () => ({}), persist: wf.persistRun });
    expect(wf.readRun('rr3').status).toBe('interrupted');
  });

  it('gives up on a run that keeps crash-restarting instead of retrying forever', () => {
    const w = wf.save(good(), ROLE_NAMES);
    const called = [];
    wf.persistRun({ id: 'rr4', workflow_id: w.id, name: w.name, status: 'running', resumes: 3, started_at: 't', steps: [] });
    wf.recoverRuns({ runAgent: async ({ node }) => { called.push(node.id); return {}; }, persist: wf.persistRun });
    expect(wf.readRun('rr4').status).toBe('interrupted');
    expect(called).toHaveLength(0);
  });
});

describe('auto-send replies (autoApprove) + natural pacing', () => {
  const replyFlow = (extra = {}) => ({
    name: 'auto outreach', trigger: { type: 'manual' }, ...extra,
    nodes: [
      { id: 't', type: 'trigger', trigger: { type: 'manual' } },
      { id: 'collect', type: 'agent', role: 'reddit.scout', profile: 'reddit', goal: 'find', outKey: 'leads' },
      { id: 'reply', type: 'agent', role: 'general', goal: 'reply to {{item}}', forEach: 'collect.leads' },
    ],
    edges: [{ from: 't', to: 'collect' }, { from: 'collect', to: 'reply' }],
  });

  it('passes autoApprove to acting steps and paces ONCE between two replies', async () => {
    const saved = wf.save(replyFlow({ autoApprove: true }), ROLE_NAMES);
    expect(saved.autoApprove).toBe(true);                    // survives save
    const seen = []; let sleeps = 0;
    const runAgent = async ({ node, autoApprove }) => { seen.push({ id: node.id, autoApprove }); return node.id === 'collect' ? { leads: [{ who: 'a' }, { who: 'b' }] } : {}; };
    const run = await wf.drive(saved, { runAgent, now: () => 't', runId: 'ra', sleep: async () => { sleeps += 1; } });
    expect(run.status).toBe('done');
    const replies = seen.filter((s) => s.id === 'reply');
    expect(replies).toHaveLength(2);
    expect(replies.every((r) => r.autoApprove === true)).toBe(true);   // acting steps auto-approve
    expect(sleeps).toBe(1);                                            // spaced between, not after the last
  });

  it('manual mode neither auto-approves nor paces', async () => {
    const saved = wf.save(replyFlow(), ROLE_NAMES);
    expect(saved.autoApprove).toBe(false);
    const seen = []; let sleeps = 0;
    const runAgent = async ({ node, autoApprove }) => { seen.push(autoApprove); return node.id === 'collect' ? { leads: [{ who: 'a' }, { who: 'b' }] } : {}; };
    await wf.drive(saved, { runAgent, now: () => 't', runId: 'rm', sleep: async () => { sleeps += 1; } });
    expect(seen.every((v) => !v)).toBe(true);
    expect(sleeps).toBe(0);
  });
});
