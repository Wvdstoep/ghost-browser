/**
 * The claude.ai connector login, end to end: discovery from a 401, open registration, the owner's
 * consent, PKCE code exchange, and an MCP call made with the token that came back. Plus every door
 * that must stay shut — a consent POST from another origin or without the page's token, a wrong
 * verifier, a code spent twice, a redirect that is not https.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import mcp from '../src/mcp.js';
import mcpOauth from '../src/mcpOauth.js';
import deviceTokens from '../src/deviceTokens.js';
import { parseKeys } from '../src/keys.js';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const b64url = (b) => Buffer.from(b).toString('base64url');

describe('MCP OAuth for claude.ai connectors', () => {
  let http, base, keys, dir, signedIn;
  const accounts = {
    readCookie: (req) => (req.headers.cookie || '').includes('gb_session=ok') ? 'ok' : null,
    verifyToken: (t) => (t === 'ok' && signedIn ? { username: 'carla' } : null),
  };
  const form = (obj) => new URLSearchParams(obj).toString();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-oauth-'));
    process.env.PROFILE_DIR = dir;
    keys = parseKeys('env-key:solo');
    const app = express();
    app.use(express.json());
    mcp.mount(app, { keys, challenge: mcpOauth.challengeFor, requestApi: async (req) => ({ ok: true, data: { sessions: [], auth: req.authorization } }) });
    mcpOauth.mount(app, {
      accounts, log: { info() {}, warn() {}, error() {} },
      mintToken: (owner, client) => deviceTokens.mint(keys, { owner, ...mcpOauth.connectorDevice(client) }).token,
    });
    http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${http.address().port}`;
    process.env.TOOL_PUBLIC_URL = base;
  });
  afterAll(async () => {
    delete process.env.TOOL_PUBLIC_URL; delete process.env.PROFILE_DIR;
    await new Promise((resolve) => http.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const register = async (body = { client_name: 'Claude', redirect_uris: [REDIRECT] }) =>
    fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  /** Walk the browser part: open /authorize signed in, read the page's hidden fields, press a button. */
  async function consent(clientId, { verifier = 'v'.repeat(50), decision = 'allow', origin = base, csrf } = {}) {
    const q = { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', state: 'st8',
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      resource: `${base}/mcp`, scope: 'browser' };
    const html = await (await fetch(`${base}/oauth/authorize?${form(q)}`, { headers: { cookie: 'gb_session=ok' } })).text();
    const token = csrf ?? (html.match(/name="csrf" value="([^"]+)"/) || [])[1];
    const res = await fetch(`${base}/oauth/authorize`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: 'gb_session=ok', 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
      body: form({ ...q, csrf: token || '', decision }),
    });
    return { res, html, location: res.headers.get('location') };
  }

  it('a 401 on /mcp points at the metadata, and discovery describes this server', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');

    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(prm).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({ issuer: base, code_challenge_methods_supported: ['S256'], registration_endpoint: `${base}/oauth/register` });
  });

  it('registers clients but refuses non-https redirects', async () => {
    expect((await register({ redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    expect((await register({ redirect_uris: ['http://localhost:33418/callback'] })).status).toBe(201);
    const ok = await register();
    expect(ok.status).toBe(201);
    expect((await ok.json()).client_id).toMatch(/^mcp_[0-9a-f]{32}$/);
  });

  it('asks the owner to sign in first, and validates the request before any consent screen', async () => {
    const { client_id } = await (await register()).json();
    signedIn = false;
    const q = form({ client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: 'x', code_challenge_method: 'S256' });
    expect(await (await fetch(`${base}/oauth/authorize?${q}`)).text()).toContain('Sign in to your Ghost Browser first');
    const plain = form({ client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: 'x', code_challenge_method: 'plain' });
    expect((await fetch(`${base}/oauth/authorize?${plain}`)).status).toBe(400);
    const other = form({ client_id, redirect_uri: 'https://elsewhere.example/cb', response_type: 'code', code_challenge: 'x', code_challenge_method: 'S256' });
    expect((await fetch(`${base}/oauth/authorize?${other}`)).status).toBe(400);
  });

  it('the whole connector login: consent, exchange, then a real MCP call with the token', async () => {
    signedIn = true;
    const { client_id } = await (await register()).json();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const { html, location } = await consent(client_id, { verifier });
    expect(html).toContain('Connect Claude to your Ghost Browser');
    const back = new URL(location);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st8');
    expect(back.searchParams.get('iss')).toBe(base);
    const code = back.searchParams.get('code');

    const exchange = (v) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: v }) });
    expect((await exchange('wrong-verifier')).status).toBe(400);
    const tok = await exchange(verifier);
    expect(tok.status).toBe(200);
    const body = await tok.json();
    expect(body).toMatchObject({ token_type: 'Bearer', scope: 'browser' });
    expect(body.access_token).toMatch(/^gbd_/);
    expect((await exchange(verifier)).status).toBe(400);           // single use

    // the token is the owner's device login, listed and revocable like any other
    expect(keys.get(body.access_token)).toMatchObject({ owner: 'carla', console: true, device: true });
    const device = deviceTokens.list('carla').find((d) => d.name === 'Claude (connector)');
    expect(device).toBeTruthy();

    const client = new Client({ name: 'claude-ai', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${body.access_token}` } } }));
    const listed = await client.callTool({ name: 'browser_list', arguments: {} });
    expect(JSON.parse(listed.content[0].text).auth).toBe(`Bearer ${body.access_token}`);
    await client.close();

    deviceTokens.revoke(keys, 'carla', device.deviceId);
    const revoked = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(revoked.status).toBe(401);
  });

  it('refuses a consent POST from another origin or without the screen\'s token, and honours Cancel', async () => {
    signedIn = true;
    const { client_id } = await (await register()).json();
    expect((await consent(client_id, { origin: 'https://tenant-app.my-app.engineer' })).res.status).toBe(403);
    expect((await consent(client_id, { csrf: 'forged.token' })).res.status).toBe(403);
    const denied = new URL((await consent(client_id, { decision: 'deny' })).location);
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('code')).toBeNull();
  });
});
