/** WebMCP: tools a page registers are found whichever object it uses, callable, and bound by the lease. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import * as webmcp from '../src/webmcp.js';
import { mint, verify, enforce } from '../src/lease.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip */ }
let browser = null;
if (chromium) {
  const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
  try { browser = await chromium.launch(opts); }
  catch { try { if (process.env.GB_CHROMIUM) browser = await chromium.launch({ ...opts, executablePath: process.env.GB_CHROMIUM }); } catch { console.warn('[webmcp] no Chromium — skipping'); } }
}

const cart = [];
const PAGE = `<!doctype html><html><body><h1>Shop</h1><script>
  // a page written for agents: registers tools through navigator.modelContext…
  navigator.modelContext.registerTool({
    name: 'search_products', description: 'Search the catalogue', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: async ({ q }) => ({ results: ['Ghost Mug', 'Ghost Tee'].filter((x) => x.toLowerCase().includes(String(q).toLowerCase())) }),
  });
  // …and the newer document.modelContext, with provideContext
  document.modelContext.provideContext({ tools: [{
    name: 'add_to_cart', description: 'Add a SKU to the cart', inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
    execute: async ({ sku }) => { const r = await fetch('/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku }) }); if (!r.ok) throw new Error('cart refused: ' + r.status); return { added: sku }; },
  }] });
</script></body></html>`;

describe.skipIf(!browser)('WebMCP capture', () => {
  let server, base, ctx, page;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/cart') { let b = ''; req.on('data', (c) => { b += c; }); return req.on('end', () => { cart.push(JSON.parse(b).sku); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }); }
      res.setHeader('content-type', 'text/html'); res.end(PAGE);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
    ctx = await browser.newContext(); await webmcp.attach(ctx); page = await ctx.newPage(); await page.goto(base + '/');
  }, 30000);
  afterAll(async () => { await ctx.close(); await browser.close(); await new Promise((r) => server.close(r)); });

  it('finds tools registered through either object, with their schemas', async () => {
    const tools = await webmcp.list(page);
    expect(tools.map((t) => t.name).sort()).toEqual(['add_to_cart', 'search_products']);
    expect(tools.find((t) => t.name === 'search_products').inputSchema.required).toEqual(['q']);
    expect(JSON.stringify(tools)).not.toMatch(/execute/);                    // the function never leaves the page
  });
  it('calls a tool and returns its result; an unknown tool is an error value, not a throw', async () => {
    expect(await webmcp.call(page, 'search_products', { q: 'mug' })).toEqual({ ok: true, result: { results: ['Ghost Mug'] } });
    expect((await webmcp.call(page, 'nope', {})).ok).toBe(false);
  });
  it('a tool that writes is bound by the write lease, exactly like any request', async () => {
    expect(await webmcp.call(page, 'add_to_cart', { sku: 'mug-1' })).toMatchObject({ ok: true });     // no gate yet
    expect(cart).toEqual(['mug-1']);
    const gate = await enforce(ctx, () => null, { log: { info() {} } });                                // session becomes read-only
    const r = await webmcp.call(page, 'add_to_cart', { sku: 'tee-9' });
    expect(r.ok).toBe(false);
    expect(cart).toEqual(['mug-1']);                                                                    // it never left the browser
    expect(gate.blocked.length).toBe(1);
  });
  it('a page with no tools lists none, and a page that breaks its own registration does not break capture', async () => {
    const p2 = await ctx.newPage(); await p2.setContent('<script>try { navigator.modelContext.registerTool(null); navigator.modelContext.registerTool({name: 1}); } catch (e) {}</script>');
    expect(await webmcp.list(p2)).toEqual([]);
  });
});
