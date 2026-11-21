// cloud-login-copy.test.js — the cloud's copy of a phone login goes from every place it was kept (2026-11-21).
//
// A profile that copied its login to the cluster ("phone + cluster") is set back to living on the phone. The
// copy was in three places: the pending cookies (applied at every launch), the vault snapshot (puts a "lost"
// session back) and the browser's jar. Leaving any one of them brings the login back to the datacenter.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const copy = require('../src/cloudLoginCopy');
const pool = readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

let dir;
const fb = (name) => ({ name, value: 'v', domain: '.facebook.com', path: '/' });
const g = (name) => ({ name, value: 'v', domain: '.google.com', path: '/' });
function ctx(cookies) {
  return { cookies, cleared: [], async clearCookies({ domain }) { this.cleared.push(String(domain)); this.cookies = this.cookies.filter((c) => !domain.test(c.domain.replace(/^\./, ''))); } };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-copy-'));
  mkdirSync(join(dir, 'facebook')); mkdirSync(join(dir, 'facebook-watch'));
  writeFileSync(join(dir, 'facebook', 'pending-cookies.json'), JSON.stringify([fb('c_user'), fb('xs')]));
  writeFileSync(join(dir, 'facebook', '.gb-session.json'), JSON.stringify({ at: 1, cookies: [fb('c_user'), fb('xs'), g('SID')] }));
  writeFileSync(join(dir, 'facebook-watch', '.gb-session.json'), JSON.stringify({ at: 1, cookies: [fb('c_user')] }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('forgetting the cloud copy', () => {
  it('removes the pending cookies, takes the site out of the vault (keeping other sites), and clears the open browser', async () => {
    const open = ctx([fb('c_user'), g('SID')]);
    const r = await copy.forget({ profileDir: dir, profile: 'facebook', contexts: [open] });
    expect(r.sites).toEqual(['facebook.com']);
    expect(existsSync(join(dir, 'facebook', 'pending-cookies.json'))).toBe(false);
    const vault = JSON.parse(readFileSync(join(dir, 'facebook', '.gb-session.json'), 'utf8'));
    expect(vault.cookies.map((c) => c.name)).toEqual(['SID']);              // the Google login made on the cluster stays
    expect(existsSync(join(dir, 'facebook-watch', '.gb-session.json'))).toBe(false);   // the watch copy held only Facebook
    expect(open.cookies.map((c) => c.name)).toEqual(['SID']);
    expect(r.vaultRemoved).toBe(3);
  });

  it('a browser that is closed now is cleared at its next launch, before a page loads', async () => {
    await copy.forget({ profileDir: dir, profile: 'facebook' });
    expect(JSON.parse(readFileSync(join(dir, 'facebook', copy.PURGE_FILE), 'utf8'))).toEqual(['facebook.com']);
    const later = ctx([fb('c_user'), fb('xs'), g('SID')]);
    expect(await copy.applyPurge(join(dir, 'facebook'), later, { info() {}, warn() {} })).toBe(1);
    expect(later.cookies.map((c) => c.name)).toEqual(['SID']);
    expect(existsSync(join(dir, 'facebook', copy.PURGE_FILE))).toBe(false);
    expect(await copy.applyPurge(join(dir, 'facebook'), later, { info() {} })).toBe(0);   // asked once, done once
  });

  it('the site the app names is cleared even when no pending file is left', async () => {
    rmSync(join(dir, 'facebook', 'pending-cookies.json'));
    const r = await copy.forget({ profileDir: dir, profile: 'facebook', sites: ['https://www.facebook.com/'.replace(/^https:\/\//, '').replace(/\/$/, '')] });
    expect(r.sites).toEqual(['facebook.com']);
  });

  it('knows a cookie\'s site from its domain or its url', () => {
    expect(copy.siteOf({ domain: '.m.facebook.com' })).toBe('facebook.com');
    expect(copy.siteOf({ url: 'https://www.linkedin.com/' })).toBe('linkedin.com');
    expect(copy.siteOf({})).toBe('');
  });
});

describe('wired in', () => {
  it('the launch clears a purged site after the vault restore, before the first page', () => {
    expect(pool).toMatch(/restore skipped[\s\S]{0,400}applyPurge\(dir, persistent, this\.log\)[\s\S]{0,200}const page = persistent\.pages\(\)\[0\]/);
  });
  it('the app has a route to ask for it', () => {
    expect(server).toMatch(/app\.delete\('\/v1\/profiles\/:name\/cookies', authed,[\s\S]{0,1200}cloudLoginCopy'\)\.forget\(/);
  });
});
