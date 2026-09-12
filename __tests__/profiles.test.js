/**
 * How a profile presents itself.
 *
 * A profile is an identity, not just a cookie jar: an exit IP, a timezone, a language. Those have
 * to agree with each other, and the moment they do not they become the signal.
 *
 * This file exists because of a real one. The Facebook login kept returning to the login page after
 * a solved captcha, and while the browser fingerprint was being chased the actual mismatch was in
 * the launch options: timezone Europe/Amsterdam, exit IP 65.108.13.228 — Finland, Hetzner, already
 * flagged proxy:true by public databases. Neither value was wrong alone. Together they were.
 *
 * The validation matters as much as the storage: a proxy string Chromium cannot parse, or a
 * timezone it does not know, fails minutes later at launch with an error nobody connects back to a
 * settings screen.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-prof-'));
process.env.PROFILE_DIR = dir;
const profiles = await import('../src/profiles.js');

beforeEach(() => { fs.rmSync(path.join(dir, 'p'), { recursive: true, force: true }); });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('defaults', () => {
  it('describe where these pods actually are, so an unconfigured profile is at least consistent', () => {
    const s = profiles.read('p');
    expect(s.timezone).toBe('Europe/Helsinki');
    expect(s.proxy).toBeNull();
  });

  it('sets no userAgent, because a real headful Chromium already reports a real one', () => {
    expect(profiles.read('p').userAgent).toBeNull();
  });
});

describe('validation', () => {
  it('keeps a timezone the runtime actually knows', () => {
    expect(profiles.normalize({ timezone: 'Europe/Amsterdam' }).timezone).toBe('Europe/Amsterdam');
  });

  it('drops one it does not, instead of failing at launch', () => {
    expect(profiles.normalize({ timezone: 'Mars/Olympus' }).timezone).toBeUndefined();
    expect(profiles.normalize({ timezone: 'nonsense' }).timezone).toBeUndefined();
  });

  it('accepts the proxy schemes Chromium accepts', () => {
    for (const server of ['socks5://10.0.0.1:1080', 'http://proxy.example.com:8080', 'https://p.example.com:443']) {
      expect(profiles.normalize({ proxy: { server } }).proxy).toEqual({ server });
    }
  });

  it('refuses a proxy string that would only fail later', () => {
    for (const server of ['not a url', 'ftp://x:1', 'socks5://', '10.0.0.1:1080']) {
      expect(profiles.normalize({ proxy: { server } }).proxy).toBeUndefined();
    }
  });

  it('carries proxy credentials but keeps them out of what the UI reads', () => {
    profiles.write('p', { proxy: { server: 'socks5://10.0.0.1:1080', username: 'u', password: 'secret' } });
    expect(profiles.read('p').proxy.password).toBe('secret');
    expect(profiles.redacted('p').proxy.password).toBe('••••');
    expect(JSON.stringify(profiles.redacted('p'))).not.toContain('secret');
  });

  it('allows clearing the proxy explicitly', () => {
    profiles.write('p', { proxy: { server: 'socks5://10.0.0.1:1080' } });
    profiles.write('p', { proxy: null });
    expect(profiles.read('p').proxy).toBeNull();
  });
});

describe('storage', () => {
  it('keeps settings beside the cookies, so they travel with the profile', () => {
    profiles.write('p', { timezone: 'Europe/Amsterdam', locale: 'nl-NL' });
    expect(fs.existsSync(path.join(dir, 'p', profiles.FILE))).toBe(true);
    expect(profiles.read('p')).toMatchObject({ timezone: 'Europe/Amsterdam', locale: 'nl-NL' });
  });

  it('merges rather than replaces, so setting one field does not wipe the rest', () => {
    profiles.write('p', { timezone: 'Europe/Amsterdam', proxy: { server: 'socks5://10.0.0.1:1080' } });
    profiles.write('p', { locale: 'nl-NL' });
    const s = profiles.read('p');
    expect(s.timezone).toBe('Europe/Amsterdam');
    expect(s.proxy.server).toBe('socks5://10.0.0.1:1080');
  });

  it('cannot be pointed outside the profile directory by its name', () => {
    expect(profiles.safeName('../../etc')).toBe('etc');
    expect(profiles.safeName('')).toBe('default');
  });
});

/*
 * Exiting through the tailnet.
 *
 * The evidence that made this necessary: Facebook refused a login from 65.108.13.228 (Finland,
 * Hetzner, flagged proxy:true) and accepted the same account from a home connection minutes later,
 * in an ordinary browser. Not a fingerprint problem — the browser was telling the truth, and the
 * truth was the problem.
 *
 * A profile says WHERE it exits, not HOW: "tailscale" rather than a hand-copied socks5 URL, because
 * the port belongs to the image and a profile that hard-codes it breaks the day it changes.
 */
describe('exiting through the tailnet', () => {
  it('accepts the name and stores it as a name', () => {
    expect(profiles.normalize({ proxy: 'tailscale' }).proxy).toBe('tailscale');
    expect(profiles.normalize({ proxy: { server: 'tailscale' } }).proxy).toBe('tailscale');
  });

  it('resolves to whatever port the image is actually using', () => {
    expect(profiles.launchProxy('tailscale', 'socks5://127.0.0.1:1055')).toEqual({ server: 'socks5://127.0.0.1:1055' });
  });

  /*
   * THE COMMENT WAS RIGHT AND THE ASSERTION WAS THE BUG.
   *
   * "Falling back to the datacentre IP silently is the one thing this must never do" — and then it
   * asserted null, which IS that fallback: null means no proxy, which means out through this
   * server. The intent was written down and the opposite was pinned, so the behaviour stayed wrong
   * with a test guarding it.
   *
   * It refuses now. A profile that asked to leave through a home connection, quietly leaving from a
   * Finnish datacentre instead, is how an account gets locked — and not launching is a problem
   * somebody can see.
   */
  it('refuses to launch rather than silently leaving from this server', () => {
    expect(() => profiles.launchProxy('tailscale', null)).toThrow(/refusing to open it from this server/);
  });

  /* Unset is not the same as 'direct'. Unset follows whatever the default is — which is now the
     tailnet, because a datacentre address is never what anybody wants and remembering it per login
     is how it gets forgotten. */
  it('sends an unconfigured profile through the tailnet when that is the default', () => {
    expect(profiles.launchProxy(null, 'socks5://127.0.0.1:1055', { routeAll: true }))
      .toEqual({ server: 'socks5://127.0.0.1:1055' });
  });

  it('leaves an unconfigured profile direct when the default is off', () => {
    expect(profiles.launchProxy(null, 'socks5://127.0.0.1:1055', { routeAll: false })).toBeNull();
  });

  /* A profile that has deliberately opted out must survive the default changing under it. */
  it('honours an explicit opt-out even when everything else is routed', () => {
    expect(profiles.launchProxy('direct', 'socks5://127.0.0.1:1055', { routeAll: true })).toBeNull();
  });

  it('does not fail an unconfigured profile when there is no tailnet at all', () => {
    expect(profiles.launchProxy(null, null, { routeAll: true })).toBeNull();
  });

  /* A refusal that does not say what to do about it gets retried until somebody gives up. This one
     lands on the generic 409 path in server.js, which would otherwise tell them to "retry shortly"
     — true of a busy worker and useless here. */
  it('says how to get past the refusal, not just that it refused', () => {
    let caught;
    try { profiles.launchProxy('tailscale', null); } catch (e) { caught = e; }
    expect(caught.status).toBe(409);
    expect(caught.hint).toMatch(/connect your tailnet/i);
  });

  /* 'direct' has to survive a round trip, or an opt-out silently becomes "follow the default" the
     next time anything saves the profile — which would put it straight back on the tailnet. */
  it('keeps an explicit opt-out through normalize', () => {
    expect(profiles.normalize({ proxy: 'direct' }).proxy).toBe('direct');
    expect(profiles.normalize({ proxy: 'tailscale' }).proxy).toBe('tailscale');
    expect(profiles.normalize({ proxy: null }).proxy).toBeNull();
  });

  it('passes an explicit proxy through untouched', () => {
    const px = { server: 'socks5://10.0.0.1:1080', username: 'u' };
    expect(profiles.launchProxy(px, 'socks5://127.0.0.1:1055')).toEqual(px);
  });

  it('means no proxy at all when nothing is set', () => {
    expect(profiles.launchProxy(null, 'socks5://127.0.0.1:1055')).toBeNull();
  });

  it('survives a round trip through storage', () => {
    profiles.write('p', { proxy: 'tailscale', timezone: 'Europe/Amsterdam' });
    expect(profiles.read('p').proxy).toBe('tailscale');
    expect(profiles.redacted('p').proxy).toBe('tailscale');
  });
});

/*
 * Refusing passkeys.
 *
 * Found at Facebook's two-factor step: a container has no platform authenticator, so
 * navigator.credentials.get() never settles — the button spins forever AND the page's own "try
 * another way" link stops working, because the page is still waiting on its own request. There is
 * no way out from inside the page.
 *
 * The setting is off by default on purpose. A site that genuinely wants a security key should be
 * allowed to ask; this is for the case where nothing can ever answer.
 */
describe('refusing passkey prompts', () => {
  it('is off unless a profile turns it on', () => {
    expect(profiles.DEFAULTS.blockPasskeys).toBe(false);
  });

  it('is remembered per profile, like everything else about an identity', () => {
    const saved = profiles.write('pk-test', { blockPasskeys: true });
    expect(saved.blockPasskeys).toBe(true);
    expect(profiles.read('pk-test').blockPasskeys).toBe(true);
  });

  it('can be turned back off', () => {
    profiles.write('pk-off', { blockPasskeys: true });
    expect(profiles.write('pk-off', { blockPasskeys: false }).blockPasskeys).toBe(false);
  });

  it('ignores anything that is not a yes or a no', () => {
    expect(profiles.normalize({ blockPasskeys: 'yes' })).toEqual({});
  });

  it('does not disturb the rest of the identity', () => {
    const saved = profiles.write('pk-mix', { proxy: 'tailscale', timezone: 'Europe/Amsterdam', blockPasskeys: true });
    expect(saved).toMatchObject({ proxy: 'tailscale', timezone: 'Europe/Amsterdam', blockPasskeys: true });
  });
});

/**
 * Which operating system a profile claims to be.
 *
 * Both Facebook's and LinkedIn's "was this you?" screens name the device, and both said Linux. With
 * the traffic leaving through the owner's own connection, that is the last thing still describing a
 * datacentre — and it is their own account on both sides of it.
 *
 * A CLOSED SET, deliberately. Each value needs a matching set of Client Hints to go with it (see
 * presentAs in pool.js); a free string would produce a browser whose user agent, userAgentData and
 * Sec-CH-UA-Platform disagree, and a browser contradicting itself is a louder signal than an
 * unusual operating system. Empty means it tells the truth, which is the default.
 */
describe('what a profile says it is running on', () => {
  it('tells the truth unless asked otherwise', () => {
    expect(profiles.DEFAULTS.presentAs).toBe('');
  });

  it('takes the two it knows how to do completely', () => {
    expect(profiles.normalize({ presentAs: 'windows' })).toEqual({ presentAs: 'windows' });
    expect(profiles.normalize({ presentAs: 'mac' })).toEqual({ presentAs: 'mac' });
  });

  it('refuses anything else, rather than half-applying it', () => {
    expect(profiles.normalize({ presentAs: 'Windows 11' })).toEqual({});
    expect(profiles.normalize({ presentAs: 'linux' })).toEqual({});
    expect(profiles.normalize({ presentAs: true })).toEqual({});
  });

  it('can be turned back off', () => {
    profiles.write('os-test', { presentAs: 'windows' });
    expect(profiles.write('os-test', { presentAs: '' }).presentAs).toBe('');
  });

  it('is remembered with the rest of the identity', () => {
    const saved = profiles.write('os-mix', { site: 'linkedin.com', presentAs: 'windows', proxy: 'tailscale' });
    expect(saved).toMatchObject({ site: 'linkedin.com', presentAs: 'windows', proxy: 'tailscale' });
  });
});
