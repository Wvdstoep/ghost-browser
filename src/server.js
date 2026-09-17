/**
 * server.js — Ghost Browser, the API.
 *
 * Phase 0 of the plan: the browsing that already runs inside the agent platform, lifted out behind
 * an HTTP API, with the session limits that let it serve more than one person. Deliberately NOT in
 * here yet: the AI navigation loop, the recipe compiler and billing. Those are later phases, and
 * every one of them is easier against a service that already survives concurrency.
 *
 * What is here is the whole primitive the rest is built on: open a session, go somewhere, look at
 * the page as numbered boxes, act on a number, read the text.
 */

const express = require('express');
const path = require('path');
const { BrowserPool, LIMITS } = require('./pool');
const { assertPublicUrl } = require('./guard');
const { parseKeys, auth, PLANS } = require('./keys');
const { analyzePage, clickByIndex } = require('./inspector');
const accounts = require('./accounts');
const profiles = require('./profiles');
const settingsStore = require('./settings');
const company = require('./company');
const jobs = require('./jobs');
const agent = require('./agent');
const me = require('./me');
const llm = require('./llm');
const { makeSink, makeConversation } = require('./sink');
const sso = require('./sso');
const roles = require('./roles');
const userRoles = require('./userRoles');
const workflows = require('./workflows');
// Roles a person authored live in a JSON store on the profiles volume; register it so roles.list()
// and roles.get() return them alongside the built-ins (which always win a name collision).
roles.useExternal(userRoles);
const sites = require('./sites');
const userSites = require('./userSites');
const platforms = require('./platforms');
const connectors = require('./connectors');
const playbook = require('./playbook');
const crypto = require('crypto');
const tailscale = require('./tailscale');
const diagnostics = require('./diagnostics');
const fileAssets = require('./fileAssets');

const PORT = process.env.PORT || 3000;
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT_MS, 10) || 30000;

const log = {
  info: (m) => console.log(`[ghost] ${m}`),
  warn: (m) => console.warn(`[ghost] ${m}`),
  // 14 call sites and no method: the first error path to run took the whole server down.
  error: (m) => console.error(`[ghost] ERROR ${m}`),
};
const ops = require('./ops'); ops.tapLog(log);

const app = express();
app.use(express.json({ limit: '1mb' }));
/*
 * The console must never be cached. A stale index.html is indistinguishable from a broken deploy —
 * an old page was still logging its old messages against a new server, which cost an afternoon of
 * looking for a bug that had already been fixed.
 */
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true, lastModified: true,
  // extensionless pretty URLs: /hub -> hub.html (the Device Hub page, shared by cluster/desktop/mobile)
  extensions: ['html'],
  // no-cache on the console's own code too, or a deploy ships new JS/CSS that browsers keep serving
  // from cache (the "I don't see the new UI" trap). no-cache = revalidate every load (304 if unchanged).
  setHeaders: (res, file) => { if (/\.(html|js|css)$/i.test(file)) res.set('Cache-Control', 'no-cache'); },
}));

const pool = new BrowserPool({ logger: log });
const keys = parseKeys();

/** Turn a thrown error into the answer it deserves, with the status it carried. */
const fail = (res, e) => {
  const status = e.status || 500;
  if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
  res.status(status).json({ error: e.message });
};

// ── Open endpoints: liveness and honest capacity ────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/*
 * Capacity is public on purpose. A client that can see the worker is full can queue politely
 * instead of hammering it, and an operator can see the ceiling being approached before it is hit.
 */
app.get('/v1/capacity', (_req, res) => res.json({ ...pool.capacity(), limits: LIMITS }));

/*
 * WHAT THE BROWSER HAS LEARNED. Route cards are execution knowledge — shapes only, never token
 * values — so this is safe to render. A person watches which platforms have a fast path and, if a
 * platform changes and a card goes stale in a way the self-heal has not yet caught, forgets one by
 * hand. Authed like the rest of the operator surface.
 */
app.get('/v1/route-cards', authed, (_req, res) => {
  res.json({ cards: agent.cardStore.list().map((c) => ({
    intent: c.intent, origin: c.origin, method: c.method,
    confidence: c.confidence, lastVerified: c.lastVerified, quarantined: c.quarantined, fails: c.fails,
  })) });
});
app.delete('/v1/route-cards/:origin/:intent', authed, (req, res) => {
  agent.cardStore.forget(decodeURIComponent(req.params.origin), decodeURIComponent(req.params.intent));
  res.json({ ok: true });
});

/*
 * What is configured, without ever handing back a secret. The AI paths are not built yet; this
 * reports whether their credentials are present so the UI can say so plainly rather than implying
 * a capability that would fail on first use.
 */
app.get('/v1/config', (_req, res) => res.json({
  plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })),
  keysConfigured: keys.size,
  ollama: {
    configured: !!(process.env.OLLAMA_URL && process.env.OLLAMA_API_KEY),
    baseUrl: process.env.OLLAMA_URL ? process.env.OLLAMA_URL.replace(/\/+$/, '') : null,
    navigationModel: process.env.OLLAMA_VISION_MODEL || null,
    extractionModel: process.env.OLLAMA_TEXT_MODEL || null,
  },
}));

/*
 * TWO KINDS OF CALLER, TWO KINDS OF CREDENTIAL.
 *
 * A program gets a Bearer key. A person gets an account and a cookie. Conflating them is what made
 * the console ask for the API key on every visit — a key pasted into a browser field ends up in a
 * password manager, a screenshot and eventually a support chat, and it is the wrong credential for
 * a human anyway.
 *
 * The owner's sessions are attributed to the same identity whichever door they came through, so
 * opening a session in the console and then driving it from a script is one session, not two.
 */
const bearer = auth(keys);

/*
 * SSO-ONLY mode. A platform-managed install (Ghost Browser connected from the Tools tab) belongs to
 * exactly ONE platform user and must ONLY be entered through their platform login. Local password
 * accounts are disabled entirely — otherwise ANYONE who reached the tool's URL before the owner's
 * first sign-in could claim ownership via the "create the owner account" form. Gated on LEADFLOW being
 * configured so an accidental SSO_ONLY without a secret can never lock everyone out (there'd be no way
 * in at all); in that case it falls back to normal local accounts.
 */
const SSO_ONLY = /^(1|true|yes|on)$/i.test(String(process.env.SSO_ONLY || '')) && !!process.env.LEADFLOW_JWT_SECRET;
const ssoOnlyBlock = (_req, res) =>
  res.status(403).json({ error: 'This browser is single sign-on only — open it from your platform to sign in. There is no separate password account.' });

// ── Who am I, and is there even an account yet ──────────────────────────────────────────
app.get('/api/auth/state', (req, res) => {
  const who = accounts.verifyToken(accounts.readCookie(req));
  /*
   * `superadmin` is here so the console never has to ASK BY BEING REFUSED. It used to decide whether
   * to show the Admin tab by calling /v1/admin/overview and catching the failure, which meant every
   * ordinary page load logged a red 403 in the browser's console — noise that reads exactly like a
   * broken page, and twice sent the owner looking for a bug that was not there. A question about who
   * you are belongs on the route that answers who you are.
   */
  res.json({ needsSignup: accounts.needsSignup(), signedIn: !!who, username: who ? who.username : null,
            superadmin: !!(who && SUPERADMIN.has(String(who.username || '').toLowerCase())),
            minPassword: accounts.MIN_PASSWORD, sso: !!process.env.LEADFLOW_JWT_SECRET, ssoOnly: SSO_ONLY });
});

app.post('/api/auth/signup', (req, res) => {
  if (SSO_ONLY) return ssoOnlyBlock(req, res);
  try {
    const rec = accounts.signup(req.body?.username, req.body?.password);
    const { token, exp } = accounts.issue(rec);
    accounts.setCookie(res, token, exp);
    res.status(201).json({ username: rec.username });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/auth/login', (req, res) => {
  if (SSO_ONLY) return ssoOnlyBlock(req, res);
  try {
    const rec = accounts.login(req.body?.username, req.body?.password);
    const { token, exp } = accounts.issue(rec);
    accounts.setCookie(res, token, exp);
    res.json({ username: rec.username });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/*
 * ONE LOGIN, because this is one app now.
 *
 * The console grew up standalone with its own owner and its own password. That was right on its own
 * host and wrong the moment it became a page of LeadFlow — being asked to sign in again, inside an
 * app you are already signed into, is the clearest possible sign that two things were bolted
 * together rather than merged.
 *
 * LeadFlow already signs a token for every signed-in user. Given the same secret this can verify
 * one offline, so no request has to go back to the API and no second account exists anywhere.
 *
 * ON A CONSOLE WITH NO OWNER YET this also creates one, named after the LeadFlow user. That is the
 * whole first-run experience for someone who only ever sees LeadFlow: there is no separate signup
 * because there is no separate product.
 */
app.post('/api/auth/sso', (req, res) => {
  try {
    const claims = sso.verifyLeadflowToken(req.body?.token, process.env.LEADFLOW_JWT_SECRET);
    const who = sso.ownerName(claims);
    let rec = accounts.load();
    if (!rec) {
      // A password nobody will ever type. Signing in happens through LeadFlow; this exists only
      // because the record needs one, and a guessable placeholder would be worse than a random one.
      rec = accounts.signup(who, crypto.randomBytes(24).toString('hex'));
      log.info(`[sso] created the owner account for ${rec.username}`);
    } else {
      /*
       * ISOLATION — this Ghost Browser belongs to exactly ONE owner. A DIFFERENT LeadFlow user signing
       * in must NOT be logged in as them: that would hand over their live sessions, roles and workflows.
       * Each user gets their OWN instance; refuse the mismatch rather than share one. This is the line
       * that makes a per-user pod actually private, not just nominally.
       *
       * Allowed: the same identity (ownerName matches), OR a platform superadmin — whose token can carry
       * an email that differs from the stored username, so matching on that alone would lock the real
       * owner out. A superadmin is always let in; anyone else who is not the owner is refused.
       */
      const email = String(claims.email || '').toLowerCase();
      const sameOwner = String(who).toLowerCase() === String(rec.username).toLowerCase();
      const isSuper = !!email && SUPERADMIN.has(email);
      if (!sameOwner && !isSuper) {
        log.warn(`[sso] refused ${who} — this browser belongs to ${rec.username}`);
        return res.status(403).json({ error: 'This Ghost Browser belongs to another account. You get your own — sign in from your own workspace.' });
      }
    }
    const { token, exp } = accounts.issue(rec);
    accounts.setCookie(res, token, exp);
    res.json({ username: rec.username, via: 'leadflow' });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (_req, res) => { accounts.clearCookie(res); res.json({ ok: true }); });

/*
 * SUPERADMIN OVERVIEW — the platform (my-app) superadmin's cross-tenant view, one pod at a time.
 * Each GB instance is one owner's isolated pod, so the platform dashboard fans out to every pod's
 * /v1/admin/overview and stitches the results into Users / Flows / Roles. Gated by the SSO IDENTITY
 * (the caller's LeadFlow token, email in SUPERADMIN_USERS) — the view travels with the platform login,
 * not this console's owner or an API key. Read-only: it reports, it never drives.
 */
const SUPERADMIN = new Set(String(process.env.SUPERADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
function superadminGate(req, res, next) {
  // The signed-in console authenticates by COOKIE, and the owner's username IS the SSO email — so a
  // superadmin logged in here is recognised without re-presenting the platform token.
  try {
    const who = accounts.verifyToken(accounts.readCookie(req));
    if (who && SUPERADMIN.has(String(who.username || '').toLowerCase())) { req.superadmin = String(who.username).toLowerCase(); return next(); }
  } catch { /* fall through to the token path */ }
  // A LeadFlow SSO token (the aggregator's server-to-server fan-out, or an external caller).
  try {
    const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() || (req.body && req.body.token) || req.query.token;
    const claims = sso.verifyLeadflowToken(raw, process.env.LEADFLOW_JWT_SECRET);
    const email = String(claims.email || '').toLowerCase();
    if (email && SUPERADMIN.has(email)) { req.superadmin = email; return next(); }
  } catch { /* not a valid superadmin token */ }
  return res.status(403).json({ error: 'not a superadmin' });
}

app.get('/v1/admin/overview', superadminGate, (_req, res) => {
  const acct = accounts.load();
  const owner = acct ? acct.username : null;
  let sessions = [];
  try { sessions = owner ? pool.listFor(owner) : []; } catch { sessions = []; }
  const wfs = (workflows.all() || []).map((w) => ({ id: w.id, name: w.name, active: !!w.active, autoApprove: !!w.autoApprove, nodes: (w.nodes || []).length, createdAt: w.createdAt, updatedAt: w.updatedAt }));
  const created = (userRoles.all() || []).map((r) => ({ id: r.id, label: r.label, group: r.group || r.site || null, tools: (r.tools || []).length, createdAt: r.createdAt, updatedAt: r.updatedAt }));
  res.json({
    tenant: process.env.TAILSCALE_HOSTNAME || null,
    owner: acct ? { username: acct.username, createdAt: acct.createdAt } : null,
    counts: { sessions: sessions.length, workflows: wfs.length, createdRoles: created.length },
    sessions: sessions.map((s) => ({ profile: s.profile || null, url: s.url, lastUsed: s.lastUsed, createdAt: s.createdAt, expiresAt: s.expiresAt })),
    workflows: wfs,
    roles: created,
    at: new Date().toISOString(),
  });
});

/*
 * THE AGGREGATOR — one call the superadmin dashboard hits, which fans out to every tenant pod's
 * /v1/admin/overview and returns them together. Server-side on purpose: a pod cannot reach another
 * tenant's pod directly (network policy), but it CAN fetch that tenant's PUBLIC ingress, and a
 * server-side fetch also sidesteps cross-origin from the browser. The tenant list is GB_TENANT_URLS
 * (comma-separated base URLs); with none set it reports just this instance, so a single-tenant deploy
 * needs no config. The caller's superadmin SSO token is forwarded to each pod, which re-checks it.
 */
app.get('/v1/admin/tenants-overview', superadminGate, async (req, res) => {
  // Forward whatever the caller presented; if they came in on the console cookie (no token to
  // forward), mint a short-lived superadmin SSO token so the OTHER pods still recognise the caller.
  const mintToken = () => {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const h = b({ alg: 'HS256', typ: 'JWT' }), p = b({ email: req.superadmin, exp: Math.floor(Date.now() / 1000) + 300 });
    return `${h}.${p}.${crypto.createHmac('sha256', process.env.LEADFLOW_JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
  };
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() || (req.query && req.query.token) || mintToken();
  const configured = String(process.env.GB_TENANT_URLS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const targets = configured.length ? configured : [`http://127.0.0.1:${process.env.PORT || 3000}`];
  const tenants = await Promise.all(targets.map(async (base) => {
    try {
      const r = await fetch(base + '/v1/admin/overview', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { base, error: `HTTP ${r.status}` };
      return { base, ...(await r.json()) };
    } catch (e) { return { base, error: String(e.message).slice(0, 140) }; }
  }));
  res.json({ tenants, count: tenants.length, at: new Date().toISOString() });
});

/*
 * FORGETTING THE PASSWORD SHOULD NOT REQUIRE AN ADMINISTRATOR.
 *
 * Twice now the account has had to be cleared by hand, over SSH, because there is no recovery: one
 * owner, no email, nothing to send a link to. That is a fine design for a single-owner console and
 * a bad one without a way back in.
 *
 * The API key is the way back in. It already grants everything this console can do — anyone holding
 * it can drive the browser through the API regardless of who owns the console — so letting it clear
 * the account grants no new power, it just stops a forgotten password from needing me.
 */
app.post('/api/auth/reset', (req, res) => {
  const presented = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() || req.get('x-api-key') || '';
  if (!presented || !keys.get(presented)) {
    return res.status(401).json({ error: 'this needs the API key — it is in the app\'s environment as API_KEYS' });
  }
  const had = accounts.reset();
  accounts.clearCookie(res);
  res.json({ reset: had, needsSignup: true });
});

/*
 * THE KEY, SHOWN TO THE OWNER RATHER THAN LOST.
 *
 * The API key was generated at deploy time and handed over in a chat message, which is the one
 * place it can scroll away — the same mistake as a WordPress password mentioned once by an agent.
 * It has never actually been lost (it lives in the deployment's environment), but a credential
 * nobody can find is a credential nobody has. Signed in, you can read it here.
 */
app.get('/api/auth/key', (req, res) => {
  if (!accounts.verifyToken(accounts.readCookie(req))) return res.status(401).json({ error: 'sign in first' });
  res.json({ keys: [...keys.values()].map((k) => ({ key: k.key, plan: k.plan, maxConcurrent: k.maxConcurrent })) });
});

/** A cookie OR a key. Whichever it is, the caller ends up with the same identity attached. */
function authed(req, res, next) {
  const who = accounts.verifyToken(accounts.readCookie(req));
  if (who) {
    const anyKey = [...keys.values()][0];
    /*
     * `console: true` — this is the PERSON who owns the browser, signed in to its own console, not a
     * connected tool holding a key. It matters for what they are allowed to SEE: a caller's identity
     * comes from its key, so LeadFlow's walks are owned by "gb_42c3f" and the owner's console by
     * their username, and listFor(owner) hid the owner's own browser from them — a Maps walk was
     * mid-search while the console said "Nothing running right now".
     */
    req.client = { owner: who.username, console: true, plan: anyKey ? anyKey.plan : 'solo', maxConcurrent: anyKey ? anyKey.maxConcurrent : 1 };
    return next();
  }
  return bearer(req, res, next);
}

app.use('/v1/sessions', authed);

// ── Sessions ────────────────────────────────────────────────────────────────────────────
/*
 * WHAT YOU ARE HOLDING. Added the first time the limit was hit for real: the answer was a bare
 * "at its session limit" with no way to see the session causing it or to get rid of it, which is
 * a dead end rather than a limit. A cap is only reasonable if the thing it caps is visible.
 */
/*
 * WHAT IS HOLDING THIS BROWSER, IN WORDS.
 *
 * The console lists every session, and until now each was a session id, a url and an owner — and
 * the owner is the same eight characters for every organ, because the platform mints ONE key that
 * the master, Herald and LeadFlow all share. So "who is using my browser" was unanswerable from the
 * screen, and "can I close it" was worse: the owner watched a Google login sit on a sign-in page for
 * twenty minutes, unable to sign in, because the session belonged to a key rather than to them.
 *
 * A session's real identity is the JOB in it. A role reads as what it is — reach.search is Search
 * Console, learn.shot is a picture for an answer page — and the job's own status says whether it is
 * working or finished and merely holding the door shut.
 */
function heldBy(sessionId) {
  try {
    const j = (jobs.jobs ? [...jobs.jobs.values()] : []).filter((x) => x && x.sessionId === sessionId);
    if (!j.length) return null;
    /* The live one if there is one, otherwise the most recent — a finished job still holding a
       session is exactly the thing worth seeing, so it is never hidden. */
    const live = j.find((x) => x.status === 'running') || j.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    return { jobId: live.id, role: live.role || 'general', status: live.status, goal: String(live.goal || '').slice(0, 120) };
  } catch { return null; }
}

app.get('/v1/sessions', (req, res) => {
  /* The console sees every session on the install — it is one browser with one owner, and a session
     a connected tool opened is still theirs. A key sees only what it opened. */
  const list = (req.client.console ? pool.listAll() : pool.listFor(req.client.owner))
    .map((s) => ({ ...s, job: heldBy(s.sessionId), yours: s.owner === req.client.owner }));
  res.json({
    sessions: list,
    maxConcurrent: req.client.maxConcurrent, plan: req.client.plan,
  });
});

/** Close everything this caller holds — the way out of a session they lost track of. */
app.delete('/v1/sessions', async (req, res) => {
  const closed = await pool.closeAllFor(req.client.owner);
  res.json({ closed });
});

app.post('/v1/sessions', async (req, res) => {
  try {
    /*
     * `reuse` turns the common case into one call: a client that just wants A session, rather than
     * specifically a NEW one, gets the one it already has instead of an error it has to understand.
     */
    if (req.body && req.body.reuse) {
      /*
       * A profile names WHICH session. `reuse` with a profile used to hand back the caller's first
       * session whatever profile it was on, so a job meant for the reddit login landed in a
       * signed-out browser already mid-conversation and was refused — the caller then waited for a
       * session that was never going to be the one it asked for. Only a session ON that profile is
       * "the one it already has"; otherwise fall through and open one there.
       */
      const mine = pool.listFor(req.client.owner);
      const want = req.body.profile ? profiles.safeName(req.body.profile) : null;   // sessions carry the safe name
      const existing = want ? mine.find((s) => s.profile === want) : mine[0];
      if (existing) return res.json({ ...existing, plan: req.client.plan, reused: true });
    }
    /*
     * A PRESET SETS ITSELF UP. Its settings are written BEFORE the browser starts, because that is
     * the only moment they can take effect — the timezone, the proxy and the operating system it
     * presents as are all fixed when the context is created, and a profile configured afterwards
     * looks configured and behaves as though it were not.
     */
    const preset = req.body && req.body.preset ? sites.get(req.body.preset) : null;
    let profileName = req.body && req.body.profile ? String(req.body.profile) : null;
    if (preset) {
      /*
       * WHICH BROWSER A SIGN-IN OPENS, in the order that cannot lose a login:
       *
       *  1. A PIN. Some sites only sign in THROUGH another site, so the login is in that site's
       *     profile whatever the policy says. Indie Hackers goes through Google, and tried in both it
       *     works in the google profile and not in the shared one.
       *  2. THE PROFILE THAT ALREADY HOLDS THIS LOGIN. If the owner has signed in to this site
       *     somewhere, that is where the session belongs — Reddit and Hacker News each live in their
       *     own profile here. Sending them to the shared browser would open one signed out of the
       *     very site being opened, and quietly ask for the login to be made a second time.
       *  3. THE ONE BROWSER, where the install is set up as a single jar signed into everything
       *     (`singleBrowser`). This is the right home for a site nobody has signed into yet: it puts
       *     the new login beside the others instead of minting another empty profile.
       *  4. Its own profile, for a multi-profile install.
       *
       * Only case 4 creates and labels a profile. Writing a site label onto a browser that already
       * holds other logins would hide them from every role that matches on that label — a silent
       * break of working logins, to set up one more.
       */
      const single = settingsStore.read();
      const oneBrowser = single.singleBrowser ? (single.browserProfile || 'facebook') : null;
      const pinned = sites.pinnedProfile(req.body.preset);
      const served = pinned ? null : sites.servedProfile(req.body.preset, pool.listProfilesDetailed());
      profileName = pinned || served || oneBrowser || sites.profileNameFor(req.body.preset);
      if (!pinned && !served && !oneBrowser && !sites.borrowsProfile(req.body.preset)) {
        profiles.write(profileName, { site: preset.site, ...preset.defaults });
        log.info(`[preset] ${profileName} set up for ${preset.site}`);
      } else {
        log.info(`[preset] ${req.body.preset} opens in the existing "${profileName}" browser (its sign-in lives there)`);
      }
    }

    const s = await pool.createSession({
      owner: req.client.owner, maxConcurrent: req.client.maxConcurrent,
      reserved: !!req.client.console,   // the owner is never refused for the session limit — see pool.createSession
      profile: profileName,
      takeover: !!(req.body && req.body.takeover),
    });
    // Opened where a person setting up a login actually wants to be, rather than on a home page
    // that will redirect them somewhere else first.
    if (preset) s.startUrl = preset.start;
    /* The Platforms tab's "last used" comes from here: a session opening on a profile IS the moment
       a platform was worked. Best-effort — a registry that will not write must never fail a login. */
    try {
      const p = String(profileName || '').toLowerCase();
      if (p) for (const r of platforms.list()) {
        if (r.loginProfile === p || (r.profiles || []).includes(p)) platforms.note(r.key, { used: true });
      }
    } catch { /* the session is what matters */ }
    res.status(201).json({ ...s, plan: req.client.plan, reused: false });
  } catch (e) {
    // Hand back the way out with the refusal, so the caller never has to guess.
    if (e.status === 409 || e.status === 503) {
      const mine = pool.listFor(req.client.owner);
      if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
      return res.status(e.status).json({
        error: e.message,
        // Hand back what the client needs to offer a way out, rather than only what went wrong.
        ...(e.canTakeover ? { canTakeover: true, blockedBy: e.blockedBy, profile: e.profile } : {}),
        yourSessions: mine,
        /* A refusal can know its own way out better than this handler can. The tailnet refusal
           arrives here as a 409 and would otherwise be told to "retry shortly", which is not the
           problem and would send somebody round the loop until they gave up. */
        hint: e.hint
          ? e.hint
          : e.canTakeover
          ? 'That session is yours — POST again with {"takeover":true} to close it and open here.'
          : mine.length
          ? 'You already have a session — POST with {"reuse":true} to take it, or DELETE /v1/sessions to drop it.'
          : 'Someone else is using this worker. Retry shortly.',
      });
    }
    fail(res, e);
  }
});

/*
 * SMOKE — open a page as a stranger would, watch it for a few seconds, say what the browser saw,
 * and give the browser straight back.
 *
 * THE RUN THAT MADE THIS NECESSARY is the same one behind diagnostics.js, one layer earlier. A build
 * declared itself finished on "HTTP 200 on / and /api/health" — which a completely broken
 * single-page app returns all day, because the server is fine and the app is not. The app that
 * passed that check bounced from its landing page to /login and back, forever. Nobody could read a
 * word of it or click anything. It was handed to QA anyway, and the failure was finally found by a
 * person opening the URL — after a full QA run and a 1.37M-token fix attempt had been spent.
 *
 * This is NOT an agent: no model, no tools, no step budget, no conversation, no cost. It opens an
 * EPHEMERAL, ANONYMOUS session — deliberately, because that is precisely the visitor who was broken
 * and the one nobody was checking for — waits long enough for a client-rendered app to settle and
 * for a redirect loop to reveal itself, reads the diagnostics buffers, and CLOSES. Seconds, not
 * minutes.
 *
 * It answers ONE question: can a stranger who has never been here begin at all? Not "does the
 * product work" — that stays QA's job, and this exists so QA's expensive runs get spent on real
 * bugs instead of rediscovering that the front door is nailed shut.
 */
app.post('/v1/smoke', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  const settle = Math.min(20000, Math.max(1500, Number(req.body && req.body.settleMs) || 6000));
  let sessionId = null;
  try {
    // The same guard every navigation goes through. A URL arriving in a request body is exactly the
    // shape an SSRF takes, and "it is only a health check" is how that gets waved through.
    await assertPublicUrl(url);

    /*
     * Its OWN owner lane, on purpose. The caller may well be holding a session already — QA mid-run,
     * a login half-finished — and a check that seizes or is refused by that session is worse than no
     * check. Suffixing the owner gives smoke a private per-caller slot: never in contention with the
     * caller's real work, and still only one smoke at a time.
     */
    const s = await pool.createSession({ owner: `${req.client.owner}:smoke`, maxConcurrent: 1 });
    sessionId = s.sessionId;
    const session = pool.get(sessionId);
    const page = session.page;

    let loadError = null;
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch (e) { loadError = String(e.message || e).slice(0, 300); }

    // Then sit still and WATCH. A redirect loop does not exist in a snapshot — it only exists over
    // time — and a client-rendered app needs a moment before "nothing to click" means anything.
    await new Promise((r) => setTimeout(r, settle));

    // null, not 0: these stay UNMEASURED unless the page actually answers, because a page that
    // refuses the question must not be reported as an empty one.
    let title = '', textLength = null, clickable = null, finalUrl = url;
    try {
      finalUrl = page.url();
      title = await page.title();
      const probe = await page.evaluate(() => ({
        len: ((document.body && document.body.innerText) || '').trim().length,
        clickable: document.querySelectorAll('a[href],button,input,select,textarea,[role="button"]').length,
      }));
      textLength = probe.len; clickable = probe.clickable;
    } catch { /* a page that will not answer a question is itself the finding */ }

    const d = diagnostics.dump(session);

    // The bar, and the reasoning behind it, live with the perception they read (diagnostics.js).
    const problems = diagnostics.smokeVerdict({ loadError, dump: d, textLength, clickable, settleMs: settle });
    // Say WHOSE fault it is, because the caller acts on that: a certificate or a route is not
    // something an application rebuild can repair, and a gate that cannot tell would spend build
    // after build on one.
    const platformFault = diagnostics.platformFaultOf(loadError);

    res.json({
      ok: problems.length === 0,
      url, finalUrl, title, textLength, clickable,
      problems, platformFault,
      // The narrative and the raw buffers both: the first is what a person reads, the second is what
      // a fixer needs in order to work on evidence instead of on a description of evidence.
      summary: d.summary,
      diagnostics: d,
    });
  } catch (e) {
    fail(res, e);
  } finally {
    /*
     * ALWAYS hand the browser back. This is the whole bargain — a check cheap enough to run on every
     * build only stays cheap if it cannot leak a session, including when it throws.
     */
    if (sessionId) { try { await pool.close(sessionId, 'smoke check finished'); } catch { /* already gone */ } }
  }
});

/*
 * DOM PROBE — a diagnostic for "the reader sees 0 things to click on a page that clearly has controls".
 * Opens the given LOGGED-IN profile (so it sees the real app, not a login wall), navigates, and dumps,
 * per frame, the signal breakdown the inspector keys on plus a sample of labelled elements it did NOT
 * match — which is exactly what tells whether a control is a custom element, in a cross-origin frame,
 * or carries no detectable signal. Read-only; hands the session back untouched (does not close it).
 */
const DOM_DUMP = () => {
  const cs = (e) => { try { return getComputedStyle(e); } catch { return {}; } };
  const q = (sel) => { try { return document.querySelectorAll(sel).length; } catch { return -1; } };
  const label = (e) => ((e.getAttribute && e.getAttribute('aria-label')) || e.textContent || '').trim().replace(/\s+/g, ' ');
  const NATIVE = 'button,a[href],input,textarea,select,[role],[onclick]';
  const els = [...document.querySelectorAll('*')];
  const texted = els.filter((e) => { const t = label(e); if (!t || t.length > 50) return false; const r = e.getBoundingClientRect(); return r.width >= 8 && r.height >= 8; });
  const unmatched = texted.filter((e) => { try { return !e.matches(NATIVE); } catch { return false; } }).slice(0, 30).map((e) => ({
    tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || null, ti: e.getAttribute('tabindex') || null,
    js: e.getAttribute('jsaction') ? 1 : 0, cur: (cs(e).cursor || '').slice(0, 10),
    cls: (typeof e.className === 'string' ? e.className : '').slice(0, 40), text: label(e).slice(0, 28),
  }));
  return {
    total: els.length, bodyText: ((document.body && document.body.innerText) || '').trim().length,
    native: q(NATIVE), button: q('button'), roleBtn: q('[role="button"]'), jsaction: q('[jsaction]'), tabindex0: q('[tabindex="0"]'), pointerSample: els.filter((e) => cs(e).cursor === 'pointer').length,
    customTags: [...new Set(els.filter((e) => e.tagName.includes('-')).map((e) => e.tagName.toLowerCase()))].slice(0, 25),
    unmatched,
  };
};
app.post('/v1/debug/inspect', authed, async (req, res) => {
  try {
    const profile = profiles.safeName(String((req.body && req.body.profile) || ''));
    const url = String((req.body && req.body.url) || '').trim();
    if (!profile) return res.status(400).json({ error: 'profile required' });
    if (url) await assertPublicUrl(url);
    const owner = req.client.owner, cap = Number(process.env.MAX_CONTEXTS) || 8;
    let s = pool.listFor(owner).find((x) => x.profile === profile);
    s = s ? pool.get(s.sessionId) : pool.get((await pool.createSession({ owner, maxConcurrent: cap, profile, takeover: true })).sessionId);
    const page = s.page;
    if (url) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { /* report what loaded anyway */ } }
    await new Promise((r) => setTimeout(r, Number(req.body && req.body.settleMs) || 5000));
    const frames = [];
    for (const f of page.frames()) {
      const info = { url: String(f.url()).slice(0, 120) };
      try { info.dump = await f.evaluate(DOM_DUMP); } catch (e) { info.blocked = String(e.message || e).slice(0, 90); }
      frames.push(info);
    }
    res.json({ profile, finalUrl: page.url(), title: await page.title().catch(() => ''), frameCount: frames.length, frames });
  } catch (e) { fail(res, e); }
});

/*
 * FILES — every generated asset across ALL sessions, so nothing is lost and the owner can actually
 * SEE it. The factory conveyor (voiceover, music, per-scene clips, images, screen recordings) all
 * lands in the cross-session store; this is the window onto it. /v1/files is the metadata list;
 * /v1/files/:id/raw streams the bytes so an <img>/<video>/<audio> can show it. The raw route also
 * accepts ?key= so a media element (which cannot send a Bearer header) still authenticates when the
 * console is key-based rather than cookie-based.
 */
function mediaAuth(req, res, next) {
  const qk = req.query.key ? String(req.query.key) : '';
  if (qk && keys.get(qk)) { const k = keys.get(qk); req.client = { owner: '_media', plan: k.plan, maxConcurrent: k.maxConcurrent }; return next(); }
  return authed(req, res, next);
}
/*
 * PUTTING A FILE ON THE SHELF FROM OUTSIDE.
 *
 * The shelf could only be filled from INSIDE a walk — something the agent downloaded or drew. So a
 * brand's real logo, which lives in Crest and never passes through a browser, had no way onto a
 * page: the set-up walk drew a mark or generated one, and a brand whose face is invented per surface
 * is not a brand.
 *
 * This is the same conveyor the walks already use, with a loading door. An organ posts the bytes and
 * gets the id back; the walk that runs next uploads it by that id, exactly as it would one it made
 * itself. Nothing else about the shelf changes.
 */
app.post('/v1/files', authed, express.json({ limit: '12mb' }), (req, res) => {
  const b = req.body || {};
  const raw = String(b.dataUrl || b.bytes || '');
  const m = raw.match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
  const mime = String(m ? m[1] : (b.mime || '')).toLowerCase();
  if (!/^image\/|^video\/|^audio\/|^application\/pdf$/.test(mime)) {
    return res.status(400).json({ error: 'send a data URL, or base64 bytes with an image/video/audio/pdf mime' });
  }
  let bytes; try { bytes = Buffer.from(m ? m[2] : raw, 'base64'); } catch { bytes = null; }
  if (!bytes || !bytes.length) return res.status(400).json({ error: 'that did not decode to any bytes' });
  if (bytes.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'that file is over 10 MB' });
  /* `kind` is what upload_image asks for when it is given no id — a picture put here as the profile
     is the one a walk uploads when it is told to use the prepared profile picture. */
  const id = fileAssets.put({ kind: String(b.kind || 'image'), mime, name: b.name || null, source: b.source || 'organ', bytes });
  if (!id) return res.status(500).json({ error: 'the file could not be stored' });
  log.info?.(`[files] ${req.client.owner} put ${Math.round(bytes.length / 1024)} KB (${mime}) on the shelf as ${id}${b.kind ? ` for ${b.kind}` : ''}`);
  res.status(201).json({ id, kind: b.kind || 'image', mime, bytes: bytes.length });
});
app.get('/v1/files', authed, (_req, res) => {
  const files = fileAssets.list().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  res.json({ files, total: files.length, bytes: files.reduce((n, f) => n + (f.size || 0), 0) });
});
app.get('/v1/files/:id/raw', mediaAuth, (req, res) => {
  const f = fileAssets.get(req.params.id);
  if (!f || !f.bytes) return res.status(404).json({ error: 'no such file' });
  res.set('Content-Type', f.mime || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=600');
  res.set('Accept-Ranges', 'bytes');   // lets a <video> seek
  if (req.query.download) res.set('Content-Disposition', `attachment; filename="${String(f.name || f.id).replace(/[^\w.\-]/g, '_')}"`);
  res.send(f.bytes);
});
app.delete('/v1/files/:id', authed, (req, res) => {
  res.json({ removed: fileAssets.remove ? fileAssets.remove(req.params.id) : false });
});


app.get('/v1/sessions/:id', (req, res) => {
  try {
    const s = pool.get(req.params.id);
    res.json({
      sessionId: s.id, url: s.page.url(), createdAt: s.createdAt, lastUsed: s.lastUsed,
      expiresAt: s.createdAt + LIMITS.ttlMs,
    });
  } catch (e) { fail(res, e); }
});

/*
 * THE PERSON WHOSE BROWSER THIS IS CAN CLOSE ANYTHING IN IT.
 *
 * A key may only close what it opened — that part was always right, and it stays. But the CONSOLE is
 * the signed-in owner of this install, and refusing them was a rule with no one behind it: the
 * owner sat watching a Google login parked on a sign-in page, needing to sign in, unable to take the
 * session because it had been opened by an organ's key. "Not your session" — in their own browser,
 * on their own machine, by a tool they installed.
 *
 * A job left holding a session it has finished with cannot be argued with. The owner can.
 */
app.delete('/v1/sessions/:id', async (req, res) => {
  try {
    const s = pool.get(req.params.id);
    if (s.owner !== req.client.owner && !req.client.console) return res.status(403).json({ error: 'not your session' });
    const by = req.client.console && s.owner !== req.client.owner ? `closed by ${req.client.owner} (the owner of this browser)` : 'closed by client';
    await pool.close(req.params.id, by);
    res.json({ closed: true, by });
  } catch (e) { fail(res, e); }
});

/** A session belongs to the key that opened it — checked on every call, not just on close. */
function mine(req) {
  const s = pool.get(req.params.id);
  if (s.owner !== req.client.owner) throw Object.assign(new Error('not your session'), { status: 403 });
  return s;
}

// ── Navigation ──────────────────────────────────────────────────────────────────────────
app.post('/v1/sessions/:id/navigate', async (req, res) => {
  try {
    const s = mine(req);
    const target = String(req.body?.url || '');
    await assertPublicUrl(target);

    const r = await s.page.goto(target, { waitUntil: req.body?.waitUntil || 'domcontentloaded', timeout: NAV_TIMEOUT });

    /*
     * RE-CHECK AFTER THE FACT. A public URL that redirects to a private one defeats a check done
     * only before the request, and that is the standard way this class of guard is bypassed. If we
     * have landed somewhere we should not be, the page is emptied before anything can read it.
     */
    const landed = s.page.url();
    if (landed !== target) {
      try { await assertPublicUrl(landed); }
      catch (e) {
        await s.page.goto('about:blank').catch(() => {});
        return res.status(403).json({ error: `redirected to a private address and was stopped (${e.message})` });
      }
    }
    res.json({ url: landed, status: r ? r.status() : null, title: await s.page.title().catch(() => '') });
  } catch (e) { fail(res, e); }
});

// ── Set-of-Mark: the reason any of this works ───────────────────────────────────────────
app.get('/v1/sessions/:id/analyze', async (req, res) => {
  try {
    const s = mine(req);
    const analysis = await analyzePage(s.page);
    // Kept so a click by index has something to resolve against, with the url and scroll position
    // it was taken at — a click against a stale analysis is a click in the wrong place.
    s.lastAnalysis = {
      elements: analysis.elements,
      url: analysis.url,
      scrollY: await s.page.evaluate(() => window.scrollY).catch(() => 0),
    };
    const withShot = req.query.screenshot !== 'false';
    res.json({
      url: analysis.url, title: analysis.title, elementCount: analysis.elementCount,
      elements: analysis.elements, summary: analysis.summary,
      screenshot: withShot ? analysis.screenshot : null,
    });
  } catch (e) { fail(res, e); }
});

app.post('/v1/sessions/:id/click', async (req, res) => {
  try {
    const s = mine(req);
    const { index, text } = req.body || {};

    if (text) {
      const el = s.page.getByText(String(text), { exact: false }).first();
      await el.click({ timeout: 10000 });
      return res.json({ clicked: { text }, url: s.page.url() });
    }

    if (!s.lastAnalysis) {
      return res.status(409).json({ error: 'analyze the page before clicking — the numbers come from that' });
    }
    /*
     * If the page moved since the analysis, the numbers refer to a layout that no longer exists.
     * Re-analysing silently is the right answer: the caller asked to click a thing, not to click
     * coordinates, and failing here would just make them do this themselves.
     */
    const scrollY = await s.page.evaluate(() => window.scrollY).catch(() => 0);
    if (s.page.url() !== s.lastAnalysis.url || Math.abs(scrollY - s.lastAnalysis.scrollY) > 40) {
      const fresh = await analyzePage(s.page);
      s.lastAnalysis = { elements: fresh.elements, url: fresh.url, scrollY };
    }
    const target = await bringIntoView(s.page, await clickByIndex(s.page, Number(index), s.lastAnalysis.elements));
    await s.page.mouse.click(target.x, target.y);
    await s.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    res.json({ clicked: { index: Number(index), text: target.text }, url: s.page.url() });
  } catch (e) { fail(res, e); }
});

// Scroll a target to mid-viewport if it is off-screen, so a coordinate action actually lands on it
// (the same fix the agent uses for long forms). Mutates and returns the target with a usable y.
async function bringIntoView(page, target) {
  const vh = await page.evaluate(() => window.innerHeight).catch(() => 800);
  if (target.y < 40 || target.y > vh - 40) {
    await page.mouse.wheel(0, target.y - Math.round(vh / 2));
    await new Promise((r) => setTimeout(r, 500));
    target.y = Math.round(vh / 2);
  }
  return target;
}
// Re-analyse when the page moved since the last look, so an index still names the thing the caller meant.
async function freshIfMoved(s) {
  const scrollY = await s.page.evaluate(() => window.scrollY).catch(() => 0);
  if (!s.lastAnalysis || s.page.url() !== s.lastAnalysis.url || Math.abs(scrollY - s.lastAnalysis.scrollY) > 40) {
    const fresh = await analyzePage(s.page);
    s.lastAnalysis = { elements: fresh.elements, url: fresh.url, scrollY };
  }
}

app.post('/v1/sessions/:id/type', async (req, res) => {
  try {
    const s = mine(req);
    const { index, text = '', submit = false, paste = false, clear = true } = req.body || {};
    if (!s.lastAnalysis) return res.status(409).json({ error: 'analyze the page first' });
    await freshIfMoved(s);
    const target = await bringIntoView(s.page, await clickByIndex(s.page, Number(index), s.lastAnalysis.elements));
    // Focus the field; triple-click selects its own content so a re-type REPLACES rather than appends.
    await s.page.mouse.click(target.x, target.y, clear ? { clickCount: 3 } : {});
    if (paste) {
      // insertText fires the input events a RICH editor (markdown/contenteditable/React) needs, which
      // keyboard.type into a hidden backing textarea does not — this is why a bio/markdown box now fills.
      await s.page.keyboard.press('Control+A').catch(() => {});
      await s.page.keyboard.insertText(String(text));
    } else {
      await s.page.keyboard.type(String(text), { delay: 45 + Math.floor(Math.random() * 55) });
    }
    if (submit) {
      await s.page.keyboard.press('Enter');
      await s.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    }
    res.json({ typed: String(text).length, into: target.text, mode: paste ? 'paste' : 'type', url: s.page.url() });
  } catch (e) { fail(res, e); }
});

/*
 * DRIVING IT BY HAND.
 *
 * Set-of-Mark is how the AGENT acts, and it is the right interface for a model. It is the wrong one
 * for a person facing a cookie wall, a captcha or a login: those need "click exactly there", and
 * half the time the thing to click is not in the element list at all — a canvas, an image tile, a
 * custom widget that answers to no role.
 *
 * So the console gets raw input as well: viewport coordinates, keystrokes and scroll, relayed
 * straight to the page. Poor-man's remote desktop, and enough to get through the thing that is
 * blocking the agent — which is the only reason a human is here.
 */
app.post('/v1/sessions/:id/mouse', async (req, res) => {
  try {
    const s = mine(req);
    const x = Number(req.body?.x); const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x and y required' });
    const action = String(req.body?.action || 'click');
    if (action === 'move') await s.page.mouse.move(x, y);
    else if (action === 'dblclick') await s.page.mouse.dblclick(x, y);
    else {
      // Move first, then click. A click with no preceding movement is one of the cheaper automation
      // tells, and it costs nothing to not give it away.
      await s.page.mouse.move(x, y, { steps: 6 });
      await s.page.mouse.click(x, y);
      // Active tab, so the keystrokes that usually follow a click on a field actually arrive.
      await s.page.bringToFront().catch(() => {});
    }
    await s.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    res.json({ url: s.page.url() });
  } catch (e) { fail(res, e); }
});

/*
 * TYPING, WHICH IS HARDER THAN IT LOOKS IN A HEADLESS BROWSER.
 *
 * Clicking a field focused it — the outline appeared — and then every keystroke went nowhere. In
 * headless Chromium a page that is not the active tab does not receive key events, and a persistent
 * context opens with pages that are not necessarily active, so `keyboard.type` succeeded and typed
 * into nothing at all. Silently: no error, no text.
 *
 * Three things fix it, in order of how often they are the answer:
 *
 *   1. bringToFront() — make the page the active tab before sending keys. Usually enough.
 *   2. Refocus the element the click landed on. A screenshot round-trip takes a second or two, and
 *      pages steal focus back in that time.
 *   3. If the value still has not changed, set it through the DOM with the NATIVE setter and fire
 *      the events a framework listens for. React tracks its own copy of an input's value and
 *      ignores a plain assignment, which is why the naive version of this fallback works
 *      everywhere except the React sites people actually want to automate — Facebook included.
 *
 * And it VERIFIES. The whole reason this was confusing is that typing failed without saying so, so
 * the response now reports what it typed into and whether the field actually changed.
 */
app.post('/v1/sessions/:id/keys', async (req, res) => {
  try {
    const s = mine(req);
    await s.page.bringToFront().catch(() => {});

    if (req.body?.key) {
      await s.page.keyboard.press(String(req.body.key));
      await s.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return res.json({ url: s.page.url(), pressed: req.body.key });
    }

    const text = String(req.body?.text || '');
    const describe = () => s.page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        name: el.getAttribute('name') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || null,
        value: 'value' in el ? String(el.value || '') : (el.textContent || ''),
      };
    }).catch(() => null);

    const before = await describe();
    if (!before) {
      return res.status(409).json({ error: 'nothing is focused — click the field on the page first' });
    }

    await s.page.keyboard.type(text, { delay: 45 + Math.floor(Math.random() * 55) });
    let after = await describe();

    // Did anything actually land?
    if (after && after.value === before.value && text) {
      /*
       * The React-safe fallback. Assigning `el.value` directly updates the DOM but not React's
       * internal record of it, so React re-renders the old value straight back and the field looks
       * untouched. Going through the prototype's native setter is what makes React notice.
       */
      const ok = await s.page.evaluate((t) => {
        const el = document.activeElement;
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (!setter) { el.textContent = t; return true; }
        setter.call(el, (el.value || '') + t);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, text).catch(() => false);
      if (ok) after = await describe();
    }

    await s.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    res.json({
      url: s.page.url(),
      into: before.name || `${before.tag}${before.type ? '[' + before.type + ']' : ''}`,
      // Never echo what was typed — this field is very often a password.
      changed: !!(after && after.value !== before.value),
      length: after ? after.value.length : 0,
    });
  } catch (e) { fail(res, e); }
});

app.post('/v1/sessions/:id/scroll', async (req, res) => {
  try {
    const s = mine(req);
    await s.page.mouse.wheel(0, Number(req.body?.dy) || 400);
    res.json({ url: s.page.url() });
  } catch (e) { fail(res, e); }
});

/** The profiles that exist on disk — the logins built up so far. */
app.get('/v1/profiles', (_req, res) => res.json({ profiles: pool.listProfiles() }));

/*
 * THE SITES THIS BROWSER KNOWS, and whether a login already exists for each.
 *
 * A profile used to be named by hand and labelled by hand, and the agent finds the right account BY
 * that label — so an unlabelled one is invisible to it: the login exists, the agent says it has
 * none, and neither half looks broken. Getting it wrong was silent. These cannot be typed wrongly
 * because there is nothing to type.
 */
require('./device-hub').mountDeviceHub(app, authed); // reverse (poll) channel for GB Mobile devices

// --- On-device run journals (S1). A flow executed LOCALLY on a phone/desktop node POSTs its journal
// here over the authed SSO API (no control channel needed), so on-device runs are visible in the shared
// history alongside cluster runs. One JSON file per run on the same /profiles volume. ---
const _devRunsDir = require('path').join(process.env.PROFILE_DIR || '/profiles', 'device-runs');
app.post('/v1/device-runs', authed, (req, res) => {
  try {
    const fs = require('fs'), path = require('path');
    fs.mkdirSync(_devRunsDir, { recursive: true });
    const b = req.body || {};
    const id = String(b.id || (b.flowId || 'run') + '-' + Date.now()).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const rec = {
      id, deviceId: String(b.deviceId || ''), deviceName: String(b.deviceName || ''), target: String(b.target || ''),
      flowId: String(b.flowId || ''), flowName: String(b.flowName || ''), goal: String(b.goal || '').slice(0, 4000),
      steps: Array.isArray(b.steps) ? b.steps.slice(0, 500) : [], outcome: String(b.outcome || '').slice(0, 400),
      status: String(b.status || 'done'), startedAt: Number(b.startedAt) || Date.now(), endedAt: Number(b.endedAt) || Date.now(),
      owner: (req.client && req.client.owner) || '', savedAt: Date.now(),
    };
    fs.writeFileSync(path.join(_devRunsDir, id + '.json'), JSON.stringify(rec, null, 2), { mode: 0o600 });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});
app.get('/v1/device-runs', authed, (req, res) => {
  try {
    const fs = require('fs'), path = require('path');
    let names = []; try { names = fs.readdirSync(_devRunsDir).filter((f) => f.endsWith('.json')); } catch (e) {}
    const runs = names.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(_devRunsDir, f), 'utf8')); } catch (e) { return null; } })
      .filter(Boolean).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 100);
    res.json({ runs });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});
app.get('/v1/profiles/presets', authed, (_req, res) =>
  // Detailed, so a login labelled for a site counts even when it is called something else.
  res.json({ presets: sites.list(pool.listProfilesDetailed()) }));

/*
 * AUTHOR A SITE AS DATA. sites/index.js ships the sites we know; this lets the owner add one with a
 * login URL and (if any exist) the roles to attach. It MERGES into the preset list above, so the new
 * site opens and configures itself through the exact same path as a shipped preset — nothing
 * downstream changes. This is profiles-as-data, the twin of roles-as-data.
 */
app.post('/v1/profiles/custom', authed, (req, res) => {
  try { res.status(201).json({ site: userSites.create(req.body || {}) }); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

/* Change the roles attached to an authored site — the part most likely to change after it exists. */
app.put('/v1/profiles/custom/:key/roles', authed, (req, res) => {
  const updated = userSites.setRoles(req.params.key, (req.body && req.body.roles) || []);
  if (!updated) return res.status(404).json({ error: 'no such site' });
  res.json({ site: updated });
});

/* Forget an authored site. Its saved login (if any) is left alone — remove that from its card. */
app.delete('/v1/profiles/custom/:key', authed, (req, res) => {
  res.json({ removed: userSites.remove(req.params.key) });
});

/*
 * THE PLATFORM REGISTRY — what a platform IS and how it may be worked, held here because this is
 * where the logins live. Herald and LeadFlow read it instead of each carrying their own copy of the
 * same constants (see src/platforms.js for why that mattered). Every record carries its live login
 * state, so one call answers both "what are the rules here" and "am I even signed in".
 */
app.get('/v1/platforms', authed, (_req, res) => {
  try { res.json({ platforms: platforms.withLogins(pool.listProfilesDetailed()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* Change one platform's rules without a deploy. Unsafe and unknown fields are dropped, not obeyed. */
app.put('/v1/platforms/:key', authed, (req, res) => {
  try { res.json({ platform: platforms.override(req.params.key, req.body || {}) }); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

/* Back to what shipped. */
app.delete('/v1/platforms/:key/override', authed, (req, res) => {
  res.json({ reset: platforms.reset(req.params.key) });
});

/*
 * WHAT HAPPENED HERE. A walk that ran, or a platform that pushed back — Herald already recognises a
 * rate-limit and backs off for hours; recording it here is what lets the Platforms tab say "Reddit
 * asked us to slow down at 14:20" instead of leaving an owner to wonder why nothing is being read.
 */
app.post('/v1/platforms/:key/note', authed, (req, res) => {
  const b = req.body || {};
  const h = platforms.note(req.params.key, { used: !!b.used, refusedWhy: b.refusedWhy || b.why || '' });
  if (!h) return res.status(400).json({ error: 'which platform?' });
  res.json({ noted: h });
});

/*
 * CONNECTORS — external APIs the owner connects as DATA, so a customer's system (their vector DB, CRM,
 * knowledge base) needs no per-customer tool code. A generic tool (knowledge_query/store) resolves a
 * named connector at call time. list() never returns the key; the in-process tool reads it via get().
 */
app.get('/v1/connectors', authed, (_req, res) => res.json({ connectors: connectors.list() }));
app.post('/v1/connectors', authed, (req, res) => {
  try { res.json(connectors.create(req.body || {})); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.delete('/v1/connectors/:key', authed, (req, res) => res.json({ removed: connectors.remove(req.params.key) }));

/* Remove a login and everything in it. Refused while it is open. */
app.delete('/v1/profiles/:name', authed, async (req, res) => {
  try { res.json({ removed: await pool.removeProfile(req.params.name) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/*
 * HOW A PROFILE PRESENTS ITSELF: where it exits, what time it thinks it is, what language it
 * speaks. Kept per profile because they have to AGREE with each other — the Facebook login was
 * fighting a browser on Amsterdam time arriving from a Finnish datacentre, which is a mismatch no
 * amount of fingerprint patching hides.
 */
app.get('/v1/profiles/:name/settings', authed, (req, res) => {
  res.json(profiles.redacted(req.params.name));
});

app.put('/v1/profiles/:name/settings', authed, async (req, res) => {
  try {
    const saved = profiles.write(req.params.name, req.body || {});
    /*
     * Most of these settings — timezone, locale, the proxy — are fixed when the browser context is
     * created and genuinely cannot change under a running session.
     *
     * The passkey refusal is the exception, and it is the one that matters most in the moment: it
     * is turned on BECAUSE a page is stuck right now. Telling someone to reopen the session is both
     * useless (they come back to the same stuck page) and costly (they are mid-login). So apply it
     * to their open sessions on this profile and reload, and report which ones.
     */
    let applied = [];
    if (saved.blockPasskeys) {
      applied = await pool.applyPasskeyRefusal(req.client.owner, profiles.safeName(req.params.name));
    }
    // Never echo the password back.
    res.json({ ...profiles.redacted(req.params.name), appliedTo: applied.length,
      note: saved.blockPasskeys
        ? (applied.length
            ? `Applied now — reloaded ${applied.length} open session${applied.length > 1 ? 's' : ''}. You stay logged in; only the page reloads.`
            : 'Saved. It applies the next time this profile is opened.')
        : 'Saved. Allowing passkeys again needs a fresh session — an injected refusal cannot be taken back out of a running one.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/*
 * ── THE AGENT ───────────────────────────────────────────────────────────────────────────
 *
 * A job is "go and do this in the browser I am already logged into". Everything below is either
 * setting that up, watching it, or answering it when it asks permission.
 *
 * All of it is gated on the console account rather than an API key. A key is a credential that
 * travels in scripts; starting something that will comment under someone's name, and approving what
 * it says, are acts of the person themselves.
 */

/* The specialists a conversation can be given, so a UI never has to know their names. */
app.get('/v1/agent/roles', authed, (_req, res) => res.json({ roles: roles.list() }));

/*
 * ── AUTHORING ROLES — the marketplace's server side ─────────────────────────────────────────────
 * A role is data now: a person can write one, an AI can draft one, and a pack can carry a set of
 * them between installs. Everything below is strictly additive to the built-ins and gated on the
 * same console account as the rest of /v1/agent — and none of it can widen what the agent may DO,
 * only what it may reach for, because the act gate is elsewhere and unchanged.
 */

// The tools a role may be given, grouped and described, sourced from the agent's own declarations so
// this list can never drift from what the agent actually offers.
const TOOL_GROUPS = [
  { group: 'Getting around', names: roles.HANDS },
  { group: 'Accounts', names: roles.LOGINS },
  { group: 'Conversations', names: roles.CONVERSATION },
  { group: 'Finding things', names: ['sweep', 'google', 'dig'] },
  { group: 'Saving what it finds', names: ['save_lead', 'save_gig', 'save_reply', 'save_reach', 'save_keywords', 'save_search', 'save_gsc_token', 'save_opportunity'] },
  { group: 'Images', names: ['make_brand_image', 'upload_image', 'download_image'] },
  { group: 'Your voice', names: ['remember_about_me', 'save_my_writing', 'describe_my_voice'] },
  { group: 'Diagnostics', names: ['diagnostics'] },
];
const paletteNames = () => agent.TOOLS.map((t) => t.function && t.function.name).filter(Boolean);

/*
 * WHAT HANDS THIS BROWSER ACTUALLY HAS. A Workshop build announced "I see http-request is available"
 * — it was not, and it spent its budget on a tool that never existed. A role is composed from this
 * list, so the list has to be readable by whoever composes one.
 */
app.get('/v1/agent/tools', authed, (_req, res) => {
  res.json({ tools: agent.TOOLS.map((t) => t.function).filter(Boolean).map((f) => ({
    name: f.name,
    description: String(f.description || '').slice(0, 400),
    takes: Object.keys((f.parameters && f.parameters.properties) || {}),
  })) });
});
function toolPalette() {
  const groupOf = {};
  for (const g of TOOL_GROUPS) for (const n of g.names) groupOf[n] = g.group;
  return agent.TOOLS
    .filter((t) => t.function && t.function.name)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      group: groupOf[t.function.name] || 'Other',
      // `act` is the only tool that performs a visible action, and it stops for the owner every time.
      // Flagged so a builder UI can say so, not because listing it is any less safe.
      gated: t.function.name === 'act',
    }));
}
app.get('/v1/agent/tools', authed, (_req, res) => res.json({ tools: toolPalette() }));

/*
 * Draft a role from a plain description. The model is asked for JSON only, and whatever it returns is
 * COERCED against the real palette before it is handed back — an invented tool is dropped, not saved,
 * so the suggestion can never be worse than a blank form. It does NOT persist: it fills the form, the
 * person reviews it, and saving is a separate, deliberate act.
 */
app.post('/v1/agent/roles/suggest', authed, async (req, res) => {
  const desc = String(req.body && req.body.description || '').trim();
  if (desc.length < 8) return res.status(400).json({ error: 'Describe what the role should do — a sentence or two.' });
  const cur = settingsStore.read();
  const key = cur.llmKey || String(cur.llmKeys || '').split(/[\s,]+/).filter(Boolean)[0] || null;
  const names = paletteNames();
  const sys = [
    'You design a role for an agent that operates a real web browser on the owner\'s behalf.',
    'Reply with ONE JSON object and nothing else: {"label","site","description","tools","prompt"}.',
    'label: a short human name, e.g. "Reddit · Complaint scout".',
    'site: exactly one of facebook, linkedin, google, reddit, x, youtube, instagram — or null if it works across sites.',
    'description: one sentence a non-technical owner would understand.',
    'tools: an array chosen ONLY from this exact list (use the fewest that do the job): ' + names.join(', ') + '.',
    'Always include the basics look, read, open, click, type, scroll, back, note, finish and the accounts tools list_profiles, use_profile. Include act ONLY if the role must post, send, comment, like or connect — and know that every act still asks the owner first.',
    'prompt: the playbook — plain, direct instructions telling the agent exactly what its job is and, just as importantly, what it must NOT do. Address it as "you". Several short paragraphs.',
  ].join('\n');
  try {
    const out = await llm.chat({ host: cur.llmHost, model: cur.llmModel, key, messages: [
      { role: 'system', content: sys },
      { role: 'user', content: desc },
    ] });
    res.json(userRoles.coerceDraft(out.content, names));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || 'The AI model could not be reached — check it under Settings.' });
  }
});

/*
 * Share a set of roles as one pack, and install one someone shares back. A pack that names a tool
 * this build does not have is refused WHOLE — half an install is worse than none.
 */
app.get('/v1/agent/roles/export', authed, (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.json(userRoles.exportPack(ids, req.query.name));
});
app.post('/v1/agent/roles/import', authed, (req, res) => {
  try { res.json({ installed: userRoles.importPack(req.body || {}, paletteNames()) }); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// One full role by name — the builder reads it to CLONE a built-in (which needs its playbook, not
// just the summary the list carries). Registered AFTER /roles/export so ':id' never eats that word.
app.get('/v1/agent/roles/:id', authed, (req, res) => {
  const key = String(req.params.id || '').toLowerCase();
  const canonical = roles.canonical(key);
  if (key !== 'general' && canonical === 'general') return res.status(404).json({ error: 'No such role.' });
  const r = roles.get(key);
  res.json({ name: canonical, builtin: !!roles.ROLES[canonical], site: r.site || null, group: r.group || null, label: r.label, description: r.description, tools: r.tools === undefined ? null : r.tools, prompt: r.prompt || '' });
});

/*
 * ── AUTOMATION WORKFLOWS — the canvas' engine ────────────────────────────────────────────────────
 * An automation is a stored line of steps; running one dispatches ordinary agent jobs, one per agent
 * step, on the profile that step names, and feeds each step's saved records into the next step's goal.
 * Everything here is additive and isolated: a workflow run uses the same jobs/pool/act-gate machinery
 * everything else does, so a broken automation fails its own run and touches nothing else.
 */
const wfRoleNames = () => roles.list().map((r) => r.name);
const pruneOut = (o) => { const out = {}; for (const k of Object.keys(o)) { const v = o[k]; if (Array.isArray(v) ? v.length : v != null) out[k] = v; } return out; };

// Run ONE agent step: open (or reuse) a session on its profile, dispatch its role+goal exactly as the
// jobs API does, wait for it to finish, and return the records it saved as this step's output.
const record = require('./tools/record');

/*
 * Run ONE verify step: open (or reuse) the profile's session, go to the URL, and read the page back
 * for the text — the act gate's own confirmation, as a step. No model, no act, nothing typed.
 */
function makeRunVerify(client) {
  const owner = client.owner;
  const maxConcurrent = Math.max(client.maxConcurrent || 2, Number(process.env.MAX_CONTEXTS) || 8);
  return async ({ node, url, text, signIn = false }) => {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error(signIn ? 'a sign-in check needs an http(s) url' : 'a verify step needs an http(s) url');
    const want = node.profile ? profiles.safeName(node.profile) : '';
    let s = want ? pool.listFor(owner).find((x) => x.profile === want) : null;
    if (s) s = pool.get(s.sessionId);
    if (!s) { const o = await pool.createSession({ owner, maxConcurrent, profile: want || undefined, takeover: true }); s = pool.get(o.sessionId); }
    try { await s.page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { throw new Error(`could not open ${url}: ${e.message}`); }
    /* A sign-in check answers a different question about the same page, and never types anything. */
    if (signIn) {
      let wall = false;
      try { wall = await s.page.evaluate(agent.loginWall); } catch { wall = false; }
      if (!want) { try { await pool.close(s.id, 'sign-in check finished'); } catch { /* best effort */ } }
      return { signedIn: !wall };
    }
    /*
     * A VERIFY STEP ASKS WHETHER THE PAGE SAYS THIS — it does not ask whether a comment landed, which
     * is what confirmPosted answers and why it refuses anything under 40 characters. Asking the wrong
     * function made every short proof ("PLN", a page heading) permanently unverifiable, so no flow
     * could ever be filed in the library.
     */
    const found = await agent.pageHasText(s.page, String(text));
    if (!want) { try { await pool.close(s.id, 'verify step finished'); } catch { /* best effort */ } }
    return { found: found === true };
  };
}

/*
 * A `fetch` STEP: one GET, in this browser's own session, with no model anywhere near it.
 *
 * Every reading step used to be an agent step, and the model is what a run costs — one Workshop
 * build spent 2.97M tokens and produced nothing, and four of them exhausted a weekly allowance.
 * A JSON feed or a listing page is a request, not a judgement, so this performs it directly:
 * Playwright's request API shares the context's cookies, so a logged-in feed answers exactly as it
 * would in the page, and nothing has to be navigated away from.
 *
 * GET only. A step that cannot act needs no approval gate, and that is the whole reason it may run
 * unattended, every hour, for nothing.
 */
function makeRunFetch(client) {
  const owner = client.owner;
  const maxConcurrent = Math.max(client.maxConcurrent || 2, Number(process.env.MAX_CONTEXTS) || 8);
  /** Walk a dot path into parsed JSON ("data.children.0.title"); undefined when it leads nowhere. */
  const pickPath = (value, path) => (!path ? value
    : String(path).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), value));
  return async ({ node, url, pick }) => {
    const want = node.profile ? profiles.safeName(node.profile) : '';
    let s = want ? pool.listFor(owner).find((x) => x.profile === want) : null;
    if (s) s = pool.get(s.sessionId);
    if (!s) { const o = await pool.createSession({ owner, maxConcurrent, profile: want || undefined, takeover: true }); s = pool.get(o.sessionId); }
    let status = 0, ctype = '', body = '';
    try {
      const rq = s.context && s.context.request;
      if (!rq) throw new Error('this browser has no request context');
      const r = await rq.get(String(url), { timeout: 30000, failOnStatusCode: false });
      status = r.status(); ctype = String((r.headers() || {})['content-type'] || '');
      body = await r.text();
    } finally {
      /* A throwaway session is closed the moment the step ends — a chain of fetches must not leave
         a trail of open browsers behind it. A named profile stays: it is where the login lives. */
      if (!want) { try { await pool.close(s.id, 'fetch step finished'); } catch { /* best effort */ } }
    }
    let shape = (ctype.split(';')[0] || 'text').trim();
    if (/json/i.test(ctype) || /^\s*[[{]/.test(body)) {
      try {
        const parsed = JSON.parse(body);
        const picked = pick ? pickPath(parsed, pick) : parsed;
        if (pick && picked === undefined) {
          const keys = (parsed && typeof parsed === 'object' ? Object.keys(parsed) : []).slice(0, 30).join(', ');
          throw new Error(`the path "${String(pick).slice(0, 80)}" does not lead anywhere in that JSON. Its top-level keys are: ${keys || '(not an object)'}`);
        }
        body = JSON.stringify(picked, null, 1);
        shape = 'json' + (pick ? ` at ${pick}` : '');
      } catch (e) {
        if (pick) throw e;          // a stated path that does not exist is a defect, not a shrug
        /* not JSON after all — hand back the text exactly as it came */
      }
    }
    return { status, shape, body };
  };
}

/*
 * A `script` STEP: open one page as the profile, run one read-only script in it, return its value.
 * No model anywhere. This is what makes a repeat read of a rendered, cookied page free — the case
 * fetch cannot serve (useme answers a plain request with 403) and an agent step serves at fourteen
 * model calls a time. The script is held to run_script's own refusal list, so it can only read.
 */
function makeRunScript(client) {
  const owner = client.owner;
  const maxConcurrent = Math.max(client.maxConcurrent || 2, Number(process.env.MAX_CONTEXTS) || 8);
  const { scriptRefusal } = require('./agent');
  const { dismissConsent, settle } = require('./inspector');
  return async ({ node, url, script }) => {
    const no = scriptRefusal(script);
    if (no) throw new Error(`the script step was refused: ${no}`);
    const want = node.profile ? profiles.safeName(node.profile) : '';
    let s = want ? pool.listFor(owner).find((x) => x.profile === want) : null;
    if (s) s = pool.get(s.sessionId);
    if (!s) { const o = await pool.createSession({ owner, maxConcurrent, profile: want || undefined, takeover: true }); s = pool.get(o.sessionId); }
    try {
      try { await s.page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 45000 }); }
      catch (e) { throw new Error(`could not open ${url}: ${e.message}`); }
      try { await dismissConsent(s.page); } catch { /* no banner is the normal case */ }
      /* An app-style page renders after load and may redirect: a probe of olx.pl/adding/ at domcontentloaded
         returned an empty shell with one iframe. Settle first, then read the page that is really there. */
      try { await settle(s.page); } catch { /* page may have navigated */ }
      /* The same wrapping run_script uses: a snippet with `return` is a body, anything else an expression. */
      const src = String(script || '');
      const wrapped = /\breturn\b/.test(src) ? `(async () => { ${src} })()` : `(async () => (${src}))()`;
      let value;
      try { value = await s.page.evaluate(wrapped); }
      catch (e) { throw new Error(`the script threw on ${url}: ${String(e && e.message).slice(0, 300)}`); }
      return { value: value === undefined ? null : value };
    } finally {
      /* A throwaway session closes with the step; a named profile stays, it is where the login lives. */
      if (!want) { try { await pool.close(s.id, 'script step finished'); } catch { /* best effort */ } }
    }
  };
}

function makeRunAgent(client) {
  // An automation pipeline is the owner's OWN work, not interactive multi-session use, so it is not
  // throttled by the small per-plan concurrency limit — the worker's MAX_CONTEXTS is the real cap. A
  // 5-step flow whose thinking steps briefly overlap must not trip "your plan allows 3 sessions".
  const owner = client.owner;
  const maxConcurrent = Math.max(client.maxConcurrent || 2, Number(process.env.MAX_CONTEXTS) || 8);
  return async ({ node, goal, autoApprove, workflowId, runId, context }) => {
    const cfg = { ...settingsStore.read() };
    // Auto-reply: when the owner has flipped an automation to auto-send, its acting steps approve
    // themselves instead of parking for a yes. The role's own judgment (skip your own post, skip
    // anyone you've already engaged) still runs — only the human approval of the final text is waived.
    if (autoApprove) cfg.autoAct = true;
    /*
     * THE STEP'S REPLAY LETTER. agent.js reads settings.replayValues when it consults this step's
     * route card; nothing ever assigned it, so a trusted card could never be rebuilt and every repeat
     * of every job walked the UI. A step with no values walks, as before.
     */
    if (node.values && typeof node.values === 'object') cfg.replayValues = node.values;
    if (!cfg.llmModel) throw new Error('no AI model configured — set it under agent Settings first');
    const want = node.profile ? profiles.safeName(node.profile) : '';
    let s = want ? pool.listFor(owner).find((x) => x.profile === want) : null;
    if (s) s = pool.get(s.sessionId);
    if (!s) { const o = await pool.createSession({ owner, maxConcurrent, profile: want || undefined, takeover: true }); s = pool.get(o.sessionId); }
    const _in = (context && context.input) || {};
    const job = jobs.create({ owner, goal: String(goal).slice(0, 4000), companyId: null, profile: s.profile || null, sessionId: s.id, workflowId: workflowId || null, runId: runId || null, nodeId: node.id || null,
      feedKey: _in.feedKey || null, feedWorkflowId: _in.feedWorkflowId || null,
      /* The step's own budget (see cleanNode); 0 keeps the browser default. */
      maxSteps: Number(node.maxSteps) || 0, maxPages: Number(node.maxPages) || 0 });
    s.job = job.id; job.role = roles.canonical(node.role);
    // PER-NODE AUTO-RECORD. When the builder ticks "record" on this step, the server films the whole
    // step itself — start now, stop when the step ends — so a clip of exactly what the agent did lands
    // in the Files tab every run, with no dependence on the agent remembering start/stop_recording (a
    // drifting run never reached the stop, so it saved nothing). Best-effort: a recorder failure must
    // never break the step it is filming.
    let recStarted = false;
    if (node.record) { try { recStarted = await record.beginRecording(s, s.page); } catch { recStarted = false; } }
    const switchProfile = async (name) => {
      const w = profiles.safeName(name);
      const ex = pool.listFor(owner).find((x) => x.profile === w);
      let ss; if (ex) ss = pool.get(ex.sessionId);
      else { const op = await pool.createSession({ owner, maxConcurrent, profile: w, takeover: true }); ss = pool.get(op.sessionId); }
      ss.job = job.id; return ss;
    };
    // Detached exactly as the jobs endpoint runs it; a workflow step is unattended by definition. Acts
    // still pass through the gate — an automation does not silently earn autoAct.
    agent.run({ job, session: s, settings: cfg, switchProfile, sink: null, convo: null, role: roles.canonical(node.role), ownOrigin: null, unattended: true, log })
      .catch((e) => { try { jobs.finish(job, 'failed', e.message); } catch { /* already ended */ } });
    // The 40-minute limit is a STUCK-work guard, not a review clock. Time the step spends parked on
    // the owner's approval must not count against it — a person reviewing a draft slowly should never
    // silently kill the run — so the deadline is pushed forward for as long as a proposal is pending.
    let deadline = Date.now() + 40 * 60 * 1000;
    let result = null, failure = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const j = jobs.get(job.id);
      if (!j) { failure = new Error('the browser lost this step\'s job'); break; }
      if (jobs.isOver(j) || j.status === 'idle') {
        const v = jobs.view(j);
        if (j.status === 'failed') { failure = new Error(j.error || 'the step failed'); break; }
        /* What happened, as data: the report, the outcome, the last note and the last URL ride
           beside the saved records, so a branch can test them and an organ can read one field. */
        const lastOf = (kind) => { const xs = (v.steps || []).filter((x) => x && x.kind === kind); return xs.length ? xs[xs.length - 1] : null; };
        const lastUrl = (() => { const xs = (v.steps || []).filter((x) => x && x.url); return xs.length ? xs[xs.length - 1].url : undefined; })();
        result = pruneOut({ leads: v.leads, gigs: v.gigs, reach: v.reach, keywords: v.keywords, searchQueries: v.searchQueries, opportunities: v.opportunities, data: (v.data && Object.keys(v.data).length) ? v.data : undefined, steps: (v.steps || []).length, __jobId: job.id,
          report: v.report ? String(v.report).slice(0, 4000) : undefined,
          outcome: workflows.outcomeOf(v.steps),
          note: (lastOf('note') || lastOf('blocked') || lastOf('unconfirmed') || {}).text,
          url: lastUrl });
        break;
      }
      if ((j.proposals || []).some((p) => p.state === 'pending')) deadline = Date.now() + 40 * 60 * 1000;
      else if (Date.now() > deadline) { try { jobs.finish(j, 'failed', 'workflow step timed out'); } catch { /* */ } failure = new Error('this step ran past its 40-minute limit'); break; }
    }
    // Stop the per-node recording (if any) BEFORE the throwaway session is closed, and save the clip to
    // the Files tab. Surfaced on the node output as __recording so a later step (or the run view) can
    // pick the asset up.
    if (recStarted) {
      try {
        const saved = await record.endRecording(s, { name: `${node.outKey || node.id || 'node'}-${Date.now()}.mp4` });
        if (saved) { log.info(`[workflow] node "${node.label || node.id}" recorded → asset ${saved.id} (${saved.secs}s)`); if (result) result.__recording = saved.id; }
      } catch { /* recording is best-effort — never fail the step over it */ }
    }
    // A throwaway (no-login) step's session is one-off — close it the moment the step ends, so a chain
    // of thinking steps (strategist → ideas → packaging → …) does not leave a trail of open sessions
    // stacking up against the worker limit. A login session is left to linger: later steps reuse it and
    // it expires on its own.
    if (!want) { try { await pool.close(s.id, 'workflow throwaway step finished'); } catch { /* best effort */ } }
    if (failure) throw failure;
    return result;
  };
}

/*
 * THE FLOW LIST CARRIES ITS OUTCOMES. Without them a caller — the Workshop builder above all — sees
 * only shapes and cannot tell a proven automation from an abandoned probe, so it writes another one.
 * That is how this browser reached 114 flows with 77 for a single site and reused none of them.
 * `verifiedEver` says this flow has worked; `lastVerified` says it still worked last time it ran.
 */
app.get('/v1/workflows', authed, (_req, res) => {
  const outcomes = workflows.latestOutcomes();
  const list = (workflows.all() || []).map((w) => {
    const o = outcomes[w.id] || null;
    return {
      ...w,
      runs: o ? o.runs : 0,
      verifiedRuns: o ? o.verifiedRuns : 0,
      verifiedEver: !!(o && o.verifiedEver),
      lastRunAt: o ? o.lastRunAt : null,
      lastRunStatus: o ? o.lastRunStatus : null,
      lastVerified: !!(o && o.lastVerified),
    };
  });
  res.json({ workflows: list });
});
app.post('/v1/workflows', authed, (req, res) => {
  try { res.json(workflows.save({ ...(req.body || {}), id: null }, wfRoleNames())); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/v1/workflows/import', authed, (req, res) => {
  try { res.json(workflows.importPack(req.body || {}, wfRoleNames())); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.get('/v1/workflows/:id/export', authed, (req, res) => {
  const p = workflows.exportPack(req.params.id); if (!p) return res.status(404).json({ error: 'No such automation.' });
  res.json(p);
});
app.get('/v1/workflows/:id/runs', authed, (req, res) => res.json({ runs: workflows.runsFor(req.params.id) }));
app.post('/v1/workflows/:id/run', authed, (req, res) => {
  const wf = workflows.read(req.params.id);
  if (!wf) return res.status(404).json({ error: 'No such automation.' });
  const runId = `${wf.id}-${Date.now()}`;
  /* The run's input, if the caller has one: {"input": {...}} becomes {{input.*}} in every goal. */
  const input = req.body && req.body.input && typeof req.body.input === 'object' ? req.body.input : null;
  if (runningWatchers.size) return res.json({ runId: null, status: 'busy', note: `another watcher pass holds the browser (${[...runningWatchers].join(', ')}) — it starts as soon as that finishes` });
  runningWatchers.add(wf.id);
  if (String(require('./watcherFeed').getConfig(wf.id).mode) === 'posts') {
    postWatchTick(wf, consoleOwner() || req.client.owner, { force: true }).catch((e) => log.error(`[post-watch] ${wf.id}: ${e.message}`)).finally(() => runningWatchers.delete(wf.id));
    return res.json({ runId, status: 'running', mode: 'posts' });
  }
  const startedAtM = Date.now();
  workflows.drive(wf, { runAgent: makeRunAgent(req.client), runVerify: makeRunVerify(req.client), runFetch: makeRunFetch(req.client), runScript: makeRunScript(req.client), input, persist: workflows.persistRun, runId })
    .then((run) => { recordRolePass(wf, startedAtM, run); return triggerFollowUps(wf, req.client.owner); })
    .catch((e) => log.error(`[workflow] ${wf.id} run died: ${e.message}`))
    .finally(() => runningWatchers.delete(wf.id));
  res.json({ runId, status: 'running' });
});

/*
 * Start a Messenger conversation with ONE contact, guided by the owner — fired from a contact card in
 * a run's results. Reuses the workflow step runner so it lands on the facebook profile and its drafted
 * opener parks at the act gate (or auto-sends) exactly like an automation reply — which is why it then
 * shows up in the same approvals queue. Fire-and-forget; the browser work outlives the HTTP response.
 */
app.post('/v1/agent/message-contact', authed, (req, res) => {
  const { name, threadUrl, guidance, autoApprove } = req.body || {};
  if (!String(guidance || '').trim()) return res.status(400).json({ error: 'say what the message should be about' });
  const who = String(name || 'this contact').slice(0, 120);
  const where = /^https?:\/\//.test(String(threadUrl || '')) ? ` at ${String(threadUrl).slice(0, 400)}` : '';
  const goal = `Open the Facebook Messenger chat with ${who}${where}. Start this conversation, in my voice: ${String(guidance).slice(0, 1500)}`;
  try {
    makeRunAgent(req.client)({ node: { role: 'messenger-start-a-chat', profile: 'facebook' }, goal, autoApprove: !!autoApprove })
      .catch((e) => log.error(`[messenger] opener for ${who} failed: ${e.message}`));
    res.json({ ok: true, name: who });
  } catch (e) { fail(res, e); }
});
app.get('/v1/workflows/:id', authed, (req, res) => {
  const w = workflows.read(req.params.id); if (!w) return res.status(404).json({ error: 'No such automation.' });
  res.json(w);
});
app.put('/v1/workflows/:id', authed, (req, res) => {
  if (!workflows.read(req.params.id)) return res.status(404).json({ error: 'No such automation.' });
  try { res.json(workflows.save({ ...(req.body || {}), id: req.params.id }, wfRoleNames())); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.delete('/v1/workflows/:id', authed, (req, res) => {
  /*
   * AN ORGAN'S FLOW IS NOT DELETED FROM HERE. Removing Herald's reply flow would stop every reply
   * the desk sends, with nothing on screen to say what broke — and the desk would simply register
   * it again on its next restart. Disconnecting the organ is how you get rid of it.
   */
  const w = workflows.read(req.params.id);
  if (w && w.owner) return res.status(409).json({ error: `This automation belongs to ${w.owner}. Disconnect ${w.owner} to remove it — deleting it here would stop its work and it would come back on the next restart.` });
  res.json({ removed: workflows.remove(req.params.id) });
});
app.get('/v1/workflow-runs/:id', authed, (req, res) => {
  const r = workflows.readRun(req.params.id); if (!r) return res.status(404).json({ error: 'No such run.' });
  res.json(r);
});
// A watcher's deduped, accumulating result feed (only-new, urgency-ranked, handled-aware).
app.get('/v1/watchers/:id/feed', authed, (req, res) => {
  try {
    const wf = require('./watcherFeed'); const c = wf.getConfig(req.params.id) || {};
    const hideAfter = Number(c.hideAfterDays) || 14;   // older than this is history, not a to-do
    const items = wf.list(req.params.id).filter((it) => it.handled || wf.ageDays(it) <= hideAfter).map((it) => ({ ...it, draftState: wf.stateOf(it) }));
    res.json({ items, counts: wf.counts(req.params.id) });
  }
  catch (e) { res.json({ items: [], counts: { total: 0, unhandled: 0 } }); }
});
app.post('/v1/watchers/:id/feed/handled', authed, (req, res) => {
  try { const b = req.body || {}; res.json({ ok: require('./watcherFeed').markHandled(req.params.id, b.key, b.handled !== false) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// A watcher's follow-up config (generic): { followUpFlowId, followUpKinds:[] } — any flow, any item kinds.
app.get('/v1/watchers/:id/config', authed, (req, res) => { try { res.json(require('./watcherFeed').getConfig(req.params.id)); } catch (e) { res.json({}); } });
app.put('/v1/watchers/:id/config', authed, (req, res) => { try { res.json(require('./watcherFeed').setConfig(req.params.id, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });

/*
 * APPROVE A DRAFT = POST IT. A follow-up drafts in draft-only mode (the flow saves the text and ends,
 * so the one browser session is free for the next item) — which means nobody is parked at a gate
 * waiting for this yes. So approving runs a small POSTER: open the thread, EXPAND it, re-check that
 * nothing was answered in the meantime (a draft can sit in Results for hours; double-answering in
 * public is the one failure that embarrasses), then post the owner's exact words. If the drafting job
 * happens to still be parked (a live Reply Desk gate), the yes goes to that job instead. `dryRun`
 * does everything except the final act — the safe way to prove the poster on a real thread.
 */
function posterFlow(dryRun) {
  const goal = dryRun
    ? 'DRY RUN - verify only, post NOTHING. use_my_profile, then open {{input.url}}. THE MESSAGE TO ANSWER is by {{input.author}} and begins: "{{input.said}}" - the comment_id in the URL points at it and Facebook highlights it. Find THAT message (expand its hidden replies if needed, at most 3 expands, only around it - ignore other threads on the page). Then call note with ONE line: (a) has {{input.author}} already received a reply from me AFTER that message (yes/no) and (b) which numbered element is the Reply / Beantwoorden control under {{input.author}}\'s message. Then finish. Do NOT call act, do NOT type.'
    : 'use_my_profile, then open {{input.url}}. THE MESSAGE TO ANSWER is by {{input.author}} and begins: "{{input.said}}" - the comment_id in the URL points at it and Facebook highlights it. Find THAT message (expand its hidden replies if needed, at most 3 expands, only around it - ignore other threads on the page). If a reply from me to {{input.author}} already sits AFTER that message, call note "already answered" and finish - post nothing. Otherwise call look, find the Reply / Beantwoorden control directly under {{input.author}}\'s message, and call act(kind: reply, index: <that element>, text: <EXACTLY the text below, unchanged, nothing added>). Then call note "posted" and finish.\n\nTEXT TO POST (verbatim):\n{{input.text}}';
  return { id: 'watcher-post-approved-reply', name: 'Post approved reply', autoApprove: !dryRun,
    nodes: [{ id: 'trigger', type: 'trigger', label: 'Approved in Results', trigger: { type: 'manual' } },
            { id: 'n0', type: 'agent', label: 'Re-check the thread, then post', role: 'facebook-post-approved-reply', profile: 'facebook', goal, maxSteps: 50, maxPages: 10 }],
    edges: [{ from: 'trigger', to: 'n0' }] };
}
const posterVerdict = (run) => {
  const notes = [];
  for (const st of ((run && run.steps) || [])) { const o = (st && st.output) || {}; for (const k of ['note', 'report', 'outcome']) if (o[k]) notes.push(String(o[k])); }
  return notes.join(' | ').slice(0, 700);
};
app.post('/v1/watchers/:id/feed/approve', authed, (req, res) => {
  const feed = require('./watcherFeed'); const b = req.body || {}; const wid = req.params.id;
  const it = feed.list(wid).find((x) => x.key === b.key);
  if (!it) return res.status(404).json({ error: 'no such item' });
  const text = String(b.text || it.draft || '').trim();
  if (!text) return res.status(400).json({ error: 'nothing to post' });
  const dryRun = !!b.dryRun;
  // still parked at a live gate? then the yes belongs to that job
  let live = null; try { live = it.draftJobId ? jobs.get(it.draftJobId) : null; } catch (e) { live = null; }
  const pend = live && (live.proposals || []).find((p) => p.pid === it.draftPid && p.state === 'pending');
  if (pend && !jobs.isOver(live) && !dryRun) {
    jobs.decide(live, it.draftPid, 'approved', text);
    feed.mark(wid, it.key, { handled: true, posted: 'live', draft: text });
    return res.json({ mode: 'live' });
  }
  const owner = consoleOwner() || req.client.owner;
  const runId = `watcher-post-approved-reply-${Date.now()}`;
  feed.mark(wid, it.key, dryRun ? { dryRunId: runId, dryRunResult: '' } : { posting: true, postFailed: false, postRunId: runId, draft: text });
  /* THE POSTER IS CODE, NOT AN AGENT (see postWatch.postReply): open the comment's own deep link, find
     that comment by id, press its Reply, type the exact words, submit, and prove the reply is on the
     page with the owner's name — never typing twice. Shares the one browser with the watcher passes:
     wait for a running pass (up to 4 min) and hold the lock while posting. */
  const lockKey = `poster:${wid}`;
  const cfgP = feed.getConfig(wid) || {};
  const want = profiles.safeName(cfgP.profile || 'facebook'); const maxConcurrent = Math.max(2, Number(process.env.MAX_CONTEXTS) || 8);
  const session = async () => {
    let s = pool.listFor(owner).find((x) => x.profile === want); if (s) s = pool.get(s.sessionId);
    let dead = false; try { dead = !s || !s.page || (s.page.isClosed && s.page.isClosed()); } catch (e) { dead = true; }
    if (dead) { const o = await pool.createSession({ owner, maxConcurrent, profile: want, takeover: true }); s = pool.get(o.sessionId); }
    return s;
  };
  const touch = () => { try { const s = pool.listFor(owner).find((x) => x.profile === want); const live = s && pool.get(s.sessionId); if (live) live.lastUsed = Date.now(); } catch (e) { /* best effort */ } };
  (async () => {
    /* Claim a place at once (so the scheduler starts no NEW pass), then wait for the pass that is
       already running to finish — however long it takes, up to 12 min. Never proceed on top of it:
       a crawl and a post on the same page mean the wrong page for one of them. */
    runningWatchers.add(lockKey);
    const t0 = Date.now(); const others = () => [...runningWatchers].some((k) => k !== lockKey);
    while (others() && Date.now() - t0 < 720000) await new Promise((r) => setTimeout(r, 2000));
    if (others()) { runningWatchers.delete(lockKey); feed.mark(wid, it.key, dryRun ? { dryRunResult: 'failed: browser busy for 12 min' } : { posting: false, postFailed: true, posted: 'failed: the browser stayed busy for 12 minutes — approve again' }); return; }
    try {
      const pw = require('./postWatch');
      const r = await pw.postReply((await session()).page, it.url, text, { meName: cfgP.meName || '', dryRun, touch });
      log.info(`[poster] ${it.fields && it.fields.author}: ${JSON.stringify(r)}`);
      if (dryRun) feed.mark(wid, it.key, { dryRunResult: (r.dryRun ? 'ok: ' : 'failed: ') + r.detail });
      else if (r.posted) feed.mark(wid, it.key, { posting: false, handled: true, posted: 'posted — ' + r.detail, fields: Object.assign({}, it.fields, { status: 'answered' }) });
      else if (r.alreadyAnswered) feed.mark(wid, it.key, { posting: false, handled: true, posted: 'already answered on the page', fields: Object.assign({}, it.fields, { status: 'answered' }) });
      else feed.mark(wid, it.key, { posting: false, postFailed: true, posted: 'failed: ' + r.detail });
    } catch (e) {
      log.error(`[poster] ${e.message}`);
      feed.mark(wid, it.key, dryRun ? { dryRunResult: 'failed: ' + e.message } : { posting: false, postFailed: true, posted: 'failed: ' + e.message });
    } finally { runningWatchers.delete(lockKey); }
  })();
  res.json({ mode: dryRun ? 'dry-run' : 'post', runId });
});
app.post('/v1/watchers/:id/feed/deny', authed, (req, res) => {
  const feed = require('./watcherFeed'); const b = req.body || {}; const wid = req.params.id;
  const it = feed.list(wid).find((x) => x.key === b.key);
  if (!it) return res.status(404).json({ error: 'no such item' });
  try { const live = it.draftJobId ? jobs.get(it.draftJobId) : null; if (live && !jobs.isOver(live)) jobs.decide(live, it.draftPid, 'skipped'); } catch (e) { /* no live gate */ }
  feed.mark(wid, it.key, { handled: true, posted: 'denied' });
  res.json({ ok: true });
});

/*
 * THE AUTOMATION SCHEDULER. A quiet once-a-minute tick that fires ACTIVE workflows whose trigger is a
 * schedule and which are due. It is off by construction — a workflow only fires once it is switched
 * Active — and every run is isolated, so a bad schedule fails its own run and touches nothing else.
 * Runs as the single console owner (there is only one), on that owner's profiles.
 */
const consoleOwner = () => { try { const a = accounts.load(); return a && a.username; } catch { return null; } };
// Interval units the scheduler understands. The interval VALUE (n + unit) is data set on the
// automation; this map is the only code — adding a new unit is one line, never a per-schedule change.
const SCHED_UNIT_MS = { minute: 60e3, hour: 3600e3 };
function scheduleDue(cfg, lastMs, when) {
  if (!cfg) return false;
  if (cfg.every === 'day') {
    const [hh, mm] = String(cfg.at || '08:00').split(':').map((x) => parseInt(x, 10) || 0);
    return when.getHours() === hh && when.getMinutes() === mm && (Date.now() - lastMs) > 22 * 3600e3;
  }
  const ms = SCHED_UNIT_MS[cfg.every];
  if (ms) { const n = Math.max(1, Number(cfg.n) || 1); return (Date.now() - lastMs) >= n * ms; }
  return false;
}
/* One watcher pass at a time. A second pass (a schedule firing, or a hand-started run) that
   overlaps the first fights it for the one browser session and every follow-up draft errors on a
   busy profile. This gate makes collect finish and free the session before the follow-ups draft. */
const runningWatchers = new Set();

/*
 * POST WATCHER PASS. A watcher whose config says mode:"posts" is not driven as a flow: the server
 * crawls each watched post on the profile session (deterministic, no model at the wheel), folds the
 * comment tree into the feed with every branch's standing, and drafts one dedicated reply per person
 * waiting on the owner - a text call with the post and the whole branch as context. See postWatch.js.
 */
async function postWatchTick(wf, owner, opts) {
  const feed = require('./watcherFeed'); const pw = require('./postWatch');
  let cfg = feed.getConfig(wf.id);
  const llmCfg = settingsStore.read();
  const want = profiles.safeName(cfg.profile || 'facebook');
  const maxConcurrent = Math.max(2, Number(process.env.MAX_CONTEXTS) || 8);
  const session = async () => {
    let s = pool.listFor(owner).find((x) => x.profile === want); if (s) s = pool.get(s.sessionId);
    let dead = false; try { dead = !s || !s.page || (s.page.isClosed && s.page.isClosed()); } catch (e) { dead = true; }
    if (dead) { const o = await pool.createSession({ owner, maxConcurrent, profile: want, takeover: true }); s = pool.get(o.sessionId); }
    return s;
  };
  // A crawl drives the page directly; without this the pool reads it as idle and reaps the browser mid-pass.
  const touch = () => { try { const s = pool.listFor(owner).find((x) => x.profile === want); const live = s && pool.get(s.sessionId); if (live) live.lastUsed = Date.now(); } catch (e) { /* best effort */ } };
  const getPage = async () => (await session()).page;
  // Stand alone: read the owner's notifications page for posts with activity, no other watcher needed.
  if (cfg.selfDiscover !== false) {
    try {
      const found = await pw.discoverOnPage((await session()).page, log);
      const have = new Set((cfg.postUrls || []).map((u) => pw.postIdOf(u)));
      const add = found.filter((u) => !have.has(pw.postIdOf(u)));
      if (add.length) { cfg = feed.setConfig(wf.id, { postUrls: (cfg.postUrls || []).concat(add) }); log.info(`[post-watch] now watching ${add.length} new post(s)`); }
    } catch (e) { log.error(`[post-watch] self-discovery: ${e.message}`); }
  }
  const all = pw.discover(wf.id, cfg, feed);
  if (!all.length) { log.info(`[post-watch] "${wf.name}": no posts to watch yet`); return; }
  // adaptive cadence: a scheduled pass reads only the posts that are due (active every pass, quiet
  // hourly, dead daily, with jitter); a hand-started run reads them all
  const urls = (opts && opts.force) ? all : pw.dueUrls(cfg, all);
  if (!urls.length) { log.info(`[post-watch] "${wf.name}": ${all.length} post(s) watched, none due yet`); return; }
  // oldest-crawled first, so a busy pass still gets round to every post over time
  const last = cfg.lastCrawl || {};
  const order = urls.slice().sort((a, b) => (last[a] || 0) - (last[b] || 0)).slice(0, Number(cfg.maxPostsPerPass) || 6);
  /* PASS HEALTH: what this pass read, verified, corrected, drafted and hit — kept on the watcher so the
     app can show it and a silent failure has nowhere to hide. */
  const health = { startedAt: Date.now(), endedAt: 0, posts: 0, messages: 0, waiting: 0, drafts: 0, verified: 0, corrected: 0, errors: [] };
  for (const url of order) {
    try {
      const tree = await pw.crawl(getPage, url, log, touch);
      const entries = pw.ingest(wf.id, tree, cfg, feed);
      const v = await pw.verifyWaiting(getPage, tree, entries, cfg, feed, wf.id, log, touch);
      pw.store(tree);
      const made = await pw.draftAll(wf.id, tree, entries, cfg, llmCfg, feed, log);
      const waiting = entries.filter((e) => e.needsReply).length;
      health.posts++; health.messages += tree.nodes.length; health.waiting += waiting; health.drafts += made; health.verified += v.checked; health.corrected += v.corrected;
      if (v.errors) health.errors.push(`${v.errors} verify error(s) on ${url}`);
      log.info(`[post-watch] ${url}: ${tree.nodes.length} message(s), ${waiting} waiting on you (${v.checked} verified, ${v.corrected} corrected), ${made} new draft(s)`);
      feed.setConfig(wf.id, { lastCrawl: Object.assign({}, feed.getConfig(wf.id).lastCrawl || {}, { [url]: Date.now() }) });
    } catch (e) { health.errors.push(`${url}: ${e.message}`); log.error(`[post-watch] ${url}: ${e.message}`); }
  }
  health.endedAt = Date.now();
  feed.setConfig(wf.id, { lastPass: health });
}
/*
 * ── THE GB OPERATOR ──────────────────────────────────────────────────────────────────────────────
 * An engineer for this browser, self-contained: src/operator/{harness,registry,tools,prompt}.js. A job
 * is a goal in plain words; the harness runs the operator's tools (closures over THIS server's
 * internals — no other service) until the outcome is proven or blocked, journaled under
 * /profiles/operator/jobs. The app's Agent chat and the console are its surfaces.
 */
ops.install({ app, authed, workflows, pool, profiles, consoleOwner, log });
const operatorRuns = new Map();
function operatorContext() {
  const owner = consoleOwner(); const feed = require('./watcherFeed'); const pw = require('./postWatch');
  const c = { owner, maxConcurrent: 2 };
  const maxConcurrent = Math.max(2, Number(process.env.MAX_CONTEXTS) || 8);
  const sessionFor = async (want) => {
    let s = pool.listFor(owner).find((x) => x.profile === want); if (s) s = pool.get(s.sessionId);
    let dead = false; try { dead = !s || !s.page || (s.page.isClosed && s.page.isClosed()); } catch (e) { dead = true; }
    if (dead) { const o = await pool.createSession({ owner, maxConcurrent, profile: want, takeover: true }); s = pool.get(o.sessionId); }
    return s;
  };
  const healthOf = (id) => {
    const cfg = feed.getConfig(id) || {}; const wf = workflows.read(id); const lp = cfg.lastPass || null; const running = runningWatchers.has(id);
    const sinceMin = lp && lp.endedAt ? Math.round((Date.now() - lp.endedAt) / 60000) : null;
    return { id, active: !!(wf && wf.active), running, lastPass: lp, sinceMinutes: sinceMin, stale: !!(wf && wf.active && !running && (sinceMin === null || sinceMin > 45)), mode: cfg.mode || '' };
  };
  const pickJob = (v) => ({ id: v.id, status: v.status, role: v.role, workflowId: v.workflowId, runId: v.runId, steps: Array.isArray(v.steps) ? v.steps.length : 0, proposals: (v.proposals || []).length, error: v.error || null });
  return {
    ops, workflows, feed, runningWatchers, postIdOf: pw.postIdOf, health: healthOf,
    jobsSummary: () => { const live = [...jobs.jobs.values()].map((j) => pickJob(jobs.view(j))); let hist = []; try { hist = (jobs.loadHistory(owner) || []).slice(0, 15).map(pickJob); } catch (e) { hist = []; } return { jobs: live, history: hist }; },
    jobDetail: (id, last) => { const j = jobs.get(id); if (!j) return { error: 'no such job (it may have ended and been pruned — read its run instead)' }; const v = jobs.view(j); return { id: v.id, status: v.status, role: v.role, workflowId: v.workflowId, runId: v.runId, error: v.error || null, report: v.report ? String(v.report).slice(0, 1500) : null, proposals: (v.proposals || []).map((p) => ({ pid: p.pid, state: p.state, kind: p.kind, text: String(p.text || '').slice(0, 300), url: p.url })), steps: (v.steps || []).slice(-(last || 40)).map((s) => ({ kind: s.kind, text: String(s.text || '').slice(0, 300), ...(s.url ? { url: s.url } : {}) })) }; },
    sessions: () => pool.listFor(owner),
    look: async (profile) => {
      const s = await sessionFor(profiles.safeName(profile || 'facebook')); const page = s.page;
      const url = page.url(); const title = await page.title().catch(() => '');
      let controls = []; try { const a = await analyzePage(page); const els = Array.isArray(a) ? a : ((a && (a.elements || a.items)) || []); controls = els.slice(0, 60).map((e) => ({ i: e.index !== undefined ? e.index : e.i, text: String(e.text || e.label || e.ariaLabel || '').slice(0, 80), kind: e.tag || e.role || e.type })); } catch (e) { controls = [{ error: e.message }]; }
      let text = ''; try { text = await page.evaluate(() => (document.body && document.body.innerText || '').replace(/\s+\n/g, '\n').slice(0, 1500)); } catch (e) { /* none */ }
      let shot = null; try { const dir = require('path').join(process.env.PROFILE_DIR || '/profiles', 'operator', 'shots'); require('fs').mkdirSync(dir, { recursive: true }); shot = require('path').join(dir, Date.now() + '.png'); await page.screenshot({ path: shot, type: 'png' }); } catch (e) { shot = null; }
      return { url, title, controls, text, screenshot: shot };
    },
    probe: async (id, url, expand) => {
      if (runningWatchers.size) return { error: `busy: a watcher pass holds the browser (${[...runningWatchers].join(', ')}) — wait for it` };
      runningWatchers.add('probe:' + id);
      try { const s = await sessionFor(profiles.safeName((feed.getConfig(id) || {}).profile || 'facebook')); return await pw.probePage(s.page, url, { expand: !!expand }); }
      finally { runningWatchers.delete('probe:' + id); }
    },
    runWatcher: (id) => {
      const wf = workflows.read(id); if (!wf) return { error: 'no such watcher' };
      if (runningWatchers.size) return { status: 'busy', note: `another pass holds the browser (${[...runningWatchers].join(', ')}) — wait with gb_watcher_wait, then run again` };
      runningWatchers.add(wf.id);
      const runId = `${wf.id}-${Date.now()}`;
      if (String((feed.getConfig(wf.id) || {}).mode) === 'posts') postWatchTick(wf, owner, { force: true }).catch((e) => log.error(`[post-watch] ${wf.id}: ${e.message}`)).finally(() => runningWatchers.delete(wf.id));
      else { const t0 = Date.now(); workflows.drive(wf, { runAgent: makeRunAgent(c), runVerify: makeRunVerify(c), runFetch: makeRunFetch(c), runScript: makeRunScript(c), persist: workflows.persistRun, runId }).then((run) => { recordRolePass(wf, t0, run); return triggerFollowUps(wf, owner); }).catch((e) => log.error(`[workflow] ${wf.id} run died: ${e.message}`)).finally(() => runningWatchers.delete(wf.id)); }
      return { runId, status: 'running' };
    },
    setActive: (id, active) => { const wf = workflows.read(id); if (!wf) return { error: 'no such watcher' }; wf.active = !!active; const r = workflows.save(wf, paletteNames()); return { id, active: !!((r && r.workflow) || r || wf).active }; },
    agentTools: () => agent.TOOLS.map((t) => t.function).filter(Boolean).map((f) => ({ name: f.name, description: String(f.description || '').slice(0, 200), takes: Object.keys((f.parameters && f.parameters.properties) || {}) })),
    listRoles: () => roles.list(),
    getRole: (name) => { const key = String(name || '').toLowerCase(); const canonical = roles.canonical(key); if (key !== 'general' && canonical === 'general') return null; const r = roles.get(key); return { name: canonical, builtin: !!roles.ROLES[canonical], site: r.site || null, group: r.group || null, label: r.label, description: r.description, tools: r.tools === undefined ? null : r.tools, prompt: r.prompt || '' }; },
    saveRole: (name, role) => userRoles.save({ ...(role || {}), id: name || null }, paletteNames()),
    saveFlow: (flow) => { const r = workflows.save(flow, paletteNames()); return (r && r.workflow) || r; },
    runFlow: (id, input) => { const wf = workflows.read(id); if (!wf) return { error: 'no such flow' }; const runId = `${wf.id}-${Date.now()}`; workflows.drive(wf, { runAgent: makeRunAgent(c), runVerify: makeRunVerify(c), runFetch: makeRunFetch(c), runScript: makeRunScript(c), input: input || null, persist: workflows.persistRun, runId }).catch((e) => log.error(`[workflow] ${wf.id} run died: ${e.message}`)); return { runId, status: 'running' }; },
    platforms: () => platforms.withLogins(pool.listProfilesDetailed()),
  };
}
app.post('/v1/operator/jobs', authed, (req, res) => {
  const goal = String((req.body || {}).goal || '').trim();
  if (!goal) return res.status(400).json({ error: 'goal required — what should the operator do, in plain words' });
  const cfg = settingsStore.read();
  if (!cfg.llmModel) return res.status(400).json({ error: 'no AI model configured — set it under agent Settings first' });
  try {
    const { Registry } = require('./operator/registry'); const { registerOperatorTools } = require('./operator/tools');
    const { OperatorRun } = require('./operator/harness'); const { operatorPrompt } = require('./operator/prompt');
    const reg = new Registry(); registerOperatorTools(reg, operatorContext());
    const run = new OperatorRun({ goal, chat: (o) => llm.chat(o), llm: { host: cfg.llmHost, model: cfg.llmModel, key: cfg.llmKey }, registry: reg, systemPrompt: operatorPrompt(), orientation: () => { const m = ops.readMemory(); return m ? 'YOUR NOTES (newest last):\n' + m.slice(-3000) : ''; }, log });
    operatorRuns.set(run.id, run);
    run.run().catch((e) => log.error(`[operator] ${run.id}: ${e.message}`));
    log.info(`[operator] job ${run.id}: ${goal.slice(0, 120)}`);
    res.json({ id: run.id, status: 'running' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/v1/operator/jobs', authed, (req, res) => {
  const { listPersisted } = require('./operator/harness');
  const live = [...operatorRuns.values()].map((r) => r.view()); const ids = new Set(live.map((r) => r.id));
  const past = listPersisted().filter((r) => !ids.has(r.id)).slice(0, 30).map((r) => ({ ...r, events: (r.events || []).slice(-20) }));
  res.json({ jobs: [...live, ...past] });
});
app.get('/v1/operator/jobs/:id', authed, (req, res) => {
  const r = operatorRuns.get(req.params.id); if (r) return res.json(r.view());
  const { listPersisted } = require('./operator/harness'); const p = listPersisted().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'no such operator job' }); res.json(p);
});
app.post('/v1/operator/jobs/:id/say', authed, (req, res) => { const r = operatorRuns.get(req.params.id); if (!r) return res.status(404).json({ error: 'not running' }); r.say(String((req.body || {}).text || '')); res.json({ ok: true }); });
app.post('/v1/operator/jobs/:id/stop', authed, (req, res) => { const r = operatorRuns.get(req.params.id); if (!r) return res.status(404).json({ error: 'not running' }); r.stop(); res.json({ ok: true }); });
// Which watcher passes hold the browser right now. NOT owner-scoped on purpose: the deploy gate asks
// with the master's key and sessions are per owner, so it rolled the pod straight through a crawl.
app.get('/v1/watchers/busy', authed, (req, res) => res.json({ running: [...runningWatchers] }));
// A watcher's health: its last pass, whether one is running now, and whether it has gone quiet.
app.get('/v1/watchers/:id/health', authed, (req, res) => {
  try {
    const feed = require('./watcherFeed'); const c = feed.getConfig(req.params.id) || {}; const wf = workflows.read(req.params.id);
    const lp = c.lastPass || null; const running = runningWatchers.has(req.params.id);
    const sinceMin = lp && lp.endedAt ? Math.round((Date.now() - lp.endedAt) / 60000) : null;
    const stale = !!(wf && wf.active && !running && (sinceMin === null || sinceMin > 45));
    res.json({ active: !!(wf && wf.active), running, lastPass: lp, sinceMinutes: sinceMin, stale, mode: c.mode || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Ground truth for one thread, as the watcher's OWN session sees it (same owner, same login): every
// comment article on that comment's page. For checking "it says waiting but I answered" without guessing.
app.post('/v1/watchers/:id/probe', authed, async (req, res) => {
  const feed = require('./watcherFeed'); const pw = require('./postWatch');
  const url = String((req.body || {}).url || '').trim();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url required' });
  if (runningWatchers.size) return res.status(409).json({ error: `busy: a watcher pass holds the browser (${[...runningWatchers].join(', ')})` });
  const owner = consoleOwner() || req.client.owner; const cfg = feed.getConfig(req.params.id) || {};
  const want = profiles.safeName(cfg.profile || 'facebook'); const maxConcurrent = Math.max(2, Number(process.env.MAX_CONTEXTS) || 8);
  runningWatchers.add(req.params.id);
  try {
    let s = pool.listFor(owner).find((x) => x.profile === want); if (s) s = pool.get(s.sessionId);
    if (!s) { const o = await pool.createSession({ owner, maxConcurrent, profile: want, takeover: true }); s = pool.get(o.sessionId); }
    res.json(await pw.probePage(s.page, url, { expand: !!(req.body || {}).expand, html: !!(req.body || {}).html }));
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { runningWatchers.delete(req.params.id); }
});
// The posts a post-watcher follows: list / add one / remove one.
app.get('/v1/watchers/:id/posts', authed, (req, res) => { try { const c = require('./watcherFeed').getConfig(req.params.id); res.json({ postUrls: c.postUrls || [], mode: c.mode || '', lastCrawl: c.lastCrawl || {} }); } catch (e) { res.json({ postUrls: [] }); } });
app.post('/v1/watchers/:id/posts', authed, (req, res) => {
  const feed = require('./watcherFeed'); const pw = require('./postWatch');
  const url = String((req.body || {}).url || '').trim(); const pid = pw.postIdOf(url);
  if (!pid) return res.status(400).json({ error: 'that is not a post link (needs post_id or /posts/<id>/)' });
  const c = feed.getConfig(req.params.id); const urls = Array.isArray(c.postUrls) ? c.postUrls.slice() : [];
  if (!urls.some((u) => pw.postIdOf(u) === pid)) urls.push(url);
  res.json(feed.setConfig(req.params.id, { postUrls: urls, mode: 'posts' }));
});
app.delete('/v1/watchers/:id/posts', authed, (req, res) => {
  const feed = require('./watcherFeed'); const pw = require('./postWatch');
  const pid = pw.postIdOf(String((req.body || {}).url || req.query.url || ''));
  const c = feed.getConfig(req.params.id);
  res.json(feed.setConfig(req.params.id, { postUrls: (c.postUrls || []).filter((u) => pw.postIdOf(u) !== pid) }));
});

/*
 * FOLLOW-UPS (generic). After a watcher run, for each NEW collected item matching the watcher's
 * follow-up config, run the chosen follow-up flow ON that item (as the same owner, so it reuses the
 * one profile session by takeover rather than colliding). The flow's action is correlated back to the
 * item by URL in the UI. Nothing here is site- or reply-specific.
 */

/* One health record for a ROLE watcher's pass (a post watcher writes its own in postWatchTick). */
function recordRolePass(wf, startedAt, run) {
  try {
    const feed = require('./watcherFeed'); const items = feed.list(wf.id);
    const fresh = items.filter((it) => (it.lastSeen || 0) >= startedAt).length;
    const waiting = items.filter((it) => !it.handled && ((it.fields || {}).status === 'waiting on you' || it.draft)).length;
    const errored = run && (run.status === 'error' || (run.steps || []).some((s) => s && s.status === 'error'));
    feed.setConfig(wf.id, { lastPass: { startedAt, endedAt: Date.now(), posts: 0, messages: fresh, waiting, drafts: items.filter((it) => it.draft && (it.lastSeen || 0) >= startedAt).length, verified: 0, corrected: 0, errors: errored ? [String((run && run.error) || 'a step errored')] : [] } });
  } catch (e) { /* best effort */ }
}

async function triggerFollowUps(wf, owner) {
  try {
    if (!wf || !wf.id || !owner) return;
    const feed = require('./watcherFeed');
    const cfg = feed.getConfig(wf.id) || {};
    /* THE ENGINE: each notification KIND goes to its own flow - mentions to one, invites to another,
       replies to a third. config.followUps = [{ kinds:[...], flowId }] in order; empty kinds = any.
       The old single followUpFlowId + followUpKinds still works as one route. */
    const routes = (Array.isArray(cfg.followUps) && cfg.followUps.length ? cfg.followUps : (cfg.followUpFlowId ? [{ kinds: cfg.followUpKinds || [], flowId: cfg.followUpFlowId }] : []))
      .map((r) => ({ kinds: (Array.isArray(r.kinds) ? r.kinds : []).map((k) => String(k).toLowerCase()).filter(Boolean), flow: r && r.flowId ? workflows.read(r.flowId) : null }))
      .filter((r) => r.flow);
    if (!routes.length) return;
    const kindOf = (it) => String((it.fields && (it.fields.type || it.fields.action)) || it.kind || '').toLowerCase();
    const routeFor = (it) => routes.find((r) => !r.kinds.length || r.kinds.includes(kindOf(it)));
    const items = feed.list(wf.id).filter((it) => !it.followedUp && !it.handled && it.url && routeFor(it));
    // A thread older than the watcher's horizon (default 7 days) nobody expects an answer on any
    // more — mark it seen without the drive, so a pass spends its budget on what matters today.
    const maxAge = Number(cfg.maxAgeDays) || 7; const fresh = [];
    for (const it of items) { if (feed.ageDays(it) > maxAge) feed.mark(wf.id, it.key, { draftChecked: true, tooOld: true }); else fresh.push(it); }
    for (const it of fresh.slice(0, 6)) {
      const flow = routeFor(it).flow;
      const rid = `${flow.id}-${Date.now()}`;
      feed.mark(wf.id, it.key, { followedUp: true, draftRunId: rid, followedUpAt: Date.now() });
      const input = { url: it.url, title: it.title, said: (it.fields && (it.fields.detail || it.fields.said)) || '', feedKey: it.key, feedWorkflowId: wf.id };
      let rres = null;
      try {
        rres = await workflows.drive(flow, { runAgent: makeRunAgent({ owner, maxConcurrent: 2 }), runVerify: makeRunVerify({ owner, maxConcurrent: 2 }), runFetch: makeRunFetch({ owner, maxConcurrent: 2 }), runScript: makeRunScript({ owner, maxConcurrent: 2 }), input, persist: workflows.persistRun, runId: rid });
      } catch (e) { log.error(`[follow-up] ${flow.id} on ${it.key}: ${e.message}`); }
      /* The draft, if one was made, was written onto the item at propose-time (agent.js draft-only).
         Decide the item's fate from what actually happened. */
      const cur = feed.list(wf.id).find((x) => x.key === it.key);
      if (cur && cur.draft) continue;                                     // drafted — done
      const errored = !rres || ['error', 'interrupted', 'failed'].includes(String(rres.status || '').toLowerCase());
      if (errored) feed.mark(wf.id, it.key, { followedUp: false, draftRunId: null });   // transient — retry next pass
      else feed.mark(wf.id, it.key, { draftChecked: true });               // ran clean, nothing to say (already answered)
    }
  } catch (e) { log.error(`[follow-up] ${wf && wf.id}: ${e.message}`); }
}

/*
 * RESTART-SAFE DRAFT RECONCILE. The follow-up flow can be interrupted by a pod roll (the 15-min
 * auto-deploy) and RESUME in a fresh process — but the in-process .then() that wrote the draft back
 * onto the feed item died with the old process. So we also reconcile out-of-band: for every feed item
 * that was followed-up but has no draft yet, look up its follow-up run by the STABLE runId (which
 * survives resume) and, once that run has a pending proposal, write it onto the item. If the run has
 * finished with nothing to propose (e.g. already-answered), mark it checked so it stops pending.
 */
async function reconcileDrafts() {
  try {
    const feed = require('./watcherFeed');
    for (const wf of workflows.all()) {
      let items; try { items = feed.list(wf.id); } catch (e) { continue; }
      for (const it of items) {
        if (!it.followedUp || it.draft || it.draftChecked) continue;
        if (!it.draftRunId) { if (it.followedUpAt && Date.now() - it.followedUpAt > 20 * 60000) feed.mark(wf.id, it.key, { draftChecked: true }); continue; }
        let fjob = null; try { for (const j of jobs.jobs.values()) if (j.runId === it.draftRunId) { fjob = j; break; } } catch (e) {}
        if (fjob) {
          const fprop = (fjob.proposals || []).find((pp) => pp.state === 'pending');
          if (fprop) { feed.mark(wf.id, it.key, { draft: fprop.text || '', draftJobId: fjob.id, draftPid: fprop.pid }); continue; }
          const st = String(fjob.status || '').toLowerCase();
          if (st === 'done') { feed.mark(wf.id, it.key, { draftChecked: true }); continue; }
          if (st === 'error' || st === 'failed' || st === 'stopped') {
            if (it.followedUpAt && Date.now() - it.followedUpAt > 20 * 60000) feed.mark(wf.id, it.key, { draftChecked: true });
            else feed.mark(wf.id, it.key, { followedUp: false, draftRunId: null });
            continue;
          }
        }
        if (it.followedUpAt && Date.now() - it.followedUpAt > 20 * 60000) feed.mark(wf.id, it.key, { draftChecked: true });
      }
    }
  } catch (e) { log.error(`[reconcile-drafts] ${e.message}`); }
}

async function scheduleTick() {
  const owner = consoleOwner(); if (!owner) return;
  const when = new Date();
  for (const wf of workflows.all()) {
    if (!wf.active) continue;
    const trig = (wf.nodes || []).find((n) => n.type === 'trigger');
    const cfg = (trig && trig.trigger) || wf.trigger || {};
    if (cfg.type !== 'schedule') continue;
    const last = workflows.runsFor(wf.id, 1)[0];
    if (!scheduleDue(cfg, last ? Date.parse(last.started_at) : 0, when)) continue;
    if (runningWatchers.size) { log.info(`[workflow-sched] "${wf.name}" waits — another watcher pass holds the browser (${[...runningWatchers].join(', ')})`); continue; }
    log.info(`[workflow-sched] firing "${wf.name}"`);
    /* The same hands as a hand-started run: a scheduled flow with a verify step used to die on
       "this browser cannot run a verify step", so no nightly automation could ever prove itself. */
    runningWatchers.add(wf.id);
    if (String(require('./watcherFeed').getConfig(wf.id).mode) === 'posts') {
      workflows.persistRun({ id: `${wf.id}-${Date.now()}`, workflow_id: wf.id, name: wf.name, status: 'done', started_at: when.toISOString(), ended_at: when.toISOString(), steps: [] });
      postWatchTick(wf, owner).catch((e) => log.error(`[post-watch] ${wf.id}: ${e.message}`)).finally(() => runningWatchers.delete(wf.id));
      continue;
    }
    const startedAtS = Date.now();
    workflows.drive(wf, { runAgent: makeRunAgent({ owner, maxConcurrent: 2 }), runVerify: makeRunVerify({ owner, maxConcurrent: 2 }), runFetch: makeRunFetch({ owner, maxConcurrent: 2 }), runScript: makeRunScript({ owner, maxConcurrent: 2 }), persist: workflows.persistRun, runId: `${wf.id}-${Date.now()}` })
      .then((run) => { recordRolePass(wf, startedAtS, run); return triggerFollowUps(wf, owner); })
      .catch((e) => log.error(`[workflow-sched] ${wf.id}: ${e.message}`))
      .finally(() => runningWatchers.delete(wf.id));
  }
}
const _schedTimer = setInterval(() => { scheduleTick().catch(() => {}); reconcileDrafts().catch(() => {}); }, 60000);
setTimeout(() => reconcileDrafts().catch(() => {}), 20000);
if (_schedTimer.unref) _schedTimer.unref();

// Create / edit / forget an authored role. Editing and deleting only ever touch the user store, so a
// built-in cannot be changed or removed through here — to tweak a built-in you clone it into one of
// your own, which the UI does client-side.
app.post('/v1/agent/roles', authed, (req, res) => {
  try { res.json(userRoles.save({ ...(req.body || {}), id: null }, paletteNames())); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.put('/v1/agent/roles/:id', authed, (req, res) => {
  if (!userRoles.read(req.params.id)) return res.status(404).json({ error: 'No such authored role — built-ins cannot be edited.' });
  try { res.json(userRoles.save({ ...(req.body || {}), id: req.params.id }, paletteNames())); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.delete('/v1/agent/roles/:id', authed, (req, res) => {
  res.json({ removed: userRoles.remove(req.params.id) });
});

/*
 * WHAT IT HAS LEARNED ABOUT WHERE LEADS ARE — earned from what places actually returned, not from
 * anything the agent claimed. Readable, because a score nobody can see is a score nobody trusts.
 */
app.get('/v1/agent/playbook', authed, (req, res) => res.json(playbook.summary(req.query.site || 'facebook')));
app.delete('/v1/agent/playbook', authed, (req, res) => { playbook.forget(req.query.site || 'facebook'); res.json({ ok: true }); });

app.get('/v1/agent/settings', authed, (_req, res) => {
  /* The key STATE rides along — how many model keys are usable right now, never the keys. Both
     accounts hitting their weekly allowance on the same afternoon stopped every walk on its third
     step, and nothing on screen said why. */
  const s = settingsStore.read();
  res.json({ ...settingsStore.redacted(), keyState: require('./agent').keyState(s) });
});

app.put('/v1/agent/settings', authed, (req, res) => {
  try { settingsStore.write(req.body || {}); res.json(settingsStore.redacted()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* What the host can serve. Never fails: an unlistable host is still usable by typing a name. */
app.post('/v1/agent/models', authed, async (req, res) => {
  const cur = settingsStore.read();
  res.json(await llm.listModels({
    host: req.body?.llmHost || cur.llmHost,
    key: req.body?.llmKey || cur.llmKey,
  }));
});

/* Prove the key, host and model work together BEFORE a job is started — otherwise the first sign
   that the model is wrong is a job that dies forty seconds in with a 404 nobody can read. */
/* The on-device agent (phone) posts here so it never needs its own model key — it uses the
 * cluster's configured LLM. Body: {system, prompt} or {messages:[{role,content}]}. Returns {text}. */
app.post('/v1/agent/chat', authed, async (req, res) => {
  const cfg = settingsStore.read();
  if (!cfg.llmModel) return res.status(400).json({ error: 'no model configured on the cluster - set one in the GB console agent settings' });
  const b = req.body || {};
  const messages = (Array.isArray(b.messages) && b.messages.length) ? b.messages
    : [ ...(b.system ? [{ role: 'system', content: String(b.system) }] : []), { role: 'user', content: String(b.prompt || b.text || '') } ];
  try {
    const out = await llm.chat({ host: cfg.llmHost, model: cfg.llmModel, key: cfg.llmKey, messages });
    res.json({ text: (out && out.content) || '', model: cfg.llmModel });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.post('/v1/agent/test', authed, async (req, res) => {
  const cur = settingsStore.read();
  try {
    res.json(await llm.testConnection({
      host: req.body?.llmHost || cur.llmHost,
      model: req.body?.llmModel || cur.llmModel,
      // Test the key being typed if there is one, otherwise the saved one — so it can be checked
      // before it is committed.
      key: req.body?.llmKey || cur.llmKey,
    }));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// ── Who we are selling for ──────────────────────────────────────────────────────────────
app.get('/v1/agent/companies', authed, (_req, res) => res.json({ companies: company.readAll() }));
app.put('/v1/agent/companies', authed, (req, res) => {
  try { res.json(company.save(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/v1/agent/companies/:id', authed, (req, res) => res.json({ removed: company.remove(req.params.id) }));

// ── Jobs ────────────────────────────────────────────────────────────────────────────────
app.get('/v1/agent/jobs', authed, (req, res) => {
  /* Same rule as sessions: the owner's console sees the owner's browser working, whoever dispatched
     it. Without this, "watch what it is doing" opened a page that said nothing was happening. */
  const list = req.client.console ? jobs.listAll() : jobs.listFor(req.client.owner);
  /* And whether each one is actually WAITING for the session rather than working in it — a control
     room that cannot tell those apart shows a queue of things that all look busy. */
  res.json({
    jobs: list.map((j) => { const place = queuePosition(j.id); return place ? { ...j, queued: true, position: place } : j; }),
    history: jobs.loadHistory(20),
  });
});

app.post('/v1/agent/jobs', authed, async (req, res) => {
  const { goal, companyId, sessionId, leadflow, role, ownOrigin, unattended, autoApprove, maxSteps, maxPages } = req.body || {};

  /*
   * WHERE THE LEADS GO.
   *
   * Handed in per conversation rather than configured once, because it carries a token scoped to
   * ONE search on the other side — that is the whole point of the design, and storing it would
   * turn a credential that expires in hours into one that sits in a settings file.
   *
   * Validated here so a bad destination fails before the browser does forty minutes of work.
   */
  let sink = null;
  if (leadflow) {
    try { sink = makeSink({ api: leadflow.api, searchId: leadflow.searchId, token: leadflow.token }); }
    catch (e) { return res.status(400).json({ error: `that lead destination is not usable: ${e.message}` }); }
  }

  /*
   * THE CONVERSATION SIDE, on its own token.
   *
   * Separate from the lead sink because it outlives it: replies come days after the search that
   * found them, and a credential scoped to that search would expire exactly when it starts being
   * useful. It also arrives on its own — opening the Browser tab to check for answers hands over a
   * conversation token and no search at all.
   */
  let convo = null;
  const social = req.body?.social;
  if (social && social.api && social.token) {
    try { convo = makeConversation({ api: social.api, token: social.token }); }
    catch (e) { return res.status(400).json({ error: `that conversation endpoint is not usable: ${e.message}` }); }
  }
  if (!goal || !String(goal).trim()) return res.status(400).json({ error: 'say what the agent should do' });

  const cfg = settingsStore.read();
  if (!cfg.llmModel) return res.status(400).json({ error: 'no model configured — open the agent settings first' });

  /*
   * PRE-AUTHORISED BY THE CALLER. A job the owner explicitly TRIGGERED — pressing "Create Facebook
   * Page" in Herald — is already approved by that press; making its acts wait in the queue for a
   * SECOND approval is redundant, and parking there is what let the session idle-close before the
   * owner clicked again. So a caller may pass autoApprove:true to run this ONE job with autoAct on,
   * without touching the global setting (posts the loop composes on its own still go through the
   * queue). Per-job only — the stored default is unchanged.
   */
  const runCfg = autoApprove ? { ...cfg, autoAct: true } : cfg;

  /*
   * The job runs in the session the person is WATCHING. That is the whole point of doing this in a
   * visible browser: when the agent hits a checkpoint the human is already looking at it and can
   * click through, and the agent carries on in the same logged-in context.
   */
  let session;
  try { session = pool.get(sessionId); } catch { session = null; }
  if (!session || session.owner !== req.client.owner) {
    return res.status(409).json({ error: 'open a browser session first — the agent works in the one you are watching' });
  }
  /*
   * One live conversation per session: two agents driving the same browser would fight over the
   * same page, and the second one's first click would land on whatever the first just opened. That
   * rule stands — what changed is the answer to the second caller. It used to be a 409, which for a
   * connected organ is a dead end: it cannot see the holding job (a key sees only its own work), so
   * it cannot stop it, and it has nothing to do but fail. Four approved Herald replies sat unsent
   * for a day that way. Now the job is ACCEPTED and started when the session frees.
   */
  const free = sessionFree(session);
  if (free.release) { try { await jobs.stop(jobs.get(free.release)); } catch { /* already gone */ } }

  const job = jobs.create({
    owner: req.client.owner, goal: String(goal).trim().slice(0, 4000),
    companyId: companyId || null, profile: session.profile || null, sessionId,
    /* Clamped, because a budget is a promise about cost and a caller must not be able to ask for
       an unbounded walk by typing a big number. Omitted means the instance default, as before. */
    maxSteps: Math.min(300, Math.max(0, Math.round(Number(maxSteps) || 0))),
    maxPages: Math.min(200, Math.max(0, Math.round(Number(maxPages) || 0))),
  });
  /* The session is claimed WHEN THE JOB ACTUALLY STARTS — see the launch below. Claiming it here
     would take it from the walk still running in it, which is the one thing the queue exists to
     prevent: the second caller would own the session while the first was still clicking in it. */
  job.sink = sink ? { label: sink.label, searchId: sink.searchId } : null;
  job.role = roles.canonical(role);

  /*
   * MOVING BETWEEN LOGINS MID-JOB.
   *
   * "Search LinkedIn" is a different account from the Facebook one, and the agent has to be able to
   * go there. Reuse first: a profile that already has a session IS that login, and opening a second
   * context for the same profile would fight over the same Chromium profile directory.
   *
   * `takeover` matters here. There are only a couple of contexts to go around, and without it the
   * second switch fails on the concurrency limit rather than doing the obvious thing — the person
   * asked for LinkedIn, so close what is idle and open LinkedIn.
   */
  const switchProfile = async (name) => {
    const wanted = profiles.safeName(name);
    const leaving = (() => { try { return pool.get(job.sessionId); } catch { return null; } })();

    const existing = pool.listFor(req.client.owner).find((x) => x.profile === wanted);
    let s;
    if (existing) {
      s = pool.get(existing.sessionId);
    } else {
      const opened = await pool.createSession({
        owner: req.client.owner, maxConcurrent: req.client.maxConcurrent,
        profile: wanted, takeover: true,
      });
      s = pool.get(opened.sessionId);
    }
    s.job = job.id;

    /*
     * Let go of a THROWAWAY it has walked away from. There are two browser contexts in total, and
     * an unnamed session — the one the panel calls "throwaway (no saved cookies)" — has nothing in
     * it worth keeping the moment the agent decides it needs a real login. Holding it means the
     * next switch fails at the cap for no reason anyone could see.
     *
     * A NAMED profile is never closed here: that is somebody's logged-in browser, and they may well
     * be about to go back to it.
     */
    if (leaving && leaving.id !== s.id && !leaving.profile) {
      await pool.close(leaving.id, 'the agent moved to a stored login').catch(() => {});
    }
    return s;
  };

  // Deliberately not awaited: the loop outlives this request by design, and the client follows it
  // over the websocket.
  /*
   * NO SEARCH? OPEN ONE.
   *
   * A conversation started from the Browser tab had nowhere to put what it found, so its leads sat
   * in a job file nobody reads — twenty-nine of them, in the run that exposed this. Anything the
   * agent finds belongs in the library regardless of which door the person came through.
   */
  const started = (async () => {
    if (sink || !convo) return sink;
    try {
      const r = await convo.openSearch(String(goal).slice(0, 200));
      const s2 = makeSink({ api: social.api.replace(/\/social$/, '/leads/browser'), searchId: r.searchId, token: r.token });
      job.sink = s2 ? { label: s2.label, searchId: s2.searchId } : null;
      jobs.step(job, 'note', `leads from this conversation go to LeadFlow search #${r.searchId}`);
      return s2;
    } catch (e) {
      jobs.step(job, 'error', `could not open a LeadFlow search — leads will stay here only: ${e.message}`);
      return null;
    }
  })();

  /*
   * THE LAUNCH, which may be now or may be when the session frees. Everything above has already
   * happened — the job exists, it has its id and its role — so a queued caller gets the same answer
   * shape it always did and polls the same way; only the start is deferred.
   */
  const launch = (useSession) => started.then((s2) => agent.run({ job, session: useSession || session, settings: runCfg, switchProfile, sink: s2 || sink, convo,
    // A caller picks a NAME. The prompt and the tool set are resolved from the registry
    // server-side, so nothing can inject instructions or hand itself a tool.
    role: roles.canonical(role),
    /* The app this job was sent to test, if it was sent to one. agent.js honours it only for a
       role that declared trustsOwnOrigin, and only on that exact origin — see ownGround(). */
    ownOrigin: ownOrigin ? String(ownOrigin) : null,
    /* Whether anyone is watching. A console conversation parks at its step limit so a person can
       say "carry on"; a job the master dispatched has nobody coming, so it concludes and hands the
       session back instead of sitting idle for half an hour with its findings unwritten. */
    unattended: !!unattended,
    log })).catch((e) => {
    log.error(`[agent] ${job.id} died: ${e.message}`);
    jobs.finish(job, 'failed', e.message);
  });

  if (free.free) {
    session.job = job.id;
    launch();
    return res.json({ jobId: job.id, ...jobs.view(job) });
  }

  /*
   * WAITING, NOT REFUSED. The queue holds the launcher; pumpQueues starts it when the session comes
   * free. 202 rather than 200 so a caller that cares can tell "queued" from "running", and the body
   * carries the position so a person can be told they are second in line instead of "it failed".
   */
  const q = queueFor(sessionId);
  if (q.length >= QUEUE_MAX) {
    jobs.finish(job, 'failed', 'the browser already has ' + q.length + ' jobs waiting on that session');
    return res.status(503).json({ error: 'the browser already has ' + q.length + ' jobs waiting on that session — try again once it has caught up', jobId: job.id });
  }
  q.push({ jobId: job.id, at: Date.now(), start: (useSession) => { useSession.job = job.id; return launch(useSession); } });
  log.info?.(`[queue] session ${sessionId}: ${job.id} is ${q.length} in line (held by ${free.heldBy} — ${free.why})`);
  return res.status(202).json({
    jobId: job.id, ...jobs.view(job),
    queued: true, position: q.length, heldBy: free.heldBy, why: free.why,
    note: 'the browser is busy — this is queued and starts on its own when the session frees',
  });
});

/*
 * THE SESSION QUEUE — one conversation at a time, and everyone else waits their turn.
 *
 * A browser session holds one conversation because two agents driving one page would fight over
 * it. That rule is right; refusing the second caller was not. Live, four approved Herald replies
 * died on "that session already has a conversation" — held by another organ's job, which Herald
 * could not even see, let alone stop. Now the second job is accepted and started when the session
 * frees, which is what every caller wanted the 409 to mean.
 *
 * Polled rather than event-driven ON PURPOSE: a job can end through finish, stop, an error, an
 * abort or a process that simply moved on, and a queue that hooks four of those five is a queue
 * that strands work on the fifth.
 */
const QUEUE_MAX = 20;
const QUEUE_TTL_MS = 60 * 60 * 1000;   // nobody wants a reply that has waited an hour
const sessionQueues = new Map();       // sessionId -> [{ jobId, at, start }]

function queueFor(sessionId) {
  if (!sessionQueues.has(sessionId)) sessionQueues.set(sessionId, []);
  return sessionQueues.get(sessionId);
}

/** Where this job stands in its session's line, 1-based. 0 means it is not waiting. */
function queuePosition(jobId) {
  for (const q of sessionQueues.values()) {
    const i = q.findIndex((x) => x.jobId === jobId);
    if (i >= 0) return i + 1;
  }
  return 0;
}

/*
 * Is this session free for the next job, and may we take it?
 *   running  → no. A live walk is never interrupted for something queued behind it.
 *   idle     → yes, and the parked conversation is closed — idle means finished and waiting for a
 *              "carry on" that nobody typed. Unless it owes a decision: a pending act is the
 *              owner's to answer and is never discarded to make room.
 *   over     → yes.
 */
function sessionFree(session) {
  const held = session && session.job && jobs.get(session.job);
  if (!held || jobs.isOver(held)) return { free: true };
  const pending = (held.proposals || []).some((p) => p && p.state === 'pending');
  if (held.status === 'idle' && !pending) return { free: true, release: held.id };
  return { free: false, heldBy: held.id, why: pending ? 'it is waiting for your decision on an act' : 'a walk is running in it' };
}

/** Start whatever is next in line on any session that has come free. Safe to call often. */
async function pumpQueues(log = console) {
  for (const [sessionId, q] of sessionQueues) {
    if (!q.length) { sessionQueues.delete(sessionId); continue; }
    /* A caller that gave up is not kept alive by us. */
    while (q.length && Date.now() - q[0].at > QUEUE_TTL_MS) {
      const dead = q.shift();
      try { const j = jobs.get(dead.jobId); if (j) jobs.finish(j, 'failed', 'waited over an hour for the browser and gave up'); } catch { /* gone */ }
    }
    if (!q.length) continue;
    let session = null;
    try { session = pool.get(sessionId); } catch { session = null; }
    if (!session) {
      /* The session it was queued on is gone; nothing can run there. Say so on each job. */
      for (const x of q.splice(0)) {
        try { const j = jobs.get(x.jobId); if (j) jobs.finish(j, 'failed', 'the browser session it was waiting for was closed'); } catch { /* gone */ }
      }
      continue;
    }
    const state = sessionFree(session);
    if (!state.free) continue;
    if (state.release) { try { await jobs.stop(jobs.get(state.release)); } catch { /* already gone */ } }
    const next = q.shift();
    try {
      log.info?.(`[queue] session ${sessionId}: starting ${next.jobId} (${q.length} still waiting)`);
      await next.start(session);
    } catch (e) {
      log.error?.(`[queue] ${next.jobId} failed to start: ${e.message}`);
      try { const j = jobs.get(next.jobId); if (j) jobs.finish(j, 'failed', e.message); } catch { /* gone */ }
    }
  }
}
setInterval(() => { pumpQueues().catch(() => {}); }, 5000).unref?.();
const myJob = (req) => {
  const j = jobs.get(req.params.id);
  if (!j || j.owner !== req.client.owner) throw Object.assign(new Error('no such job'), { status: 404 });
  return j;
};

app.get('/v1/agent/jobs/:id', authed, (req, res) => {
  try {
    const j = myJob(req);
    const place = queuePosition(j.id);
    /* A caller polling a queued job must not read it as 'running and doing nothing'. */
    res.json({ ...jobs.view(j), ...(place ? { queued: true, position: place } : {}) });
  } catch (e) { fail(res, e); }
});

/* Talking to it while it works. Queued rather than injected mid-action: an agent halfway through
   typing should finish the keystroke and then read the note. */
app.post('/v1/agent/jobs/:id/say', authed, (req, res) => {
  try {
    const j = myJob(req);
    // Idle is exactly when you most want to say something: it has reported and is waiting.
    if (jobs.isOver(j)) return res.status(409).json({ error: `that conversation is ${j.status} — start a new one` });
    res.json(jobs.say(j, String(req.body?.text || '')));
  } catch (e) { fail(res, e); }
});

/* The approval. `edit` rewrites the text before it is sent, which is the normal case — the agent
   gets the person right and the wording nearly right. */
app.post('/v1/agent/jobs/:id/proposals/:pid', authed, (req, res) => {
  try {
    const j = myJob(req);
    const decision = req.body?.approve ? 'approved' : 'skipped';
    const p = jobs.decide(j, req.params.pid, decision, req.body?.edit);
    if (!p) return res.status(404).json({ error: 'no such proposal' });
    res.json(p);
  } catch (e) { fail(res, e); }
});

app.post('/v1/agent/jobs/:id/stop', authed, (req, res) => {
  try { res.json(jobs.view(jobs.stop(myJob(req)))); } catch (e) { fail(res, e); }
});

/*
 * WHAT THE AGENT HAS LEARNED ABOUT THE OWNER.
 *
 * Readable and deletable, deliberately. This is a profile of a person, built from their own
 * accounts — the only version of that worth building is one they can read back and correct. It is
 * also the thing that makes a reply sound like them rather than like software, so it is worth
 * showing off rather than hiding in a file.
 */
app.get('/v1/agent/me', authed, (_req, res) => res.json(me.summary()));

app.put('/v1/agent/me', authed, (req, res) => {
  const cur = me.read();
  const next = { ...cur };
  if (typeof req.body?.name === 'string') next.name = req.body.name.trim().slice(0, 200);
  if (typeof req.body?.style === 'string') next.style = req.body.style.trim().slice(0, 2000);
  if (req.body?.facts && typeof req.body.facts === 'object') next.facts = req.body.facts;
  // Editing a sample would defeat the point — they are evidence of how someone writes. Removing one
  // is different, and is the whole reason this is editable at all.
  if (Array.isArray(req.body?.samples)) next.samples = req.body.samples.slice(0, 40);
  me.save(next);
  res.json(me.summary());
});

app.delete('/v1/agent/me', authed, (_req, res) => { me.forget(); res.json(me.summary()); });

/* The leads are the product, and a list trapped in a browser tab is not a deliverable. */
app.get('/v1/agent/jobs/:id/leads.csv', authed, (req, res) => {
  try {
    const j = myJob(req);
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [['found', 'name', 'why', 'quote', 'contact', 'url'].join(',')]
      .concat(j.leads.map((l) => [l.at, l.name, l.why, l.quote, l.contact, l.url].map(esc).join(',')));
    res.type('text/csv').attachment(`leads-${j.id}.csv`).send(rows.join(String.fromCharCode(10)));
  } catch (e) { fail(res, e); }
});

/*
 * THE EXIT. Owned by whoever runs this, not by the platform underneath it.
 *
 * Everything here is gated on the console account rather than an API key: connecting a tailnet is
 * an act of the owner, and an auth key is a credential that should never travel in a script's
 * config.
 */
app.get('/v1/tailscale/status', authed, async (_req, res) => {
  try { res.json(await tailscale.status()); }
  catch (e) { fail(res, e); }
});

app.post('/v1/tailscale/up', authed, async (req, res) => {
  try {
    const out = await tailscale.up({ authKey: req.body && req.body.authKey ? String(req.body.authKey).trim() : null, log });
    // The key is used and forgotten — it is never written to the profile or echoed back.
    res.json(out);
  } catch (e) { fail(res, e); }
});

app.post('/v1/tailscale/exit-node', authed, async (req, res) => {
  try { res.json(await tailscale.setExitNode(req.body && req.body.node)); }
  catch (e) { fail(res, e); }
});

app.post('/v1/tailscale/down', authed, async (_req, res) => {
  try { res.json(await tailscale.down()); }
  catch (e) { fail(res, e); }
});

/** The page as text — what an extraction step reads, once there is one. */
/*
 * A DOM PROBE, so a sweep that returns nothing can be told apart from a page that changed shape.
 * It reports how each of the extractor's routes fares against the LIVE markup and hands back a
 * sample of the nodes that look like posts — which is the only way to fix a selector that a
 * synthetic test cannot, because it is the real site that moved.
 */
app.get('/v1/sessions/:id/probe', async (req, res) => {
  try {
    const s = mine(req);
    const out = await s.page.evaluate(() => {
      const r = { url: location.href, chars: (document.body?.innerText || '').length };
      const RE = /urn:li:activity:(\d+)/;
      // how many elements carry the urn, by route
      r.byAttrSelector = document.querySelectorAll('[data-urn],[data-id],[data-entity-urn],[data-chameleon-result-urn],[data-activity-urn]').length;
      let scan = 0, href = 0;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const a = el.attributes; if (!a) continue;
        for (let i = 0; i < a.length; i++) { if (RE.test(a[i].value || '')) { scan++; break; } }
      }
      r.anyAttrHasUrn = scan;
      href = document.querySelectorAll('a[href*="urn:li:activity:"]').length;
      r.hrefHasUrn = href;
      // the attribute NAMES actually present on likely post containers, and a sample of one
      const long = Array.from(document.querySelectorAll('div,article,li,section'))
        .filter((e) => (e.innerText || '').trim().length > 120)
        .sort((a, b) => (b.innerText.length - a.innerText.length));
      r.longNodeCount = long.length;
      const sample = long.slice(0, 3).map((e) => ({
        tag: e.tagName.toLowerCase(),
        attrs: Array.from(e.attributes).map((x) => x.name + '=' + String(x.value).slice(0, 80)),
        cls: (e.className || '').toString().slice(0, 200),
        html: e.outerHTML.slice(0, 900),
      }));
      r.sample = sample;
      // any data-* attribute anywhere whose NAME contains 'urn' or 'activity'
      const names = new Set();
      for (const el of Array.from(document.querySelectorAll('*')).slice(0, 4000)) {
        for (const a of Array.from(el.attributes || [])) {
          if (/urn|activity|chameleon|entity/i.test(a.name)) names.add(a.name);
        }
      }
      r.urnishAttrNames = Array.from(names).slice(0, 40);

      // The href patterns present, bucketed — the post permalink shape shows up here if it exists.
      const hrefs = {};
      for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 800)) {
        const h = a.getAttribute('href') || '';
        const key = h.replace(/[0-9]+/g, 'N').replace(/\?.*$/, '').slice(0, 60);
        hrefs[key] = (hrefs[key] || 0) + 1;
      }
      r.hrefShapes = Object.entries(hrefs).sort((a, b) => b[1] - a[1]).slice(0, 25);

      // ACTUAL posts: a container holding an author link (/in/ or /company/) and real body text.
      const authorLinks = Array.from(document.querySelectorAll('a[href*="/in/"], a[href*="/company/"]'));
      const seen = new Set(); const posts = [];
      for (const a of authorLinks) {
        let node = a;
        for (let i = 0; i < 12 && node.parentElement; i++) {
          if ((node.innerText || '').trim().length > 200) break;
          node = node.parentElement;
        }
        if (seen.has(node)) continue; seen.add(node);
        posts.push(node);
      }
      r.postishCount = posts.length;

      // The per-post container: walk the feed list's children directly. This is the selector the
      // extractor actually needs, rather than a heuristic that overshoots to the whole feed.
      const feedRoot = document.querySelector('[data-testid="mainFeed"], [data-finite-scroll-hotkey-context], main [role="list"]');
      r.feedRootFound = !!feedRoot;
      if (feedRoot) {
        const kids = Array.from(feedRoot.children).filter((k) => (k.innerText || '').trim().length > 40);
        r.feedChildCount = kids.length;
        r.feedChildren = kids.slice(0, 3).map((k) => ({
          tag: k.tagName.toLowerCase(),
          attrs: Array.from(k.attributes).map((x) => x.name + '=' + String(x.value).slice(0, 70)),
          text: (k.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
          authorLinks: Array.from(k.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')).slice(0, 3).map((a) => a.getAttribute('href').slice(0, 60)),
          allLinks: Array.from(k.querySelectorAll('a[href]')).map((a) => a.getAttribute('href').slice(0, 70)).filter((h) => /update|posts|activity|feed\/update/.test(h)).slice(0, 5),
        }));
      }
      r.postSamples = posts.slice(0, 2).map((e) => ({
        tag: e.tagName.toLowerCase(),
        attrs: Array.from(e.attributes).map((x) => x.name + '=' + String(x.value).slice(0, 60)),
        textHead: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
        links: Array.from(e.querySelectorAll('a[href]')).slice(0, 8).map((x) => x.getAttribute('href').slice(0, 80)),
        times: Array.from(e.querySelectorAll('time')).map((t) => (t.getAttribute('datetime') || '') + '|' + (t.innerText || '').slice(0, 20)),
        html: e.outerHTML.slice(0, 1400),
      }));
      return r;
    });
    res.json(out);
  } catch (e) { fail(res, e); }
});

app.get('/v1/sessions/:id/content', async (req, res) => {
  try {
    const s = mine(req);
    const content = await s.page.evaluate(() => {
      const junk = document.querySelectorAll('script, style, noscript, svg, iframe');
      junk.forEach((n) => n.remove());
      const main = document.querySelector('main, article, [role="main"]') || document.body;
      return (main.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    });
    res.json({ url: s.page.url(), title: await s.page.title().catch(() => ''), chars: content.length, content: content.slice(0, 200000) });
  } catch (e) { fail(res, e); }
});

app.get('/v1/sessions/:id/screenshot', async (req, res) => {
  try {
    const s = mine(req);
    const buf = await s.page.screenshot({ type: 'jpeg', quality: 80 });
    res.type('jpeg').send(buf);
  } catch (e) { fail(res, e); }
});

// ── Lifecycle ───────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  log.info(`listening on ${PORT} · ${keys.size} key(s) · max ${LIMITS.maxContexts} sessions`);
  // An exit that disappears on restart is worse than no exit: a profile routed through the tailnet
  // would quietly point at a dead port, or fall back to the address it was configured to avoid.
  tailscale.resumeIfConfigured(log).catch(() => {});
  if (!keys.size) log.warn('API_KEYS is not set — every request will be refused until it is');
  // Resume any automation run a restart interrupted — a deploy mid-run must not strand it. Delayed a
  // beat so settings/pool are warm; fire-and-forget, so it never blocks startup.
  setTimeout(() => {
    try {
      const owner = consoleOwner(); if (!owner) return;
      const n = workflows.recoverRuns({ runAgent: makeRunAgent({ owner, maxConcurrent: 2 }), runVerify: makeRunVerify({ owner, maxConcurrent: 2 }), runFetch: makeRunFetch({ owner, maxConcurrent: 2 }), persist: workflows.persistRun, log });
      if (n) log.info(`[workflow] found ${n} interrupted run(s) to resume`);
    } catch (e) { log.error(`[workflow] recovery failed: ${(e && e.message) || e}`); }
  }, 5000);
});

/*
 * A browser does not survive SIGTERM on its own, and an orphaned Chromium keeps a node's memory
 * until something kills it. Close the sessions, then the browser, then go.
 */
const bye = async (sig) => {
  log.info(`${sig} — closing sessions`);
  server.close();
  await pool.shutdown();
  process.exit(0);
};
/*
 * THE LIVE VIEW. Screencast frames out, real input events in — the difference between looking at a
 * picture of a browser and using one.
 */
/*
 * WHO IS AT THE SOCKET DOOR. The cookie is the PERSON who owns this browser, signed in to their own
 * console; a key is a program. The distinction matters for what they may WATCH: an organ's walk is
 * owned by the key's owner, and without this flag the owner pressed Watch on her own running job
 * and got a refused socket and a black viewport, while Herald over REST showed it progressing.
 * The REST door has carried `console: true` since v194; the sockets are the same door.
 */
const wsAuth = (req, url) => {
  const who = accounts.verifyToken(accounts.readCookie(req));
  if (who) return { owner: who.username, console: true };
  const k = url.searchParams.get('key');
  const found = k && keys.get(k);
  return found ? { owner: found.owner } : null;
};

/* The agent's own socket. Separate path, same door. */
require('./agent-ws').attach({ server, logger: log, authorize: wsAuth });

require('./live').attach({
  server,
  pool,
  logger: log,
  authorize: (req, url) => {
    // Same two doors as the REST API: the owner's cookie, or a key for a program. The cookie is the
    // console, and the console may watch any session in this browser — see wsAuth above.
    const who = accounts.verifyToken(accounts.readCookie(req));
    if (who) return { owner: who.username, console: true };
    const k = url.searchParams.get('key');
    const found = k && keys.get(k);
    return found ? { owner: found.owner } : null;
  },
});

process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));

module.exports = { app, pool };
