'use strict';
/*
 * API TOKENS THE OWNER MINTS — the server half of Settings → API tokens.
 *
 * The console's sheet (ApiTokensSheet.kt) has called GET/POST /v1/tokens and DELETE /v1/tokens/:id
 * since it was built, and no server ever answered them: "Generate" got the HTML 404 page back, which
 * is not JSON, so the sheet could only say "could not generate". The only keys were API_KEYS in the
 * deployment's environment, which an owner cannot add to from the app.
 *
 * A minted token (gbt_…) is a full API key — it is meant for a script, another machine or a site's
 * one-time connect step — stored only as a SHA-256 hash on the volume and shown once. It is looked up
 * beside the environment keys (see `extend`), so every route and /mcp accept it unchanged. Only the
 * signed-in owner of the console can mint, list or revoke; a token cannot mint another.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'gbt_';
const fileOf = () => path.join(process.env.PROFILE_DIR || '/profiles', 'api-tokens.json');
const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

function load() {
  try { const d = JSON.parse(fs.readFileSync(fileOf(), 'utf8')); if (d && Array.isArray(d.tokens)) return d; } catch { /* none yet */ }
  return { tokens: [] };
}
function save(d) {
  fs.mkdirSync(path.dirname(fileOf()), { recursive: true });
  const t = fileOf() + '.tmp';
  fs.writeFileSync(t, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(t, fileOf());
  cache = { mtime: -1, byHash: new Map() };   // a revoke in the same millisecond keeps the mtime; never trust it here
}
const row = (r) => ({ tokenId: r.tokenId, name: r.name, createdAt: r.createdAt, preview: r.preview, lastUsedAt: r.lastUsedAt || 0 });

function mint(name) {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  const r = { tokenId: 't_' + crypto.randomBytes(6).toString('hex'), name: String(name || 'API token').trim().slice(0, 60) || 'API token',
    hash: hash(token), preview: '…' + token.slice(-4), createdAt: Date.now(), lastUsedAt: 0 };
  const d = load(); d.tokens.push(r); save(d);
  return { token, ...row(r) };
}
const list = () => load().tokens.map(row);
function revoke(tokenId) { const d = load(); const n = d.tokens.length; d.tokens = d.tokens.filter((r) => r.tokenId !== tokenId); if (d.tokens.length === n) return false; save(d); return true; }

/* Cached by file mtime, so a lookup per request is a Map hit, and a revoke elsewhere is seen at once. */
var cache = { mtime: -1, byHash: new Map() };
function lookup(token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  let mtime = 0; try { mtime = fs.statSync(fileOf()).mtimeMs; } catch { return null; }
  if (mtime !== cache.mtime) cache = { mtime, byHash: new Map(load().tokens.map((r) => [r.hash, r])) };
  const r = cache.byHash.get(hash(token));
  if (r && Date.now() - (r.lastUsedAt || 0) > 10 * 60e3) {
    try { const d = load(); const x = d.tokens.find((t) => t.tokenId === r.tokenId); if (x) { x.lastUsedAt = Date.now(); save(d); } } catch { /* a stamp must never fail a request */ }
  }
  return r ? row(r) : null;
}

/**
 * Make the environment key map also answer for minted tokens. keys.js's auth() and the /mcp mount
 * both ask `keys.get(presented)`, so extending get is the one change every route sees. The client a
 * token gets is the same shape as an environment key's, with the plan of the install's first key.
 */
function extend(keys) {
  const base = keys.get.bind(keys);
  keys.get = (k) => {
    const env = base(k);
    if (env) return env;
    const t = lookup(k);
    if (!t) return undefined;
    const first = [...keys.values()][0] || { plan: 'solo', maxConcurrent: 1 };
    return { key: k, owner: 'tok_' + t.tokenId.slice(2, 8), plan: first.plan, maxConcurrent: first.maxConcurrent, tokenId: t.tokenId, tokenName: t.name };
  };
  return keys;
}

module.exports = { PREFIX, mint, list, revoke, lookup, extend };
