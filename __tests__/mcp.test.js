/** MCP: the protocol core, the stdio transport against a stand-in Ghost Browser, and /mcp on the real server. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { spawn } from 'child_process';
import { handle, TOOLS, checkArgs } from '../src/mcp.js';

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const fake = (log = []) => async (req) => { log.push(req); return { status: 200, json: { ok: true, echo: req.path } }; };

describe('protocol core', () => {
  it('initialize answers with the protocol, capabilities and server info; notifications get no reply', async () => {
    const r = await handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }), fake());
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.capabilities.tools).toBeTruthy();
    expect(r.result.serverInfo.name).toBe('ghost-browser');
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, fake())).toBeNull();
  });
  it('lists every tool with a valid JSON schema and a description', async () => {
    const r = await handle(rpc(2, 'tools/list'), fake());
    expect(r.result.tools.length).toBe(TOOLS.length);
    for (const t of r.result.tools) {
      expect(t.name).toMatch(/^gb_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
      for (const req of t.inputSchema.required) expect(t.inputSchema.properties[req]).toBeTruthy();
    }
    const names = r.result.tools.map((t) => t.name);
    for (const n of ['gb_open', 'gb_navigate', 'gb_look', 'gb_click', 'gb_type', 'gb_read', 'gb_lease', 'gb_webmcp_tools', 'gb_webmcp_call', 'gb_close']) expect(names).toContain(n);
  });
  it('maps a call to exactly one HTTP API request', async () => {
    const log = [];
    await handle(rpc(3, 'tools/call', { name: 'gb_navigate', arguments: { sessionId: 's-1', url: 'https://example.com' } }), fake(log));
    await handle(rpc(4, 'tools/call', { name: 'gb_lease', arguments: { sessionId: 's-1', action: 'grant', allow: [{ method: 'POST', path: '/x' }], ttlMs: 1000 } }), fake(log));
    await handle(rpc(5, 'tools/call', { name: 'gb_lease', arguments: { sessionId: 's-1', action: 'revoke' } }), fake(log));
    expect(log[0]).toMatchObject({ method: 'POST', path: '/v1/sessions/s-1/navigate', body: { url: 'https://example.com' } });
    expect(log[1]).toMatchObject({ method: 'POST', path: '/v1/sessions/s-1/lease' });
    expect(log[2]).toMatchObject({ method: 'DELETE', path: '/v1/sessions/s-1/lease' });
  });
  it('refuses a bad call before it reaches the API: missing, unknown, mistyped, out-of-enum', async () => {
    const log = [];
    for (const [name, args] of [['gb_navigate', { sessionId: 's' }], ['gb_navigate', { sessionId: 's', url: 'x', extra: 1 }], ['gb_click', { sessionId: 's', index: '3' }], ['gb_lease', { sessionId: 's', action: 'delete-everything' }]]) {
      const r = await handle(rpc(9, 'tools/call', { name, arguments: args }), fake(log));
      expect(r.result.isError).toBe(true);
    }
    expect(log).toEqual([]);
    expect((await handle(rpc(10, 'tools/call', { name: 'gb_nope', arguments: {} }), fake())).error.code).toBe(-32602);
    expect((await handle(rpc(11, 'nope'), fake())).error.code).toBe(-32601);
    expect((await handle({ foo: 1 }, fake())).error.code).toBe(-32600);
  });
  it('turns an API error into a tool error carrying the API\'s own words, and a network failure into one too', async () => {
    const r = await handle(rpc(12, 'tools/call', { name: 'gb_navigate', arguments: { sessionId: 's', url: 'http://169.254.169.254' } }), async () => ({ status: 403, json: { error: 'that address is inside a private network and cannot be opened' } }));
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/private network/);
    const n = await handle(rpc(13, 'tools/call', { name: 'gb_capacity', arguments: {} }), async () => { throw new Error('ECONNREFUSED'); });
    expect(n.result.isError).toBe(true);
  });
  it('gb_look returns the elements as text and the screenshot as an image part', async () => {
    const r = await handle(rpc(14, 'tools/call', { name: 'gb_look', arguments: { sessionId: 's' } }), async () => ({ status: 200, json: { url: 'u', title: 't', summary: 's', elements: [{ index: 1 }], screenshot: 'data:image/jpeg;base64,QUJD' } }));
    expect(r.result.content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(r.result.content[1]).toMatchObject({ data: 'QUJD', mimeType: 'image/jpeg' });
  });
  it('checkArgs is strict about types', () => {
    const t = TOOLS.find((x) => x.name === 'gb_type');
    expect(checkArgs(t, { sessionId: 's', index: 1, text: 'hi' })).toBeNull();
    expect(checkArgs(t, { sessionId: 's', index: 1.5, text: 'hi' })).toMatch(/integer/);
  });
});

describe('stdio transport, against a stand-in Ghost Browser', () => {
  let gb, base; const seen = [];
  beforeAll(async () => {
    gb = http.createServer((req, res) => { seen.push({ m: req.method, u: req.url, a: req.headers.authorization }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ free: 3 })); });
    await new Promise((r) => gb.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${gb.address().port}`;
  });
  afterAll(() => gb.close());
  it('speaks newline-delimited JSON-RPC and authenticates every call with the key', async () => {
    const p = spawn(process.execPath, ['src/mcp.js'], { env: { ...process.env, GB_URL: base, GB_KEY: 'k-123' } });
    const lines = []; let buf = '';
    p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    send(rpc(1, 'initialize', {})); send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send(rpc(2, 'tools/list')); send(rpc(3, 'tools/call', { name: 'gb_capacity', arguments: {} })); p.stdin.write('not json\n');
    await new Promise((r) => { const t = setInterval(() => { if (lines.length >= 4) { clearInterval(t); r(); } }, 20); setTimeout(r, 4000); });
    p.kill();
    const by = Object.fromEntries(lines.map((l) => [l.id, l]));
    expect(by[1].result.serverInfo.name).toBe('ghost-browser');
    expect(by[2].result.tools.length).toBe(TOOLS.length);
    expect(JSON.parse(by[3].result.content[0].text)).toEqual({ free: 3 });
    expect(by.null.error.code).toBe(-32700);                                  // garbage on the wire is answered, not fatal
    expect(seen).toEqual([{ m: 'GET', u: '/v1/capacity', a: 'Bearer k-123' }]);
    expect(lines.length).toBe(4);                                              // no reply to the notification
  }, 15000);
  it('refuses to start without GB_URL and GB_KEY', async () => {
    const p = spawn(process.execPath, ['src/mcp.js'], { env: { PATH: process.env.PATH } });
    const code = await new Promise((r) => p.on('exit', r));
    expect(code).toBe(2);
  });
});
