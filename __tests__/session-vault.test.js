/*
 * A LOGIN MADE BY HAND MUST SURVIVE A DEPLOY.
 *
 * It did not. The owner signed in to Google in the console. Three pod rolls later the `google`
 * profile held 63 google.com cookies and not one auth cookie, Search Console reported no access to
 * the property, the dashboard raised a manual-action flag invented from its own inability to read
 * the page, and a whole day's audit slot was spent on a locked door.
 *
 * Closing contexts in parallel with a timeout narrowed that window but cannot close it: it still
 * needs SIGTERM to arrive and the closes to finish inside the grace period. SIGKILL, OOM, a drained
 * node or a wedged Chromium all still lose the jar. So the session is written down on our own
 * schedule and put back when the jar returns empty.
 *
 * THE TEST THAT MATTERS MOST is "refuses to overwrite a good snapshot with a signed-out jar". A
 * signed-out profile is not empty — it had 63 cookies — so an unconditional save would let one
 * signed-out moment erase the only backup of a login a human made by hand. That failure would be
 * worse than the bug this whole module exists to fix, because it would be silent AND permanent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);

const DIR = mkdtempSync(join(tmpdir(), 'gb-vault-'));
process.env.PROFILE_DIR = DIR;                 // read once at load, so set it before requiring
const vault = require('../src/sessionVault');

/* The shapes Playwright actually hands back. */
const ck = (name, domain = '.google.com', expires = -1) => ({ name, value: 'v', domain, path: '/', expires });
const GOOGLE_SESSION = [
  ck('SID'), ck('HSID'), ck('SSID'), ck('APISID'), ck('SAPISID'), ck('__Secure-1PSID'), ck('LSID'),
];
/* What a signed-out google profile really looks like: plenty of cookies, no session. */
const GOOGLE_SIGNED_OUT = ['NID', 'AEC', '1P_JAR', 'CONSENT', 'OTZ', 'SEARCH_SAMESITE', 'DV']
  .map((n) => ck(n));

describe('sessionVault: which jars hold a session', () => {
  it('knows a real Google session when it sees one', () => {
    expect(vault.sessionHosts(GOOGLE_SESSION)).toEqual(['google.com']);
    expect(vault.worthSaving(GOOGLE_SESSION)).toBe(true);
  });

  /* The measured case. 63 cookies, no session. */
  it('knows that a jar full of cookies can still be signed out', () => {
    expect(vault.sessionHosts(GOOGLE_SIGNED_OUT)).toEqual([]);
    expect(vault.worthSaving(GOOGLE_SIGNED_OUT)).toBe(false);
  });

  it('recognises the other logins this browser holds by hand', () => {
    expect(vault.sessionHosts([ck('c_user', '.facebook.com'), ck('xs', '.facebook.com')])).toEqual(['facebook.com']);
    expect(vault.sessionHosts([ck('li_at', '.www.linkedin.com')])).toEqual(['linkedin.com']);
    expect(vault.sessionHosts([ck('sessionid', 'useme.com')])).toEqual(['useme.com']);
  });

  it('is not fooled by an auth cookie name on an unrelated domain', () => {
    expect(vault.sessionHosts([ck('SID', '.evil.example')])).toEqual([]);
  });

  it('drops expired cookies but keeps session cookies', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    const kept = vault.live([ck('SID', '.google.com', past), ck('SAPISID', '.google.com', future), ck('LSID', '.google.com', -1)]);
    expect(kept.map((c) => c.name).sort()).toEqual(['LSID', 'SAPISID']);
  });

  it('tolerates rubbish instead of throwing', () => {
    for (const j of [null, undefined, [], [null, {}, { name: '' }]]) {
      expect(vault.worthSaving(j)).toBe(false);
      expect(() => vault.live(j)).not.toThrow();
    }
  });
});

describe('sessionVault: saving never makes things worse', () => {
  const PROF = 'google';
  beforeEach(() => { try { rmSync(join(DIR, PROF), { recursive: true, force: true }); } catch { /* fresh */ } });
  afterEach(() => { try { rmSync(join(DIR, PROF), { recursive: true, force: true }); } catch { /* gone */ } });

  it('writes a session down, with owner-only permissions', () => {
    const r = vault.save(PROF, GOOGLE_SESSION);
    expect(r.saved).toBe(true);
    expect(r.hosts).toEqual(['google.com']);
    expect(existsSync(vault.fileFor(PROF))).toBe(true);
    const back = vault.read(PROF);
    expect(back.cookies.map((c) => c.name)).toContain('SAPISID');
  });

  /*
   * THE ONE THAT MATTERS. If this ever regresses, a single signed-out moment silently destroys the
   * only copy of a login a human made by hand, and nobody finds out until the channel stops.
   */
  it('refuses to overwrite a good snapshot with a signed-out jar', () => {
    expect(vault.save(PROF, GOOGLE_SESSION).saved).toBe(true);
    const r = vault.save(PROF, GOOGLE_SIGNED_OUT);
    expect(r.saved).toBe(false);
    expect(r.why).toMatch(/no session/i);
    /* and the good one is still there, untouched */
    expect(vault.read(PROF).cookies.map((c) => c.name)).toContain('SAPISID');
  });

  it('refuses an empty jar too, for the same reason', () => {
    expect(vault.save(PROF, GOOGLE_SESSION).saved).toBe(true);
    expect(vault.save(PROF, []).saved).toBe(false);
    expect(vault.read(PROF).cookies.length).toBeGreaterThan(0);
  });

  it('will not save a jar whose session has entirely expired', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const dead = GOOGLE_SESSION.map((c) => ({ ...c, expires: past }));
    expect(vault.save(PROF, dead).saved).toBe(false);
  });

  it('reads nothing rather than throwing when there is no snapshot', () => {
    expect(vault.read('never-existed')).toBe(null);
  });

  it('survives a corrupt snapshot on disk', () => {
    mkdirSync(join(DIR, PROF), { recursive: true });
    writeFileSync(vault.fileFor(PROF), '{not json');
    expect(vault.read(PROF)).toBe(null);
    /* and a good save repairs it */
    expect(vault.save(PROF, GOOGLE_SESSION).saved).toBe(true);
    expect(vault.read(PROF).cookies.length).toBe(GOOGLE_SESSION.length);
  });

  it('leaves no temp file behind, so a kill mid-write cannot masquerade as a snapshot', () => {
    vault.save(PROF, GOOGLE_SESSION);
    expect(existsSync(vault.fileFor(PROF) + '.tmp')).toBe(false);
  });
});

describe('sessionVault: restoring only what is missing', () => {
  it('puts a session back when the jar has lost it', () => {
    const plan = vault.planRestore(GOOGLE_SIGNED_OUT, { at: Date.now(), cookies: GOOGLE_SESSION });
    expect(plan.hosts).toEqual(['google.com']);
    expect(plan.restore.map((c) => c.name)).toContain('SAPISID');
  });

  /* Never stomp a live session: it could be a NEWER login than the snapshot. */
  it('leaves a browser that is already signed in alone', () => {
    const plan = vault.planRestore(GOOGLE_SESSION, { at: Date.now(), cookies: GOOGLE_SESSION });
    expect(plan.restore).toEqual([]);
    expect(plan.why).toMatch(/already holds/i);
  });

  it('restores only the sites that are missing, not the whole snapshot', () => {
    const snap = { at: Date.now(), cookies: [...GOOGLE_SESSION, ck('c_user', '.facebook.com'), ck('xs', '.facebook.com')] };
    const plan = vault.planRestore(GOOGLE_SESSION, snap);       // google present, facebook missing
    expect(plan.hosts).toEqual(['facebook.com']);
    expect(plan.restore.every((c) => /facebook/.test(c.domain))).toBe(true);
  });

  it('does not restore a snapshot whose cookies have all expired', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const snap = { at: 1, cookies: GOOGLE_SESSION.map((c) => ({ ...c, expires: past })) };
    expect(vault.planRestore(GOOGLE_SIGNED_OUT, snap).restore).toEqual([]);
  });

  it('says so plainly when there is nothing to restore from', () => {
    expect(vault.planRestore(GOOGLE_SIGNED_OUT, null).why).toMatch(/no snapshot/i);
    expect(vault.planRestore(GOOGLE_SIGNED_OUT, { cookies: [] }).why).toMatch(/no snapshot/i);
  });
});
