/**
 * STOP that bites: the owner's stop ends a turn that is inside a waiting tool (the tool sees the flag),
 * fires the stop hooks (the walk it waited on), and the journal keeps the request so a restart never
 * resumes a stopped turn. A turn also has a wall clock: past it, it ends as blocked instead of browsing
 * for an hour. Pure: scripted model, no browser, journals in a temp dir.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OperatorRun, interruptedJobs } from '../src/operator/harness.js';
import { Registry } from '../src/operator/registry.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'op-stop-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (name, args = {}) => ({ content: '', toolCalls: [{ name, args }] });

describe('a stop that bites', () => {
  it('ends a turn stuck in a waiting tool, fires the hooks, and the view says stopping meanwhile', async () => {
    const dir = tmp(); const ctx = { stopped: () => false };
    const reg = new Registry();
    reg.register('wait_walk', 'wait', { type: 'object', properties: {} }, async () => { while (!ctx.stopped()) await sleep(5); return { stopped: true }; }, { repeatable: true });
    const run = new OperatorRun({ goal: 'browse for an hour', chat: async () => call('wait_walk'), registry: reg, systemPrompt: 'sys', persistDir: dir });
    ctx.stopped = () => run.stopped();
    let walksStopped = 0; run.onStop(() => { walksStopped++; });
    const done = run.run();
    await sleep(30);
    expect(run.view().status).toBe('running');
    run.stop();
    expect(run.view().status).toBe('stopping');
    expect(walksStopped).toBe(1);
    const v = await done;
    expect(v.status).toBe('stopped');
    expect(JSON.parse(fs.readFileSync(path.join(dir, run.id + '.json'), 'utf8')).stopRequested).toBe(true);
    run.stop(); expect(walksStopped).toBe(1);   // a second press is a no-op
  });

  it('a journal left running WITH a stop request is retired as stopped, never resumed', () => {
    const dir = tmp(); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'op-s.json'), JSON.stringify({ id: 'op-s', goal: 'g', status: 'running', stopRequested: true, iterations: 2, budget: 60, resumes: 0, tasks: [], events: [], startedAt: 1, messages: [] }));
    fs.writeFileSync(path.join(dir, 'op-r.json'), JSON.stringify({ id: 'op-r', goal: 'g', status: 'running', iterations: 2, budget: 60, resumes: 0, tasks: [], events: [], startedAt: 2, messages: [] }));
    expect(interruptedJobs(dir).map((r) => r.id)).toEqual(['op-r']);
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'op-s.json'), 'utf8')); expect(s.status).toBe('stopped'); expect(s.finalLine).toMatch(/stopped by the owner/);
  });

  it('a turn past its wall clock ends as blocked with the time named', async () => {
    const dir = tmp(); let t = 0; const now = () => (t += 10 * 60 * 1000);   // ten minutes per look at the clock
    const reg = new Registry(); reg.register('poke', 'poke', { type: 'object', properties: {} }, async () => ({ ok: true }), { repeatable: true });
    const run = new OperatorRun({ goal: 'never ends', chat: async () => call('poke'), registry: reg, systemPrompt: 'sys', persistDir: dir, now, maxMs: 30 * 60 * 1000 });
    const v = await run.run();
    expect(v.status).toBe('blocked'); expect(v.finalLine).toMatch(/ran out of time \(30 min\)/);
    expect(run.iterations).toBeLessThan(10);
  });
});
