/**
 * A recording as a pod of its own (Phase 3): the Job it asks for, the engine handing a recording to the
 * cluster and taking it back when the cluster says no, the pod's journal merged into ours, a pod gone
 * or silent closed as a playable partial, and the pod's own bookkeeping of what is safe to push.
 * No cluster here: the remote is faked, the Job spec is inspected.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobSpec, jobAlive } from '../src/recorder/k8s.js';
import { Recorder, MIN_FREE_BYTES, STALE_MS } from '../src/recorder/engine.js';
import { readySegments } from '../src/recorder/recorder-main.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rec-remote-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, debug() {} };
const baseDeps = () => ({ capabilities: () => ({ ok: true }), freeBytes: () => 100 * MIN_FREE_BYTES, sizeOf: () => ({ width: 1280, height: 720 }),
  cookiesFor: async () => [], startDisplay: async () => ({ n: 101, stop() {} }), startPulse: async () => ({ server: 'unix:/x', stop() {} }),
  launchBrowser: async () => ({ pages: () => [{ goto: async () => {}, title: async () => 'T' }], addCookies: async () => {}, close: async () => {} }),
  preparePage: async () => ({}), videoState: async () => ({ ended: false, paused: false, currentTime: 1, duration: 100, href: 'https://x/v' }),
  startFfmpeg: ({ out }) => { fs.writeFileSync(path.join(out, 'index.m3u8'), '#EXTM3U\n'); const proc = { exitCode: null }; return { proc, stop: async () => { proc.exitCode = 0; return { code: 0 }; } }; } });

describe('a recording as a pod of its own', () => {
  it('asks for a Job with the recording\'s token, its own resources, a scratch disk, labels and a TTL — and no service account token', () => {
    const s = jobSpec({ id: 'rec-abc', namespace: 'pod-x', image: 'wvdstoep/ghost-browser:v340', gbUrl: 'http://ghost-browser:3000', token: 'tok', imagePullSecrets: ['regcred'] });
    expect(s.metadata.name).toBe('ghost-browser-rec-rec-abc'); expect(s.metadata.labels['gb/recording']).toBe('rec-abc');
    const c = s.spec.template.spec.containers[0];
    expect(c.image).toBe('wvdstoep/ghost-browser:v340');
    expect(Object.fromEntries(c.env.map((e) => [e.name, e.value]))).toMatchObject({ MODE: 'recorder', RECORDING_ID: 'rec-abc', GB_URL: 'http://ghost-browser:3000', RECORDING_TOKEN: 'tok', RECORDINGS_DIR: '/scratch' });
    expect(c.resources.requests).toEqual({ cpu: '1', memory: '1536Mi' }); expect(c.resources.limits).toEqual({ cpu: '2', memory: '3Gi' });
    expect(s.spec.template.spec.volumes.find((v) => v.name === 'scratch').emptyDir.sizeLimit).toBe('20Gi');
    expect(s.spec.template.spec.automountServiceAccountToken).toBe(false); expect(s.spec.template.spec.imagePullSecrets).toEqual([{ name: 'regcred' }]);
    expect(s.spec.ttlSecondsAfterFinished).toBe(600); expect(s.spec.backoffLimit).toBe(0); expect(s.spec.template.spec.restartPolicy).toBe('Never');
    expect(jobAlive({ status: { active: 1 } })).toBe(true); expect(jobAlive({ status: { succeeded: 1 } })).toBe(false); expect(jobAlive({ status: { failed: 1 } })).toBe(false); expect(jobAlive({ status: {} })).toBe(true);
  });

  it('hands a recording to the cluster: journal says mode job with a token, the pod\'s updates merge in, stop is a flag the pod reads', async () => {
    const launched = []; const remote = { available: () => true, launch: async (rec) => { launched.push(rec.id); return { jobName: 'ghost-browser-rec-' + rec.id }; }, alive: async () => true, stop: () => true };
    const r = new Recorder({ root: tmp(), deps: { ...baseDeps(), remote }, log: quiet });
    const v = r.start({ url: 'https://x/v', profile: 'google', until: 'video-ends' });
    expect(v.mode).toBe('job'); expect(v.live).toBe(true); expect(v.token).toBeUndefined();   // the token never leaves in a view
    expect(r.tokenOf(v.id)).toMatch(/^[0-9a-f]{48}$/); expect(r.running()).toEqual([]); expect(r.runningRemote()).toEqual([v.id]);
    await sleep(20); expect(launched).toEqual([v.id]); expect(r.get(v.id).jobName).toBe('ghost-browser-rec-' + v.id);
    const h = r.handoff(v.id); expect(h).toMatchObject({ id: v.id, url: 'https://x/v', profile: 'google', until: 'video-ends', stop: '' });
    // the pod's numbers are ignored: what counts is what arrived here (the pod deletes what it pushed)
    expect(r.remoteUpdate(v.id, { state: 'recording', seconds: 30, bytes: 1000, segments: 3, pageTitle: 'T', mode: 'local', url: 'https://evil' })).toMatchObject({ state: 'recording', seconds: 0, segments: 0, pageTitle: 'T', mode: 'job', url: 'https://x/v' });
    fs.writeFileSync(path.join(r.dirOf(v.id), 'index.m3u8'), '#EXTM3U\n#EXTINF:10.000,\nseg-00000.ts\n#EXTINF:10.000,\nseg-00001.ts\n'); fs.writeFileSync(path.join(r.dirOf(v.id), 'seg-00000.ts'), Buffer.alloc(40)); fs.writeFileSync(path.join(r.dirOf(v.id), 'seg-00001.ts'), Buffer.alloc(2));
    expect(r.remoteUpdate(v.id, { state: 'recording' })).toMatchObject({ seconds: 20, segments: 2, bytes: 42 });
    expect(r.remove(v.id)).toEqual({ error: 'still recording — stop it first' });
    expect(r.stop(v.id)).toEqual({ ok: true, id: v.id, remote: true }); expect(r.handoff(v.id).stop).toBe('stopped by the owner');
    fs.writeFileSync(path.join(r.dirOf(v.id), 'index.m3u8'), '#EXTM3U\n#EXTINF:10.000,\nseg-00001.ts\n'); fs.writeFileSync(path.join(r.dirOf(v.id), 'seg-00001.ts'), Buffer.alloc(5));
    expect(r.remoteUpdate(v.id, { state: 'done', reason: 'stopped by the owner', seconds: 10, segments: 1, bytes: 5 }).live).toBe(false);
    expect(fs.readFileSync(path.join(r.dirOf(v.id), 'index.m3u8'), 'utf8')).toMatch(/ENDLIST/);
    expect(r.remove(v.id)).toEqual({ removed: true });
  });

  it('records here when the cluster says no, and the journal says why', async () => {
    const remote = { available: () => true, launch: async () => { throw new Error('jobs.batch is forbidden'); }, alive: async () => true, stop: () => true };
    const r = new Recorder({ root: tmp(), deps: { ...baseDeps(), remote }, log: quiet, tickMs: 20 });
    const v = r.start({ url: 'https://x/v', until: 'owner-stop' }); expect(v.mode).toBe('job');
    await sleep(60); const j = r.get(v.id); expect(j.mode).toBe('local'); expect(j.fallback).toMatch(/forbidden/); expect(r.running()).toEqual([v.id]); expect(r.tokenOf(v.id)).toBe('');
    r.stop(v.id); await sleep(80);
  });

  it('a Job the cluster accepted but never gave a pod (a quota) is taken back and the recording runs here', async () => {
    const cancelled = []; const remote = { available: () => true, launch: async () => ({ jobName: 'j-q' }), alive: async () => true, stop: () => true, podExists: async () => false, cancel: async (rec) => { cancelled.push(rec.id); return true; } };
    const r = new Recorder({ root: tmp(), deps: { ...baseDeps(), remote }, log: quiet, tickMs: 20, launchGraceMs: 30 });
    const v = r.start({ url: 'https://x/v', until: 'owner-stop' }); expect(v.mode).toBe('job');
    await sleep(120);
    const j = r.get(v.id); expect(cancelled).toEqual([v.id]); expect(j.mode).toBe('local'); expect(j.fallback).toMatch(/no pod/); expect(r.running()).toEqual([v.id]); expect(r.demand.refusedRemote).toBe(1);
    r.stop(v.id); await sleep(80);
    // a Job that DID get a pod is left alone
    const ok = { ...remote, podExists: async () => true, cancel: async () => { throw new Error('must not cancel'); } };
    const r2 = new Recorder({ root: tmp(), deps: { ...baseDeps(), remote: ok }, log: quiet, launchGraceMs: 20 });
    const w = r2.start({ url: 'https://x/w' }); await sleep(80); expect(r2.get(w.id).mode).toBe('job'); expect(r2.runningRemote()).toEqual([w.id]);
  });

  it('a pod that is gone, or silent too long, leaves a playable partial; a live one is left alone', async () => {
    let t = 1000; let alive = true;
    const remote = { available: () => true, launch: async () => ({ jobName: 'j' }), alive: async () => alive, stop: () => true };
    const r = new Recorder({ root: tmp(), deps: { ...baseDeps(), remote }, log: quiet, clock: () => t });
    const v = r.start({ url: 'https://x/v' }); await sleep(10);
    fs.writeFileSync(path.join(r.dirOf(v.id), 'index.m3u8'), '#EXTM3U\n#EXTINF:10.000,\nseg-00001.ts\n'); fs.writeFileSync(path.join(r.dirOf(v.id), 'seg-00001.ts'), Buffer.alloc(7));
    r.remoteUpdate(v.id, { state: 'recording' });
    expect(await r.reconcile()).toBe(0);
    t += STALE_MS + 1; expect(await r.reconcile()).toBe(1); expect(r.get(v.id)).toMatchObject({ state: 'partial', segments: 1, reason: 'the recorder pod went silent' });
    const w = r.start({ url: 'https://x/w' }); await sleep(10); r.remoteUpdate(w.id, { state: 'recording' }); alive = false;
    expect(await r.reconcile()).toBe(1); expect(r.get(w.id)).toMatchObject({ state: 'failed', reason: 'the recorder pod is gone' });
    expect(r.adopt()).toBe(0);   // adopt() leaves pods of their own to reconcile()
  });

  it('a playback ticket opens one recording\'s media for a while, never another\'s, never after it expires, and survives a restart', () => {
    let t = 5000; const root = tmp();
    const r = new Recorder({ root, deps: baseDeps(), log: quiet, clock: () => t });
    const tk = r.ticket('rec-a', 1000); expect(tk.t).toMatch(/^6000\.[0-9a-f]{32}$/); expect(tk.exp).toBe(6000);
    expect(r.checkTicket('rec-a', tk.t)).toBe(true); expect(r.checkTicket('rec-b', tk.t)).toBe(false); expect(r.checkTicket('rec-a', tk.t.replace(/.$/, 'x'))).toBe(false); expect(r.checkTicket('rec-a', '')).toBe(false);
    t = 6001; expect(r.checkTicket('rec-a', tk.t)).toBe(false);
    const r2 = new Recorder({ root, deps: baseDeps(), log: quiet, clock: () => 5000 }); expect(r2.checkTicket('rec-a', tk.t)).toBe(true);   // the secret is on disk
  });

  it('the pod pushes only segments that are complete: never the one being written, all of them at the end', () => {
    const d = tmp(); for (const n of ['seg-00001.ts', 'seg-00002.ts', 'seg-00003.ts']) fs.writeFileSync(path.join(d, n), '');
    const pushed = new Set(['seg-00001.ts']);
    expect(readySegments(d, pushed)).toEqual(['seg-00002.ts']); expect(readySegments(d, pushed, true)).toEqual(['seg-00002.ts', 'seg-00003.ts']);
    expect(readySegments('/nope', pushed)).toEqual([]);
  });
});
