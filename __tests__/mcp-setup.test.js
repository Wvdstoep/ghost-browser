import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const setupPage = readFileSync(fileURLToPath(new URL('../public/mcp-setup.html', import.meta.url)), 'utf8');
const composeLoader = readFileSync(fileURLToPath(new URL('../public/compose-index.html', import.meta.url)), 'utf8');
const deployScript = readFileSync(fileURLToPath(new URL('../scripts/gb-auto-deploy.sh', import.meta.url)), 'utf8');
const script = readFileSync(fileURLToPath(new URL('../public/js/mcp-setup.js', import.meta.url)), 'utf8');

describe('MCP setup in Settings', () => {
  it('uses the current browser host and copies working client templates without a secret', async () => {
    const dom = new JSDOM(html, {
      url: 'https://ghost-browser.example.test/',
      runScripts: 'outside-only',
    });
    const copied = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      value: { writeText: vi.fn(async value => copied.push(value)) },
    });
    dom.window.eval(script);

    const doc = dom.window.document;
    expect(doc.querySelector('#mcpSetup')).not.toBeNull();
    expect(doc.querySelector('#mcpEndpoint').value).toBe('https://ghost-browser.example.test/mcp');
    expect(doc.querySelector('#mcpCodexConfig').textContent).toContain('bearer_token_env_var = "GHOST_BROWSER_KEY"');
    expect(doc.querySelector('#mcpClaudeCommand').textContent).toContain('--header "Authorization: Bearer YOUR_GHOST_BROWSER_KEY"');
    expect(doc.querySelector('#mcpClaudeCommand').textContent).toContain('--scope user');
    expect(html).toContain('<script src="js/mcp-setup.js"></script>');

    doc.querySelector('#mcpCopyUrl').click();
    doc.querySelector('#mcpCopyCodex').click();
    doc.querySelector('#mcpCopyClaude').click();
    await vi.waitFor(() => expect(copied).toHaveLength(3));
    expect(copied[0]).toBe('https://ghost-browser.example.test/mcp');
    expect(copied[1]).toBe(doc.querySelector('#mcpCodexConfig').textContent);
    expect(copied[2]).toBe(doc.querySelector('#mcpClaudeCommand').textContent);
    await vi.waitFor(() => expect(doc.querySelector('#mcpSetupMsg').textContent).toContain('copied'));
    dom.window.close();
  });

  it('reports clipboard failures without exposing a key', async () => {
    const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only' });
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('denied'); }) },
    });
    dom.window.eval(script);
    dom.window.document.querySelector('#mcpCopyUrl').click();
    await vi.waitFor(() => expect(dom.window.document.querySelector('#mcpSetupMsg').textContent).toContain('Could not copy'));
    dom.window.close();
  });

  it('offers setup in the deployed Compose console and reveals a key only on request', async () => {
    expect(composeLoader).toContain('href="/mcp-setup.html"');
    expect(composeLoader).toContain('src="gbweb.js"');
    expect(deployScript).toContain('LOADER_SRC="$SRC/public/compose-index.html"');
    const dom = new JSDOM(setupPage, { url: 'https://ghost-browser.example.test/mcp-setup.html', runScripts: 'outside-only' });
    const fetchKey = vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ key: 'test-secret' }] }) }));
    dom.window.fetch = fetchKey;
    dom.window.eval(script);
    expect(fetchKey).not.toHaveBeenCalled();
    dom.window.document.querySelector('#mcpRevealKey').click();
    await vi.waitFor(() => expect(dom.window.document.querySelector('#mcpKeyBox').textContent).toBe('test-secret'));
    expect(fetchKey).toHaveBeenCalledWith('/api/auth/key', { credentials: 'same-origin' });
    dom.window.close();
  });
});
