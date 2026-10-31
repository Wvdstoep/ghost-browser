import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import mcp from '../src/mcp.js';
import { parseKeys } from '../src/keys.js';

// LunaGrow, 2026-10-31: a Flow image the agent made had no way into the shop. The picture tools.
describe('Ghost Browser MCP picture tools', () => {
  let http, client, calls;
  beforeAll(async () => {
    calls = [];
    const app = express();
    app.use(express.json());
    mcp.mount(app, { keys: parseKeys('key-one:solo'), requestApi: async (req) => {
      calls.push(req);
      if (req.path.endsWith('/b64')) return { ok: true, data: req.path.includes('f00000000000000aa')
        ? { id: 'f00000000000000aa', name: 'flow.png', mime: 'image/png', size: 5, data: 'data:image/png;base64,aGVsbG8=' }
        : { id: 'f00000000000000bb', name: 'doc.pdf', mime: 'application/pdf', size: 5, data: 'data:application/pdf;base64,aGVsbG8=' } };
      return { ok: true, data: { fileId: 'f00000000000000aa' } };
    } });
    http = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`), { requestInit: { headers: { authorization: 'Bearer key-one' } } }));
  });
  afterAll(async () => { await client.close(); http.closeAllConnections?.(); await new Promise(resolve => http.close(resolve)); });

  it('lists the four picture tools, read-only where they only read', async () => {
    const tools = (await client.listTools()).tools;
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    for (const n of ['browser_images', 'browser_save_image', 'browser_upload_file', 'browser_file']) expect(byName[n]).toBeTruthy();
    expect(byName.browser_images.annotations.readOnlyHint).toBe(true);
    expect(byName.browser_upload_file.annotations.destructiveHint).toBe(true);
  });

  it('routes each to its endpoint', async () => {
    await client.callTool({ name: 'browser_images', arguments: { sessionId: 's-abc-123' } });
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/v1/sessions/s-abc-123/images' });
    await client.callTool({ name: 'browser_save_image', arguments: { sessionId: 's-abc-123', image: 2 } });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/sessions/s-abc-123/save-image', body: { image: 2 } });
    await client.callTool({ name: 'browser_upload_file', arguments: { sessionId: 's-abc-123', index: 4, fileId: 'f00000000000000aa' } });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/sessions/s-abc-123/upload-file', body: { index: 4, fileId: 'f00000000000000aa' } });
  });

  it('refuses a save with nothing to save and a malformed fileId, without calling the browser', async () => {
    const before = calls.length;
    expect((await client.callTool({ name: 'browser_save_image', arguments: { sessionId: 's-abc-123' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'browser_file', arguments: { fileId: '../../etc' } })).isError).toBe(true);
    expect(calls.length).toBe(before);
  });

  it('returns a kept picture as an image block plus what it is, and refuses a non-picture', async () => {
    const out = await client.callTool({ name: 'browser_file', arguments: { fileId: 'f00000000000000aa' } });
    expect(out.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
    expect(JSON.parse(out.content[1].text)).toMatchObject({ fileId: 'f00000000000000aa', name: 'flow.png' });
    expect((await client.callTool({ name: 'browser_file', arguments: { fileId: 'f00000000000000bb' } })).isError).toBe(true);
  });

  it('reads pictures through the session and keeps them on the shelf (server source pins)', () => {
    const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    expect(src).toContain("app.post('/v1/sessions/:id/save-image'");
    expect(src).toMatch(/context\(\)\.request\.get\(src/);          // the session's own cookies
    expect(src).toMatch(/assertPublicUrl\(src\)/);                   // never a private address
    expect(src).toContain("waitForEvent('filechooser'");            // the picker is caught, not shown
  });
});
