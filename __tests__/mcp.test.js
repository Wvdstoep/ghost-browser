import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import mcp from '../src/mcp.js';
import { parseKeys } from '../src/keys.js';

describe('Ghost Browser MCP', () => {
  let http, url, calls;
  beforeAll(async () => {
    calls = [];
    const app = express();
    app.use(express.json());
    mcp.mount(app, { keys: parseKeys('key-one:solo'), requestApi: async (req) => {
      calls.push(req);
      if (req.path.endsWith('/screenshot')) return { ok: true, data: 'aW1hZ2U=' };
      if (req.path.endsWith('/navigate')) return { ok: false, data: { error: 'private address blocked' } };
      return { ok: true, data: { sessionId: 's-abc-123' } };
    } });
    http = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  });
  afterAll(() => new Promise(resolve => http.close(resolve)));

  it('rejects missing or invalid credentials and browser origins', async () => {
    const send = (headers) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    expect((await send({})).status).toBe(401);
    expect((await send({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await send({ authorization: 'Bearer key-one', origin: 'https://example.com' })).status).toBe(403);
  });

  it('works through the official MCP client and forwards the caller key', async () => {
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer key-one' } } });
    await client.connect(transport);
    expect((await client.listTools()).tools.map(t => t.name)).toContain('browser_navigate');
    const opened = await client.callTool({ name: 'browser_open', arguments: {} });
    expect(JSON.parse(opened.content[0].text).sessionId).toBe('s-abc-123');
    const blocked = await client.callTool({ name: 'browser_navigate', arguments: { sessionId: 's-abc-123', url: 'http://127.0.0.1' } });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain('private address blocked');
    const image = await client.callTool({ name: 'browser_screenshot', arguments: { sessionId: 's-abc-123' } });
    expect(image.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg', data: 'aW1hZ2U=' });
    expect(calls.every(c => c.authorization === 'Bearer key-one')).toBe(true);
    const before = calls.length;
    const invalid = await client.callTool({ name: 'browser_close', arguments: { sessionId: '..' } });
    expect(invalid.isError).toBe(true);
    expect(calls.length).toBe(before);
    await client.close();
  });

  it('forwards requests to the local API, including errors and images', async () => {
    const backend = express();
    backend.use(express.json());
    backend.post('/v1/sessions', (req, res) => res.status(403).json({ error: req.get('authorization') }));
    backend.get('/v1/sessions/s-abc-123/screenshot', (_req, res) => res.type('jpeg').send(Buffer.from('image')));
    const server = await new Promise(resolve => { const s = backend.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const api = mcp.localApi(server.address().port);
      const error = await api({ method: 'POST', path: '/v1/sessions', body: {}, authorization: 'Bearer key-one' });
      expect(error).toEqual({ ok: false, data: { error: 'Bearer key-one' } });
      const image = await api({ method: 'GET', path: '/v1/sessions/s-abc-123/screenshot', authorization: 'Bearer key-one' });
      expect(image).toEqual({ ok: true, data: 'aW1hZ2U=' });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
