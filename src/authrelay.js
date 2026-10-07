'use strict';
/**
 * authrelay.js — a passkey prompt on a page the cluster drives is answered by the OWNER'S device.
 *
 * THE PROBLEM. A pod has no authenticator, so pool.passkeyRefusalScript refuses WebAuthn outright:
 * the site shows its fallback, and a login that REQUIRES a passkey is simply out of reach. Faking an
 * authenticator in the pod is worse (a key that lives and dies with the pod). The right place for the
 * key is where the owner already keeps it: their phone or laptop.
 *
 * THE SHAPE.
 *
 *     page (in the cluster browser)            cluster                      owner's device
 *     navigator.credentials.get(...)  ──►  installRelay binding  ──►  ask(request)  ──►  authenticator
 *              ◄── assertion ◄───────────────────────────────────────────────────────  (key never leaves)
 *
 * The page's call is intercepted, the request (rpId, challenge, origin, allowed credentials, what the
 * site wants verified) is serialised and handed to `ask`, which is whatever transport reaches the
 * device. The device approves — a human tap — and signs; only the SIGNED ASSERTION comes back. The
 * cluster never holds a private key, so a leak of the pod leaks no passkey, and nothing is registered
 * against a key that dies with the session.
 *
 * WHAT IS REAL AND WHAT IS NOT. Everything here is real WebAuthn: the authenticator data, the ES256
 * signature, the attestation object, the counter. A site cannot tell this from a platform
 * authenticator, and the test site verifies it with the same checks a real relying party runs. What
 * is NOT in this file is the radio: `makeSoftAuthenticator` stands in for the device's secure
 * hardware, and `ask` is where a ring node's transport plugs in. A real phone approving it needs a
 * real phone; see docs/FRONTIER-REPORT.md.
 *
 * Only WebAuthn is intercepted. Password and federated credentials share the same two methods and
 * must keep working, so anything without `publicKey` is passed straight through.
 */

const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

/* ── CBOR: only what WebAuthn needs (ints, byte/text strings, arrays, maps) ───────────────────── */
function cborEncode(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEncode(k), cborEncode(x)])]);
  if (v && typeof v === 'object') return cborEncode(new Map(Object.entries(v)));
  throw new Error('cbor: cannot encode ' + typeof v);
}

function cborDecode(buf, at = { i: 0 }) {
  const b = buf[at.i++]; const major = b >> 5; let n = b & 31;
  if (n === 24) n = buf[at.i++];
  else if (n === 25) { n = buf.readUInt16BE(at.i); at.i += 2; }
  else if (n === 26) { n = buf.readUInt32BE(at.i); at.i += 4; }
  else if (n > 26) throw new Error('cbor: unsupported length');
  switch (major) {
    case 0: return n;
    case 1: return -1 - n;
    case 2: { const s = buf.subarray(at.i, at.i + n); at.i += n; return Buffer.from(s); }
    case 3: { const s = buf.subarray(at.i, at.i + n).toString('utf8'); at.i += n; return s; }
    case 4: return Array.from({ length: n }, () => cborDecode(buf, at));
    case 5: { const m = new Map(); for (let k = 0; k < n; k++) { const key = cborDecode(buf, at); m.set(key, cborDecode(buf, at)); } return m; }
    default: throw new Error('cbor: unsupported major type ' + major);
  }
}

/** A COSE_Key (EC2, P-256, ES256) from a Node public KeyObject. */
function coseFromPublic(pub) {
  const jwk = pub.export({ format: 'jwk' });
  return new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]);
}
function publicFromCose(cose) {
  const m = cose instanceof Map ? cose : new Map(Object.entries(cose));
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(m.get(-2)), y: b64u(m.get(-3)) }, format: 'jwk' });
}

/* ── the authenticator: the owner's device ─────────────────────────────────────────────────────── */
/**
 * A software stand-in for the secure hardware on the owner's device. Keys are generated here and
 * NEVER returned: callers get public keys and signatures only. `approve(request)` is the human tap;
 * if it resolves false the call fails the way a dismissed prompt does (NotAllowedError).
 */
function makeSoftAuthenticator({ approve = async () => true, aaguid = Buffer.alloc(16) } = {}) {
  const creds = new Map();                       // credIdB64u → { priv, pub, rpId, counter, user }
  const refused = () => Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });

  const flags = (...bits) => bits.reduce((a, b) => a | b, 0);
  const UP = 0x01, UV = 0x04, AT = 0x40;

  return {
    get count() { return creds.size; },
    has: (rpId) => [...creds.values()].some((c) => c.rpId === rpId),

    async create(req) {
      if (!(await approve(req))) throw refused();
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const credId = crypto.randomBytes(32);
      creds.set(b64u(credId), { priv: privateKey, pub: publicKey, rpId: req.rpId, counter: 0, user: req.user || null });
      const cose = cborEncode(coseFromPublic(publicKey));
      const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha256(req.rpId), Buffer.from([flags(UP, UV, AT)]), Buffer.alloc(4), aaguid, idLen, credId, cose]);
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: req.challenge, origin: req.origin, crossOrigin: false }));
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key',
        response: {
          clientDataJSON: b64u(clientData),
          attestationObject: b64u(cborEncode({ fmt: 'none', attStmt: new Map(), authData })),
        },
      };
    },

    async get(req) {
      const allowed = (req.allowCredentials || []).map((c) => c.id);
      const hit = [...creds.entries()].find(([id, c]) => c.rpId === req.rpId && (!allowed.length || allowed.includes(id)));
      if (!hit) throw refused();
      if (!(await approve(req))) throw refused();
      const [id, c] = hit;
      c.counter += 1;
      const ctr = Buffer.alloc(4); ctr.writeUInt32BE(c.counter);
      const authData = Buffer.concat([sha256(req.rpId), Buffer.from([flags(UP, UV)]), ctr]);
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: req.challenge, origin: req.origin, crossOrigin: false }));
      const sig = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), c.priv);   // DER ES256
      return {
        id, rawId: id, type: 'public-key',
        response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: c.user ? b64u(Buffer.from(String(c.user))) : null },
      };
    },
  };
}

/* ── verification, as a relying party does it (used by the test site and by anyone checking) ───── */
function parseAuthData(ad) {
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], counter: ad.readUInt32BE(33) };
  if (out.flags & 0x40) {
    // 32 rpIdHash + 1 flags + 4 counter, then 16 aaguid, then a 2-byte credential id length
    const len = ad.readUInt16BE(37 + 16);
    out.credId = ad.subarray(37 + 16 + 2, 37 + 16 + 2 + len);
    out.cose = cborDecode(ad, { i: 37 + 16 + 2 + len });
  }
  return out;
}

function verifyRegistration({ attestationObject, clientDataJSON }, { challenge, origin, rpId }) {
  const cd = JSON.parse(unb64u(clientDataJSON).toString());
  if (cd.type !== 'webauthn.create' || cd.challenge !== challenge || cd.origin !== origin) throw new Error('registration clientData does not match');
  const att = cborDecode(unb64u(attestationObject));
  const ad = parseAuthData(att.get('authData'));
  if (!ad.rpIdHash.equals(sha256(rpId))) throw new Error('rpId hash mismatch');
  if (!(ad.flags & 0x01)) throw new Error('user presence missing');
  return { credId: b64u(ad.credId), publicKey: publicFromCose(ad.cose) };
}

function verifyAssertion({ clientDataJSON, authenticatorData, signature }, { challenge, origin, rpId, publicKey, lastCounter = 0 }) {
  const cdRaw = unb64u(clientDataJSON); const cd = JSON.parse(cdRaw.toString());
  if (cd.type !== 'webauthn.get' || cd.challenge !== challenge || cd.origin !== origin) throw new Error('assertion clientData does not match');
  const ad = unb64u(authenticatorData); const p = parseAuthData(ad);
  if (!p.rpIdHash.equals(sha256(rpId))) throw new Error('rpId hash mismatch');
  if (!(p.flags & 0x01)) throw new Error('user presence missing');
  if (!crypto.verify('sha256', Buffer.concat([ad, sha256(cdRaw)]), publicKey, unb64u(signature))) throw new Error('bad signature');
  if (p.counter <= lastCounter) throw new Error('counter did not advance (cloned authenticator?)');
  return { counter: p.counter };
}

/* ── the page side ─────────────────────────────────────────────────────────────────────────────── */
/*
 * Runs in the page. Serialises a WebAuthn call, hands it to the Node binding, and rebuilds the
 * credential object the site expects. Everything crossing the boundary is base64url text.
 */
function pageScript() {
  const b64u = (buf) => { const b = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer || buf); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64u = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const r = atob(s); const u = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u.buffer; };
  const c = navigator.credentials;
  if (!c || !window.__gbRelay) return;
  const origGet = c.get.bind(c); const origCreate = c.create.bind(c);
  const fail = (e) => new DOMException(e && e.message || 'The operation either timed out or was not allowed.', 'NotAllowedError');
  const wrap = (kind, orig) => async function (options) {
    if (!options || !options.publicKey) return orig(options);          // passwords and federated credentials: untouched
    const pk = options.publicKey;
    const req = {
      kind, origin: location.origin, rpId: pk.rpId || location.hostname,
      challenge: b64u(pk.challenge), userVerification: pk.userVerification || 'preferred',
      allowCredentials: (pk.allowCredentials || []).map((x) => ({ id: b64u(x.id) })),
      user: pk.user ? { id: b64u(pk.user.id), name: pk.user.name } : null,
      site: location.hostname,
    };
    let r;
    try { r = await window.__gbRelay(req); } catch (e) { throw fail(e); }
    if (!r || r.error) throw fail(r && r.error);
    const resp = {};
    for (const [k, v] of Object.entries(r.response)) resp[k] = v == null ? null : unb64u(v);
    if (kind === 'create') resp.getTransports = () => ['hybrid'];
    return { id: r.id, rawId: unb64u(r.rawId), type: 'public-key', authenticatorAttachment: 'cross-platform', response: resp, getClientExtensionResults: () => ({}) };
  };
  c.get = wrap('get', origGet);
  c.create = wrap('create', origCreate);
  if (window.PublicKeyCredential) {
    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
    window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  }
}

/**
 * Wire the relay into a browser context. `ask(request)` reaches the owner's device and resolves to
 * the authenticator's response ({id, rawId, response}) or rejects/returns {error} when the owner
 * declines. Returns the audit log of what the page asked for, so the owner can see every prompt.
 */
async function installRelay(context, ask, { log = console, onRequest = null } = {}) {
  const audit = [];
  await context.exposeBinding('__gbRelay', async (_src, req) => {
    const entry = { at: Date.now(), kind: req.kind, site: req.site, rpId: req.rpId, outcome: 'pending' };
    audit.push(entry);
    try { onRequest && onRequest(req); } catch { /* an observer must not break the login */ }
    try {
      const out = await ask(req);
      entry.outcome = 'answered';
      return out;
    } catch (e) {
      entry.outcome = 'declined';
      log.info?.(`[authrelay] ${req.kind} for ${req.site} declined: ${e.message}`);
      return { error: e.message };
    }
  });
  await context.addInitScript(pageScript);
  return { audit };
}

module.exports = {
  makeSoftAuthenticator, installRelay, pageScript,
  verifyRegistration, verifyAssertion, parseAuthData, cborEncode, cborDecode, b64u, unb64u,
};
