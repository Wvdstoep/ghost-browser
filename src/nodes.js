'use strict';
/*
 * GPU NODES - machines made of a Python session with a GPU.
 *
 * A laptop becomes a machine by running the desktop app. A GPU session (Modal, Colab, Kaggle)
 * becomes one by running training/gb_node.py with the hub's address and a device token filled
 * in. The owner mints a JOIN CODE on the Machines page; the hub serves the script for that code
 * with everything filled in, so the session needs nothing typed into it. The code is a secret
 * good for a day (a Modal or Kaggle restart re-fetches it) and can be revoked, which revokes the
 * device token with it.
 *
 * Modal is driven from here: `modal run --detach training/gb_modal.py --join-url <url>` with
 * the owner's token in the environment. The node leaves by itself when idle, so a detached
 * function costs only while it works.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'nodes.json');
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(p + '.tmp', p); };

const JOIN_MS = 24 * 3600 * 1000;
const KINDS = ['modal', 'colab', 'kaggle', 'gpu'];
const LABEL = { modal: 'Modal', colab: 'Colab', kaggle: 'Kaggle', gpu: 'GPU' };

function all() {
  const s = readJson(FILE(), null);
  return s && typeof s === 'object' ? { joins: s.joins || {}, modal: s.modal || {} } : { joins: {}, modal: {} };
}
function save(s) { writeJson(FILE(), s); }

/** A new join: a device token minted by the caller, a code, a name. */
function mintJoin({ kind = 'gpu', name = '', token = '', deviceId = '', owner = '', publicUrl = '' } = {}) {
  const k = KINDS.includes(kind) ? kind : 'gpu';
  const s = all();
  const code = crypto.randomBytes(9).toString('base64url');
  const n = Object.values(s.joins).filter((j) => j.kind === k).length + 1;
  const rec = { code, kind: k, name: name || `${LABEL[k]} node ${n}`, token, deviceId, owner, publicUrl, at: new Date().toISOString(), uses: 0 };
  s.joins[code] = rec;
  save(s);
  return rec;
}
function joinFor(code, now = Date.now()) {
  const s = all();
  const j = s.joins[String(code || '')];
  if (!j) return null;
  if (now - (Date.parse(j.at) || 0) > JOIN_MS) return null;
  return j;
}
function useJoin(code) {
  const s = all();
  const j = s.joins[String(code || '')];
  if (!j) return null;
  j.uses = (j.uses || 0) + 1; j.lastUse = new Date().toISOString();
  save(s);
  return j;
}
function revokeJoin(code) {
  const s = all();
  const j = s.joins[String(code || '')];
  if (!j) return null;
  delete s.joins[code];
  save(s);
  return j;
}
function joins(now = Date.now()) {
  return Object.values(all().joins).map((j) => ({ ...j, token: undefined, expired: now - (Date.parse(j.at) || 0) > JOIN_MS }));
}

/** The node script for a join, with the hub, the token, the device and the name filled in. */
function scriptFor(j, publicUrl = '') {
  const src = fs.readFileSync(path.join(__dirname, '..', 'training', 'gb_node.py'), 'utf8');
  const hub = String(publicUrl || j.publicUrl || '').replace(/\/+$/, '');
  return src
    .replace('"__HUB__"', JSON.stringify(hub))
    .replace('"__TOKEN__"', JSON.stringify(j.token || ''))
    .replace('"__DEVICE__"', JSON.stringify(j.deviceId || ''))
    .replace('"__NAME__"', JSON.stringify(j.name || 'GPU node'))
    .replace('"__KIND__"', JSON.stringify(j.kind || 'gpu'));
}
const joinUrl = (j, publicUrl = '') => `${String(publicUrl || j.publicUrl || '').replace(/\/+$/, '')}/v1/training/node.py?join=${encodeURIComponent(j.code)}`;
const pasteLine = (j, publicUrl = '') => `curl -fsSL "${joinUrl(j, publicUrl)}" | python3 -`;

/* ── Modal ───────────────────────────────────────────────────────────────────────────────────── */
const MODAL_BIN = () => process.env.MODAL_BIN || '/opt/modal/bin/modal';
function modalState() { return all().modal || {}; }
function modalPatch(p) { const s = all(); s.modal = { ...(s.modal || {}), ...p }; save(s); return s.modal; }
function modalReady() { try { return fs.existsSync(MODAL_BIN()); } catch { return false; } }

/**
 * Start a node on Modal: one detached function with the join url. Resolves with what the CLI
 * printed (the app id when it gave one). The owner's token travels in the environment only.
 */
function modalStart({ tokenId, tokenSecret, joinUrl: url, gpu = 'T4', idleExit = 900, cwd = path.join(__dirname, '..') } = {}) {
  return new Promise((resolve) => {
    if (!modalReady()) return resolve({ ok: false, error: 'the hub image has no Modal client yet (rebuild with the Dockerfile that installs it)' });
    if (!tokenId || !tokenSecret) return resolve({ ok: false, error: 'no Modal token — paste the token id and secret first' });
    const env = { ...process.env, MODAL_TOKEN_ID: tokenId, MODAL_TOKEN_SECRET: tokenSecret, GB_MODAL_GPU: gpu, HOME: process.env.HOME || '/tmp', PYTHONUNBUFFERED: '1' };
    const args = ['run', '--detach', 'training/gb_modal.py', '--join-url', url, '--idle-exit', String(idleExit)];
    let out = '';
    let done = false;
    const finish = (res) => { if (!done) { done = true; resolve(res); } };
    let p;
    try { p = spawn(MODAL_BIN(), args, { cwd, env }); } catch (e) { return finish({ ok: false, error: e.message }); }
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { out += b.toString(); });
    p.on('error', (e) => finish({ ok: false, error: e.message, out: out.slice(-1200) }));
    p.on('close', (code) => {
      const app = (/\b(ap-[A-Za-z0-9]+)\b/.exec(out) || [])[1] || '';
      const spawned = /node spawned/.test(out);
      finish({ ok: code === 0 && (spawned || !!app), code, app, out: out.slice(-1200) });
    });
    setTimeout(() => { try { p.kill(); } catch {} finish({ ok: false, error: 'modal run took longer than 15 minutes (image build?) — check the Modal dashboard', out: out.slice(-1200) }); }, 15 * 60 * 1000).unref?.();
  });
}
function modalStop({ tokenId, tokenSecret, app, cwd = path.join(__dirname, '..') } = {}) {
  return new Promise((resolve) => {
    if (!modalReady() || !app) return resolve({ ok: false, error: !app ? 'no Modal app to stop' : 'no Modal client' });
    const env = { ...process.env, MODAL_TOKEN_ID: tokenId, MODAL_TOKEN_SECRET: tokenSecret, HOME: process.env.HOME || '/tmp' };
    let out = '';
    const p = spawn(MODAL_BIN(), ['app', 'stop', '--yes', app], { cwd, env });
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { out += b.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, out: out.slice(-600) }));
  });
}

module.exports = { KINDS, LABEL, JOIN_MS, mintJoin, joinFor, useJoin, revokeJoin, joins, scriptFor, joinUrl, pasteLine, modalState, modalPatch, modalReady, modalStart, modalStop, FILE };
