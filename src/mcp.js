'use strict';

// MCP is a thin, bearer-authenticated adapter over the existing browser API. The API remains
// responsible for owner isolation, capacity limits and public-URL checks.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const string = (description) => ({ type: 'string', minLength: 1, description });
const id = string('Browser session ID returned by browser_open.');
const tools = [
  ['browser_profiles', 'List the browser profiles and what each is signed in to or used for, on this browser and on the owner\'s devices. "default" is the owner\'s main profile, signed in with their Google account. Call this before browser_open when a site needs a login.', {}, []],
  ['browser_open', 'Open an isolated browser session. Pass profile to use a signed-in profile from browser_profiles (default: "default"). Close it when finished.', { profile: string('Profile name from browser_profiles, e.g. "default".') }, []],
  ['browser_list', 'List your open browser sessions.', {}, []],
  ['browser_navigate', 'Navigate to a public HTTP(S) URL in your session.', { sessionId: id, url: string('Public URL to visit.') }, ['sessionId', 'url']],
  ['browser_analyze', 'Inspect the current page and return numbered interactive elements.', { sessionId: id }, ['sessionId']],
  ['browser_click', 'Click a numbered element from the most recent analysis. This can submit forms or change websites.', { sessionId: id, index: { type: 'integer', minimum: 1 } }, ['sessionId', 'index']],
  ['browser_type', 'Type into a numbered element from the most recent analysis; optionally submit it.', { sessionId: id, index: { type: 'integer', minimum: 1 }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['sessionId', 'index', 'text']],
  ['browser_scroll', 'Scroll the page vertically.', { sessionId: id, dy: { type: 'number' } }, ['sessionId', 'dy']],
  ['browser_read', 'Read the text of the current page.', { sessionId: id }, ['sessionId']],
  ['browser_extract_product', 'Extract factual product fields from the current page for review before importing to a shop. Does not verify variants, stock, shipping or fulfillment.', { sessionId: id }, ['sessionId']],
  ['browser_screenshot', 'Capture an image of the current page.', { sessionId: id }, ['sessionId']],
  ['browser_close', 'Close your browser session.', { sessionId: id }, ['sessionId']],
].map(([name, description, properties, required]) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: ['browser_list', 'browser_profiles', 'browser_analyze', 'browser_read', 'browser_extract_product', 'browser_screenshot'].includes(name),
    destructiveHint: ['browser_click', 'browser_type'].includes(name), openWorldHint: true },
}));

function validate(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  const schema = tool.inputSchema;
  for (const key of schema.required) if (!(key in args)) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const p = schema.properties[key];
    if (!p || (p.type === 'integer' ? !Number.isInteger(value) : typeof value !== p.type) ||
        (p.minLength && value.length < p.minLength) || (p.minimum !== undefined && value < p.minimum) ||
        (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`Invalid ${key}`);
  }
  if (args.sessionId && !/^s-[a-z0-9]+-[a-z0-9]+$/.test(args.sessionId)) throw new Error('Invalid sessionId');
}

const CONNECTOR_ORIGINS = new Set(['https://claude.ai', 'https://claude.com']);

function createHandler({ requestApi }) {
  return async (req, res) => {
    // Browser-originated requests are not needed by CLI clients; refuse them to prevent cross-site use.
    // Claude's own connector origins are the exception: claude.ai may present one when it relays a call.
    const origin = req.get('origin');
    if (origin && !CONNECTOR_ORIGINS.has(origin)) return res.status(403).json({ error: 'Browser origins are not supported' });
    const server = new Server({ name: 'ghost-browser', version: '1.0.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        const tool = tools.find(t => t.name === params.name);
        if (!tool) throw new Error('Unknown tool');
        const args = params.arguments || {};
        validate(tool, args);
        const session = args.sessionId && encodeURIComponent(args.sessionId);
        const base = `/v1/sessions/${session}`;
        const routes = {
          browser_open: ['POST', '/v1/sessions', args.profile ? { profile: String(args.profile) } : {}], browser_list: ['GET', '/v1/sessions'],
          browser_profiles: ['GET', '/v1/browser-profiles'],
          browser_navigate: ['POST', `${base}/navigate`, { url: args.url }],
          browser_analyze: ['GET', `${base}/analyze?screenshot=false`],
          browser_click: ['POST', `${base}/click`, { index: args.index }],
          browser_type: ['POST', `${base}/type`, { index: args.index, text: args.text, submit: args.submit === true }],
          browser_scroll: ['POST', `${base}/scroll`, { dy: args.dy }],
          browser_read: ['GET', `${base}/content`], browser_screenshot: ['GET', `${base}/screenshot`],
          browser_extract_product: ['GET', `${base}/product`],
          browser_close: ['DELETE', base],
        };
        const [method, path, body] = routes[tool.name];
        const result = await requestApi({ method, path, body, authorization: req.get('authorization') });
        if (!result.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify(result.data) }] };
        if (tool.name === 'browser_screenshot') return { content: [{ type: 'image', mimeType: result.mimeType || 'image/jpeg', data: result.data }] };
        return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
      } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
    });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' }); }
  };
}

function localApi(port) {
  return async ({ method, path, body, authorization }) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(150000),   // a walled page tries the server, then loads on a device
    });
    const image = response.ok && response.headers.get('content-type')?.startsWith('image/');
    const data = image ? Buffer.from(await response.arrayBuffer()).toString('base64') : await response.json();
    return { ok: response.ok, data, mimeType: image ? response.headers.get('content-type').split(';')[0] : undefined };
  };
}

/*
 * EVERY 401 SAYS WHERE TO LOG IN. A claude.ai connector starts OAuth only when the challenge names
 * the resource metadata (RFC 9728), and it must do so for a revoked or unknown token as well as a
 * missing one — otherwise a revoked connector just fails instead of asking to reconnect.
 */
function mount(app, { keys, requestApi, challenge = () => 'Bearer' }) {
  const bearer = require('./keys').auth(keys);
  app.all('/mcp', (req, res, next) => {
    const header = req.get('authorization') || '';
    if (!/^Bearer\s+\S+$/i.test(header)) {
      res.set('WWW-Authenticate', challenge(req));
      return res.status(401).json({ error: 'Bearer key required' });
    }
    if (keys.size && !keys.get(header.replace(/^Bearer\s+/i, '').trim())) {
      res.set('WWW-Authenticate', `${challenge(req)}, error="invalid_token"`);
      return res.status(401).json({ error: 'invalid_token' });
    }
    return bearer(req, res, next);
  }, createHandler({ requestApi }));
}

module.exports = { createHandler, localApi, mount, tools };
