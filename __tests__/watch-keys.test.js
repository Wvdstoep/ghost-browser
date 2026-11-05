/*
 * A WATCH KEY OPENS ONE WATCHER'S FEED AND NOTHING ELSE.
 *
 * Every API key can drive the owner's signed-in browser. A public website that shows a watcher's
 * feed must never hold one, so it holds a gbw_ key: bound to one sources watcher, scoped to
 * feed/egress(/run), refused by every other route and shown only the three watcher tools over MCP.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.PROFILE_DIR = mkdtempSync(join(tmpdir(), 'gb-watchkeys-'));
const require = createRequire(import.meta.url);
const wk = require('../src/watchKeys');
const mcp = require('../src/mcp');
const { parseKeys } = require('../src/keys');
const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');

describe('minting and checking', () => {
  it('shows the key once and stores only its hash', () => {
    const k = wk.mint('border-watch', { scopes: ['feed', 'egress'] });
    expect(k.key.startsWith('gbw_')).toBe(true);
    const stored = readFileSync(join(process.env.PROFILE_DIR, 'watch-keys.json'), 'utf8');
    expect(stored).not.toContain(k.key);
    expect(wk.verify(k.key)).toMatchObject({ watcherId: 'border-watch', scopes: ['feed', 'egress'], last4: k.key.slice(-4) });
    expect(wk.verify(k.key + 'x')).toBeNull();
    expect(wk.verify('key-one')).toBeNull();
  });

  it('allows its own watcher and scopes only', () => {
    const rec = wk.verify(wk.mint('border-watch').key);
    expect(wk.allows(rec, 'feed', 'border-watch')).toBe(true);
    expect(wk.allows(rec, 'feed', 'facebook-replies')).toBe(false);
    expect(wk.allows(rec, 'run', 'border-watch')).toBe(false);
    expect(wk.allows(rec, 'egress')).toBe(true);
    expect(wk.allows(rec, 'sessions', 'border-watch')).toBe(false);
    const runner = wk.verify(wk.mint('border-watch', { scopes: ['feed', 'run'] }).key);
    expect(wk.allows(runner, 'run', 'border-watch')).toBe(true);
    expect(wk.allows(runner, 'sources', 'border-watch')).toBe(false);
    const editor = wk.verify(wk.mint('border-watch', { scopes: ['feed', 'sources', 'admin'] }).key);
    expect(editor.scopes).toEqual(['feed', 'sources']);   // an unknown scope is dropped, never granted
    expect(wk.allows(editor, 'sources', 'other-watcher')).toBe(false);
  });

  it('a revoked key stops working', () => {
    const k = wk.mint('border-watch');
    expect(wk.revoke(k.id)).toBe(true);
    expect(wk.verify(k.key)).toBeNull();
  });

  it('is not an API key: keys.js does not know it', () => {
    const k = wk.mint('border-watch');
    expect(parseKeys('key-one:solo').get(k.key)).toBeUndefined();
  });
});

describe('the server opens exactly three routes to it', () => {
  it('feed, egress, run and the source list go through watchOrAuthed; everything else stays authed', () => {
    expect(server).toContain("app.get('/v1/watchers/:id/feed', watchOrAuthed('feed')");
    expect(server).toContain("app.get('/v1/egress', watchOrAuthed('egress')");
    expect(server).toContain("app.post('/v1/workflows/:id/run', watchOrAuthed('run')");
    expect(server).toContain("app.put('/v1/watchers/:id/sources', watchOrAuthed('sources')");
    expect(server.match(/watchOrAuthed\('/g)).toHaveLength(4);
    for (const r of ["'/v1/watchers/:id/config', authed", "'/v1/watchers/:id/keys', authed", "'/v1/watchers/:id/feed/approve', authed", "app.use('/v1/sessions', authed)"]) expect(server).toContain(r);
  });

  it('a watch key reaches a sources watcher only', () => {
    const fn = server.slice(server.indexOf('function watchOrAuthed('), server.indexOf('function watchOrAuthed(') + 1500);
    expect(fn).toContain("!== 'sources'");
    expect(fn).toContain('watchKeys.allows(rec, scope, wid)');
  });
});

describe('over MCP it sees the watcher tools only', () => {
  let http, url, calls, key;
  beforeAll(async () => {
    calls = []; key = wk.mint('border-watch', { scopes: ['feed', 'egress', 'run'] }).key;
    const app = express(); app.use(express.json());
    mcp.mount(app, { keys: parseKeys('key-one:solo'), requestApi: async (r) => { calls.push(r); return { ok: true, data: { items: [] } }; } });
    http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  });
  afterAll(() => new Promise((resolve) => http.close(resolve)));

  it('lists three tools, refuses browser_*, and forwards the key to the scoped routes', async () => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer ' + key } } }));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['egress_check', 'watcher_feed', 'watcher_run']);
    const refused = await client.callTool({ name: 'browser_open', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await client.callTool({ name: 'watcher_feed', arguments: { watcherId: 'border-watch', limit: 20 } });
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/v1/watchers/border-watch/feed?limit=20', authorization: 'Bearer ' + key });
    await client.callTool({ name: 'egress_check', arguments: {} });
    expect(calls.at(-1).path).toBe('/v1/egress');
    await client.callTool({ name: 'watcher_run', arguments: { watcherId: 'border-watch' } });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/workflows/border-watch/run' });
    const bad = await client.callTool({ name: 'watcher_feed', arguments: { watcherId: '../sessions' } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it('a revoked or invented watch key is refused before any tool', async () => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer gbw_invented' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect(r.status).toBe(401);
  });

  it('a full key still sees the browser tools and the watcher tools', async () => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer key-one' } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('browser_open');
    expect(names).toContain('watcher_feed');
    await client.close();
  });
});
