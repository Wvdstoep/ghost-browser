'use strict';
const crypto = require('crypto');
const digest = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const bad = () => Object.assign(new Error('This device sign-in expired or could not be verified. Please sign in again.'), { status: 401 });

// Short-lived, single-use authorization codes. A callback never carries a device API key.
function makeMobileAuth({ mintDevice, now = Date.now, ttlMs = 120000, maxPending = 100 } = {}) {
  const pending = new Map();
  function issue(owner, challenge) {
    if (!owner || !/^[A-Za-z0-9_-]{43}$/.test(String(challenge || ''))) throw bad();
    for (const [key, value] of pending) if (value.expires <= now()) pending.delete(key);
    if (pending.size >= maxPending) throw Object.assign(new Error('Please try device sign-in again in a moment.'), { status: 429 });
    const code = crypto.randomBytes(32).toString('base64url');
    pending.set(digest(code), { owner, challenge, expires: now() + ttlMs });
    return { code, expiresIn: ttlMs / 1000 };
  }
  function redeem({ code, verifier, deviceId, name } = {}) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(code || '')) || !/^[A-Za-z0-9._~-]{43,128}$/.test(String(verifier || ''))
      || !/^[A-Za-z0-9_-]{1,128}$/.test(String(deviceId || ''))) throw bad();
    const key = digest(code), rec = pending.get(key);
    if (!rec || rec.expires <= now() || digest(verifier) !== rec.challenge) throw bad();
    pending.delete(key); // Consume before issuing the durable device token.
    return mintDevice({ owner: rec.owner, deviceId, name: String(name || 'Android').slice(0, 100) });
  }
  return { issue, redeem };
}
module.exports = { makeMobileAuth };
