'use strict';
/*
 * A KEY FOR ONE WATCHER, AND NOTHING ELSE.
 *
 * Every key in API_KEYS can do everything this browser can: open sessions in the owner's signed-in
 * profiles, read and type, run any flow. Handing one of those to a public website so it can show a
 * watcher's feed would make that website's server a way into the owner's Facebook, Google and mail.
 *
 * A watch key (gbw_…) is bound to ONE watcher of mode "sources" and carries scopes: `feed` (read its
 * feed), `egress` (ask where the server leaves the internet), and optionally `run` (start a pass).
 * It never passes `authed` — keys.js does not know it — so every route that has not been opened to
 * it explicitly refuses it, browser_* tools included. Only a hash is stored; the key is shown once.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'gbw_';
const SCOPES = ['feed', 'egress', 'run', 'sources'];   // sources = edit this watcher's source list and keywords, nothing else
const fileOf = () => path.join(process.env.PROFILE_DIR || '/profiles', 'watch-keys.json');
const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

function load() {
  try { const d = JSON.parse(fs.readFileSync(fileOf(), 'utf8')); if (d && Array.isArray(d.keys)) return d; } catch { /* none yet */ }
  return { keys: [] };
}
function save(d) {
  fs.mkdirSync(path.dirname(fileOf()), { recursive: true });
  const t = fileOf() + '.tmp';
  fs.writeFileSync(t, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(t, fileOf());
}

const isWatchKey = (token) => typeof token === 'string' && token.startsWith(PREFIX);
const safeRow = (r) => ({ id: r.id, watcherId: r.watcherId, scopes: r.scopes, label: r.label || '', last4: r.last4, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt || 0 });

/** Mint a key for one watcher. The key itself is returned ONCE and never stored. */
function mint(watcherId, { scopes = ['feed', 'egress'], label = '' } = {}) {
  const wid = String(watcherId || '');
  if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(wid)) throw Object.assign(new Error('not a watcher id'), { status: 400 });
  const want = [...new Set((Array.isArray(scopes) ? scopes : []).map(String))].filter((s) => SCOPES.includes(s));
  if (!want.includes('feed')) want.unshift('feed');
  const key = PREFIX + crypto.randomBytes(32).toString('base64url');
  const row = { id: 'wk_' + crypto.randomBytes(5).toString('hex'), watcherId: wid, scopes: want, label: String(label || '').slice(0, 60), last4: key.slice(-4), hash: hash(key), createdAt: Date.now(), lastUsedAt: 0 };
  const d = load(); d.keys.push(row); save(d);
  return { key, ...safeRow(row) };
}

/** The key's record, or null. Stamps lastUsedAt at most every five minutes, to keep writes rare. */
function verify(token) {
  if (!isWatchKey(token)) return null;
  const d = load(); const h = Buffer.from(hash(token), 'hex');
  const row = d.keys.find((r) => { const b = Buffer.from(String(r.hash || ''), 'hex'); return b.length === h.length && crypto.timingSafeEqual(b, h); });
  if (!row) return null;
  if (Date.now() - (row.lastUsedAt || 0) > 5 * 60e3) { row.lastUsedAt = Date.now(); try { save(d); } catch { /* the check must not fail on a stamp */ } }
  return safeRow(row);
}

/** May this key do `scope` on watcher `watcherId`? egress is not about any one watcher. */
function allows(rec, scope, watcherId) {
  if (!rec || !rec.scopes || !rec.scopes.includes(scope)) return false;
  if (scope === 'egress') return true;
  return String(watcherId || '') === rec.watcherId;
}

const list = (watcherId) => load().keys.filter((r) => !watcherId || r.watcherId === watcherId).map(safeRow);
function revoke(id) { const d = load(); const n = d.keys.length; d.keys = d.keys.filter((r) => r.id !== id); if (d.keys.length !== n) { save(d); return true; } return false; }

module.exports = { PREFIX, SCOPES, isWatchKey, mint, verify, allows, list, revoke };
