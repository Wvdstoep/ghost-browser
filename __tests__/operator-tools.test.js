/**
 * The operator's hands, against a fake context: what they refuse by construction (a flow without a
 * verify step, a watcher without a role step or a budget, auto-send), and that the reads and waits are
 * wired to the right internals and marked repeatable.
 */
import { describe, it, expect } from 'vitest';
import { Registry } from '../src/operator/registry.js';
import { registerOperatorTools, flowProblems, sanitizeFlow, isWatcher, summarizeRun } from '../src/operator/tools.js';

const watcher = { name: 'Reddit · post watcher', active: true, autoApprove: true,
  nodes: [{ id: 'trigger', type: 'trigger', trigger: { type: 'schedule', every: 'minute', n: 15 } }, { id: 'n0', type: 'agent', role: 'reddit-watch', profile: 'reddit', goal: 'gather', maxSteps: 30 }], edges: [{ from: 'trigger', to: 'n0' }] };
const oneOff = { name: 'LinkedIn · scout', nodes: [{ id: 't', type: 'trigger' }, { id: 'a', type: 'agent', role: 'x', goal: 'read', maxSteps: 20 }, { id: 'v', type: 'verify', url: 'https://www.linkedin.com/feed/', text: 'Feed' }], edges: [] };

function fakeCtx() {
  const saved = [];
  return {
    saved,
    ops: { readGuide: (s) => 'GUIDE ' + (s || 'all'), readMemory: () => 'notes', appendMemory: () => 42, ringLines: ({ grep }) => ['09:00:00 line ' + (grep || '')] },
    workflows: { all: () => [{ id: 'w1', name: 'W', active: true, nodes: watcher.nodes }, { id: 'f1', name: 'F', nodes: oneOff.nodes }], read: (id) => (id === 'f1' ? { id: 'f1', ...oneOff } : null), runsFor: () => [{ id: 'r1', workflow_id: 'w1', status: 'done', steps: [{ node_id: 'v', type: 'verify', status: 'done', output: { found: true } }] }], readRun: (id) => (id === 'r1' ? { id: 'r1', status: 'done', steps: [] } : null) },
    feed: { getConfig: () => ({ mode: 'posts', meName: 'Wesley', postUrls: ['https://www.facebook.com/groups/g/posts/1/'] }), setConfig: (id, c) => ({ id, ...c }), list: () => [{ key: 'k', title: 't', kind: 'reply', handled: false, fields: { status: 'waiting on you', author: 'Joe' }, draft: 'hi' }], counts: () => ({ total: 1, unhandled: 1 }), stateOf: () => 'drafted' },
    health: (id) => ({ id, running: false, stale: false }),
    runningWatchers: new Set(['facebook-post-watcher']),
    postIdOf: (u) => (String(u).match(/posts\/(\d+)|post_id=(\d+)/) || []).slice(1).find(Boolean) || null,
    runWatcher: (id) => ({ runId: id + '-1', status: 'running' }),
    setActive: (id, a) => ({ id, active: a }),
    probe: (id, url, expand) => ({ url, expand, count: 3 }),
    jobsSummary: () => ({ jobs: [], history: [] }), jobDetail: (id) => ({ id, steps: [] }), sessions: () => [], look: (p) => ({ profile: p, url: 'https://x', controls: [] }),
    agentTools: () => [{ name: 'look' }], listRoles: () => [{ name: 'a', site: 'facebook' }, { name: 'b', site: 'reddit' }], getRole: (n) => (n === 'a' ? { name: 'a', prompt: 'p' } : null), saveRole: (name, role) => ({ id: name || 'new', ...role }),
    saveFlow: (f) => { saved.push(f); return { id: f.id || 'new', ...f }; }, runFlow: (id, input) => ({ runId: id + '-r', input }), platforms: () => [],
  };
}

describe('flowProblems — a watcher judged as a watcher, a flow as a flow', () => {
  it('accepts a good watcher and a good one-off flow', () => { expect(isWatcher(watcher)).toBe(true); expect(flowProblems(watcher)).toEqual([]); expect(flowProblems(oneOff)).toEqual([]); });
  it('refuses a watcher without a schedule, a role step, or a budget', () => {
    expect(flowProblems({ ...watcher, nodes: watcher.nodes.map((n) => (n.type === 'trigger' ? { ...n, trigger: { type: 'schedule' } } : n)) }).join(' ')).toMatch(/schedule trigger needs/);
    expect(flowProblems({ ...watcher, nodes: watcher.nodes.map((n) => (n.type === 'agent' ? { ...n, role: '' } : n)) }).join(' ')).toMatch(/agent step with a role/);
    expect(flowProblems({ ...watcher, nodes: watcher.nodes.map((n) => (n.type === 'agent' ? { ...n, maxSteps: 0 } : n)) }).join(' ')).toMatch(/needs a budget/);
  });
  it('refuses a one-off flow without a verify step, or with a verify that takes its url from another step', () => {
    expect(flowProblems({ ...oneOff, nodes: oneOff.nodes.filter((n) => n.type !== 'verify') }).join(' ')).toMatch(/verify step/);
    expect(flowProblems({ ...oneOff, nodes: oneOff.nodes.map((n) => (n.type === 'verify' ? { ...n, url: '{{scrape.url}}' } : n)) }).join(' ')).toMatch(/must not take its url/);
  });
  it('sanitize: auto-send always off; a watcher may be active, a one-off never', () => {
    expect(sanitizeFlow(watcher)).toMatchObject({ autoApprove: false, active: true });
    expect(sanitizeFlow({ ...oneOff, active: true, autoApprove: true })).toMatchObject({ autoApprove: false, active: false });
  });
});

describe('registerOperatorTools — the hands on a fake context', () => {
  it('registers the full belt with repeatable reads/waits', () => {
    const reg = new Registry(); const n = registerOperatorTools(reg, fakeCtx());
    expect(n).toBeGreaterThan(25);
    for (const t of ['gb_guide', 'gb_memory_write', 'gb_logs', 'gb_runs_recent', 'gb_job', 'gb_look', 'gb_busy', 'gb_watchers', 'gb_watcher_feed', 'gb_watcher_config', 'gb_watcher_posts', 'gb_watcher_run', 'gb_watcher_wait', 'gb_watcher_probe', 'gb_role_get', 'gb_role_update', 'gb_flow_save', 'gb_flow_run', 'gb_flow_wait', 'gb_platforms']) expect(reg.has(t), t).toBe(true);
    expect(reg.get('gb_watcher_wait').repeatable).toBe(true); expect(reg.get('gb_logs').repeatable).toBe(true); expect(reg.get('gb_flow_save').repeatable).toBe(false);
  });
  it('gb_flow_save refuses a bad watcher and saves a good one with active kept and auto-send off', async () => {
    const ctx = fakeCtx(); const reg = new Registry(); registerOperatorTools(reg, ctx);
    const bad = JSON.parse(await reg.execute('gb_flow_save', { flow: { ...watcher, nodes: watcher.nodes.filter((n) => n.type !== 'agent') } }));
    expect(bad.saved).toBe(false); expect(ctx.saved.length).toBe(0);
    const good = JSON.parse(await reg.execute('gb_flow_save', { flow: watcher }));
    expect(good).toMatchObject({ saved: true, watcher: true, active: true }); expect(ctx.saved[0].autoApprove).toBe(false);
  });
  it('gb_watchers lists only scheduled flows with config and health; gb_watcher_posts adds by post id once', async () => {
    const ctx = fakeCtx(); const reg = new Registry(); registerOperatorTools(reg, ctx);
    const ws = JSON.parse(await reg.execute('gb_watchers', {}));
    expect(ws.length).toBe(1); expect(ws[0]).toMatchObject({ id: 'w1', config: { mode: 'posts', meName: 'Wesley' } });
    const p = JSON.parse(await reg.execute('gb_watcher_posts', { watcherId: 'w1', add: 'https://www.facebook.com/groups/g/posts/1/?x=1' }));
    expect(p.postUrls.length).toBe(1);                                   // same post id → not added twice
    const bad = JSON.parse(await reg.execute('gb_watcher_posts', { watcherId: 'w1', add: 'https://www.facebook.com/' }));
    expect(bad.error).toMatch(/not a post link/);
  });
  it('gb_busy, gb_guide, gb_logs and gb_watcher_feed read the right internals', async () => {
    const reg = new Registry(); registerOperatorTools(reg, fakeCtx());
    expect(JSON.parse(await reg.execute('gb_busy', {})).running).toEqual(['facebook-post-watcher']);
    expect(await reg.execute('gb_guide', { section: 'watchers' })).toBe('GUIDE watchers');
    expect(await reg.execute('gb_logs', { grep: 'ERROR' })).toMatch(/line ERROR/);
    const feed = JSON.parse(await reg.execute('gb_watcher_feed', { watcherId: 'w1', onlyWaiting: true }));
    expect(feed.items[0]).toMatchObject({ author: 'Joe', state: 'drafted', draft: 'hi' });
  });
  it('summarizeRun marks verified only when every verify step found its text', () => {
    expect(summarizeRun({ id: 'r', status: 'done', steps: [{ node_id: 'v', type: 'verify', status: 'done', output: { found: true } }] }).verified).toBe(true);
    expect(summarizeRun({ id: 'r', status: 'done', steps: [{ node_id: 'v', type: 'verify', status: 'done', output: { found: false } }] }).verified).toBe(false);
  });
});
