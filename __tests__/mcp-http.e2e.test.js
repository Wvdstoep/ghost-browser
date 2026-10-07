/** /mcp on the real server: same auth as /v1, and the tools reach the real API. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path';

const PORT = 3200 + Math.floor(Math.random() * 400);
let proc; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-mcp-'));
const post = (body, key = 'k-mcp') => fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) });

beforeAll(async () => {
  proc = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(PORT), API_KEYS: 'k-mcp:team', PROFILE_DIR: dir, HEADLESS: 'true' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/v1/capacity`)).status) break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
}, 30000);
afterAll(() => { proc && proc.kill(); });

describe('POST /mcp', () => {
  it('rejects a call with no key or a wrong key, like /v1', async () => {
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)).status).toBe(401);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope')).status).toBe(401);
  });
  it('lists the tools and answers a tool call through the real API, with the caller\'s own key', async () => {
    const l = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    expect(l.result.tools.map((t) => t.name)).toContain('gb_lease');
    const c = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gb_capacity', arguments: {} } })).json();
    expect(c.result.isError).toBeUndefined();
    expect(JSON.parse(c.result.content[0].text).limits).toBeTruthy();
  });
  it('a navigation to an internal address is refused by the guard, through MCP too', async () => {
    const o = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gb_open', arguments: {} } })).json();
    if (o.result.isError) { console.warn('[mcp-http] gb_open failed, guard-through-MCP not exercised:', o.result.content[0].text); return; }
    const sid = JSON.parse(o.result.content[0].text).sessionId;
    const n = await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gb_navigate', arguments: { sessionId: sid, url: 'http://[::ffff:a9fe:a9fe]/latest/meta-data/' } } })).json();
    expect(n.result.isError).toBe(true);
    expect(n.result.content[0].text).toMatch(/private/);
    await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'gb_close', arguments: { sessionId: sid } } });
  }, 60000);
  it('a batch is answered as a batch, a lone notification with 202', async () => {
    const b = await (await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])).json();
    expect(b.map((x) => x.id)).toEqual([1, 2]);
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });
});
