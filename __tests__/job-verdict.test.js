/*
 * THE VERDICT IS TAKEN WHEN THE WORK FINISHES, NOT WHEN SOMEBODY BUILDS A TRAINING SET.
 *
 * Labelling the whole store afterwards works — it is how the first 1,147 gold jobs were found — but
 * evidence ages. A captured file is cleaned up, a recording is deleted, a workflow run rolls out of
 * its window, and the label quietly gets worse the longer it waits.
 *
 * The other half is a product fix that stands on its own: an agent that reports an export it never
 * produced is worse than one that admits it failed, because nobody finds out until they go looking
 * for the file. So when a check contradicts the report, the job says so in its own record.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-verdict-'));
process.env.PROFILE_DIR = dir;
const jobs = await import('../src/jobs.js');
const { outcomeOf } = await import('../src/verify.js');

const newJob = (over = {}) => {
  const j = jobs.create({ owner: 'o', goal: 'do the thing', role: 'research.web', ...over });
  return j;
};

beforeEach(() => { jobs.setVerifier(null); });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('finishing a job takes its verdict', () => {
  it('lands the tier on the job record', () => {
    jobs.setVerifier((job) => outcomeOf(job, {}));
    const j = newJob();
    jobs.setReport(j, 'Had a look around.');
    jobs.finish(j, 'idle', 'done');
    expect(j.verdict).toBeTruthy();
    expect(['gold', 'silver', 'bronze', 'void']).toContain(j.verdict.tier);
    expect(j.verdict.at).toBeTruthy();
  });

  it('sees the END step, which is how a stop becomes void rather than a failure', () => {
    /* The verdict is taken AFTER the end step is written, on purpose: "stopped by you" is what
       makes voidOf answer correctly, and it does not exist a moment earlier. */
    jobs.setVerifier((job) => outcomeOf(job, {}));
    const j = newJob();
    jobs.stop(j, 'stopped by you');
    expect(j.verdict.tier).toBe('void');
    expect(j.verdict.voidReason).toMatch(/owner stopped/);
  });

  it('writes the contradiction into the job when a check fails the report', () => {
    /* The product half: the claim is wrong and the record now says which claim and why, instead of
       the failure sitting invisible until somebody looks for the file. */
    jobs.setVerifier((job) => outcomeOf(job, { files: () => [] }));
    const j = newJob();
    jobs.step(j, 'tool', 'download_url()', { tool: 'download_url', args: { url: 'https://x/v.mp4' } });
    jobs.setReport(j, 'Exported the video successfully.');
    jobs.finish(j, 'idle', 'done');
    expect(j.verdict.tier).toBe('bronze');
    expect(j.verdict.failures).toContain('fileWasProduced');
    const said = j.steps.filter((s) => s.kind === 'blocked').map((s) => s.text).join(' ');
    expect(said).toMatch(/checked:/);
    expect(said).toMatch(/fileWasProduced/);
  });

  it('says nothing extra when every check passes', () => {
    jobs.setVerifier((job) => outcomeOf(job, {}));
    const j = newJob();
    jobs.step(j, 'tool', 'type()', { tool: 'type', args: { text: 'a confirmed sentence of some length' } });
    jobs.step(j, 'type', 'typed into [3] "field": a confirmed sentence of some length');
    jobs.setReport(j, 'Typed it.');
    jobs.finish(j, 'idle', 'done');
    expect(j.verdict.tier).toBe('gold');
    expect(j.steps.some((s) => s.kind === 'blocked')).toBe(false);
  });
});

describe('the checker is injected, and nothing depends on it being there', () => {
  it('finishes normally with no verifier wired at all', () => {
    const j = newJob();
    jobs.finish(j, 'idle', 'done');
    expect(j.status).toBe('idle');
    expect(j.verdict).toBeUndefined();
  });

  it('a verifier that throws does not take the job down with it', () => {
    /* A label is never worth failing the work for. */
    jobs.setVerifier(() => { throw new Error('the file store is offline'); });
    const j = newJob();
    expect(() => jobs.finish(j, 'idle', 'done')).not.toThrow();
    expect(j.status).toBe('idle');
    expect(j.verdict).toBeUndefined();
  });

  it('a verifier returning nothing is simply no verdict', () => {
    jobs.setVerifier(() => null);
    const j = newJob();
    jobs.finish(j, 'idle', 'done');
    expect(j.verdict).toBeUndefined();
  });

  it('judging twice does not double up the record', () => {
    jobs.setVerifier((job) => outcomeOf(job, {}));
    const j = newJob();
    jobs.setReport(j, 'Looked around.');
    jobs.finish(j, 'idle', 'done');
    const first = j.verdict.at;
    /* finish() on an already-over job is a no-op; idle is not over, so this re-judges rather than
       skipping — either way there is exactly one verdict object. */
    jobs.finish(j, 'stopped', 'stopped by you');
    expect(typeof j.verdict.at).toBe(typeof first);
    expect(Array.isArray(j.verdict.why)).toBe(true);
  });
});
