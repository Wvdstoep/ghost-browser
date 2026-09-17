/**
 * Auto-resume: a job whose journal says `running` when the process comes back is picked up with its
 * task list, budget and a digest of its last steps; the model is told it resumed; a job interrupted
 * MAX_RESUMES times is marked interrupted instead of coming back forever. Journals live in a temp dir.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OperatorRun, interruptedJobs, MAX_RESUMES } from '../src/operator/harness.js';
import { Registry } from '../src/operator/registry.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'op-'));
const scripted = (turns) => { let i = 0; return async ({ messages }) => { const t = turns[Math.min(i, turns.length - 1)]; i++; return typeof t === 'function' ? t(messages) : t; }; };
const call = (name, args) => ({ content: '', toolCalls: [{ name, args }] });

function reg() {
  const r = new Registry();
  r.register('read_thing', 'read', { type: 'object', properties: { id: { type: 'string' } } }, async ({ id }) => ({ id, value: 'v' + id }));
  return r;
}

/** A journal as a roll leaves it: status running, two tasks (one done), a few events. */
function interruptedJournal(dir, extra = {}) {
  const rec = {
    id: 'op-test-1', goal: 'prove b', status: 'running', iterations: 3, budget: 190, resumes: 0,
    tasks: [{ i: 1, title: 'read a', done: true, note: 'a is va' }, { i: 2, title: 'prove b', done: false }],
    events: [{ t: 1, kind: 'thought', text: 'reading a' }, { t: 2, kind: 'tool', name: 'read_thing', args: { id: 'a' } }, { t: 3, kind: 'result', name: 'read_thing', text: '{"value":"va"}' }],
    startedAt: 1000, endedAt: 0, error: null, messages: [{ role: 'system', content: 'sys' }, { role: 'tool', content: 'stray' }], ...extra,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, rec.id + '.json'), JSON.stringify(rec));
  return rec;
}

describe('operator auto-resume', () => {
  it('lists only journals left running, oldest first, and retires one resumed too often', () => {
    const dir = tmp();
    interruptedJournal(dir);
    interruptedJournal(dir, { id: 'op-test-0', startedAt: 500 });
    interruptedJournal(dir, { id: 'op-done', status: 'done' });
    interruptedJournal(dir, { id: 'op-tired', resumes: MAX_RESUMES });
    const jobs = interruptedJobs(dir);
    expect(jobs.map((j) => j.id)).toEqual(['op-test-0', 'op-test-1']);
    const tired = JSON.parse(fs.readFileSync(path.join(dir, 'op-tired.json'), 'utf8'));
    expect(tired.status).toBe('interrupted'); expect(tired.finalLine).toMatch(/not resumed again/);
  });

  it('resumes with the task list, budget, a digest of the last steps and the raw transcript NOT replayed', async () => {
    const dir = tmp(); const rec = interruptedJournal(dir);
    let firstMessages = null;
    const chat = scripted([
      (messages) => { firstMessages = messages.map((m) => ({ ...m })); return call('read_thing', { id: 'b' }); },
      call('update_task', { index: 1, done: true, note: 'b is vb' }),
      call('finish', { status: 'done', summary: 'b proven', report: { evidence: 'vb' } }),
    ]);
    const run = new OperatorRun({ goal: 'ignored — the journal wins', restore: interruptedJobs(dir)[0], chat, registry: reg(), systemPrompt: 'sys', persistDir: dir });
    expect(run.id).toBe(rec.id); expect(run.goal).toBe('prove b'); expect(run.budget).toBe(190); expect(run.iterations).toBe(3);
    const v = await run.run();
    expect(v.status).toBe('done'); expect(v.resumes).toBe(1); expect(v.iterations).toBe(6);
    // the model saw: system, orientation with the carried task list, then the resume digest — no stray tool turn
    expect(firstMessages[0].role).toBe('system');
    expect(firstMessages[1].content).toMatch(/\[x\] 1\. read a — a is va/); expect(firstMessages[1].content).toMatch(/\[ \] 2\. prove b/);
    expect(firstMessages[2].content).toMatch(/^\[Resumed\]/); expect(firstMessages[2].content).toMatch(/call read_thing/); expect(firstMessages[2].content).toMatch(/resume 1, 3 iterations/);
    expect(firstMessages.some((m) => m.content === 'stray')).toBe(false);
    // the journal is the same file, now done, carrying the resume count and the resume event
    const j = JSON.parse(fs.readFileSync(path.join(dir, rec.id + '.json'), 'utf8'));
    expect(j.status).toBe('done'); expect(j.resumes).toBe(1); expect(j.events.some((e) => e.kind === 'resume')).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([rec.id + '.json']);
  });

  it('counts resumes across restarts so the cap is reached', () => {
    const dir = tmp(); interruptedJournal(dir, { resumes: MAX_RESUMES - 1 });
    const run = new OperatorRun({ goal: 'x', restore: interruptedJobs(dir)[0], chat: async () => ({ content: '', toolCalls: [] }), registry: reg(), systemPrompt: 'sys', persistDir: dir });
    run.status = 'running'; run._persist();   // as a roll would leave it
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'op-test-1.json'), 'utf8'));
    expect(j.resumes).toBe(MAX_RESUMES);
    expect(interruptedJobs(dir)).toEqual([]);   // next boot: retired, not resumed a fourth time
  });
});
