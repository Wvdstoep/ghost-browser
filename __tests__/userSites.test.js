/**
 * Sites the OWNER authors as DATA — a URL and (if any exist) the roles that work there.
 *
 * The whole point is that this needs no code change and no deploy: it stores an authored site and
 * MERGES it into the preset machinery, so `sites.get(key)` opens it and `sites.list()` lists it
 * exactly like a shipped one. These tests pin both halves — the store, and the merge.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-us-'));
process.env.PROFILE_DIR = dir;
const us = await import('../src/userSites.js');
const sites = await import('../src/sites/index.js');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => { try { fs.rmSync(us.FILE, { force: true }); } catch { /* fresh anyway */ } });

describe('authoring a site', () => {
  it('takes a bare host and a full URL alike, and derives the matchable site label', () => {
    const a = us.create({ label: 'CapCut', url: 'https://www.capcut.com/login', roles: ['video.capcut'] });
    expect(a.site).toBe('capcut.com');                 // www stripped, lowercased — the agent matches on this
    expect(a.start).toBe('https://www.capcut.com/login'); // the login page it opens on, kept verbatim
    expect(a.roles).toEqual(['video.capcut']);

    const b = us.create({ label: 'Kling', url: 'klingai.com' });   // no scheme → https, home page
    expect(b.site).toBe('klingai.com');
    expect(b.start).toBe('https://klingai.com');
  });

  it('refuses a site with no usable URL', () => {
    expect(() => us.create({ label: 'Nothing', url: '' })).toThrow(/URL/i);
  });

  it('mints a unique key that never shadows a shipped preset', () => {
    // A label that slugs to a built-in ("google") must not collide with the shipped google preset.
    const g = us.create({ label: 'Google', url: 'https://labs.google/' });
    expect(g.key).not.toBe('google');                  // suffixed away from the reserved built-in
    expect(sites.SITES.google).toBeTruthy();
    // sites.get('google') still returns the BUILT-IN, never the authored one.
    expect(sites.get('google').site).toBe('google.com');
  });

  it('keeps keys distinct when two sites share a label', () => {
    const one = us.create({ label: 'Studio', url: 'a.com' });
    const two = us.create({ label: 'Studio', url: 'b.com' });
    expect(one.key).not.toBe(two.key);
    expect(us.list().map((x) => x.key).sort()).toEqual([one.key, two.key].sort());
  });

  it('changes the attached roles after the fact, and forgets a site', () => {
    const c = us.create({ label: 'CapCut', url: 'capcut.com' });
    us.setRoles(c.key, ['video.capcut', 'video.upload']);
    expect(us.get(c.key).roles).toEqual(['video.capcut', 'video.upload']);
    expect(us.remove(c.key)).toBe(true);
    expect(us.get(c.key)).toBeNull();
    expect(us.remove('gone')).toBe(false);
  });
});

describe('merging authored sites into the preset flow', () => {
  it('sites.get() returns an authored site dressed as a preset, so session-open just works', () => {
    const c = us.create({ label: 'CapCut', url: 'https://www.capcut.com/login', roles: ['video.capcut'] });
    const preset = sites.get(c.key);
    expect(preset).toBeTruthy();
    expect(preset.site).toBe('capcut.com');
    expect(preset.start).toBe('https://www.capcut.com/login');
    expect(preset.custom).toBe(true);
    expect(preset.defaults.blockPasskeys).toBe(true);   // a sane default so the login does not hang
    expect(preset.hint).toBeTruthy();
  });

  it('sites.list() offers authored sites alongside the built-ins, flagged and carrying their roles', () => {
    us.create({ label: 'CapCut', url: 'capcut.com', roles: ['video.capcut'] });
    const l = sites.list([]);
    // every shipped preset is still there
    for (const k of ['facebook', 'linkedin', 'google', 'useme', 'upwork', 'reddit', 'hn', 'indiehackers']) {
      expect(l.find((x) => x.key === k), k).toBeTruthy();
    }
    const cap = l.find((x) => x.custom);
    expect(cap).toBeTruthy();
    expect(cap.site).toBe('capcut.com');
    expect(cap.url).toBe('https://capcut.com');
    expect(cap.roles).toEqual(['video.capcut']);
    expect(cap.exists).toBe(false);                     // no login saved yet
  });

  it('marks an authored site as already set up when a login is labelled for it', () => {
    const c = us.create({ label: 'CapCut', url: 'capcut.com' });
    const l = sites.list([{ name: 'my-capcut', site: 'capcut.com' }]);
    const cap = l.find((x) => x.key === c.key);
    expect(cap.exists).toBe(true);
    expect(cap.servedBy).toBe('my-capcut');
  });
});
