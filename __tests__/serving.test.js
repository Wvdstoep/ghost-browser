/*
 * SERVING THE STUDENT - the ways it could go wrong quietly:
 *   - the student gets a prompt shaped differently from the one it was trained on (parity);
 *   - a lost student keeps driving (strikes);
 *   - a canary job changes hands mid-way (decided once per job);
 *   - the ledger counts a different model's numbers as this one's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import student from '../src/student.js';
import router from '../src/router.js';
import shadow from '../src/shadow.js';
import traceset from '../src/traceset.js';
import localPrompt from '../src/localPrompt.js';

const step = (kind, text, extra = {}) => ({ kind, text, at: 'x', ...extra });
const job = () => ({
  id: 'j-1', goal: 'Find the cheapest bakfiets on marktplaats.nl', profile: 'default', role: 'general',
  steps: [
    step('you', 'Find the cheapest bakfiets on marktplaats.nl'),
    step('tool', 'open(https://www.marktplaats.nl)', { tool: 'open', args: { url: 'https://www.marktplaats.nl' } }),
    step('open', 'https://www.marktplaats.nl'),
    step('tool', 'look()', { tool: 'look', args: {} }),
    step('look', 'Marktplaats — 12 things to click', { marks: '[1] Zoeken\n[2] Fietsen' }),
    step('tool', 'read()', { tool: 'read', args: {} }),
    step('read', 'read the page (900 characters)', { content: 'You are on: https://www.marktplaats.nl\n\nPage text:\nBakfiets 250 euro' }),
  ],
});
const tools = [{ function: { name: 'open', description: 'Go to a web address.', parameters: { properties: { url: {} }, required: ['url'] } } }, { function: { name: 'look', description: 'Look.' } }, { function: { name: 'read', description: 'Read.' } }, { function: { name: 'click', description: 'Click.', parameters: { properties: { index: {} }, required: ['index'] } } }];

describe('the student prompt', () => {
  it('is the training prompt, built from the same record', () => {
    const j = job();
    const live = student.promptFor(j, { role: 'general', tools, playbook: '' });
    /* The training turn that would be cut AFTER the last observation sees exactly this history. */
    j.steps.push(step('tool', 'click(2)', { tool: 'click', args: { index: 2 } }));
    const turns = traceset.turnsOf(j);
    const last = turns[turns.length - 1];
    const trained = localPrompt.userFor({ goal: last.goal, observed: last.observed });
    expect(live[1].content).toBe(trained);
    expect(live[0].content).toContain('open(url)');
    expect(live[1].content).toContain('Page text:');
  });

  it('reads the one JSON object out of whatever the student said', () => {
    expect(student.parseCall('{"tool":"click","args":{"index":2}}')).toEqual({ name: 'click', args: { index: 2 } });
    expect(student.parseCall('Sure. {"tool":"finish","args":{"summary":"done"}} ok')).toEqual({ name: 'finish', args: { summary: 'done' } });
    expect(student.parseCall('I would click it.')).toBeNull();
    expect(student.parseCall('{"args":{}}')).toBeNull();
  });

  it('compares calls the way the exam does', () => {
    expect(student.compare({ name: 'open', args: { url: 'https://example.org/a' } }, { name: 'open', args: { url: 'http://www.example.org/a/?x=1' } })).toEqual({ tool: true, args: true });
    expect(student.compare({ name: 'open', args: { url: 'https://example.org/a' } }, { name: 'open', args: { url: 'https://example.org/b' } })).toEqual({ tool: true, args: false });
    expect(student.compare({ name: 'click', args: { index: 2 } }, { name: 'look', args: {} })).toEqual({ tool: false, args: false });
    expect(student.compare({ name: 'type', args: { index: 1, text: 'Utrecht Centraal' } }, { name: 'type', args: { index: 1, text: 'utrecht  centraal' } }).args).toBe(true);
    expect(student.compare({ name: 'look', args: {} }, null)).toEqual({ tool: false, args: false });
  });
});

describe('who drives', () => {
  it('never asks the student when off or unconfigured', () => {
    expect(router.decide({ mode: 'off', model: 'gb' }).drive).toBe('teacher');
    expect(router.decide({ mode: 'primary', model: '' })).toMatchObject({ drive: 'teacher', shadow: false });
  });
  it('shadows: the teacher drives and the student is asked beside it', () => {
    expect(router.decide({ mode: 'shadow', model: 'gb', jobId: 'j' })).toMatchObject({ drive: 'teacher', shadow: true });
  });
  it('gives the canary a share of the jobs, decided once per job', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `j-${i}`);
    const mine = ids.filter((id) => router.decide({ mode: 'canary', share: 0.1, model: 'gb', jobId: id }).drive === 'student').length;
    expect(mine).toBeGreaterThan(150);
    expect(mine).toBeLessThan(250);
    const a = router.decide({ mode: 'canary', share: 0.1, model: 'gb', jobId: 'j-7' }).drive;
    expect(router.decide({ mode: 'canary', share: 0.1, model: 'gb', jobId: 'j-7' }).drive).toBe(a);
  });
  it('hands a job back to the teacher after three strikes', () => {
    expect(router.decide({ mode: 'primary', model: 'gb', strikes: 2 }).drive).toBe('student');
    expect(router.decide({ mode: 'primary', model: 'gb', strikes: 3 })).toMatchObject({ drive: 'teacher', shadow: false });
  });
  it('knows what a lost student looks like', () => {
    const allowed = new Set(['look', 'click', 'open']);
    expect(router.looksWrong({ call: null })).toMatch(/not answer/);
    expect(router.looksWrong({ call: { name: 'sweep', args: {} }, allowed })).toMatch(/not one of/);
    expect(router.looksWrong({ call: { name: 'click', args: { index: 14 } }, allowed, marksCount: 12 })).toMatch(/\[14\]/);
    const c = { name: 'look', args: {} };
    expect(router.looksWrong({ call: c, allowed, recent: [c, c] })).toMatch(/third time/);
    expect(router.looksWrong({ call: { name: 'click', args: { index: 3 } }, allowed, marksCount: 12, recent: [c, c] })).toBeNull();
  });
  it('shapes the student answer like a teacher reply', () => {
    const r = router.asReply({ name: 'click', args: { index: 2 } });
    expect(r.toolCalls).toEqual([{ name: 'click', args: { index: 2 } }]);
    expect(r.raw.message.tool_calls[0].function.name).toBe('click');
    expect(r.student).toBe(true);
  });
});

describe('the live ledger', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-shadow-')); process.env.PROFILE_DIR = dir; });
  afterEach(() => { delete process.env.PROFILE_DIR; try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

  it('counts agreement per tool and per role, and keeps the recent ones whole', () => {
    shadow.record({ jobId: 'j', role: 'general', step: 3, teacher: { name: 'look', args: {} }, student: { name: 'look', args: {} }, agree: true, argsAgree: true, model: 'gb:v1' });
    shadow.record({ jobId: 'j', role: 'general', step: 4, teacher: { name: 'open', args: { url: 'a' } }, student: { name: 'look', args: {} }, agree: false, argsAgree: false, model: 'gb:v1' });
    shadow.record({ jobId: 'j', role: 'general', step: 5, teacher: { name: 'open', args: { url: 'a' } }, student: null, agree: false, argsAgree: false, model: 'gb:v1' });
    const s = shadow.state();
    expect(s.seen).toBe(3);
    expect(s.agreePct).toBe(33.3);
    expect(s.unusablePct).toBe(33.3);
    expect(s.perTool.find((t) => t.name === 'open')).toMatchObject({ seen: 2, agree: 0 });
    expect(s.recent[0].student).toBe('(nothing usable)');
  });

  it('starts over when the model changes, so the numbers are always about one model', () => {
    shadow.record({ teacher: { name: 'look', args: {} }, student: { name: 'look', args: {} }, agree: true, argsAgree: true, model: 'gb:v1' });
    shadow.record({ teacher: { name: 'look', args: {} }, student: null, model: 'gb:v2' });
    const s = shadow.state();
    expect(s.model).toBe('gb:v2');
    expect(s.seen).toBe(1);
  });

  it('counts the steps the student drove and the fallbacks', () => {
    shadow.drove({ jobId: 'a' }); shadow.drove({ jobId: 'a' }); shadow.drove({ jobId: 'a', fallback: true, why: 'it repeated look a third time' });
    expect(shadow.state().driven).toMatchObject({ steps: 3, fallbacks: 1, fallbackPct: 33.3, jobs: 1 });
  });
});
