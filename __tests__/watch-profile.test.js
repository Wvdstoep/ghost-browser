/**
 * The watchers' own browser: the watch copy is cloned from the login profile once (lock files left
 * behind, profile.json carried over), reused afterwards, and its cookies are topped up from the login
 * browser. Temp dirs, fake contexts, no Chromium.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWatchProfile, syncCookies, watchName } from '../src/watchProfile.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));

describe('watch profile', () => {
  it('names the copy once, never twice', () => {
    expect(watchName('facebook')).toBe('facebook-watch');
    expect(watchName('facebook-watch')).toBe('facebook-watch');
  });

  it('clones the login profile without its lock files, carries profile.json, and reuses the copy', () => {
    const dir = tmp(); const src = path.join(dir, 'facebook');
    fs.mkdirSync(path.join(src, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(src, 'Default', 'Cookies'), 'jar');
    fs.writeFileSync(path.join(src, 'SingletonLock'), 'x'); fs.writeFileSync(path.join(src, 'lockfile'), 'x'); fs.writeFileSync(path.join(src, 'DevToolsActivePort'), '1');
    fs.writeFileSync(path.join(src, 'profile.json'), JSON.stringify({ timezone: 'Europe/Amsterdam' }));
    const name = ensureWatchProfile(dir, 'facebook');
    expect(name).toBe('facebook-watch');
    const dst = path.join(dir, name);
    expect(fs.readFileSync(path.join(dst, 'Default', 'Cookies'), 'utf8')).toBe('jar');
    expect(fs.existsSync(path.join(dst, 'SingletonLock'))).toBe(false); expect(fs.existsSync(path.join(dst, 'lockfile'))).toBe(false); expect(fs.existsSync(path.join(dst, 'DevToolsActivePort'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dst, 'profile.json'), 'utf8')).timezone).toBe('Europe/Amsterdam');
    // the copy is the copy's own from now on: a change in the login profile does not overwrite it
    fs.writeFileSync(path.join(src, 'Default', 'Cookies'), 'newer');
    expect(ensureWatchProfile(dir, 'facebook')).toBe('facebook-watch');
    expect(fs.readFileSync(path.join(dst, 'Default', 'Cookies'), 'utf8')).toBe('jar');
  });

  it('makes an empty copy when there is nothing to clone', () => {
    const dir = tmp();
    expect(ensureWatchProfile(dir, 'linkedin')).toBe('linkedin-watch');
    expect(fs.existsSync(path.join(dir, 'linkedin-watch'))).toBe(true);
  });

  it('tops the copy up with the login browser\'s cookies, minus the fields addCookies refuses', async () => {
    const added = [];
    const from = { cookies: async () => [{ name: 'c_user', value: '1', domain: '.facebook.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None', sameParty: false, priority: 'Medium', sourceScheme: 'Secure', sourcePort: 443 }] };
    const to = { addCookies: async (cs) => { added.push(...cs); } };
    expect(await syncCookies(from, to)).toBe(1);
    expect(added[0]).toEqual({ name: 'c_user', value: '1', domain: '.facebook.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' });
    expect(await syncCookies(null, to)).toBe(0);
    expect(await syncCookies({ cookies: async () => [] }, to)).toBe(0);
  });
});
