import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OperatorRun } from '../src/operator/harness.js';
import { Registry } from '../src/operator/registry.js';

it.each([
  [new Error('quota exhausted'), 'quota exhausted'],
  ['every model key is out of allowance (0 of 3 usable)', 'every model key is out of allowance (0 of 3 usable)'],
  [{ error: 'quota exhausted' }, 'quota exhausted'],
  [null, 'Model request failed'],
])('preserves a rejected model request in the journal: %s', async (failure, expected) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-error-'));
  vi.useFakeTimers();
  try {
    const run = new OperatorRun({
      goal: 'generate the video', systemPrompt: 'test', registry: new Registry(), persistDir: dir,
      chat: async () => { throw failure; },
    });
    const done = run.run();
    await vi.runAllTimersAsync();
    await done;
    expect(run.status).toBe('error');
    expect(run.error).toBe(expected);
    expect(run.finalLine).toContain(expected);
    expect(JSON.parse(fs.readFileSync(path.join(dir, run.id + '.json'), 'utf8')).error).toBe(expected);
  } finally { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('clears a transient provider error after the model recovers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-recover-'));
  vi.useFakeTimers();
  try {
    let attempts = 0;
    const run = new OperatorRun({
      goal: 'generate the video', systemPrompt: 'test', registry: new Registry(), persistDir: dir,
      chat: async () => {
        if (attempts++ === 0) throw 'temporary provider failure';
        return { content: '', toolCalls: [{ name: 'finish', args: { status: 'done', summary: 'verified' } }] };
      },
    });
    const done = run.run();
    await vi.runAllTimersAsync();
    await done;
    expect(run.status).toBe('done');
    expect(run.error).toBeNull();
  } finally { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); }
});
