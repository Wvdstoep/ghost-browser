import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { authenticate, boot, PLATFORM_SIGN_IN } = require('../public/js/console-auth');
const { prepareConsole } = require('../scripts/prepare-console');
const html = readFileSync(new URL('../public/compose-index.html', import.meta.url), 'utf8');
const url = (envelope) => 'https://ghost-browser.ben.my-app.engineer/#leadflow=' + encodeURIComponent(JSON.stringify(envelope));
const reply = (body, ok = true) => ({ ok, json: async () => body });

describe('the shipped console authenticates before Compose starts', () => {
  it('exchanges the fragment first, strips it from history and sends cookies', async () => {
    const dom = new JSDOM(html, { url: url({ auth: 'signed-token' }) });
    const calls = [];
    const fetch = vi.fn(async (path, options) => { calls.push({ path, options, hash: dom.window.location.hash }); return reply(path.endsWith('/sso') ? {} : { signedIn: true }); });
    const state = await authenticate({ location: dom.window.location, history: dom.window.history, fetch });
    expect(state.signedIn).toBe(true);
    expect(calls.map(c => c.path)).toEqual(['/api/auth/sso', '/api/auth/state']);
    expect(calls[0].hash).toBe('');
    expect(JSON.parse(calls[0].options.body)).toEqual({ token: 'signed-token' });
    expect(calls.every(c => c.options.credentials === 'include')).toBe(true);
  });
  it('shows a direct platform sign-in and no dead password form on a fresh browser', async () => {
    const dom = new JSDOM(html, { url: 'https://ghost-browser.ben.my-app.engineer/' });
    dom.window.fetch = vi.fn(async () => reply({ signedIn: false, sso: true, ssoOnly: true, hasPassword: false }));
    await boot(dom.window);
    expect(dom.window.document.getElementById('platform-sign-in').href).toBe(PLATFORM_SIGN_IN);
    expect(dom.window.document.getElementById('password-option').hidden).toBe(true);
    expect(dom.window.document.querySelector('script[src="/console/gbweb.js"]')).toBeNull();
  });
  it('starts the real console only after the cookie is confirmed', async () => {
    const dom = new JSDOM(html, { url: url({ auth: 'signed-token' }) });
    dom.window.fetch = vi.fn(async path => reply(path.endsWith('/state') ? { signedIn: true } : {}));
    await boot(dom.window);
    expect(dom.window.document.getElementById('auth-gate').hidden).toBe(true);
    expect(dom.window.document.querySelector('script[src="/console/gbweb.js"]')).not.toBeNull();
    expect(dom.window.document.getElementById('ComposeTarget').hidden).toBe(false);
    expect(dom.window.document.querySelector('.mcp-link')).toBeNull();
  });
  it('expired handoffs show an actionable retry instead of a password form', async () => {
    const dom = new JSDOM(html, { url: url({ auth: 'expired' }) });
    dom.window.fetch = vi.fn(async () => reply({}, false));
    await boot(dom.window);
    expect(dom.window.location.hash).toBe('');
    expect(dom.window.document.getElementById('auth-status').textContent).toMatch(/expired/);
    expect(dom.window.document.getElementById('password-option').hidden).toBe(true);
  });
  it('rejects malformed handoffs and a blocked session cookie', async () => {
    for (const hash of ['#leadflow=not-json', '#leadflow=%7B%7D']) {
      const dom = new JSDOM(html, { url: 'https://host.test/' + hash });
      const fetch = vi.fn();
      await expect(authenticate({ location: dom.window.location, history: dom.window.history, fetch })).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      expect(dom.window.location.hash).toBe('');
    }
    const dom = new JSDOM(html, { url: url({ auth: 'valid' }) });
    await expect(authenticate({ location: dom.window.location, history: dom.window.history, fetch: async () => reply({ signedIn: false }) })).rejects.toThrow(/cookies/);
  });
  it('keeps a separately configured password optional', async () => {
    const dom = new JSDOM(html, { url: 'https://host.test/' });
    dom.window.fetch = vi.fn(async () => reply({ signedIn: false, sso: true, hasPassword: true }));
    await boot(dom.window);
    expect(dom.window.document.getElementById('password-option').hidden).toBe(false);
    expect(dom.window.document.getElementById('password-option').open).toBe(false);
  });
  it('returns a mobile login with only a one-time code, not a bearer key', async () => {
    const device = { challenge: 'c'.repeat(43), state: 's'.repeat(43) };
    const dom = new JSDOM(html, { url: url({ auth: 'valid', device }) });
    const assign = vi.fn();
    const win = { document: dom.window.document, history: dom.window.history, location: { hash: dom.window.location.hash, pathname: '/', search: '', origin: dom.window.location.origin, assign },
      fetch: vi.fn(async path => reply(path.endsWith('/state') ? { signedIn: true } : path.endsWith('/device-code') ? { code: 'k'.repeat(43) } : {})) };
    await boot(win);
    expect(assign).toHaveBeenCalledTimes(1);
    const callback = new URL(assign.mock.calls[0][0]);
    expect(callback.protocol).toBe('ghostbrowser:');
    expect(callback.searchParams.get('code')).toBe('k'.repeat(43));
    expect(callback.searchParams.get('state')).toBe(device.state);
    expect(callback.searchParams.has('token')).toBe(false);
  });
});

describe('console build artifact preparation', () => {
  it('updates both entry points even when the Wasm artifact was preserved from an older release', () => {
    const root = mkdtempSync(join(tmpdir(), 'gb-loader-'));
    try {
      mkdirSync(join(root, 'console')); writeFileSync(join(root, 'console', 'gbweb.js'), 'old-wasm');
      writeFileSync(join(root, 'console', 'index.html'), 'old-login'); writeFileSync(join(root, 'compose-index.html'), html);
      expect(prepareConsole(root)).toBe(true);
      expect(readFileSync(join(root, 'console', 'index.html'), 'utf8')).toBe(html);
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe(html);
      expect(readFileSync(join(root, 'console', 'gbweb.js'), 'utf8')).toBe('old-wasm');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
