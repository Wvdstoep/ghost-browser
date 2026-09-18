'use strict';
/**
 * deviceTokens.js — a durable per-device login for the app, so the owner signs in ONCE (through the SSO
 * handoff) and the device stays connected to the cluster from then on, with no per-profile sign-in.
 *
 * The friction it removes: the app used to reach the cluster through a hidden WebView carrying the SSO
 * cookie, and that WebView lived inside whichever browsing profile was open — so opening a new platform
 * (a fresh cookie jar) meant signing into the cluster again. A device token is not tied to any browsing
 * profile: it is a normal Bearer key the native HTTP client sends on every call. The browsing profiles
 * then only ever log into the actual platforms.
 *
 * A device token is minted behind the owner's SSO cookie (only the signed-in person can enroll a device
 * for themselves), joins the same in-memory `keys` map the bearer auth already checks (so nothing
 * downstream changes — it resolves to the owner, console:true, like the console does), and is persisted
 * so it survives a restart. Revocable per device.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = () => path.join(process.env.PROFILE_DIR || '/profiles', '.device-tokens.json');
const PLAN = { maxConcurrent: 3, label: 'Device' };   // a device is the owner on their phone — same reach as the console

function read() { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; } }
function write(obj) { try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); const f = FILE(); fs.writeFileSync(f + '.tmp', JSON.stringify(obj)); fs.renameSync(f + '.tmp', f); } catch { /* memory only then */ } }

/** Every entry of a device-token record, as it goes into the keys map (owner + console, so it sees what the owner sees). */
function entryOf(rec) { return { key: rec.token, owner: rec.owner, console: true, device: true, deviceId: rec.deviceId, name: rec.name || rec.deviceId, plan: 'device', ...PLAN }; }

/** Load persisted device tokens into the live keys map at boot. Returns how many. */
function load(keys, log) {
  const all = read(); let n = 0;
  for (const rec of Object.values(all)) { if (rec && rec.token && rec.owner) { keys.set(rec.token, entryOf(rec)); n++; } }
  if (n && log && log.info) log.info(`[device-token] loaded ${n} device login(s)`);
  return n;
}

/** Mint (or re-mint) a device's durable login for `owner`. One token per (owner, deviceId): re-enroll rotates it. */
function mint(keys, { owner, deviceId = '', name = '' }) {
  if (!owner) throw new Error('owner required');
  const all = read();
  const id = String(deviceId || crypto.randomBytes(6).toString('hex'));
  // rotate: drop any prior token for this owner+device from the live map and the file
  for (const [k, rec] of Object.entries(all)) { if (rec.owner === owner && rec.deviceId === id) { keys.delete(rec.token); delete all[k]; } }
  const token = 'gbd_' + crypto.randomBytes(24).toString('hex');
  const rec = { token, owner, deviceId: id, name: String(name || id).slice(0, 60), createdAt: Date.now() };
  all[token] = rec; write(all); keys.set(token, entryOf(rec));
  return rec;
}

/** The owner's devices (never the token itself). */
function list(owner) {
  return Object.values(read()).filter((r) => r.owner === owner).map((r) => ({ deviceId: r.deviceId, name: r.name, createdAt: r.createdAt }));
}

/** Revoke one device's login (by deviceId), owner-scoped. */
function revoke(keys, owner, deviceId) {
  const all = read(); let gone = 0;
  for (const [k, rec] of Object.entries(all)) { if (rec.owner === owner && rec.deviceId === String(deviceId)) { keys.delete(rec.token); delete all[k]; gone++; } }
  if (gone) write(all);
  return gone;
}

module.exports = { load, mint, list, revoke, FILE };
