/*
 * MANAGING A LOGGED-IN IDENTITY.
 *
 * Creating, renaming, duplicating and signing out were things only a session could do by accident:
 * a profile appeared the first time one was opened, and the only way to be rid of a bad login was
 * to delete the profile — taking its timezone, its exit and its role with it.
 *
 * Two rules carry the weight here, and both are things that go wrong quietly:
 *
 *   - NOTHING TOUCHES A PROFILE DIRECTORY WHILE A BROWSER IS IN IT. removeProfile learned that
 *     first; renaming, duplicating and clearing are the same act on the same directory.
 *   - A DUPLICATE COPIES SETTINGS, NEVER COOKIES. Two profiles believing they are the same account
 *     is the fastest way to get both locked out: one session token arriving from two browsers is
 *     exactly what a risk engine looks for.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-manage-'));
process.env.PROFILE_DIR = dir;
const profiles = await import('../src/profiles.js');
const { BrowserPool } = await import('../src/pool.js');

/** A pool with no browser: every operation under test is filesystem work plus the open-check. */
const newPool = () => {
  const p = Object.create(BrowserPool.prototype);
  p.sessions = new Map();
  p.log = {};
  return p;
};

const write = (name, cfg = {}) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); profiles.write(name, cfg); };
const cookies = (name) => {
  fs.mkdirSync(path.join(dir, name, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'Default', 'Cookies'), 'not really sqlite but not empty');
};

beforeEach(() => { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true }); });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('creating a profile on purpose', () => {
  it('makes a directory with its settings, so a second identity can be planned', () => {
    const p = newPool();
    expect(p.createProfile('work-video', { site: 'capcut.com', timezone: 'Europe/Amsterdam' })).toBe('work-video');
    expect(profiles.read('work-video')).toMatchObject({ site: 'capcut.com', timezone: 'Europe/Amsterdam' });
  });

  it('refuses one that already exists rather than writing over it', () => {
    const p = newPool();
    write('capcut', { site: 'capcut.com' });
    expect(() => p.createProfile('capcut')).toThrow(/already exists/);
    /* And the original is untouched. */
    expect(profiles.read('capcut').site).toBe('capcut.com');
  });

  it('cleans the name the same way every other door does', () => {
    /* safeName keeps only [a-z0-9_-], so dots and slashes are gone: a name can never walk out of
       the profiles directory, whatever a caller sends. */
    const p = newPool();
    expect(p.createProfile('My Work/../Video!')).toBe('MyWorkVideo');
    expect(p.createProfile('')).toBe('default');
  });
});

describe('renaming keeps the login', () => {
  it('moves the directory, cookies and settings together', () => {
    const p = newPool();
    write('capcut', { site: 'capcut.com', defaultRole: 'capcut-video-editor' });
    cookies('capcut');
    expect(p.renameProfile('capcut', 'capcut-work')).toBe('capcut-work');
    expect(fs.existsSync(path.join(dir, 'capcut'))).toBe(false);
    expect(profiles.read('capcut-work')).toMatchObject({ site: 'capcut.com', defaultRole: 'capcut-video-editor' });
    expect(profiles.hasLogin('capcut-work')).toBe(true);
  });

  it('refuses to land on a name already in use', () => {
    const p = newPool();
    write('a'); write('b');
    expect(() => p.renameProfile('a', 'b')).toThrow(/already exists/);
    expect(fs.existsSync(path.join(dir, 'a'))).toBe(true);
  });

  it('is a no-op for the same name, not an error', () => {
    const p = newPool();
    write('a');
    expect(p.renameProfile('a', 'a')).toBe('a');
  });

  it('refuses one that does not exist', () => {
    expect(() => newPool().renameProfile('ghost', 'x')).toThrow(/no such profile/);
  });

  it('REFUSES while a session holds it, and says what to do', () => {
    const p = newPool();
    write('capcut');
    p.sessions.set('s-1', { profile: 'capcut' });
    expect(() => p.renameProfile('capcut', 'x')).toThrow(/is open — close that session first, then rename it/);
    expect(fs.existsSync(path.join(dir, 'capcut'))).toBe(true);
  });
});

describe('duplicating gives a second identity, not a second copy of one', () => {
  it('carries the settings', () => {
    const p = newPool();
    write('capcut', { site: 'capcut.com', timezone: 'Europe/Amsterdam', defaultRole: 'capcut-video-editor' });
    expect(p.duplicateProfile('capcut', 'capcut-second')).toBe('capcut-second');
    expect(profiles.read('capcut-second')).toMatchObject({
      site: 'capcut.com', timezone: 'Europe/Amsterdam', defaultRole: 'capcut-video-editor',
    });
  });

  it('does NOT carry the cookies — that would get both accounts locked out', () => {
    const p = newPool();
    write('capcut', { site: 'capcut.com' });
    cookies('capcut');
    p.duplicateProfile('capcut', 'capcut-second');
    expect(profiles.hasLogin('capcut')).toBe(true);
    expect(profiles.hasLogin('capcut-second')).toBe(false);
  });

  it('does not carry the note, which described the original', () => {
    const p = newPool();
    write('capcut', { site: 'capcut.com', note: 'my business page' });
    p.duplicateProfile('capcut', 'capcut-second');
    expect(profiles.read('capcut-second').note).toBe('');
  });

  it('leaves the original exactly as it was', () => {
    const p = newPool();
    write('capcut', { site: 'capcut.com', note: 'my business page' });
    p.duplicateProfile('capcut', 'capcut-second');
    expect(profiles.read('capcut')).toMatchObject({ site: 'capcut.com', note: 'my business page' });
  });

  it('refuses to overwrite, and refuses a source that is not there', () => {
    const p = newPool();
    write('a'); write('b');
    expect(() => p.duplicateProfile('a', 'b')).toThrow(/already exists/);
    expect(() => p.duplicateProfile('ghost', 'c')).toThrow(/no such profile/);
  });
});

describe('clearing a login without throwing the identity away', () => {
  it('removes the cookie stores and keeps the settings', () => {
    /* Deleting the profile to get rid of a bad login also deletes its timezone, its exit and its
       role, and those took thought. */
    const p = newPool();
    write('facebook', { site: 'facebook.com', timezone: 'Europe/Amsterdam', defaultRole: 'facebook-reply-desk' });
    cookies('facebook');
    const r = p.clearProfileLogin('facebook');
    expect(r.cleared).toBeGreaterThan(0);
    expect(profiles.hasLogin('facebook')).toBe(false);
    expect(profiles.read('facebook')).toMatchObject({
      site: 'facebook.com', timezone: 'Europe/Amsterdam', defaultRole: 'facebook-reply-desk',
    });
  });

  it('is harmless on a profile that was never signed into', () => {
    const p = newPool();
    write('fresh');
    expect(p.clearProfileLogin('fresh')).toMatchObject({ profile: 'fresh', cleared: 0 });
  });

  it('REFUSES while a session holds it', () => {
    const p = newPool();
    write('facebook'); cookies('facebook');
    p.sessions.set('s-1', { profile: 'facebook' });
    expect(() => p.clearProfileLogin('facebook')).toThrow(/close that session first, then clear its login/);
    expect(profiles.hasLogin('facebook')).toBe(true);
  });

  it('refuses one that does not exist', () => {
    expect(() => newPool().clearProfileLogin('ghost')).toThrow(/no such profile/);
  });
});

describe('deleting still refuses while it is open, through the shared rule', () => {
  it('says delete it, not rename it', async () => {
    const p = newPool();
    write('capcut');
    p.sessions.set('s-1', { profile: 'capcut' });
    await expect(p.removeProfile('capcut')).rejects.toThrow(/close that session first, then delete it/);
  });
});
