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
const { loginHome, siteHome, siteOf, STARTUP_MS, BUSY_MS } = require('../src/loginHome');
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
    expect(server).toMatch(/const home = watchHome\(owner, base, 'https:\/\/www\.facebook\.com\/'\);\n  if \(home\.waiting \|\| home\.busy\) \{/);
    expect(server).toMatch(/if \(home\.device\) return postWatchOnDevice\([^)]*home\.profile\)/);
    expect(server).toMatch(/require\('\.\/ringPlaywright'\)\.ringPage\(sessionRing, rs\)/);
  });
  it('the approved reply is posted on that phone too', () => {
    expect(server).toMatch(/const home = watchHome\(owner, want, 'https:\/\/www\.facebook\.com\/'\);[\s\S]{0,900}profile: home\.profile \|\| null[\s\S]{0,300}if \(devicePage\) return \{ page: devicePage \};/);
  });
  it('a session handed to a device leaves the cloud copy of the page blank', () => {
    expect(ringSrc).toMatch(/s\.page\.goto\('about:blank'\)/);
  });
});

/* 2026-11-21, later: "facebook is logged in the default profile". The phone says per profile which sites it holds a
   real login for (app 1.01, caps.logins); the cluster routes by the site, whatever the profile is called. */
describe('where the login for a site lives', () => {
  const withLogins = (logins, over = {}) => phone({ caps: { realIp: true, platform: 'android', profiles: ['default'], logins }, ...over });
  it('a site whose login the phone holds goes to the phone, in the profile that holds it', () => {
    const r = siteHome({ devices: [withLogins({ default: ['facebook.com', 'google.com'] })], owner: 'carla', url: 'https://www.facebook.com/groups/vibe/posts/1/', now });
    expect(r).toMatchObject({ device: { deviceId: 'p1' }, profile: 'default', site: 'facebook.com' });
  });
  it('another site, another owner, or a phone that reports no logins (app before 1.01): not routed', () => {
    const d = withLogins({ default: ['facebook.com'] });
    expect(siteHome({ devices: [d], owner: 'carla', url: 'https://www.reddit.com/', now })).toEqual({});
    expect(siteHome({ devices: [d], owner: 'ben', url: 'https://www.facebook.com/', now })).toEqual({});
    expect(siteHome({ devices: [phone()], owner: 'carla', url: 'https://www.facebook.com/', now })).toEqual({});
  });
  it('offline: wait; busy in that profile: the next pass', () => {
    expect(siteHome({ devices: [withLogins({ default: ['facebook.com'] }, { online: false })], owner: 'carla', url: 'facebook.com', now }).waiting).toBe(true);
    const sessions = [{ ring: { deviceId: 'p1', profile: '' }, lastUsed: now - 1000 }];   // "default" is '' in a ring
    expect(siteHome({ devices: [withLogins({ default: ['facebook.com'] })], sessions, owner: 'carla', url: 'facebook.com', now }).busy).toBe(true);
    expect(siteHome({ devices: [withLogins({ default: ['facebook.com'] })], sessions, owner: 'carla', url: 'facebook.com', now, busyCheck: false }).device).toBeTruthy();
  });
  it('m. and www. are the same site', () => {
    expect(siteOf('https://m.facebook.com/x')).toBe('facebook.com');
    expect(siteOf('www.linkedin.com')).toBe('linkedin.com');
  });
  it('a navigate goes straight to that device and profile before the cluster loads anything', () => {
    expect(server).toMatch(/const sh = siteOnDevice\(owner, target, \{ busyCheck: false \}\);\n\s+if \(sh\.device && sessionRing\.attach\(s, ringOwners\(req\), \{ device: sh\.device, profile: sh\.profile \}\)\)[\s\S]{0,1500}const r = await s\.page\.goto\(target/);
    expect(ringSrc).toMatch(/const held = \(profile && String\(profile\)\) \|\| deviceProfileFor/);
  });
});

/* 2026-11-21, app 1.01 on SM-F926B: the phone said { default: ["facebook.com"] }, but the device hub keeps only
   the capabilities it names, and logins was not one of them; the posts watcher ran on the cluster. */
describe('the phone\'s logins reach the router', () => {
  const { mountDeviceHub } = require('../src/device-hub.js');
  const hub = () => {
    const routes = {}; const app = { get() {}, post: (p, _a, h) => { routes[p] = h; }, delete() {}, put() {} };
    const api = mountDeviceHub(app, (_q, _s, n) => n && n());
    const register = (body) => { let out; routes['/v1/device/register']({ body, client: { owner: 'carla' } }, { json: (x) => { out = x; }, status: () => ({ json: (x) => { out = x; } }) }); return out; };
    return { api, register };
  };
  it('a registration with caps.logins keeps them, and the site\'s work goes to that device and profile', () => {
    const { api, register } = hub();
    const r = register({ deviceId: 'p1', name: 'SM-F926B', caps: { platform: 'android', realIp: true, profiles: ['default'], logins: { default: ['facebook.com', 'google.com'] } } });
    expect(r.caps.logins).toEqual({ default: ['facebook.com', 'google.com'] });
    const home = siteHome({ devices: api.deviceList(), sessions: [], owner: 'carla', url: 'https://www.facebook.com/' });
    expect(home).toMatchObject({ name: 'SM-F926B', profile: 'default' });
  });
  it('junk is dropped, not passed on: no arrays for a profile, no non-site strings', () => {
    const { register } = hub();
    const r = register({ deviceId: 'p2', caps: { logins: { default: ['facebook.com', 'javascript:alert(1)', 5], x: 'facebook.com', '': ['a.com'] } } });
    expect(r.caps.logins).toEqual({ default: ['facebook.com'] });
    expect(register({ deviceId: 'p3', caps: { logins: ['facebook.com'] } }).caps.logins).toEqual({});
  });
});

describe('the probe reads where the pass reads', () => {
  it('the phone holding the login, through the same ring page; the cluster only when no device holds it', () => {
    const probe = server.slice(server.indexOf("app.post('/v1/watchers/:id/probe'"), server.indexOf("app.post('/v1/watchers/:id/probe'") + 2500);
    expect(probe).toMatch(/const home = watchHome\(owner, want, 'https:\/\/www\.facebook\.com\/'\);/);
    expect(probe).toMatch(/if \(home\.device\) \{[\s\S]{0,400}pw\.probePage\(require\('\.\/ringPlaywright'\)\.ringPage\(sessionRing, rs\), url, popts\)/);
    expect(probe.indexOf('if (home.device)')).toBeLessThan(probe.indexOf('pool.createSession'));
  });
});
