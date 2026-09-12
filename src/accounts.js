/**
 * accounts.js — one owner, created on first run, logged in after that.
 *
 * The console started out asking for the API key on every visit, which is the wrong shape twice
 * over: a key pasted into a browser field is a key that ends up in a password manager, a screenshot
 * and eventually a support chat, and the person typing it is the owner of the box, not an API
 * client. Those are two different kinds of caller and they deserve two different credentials.
 *
 * So: the API keeps its Bearer keys for programs, and the console gets an account. The FIRST visit
 * offers a signup and creates the only account there is; every visit after that offers a login and
 * nothing else. There is no registration page to find and no invite flow to abuse.
 *
 * Storage is a file on the app's volume rather than a database or a Kubernetes secret. It is one
 * record, it must survive a pod restart, and the volume is already mounted for browser profiles —
 * adding a database for a single row would be the more complicated choice, not the safer one.
 *
 * Sessions are signed rather than stored: the cookie carries the username and an expiry with an
 * HMAC over both, so a restart does not log the owner out and there is no session table to leak.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.PROFILE_DIR || '/profiles';
const FILE = path.join(DIR, '.auth.json');
const COOKIE = 'gb_session';
const SESSION_DAYS = 30;
// Ten, not eight: this console can drive a browser that is logged into things. Exported so the
// signup form states the same number it is checked against — a rule the user only discovers by
// failing is not a rule, it is a trap, and this one cost two manual resets.
const MIN_PASSWORD = 10;

const b64u = (b) => Buffer.from(b).toString('base64url');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return null; }
}

function save(record) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

/*
 * scrypt, not a plain hash. A password file that can be read is a password file that will be
 * cracked offline if the hashing is cheap; scrypt is deliberately expensive in memory as well as
 * time, which is what makes a stolen file worth little.
 */
function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, derived };
}

function verifyPassword(password, record) {
  if (!record) return false;
  const { derived } = hash(password, record.salt);
  // Constant-time: a comparison that returns early leaks how much of the hash matched.
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(record.derived, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Clear the owner account so the first-run signup is offered again. Returns whether one existed. */
function reset() {
  if (!load()) return false;
  try { fs.unlinkSync(FILE); return true; } catch { return false; }
}

/** Is there an account yet? The whole difference between showing signup and showing login. */
function needsSignup() { return !load(); }

function signup(username, password) {
  if (load()) throw Object.assign(new Error('this console already has an owner — sign in instead'), { status: 409 });
  const name = String(username || '').trim();
  if (name.length < 3) throw Object.assign(new Error('pick a username of at least 3 characters'), { status: 400 });
  if (String(password || '').length < MIN_PASSWORD) {
    throw Object.assign(new Error(`pick a password of at least ${MIN_PASSWORD} characters`), { status: 400 });
  }
  const { salt, derived } = hash(password);
  return save({
    username: name, salt, derived,
    // The secret that signs session cookies. Generated once and kept with the account, so a
    // restart does not sign everyone out and there is nothing extra to configure.
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  });
}

function login(username, password) {
  const record = load();
  if (!record) throw Object.assign(new Error('no account yet — create one first'), { status: 404 });
  const ok = String(username || '').trim() === record.username && verifyPassword(password, record);
  // One message for both wrong-username and wrong-password: saying which was wrong tells an
  // attacker they have found the right half.
  if (!ok) throw Object.assign(new Error('that username and password do not match'), { status: 401 });
  return record;
}

function issue(record) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const body = b64u(`${record.username}|${exp}`);
  const sig = crypto.createHmac('sha256', record.sessionSecret).update(body).digest('base64url');
  return { token: `${body}.${sig}`, exp };
}

function verifyToken(token) {
  const record = load();
  if (!record || !token) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', record.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [username, exp] = Buffer.from(body, 'base64url').toString().split('|');
  if (username !== record.username) return null;
  if (!exp || Number(exp) < Date.now()) return null;
  return { username };
}

/** Cookies without a dependency — one header, parsed the obvious way. */
function readCookie(req, name = COOKIE) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(res, token, exp) {
  // httpOnly so a script cannot read it, sameSite=Lax so another site cannot ride it, secure
  // because this is only ever served over TLS.
  res.set('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(exp).toUTCString()}`);
}

function clearCookie(res) {
  res.set('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

module.exports = {
  COOKIE, FILE, needsSignup, signup, login, issue, verifyToken, reset,
  readCookie, setCookie, clearCookie, verifyPassword, hash, load, MIN_PASSWORD,
};
