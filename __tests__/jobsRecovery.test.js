/**
 * A restart loses the conversation, not the journal.
 *
 * Found live: the pod rolled to a new image mid-run, and every job the master was waiting on
 * answered 404 — "no such job" — even though its journal sat on disk. A 404 is unreadable to a
 * caller (transient error, or gone forever?), so the master left those runs `started` indefinitely
 * and the ONE browser session stayed occupied by work that had already ended. An interrupted job is
 * the honest answer: terminal, with everything it found before the restart still in the record.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let dir, jobs;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbjobs-'));
  process.env.PROFILE_DIR = dir;
  jobs = await import('../src/jobs.js?' + Math.random());   // DIR is read at module load
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const writeJournal = (id, patch = {}) => {
  const d = path.join(dir, 'jobs');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify({
    id, owner: 'carla', goal: 'mine reddit', status: 'running', createdAt: new Date().toISOString(),
    steps: [{ n: 1, kind: 'read', text: 'a thread' }], leads: [], proposals: [], gigs: [], replies: [], reach: [],
    opportunities: [{ name: 'Invoice Chase', evidence: [{ url: 'https://reddit.com/x', postedAt: '2026-08-20' }] }],
    ...patch,
  }));
};

describe('jobs.get after a restart', () => {
  it('a job only on disk answers as INTERRUPTED instead of vanishing — with its findings intact', () => {
    writeJournal('j-lost');
    const j = jobs.get('j-lost');
    expect(j).toBeTruthy();
    expect(j.status).toBe('interrupted');
    expect(j.opportunities[0].evidence[0].url).toBe('https://reddit.com/x');   // the product survives
  });
  it('interrupted is TERMINAL — a caller waiting on it learns to stop waiting', () => {
    writeJournal('j-lost');
    expect(jobs.isOver(jobs.get('j-lost'))).toBe(true);
  });
  it('a job that had already finished keeps its real ending, not a rewritten one', () => {
    writeJournal('j-done', { status: 'done' });
    expect(jobs.get('j-done').status).toBe('done');
  });
  it('a job that never existed is still null — the journal is not invented', () => {
    expect(jobs.get('j-never')).toBe(null);
  });
  it('a LIVE job is served from memory, untouched by the disk path', () => {
    const live = jobs.create({ owner: 'carla', goal: 'g', sessionId: 's' });
    expect(jobs.get(live.id).status).toBe('running');
    expect(jobs.isOver(jobs.get(live.id))).toBe(false);
  });
});

/*
 * The conclusion is the deliverable. A step line is cut at 4000 characters, and the finish summary
 * used to exist ONLY as a step — so a research pass's 10K-character report reached the master as its
 * first 4000: "who has the pain" survived, the rooms and the verbatim words a launch is written from
 * did not. The report now lives beside the steps, whole, and survives the journal round-trip.
 */
describe('the finish summary is kept whole as the job report', () => {
  it('setReport stores the full text while the step stays a line', () => {
    const j = jobs.create({ owner: 'carla', goal: 'mine reddit', sessionId: 's' });
    const long = '# REPORT\n' + 'the rooms and the words, verbatim. '.repeat(400);   // ~14K characters
    jobs.setReport(j, long);
    jobs.finish(j, 'idle', long);
    expect(j.report).toBe(long);
    expect(j.report.length).toBeGreaterThan(4000);
    expect(j.steps.at(-1).text.length).toBe(4000);                       // the story line is still cut
    expect(jobs.view(j).report).toBe(long);                              // and the API serves it whole
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'jobs', `${j.id}.json`), 'utf8'));
    expect(onDisk.report).toBe(long);                                    // survives a restart
  });
  it('a job without a conclusion reports null, not an empty string', () => {
    const j = jobs.create({ owner: 'carla', goal: 'g', sessionId: 's' });
    expect(jobs.view(j).report).toBe(null);
    jobs.setReport(j, '');
    expect(j.report).toBe(null);
  });
  it('an absurdly long summary is capped, not dropped', () => {
    const j = jobs.create({ owner: 'carla', goal: 'g', sessionId: 's' });
    jobs.setReport(j, 'x'.repeat(100000));
    expect(j.report.length).toBe(64000);
  });
});
