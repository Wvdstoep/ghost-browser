// sync-backoff.test.js — a failed image delivery backs off, says why, and is paced (2026-11-21).
//
// gb-sync-tenants.sh (every 15 min) sent the 2.7 GB browser image to Ben's cluster 154 times in a row, each attempt
// a full stream through the node's one disk. etcd shares that disk: at 10:31 k3s lost its leader election and
// restarted. A target that failed now waits 1, 3, 6, 12, then 24 hours for the same release, the real error is
// kept, and the stream is paced so a delivery can never starve etcd again.
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syncAll, transferWhy, backoffMs } = require('../scripts/gb-sync-all');
const image = 'wvdstoep/ghost-browser:v729';
const H = 3600 * 1000;

const target = () => ({ metadata: { namespace: 'ghost-browser', name: 'ghost-browser' }, spec: { replicas: 1, selector: { matchLabels: { app: 'ghost-browser' } }, template: { spec: { containers: [{ name: 'ghost-browser', image: 'wvdstoep/ghost-browser:v725' }] } } }, status: { availableReplicas: 1 } });
const host = { metadata: { namespace: 'byon-cp-ben', name: 'byon-ben' }, spec: { template: { spec: { containers: [{ name: 'k3s' }] } } } };
function runMock() {
  return vi.fn((args) => {
    if (args.includes('exec') && args.includes('node')) return JSON.stringify({ busy: 0 });
    if (args.includes('get') && args.includes('deployments')) return JSON.stringify({ items: args.includes('--') ? [target()] : [host] });
    return '';
  });
}

describe('a failed delivery backs off', () => {
  it('records the failure with its reason and waits an hour before the same release', () => {
    const state = {}; const log = [];
    const fail = vi.fn(() => { throw new Error('signed browser image transfer failed: timed out'); });
    expect(syncAll(image, runMock(), (l) => log.push(l), fail, { state, now: 0 })).toBe(false);
    expect(state['byon-cp-ben/ghost-browser']).toMatchObject({ image, fails: 1, retryAt: 1 * H, why: expect.stringContaining('timed out') });
    // 15 minutes later: no stream at all
    expect(syncAll(image, runMock(), (l) => log.push(l), fail, { state, now: 15 * 60 * 1000 })).toBe(true);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(log.at(-1)).toMatch(/waiting until .* before sending wvdstoep\/ghost-browser:v729 again \(failed 1x: .*timed out\)/);
  });

  it('waits longer after each failure: 1, 3, 6, 12, then 24 hours', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n) / H)).toEqual([1, 3, 6, 12, 24, 24]);
    const state = {}; const fail = vi.fn(() => { throw new Error('x'); });
    let now = 0;
    for (let i = 0; i < 3; i += 1) { syncAll(image, runMock(), () => {}, fail, { state, now }); now = state['byon-cp-ben/ghost-browser'].retryAt; }
    expect(state['byon-cp-ben/ghost-browser'].fails).toBe(3);
    expect(state['byon-cp-ben/ghost-browser'].retryAt).toBe((1 + 3 + 6) * H);
  });

  it('a new release is tried at once, and a success clears the record', () => {
    const state = { 'byon-cp-ben/ghost-browser': { image: 'wvdstoep/ghost-browser:v728', fails: 4, retryAt: 99 * H, why: 'x' } };
    const ok = vi.fn();
    expect(syncAll(image, runMock(), () => {}, ok, { state, now: 0 })).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(state['byon-cp-ben/ghost-browser']).toBeUndefined();
  });
});

describe('the reason, without anything private', () => {
  it('says timed out, or the exit code and the last stderr line, masking anything token-shaped', () => {
    expect(transferWhy({ killed: true })).toBe('timed out');
    expect(transferWhy({ status: 1, stderr: 'warming up\nctr: failed to ingest: no space left on device\n' })).toBe('exit 1: ctr: failed to ingest: no space left on device');
    expect(transferWhy({ status: 2, stderr: 'auth abcdefghijklmnopqrstuvwxyz0123456789ABCD failed' })).toBe('exit 2: auth … failed');
  });
});

describe('the stream is paced', () => {
  it('throttle-stream.js passes every byte through at the asked rate', () => {
    const data = Buffer.alloc(6 * 1024 * 1024, 7);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [new URL('../scripts/throttle-stream.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '4'], { input: data, maxBuffer: 16 * 1024 * 1024 });
    const ms = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(data.length);
    expect(ms).toBeGreaterThan(1100);   // 6 MB at 4 MB/s ≈ 1.5 s
  }, 20000);

  it("the cron wrapper skips a pass while the server is under pressure, and never for the always-running BuildKit daemon", () => {
    const sh = readFileSync(new URL('../../ops/host/bin/gb-sync-tenants.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(sh).toMatch(/slow fdatasync/);
    expect(sh).toMatch(/the server is busy/);
    expect(sh).not.toMatch(/pgrep[^\n]*buildkitd/);   // a daemon that always runs: the pass would never run (seen 11:00)
  });
});
