/**
 * One owner, created on first run.
 *
 * The console asked for the API key on every visit, which is the wrong credential for a human: a
 * key pasted into a browser field ends up in a password manager, a screenshot and eventually a
 * support chat. Programs get Bearer keys; the person who owns the box gets an account.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-auth-'));
process.env.PROFILE_DIR = dir;
const accounts = await import('../src/accounts.js');

const wipe = () => { try { fs.unlinkSync(accounts.FILE); } catch {} };
beforeEach(wipe);
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('the first run, and only the first', () => {
  it('offers signup when there is no account, and never again', () => {
    expect(accounts.needsSignup()).toBe(true);
    accounts.signup('carla', 'a-long-enough-password');
    expect(accounts.needsSignup()).toBe(false);
  });

  it('refuses a second signup — there is no registration page to find', () => {
    accounts.signup('carla', 'a-long-enough-password');
    expect(() => accounts.signup('someone', 'another-long-password')).toThrow(/already has an owner/i);
  });

  it('insists on a password worth having, because this drives a logged-in browser', () => {
    expect(() => accounts.signup('carla', 'short')).toThrow(/at least 10/);
    expect(() => accounts.signup('ab', 'a-long-enough-password')).toThrow(/at least 3/);
  });

  it('never writes the password itself', () => {
    accounts.signup('carla', 'a-long-enough-password');
    const raw = fs.readFileSync(accounts.FILE, 'utf8');
    expect(raw).not.toContain('a-long-enough-password');
    expect(JSON.parse(raw).derived).toMatch(/^[0-9a-f]{128}$/);
  });
});

describe('signing in', () => {
  beforeEach(() => accounts.signup('carla', 'a-long-enough-password'));

  it('accepts the right pair', () => {
    expect(accounts.login('carla', 'a-long-enough-password').username).toBe('carla');
  });

  it('gives the same answer for a wrong username as a wrong password', () => {
    const a = (() => { try { accounts.login('carla', 'nope-nope-nope'); } catch (e) { return e.message; } })();
    const b = (() => { try { accounts.login('nobody', 'a-long-enough-password'); } catch (e) { return e.message; } })();
    expect(a).toBe(b);
  });
});

describe('the session cookie', () => {
  beforeEach(() => accounts.signup('carla', 'a-long-enough-password'));

  it('round-trips, so a restart does not sign the owner out', () => {
    const { token } = accounts.issue(accounts.load());
    expect(accounts.verifyToken(token)).toMatchObject({ username: 'carla' });
  });

  it('rejects a tampered or forged token', () => {
    const { token } = accounts.issue(accounts.load());
    const [body, sig] = token.split('.');
    expect(accounts.verifyToken(body + '.' + 'x'.repeat(sig.length))).toBeNull();
    expect(accounts.verifyToken('garbage')).toBeNull();
    expect(accounts.verifyToken('')).toBeNull();
  });

  it('rejects one that has expired', () => {
    const rec = accounts.load();
    const crypto = require('node:crypto');
    const body = Buffer.from('carla|' + (Date.now() - 1000)).toString('base64url');
    const sig = crypto.createHmac('sha256', rec.sessionSecret).update(body).digest('base64url');
    expect(accounts.verifyToken(body + '.' + sig)).toBeNull();
  });

  it('reads the cookie out of a real header and ignores the others', () => {
    const req = { headers: { cookie: 'other=1; gb_session=abc%3Ddef; more=2' } };
    expect(accounts.readCookie(req)).toBe('abc=def');
    expect(accounts.readCookie({ headers: {} })).toBeNull();
  });
});

/*
 * Getting back in without an administrator.
 *
 * Twice the account had to be cleared over SSH: one owner, no email, nothing to send a recovery
 * link to. That is a reasonable design for a single-owner console and an unreasonable one with no
 * way back. The API key is the way back — it already grants everything this console can do, so
 * letting it clear the account grants nothing new.
 */
describe('reset', () => {
  it('reports whether there was anything to clear', () => {
    wipe();
    expect(accounts.reset()).toBe(false);
    accounts.signup('carla', 'a-long-enough-password');
    expect(accounts.reset()).toBe(true);
  });

  it('puts the console back to offering a signup', () => {
    wipe();
    accounts.signup('carla', 'a-long-enough-password');
    expect(accounts.needsSignup()).toBe(false);
    accounts.reset();
    expect(accounts.needsSignup()).toBe(true);
  });

  it('invalidates the old session, since the secret went with the account', () => {
    wipe();
    const rec = accounts.signup('carla', 'a-long-enough-password');
    const { token } = accounts.issue(rec);
    accounts.reset();
    expect(accounts.verifyToken(token)).toBeNull();
  });
});

/* The rule the user only discovers by failing is not a rule, it is a trap — and this one cost two
   manual resets, because a rejected signup creates no account and then reads as a broken login. */
describe('the password rule is one number, stated and enforced from the same place', () => {
  it('exports the minimum so the form can state it', () => {
    expect(accounts.MIN_PASSWORD).toBeGreaterThanOrEqual(10);
  });

  it('rejects exactly what the stated minimum says it will', () => {
    wipe();
    const short = 'x'.repeat(accounts.MIN_PASSWORD - 1);
    expect(() => accounts.signup('carla', short)).toThrow(new RegExp(String(accounts.MIN_PASSWORD)));
    expect(() => accounts.signup('carla', 'x'.repeat(accounts.MIN_PASSWORD))).not.toThrow();
  });
});


/* ── the password the owner sets, so signing in never depends on the platform ─────────────── */
describe('the password fallback', () => {
  it('an SSO-born account has no usable password until the owner sets one; then email + password opens it', () => {
    accounts.reset();
    accounts.signup('Owner@Example.com', 'random-nobody-types-this');
    accounts.markSso();
    expect(accounts.hasPassword()).toBe(false);
    expect(() => accounts.setPassword('short')).toThrow(/at least/);
    accounts.setPassword('a-real-password-1');
    expect(accounts.hasPassword()).toBe(true);
    /* The address is not case-sensitive; the old password is gone; sessions survive. */
    const before = accounts.load().sessionSecret;
    expect(accounts.login('owner@example.com', 'a-real-password-1').username).toBe('Owner@Example.com');
    expect(() => accounts.login('owner@example.com', 'random-nobody-types-this')).toThrow(/do not match/);
    expect(accounts.load().sessionSecret).toBe(before);
  });
  it('an account created at the gate with a typed password counts as having one', () => {
    accounts.reset();
    accounts.signup('someone', 'typed-by-a-person');
    expect(accounts.hasPassword()).toBe(true);
  });
});
