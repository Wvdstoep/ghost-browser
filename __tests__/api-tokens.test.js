/*
 * SETTINGS → API TOKENS HAD NO SERVER.
 *
 * The console sheet called GET/POST /v1/tokens and DELETE /v1/tokens/:id, and no route existed: the
 * 404 page is not JSON, so "Generate" could only say "could not generate". These tests hold the
 * server half: a token is shown once and stored as a hash, it works as an API key on every route and
 * on /mcp, only the signed-in owner manages tokens, and a revoked token stops at once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

process.env.PROFILE_DIR = mkdtempSync(join(tmpdir(), 'gb-apitokens-'));
const require = createRequire(import.meta.url);
const tokens = require('../src/apiTokens');
const { parseKeys, auth } = require('../src/keys');
const mcp = require('../src/mcp');
const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');

describe('minting', () => {
  it('shows the token once and stores only its hash', () => {
    const t = tokens.mint('border-monitor connect');
    expect(t.token.startsWith('gbt_')).toBe(true);
    expect(t).toMatchObject({ name: 'border-monitor connect', preview: '…' + t.token.slice(-4) });
    const disk = readFileSync(join(process.env.PROFILE_DIR, 'api-tokens.json'), 'utf8');
    expect(disk).not.toContain(t.token);
    expect(tokens.list().map((r) => r.tokenId)).toContain(t.tokenId);
    expect(JSON.stringify(tokens.list())).not.toContain(t.token);
  });

  it('a revoked token stops working at once', () => {
    const t = tokens.mint('x');
    expect(tokens.lookup(t.token)).toBeTruthy();
    expect(tokens.revoke(t.tokenId)).toBe(true);
    expect(tokens.lookup(t.token)).toBeNull();
    expect(tokens.revoke(t.tokenId)).toBe(false);
  });
});

describe('a minted token is an API key', () => {
  let http, base, key;
  beforeAll(async () => {
    const keys = tokens.extend(parseKeys('env-key-1:team'));
    key = tokens.mint('script').token;
    const app = express(); app.use(express.json());
    app.get('/v1/sessions', auth(keys), (req, res) => res.json({ owner: req.client.owner, plan: req.client.plan }));
    mcp.mount(app, { keys, requestApi: async () => ({ ok: true, data: { sessions: [] } }) });
    http = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${http.address().port}`;
  });
  afterAll(() => new Promise((r) => http.close(r)));

  it('on a REST route, with the install plan', async () => {
    const ok = await fetch(base + '/v1/sessions', { headers: { authorization: 'Bearer ' + key } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).plan).toBe('team');
    expect((await fetch(base + '/v1/sessions', { headers: { authorization: 'Bearer gbt_invented' } })).status).toBe(401);
    expect((await fetch(base + '/v1/sessions', { headers: { authorization: 'Bearer env-key-1' } })).status).toBe(200);
  });

  it('on /mcp', async () => {
    const send = (k) => fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + k }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect((await send(key)).status).toBe(200);
    expect((await send('gbt_invented')).status).toBe(401);
  });
});

describe('the routes', () => {
  it('exist, and only the signed-in owner reaches them', () => {
    for (const r of ["app.get('/v1/tokens', authed, ownerOnly", "app.post('/v1/tokens', authed, ownerOnly", "app.delete('/v1/tokens/:id', authed, ownerOnly"]) expect(server).toContain(r);
    const fn = server.slice(server.indexOf('function ownerOnly('), server.indexOf('function ownerOnly(') + 300);
    expect(fn).toContain('req.client.console');
  });
  it('the key map is extended before anything reads it', () => {
    expect(server.indexOf('apiTokens.extend(keys)')).toBeGreaterThan(0);
    expect(server.indexOf('apiTokens.extend(keys)')).toBeLessThan(server.indexOf('const bearer = auth(keys)'));
    expect(server.indexOf('apiTokens.extend(keys)')).toBeLessThan(server.indexOf("require('./mcp').mount("));
  });
});
