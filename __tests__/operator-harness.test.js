/**
 * The operator harness, driven by a scripted model: the task list is state, the identical-call
 * breaker refuses a repeat and ends a run that keeps repeating, a run ends only through finish (prose
 * alone is nudged, then finished as blocked), the budget grows with done tasks and ends the run when
 * spent, the owner's `say` lands as the next turn, and the journal is written. No network, no disk
 * beyond a temp dir.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OperatorRun } from '../src/operator/harness.js';
import { Registry } from '../src/operator/registry.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'op-'));
const scripted = (turns) => { let i = 0; return async ({ messages }) => { const t = turns[Math.min(i, turns.length - 1)]; i++; return typeof t === 'function' ? t(messages) : t; }; };
const call = (name, args) => ({ content: '', toolCalls: [{ name, args }] });
const say = (content) => ({ content, toolCalls: [] });

function baseRegistry() {
  const reg = new Registry();
  let reads = 0;
  reg.register('read_thing', 'read', { type: 'object', properties: { id: { type: 'string' } } }, async ({ id }) => ({ id, reads: ++reads, value: 'v' + id }));
  reg.register('wait_thing', 'wait', { type: 'object', properties: {} }, async () => ({ waited: true }), { repeatable: true });
  reg.register('fail_thing', 'fail', { type: 'object', properties: {} }, async () => ({ error: 'nope' }));
  return reg;
}

describe('OperatorRun', () => {
  it('runs tools, keeps the task list as state, and ends through finish with a report', async () => {
    const reg = baseRegistry();
    const chat = scripted([
      call('save_task_list', { tasks: [{ title: 'read' }, { title: 'prove' }] }),
      call('read_thing', { id: 'a' }),
      call('update_task', { index: 0, done: true, note: 'read a' }),
      call('finish', { status: 'done', summary: 'a is v-a', report: { evidence: 'read_thing returned va' } }),
    ]);
    const run = new OperatorRun({ goal: 'read a', chat, registry: reg, systemPrompt: 'sys', persistDir: tmp() });
    const v = await run.run();
    expect(v.status).toBe('done'); expect(v.finalLine).toMatch(/^DONE: a is v-a/); expect(v.report.evidence).toMatch(/va/);
    expect(v.tasks[0].done).toBe(true); expect(v.tasks[0].note).toBe('read a'); expect(v.tasks[1].done).toBe(false);
    expect(v.events.some((e) => e.kind === 'tool' && e.name === 'read_thing')).toBe(true);
  });

  it('refuses an identical non-repeatable call with a nudge, lets a repeatable one through, and stops a run that keeps repeating', async () => {
    const reg = baseRegistry();
    const chat = scripted([call('read_thing', { id: 'x' }), call('read_thing', { id: 'x' }), call('wait_thing', {}), call('wait_thing', {}), call('read_thing', { id: 'x' }), call('read_thing', { id: 'x' }), call('read_thing', { id: 'x' }), call('read_thing', { id: 'x' })]);
    const run = new OperatorRun({ goal: 'g', chat, registry: reg, systemPrompt: 'sys', persistDir: tmp() });
    const v = await run.run();
    const toolEvents = v.events.filter((e) => e.kind === 'tool');
    expect(toolEvents.filter((e) => e.name === 'read_thing').length).toBe(1);     // executed once, then refused
    expect(toolEvents.filter((e) => e.name === 'wait_thing').length).toBe(2);     // repeatable: both ran
    expect(v.status).toBe('blocked'); expect(v.finalLine).toMatch(/stuck repeating read_thing/);
    const refused = run.messages.filter((m) => m.role === 'tool' && /already called read_thing/.test(m.content));
    expect(refused.length).toBeGreaterThan(0);
  });

  it('nudges prose without tools, then finishes as blocked; a DONE: line in prose is honoured', async () => {
    const reg = baseRegistry();
    const v1 = await new OperatorRun({ goal: 'g', chat: scripted([say('thinking…'), say('still thinking'), say('and more'), say('hm')]), registry: reg, systemPrompt: 'sys', persistDir: tmp() }).run();
    expect(v1.status).toBe('blocked'); expect(v1.finalLine).toMatch(/without finishing/);
    const v2 = await new OperatorRun({ goal: 'g', chat: scripted([say('DONE: it works, verified')]), registry: reg, systemPrompt: 'sys', persistDir: tmp() }).run();
    expect(v2.status).toBe('done'); expect(v2.finalLine).toBe('DONE: it works, verified');
  });

  it('ends when the budget is spent and grows the budget as tasks get done', async () => {
    const reg = baseRegistry();
    let n = 0;
    const chat = async () => ({ content: '', toolCalls: [{ name: 'read_thing', args: { id: String(n++) } }] });
    const v = await new OperatorRun({ goal: 'g', chat, registry: reg, systemPrompt: 'sys', persistDir: tmp(), startIterations: 5, maxIterations: 8 }).run();
    expect(v.status).toBe('blocked'); expect(v.iterations).toBe(5); expect(v.finalLine).toMatch(/budget spent/);
    const reg2 = baseRegistry(); let m = 0;
    const chat2 = async () => (m === 0 ? (m++, call('save_task_list', { tasks: [{ title: 't' }] })) : m === 1 ? (m++, call('update_task', { index: 0, done: true })) : ({ content: '', toolCalls: [{ name: 'read_thing', args: { id: String(m++) } }] }));
    const v2 = await new OperatorRun({ goal: 'g', chat: chat2, registry: reg2, systemPrompt: 'sys', persistDir: tmp(), startIterations: 3, maxIterations: 10 }).run();
    expect(v2.iterations).toBe(10);   // 3 + 40 earned, capped at max 10
  });

  it('ends a run whose tools keep failing, and delivers the owner\'s say as the next user turn', async () => {
    const reg = baseRegistry(); let k = 0;
    const chat = async () => ({ content: '', toolCalls: [{ name: 'fail_thing', args: { n: k++ } }] });
    const v = await new OperatorRun({ goal: 'g', chat, registry: reg, systemPrompt: 'sys', persistDir: tmp() }).run();
    expect(v.status).toBe('blocked'); expect(v.finalLine).toMatch(/eight tool calls in a row failed/);
    const seen = [];
    const run = new OperatorRun({ goal: 'g', chat: scripted([(msgs) => { seen.push(msgs.map((x) => x.content)); run.say('look at Joe'); return call('read_thing', { id: '1' }); }, (msgs) => { seen.push(msgs.map((x) => x.content)); return call('finish', { status: 'done', summary: 'ok' }); }]), registry: reg, systemPrompt: 'sys', persistDir: tmp() });
    await run.run();
    expect(seen[1].some((c) => /The owner says: look at Joe/.test(c))).toBe(true);
  });

  it('journals the run to disk with the transcript for resume', async () => {
    const dir = tmp(); const reg = baseRegistry();
    const run = new OperatorRun({ goal: 'g', chat: scripted([call('finish', { status: 'done', summary: 'ok' })]), registry: reg, systemPrompt: 'sys', persistDir: dir });
    await run.run();
    const rec = JSON.parse(fs.readFileSync(path.join(dir, run.id + '.json'), 'utf8'));
    expect(rec.status).toBe('done'); expect(rec.messages.length).toBeGreaterThan(2); expect(rec.events.some((e) => e.kind === 'end')).toBe(true);
  });
});
