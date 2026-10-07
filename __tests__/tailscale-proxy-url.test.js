/**
 * tailscale-proxy-url.test.js — the browser only gets the tailnet proxy while tailscaled is running.
 *
 * Live 2026-10-07: a fresh install that never connected Tailscale opened every login with
 * "No internet" / ERR_PROXY_CONNECTION_FAILED, because proxyUrl() always returned the shim address and
 * the default ("route every login through the tailnet") handed it to Chrome. With the daemon down,
 * proxyUrl() is now null: an unset login goes direct, a login set to 'tailscale' is refused clearly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('tailscale.proxyUrl', () => {
  let dir;
  const prev = process.env.PROFILE_DIR;
  beforeEach(() => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-profiles-'));
    process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/tailscale')];
  });
  afterEach(() => { if (prev === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = prev; });

  it('is null while tailscaled is not running (no socket)', () => {
    const ts = require('../src/tailscale');
    expect(ts.STATE_DIR).toBe(path.join(dir, '.tailscale'));
    expect(ts.proxyUrl()).toBeNull();
  });

  it('is the shim address once the daemon socket exists', () => {
    const ts = require('../src/tailscale');
    fs.mkdirSync(ts.STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(ts.STATE_DIR, 'tailscaled.sock'), '');
    expect(ts.proxyUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('launchProxy: an unset login goes direct when the tailnet is down, an insisting one is refused', () => {
    const profiles = require('../src/profiles');
    expect(profiles.launchProxy(undefined, null, { routeAll: true })).toBeNull();
    expect(() => profiles.launchProxy('tailscale', null, { routeAll: true })).toThrow(/tailnet is not available/);
  });
});
