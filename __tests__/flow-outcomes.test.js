// A FLOW LIST THAT DOES NOT SAY WHICH FLOWS WORK IS WHY NOTHING GETS REUSED.
//
// Carla asked why there were so many flow runs with no outcome and why the flows were never reused.
// Measured on 2026-09-11: 114 flows in the browser, 77 of them for useme alone, nearly all dead ends,
// and ONE build had left about thirty behind. The cause was not carelessness. The list a builder reads
// carried id, name, trigger, nodes, edges, owner, active, autoApprove, createdAt, updatedAt — and no
// outcome at all. The only record of "this one works" lived in the master's library across the wire,
// and that library was empty all week because of the verify bug. So a builder that dutifully listed
// the flows saw an unlabelled pile, could not tell a proven flow from a discarded probe, and wrote
// the next one. Which grew the pile, which left the following build with even less signal.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-outcomes-'));
process.env.PROFILE_DIR = TMP;
const wf = await import('../src/workflows.js');
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const serverSrc = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');

/* Write a run file straight into the run directory — the same shape the driver persists. */
const putRun = (id, workflow_id, started_at, status, steps) =>
  wf.persistRun({ id, workflow_id, started_at, status, steps });

beforeAll(() => {
  const verify = (found) => ({ node_id: 'v', type: 'verify', status: 'done', output: { found } });
  const agent = (status = 'done') => ({ node_id: 'a', type: 'agent', status, output: { report: 'x' } });

  // a flow that worked twice and still works
  putRun('r1', 'solid-scout', '2026-09-10T09:00:00Z', 'done', [agent(), verify(true)]);
  putRun('r2', 'solid-scout', '2026-09-11T09:00:00Z', 'done', [agent(), verify(true)]);
  // a flow that used to work and has since broken — both facts matter, they lead to different choices
  putRun('r3', 'drifted-scout', '2026-09-01T09:00:00Z', 'done', [agent(), verify(true)]);
  putRun('r4', 'drifted-scout', '2026-09-11T10:00:00Z', 'done', [agent(), verify(false)]);
  // a flow that has never reached its outcome — the kind the pile is full of
  putRun('r5', 'dead-probe', '2026-09-11T10:30:00Z', 'done', [agent(), verify(false)]);
  // a run that errored on the way: not verified even though a verify step said found
  putRun('r6', 'errored-flow', '2026-09-11T11:00:00Z', 'done', [agent('error'), verify(true)]);
  // a flow with no verify step at all can never be called verified
  putRun('r7', 'no-verify-flow', '2026-09-11T11:30:00Z', 'done', [agent()]);
  // a run still going is not an outcome
  putRun('r8', 'running-flow', '2026-09-11T12:00:00Z', 'running', [agent('running')]);
});

describe('latestOutcomes — the reuse signal, read back off the run files', () => {
  const o = () => wf.latestOutcomes();

  it('says a working flow has worked, how often, and that it still works', () => {
    expect(o()['solid-scout']).toMatchObject({ runs: 2, verifiedRuns: 2, verifiedEver: true, lastVerified: true, lastRunStatus: 'done' });
    expect(o()['solid-scout'].lastRunAt).toBe('2026-09-11T09:00:00Z');   // the NEWEST run, not the first
  });

  it('keeps BOTH facts about a flow that used to work and has drifted', () => {
    // verifiedEver says "this shape once reached the outcome"; lastVerified says "not any more".
    expect(o()['drifted-scout']).toMatchObject({ runs: 2, verifiedRuns: 1, verifiedEver: true, lastVerified: false });
  });

  it('never flatters a flow that has not reached its outcome', () => {
    expect(o()['dead-probe']).toMatchObject({ runs: 1, verifiedRuns: 0, verifiedEver: false, lastVerified: false });
    expect(o()['errored-flow']).toMatchObject({ verifiedEver: false });      // a step errored
    expect(o()['no-verify-flow']).toMatchObject({ verifiedEver: false });    // nothing proved anything
    expect(o()['running-flow']).toMatchObject({ verifiedEver: false, lastRunStatus: 'running' });
  });

  it('a flow nobody has run simply has no entry, and the caller reads that as zero', () => {
    expect(o()['never-run-flow']).toBeUndefined();
  });

  it('is ONE pass over the run directory, not one per flow', () => {
    // runsFor rescans every run file for a single flow; asking it per flow is flows x runs on every
    // list call, which with 114 flows is how an endpoint quietly becomes unusable.
    const src = readFileSync(fileURLToPath(new URL('../src/workflows.js', import.meta.url)), 'utf8');
    const fn = src.slice(src.indexOf('function latestOutcomes'), src.indexOf('function interruptedRuns'));
    expect(fn).toMatch(/fs\.readdirSync\(RUNDIR\)/);
    expect((fn.match(/readdirSync/g) || []).length).toBe(1);
    expect(fn).not.toMatch(/runsFor\(/);
  });
});

describe('the list endpoint hands those outcomes to whoever asks', () => {
  it('enriches every flow rather than returning bare shapes', () => {
    const at = serverSrc.indexOf("app.get('/v1/workflows', authed");
    expect(at).toBeGreaterThan(-1);
    const route = serverSrc.slice(at, at + 900);
    expect(route).toMatch(/const outcomes = workflows\.latestOutcomes\(\);/);
    for (const field of ['runs:', 'verifiedRuns:', 'verifiedEver:', 'lastRunAt:', 'lastRunStatus:', 'lastVerified:']) {
      expect(route, field).toContain(field);
    }
    expect(route).not.toMatch(/res\.json\(\{ workflows: workflows\.all\(\) \}\)/);   // the bare list is gone
  });

  it('explains what it is for, so it is not stripped back to shapes', () => {
    expect(serverSrc).toMatch(/THE FLOW LIST CARRIES ITS OUTCOMES/);
    expect(serverSrc).toMatch(/cannot tell a proven automation from an abandoned probe/);
    expect(serverSrc).toMatch(/114 flows with 77 for a single site/);
  });
});
