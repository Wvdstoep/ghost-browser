'use strict';
/**
 * mcpOauth.js — OAuth 2.1 in front of /mcp, so claude.ai can connect to this browser by signing in.
 *
 * WHY. /mcp already takes a Bearer key, and that is the right credential for Codex or Claude Code on
 * a machine the owner controls. It is the wrong one for a claude.ai custom connector: there the
 * client sends the person through a login and expects a token back, and pasting the instance's API
 * key into a web form is worse security and is not even offered by claude.ai.
 *
 * THE ACCESS TOKEN IS A DEVICE TOKEN. Consent mints an ordinary `gbd_` device login for the owner
 * (deviceTokens.mint) and hands it back as the access token. Nothing downstream changes — the same
 * keys map, the same bearer check, the same owner identity the console has, the same revoke route
 * (DELETE /v1/device/tokens/:deviceId) — and the connector shows up in the owner's device list,
 * which is where they will look for it when they want it gone. A second token type with its own
 * store and its own verification would have been the bigger change pretending to be the smaller one.
 *
 * Ported from the my-app.engineer Workspace Bridge (provisioner/src/mcp-oauth.js), which Claude's
 * connector review already accepted. What the spec demands, and is implemented here:
 *   • Protected Resource Metadata (RFC 9728), and every 401 on /mcp points at it
 *   • Authorization Server Metadata (RFC 8414)
 *   • open Dynamic Client Registration (RFC 7591) — claude.ai registers itself before any human is here
 *   • PKCE with S256 only, single-use codes that live one minute
 *   • the `resource` parameter (RFC 8707): a token minted here is for THIS /mcp and nothing else
 *
 * One owner per instance (accounts.js), so consent is simply "is the signed-in owner present".
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const MCP_PATH = '/mcp';
const SCOPE = 'browser';
const CODE_TTL_MS = 60 * 1000;           // a code is exchanged within seconds; a minute is generous
const CSRF_TTL_MS = 15 * 60 * 1000;      // a consent screen left open longer than this is asked again
const MAX_CLIENTS = 200;                 // registration is open, so its file must not grow without end
const CLIENTS_FILE = () => path.join(process.env.PROFILE_DIR || '/profiles', '.mcp-oauth-clients.json');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const trim = (s) => String(s || '').replace(/\/+$/, '');

/*
 * WHERE THIS INSTANCE IS SEEN FROM. The issuer and the resource must be the URL claude.ai used, not
 * the pod's own http://…:3000. The platform sets TOOL_PUBLIC_URL on every hosted browser; a
 * self-host can set PUBLIC_URL; otherwise the proxy's forwarded headers say it.
 */
function publicOrigin(req) {
  const env = process.env.TOOL_PUBLIC_URL || process.env.PUBLIC_URL;
  if (env) return trim(env);
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${String(req.get('x-forwarded-host') || req.get('host')).split(',')[0].trim()}`;
}

const resourceUri = (origin) => `${trim(origin)}${MCP_PATH}`;

function protectedResourceMetadata(origin) {
  return {
    resource: resourceUri(origin),
    authorization_servers: [trim(origin)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/Wvdstoep/ghost-browser/blob/main/docs/mcp.md',
  };
}

function authServerMetadata(origin) {
  const base = trim(origin);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],   // public clients + PKCE
    code_challenge_methods_supported: ['S256'],        // never `plain`
    authorization_response_iss_parameter_supported: true,
  };
}

/** The WWW-Authenticate challenge that tells a client where to start the login. */
function challengeHeader(origin) {
  return `Bearer realm="ghost-browser", resource_metadata="${trim(origin)}/.well-known/oauth-protected-resource", scope="${SCOPE}"`;
}
const challengeFor = (req) => challengeHeader(publicOrigin(req));

/** RFC 7591. A redirect must be HTTPS, or http on loopback for a desktop client; anything else is an open redirect. */
function clientFromRegistration(body = {}) {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
  if (!uris.length) return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uris is required' };
  for (const u of uris) {
    let parsed;
    try { parsed = new URL(u); } catch { return { ok: false, error: 'invalid_redirect_uri', description: `not a URL: ${u}` }; }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
      return { ok: false, error: 'invalid_redirect_uri', description: `must be https (or http on localhost): ${u}` };
    }
  }
  return {
    ok: true,
    client: {
      client_id: `mcp_${crypto.randomBytes(16).toString('hex')}`,
      client_name: String(body.client_name || 'MCP client').slice(0, 120),
      redirect_uris: uris.slice(0, 10),
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
  };
}

/*
 * Validate an /authorize request BEFORE a human sees a consent screen; a broken request is the
 * developer's problem and nobody should be asked to approve it. Scopes are not checked against a
 * list: this browser has one permission, so whatever a client asks for, the grant is `browser` —
 * refusing a client over an extra scope name (offline_access, say) would only break the login.
 */
function checkAuthorizeRequest(q = {}, client, { origin }) {
  if (!client) return { ok: false, error: 'invalid_client', description: 'unknown client_id' };
  if (String(q.response_type) !== 'code') return { ok: false, error: 'unsupported_response_type', description: 'only "code" is supported' };
  if (!client.redirect_uris.includes(String(q.redirect_uri || ''))) {
    return { ok: false, error: 'invalid_request', description: 'redirect_uri does not match this client' };
  }
  if (String(q.code_challenge_method || '') !== 'S256' || !q.code_challenge) {
    return { ok: false, error: 'invalid_request', description: 'PKCE with code_challenge_method=S256 is required' };
  }
  if (q.resource && trim(q.resource) !== resourceUri(origin)) {
    return { ok: false, error: 'invalid_target', description: `resource must be ${resourceUri(origin)}` };
  }
  return { ok: true };
}

/**
 * Exchange a code for a token. The code exists and is fresh; the client and redirect are the ones it
 * was issued to; the PKCE verifier hashes to the recorded challenge. The code is consumed BEFORE
 * the token is minted — a code that survives its own exchange is a replay.
 */
async function exchangeCode(params = {}, { loadCode, consumeCode, mintToken, now = Date.now() }) {
  const code = String(params.code || '');
  if (!code) return { ok: false, error: 'invalid_request', description: 'code is required' };
  const rec = await loadCode(code);
  if (!rec) return { ok: false, error: 'invalid_grant', description: 'unknown or already-used code' };
  if (now - rec.createdAt > CODE_TTL_MS) {
    await consumeCode(code);
    return { ok: false, error: 'invalid_grant', description: 'the code has expired' };
  }
  if (String(params.client_id || '') !== rec.clientId) return { ok: false, error: 'invalid_grant', description: 'this code was issued to a different client' };
  if (String(params.redirect_uri || '') !== rec.redirectUri) return { ok: false, error: 'invalid_grant', description: 'redirect_uri does not match the one used at /authorize' };
  const verifier = String(params.code_verifier || '');
  if (!verifier) return { ok: false, error: 'invalid_request', description: 'code_verifier is required' };
  if (b64url(sha256(verifier)) !== rec.codeChallenge) return { ok: false, error: 'invalid_grant', description: 'code_verifier does not match the challenge' };
  await consumeCode(code);
  const token = await mintToken(rec);
  return { ok: true, body: { access_token: token, token_type: 'Bearer', scope: SCOPE } };
}

// ── Stores ──────────────────────────────────────────────────────────────────────────────
/* Clients persist: claude.ai registers once and comes back with the same client_id after a restart.
   Codes do not: they live a minute, and a restart mid-consent costs one retry. */
function readClients() { try { return JSON.parse(fs.readFileSync(CLIENTS_FILE(), 'utf8')); } catch { return {}; } }
function saveClient(client) {
  const all = readClients();
  all[client.client_id] = client;
  const ids = Object.keys(all).sort((a, b) => all[a].client_id_issued_at - all[b].client_id_issued_at);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_CLIENTS))) delete all[id];
  const f = CLIENTS_FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(all)); fs.renameSync(f + '.tmp', f);
}
const getClient = (id) => (id && readClients()[String(id)]) || null;

/** A small fixed-window limiter, per IP — the doors below are unauthenticated, so a script must hit a wall. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(); const ip = req.get('x-forwarded-for')?.split(',')[0].trim() || req.ip || '?';
    const h = hits.get(ip);
    if (!h || now - h.start > windowMs) { hits.set(ip, { start: now, n: 1 }); if (hits.size > 5000) hits.clear(); return next(); }
    if (++h.n > max) return res.status(429).json({ error: 'slow_down', error_description: 'too many requests' });
    next();
  };
}

// ── Consent CSRF ────────────────────────────────────────────────────────────────────────
/*
 * Consent is only given on our own page. The POST grants on the session cookie alone, and a hosted
 * browser sits on a *.my-app.engineer subdomain beside every tenant app — same SITE, so a Lax cookie
 * rides along on a form another subdomain auto-submits. So the page carries a signed, expiring token
 * bound to this owner and this client, and the POST must come from this origin as well.
 */
const CSRF_KEY = crypto.randomBytes(32);
function mintCsrf(subject, now = Date.now()) {
  const exp = now + CSRF_TTL_MS;
  return `${exp}.${crypto.createHmac('sha256', CSRF_KEY).update(`${subject}|${exp}`).digest('base64url')}`;
}
function verifyCsrf(token, subject, now = Date.now()) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || Number(exp) < now) return false;
  const want = Buffer.from(crypto.createHmac('sha256', CSRF_KEY).update(`${subject}|${exp}`).digest('base64url'));
  const got = Buffer.from(sig);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function sameOrigin(req, origin) {
  const o = req.get('origin');
  if (o && o !== 'null') return trim(o) === trim(origin);
  const r = req.get('referer');
  return !!r && (r === origin || r.startsWith(`${trim(origin)}/`));
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CSS = `
  :root{--bg:#0d1117;--panel:#161b22;--line:rgba(255,255,255,.08);--text:#e6edf3;--muted:#8b949e;--faint:#6e7681;--ok:#3fb950;--amber:#d29922}
  *{box-sizing:border-box} html,body{margin:0;height:100%}
  body{background:var(--bg);color:var(--text);font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.55}
  .card{width:100%;max-width:500px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px}
  h1{font-size:20px;margin:0 0 6px;letter-spacing:-.01em} .sub{color:var(--muted);font-size:13.5px;margin:0 0 18px}
  .who{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:9px;padding:10px 12px;font-size:13px;margin-bottom:16px}
  ul{margin:0 0 18px;padding-left:18px;font-size:13.5px} li{margin-bottom:6px} .warn{color:var(--amber)}
  .acts{display:flex;gap:10px;justify-content:flex-end;border-top:1px solid var(--line);padding-top:16px}
  button,.btn{font:inherit;font-weight:600;font-size:13.5px;border-radius:8px;padding:9px 18px;cursor:pointer;border:1px solid var(--line);text-decoration:none;display:inline-block}
  .allow{background:var(--ok);color:#04100a;border-color:transparent} .deny{background:transparent;color:var(--muted)}
  .foot{color:var(--faint);font-size:11.5px;margin-top:14px} code{font-size:12px;color:var(--muted)}
  @media(max-width:460px){.card{padding:20px}.acts{flex-direction:column-reverse}button,.btn{width:100%;text-align:center}}`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main class="card">${body}</main></body></html>`;

function errorPage(error, description) {
  return page('Connection problem', `<h1>That connection request isn't valid</h1>
<p class="sub">Nothing has been shared and no permission has been given.</p>
<div class="who"><b>${esc(error)}</b><br><span style="color:var(--muted)">${esc(description || '')}</span></div>
<p class="foot">This is a problem with the application that sent you here, not with your browser. You can close this tab.</p>`);
}

/*
 * NOT SIGNED IN. The console is a Kotlin/Wasm app with its own sign-in (a password, or the platform's
 * single sign-on), so rather than teach it a return URL this page sends the owner to sign in the way
 * they always do, in another tab, and continues by itself once the session cookie exists.
 */
function signInPage() {
  return page('Sign in to Ghost Browser', `<h1>Sign in to your Ghost Browser first</h1>
<p class="sub">An app wants to connect to this browser. Only its owner can allow that.</p>
<div class="acts"><a class="btn allow" href="/" target="_blank" rel="opener">Open Ghost Browser and sign in</a></div>
<p class="foot">Keep this tab open. It continues on its own as soon as you are signed in.</p>
<script>setInterval(function(){fetch('/api/auth/state',{credentials:'same-origin'}).then(function(r){return r.json()})
.then(function(s){if(s&&s.signedIn)location.reload()}).catch(function(){})},2000)</script>`);
}

function consentPage({ owner, client, query, csrf, host }) {
  const hidden = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method', 'resource', 'scope']
    .filter((k) => query[k] != null)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(query[k])}">`).join('');
  return page(`Connect ${client.client_name}`, `<h1>Connect ${esc(client.client_name)} to your Ghost Browser</h1>
<p class="sub">Signed in as <b>${esc(owner)}</b> · <code>${esc(host)}</code></p>
<div class="who">It will be able to:</div>
<ul><li>open, read and screenshot pages in its own browser sessions</li>
<li class="warn">click and type on websites, including ones your profiles are logged into</li>
<li>list and close the sessions it opened</li></ul>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${esc(csrf)}">
<div class="acts"><button class="deny" type="submit" name="decision" value="deny">Cancel</button>
<button class="allow" type="submit" name="decision" value="allow">Allow</button></div></form>
<p class="foot">Allowing adds a device login named “${esc(client.client_name)} (connector)” to your Ghost Browser.
Removing that device revokes it.</p>`);
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────
/**
 * Mount discovery, registration, consent and token endpoints.
 * `accounts` answers who is signed in; `mintToken(owner, client)` returns a Bearer token for them.
 */
function mount(app, { accounts, mintToken, log = console }) {
  const codes = new Map();
  const codeKey = (code) => b64url(sha256(code));
  const owner = (req) => { const who = accounts.verifyToken(accounts.readCookie(req)); return who && who.username; };
  const subject = (who, clientId) => `${who}|${clientId}`;
  const registerLimit = limiter(20, 60 * 60 * 1000);
  const oauthLimit = limiter(60, 5 * 60 * 1000);

  const prm = (req, res) => res.json(protectedResourceMetadata(publicOrigin(req)));
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, prm);
  app.get('/.well-known/oauth-authorization-server', (req, res) => res.json(authServerMetadata(publicOrigin(req))));

  app.post('/oauth/register', registerLimit, (req, res) => {
    const r = clientFromRegistration(req.body || {});
    if (!r.ok) return res.status(400).json({ error: r.error, error_description: r.description });
    try { saveClient(r.client); } catch (e) { return res.status(500).json({ error: 'server_error', error_description: e.message }); }
    log.info(`[mcp-oauth] registered client ${r.client.client_id} (${r.client.client_name})`);
    res.status(201).json(r.client);
  });

  app.get('/oauth/authorize', oauthLimit, (req, res) => {
    try {
      // our own origin goes to ourselves (so the Allow POST carries it); nothing leaks to the redirect_uri
      res.set('Referrer-Policy', 'same-origin');
      res.set('Cache-Control', 'no-store');
      const origin = publicOrigin(req);
      const client = getClient(req.query.client_id);
      const check = checkAuthorizeRequest(req.query, client, { origin });
      if (!check.ok) return res.status(400).send(errorPage(check.error, check.description));
      const who = owner(req);
      if (!who) return res.send(signInPage());
      res.send(consentPage({ owner: who, client, query: req.query, csrf: mintCsrf(subject(who, client.client_id)), host: new URL(origin).host }));
    } catch (e) {
      log.error(`[mcp-oauth] authorize: ${e.message}`);
      if (!res.headersSent) res.status(500).send(errorPage('server_error', 'The permission screen could not be shown. Nothing has been shared.'));
    }
  });

  // Express 4 does not catch a rejected async handler — the request just hangs — so every path ends in a response.
  app.post('/oauth/authorize', oauthLimit, express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const origin = publicOrigin(req);
      if (!sameOrigin(req, origin)) {
        log.warn(`[mcp-oauth] consent POST from "${String(req.get('origin') || req.get('referer') || 'none').slice(0, 80)}" refused`);
        return res.status(403).send(errorPage('access_denied', 'This approval did not come from the permission screen. Nothing was shared.'));
      }
      const client = getClient(req.body.client_id);
      const check = checkAuthorizeRequest(req.body, client, { origin });
      if (!check.ok) return res.status(400).send(errorPage(check.error, check.description));
      const who = owner(req);
      if (!who) return res.status(401).send(errorPage('login_required', 'Your session expired. Sign in and try again.'));
      if (!verifyCsrf(req.body.csrf, subject(who, client.client_id))) {
        return res.status(403).send(errorPage('access_denied', 'This permission screen expired. Start the connection again from your app.'));
      }
      const redirect = new URL(String(req.body.redirect_uri));
      if (req.body.state) redirect.searchParams.set('state', String(req.body.state));
      if (String(req.body.decision || '') !== 'allow') {
        redirect.searchParams.set('error', 'access_denied');
        return res.redirect(redirect.toString());
      }
      const code = b64url(crypto.randomBytes(32));
      const now = Date.now();
      for (const [k, v] of codes) if (now - v.createdAt > CODE_TTL_MS) codes.delete(k);
      codes.set(codeKey(code), {
        clientId: client.client_id, clientName: client.client_name, redirectUri: String(req.body.redirect_uri),
        codeChallenge: String(req.body.code_challenge), owner: who, createdAt: now,
      });
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('iss', origin);   // RFC 9207
      res.redirect(redirect.toString());
    } catch (e) {
      log.error(`[mcp-oauth] consent: ${e.message}`);
      if (!res.headersSent) res.status(500).send(errorPage('server_error', 'Something went wrong granting access. Nothing was shared.'));
    }
  });

  app.post('/oauth/token', oauthLimit, express.urlencoded({ extended: false }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const params = { ...(req.body || {}) };
      if (String(params.grant_type || '') !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
      const r = await exchangeCode(params, {
        loadCode: async (code) => codes.get(codeKey(code)) || null,
        consumeCode: async (code) => { codes.delete(codeKey(code)); },
        mintToken: async (rec) => {
          const token = await mintToken(rec.owner, { client_id: rec.clientId, client_name: rec.clientName });
          log.info(`[mcp-oauth] ${rec.owner} connected ${rec.clientName}`);
          return token;
        },
      });
      if (!r.ok) return res.status(400).json({ error: r.error, error_description: r.description });
      res.json(r.body);
    } catch (e) {
      log.error(`[mcp-oauth] token: ${e.message}`);
      if (!res.headersSent) res.status(500).json({ error: 'server_error' });
    }
  });
}

/** One device login per connected client: re-connecting the same client rotates its token. */
const connectorDevice = (client) => ({ deviceId: `mcp-${String(client.client_id).replace(/^mcp_/, '').slice(0, 16)}`, name: `${client.client_name} (connector)` });

module.exports = {
  MCP_PATH, SCOPE, CODE_TTL_MS, CLIENTS_FILE,
  publicOrigin, resourceUri, protectedResourceMetadata, authServerMetadata, challengeHeader, challengeFor,
  clientFromRegistration, checkAuthorizeRequest, exchangeCode, mintCsrf, verifyCsrf, sameOrigin, connectorDevice, mount,
};
