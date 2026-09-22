/*
 * The gate that protects a production roll, tested without a browser.
 *
 * Every case below is a state that really happened and was read wrong: a session whose job record
 * had aged out blocked a built image for two hours; a parked `idle` conversation counted as work;
 * and the log said "1 active session" with three counts already summed, so none of it was visible.
 */
import { describe, it, expect } from 'vitest';
import { readiness, explain } from '../src/deployReadiness.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

describe('deploy readiness — what blocks a roll', () => {
  it('nothing open means ready', () => {
    const r = readiness({}, NOW);
    expect(r.busy).toBe(0);
    expect(explain(r)).toMatch(/nothing is holding/);
  });

  it('a session driving a running job blocks', () => {
    const r = readiness({ sessions: [{ sessionId: 's-1', profile: 'capcut', lastUsed: NOW,
      job: { jobId: 'j-1', role: 'capcut-video-editor', status: 'running' } }] }, NOW);
    expect(r.busy).toBe(1);
    expect(r.blocking[0].why).toMatch(/driving job j-1 \(capcut-video-editor\) in profile capcut/);
  });

  it('a session parked on an idle job does NOT block — idle is finished, waiting for a person', () => {
    const r = readiness({ sessions: [{ sessionId: 's-mucqqgm0-cgfbcd', profile: 'ghostbrowser',
      lastUsed: NOW - 20 * MIN, job: { jobId: 'j-mucqqgm5-irqu5', role: 'learn.shot', status: 'idle' } }] }, NOW);
    expect(r.busy).toBe(0);
    expect(r.parked).toHaveLength(1);
    expect(r.parked[0].why).toMatch(/job j-mucqqgm5-irqu5 is idle, not running/);
  });

  it.each(['done', 'failed', 'stopped', 'interrupted'])('a session on a %s job does not block', (status) => {
    const r = readiness({ sessions: [{ sessionId: 's-1', lastUsed: NOW, job: { jobId: 'j-1', status } }] }, NOW);
    expect(r.busy).toBe(0);
  });

  it('a jobless session touched just now blocks — that is a person in their own browser', () => {
    const r = readiness({ sessions: [{ sessionId: 's-1', profile: 'facebook', lastUsed: NOW - 30_000, job: null }] }, NOW);
    expect(r.busy).toBe(1);
    expect(r.blocking[0].why).toMatch(/someone is probably in it/);
  });

  it('a jobless session nobody has touched does NOT block — this is the two-hour bug', () => {
    /* The job store had aged the record out, so the lookup answered null and the session read
       exactly like a person typing in it. Untouched for an hour is not a person. */
    const r = readiness({ sessions: [{ sessionId: 's-1', profile: 'ghostbrowser', lastUsed: NOW - 61 * MIN, job: null }] }, NOW);
    expect(r.busy).toBe(0);
    expect(r.parked[0].why).toMatch(/untouched for 61 min and holding no job/);
  });

  it('a session with no lastUsed at all is treated as stale, not as busy', () => {
    const r = readiness({ sessions: [{ sessionId: 's-1', job: null }] }, NOW);
    expect(r.busy).toBe(0);
  });

  it('a running watcher pass blocks', () => {
    expect(readiness({ watchers: ['facebook-post-polish'] }, NOW).busy).toBe(1);
  });

  it('a recording blocks — a roll would truncate the file', () => {
    const r = readiness({ recordings: ['rec-1'] }, NOW);
    expect(r.busy).toBe(1);
    expect(r.blocking[0].why).toMatch(/truncate/);
  });

  it('a live assistant turn blocks', () => {
    const r = readiness({ chats: [{ id: 'chat-1', title: 'make a viral short', startedAt: NOW - 2 * MIN }] }, NOW);
    expect(r.busy).toBe(1);
    expect(r.blocking[0].why).toMatch(/started 2 min ago/);
  });

  it('an assistant turn running longer than any real turn is stuck, not busy', () => {
    const r = readiness({ chats: [{ id: 'chat-1', title: 'x', startedAt: NOW - 90 * MIN }] }, NOW);
    expect(r.busy).toBe(0);
    expect(r.parked[0].why).toMatch(/treating it as stuck/);
  });

  it('reports the parked holders even when nothing blocks — that sentence was what was missing', () => {
    const r = readiness({
      sessions: [{ sessionId: 's-1', profile: 'ghostbrowser', lastUsed: NOW - 40 * MIN, job: { jobId: 'j-1', status: 'idle' } }],
      chats: [{ id: 'chat-1', title: 'nightly', startedAt: NOW - 120 * MIN }],
    }, NOW);
    expect(r.busy).toBe(0);
    expect(r.holders).toHaveLength(2);
    expect(explain(r)).toMatch(/^parked session s-1:/m);
    expect(explain(r)).not.toMatch(/BLOCKS/);
  });

  it('every holder is named, so a log line can never be a bare number again', () => {
    const r = readiness({
      sessions: [{ sessionId: 's-1', lastUsed: NOW, job: { jobId: 'j-1', status: 'running' } }],
      watchers: ['w-1'], recordings: ['rec-1'],
      chats: [{ id: 'chat-1', startedAt: NOW }],
    }, NOW);
    expect(r.busy).toBe(4);
    for (const line of explain(r).split('\n')) expect(line).toMatch(/^BLOCKS \w+ [\w-]+: .+/);
  });

  it('the freshness window is adjustable without editing the rule', () => {
    const snap = { sessions: [{ sessionId: 's-1', lastUsed: NOW - 10 * MIN, job: null }] };
    expect(readiness(snap, NOW).busy).toBe(0);
    expect(readiness(snap, NOW, { freshMs: 15 * MIN }).busy).toBe(1);
  });

  it('junk in the snapshot is ignored rather than counted as work', () => {
    const r = readiness({ sessions: [null, {}, { sessionId: '' }], watchers: [''], recordings: [null], chats: [{}] }, NOW);
    expect(r.busy).toBe(0);
    expect(r.holders).toHaveLength(0);
  });
});
