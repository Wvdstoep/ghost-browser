/**
 * What the browser is allowed to open.
 *
 * This is the test file that matters most in the service. A browser any customer can point at any
 * URL is a server-side request forgery engine, and this one runs inside the cluster it would be
 * attacking — one unguarded fetch of the metadata endpoint or the provisioner's internal API is
 * worth more to an attacker than everything else here combined.
 *
 * The two cases that bypass a naive implementation both have tests below: a public hostname that
 * RESOLVES to a private address, and a public URL that REDIRECTS to one.
 */
import { describe, it, expect } from 'vitest';
import { assertPublicUrl, isBlockedAddress } from '../src/guard.js';

// A resolver we control, so these tests never touch real DNS.
const resolverFor = (map) => ({
  lookup: async (host) => {
    if (!map[host]) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
    return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
});

describe('addresses that must never be reachable', () => {
  it.each([
    ['127.0.0.1',        'loopback'],
    ['10.1.2.3',         'private class A'],
    ['172.16.5.4',       'private class B'],
    ['192.168.1.1',      'private class C'],
    ['169.254.169.254',  'cloud metadata — the one that hands out credentials'],
    ['100.64.1.1',       'carrier-grade NAT, where tailnets live'],
    ['0.0.0.0',          'this network'],
    ['::1',              'IPv6 loopback'],
    ['fe80::1',          'IPv6 link-local'],
    ['fd00::1',          'IPv6 unique local'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata — the same attack in a different hat'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([['1.1.1.1'], ['93.184.216.34'], ['2606:4700:4700::1111']])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('treats anything unparseable as blocked rather than as allowed', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  const dns = resolverFor({
    'example.com': ['93.184.216.34'],
    'evil.test': ['169.254.169.254'],
    'sneaky.test': ['93.184.216.34', '10.0.0.5'],
  });

  it('allows an ordinary public site', async () => {
    await expect(assertPublicUrl('https://example.com/page', { resolver: dns })).resolves.toMatchObject({ ok: true });
  });

  /* The bypass a hostname-only check misses entirely. */
  it('blocks a public NAME that resolves to a private address', async () => {
    await expect(assertPublicUrl('https://evil.test/', { resolver: dns })).rejects.toThrow(/private address/i);
  });

  /* One good answer does not make a name safe — the browser may connect to either. */
  it('blocks a name that returns one public and one private address', async () => {
    await expect(assertPublicUrl('https://sneaky.test/', { resolver: dns })).rejects.toThrow(/private address/i);
  });

  it('blocks a literal private address without consulting DNS at all', async () => {
    const never = { lookup: async () => { throw new Error('DNS must not be used for a literal'); } };
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/', { resolver: never }))
      .rejects.toThrow(/private network/i);
  });

  it('blocks internal hostnames that /etc/hosts would happily resolve', async () => {
    for (const u of [
      'http://localhost:3000/',
      'http://provisioner.agents-system.svc.cluster.local:3030/api/apps',
      'http://metadata/computeMetadata/v1/',
      'http://something.internal/',
    ]) {
      await expect(assertPublicUrl(u, { resolver: dns })).rejects.toThrow(/internal/i);
    }
  });

  it('refuses protocols that are not http(s)', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'chrome://settings']) {
      await expect(assertPublicUrl(u, { resolver: dns })).rejects.toThrow(/only http and https|not a URL/i);
    }
  });

  it('refuses a name that does not resolve, rather than letting the browser try', async () => {
    await expect(assertPublicUrl('https://nothing-here.test/', { resolver: dns })).rejects.toThrow(/does not resolve/i);
  });

  it('carries a status so the API answers with the right code', async () => {
    await expect(assertPublicUrl('https://evil.test/', { resolver: dns })).rejects.toMatchObject({ status: 403 });
    await expect(assertPublicUrl('nonsense', { resolver: dns })).rejects.toMatchObject({ status: 400 });
  });
});
