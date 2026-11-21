// login-home.test.js — a login lives on the device that holds it (2026-11-21).
//
// The owner: "for now I didn't experience a verify you are human at all on mobile, only on the cloud IP, while
// mobile works just fine". Work in a profile the phone holds runs on the phone; the cluster never tries it first
// and never reads it with a copy of the login (the posts watcher did, every hour). These pin the rule, and that
// the server, the poster and the watcher all go through it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loginHome, STARTUP_MS, BUSY_MS } = require('../src/loginHome');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ringSrc = readFileSync(new URL('../src/sessionRing.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const phone = (over = {}) => ({ deviceId: 'p1', name: 'SM-F926B', owner: 'carla', online: true, caps: { realIp: true, platform: 'android', profiles: ['default', 'facebook'] }, ...over });
const desk = (over = {}) => ({ deviceId: 'd1', name: 'DESKTOP', owner: 'carla', online: true, caps: { realIp: true, platform: 'desktop', profiles: ['default', 'facebook'] }, ...over });
const now = 10 * STARTUP_MS;

describe('where a login lives', () => {
  it('a profile the phone holds runs on the phone, a phone before a desktop', () => {
    const r = loginHome({ devices: [desk(), phone()], owner: 'carla', profile: 'facebook', now });
    expect(r.device).toMatchObject({ deviceId: 'p1', name: 'SM-F926B' });
  });

  it('a desktop that holds it is used when no phone is online', () => {
    const r = loginHome({ devices: [desk(), phone({ online: false })], owner: 'carla', profile: 'facebook', now });
    expect(r.device.deviceId).toBe('d1');
  });

  it('the device that holds it is offline: wait, never the cluster', () => {
    const r = loginHome({ devices: [phone({ online: false })], owner: 'carla', profile: 'facebook', now });
    expect(r.waiting).toBe(true);
    expect(r.device).toBeUndefined();
    expect(r.reason).toMatch(/lives on SM-F926B, which is offline.*never the cluster/);
  });

  it('a profile no device holds stays on the cluster, as before; so do "default" and another owner\'s devices', () => {
    expect(loginHome({ devices: [phone()], owner: 'carla', profile: 'hn', now })).toEqual({});
    expect(loginHome({ devices: [phone()], owner: 'carla', profile: 'default', now })).toEqual({});
    expect(loginHome({ devices: [phone({ owner: 'ben' })], owner: 'carla', profile: 'facebook', now })).toEqual({});
  });

  it('a device without a home connection does not count', () => {
    expect(loginHome({ devices: [phone({ caps: { realIp: false, profiles: ['facebook'] } })], owner: 'carla', profile: 'facebook', now })).toEqual({});
  });

  it('just after a restart (devices still registering) a scheduled pass waits instead of guessing the cluster', () => {
    const r = loginHome({ devices: [], owner: 'carla', profile: 'facebook', now: 1000, startedAt: 0 });
    expect(r.waiting).toBe(true);
    expect(loginHome({ devices: [], owner: 'carla', profile: 'facebook', now: 1000, startedAt: 0, starting: false })).toEqual({});
  });

  it('the phone working in that profile for a session makes a pass wait, unless asked not to check', () => {
    const sessions = [{ ring: { deviceId: 'p1', profile: 'facebook' }, lastUsed: now - 1000 }];
    expect(loginHome({ devices: [phone()], sessions, owner: 'carla', profile: 'facebook', now }).busy).toBe(true);
    expect(loginHome({ devices: [phone()], sessions, owner: 'carla', profile: 'facebook', now, busyCheck: false }).device).toBeTruthy();
    const old = [{ ring: { deviceId: 'p1', profile: 'facebook' }, lastUsed: now - BUSY_MS - 1 }];
    expect(loginHome({ devices: [phone()], sessions: old, owner: 'carla', profile: 'facebook', now }).device).toBeTruthy();
  });

  it('a phone before 0.92 that holds it as "p_facebook" holds it too', () => {
    const r = loginHome({ devices: [phone({ caps: { realIp: true, profiles: ['p_facebook'] } })], owner: 'carla', profile: 'facebook', now });
    expect(r.device.deviceId).toBe('p1');
  });
});

describe('everything goes through it', () => {
  it('a new session with device "auto" goes straight to the device that holds the login, or is refused while it is offline', () => {
    expect(server).toMatch(/if \(where === 'auto' && !\(req\.client && req\.client\.console\)\) \{[\s\S]{0,300}loginOnDevice\(owner, profileName, \{ starting: false, busyCheck: false \}\)/);
    expect(server).toMatch(/if \(home\.device\) return \{ where, device: home\.device, home: true \};/);
    expect(server).toMatch(/lives on \$\{home\.name\}, which is offline/);
  });
  it('the posts watcher runs on the phone that holds the login, and waits when it is offline or busy', () => {
    expect(server).toMatch(/const home = loginOnDevice\(owner, base\);\n  if \(home\.waiting \|\| home\.busy\) \{/);
    expect(server).toMatch(/if \(home\.device\) return postWatchOnDevice\(/);
    expect(server).toMatch(/require\('\.\/ringPlaywright'\)\.ringPage\(sessionRing, rs\)/);
  });
  it('the approved reply is posted on that phone too', () => {
    expect(server).toMatch(/const home = loginOnDevice\(owner, want\);[\s\S]{0,900}if \(devicePage\) return \{ page: devicePage \};/);
  });
  it('a session handed to a device leaves the cloud copy of the page blank', () => {
    expect(ringSrc).toMatch(/s\.page\.goto\('about:blank'\)/);
  });
});
