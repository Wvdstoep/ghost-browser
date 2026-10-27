import { describe, it, expect, vi } from 'vitest';
const { syncAll } = require('../scripts/gb-sync-all');
const image = 'wvdstoep/ghost-browser:v674';
const browser = (namespace, current = 'wvdstoep/ghost-browser:v673', replicas = 1) => ({ metadata: { namespace, name: 'ghost-browser' }, spec: { replicas, template: { spec: { containers: [{ name: 'ghost-browser', image: current }] } } } });
const host = { metadata: { namespace: 'byon-cp-ann', name: 'byon-ann' }, spec: { template: { spec: { containers: [{ name: 'k3s', image: 'k3s' }] } } } };
function mock(root, nested = [], busy = 0) {
  return vi.fn(args => {
    if (args.includes('get')) return JSON.stringify({ items: args.includes('--') ? nested : root });
    if (args.includes('node')) return JSON.stringify({ busy });
    return '';
  });
}
describe('all installed Ghost Browser releases', () => {
  it('discovers platform browsers and every hosted cluster without hardcoded tenants', () => {
    const run = mock([browser('pod-ann'), host], [browser('ghost-browser')]);
    expect(syncAll(image, run, () => {})).toBe(true);
    const updates = run.mock.calls.map(([a]) => a).filter(a => a.includes('set'));
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual(expect.arrayContaining(['byon-cp-ann', 'deployment/byon-ann', 'k3s', 'kubectl', 'ghost-browser']));
  });
  it('leaves current, stopped and busy browsers alone', () => {
    const run = mock([browser('current', image), browser('stopped', undefined, 0), browser('busy')], [], 1);
    syncAll(image, run, () => {});
    expect(run.mock.calls.some(([a]) => a.includes('set'))).toBe(false);
  });
  it('fails closed on readiness errors and continues other tenants', () => {
    const run = mock([browser('broken'), browser('healthy')]);
    run.mockImplementationOnce(() => JSON.stringify({ items: [browser('broken'), browser('healthy')] })).mockImplementationOnce(() => { throw Error('unreachable'); });
    expect(syncAll(image, run, () => {})).toBe(false);
    expect(run.mock.calls.filter(([a]) => a.includes('set'))).toHaveLength(1);
  });
  it('rejects non-release images before contacting a cluster', () => {
    const run = vi.fn();
    expect(() => syncAll('untrusted:latest', run)).toThrow('Invalid release image');
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['ImagePullBackOff', 'CrashLoopBackOff', null])('recovers only a browser blocked on image pull: %s', reason => {
    const dep = browser('unavailable');
    dep.status = { availableReplicas: 0 };
    dep.spec.selector = { matchLabels: { app: 'ghost-browser' } };
    const run = mock([dep], [], 1);
    run.mockImplementationOnce(() => JSON.stringify({ items: [dep] })).mockImplementationOnce(() => JSON.stringify({ items: reason ? [{ status: { containerStatuses: [{ state: { waiting: { reason } } }] } }] : [] }));
    syncAll(image, run, () => {});
    expect(run.mock.calls.some(([a]) => a.includes('set'))).toBe(reason === 'ImagePullBackOff');
  });
  it('reports a dedicated cluster discovery failure', () => {
    const run = mock([host]);
    run.mockImplementationOnce(() => JSON.stringify({ items: [host] })).mockImplementationOnce(() => { throw Error('offline'); });
    expect(syncAll(image, run, () => {})).toBe(false);
  });
});
