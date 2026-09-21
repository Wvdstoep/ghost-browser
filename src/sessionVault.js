/*
 * A LOGIN MADE BY HAND MUST SURVIVE A DEPLOY.
 *
 * It did not. The owner signed in to Google in the console; three pod rolls later the `google`
 * profile held 63 google.com cookies and not one auth cookie, Search Console reported no access to
 * the property, and a day's audit slot was spent on a locked door. The login was never revoked. It
 * was never written to disk.
 *
 * Closing contexts in parallel with a timeout (see pool.shutdown) narrowed that window but cannot
 * close it, because it still depends on SIGTERM arriving and the closes finishing inside the pod's
 * grace period. A SIGKILL, an OOM, a drained node or a wedged Chromium all still lose the jar.
 *
 * So the session is written down on OUR schedule, in our own file, and put back if the jar comes
 * back empty. Chromium's persistence becomes an optimisation rather than the only copy.
 *
 * THE INVARIANT THAT MATTERS MOST: a snapshot is never replaced by a worse one. A signed-out jar
 * holds plenty of cookies (63 of them, in the case that started this) and no session, so saving
 * unconditionally would let one signed-out moment erase the only backup of a login a human made by
 * hand. Every write is therefore gated on the jar actually carrying a session.
 *
 * This is not automating a sign-in. Accounts are born by a human, once, in the console. This is what
 * makes that once actually mean once.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROFILE_DIR = process.env.PROFILE_DIR || '/profiles';
const FILE = '.gb-session.json';

/*
 * The cookies that CONSTITUTE a session, per site. Everything else is preference and telemetry:
 * restoring it proves nothing and saving it protects nothing.
 */
const AUTH_BY_HOST = {
  'google.com': ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LSID'],
  'facebook.com': ['c_user', 'xs'],
  'linkedin.com': ['li_at', 'JSESSIONID'],
  'useme.com': ['sessionid', 'csrftoken'],
  'github.com': ['user_session', '__Host-user_session_same_site'],
};

const hostOf = (c) => String((c && c.domain) || '').replace(/^\./, '').toLowerCase();

/** Which known sites does this jar actually hold a session for? Pure. */
function sessionHosts(cookies) {
  const have = new Set();
  for (const c of cookies || []) {
    if (!c || !c.name) continue;
    const h = hostOf(c);
    for (const site of Object.keys(AUTH_BY_HOST)) {
      if (h === site || h.endsWith('.' + site)) {
        if (AUTH_BY_HOST[site].includes(String(c.name))) have.add(site);
      }
    }
  }
  return [...have];
}

/**
 * Is this jar worth saving? Only if it carries a real session for something.
 * This is the guard that stops a signed-out moment erasing a hand-made login.
 */
function worthSaving(cookies) {
  return sessionHosts(cookies).length > 0;
}

/** Cookies that have not expired. Restoring a dead cookie just re-creates the signed-out state. */
function live(cookies, now = Date.now() / 1000) {
  return (cookies || []).filter((c) => {
    if (!c || !c.name) return false;
    const e = Number(c.expires);
    if (!Number.isFinite(e) || e <= 0) return true;       // session cookie: keep, it is still valid
    return e > now;
  });
}

const fileFor = (profile) => path.join(PROFILE_DIR, String(profile || ''), FILE);

/**
 * Write the jar down, but ONLY if it holds a session. Returns what it did, so a caller can log a
 * refusal rather than believing a save happened.
 */
function save(profile, cookies, opts = {}) {
  const log = opts.log || null;
  if (!profile) return { saved: false, why: 'no profile' };
  const keep = live(cookies);
  if (!worthSaving(keep)) {
    /* The important refusal. Overwriting here would destroy the only copy of a real login. */
    return { saved: false, why: 'the jar holds no session, so the existing snapshot is left alone' };
  }
  const f = fileFor(profile);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    /* Write-then-rename, so a kill mid-write cannot leave a truncated snapshot where a good one was. */
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), cookies: keep }, null, 0), { mode: 0o600 });
    fs.renameSync(tmp, f);
    const hosts = sessionHosts(keep);
    log?.info?.(`[vault] saved ${keep.length} cookie(s) for "${profile}" — session for ${hosts.join(', ')}`);
    return { saved: true, hosts, count: keep.length };
  } catch (e) {
    log?.warn?.(`[vault] could not save "${profile}": ${e.message}`);
    return { saved: false, why: e.message };
  }
}

/** What is on disk for this profile, or null. */
function read(profile) {
  try {
    const j = JSON.parse(fs.readFileSync(fileFor(profile), 'utf8'));
    return Array.isArray(j.cookies) ? { at: Number(j.at) || 0, cookies: j.cookies } : null;
  } catch { return null; }
}

/**
 * What a restore SHOULD do, decided before touching a browser so it can be tested.
 * Returns { restore: [...], why }.
 */
function planRestore(jarNow, snapshot, now = Date.now() / 1000) {
  if (!snapshot || !snapshot.cookies || !snapshot.cookies.length) {
    return { restore: [], why: 'no snapshot on disk' };
  }
  const already = new Set(sessionHosts(jarNow));
  const usable = live(snapshot.cookies, now);
  const hosts = sessionHosts(usable);
  /* Only put back sessions the live jar is MISSING: never stomp a session the browser already has,
     which could be a newer login than the snapshot. */
  const missing = hosts.filter((h) => !already.has(h));
  if (!missing.length) {
    return { restore: [], why: already.size ? 'the browser already holds every session in the snapshot' : 'the snapshot holds no live session' };
  }
  const wanted = usable.filter((c) => {
    const h = hostOf(c);
    return missing.some((m) => h === m || h.endsWith('.' + m));
  });
  return { restore: wanted, why: `restoring ${missing.join(', ')} from the snapshot`, hosts: missing };
}

module.exports = { AUTH_BY_HOST, FILE, sessionHosts, worthSaving, live, save, read, planRestore, fileFor };
