// gb-prepull.test.js — an owned cluster pulls the signed release itself, at night (2026-11-21).
//
// The 2.7 GB browser image used to be streamed into an owned cluster through the platform's API server (docker save |
// kubectl exec … ctr import): it timed out and failed 154 times, every 15 minutes, on the disk etcd shares. Now the
// signature is checked, a short-lived pull pod asks that cluster's kubelet to pull it with the copied pull secret,
// the running browser is untouched, and only a pulled image is switched to. Owned clusters get it at night.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prePullImage, syncAll } = require('../scripts/gb-sync-all');
const image = 'wvdstoep/ghost-browser:v737';
const prefix = ['-n', 'byon-cp-ben', 'exec', '-i', 'deployment/byon-ben', '-c', 'k3s', '--', 'kubectl'];
const dep = { metadata: { namespace: 'ghost-browser', name: 'ghost-browser' },
  spec: { template: { spec: { imagePullSecrets: [{ name: 'regcred' }], securityContext: { runAsNonRoot: true, runAsUser: 1000 },
    containers: [{ name: 'ghost-browser', image: 'wvdstoep/ghost-browser:v725', securityContext: { allowPrivilegeEscalation: false } }] } } } };

function cluster(statuses) {
  const calls = []; let n = 0;
  const run = vi.fn((args, input) => {
    calls.push({ args, input });
    if (args.includes('get') && args.includes('pod')) return JSON.stringify({ status: { containerStatuses: [statuses[Math.min(n++, statuses.length - 1)]] } });
    return '';
  });
  return { run, calls };
}
const fast = { exec: () => '', sleep: () => {}, log: () => {} };

describe('the pull pod', () => {
  it('checks the signature, pulls with the browser\'s own secret and security context, and is removed afterwards', () => {
    const c = cluster([{ state: { waiting: { reason: 'ContainerCreating' } } }, { imageID: 'docker.io/wvdstoep/ghost-browser@sha256:abc', state: { terminated: { exitCode: 0 } } }]);
    const exec = vi.fn(() => '');
    prePullImage(image, prefix, { dep, container: dep.spec.template.spec.containers[0], run: c.run, ...fast, exec });
    expect(exec.mock.calls[0][1].slice(0, 2)).toEqual(['cosign', 'verify']);
    const applied = JSON.parse(c.calls.find((x) => x.args.includes('apply')).input);
    expect(applied.metadata).toMatchObject({ name: 'gb-prepull-v737', namespace: 'ghost-browser' });
    expect(applied.spec.imagePullSecrets).toEqual([{ name: 'regcred' }]);
    expect(applied.spec.securityContext).toEqual({ runAsNonRoot: true, runAsUser: 1000 });
    expect(applied.spec.containers[0]).toMatchObject({ image, imagePullPolicy: 'IfNotPresent', securityContext: { allowPrivilegeEscalation: false } });
    expect(JSON.stringify(applied)).not.toMatch(/password|auth"/i);                       // no credential in the manifest
    const deletes = c.calls.filter((x) => x.args.includes('delete'));
    expect(deletes.length).toBe(2);                                                        // a leftover before, this one after
    expect(c.calls.some((x) => x.args.includes('set') || x.args.includes('patch'))).toBe(false);   // the browser is not touched here
  });

  it('a refused pull is an error in the kubelet\'s own words, and the pod is still removed', () => {
    const c = cluster([{ state: { waiting: { reason: 'ErrImagePull', message: 'pull access denied: unauthorized' } } }]);
    expect(() => prePullImage(image, prefix, { dep, run: c.run, ...fast })).toThrow(/could not pull it \(ErrImagePull: pull access denied: unauthorized\)/);
    expect(c.calls.filter((x) => x.args.includes('delete')).length).toBe(2);
  });

  it('a pull that never finishes gives up after its limit', () => {
    let t = 0;
    const c = cluster([{ state: { waiting: { reason: 'ContainerCreating' } } }]);
    expect(() => prePullImage(image, prefix, { dep, run: c.run, ...fast, now: () => (t += 60000), timeoutMs: 5 * 60000 })).toThrow(/did not finish/);
  });

  it('a signature that does not verify stops it before anything is created', () => {
    const c = cluster([]);
    expect(() => prePullImage(image, prefix, { dep, run: c.run, ...fast, exec: () => { throw Object.assign(new Error('x'), { status: 1, stderr: 'no matching signatures' }); } })).toThrow(/signature check/);
    expect(c.run).not.toHaveBeenCalled();
  });
});

describe('the night window', () => {
  const host = { metadata: { namespace: 'byon-cp-ben', name: 'byon-ben' }, spec: { template: { spec: { containers: [{ name: 'k3s' }] } } } };
  const target = () => ({ ...dep, spec: { replicas: 1, selector: { matchLabels: { app: 'ghost-browser' } }, template: dep.spec.template }, status: { availableReplicas: 1 } });
  const run = () => vi.fn((args) => {
    if (args.includes('exec') && args.includes('node')) return JSON.stringify({ busy: 0 });
    if (args.includes('get') && args.includes('deployments')) return JSON.stringify({ items: args.includes('--') ? [target()] : [host] });
    return '';
  });
  it('an owned cluster waits outside the window, and is delivered inside it', () => {
    const log = []; const pull = vi.fn();
    syncAll(image, run(), (l) => log.push(l), pull, { nestedHours: [1, 6], hour: 15 });
    expect(pull).not.toHaveBeenCalled();
    expect(log.at(-1)).toMatch(/waits for the night window \(1:00-6:00\)/);
    syncAll(image, run(), () => {}, pull, { nestedHours: [1, 6], hour: 3 });
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull.mock.calls[0][2]).toMatchObject({ dep: expect.any(Object), run: expect.any(Function) });
  });
});

describe('wired in', () => {
  it('the cron path uses the pull pod and the night window; the busy gate is realistic', () => {
    const src = readFileSync(new URL('../scripts/gb-sync-all.js', import.meta.url), 'utf8');
    expect(src).toMatch(/syncAll\(process\.argv\[2\], run, console\.log, prePullImage, \{ state, nestedHours \}\)/);
    const sh = readFileSync(new URL('../../ops/host/bin/gb-sync-tenants.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(sh).toMatch(/\[ "\$\{slow:-0\}" -ge 3 \]/);
    expect(sh).toMatch(/load=\$\(cut -d' ' -f2 \/proc\/loadavg\)/);
  });
});
