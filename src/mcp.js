'use strict';
/**
 * mcp.js — Ghost Browser as an MCP server, so any agent client can drive a logged-in browser.
 *
 * One protocol core, two transports:
 *   stdio   `GB_URL=https://… GB_KEY=… node src/mcp.js`   for Claude Desktop, IDEs and CLIs
 *   http    POST /mcp on the server itself                 for hosted agents (Bearer key, same as /v1)
 *
 * The tools are thin: each is one call on the HTTP API that already exists, so MCP adds no second
 * surface to secure. The things that make a tool safe still hold underneath: the SSRF guard on every
 * navigation, the per-key session ceiling, and the write lease. In particular `gb_lease` is how a
 * client says what a session may CHANGE, and a session with no lease can read and cannot write.
 *
 * Protocol: JSON-RPC 2.0; initialize, notifications/initialized, ping, tools/list, tools/call.
 */

const PROTOCOL = '2025-06-18';
const INFO = { name: 'ghost-browser', version: '0.1.0' };

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SID = { sessionId: { type: 'string', description: 'from gb_open' } };

/*
 * `route(args)` → { method, path, body?, query? } on the HTTP API. `shape` (optional) turns the API's
 * answer into MCP content; the default is the JSON as text.
 */
const TOOLS = [
  { name: 'gb_open', description: 'Open a browser session. Pass profile to reuse a logged-in profile (a login a person made by hand, once). Returns sessionId.',
    inputSchema: obj({ profile: { type: 'string', description: 'a named, logged-in profile; omit for a clean anonymous session' } }),
    route: (a) => ({ method: 'POST', path: '/v1/sessions', body: a.profile ? { profile: a.profile } : {} }) },
  { name: 'gb_navigate', description: 'Go to a public http(s) URL. Private and internal addresses are refused.',
    inputSchema: obj({ ...SID, url: { type: 'string' } }, ['sessionId', 'url']),
    route: (a) => ({ method: 'POST', path: `/v1/sessions/${a.sessionId}/navigate`, body: { url: a.url } }) },
  { name: 'gb_look', description: 'See the page as numbered interactive elements (Set-of-Mark) plus a text summary. Click and type by number.',
    inputSchema: obj({ ...SID, screenshot: { type: 'boolean', description: 'include the numbered screenshot (default true)' } }, ['sessionId']),
    route: (a) => ({ method: 'GET', path: `/v1/sessions/${a.sessionId}/analyze`, query: a.screenshot === false ? { screenshot: 'false' } : {} }),
    shape: (j) => {
      const content = [{ type: 'text', text: JSON.stringify({ url: j.url, title: j.title, summary: j.summary, elements: j.elements }) }];
      if (j.screenshot) content.push({ type: 'image', data: String(j.screenshot).replace(/^data:image\/\w+;base64,/, ''), mimeType: /^data:(image\/\w+)/.exec(String(j.screenshot))?.[1] || 'image/jpeg' });
      return content;
    } },
  { name: 'gb_click', description: 'Click an element by its number from gb_look, or by visible text.',
    inputSchema: obj({ ...SID, index: { type: 'integer' }, text: { type: 'string' } }, ['sessionId']),
    route: (a) => ({ method: 'POST', path: `/v1/sessions/${a.sessionId}/click`, body: a.text ? { text: a.text } : { index: a.index } }) },
  { name: 'gb_type', description: 'Type into an element by its number from gb_look. submit:true presses Enter.',
    inputSchema: obj({ ...SID, index: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['sessionId', 'index', 'text']),
    route: (a) => ({ method: 'POST', path: `/v1/sessions/${a.sessionId}/type`, body: { index: a.index, text: a.text, submit: !!a.submit } }) },
  { name: 'gb_read', description: 'The cleaned text of the current page.',
    inputSchema: obj({ ...SID }, ['sessionId']),
    route: (a) => ({ method: 'GET', path: `/v1/sessions/${a.sessionId}/content` }),
    shape: (j) => [{ type: 'text', text: `${j.title || ''}\n${j.url}\n\n${j.content}` }] },
  { name: 'gb_lease', description: 'Say what this session may CHANGE. With no lease a session reads and cannot write. allow = [{method, path, body?:{field: regex}, max?}]. action: grant | status | revoke.',
    inputSchema: obj({ ...SID, action: { type: 'string', enum: ['grant', 'status', 'revoke'] }, allow: { type: 'array', items: { type: 'object' } }, ttlMs: { type: 'integer' }, note: { type: 'string' } }, ['sessionId', 'action']),
    route: (a) => a.action === 'grant' ? { method: 'POST', path: `/v1/sessions/${a.sessionId}/lease`, body: { allow: a.allow || [], ttlMs: a.ttlMs, note: a.note } }
      : a.action === 'revoke' ? { method: 'DELETE', path: `/v1/sessions/${a.sessionId}/lease` }
      : { method: 'GET', path: `/v1/sessions/${a.sessionId}/lease` } },
  { name: 'gb_webmcp_tools', description: 'The tools the current page offers itself through WebMCP (name, description, input schema). Prefer these over clicking when a page has them.',
    inputSchema: obj({ ...SID }, ['sessionId']),
    route: (a) => ({ method: 'GET', path: `/v1/sessions/${a.sessionId}/webmcp` }) },
  { name: 'gb_webmcp_call', description: 'Call a tool the page registered through WebMCP. It runs inside the page, so it is bound by the session\'s write lease like any other request.',
    inputSchema: obj({ ...SID, name: { type: 'string' }, args: { type: 'object' } }, ['sessionId', 'name']),
    route: (a) => ({ method: 'POST', path: `/v1/sessions/${a.sessionId}/webmcp/call`, body: { name: a.name, args: a.args || {} } }) },
  { name: 'gb_close', description: 'Close a session and free its browser.',
    inputSchema: obj({ ...SID }, ['sessionId']),
    route: (a) => ({ method: 'DELETE', path: `/v1/sessions/${a.sessionId}` }) },
  { name: 'gb_capacity', description: 'How many more sessions this server can take right now.',
    inputSchema: obj({}),
    route: () => ({ method: 'GET', path: '/v1/capacity' }) },
];

const publicTool = (t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema });

/** Check args against the tool's schema the cheap way: required present, types right. A bad call never reaches the API. */
function checkArgs(tool, args) {
  const sch = tool.inputSchema; const a = args || {};
  for (const r of sch.required || []) if (a[r] === undefined || a[r] === null || a[r] === '') return `missing required argument "${r}"`;
  for (const [k, v] of Object.entries(a)) {
    const p = sch.properties[k];
    if (!p) return `unknown argument "${k}"`;
    const t = p.type;
    if (t === 'integer' && !Number.isInteger(v)) return `"${k}" must be an integer`;
    if (t === 'string' && typeof v !== 'string') return `"${k}" must be a string`;
    if (t === 'boolean' && typeof v !== 'boolean') return `"${k}" must be a boolean`;
    if (t === 'array' && !Array.isArray(v)) return `"${k}" must be an array`;
    if (t === 'object' && (typeof v !== 'object' || Array.isArray(v) || v === null)) return `"${k}" must be an object`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}`;
  }
  return null;
}

/**
 * Handle ONE JSON-RPC message. `call({method, path, body, query})` performs an HTTP API request and
 * resolves { status, json }. Returns the response object, or null for a notification.
 */
async function handle(msg, call) {
  const id = msg && msg.id;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(-32600, 'not a JSON-RPC 2.0 request');
  if (id === undefined) return null;                                      // a notification (initialized, cancelled): no reply

  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: INFO,
        instructions: 'Open a session, navigate, look (numbered elements), click/type by number. A session can read but not write until gb_lease grants it; a site\'s own WebMCP tools, when it has them, are listed by gb_webmcp_tools.' });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS.map(publicTool) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === (msg.params && msg.params.name));
      if (!tool) return err(-32602, `unknown tool "${msg.params && msg.params.name}"`);
      const bad = checkArgs(tool, msg.params.arguments);
      if (bad) return reply({ isError: true, content: [{ type: 'text', text: `${tool.name}: ${bad}` }] });
      let out;
      try { out = await call(tool.route(msg.params.arguments || {})); }
      catch (e) { return reply({ isError: true, content: [{ type: 'text', text: `${tool.name}: could not reach Ghost Browser (${e.message})` }] }); }
      if (out.status >= 400) return reply({ isError: true, content: [{ type: 'text', text: `${tool.name}: ${out.json && out.json.error ? out.json.error : 'HTTP ' + out.status}` }] });
      return reply({ content: tool.shape ? tool.shape(out.json) : [{ type: 'text', text: JSON.stringify(out.json) }] });
    }
    default: return err(-32601, `method not found: ${msg.method}`);
  }
}

/** A `call` that goes to a Ghost Browser over HTTP. */
function httpCaller(base, key) {
  return async ({ method, path, body, query }) => {
    const u = new URL(String(base).replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, v);
    const r = await fetch(u, { method, headers: { authorization: 'Bearer ' + key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    let json = null; try { json = await r.json(); } catch { /* empty body */ }
    return { status: r.status, json };
  };
}

/** The stdio transport: newline-delimited JSON-RPC on stdin/stdout. Nothing but protocol goes to stdout. */
function serveStdio({ call, stdin = process.stdin, stdout = process.stdout }) {
  let buf = '';
  const send = (o) => stdout.write(JSON.stringify(o) + '\n');
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      const batch = Array.isArray(msg) ? msg : [msg];
      Promise.all(batch.map((m) => handle(m, call))).then((rs) => { for (const r of rs.filter(Boolean)) send(r); });
    }
  });
}

module.exports = { handle, TOOLS, httpCaller, serveStdio, checkArgs, PROTOCOL };

if (require.main === module) {
  const base = process.env.GB_URL; const key = process.env.GB_KEY;
  if (!base || !key) { process.stderr.write('Set GB_URL (your Ghost Browser) and GB_KEY (an API key).\n'); process.exit(2); }
  serveStdio({ call: httpCaller(base, key) });
}
