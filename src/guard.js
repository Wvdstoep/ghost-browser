/**
 * guard.js — what this browser is allowed to open.
 *
 * A browser service that any customer can point at any URL is a server-side request forgery engine
 * with a billing page attached, and this one runs INSIDE the cluster it would be attacking. Left
 * open, a paying stranger can ask it to fetch the provisioner's internal API, the Kubernetes API
 * server, another tenant's service, or the cloud metadata endpoint that hands out credentials — and
 * it will, because from inside the pod those are just URLs that resolve.
 *
 * So the rule is an allowlist of one thing: the public internet.
 *
 * Two details matter more than the list itself:
 *
 *   1. DNS IS PART OF THE ATTACK. Checking the hostname is not enough — `evil.com` can resolve to
 *      169.254.169.254. The name has to be resolved and the resulting ADDRESSES checked, which is
 *      why this is async and why every address a name returns is checked, not just the first.
 *   2. REDIRECTS ARE PART OF THE ATTACK. A public URL that 302s to a private one defeats a check
 *      done only at the start, so the caller must re-check every navigation, not just the first.
 */

const dns = require('dns').promises;
const net = require('net');

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/*
 * Ranges that must never be reachable. Loopback and the private blocks are the obvious ones;
 * link-local (169.254/16) is the one people forget, and it is where AWS, GCP and Azure all serve
 * instance credentials to anything that asks.
 */
const V4_BLOCKED = [
  ['0.0.0.0', 8],          // "this network"
  ['10.0.0.0', 8],         // private
  ['100.64.0.0', 10],      // carrier-grade NAT — also where tailnets live
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local — cloud metadata
  ['172.16.0.0', 12],      // private
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.168.0.0', 16],     // private
  ['198.18.0.0', 15],      // benchmarking
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved
];

const toInt = (ip) => ip.split('.').reduce((a, o) => (a << 8 >>> 0) + Number(o), 0) >>> 0;

function isBlockedV4(ip) {
  const addr = toInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return (addr & mask) === (toInt(base) & mask);
  });
}

function isBlockedV6(ip) {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::' || a === '::1') return true;                 // unspecified, loopback
  if (a.startsWith('fe80') || a.startsWith('fec0')) return true; // link-local, site-local
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;              // unique local (fc00::/7)
  // IPv4-mapped (::ffff:169.254.169.254) is the same attack wearing a different hat.
  const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  return false;
}

function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true;   // unparseable is not a reason to allow it
}

/**
 * Check one URL. Resolves the hostname and rejects if ANY address it answers with is private —
 * a name that returns one public and one private address is a name being used to attack us.
 *
 * Returns { ok: true, addresses } or throws with a reason worth showing the caller.
 */
async function assertPublicUrl(raw, { resolver = dns } = {}) {
  let u;
  try { u = new URL(String(raw)); }
  catch { throw Object.assign(new Error('that is not a URL'), { status: 400 }); }

  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    throw Object.assign(new Error(`only http and https can be opened (got ${u.protocol})`), { status: 400 });
  }

  const host = u.hostname.replace(/^\[|\]$/g, '');

  // A literal address needs no lookup — and must not get one, or a hostile literal slips through.
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw Object.assign(new Error('that address is inside a private network and cannot be opened'), { status: 403 });
    }
    return { ok: true, addresses: [host] };
  }

  // `localhost` and friends often resolve through /etc/hosts to exactly what we are blocking.
  if (/^(localhost|.*\.localhost|.*\.internal|.*\.local|.*\.cluster\.local|metadata(\..*)?)$/i.test(host)) {
    throw Object.assign(new Error('that hostname is internal and cannot be opened'), { status: 403 });
  }

  let addresses;
  try {
    const records = await resolver.lookup(host, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw Object.assign(new Error(`that hostname does not resolve (${host})`), { status: 400 });
  }
  if (!addresses.length) {
    throw Object.assign(new Error(`that hostname does not resolve (${host})`), { status: 400 });
  }
  const bad = addresses.find(isBlockedAddress);
  if (bad) {
    throw Object.assign(new Error(`${host} resolves to a private address (${bad}) and cannot be opened`), { status: 403 });
  }
  return { ok: true, addresses };
}

module.exports = { assertPublicUrl, isBlockedAddress, isBlockedV4, isBlockedV6 };
