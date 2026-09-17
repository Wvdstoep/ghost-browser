/**
 * The assistant: one chat, one agent. A message starts a harness turn with the reply exit; the answer
 * (via reply() or plain prose) lands as the assistant's turn with its steps and cards; a message while
 * a turn runs is spoken into it; the history is digested into the next turn's orientation; a turn
 * resumed after a restart re-attaches to its chat. Scripted model, temp dir, no network.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OperatorRun } from '../src/operator/harness.js';
import { Registry } from '../src/operator/registry.js';
import { makeAssistant, REPLY_SPEC, labelOf } from '../src/operator/assistant.js';
import { assistantPrompt } from '../src/operator/assistantPrompt.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
const call = (name, args) => ({ content: '', toolCalls: [{ name, args }] });
const prose = (content) => ({ content, toolCalls: [] });
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A harness turn factory over a scripted model; every turn gets the same script unless a queue is given. */
function factory(scripts, seen) {
  const jobDir = tmp();
  return ({ goal, orientation, finishSpec, meta }) => {
    const turns = Array.isArray(scripts[0]) ? scripts.shift() : scripts;
    let i = 0;
    const chat = async ({ messages }) => { if (seen) seen.push(messages.map((m) => ({ ...m }))); const t = turns[Math.min(i, turns.length - 1)]; i++; return typeof t === 'function' ? t(messages) : t; };
    const reg = new Registry();
    reg.register('gb_watcher_feed', 'feed', { type: 'object', properties: { watcherId: { type: 'string' } } }, async ({ watcherId }) => ({ watcherId, items: [{ author: 'Ilya', state: 'waiting', draft: 'thanks Ilya' }] }));
    const run = new OperatorRun({ goal, chat, registry: reg, systemPrompt: 'sys', orientation, finishSpec, meta, persistDir: jobDir, startIterations: 20 });
    run.done = run.run();
    return run;
  };
}

describe('assistant', () => {
  it('answers through reply() with cards and the steps it took, and titles the chat from the first message', async () => {
    const seen = [];
    const a = makeAssistant({ dir: tmp(), startTurn: factory([
      call('gb_watcher_feed', { watcherId: 'facebook-post-watcher' }),
      call('reply', { text: '**Ilya** replied on your post — a draft is ready.', details: 'feed: 1 waiting', cards: [{ kind: 'results', watcherId: 'facebook-post-watcher', title: 'Open results' }] }),
    ], seen) });
    const c = a.create();
    expect(c.title).toBe('New chat');
    const r = a.send(c.id, 'do I have replies to react to?');
    expect(r.ok).toBe(true); expect(r.jobId).toMatch(/^op-/);
    expect(a.view(c.id).live).toBeTruthy();
    while (a.live.has(c.id)) await tick();
    const v = a.view(c.id);
    expect(v.title).toBe('do I have replies to react to?'); expect(v.live).toBeNull();
    expect(v.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    const t = v.turns[1];
    expect(t.text).toMatch(/Ilya/); expect(t.status).toBe('done'); expect(t.details).toBe('feed: 1 waiting');
    expect(t.cards[0]).toMatchObject({ kind: 'results', watcherId: 'facebook-post-watcher' });
    expect(t.steps.map((s) => s.name)).toEqual(['gb_watcher_feed']); expect(t.steps[0].label).toBe('Reading watcher results'); expect(t.steps[0].text).toMatch(/Ilya/);
    // the model was told the goal and NOT asked for a task list first
    expect(seen[0][1].content).toMatch(/GOAL: do I have replies/); expect(seen[0][1].content).not.toMatch(/save_task_list first/);
    expect(a.list()[0]).toMatchObject({ id: c.id, turns: 2, running: false });
  });

  it('takes plain prose as the answer, digests the history into the next turn, and speaks into a running turn', async () => {
    const seen = [];
    let release; const gate = new Promise((r) => { release = r; });
    const a = makeAssistant({ dir: tmp(), startTurn: factory([
      [prose('Yes — two watchers run every 15 minutes.')],
      [async () => { await gate; return prose('Understood, keeping it short.'); }],
    ], seen) });
    const c = a.create('Ops');
    a.send(c.id, 'what runs right now?');
    while (a.live.has(c.id)) await tick();
    expect(a.view(c.id).turns[1].text).toBe('Yes — two watchers run every 15 minutes.');
    expect(a.view(c.id).turns[1].steps).toEqual([]);
    // second turn: history in the orientation; a word while it runs is spoken into it
    a.send(c.id, 'shorter please');
    const spoken = a.send(c.id, 'and no jargon');
    expect(spoken.spoken).toBe(true);
    release(); while (a.live.has(c.id)) await tick();
    const v = a.view(c.id);
    expect(v.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
    expect(v.turns[3].spoken).toBe(true);
    const orient = seen[1][1].content;
    expect(orient).toMatch(/THE CONVERSATION SO FAR/); expect(orient).toMatch(/Owner: what runs right now\?/); expect(orient).toMatch(/You: Yes — two watchers/);
    expect(orient).toMatch(/Owner: shorter please/);
  });

  it('re-attaches a resumed turn by its chat id so the answer still lands', async () => {
    const dir = tmp();
    const a = makeAssistant({ dir, startTurn: factory([prose('never used')]) });
    const c = a.create('Resume');
    // a turn journal as a restart leaves it: the chat id in meta
    const reg = new Registry();
    const run = new OperatorRun({ goal: 'x', chat: async () => call('reply', { text: 'back after the restart' }), registry: reg, systemPrompt: 'sys', finishSpec: REPLY_SPEC, meta: { chatId: c.id }, persistDir: tmp() });
    run.done = run.run();
    expect(a.attach(run)).toBe(true);
    while (a.live.has(c.id)) await tick();
    expect(a.view(c.id).turns.at(-1)).toMatchObject({ role: 'assistant', text: 'back after the restart' });
    expect(a.attach({ meta: { chatId: 'nope' } })).toBe(false);
  });

  it('labels steps for people and ships a prompt that carries the ladder and the operator method', () => {
    expect(labelOf('gb_watcher_run')).toBe('Running the watcher'); expect(labelOf('gb_zzz_thing')).toBe('zzz thing');
    const p = assistantPrompt();
    expect(p).toMatch(/IS THE ANSWER ALREADY GATHERED/); expect(p).toMatch(/gb_walk/); expect(p).toMatch(/CHANGE THE SMALLEST THING/);
    expect(p).not.toMatch(/You are THE GB OPERATOR/); expect(p).not.toMatch(/FINISH through the finish tool/);
    expect(REPLY_SPEC.map({ text: 'hi', cards: [{ kind: 'approvals' }] })).toMatchObject({ status: 'done', summary: 'hi', report: { answer: 'hi', cards: [{ kind: 'approvals' }] } });
  });
});
