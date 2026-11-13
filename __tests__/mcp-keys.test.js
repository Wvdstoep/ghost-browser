import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import mcp from '../src/mcp.js';
import { parseKeys } from '../src/keys.js';

// 2026-11-13, a connector session scheduling a post in Business Suite: the scheduling switch had no
// number, the time field had none either, and there was no way to press Tab into it. These are the
// three ways round a control the element list cannot name: click by visible text, a key, a spot.
describe('Ghost Browser MCP: keys, click by text, click at a spot', () => {
  let http, client, calls;
  beforeAll(async () => {
    calls = [];
    const app = express();
    app.use(express.json());
    mcp.mount(app, { keys: parseKeys('key-one:solo'), requestApi: async (req) => { calls.push(req); return { ok: true, data: { url: 'https://x.example/' } }; } });
    http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`), { requestInit: { headers: { authorization: 'Bearer key-one' } } }));
  });
  afterAll(async () => { await client.close(); http.closeAllConnections?.(); await new Promise((resolve) => http.close(resolve)); });
  const s = 's-abc-123';
  const call = (name, args) => client.callTool({ name, arguments: { sessionId: s, ...args } });

  it('lists the new tools as actions, and analyze points at them', async () => {
    const byName = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
    for (const n of ['browser_press_key', 'browser_click_at']) expect(byName[n].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.browser_click.inputSchema.required).toEqual(['sessionId']);
    expect(byName.browser_analyze.description).toMatch(/browser_press_key Tab.*browser_click_at/);
  });

  it('routes a key, typed text, a click by text and a click at a spot to the browser API', async () => {
    await call('browser_press_key', { key: 'Tab' });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/v1/sessions/${s}/keys`, body: { key: 'Tab' } });
    await call('browser_press_key', { key: 'Shift+Tab' });
    expect(calls.at(-1).body).toEqual({ key: 'Shift+Tab' });
    await call('browser_press_key', { key: 'Space' });
    expect(calls.at(-1).body).toEqual({ key: ' ' });                      // Playwright's name for it
    await call('browser_press_key', { text: '20:30' });
    expect(calls.at(-1)).toMatchObject({ path: `/v1/sessions/${s}/keys`, body: { text: '20:30' } });
    await call('browser_click', { text: 'Bericht plannen' });
    expect(calls.at(-1)).toMatchObject({ path: `/v1/sessions/${s}/click`, body: { text: 'Bericht plannen' } });
    await call('browser_click', { index: 7 });
    expect(calls.at(-1).body).toEqual({ index: 7 });
    await call('browser_click_at', { x: 640, y: 412 });
    expect(calls.at(-1)).toMatchObject({ path: `/v1/sessions/${s}/mouse`, body: { x: 640, y: 412 } });
  });

  it('refuses unclear or unsafe input without touching the browser', async () => {
    const before = calls.length;
    for (const [name, args] of [
      ['browser_click', {}], ['browser_click', { index: 2, text: 'x' }],
      ['browser_press_key', {}], ['browser_press_key', { key: 'Tab', text: 'x' }],
      ['browser_press_key', { key: 'Tab; rm -rf' }], ['browser_press_key', { key: 'ab' }], ['browser_press_key', { key: 'F13' }],
      ['browser_press_key', { text: 'x'.repeat(2001) }],
      ['browser_click_at', { x: -1, y: 5 }], ['browser_click_at', { x: 1.5, y: 5 }], ['browser_click_at', { x: 5 }],
    ]) expect((await call(name, args)).isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    expect(calls.length).toBe(before);
  });
});
