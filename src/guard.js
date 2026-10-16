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
  ['192.0.2.0', 24],       // TEST-NET-1 (documentation)
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // TEST-NET-2 (documentation)
  ['203.0.113.0', 24],     // TEST-NET-3 (documentation)
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

/*
 * PARSE AN IPv6 ADDRESS INTO ITS 16 BYTES, whatever spelling it arrives in.
 *
 * The check used to be string matching, and string matching only sees the spellings somebody thought
 * of. "::ffff:169.254.169.254" was caught; the SAME address written "::ffff:a9fe:a9fe" (which is what
 * WHATWG URL hands back for it) was not, nor "::127.0.0.1", nor "0:0:0:0:0:0:0:1", nor the NAT64 and
 * 6to4 forms that carry an IPv4 address inside an IPv6 one. Every one reached the cloud metadata
 * endpoint or loopback. Bytes have exactly one spelling, so the rules below are written against
 * bytes and cannot be dodged by re-writing the text.
 */
function v6Bytes(ip) {
  let a = String(ip).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');   // drop brackets and a zone id
  if (!net.isIPv6(a)) return null;
  // an embedded dotted quad ("::ffff:1.2.3.4") becomes two hex groups first
  const q = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (q) {
    const o = q[2].split('.').map(Number);
    a = q[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : (tail ? tail.split(':') : []);
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
  if (groups.length !== 8 || groups.some((x) => !(x >= 0 && x <= 0xffff))) return null;
  return groups.flatMap((x) => [x >> 8, x & 255]);
}

const v4Of = (b, i) => b.slice(i, i + 4).join('.');
const allZero = (b, from, to) => b.slice(from, to).every((x) => x === 0);

function isBlockedV6(ip) {
  const b = v6Bytes(ip);
  if (!b) return true;                                             // unparseable is not a reason to allow it
  if (allZero(b, 0, 15) && (b[15] === 0 || b[15] === 1)) return true;           // :: and ::1
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedV4(v4Of(b, 12));   // ::ffff:a.b.c.d (mapped)
  if (allZero(b, 0, 12)) return isBlockedV4(v4Of(b, 12));                       // ::a.b.c.d (deprecated "compatible")
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) {
    return isBlockedV4(v4Of(b, 12));                               // 64:ff9b::/96 NAT64 — the v4 address it will reach
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedV4(v4Of(b, 2));           // 2002::/16 6to4 — the v4 it tunnels to
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;   // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;   // 2001:db8::/32 documentation
  if ((b[0] & 0xfe) === 0xfc) return true;                         // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;        // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;        // fec0::/10 site-local
  if (b[0] === 0xff) return true;                                  // ff00::/8 multicast
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
