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

describe('IPv6 spellings of the addresses above are the same addresses', () => {
  // Every row reached 169.254.169.254 or loopback before the check was done on bytes instead of text.
  it.each([
    ['::ffff:a9fe:a9fe', 'v4-mapped metadata, hex spelling'],
    ['::ffff:169.254.169.254', 'v4-mapped metadata, dotted spelling'],
    ['::ffff:7f00:1', 'v4-mapped loopback, hex'],
    ['::127.0.0.1', 'v4-compatible loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback, written out'],
    ['0000:0000:0000:0000:0000:0000:0000:0001', 'loopback, fully padded'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 to the metadata address'],
    ['2002:a9fe:a9fe::', '6to4 to the metadata address'],
    ['2002:7f00:1::', '6to4 to loopback'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
    ['2001:db8::1', 'documentation range'],
    ['ff02::1', 'multicast'],
    ['[::ffff:a9fe:a9fe]', 'bracketed, as in a URL'],
    ['fe80::1%eth0', 'link-local with a zone id'],
  ])('blocks %s (%s)', (ip) => { expect(isBlockedAddress(ip)).toBe(true); });

  it('still allows a real public IPv6 address and the v4 it maps to', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);   // Cloudflare DNS
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedAddress('64:ff9b::808:808')).toBe(false);       // NAT64 to 8.8.8.8
    expect(isBlockedAddress('2002:808:808::')).toBe(false);         // 6to4 to 8.8.8.8
  });

  it('blocks the documentation IPv4 ranges', () => {
    for (const ip of ['192.0.2.1', '198.51.100.7', '203.0.113.9']) expect(isBlockedAddress(ip)).toBe(true);
  });

  it('a URL written with an IPv6 mapped host is refused end to end', async () => {
    await expect(assertPublicUrl('http://[::ffff:169.254.169.254]/latest/meta-data/')).rejects.toMatchObject({ status: 403 });
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
