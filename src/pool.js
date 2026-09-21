/**
 * pool.js — one Chromium, many contexts, and the limits that keep it alive.
 *
 * The naive design for this service is a browser per request, and it is how the service dies in
 * week one: Chromium is a couple of hundred megabytes before it has opened anything, so a dozen
 * concurrent users is a dozen browsers and an OOM kill.
 *
 * A browser CONTEXT is the thing to hand out instead. It has its own cookies, storage and cache —
 * full isolation, which is why this is a capacity decision and not a security compromise — but it
 * shares the browser process. That is roughly the difference between two sessions per pod and ten.
 *
 * Everything else here exists because a browser is a live process rather than a request:
 *
 *   - contexts are capped, and the cap is checked BEFORE one is created, never after;
 *   - a context nobody has touched for a few minutes is closed, because most sessions are
 *     abandoned rather than ended;
 *   - every session has an absolute deadline, because nothing legitimate needs two hours and a
 *     leak always does;
 *   - the process watches its own memory and refuses new work before the kernel decides for it.
 *
 * The numbers are defaults, not truths. They are the starting points from the plan and they are
 * meant to be measured against a real workload and moved.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// Where a named profile's cookies live. Mounted from a volume, so a login outlives the pod.
const PROFILE_DIR = process.env.PROFILE_DIR || '/profiles';
const profiles = require('./profiles');
const diag = require('./diagnostics');
const { makeRecorder } = require('./recorder');

const NUM = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

const LIMITS = {
  /*
   * DERIVED FROM MEMORY, NOT TYPED. A named profile is a whole Chromium and costs about 1.1 GiB in
   * practice (renderers seen at 885 MB on a Facebook feed). Advertising 8 on a 4 GiB pod meant three
   * sessions took it to 80% and it started draining — refusing EVERYONE, the owner's console
   * included — instead of refusing the fourth cleanly. MAX_CONTEXTS still overrides for an install
   * that knows better.
   */
  maxContexts:        NUM(process.env.MAX_CONTEXTS, contextsMemoryAffords()),
  maxPagesPerContext: NUM(process.env.MAX_PAGES_PER_CONTEXT, 3),
  idleMs:             NUM(process.env.IDLE_MS, 5 * 60 * 1000),
  ttlMs:              NUM(process.env.SESSION_TTL_MS, 2 * 60 * 60 * 1000),
  memoryPct:          NUM(process.env.MEMORY_LIMIT_PCT, 80),
  sweepMs:            NUM(process.env.SWEEP_MS, 15 * 1000),
};

const VIEWPORT = { width: 1280, height: 800 };

/*
 * HEADLESS IS THE THING BEING DETECTED.
 *
 * Facebook's login went: password accepted → reCAPTCHA Enterprise → solve the fire hydrants →
 * straight back to the login page. Solving the challenge correctly and being bounced anyway is the
 * signature of a risk SCORE, not a failed puzzle: reCAPTCHA Enterprise decides before you click,
 * and headless Chromium is one of the strongest signals it has. The stealth plugin patches the
 * obvious JavaScript tells (navigator.webdriver and friends); it cannot make a browser with no
 * display, no GPU and no window manager look like a laptop.
 *
 * Running headful inside Xvfb does. It is the same Chromium, with a real X display, real window
 * dimensions and a real compositor — the difference is not a flag being hidden, it is the flag
 * being untrue.
 *
 * HEADLESS=true still forces the old behaviour, because a scrape that never meets a challenge does
 * not need the extra memory a headful browser costs.
 */
const HEADLESS = String(process.env.HEADLESS || '').toLowerCase() === 'true';

/*
 * --disable-blink-features=AutomationControlled removes the flag that puts `navigator.webdriver`
 * true at the source, rather than patching it afterwards where a determined check can notice the
 * patch. The rest are what make Chromium survive in a container at all.
 */
const CF_CHALLENGE_IP = process.env.CF_CHALLENGE_IP || '104.18.94.41'; // Cloudflare Turnstile challenge IPv4 (brunhild.* is IPv6-only)
const CHROME_ARGS = [
  '--host-resolver-rules=MAP challenges.cloudflare.com ' + CF_CHALLENGE_IP + ',MAP *.challenges.cloudflare.com ' + CF_CHALLENGE_IP, // beat Turnstile: brunhild.* is IPv6-only and SOCKS remote-DNS SERVFAILs on it, so the checkbox never verifies. Pin the challenge domains to a CF IPv4 so the browser connects to an IP through the exit (CF serves by SNI).
  '--no-sandbox',
  '--disable-dev-shm-usage',            // /dev/shm is tiny in containers; without this it crashes under load
  '--disable-blink-features=AutomationControlled',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
];

/*
 * HOW MUCH MEMORY ARE WE ALLOWED?
 *
 * Reading the cgroup limit rather than the node's total RAM: in Kubernetes the container is the
 * boundary that matters, and os.totalmem() reports the whole machine, which would make a 4 GB pod
 * on a 64 GB node look like it had endless headroom right up until it was killed.
 */
/** How many whole browsers this pod can hold before the memory guard would start refusing. */
function contextsMemoryAffords() {
  const PER_BROWSER = 1.15 * 1024 * 1024 * 1024;
  try { return Math.max(1, Math.floor(memoryLimitBytes() / PER_BROWSER)); } catch { return 3; }
}

function memoryLimitBytes() {
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (raw && raw !== 'max') {
        const n = Number(raw);
        // A cgroup with no limit reports a number close to the machine's RAM; treat that as unset.
        if (Number.isFinite(n) && n > 0 && n < os.totalmem() * 0.95) return n;
      }
    } catch { /* not cgroup v2, or not in a container */ }
  }
  return os.totalmem();
}

function memoryUsedBytes() {
  for (const p of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try {
      const n = Number(fs.readFileSync(p, 'utf8').trim());
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* fall through */ }
  }
  // Outside a container, our own RSS is the only honest number available — it undercounts the
  // browser's separate processes, so treat it as a floor rather than the truth.
  return process.memoryUsage().rss;
}

/*
 * REGISTER THE STEALTH PLUGIN ONCE.
 *
 * `chromium.use(...)` mutates a module-level plugin list, so calling it per launch registers the
 * plugin again — and each copy appends its own arguments. A failing launch that retried a few times
 * produced a command line carrying `--disable-blink-features=AutomationControlled` ELEVEN times,
 * growing by one on every attempt. Harmless-looking, and the sort of thing that eventually trips a
 * command-line length limit or a fingerprinter counting duplicate flags.
 */
let _chromium = null;
function stealthChromium() {
  if (_chromium) return _chromium;
  const { chromium } = require('playwright-extra');
  chromium.use(require('puppeteer-extra-plugin-stealth')());
  _chromium = chromium;
  return _chromium;
}

/*
 * A PROFILE OUTLIVES THE POD THAT WAS USING IT.
 *
 * Chromium writes SingletonLock into a profile directory, containing the hostname and pid of the
 * process that holds it, and refuses to open a profile another process appears to be using. That is
 * exactly right on a desktop and exactly wrong here: the profile lives on a volume, the pod that
 * held it is gone, and its hostname will never exist again. The error even says so —
 * "in use by another Chromium process (30) on another computer (cmp-ghost-browser-app-…)" — and
 * without clearing it the profile is permanently unopenable after any restart.
 *
 * Only ever called when no session in THIS process holds the profile, which is the one case where
 * the lock could be real rather than stale.
 */
function clearStaleProfileLock(dir, log = console) {
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const p = path.join(dir, f);
    try {
      // lstat, not stat: SingletonLock is a symlink pointing at a host that no longer resolves, so
      // stat() throws ENOENT on a file that is definitely there and would silently skip the unlink.
      fs.lstatSync(p);
      fs.unlinkSync(p);
      log.warn?.(`[pool] cleared a stale ${f} in ${dir} — left by a pod that no longer exists`);
    } catch { /* not there, which is the normal case */ }
  }
}

/*
 * REFUSE WEBAUTHN, RATHER THAN PRETEND TO HAVE IT.
 *
 * A pod has no fingerprint reader, no TPM and no Secure Enclave. A site that asks for a passkey gets
 * a promise that nothing will ever settle, and Facebook's two-factor page is the worst case of it:
 * the button spins forever and its own "try another way" link stops responding, because the page is
 * still waiting on the request it made. There is no way out from inside that page.
 *
 * Two ways to unstick it, and only one of them is safe.
 *
 *   A virtual authenticator (CDP WebAuthn.addVirtualAuthenticator) answers the call — and if it is
 *   set to approve automatically, a site can REGISTER a passkey against it. Those credentials live
 *   in the CDP session and vanish with it, so the next login would expect a passkey that no longer
 *   exists anywhere. That turns a login you can still complete by other means into one you cannot.
 *
 *   Refusing outright is the other. NotAllowedError is exactly what a real browser returns when the
 *   user dismisses the prompt, so every site already handles it: the fallback appears immediately.
 *   Nothing can be registered because nothing is ever offered.
 *
 * This is the refusal. It is per-profile and off by default — a site that genuinely needs a security
 * key should be allowed to say so.
 */
function passkeyRefusalScript() {
  const c = navigator.credentials;
  if (!c) return;
  // The delay is not cosmetic. A rejection that arrives in the same tick as the call looks
  // synthetic, and some pages treat an instant failure as "no authenticator, do not offer this
  // route" rather than "the person declined" — which hides the fallback we are trying to reach.
  const declined = () => new Promise((_, reject) => setTimeout(
    () => reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')), 450));
  const wrap = (orig) => function (options) {
    // Only WebAuthn. Password and federated credentials go through the same two methods, and
    // breaking those would log people out of things that have nothing to do with passkeys.
    if (options && options.publicKey) return declined();
    return orig.apply(this, arguments);
  };
  const get = c.get.bind(c);
  const create = c.create.bind(c);
  c.get = wrap(get);
  c.create = wrap(create);
  // Sites check this BEFORE prompting to decide whether to offer a passkey at all. Answering no
  // here is what makes a well-built site skip straight to the code, never showing the button.
  if (window.PublicKeyCredential) {
    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
    window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  }
}

async function refusePasskeys(context, log = console) {
  // Named rather than inline so it can be exercised without a browser — the whole risk here is a
  // wrapper that catches more than WebAuthn, and that is testable in a second against a stub.
  await context.addInitScript(passkeyRefusalScript);
  log.info?.('[pool] passkey prompts will be refused for this session');
}

/**
 * Follow the browser's own idea of what is in front.
 *
 * Sign-in flows open popups and this console only ever streamed the page a session started with, so
 * a Google sign-in window was invisible and every click went to the form behind it. Attached to the
 * CONTEXT rather than the page, because the popup does not exist yet when the session is created.
 */
/*
 * THE ROUTE-CARD RECORDER, attached to the CONTEXT so it hears every page including popups. It does
 * nothing until a Herald walk ARMS it (session.recorder.arm) — so an ordinary run records nothing —
 * and even then it only listens to requests Chromium already makes. Best-effort like followPopups: a
 * context that cannot emit request events simply learns no cards, which is where things stand without
 * this at all.
 */
function attachRecorder(context, session, makeRecorder, log = console) {
  if (!session.recorder) session.recorder = makeRecorder({ log });
  if (typeof context.on !== 'function') return;
  context.on('request', (req) => {
    if (!session.recorder.armed) return;   // the cheap common case: nothing to do
    try {
      session.recorder.observe({
        method: req.method(), url: req.url(),
        headers: req.headers(), postData: req.postData() || '',
      });
    } catch { /* a request we cannot read is not worth failing a walk over */ }
  });
}

function followPopups(context, session, log = console) {
  // Never fail a session over this. Following windows is a convenience on top of a working browser,
  // and a context that cannot emit events is still a context somebody can drive.
  if (typeof context.on !== 'function') return;

  /*
   * Attached to EVERY page, not just popups.
   *
   * It used to be wired only inside the 'page' handler, so it watched windows that opened later and
   * never the one a session started with. When Facebook closed that original page — which it does:
   * a popup that finishes, a tab it replaces — nothing noticed, session.page stayed pointing at a
   * dead object, and every subsequent call threw "Target page, context or browser has been closed".
   * Three real runs died exactly there.
   */
  const watchClose = (p) => {
    if (typeof p.on !== 'function') return;
    p.on('close', () => {
      if (session.page !== p) return;
      let left = [];
      try { left = context.pages().filter((x) => !x.isClosed()); } catch { /* context gone */ }
      session.page = left[left.length - 1] || null;
      session.lastAnalysis = null;
      log.info?.(`[pool] ${session.id} back to ${session.page ? session.page.url() : 'nothing'}`);
    });
  };

  for (const p of (context.pages?.() || [])) watchClose(p);

  context.on('page', (p) => {
    session.page = p;
    session.lastAnalysis = null;      // the numbers belonged to a different document entirely
    log.info?.(`[pool] ${session.id} follows a new window — ${p.url() || 'about:blank'}`);
    watchClose(p);
  });
}

/*
 * SAYING WHICH OPERATING SYSTEM THIS IS.
 *
 * Both Facebook's and LinkedIn's "was this you?" screens name the device, and both said Linux. With
 * the traffic now leaving through the owner's own connection, that is the last thing still
 * describing a datacentre — a consumer signing in from a home line on Linux is unusual enough to be
 * worth a second look, and it is the owner's own account either way.
 *
 * WHY THIS IS NOT A USER-AGENT STRING. Chrome states its platform in three places:
 *
 *     navigator.userAgent          the old string — what a naive override changes
 *     navigator.userAgentData      Client Hints, structured, untouched by that override
 *     Sec-CH-UA-Platform           a header, sent on every single request
 *
 * Change one and the other two contradict it. A real browser never disagrees with itself, so a
 * half-done override is a LOUDER signal than plain Linux. Emulation.setUserAgentOverride is the
 * only thing that sets all three together, which is why this goes through CDP rather than
 * Playwright's `userAgent` option.
 *
 * The Chrome VERSION is read from the browser actually running and never hard-coded: a string
 * naming a version this binary does not have disagrees with everything else it does.
 *
 * WHAT THIS DOES NOT DO: make the browser undetectable. Canvas, fonts, WebGL, timing and TLS all
 * still describe what this really is. It removes one specific mismatch — the one both sites showed
 * the owner — and it is worth doing for that reason and not as a disguise.
 */
const PLATFORMS = {
  windows: {
    ua: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
    // Windows 11 reports platformVersion 15.0.0 in Client Hints — an oddity of the spec, and
    // getting it wrong would be its own inconsistency.
    meta: { platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64', model: '', mobile: false },
    navPlatform: 'Win32',
  },
  mac: {
    ua: (v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
    meta: { platform: 'macOS', platformVersion: '14.6.0', architecture: 'arm', bitness: '64', model: '', mobile: false },
    navPlatform: 'MacIntel',
  },
};

/**
 * Apply it to every page this context has, and to every page it opens later — a sign-in popup still
 * announcing Linux would give away the whole thing at the exact moment it matters.
 */
async function presentAs(context, which, log = console) {
  const spec = PLATFORMS[which];
  if (!spec || typeof context.newCDPSession !== 'function') return false;

  const apply = async (page) => {
    try {
      const real = await page.evaluate(() => navigator.userAgent).catch(() => '');
      const version = (real.match(/Chrome\/([\d.]+)/) || [])[1];
      if (!version) return;    // no version to agree with means no override worth making
      const major = version.split('.')[0];
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: spec.ua(version),
        platform: spec.navPlatform,
        userAgentMetadata: {
          ...spec.meta,
          brands: [
            { brand: 'Chromium', version: major },
            { brand: 'Google Chrome', version: major },
            { brand: 'Not?A_Brand', version: '99' },
          ],
          fullVersion: version,
        },
      });
    } catch (e) {
      // Never fatal. A browser telling the truth about itself still works.
      log.warn?.(`[pool] could not present as ${which}: ${e.message}`);
    }
  };

  for (const page of (context.pages?.() || [])) await apply(page);
  if (typeof context.on === 'function') context.on('page', apply);
  log.info?.(`[pool] presenting as ${which}`);
  return true;
}

// AUTO-CAPTURE DOWNLOADS. Whenever the agent clicks a native "Download" button — ElevenLabs' audio,
// Veo's video, Gemini's full-size image, CapCut's export — the browser starts a download that would
// otherwise vanish into a temp dir. This saves EVERY such download into the cross-session file store,
// so the media stations only have to click Download and their output shows up in the Files tab. One
// handler covers every station, which is why it lives here and not in a per-tool special case.
const DL_MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
};
function captureDownloads(context, log = console) {
  if (typeof context.on !== 'function') return;
  const fileAssets = require('./fileAssets');
  context.on('download', async (download) => {
    try {
      const name = download.suggestedFilename() || `download-${Date.now()}`;
      const p = await download.path();            // resolves when the download completes
      if (!p) return;
      const bytes = fs.readFileSync(p);
      if (!bytes || !bytes.length) return;
      const ext = (name.split('.').pop() || '').toLowerCase();
      const mime = DL_MIME[ext] || 'application/octet-stream';
      const kind = /^audio\//.test(mime) ? 'audio' : /^video\//.test(mime) ? 'video' : /^image\//.test(mime) ? 'image' : 'file';
      const id = fileAssets.put({ mime, name, kind, bytes, source: 'download' });
      log.info?.(`[download] captured "${name}" (${bytes.length}B, ${kind}) → asset ${id}`);
    } catch (e) { log.warn?.(`[download] could not capture a download: ${e.message}`); }
  });
  /* THE OTHER DOOR (file engine): a site that opens the file in a NEW TAB instead of downloading it —
     Google Flow's "download", many "open" links — never fires a download event. The tab's main
     response IS the file: capture its bytes, keep the tab out of the way. */
  const fileEngine = require('./fileEngine');
  context.on('page', (p) => {
    if (typeof p.on !== 'function') return;
    p.on('response', async (r) => {
      try {
        const req = r.request(); if (!req.isNavigationRequest() || r.frame() !== p.mainFrame()) return;
        const h = r.headers() || {}; const ct = h['content-type'] || '';
        if (!fileEngine.shouldCapture(ct, h['content-length'])) return;
        const bytes = await r.body(); if (!bytes || !bytes.length) return;
        const mime = String(ct).split(';')[0].trim(); const name = fileEngine.nameFrom({ contentDisposition: h['content-disposition'], url: r.url(), mime });
        let source = ''; try { source = new URL(r.url()).hostname; } catch { source = 'tab'; }
        const id = fileAssets.put({ mime, name, kind: fileEngine.kindOf(mime), bytes, source: `tab:${source}` });
        log.info?.(`[download] captured "${name}" shown in a tab (${bytes.length}B, ${fileEngine.kindOf(mime)}) → asset ${id}`);
        // the tab did its job; close it unless it is the only page the session has
        setTimeout(() => { try { if (context.pages().filter((x) => !x.isClosed()).length > 1) p.close().catch(() => {}); } catch (e) { /* gone */ } }, 1500);
      } catch (e) { /* not a file after all */ }
    });
  });
}

/* How long an idle session survives once the pod is draining. Short, because it will not be reused;
   not zero, because a walk between two slow steps has not stopped using its session. */
const DRAIN_IDLE_MS = 2 * 60 * 1000;

class BrowserPool {
  constructor({ logger = console } = {}) {
    this.log = logger;
    this.browser = null;
    this.launching = null;
    this.sessions = new Map();   // sessionId → { context, page, owner, createdAt, lastUsed, pages }
    this.perOwner = new Map();   // owner → Set(sessionId)
    this.limits = LIMITS;
    this.stats = { created: 0, closedIdle: 0, closedTtl: 0, rejected: 0 };
    this.draining = false;
    this._sweep = setInterval(() => this.sweep().catch(() => {}), LIMITS.sweepMs);
    if (this._sweep.unref) this._sweep.unref();
  }

  /*
   * One browser for the whole process, launched on first use and never per session. The stealth
   * plugin is applied here for the same reason the manager applies it: without it a headless
   * Chromium announces itself in a dozen ways and a good share of the web serves it a challenge
   * instead of a page.
   */
  async launch() {
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const browser = await stealthChromium().launch({ headless: HEADLESS, args: CHROME_ARGS });
      // If Chromium dies for its own reasons, forget it rather than handing out dead contexts.
      browser.on('disconnected', () => {
        this.log.warn?.('[pool] browser disconnected — sessions are gone');
        this.browser = null;
        this.sessions.clear();
        this.perOwner.clear();
      });
      this.browser = browser;
      this.launching = null;
      this.log.info?.('[pool] chromium up');
      return browser;
    })();
    return this.launching;
  }

  capacity() {
    const limit = memoryLimitBytes();
    const used = memoryUsedBytes();
    const pct = Math.round((used / limit) * 100);
    return {
      sessions: this.sessions.size,
      maxSessions: this.limits.maxContexts,
      memoryPct: pct,
      memoryLimitMb: Math.round(limit / 1048576),
      draining: this.draining,
      accepting: !this.draining
        && this.sessions.size < this.limits.maxContexts
        && pct < this.limits.memoryPct,
      stats: { ...this.stats },
    };
  }

  /**
   * Create a session. Every rejection here is a deliberate answer, not a failure: the caller is
   * told which limit it hit so a client can queue, back off, or upgrade rather than retry blindly.
   */
  async createSession({ owner = 'anonymous', maxConcurrent = 1, profile = null, takeover = false, reserved = false } = {}) {
    const cap = this.capacity();
    if (this.draining) {
      this.stats.rejected++;
      throw Object.assign(new Error('this worker is draining — retry, another will take it'), { status: 503, retryAfter: 5 });
    }
    if (cap.memoryPct >= this.limits.memoryPct) {
      this.stats.rejected++;
      this.log.warn?.(`[pool] refusing new session at ${cap.memoryPct}% memory`);
      throw Object.assign(new Error('this worker is at its memory ceiling'), { status: 503, retryAfter: 15 });
    }
    /*
     * THE OWNER KEEPS ONE SLOT. The person who owns this browser was queued behind their own
     * organs and saw a black screen. A reserved session may go one past the ceiling; memory above
     * still applies, because a slot is not a licence to be OOM-killed.
     */
    if (this.sessions.size >= this.limits.maxContexts + (reserved ? 1 : 0)) {
      this.stats.rejected++;
      throw Object.assign(new Error('this worker is at its session limit'), { status: 503, retryAfter: 10 });
    }
    /*
     * ONE SESSION PER USER, by default and by plan. This is both the capacity control and the
     * billing lever: a second concurrent session is a thing you sell, not a thing you leak. It is
     * checked here rather than trusted to the client, because the client is the thing that gets it
     * wrong.
     */
    const mine = this.perOwner.get(owner) || new Set();
    if (mine.size >= maxConcurrent) {
      this.stats.rejected++;
      throw Object.assign(
        new Error(`your plan allows ${maxConcurrent} concurrent session${maxConcurrent === 1 ? '' : 's'} — close the one you have, or upgrade`),
        { status: 409 });
    }

    /*
     * A NAMED PROFILE IS A DIFFERENT ANIMAL FROM A SESSION.
     *
     * An anonymous session is a context in the shared browser: cheap, isolated, and gone when it
     * closes. A named profile has to keep its cookies across restarts — you log into Facebook once,
     * solve whatever it asks, and it is still logged in next week — and Playwright can only do that
     * with a persistent context, which IS its own browser process.
     *
     * So a profile costs what a whole browser costs, and that is the honest trade for not having to
     * log in again. On a 1 GB pod it means roughly one; the cap counts them the same as any other
     * session so the ceiling still holds.
     */
    if (profile) {
      const safe = String(profile).replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'default';
      /*
       * One browser per profile, enforced here. Two Chromiums on one profile directory corrupt it,
       * and the lock that would normally prevent that is the same lock cleared below as stale —
       * so this check is what makes clearing it safe.
       *
       * TAKEOVER, because the common case is not a conflict. Closing a browser TAB does not close
       * the session behind it: open the profile on a phone, put the phone down, and the laptop is
       * refused by a session nobody is using and nobody can see. Held by the same owner, taking it
       * over is what they meant; held by someone else, it stays refused.
       */
      const holder = [...this.sessions.values()].find((o) => o.profile === safe);
      if (holder) {
        /*
         * BUSY MEANS BUSY, EVEN FOR THE SAME OWNER. Every organ job shares one key, so `owner` cannot
         * tell "the person who left this open" from "another agent mid-walk". A session actively
         * driving a job is the second case, and taking it over destroys BOTH walks: the thief gets a
         * page the victim was navigating, the victim loses its browser. Live proof: a Workshop build
         * probing olx.pl and a research walk reading Clio traded the google profile until the build
         * reported a malware hijack. 409 is the honest answer — callers already wait and retry.
         */
        const driving = holder.job && holder.job.status !== 'idle' && holder.job.status !== 'done'
          && holder.job.status !== 'failed' && holder.job.status !== 'stopped';
        if (driving) {
          this.stats.rejected++;
          throw Object.assign(
            new Error(`profile "${safe}" is busy: another job (${(holder.job && holder.job.jobId) || holder.id}) is using it right now — wait for it to finish`),
            { status: 409, blockedBy: holder.id, profile: safe, canTakeover: false, busyJob: (holder.job && holder.job.jobId) || null });
        }
        if (takeover && holder.owner === owner) {
          this.log.info?.(`[pool] taking over profile "${safe}" from ${holder.id} at its owner's request`);
          await this.close(holder.id, 'taken over by a newer session');
        } else {
          this.stats.rejected++;
          throw Object.assign(
            new Error(holder.owner === owner
              ? `profile "${safe}" is already open in another session — take it over, or close that one first`
              : `profile "${safe}" is in use by someone else`),
            { status: 409, blockedBy: holder.owner === owner ? holder.id : null, profile: safe, canTakeover: holder.owner === owner });
        }
      }
      const dir = path.join(PROFILE_DIR, safe);
      fs.mkdirSync(dir, { recursive: true });
      clearStaleProfileLock(dir, this.log);
      /*
       * The profile's own identity, not the platform's. A browser claiming Amsterdam time from a
       * Finnish datacentre IP is a mismatch a risk engine reads instantly, and that was the state
       * this shipped in — the timezone was a default nobody had matched to the exit.
       */
      const cfg = profiles.read(safe);
      const persistent = await stealthChromium().launchPersistentContext(dir, {
        headless: HEADLESS,
        viewport: VIEWPORT,
        args: CHROME_ARGS,
        acceptDownloads: true,   // so a clicked "Download" completes to a temp path we can capture
        // No userAgent unless the profile sets one: a real headful Chromium already reports a real
        // one, and overriding it with a string that disagrees with the binary is its own tell.
        ...(cfg.userAgent ? { userAgent: cfg.userAgent } : {}),
        locale: cfg.locale,
        timezoneId: cfg.timezone,
        // 'tailscale' resolves to this image's own SOCKS port; anything else is used as given.
        /* Unset means "the default", and the default is the tailnet when one is up — a datacentre
           address is never what anybody wants, and having to remember it per login is how it gets
           forgotten. An explicit 'direct' still wins. */
        ...(function () {
          const ts = require('./tailscale');
          const routeAll = require('./settings').read().routeThroughTailnet !== false;
          const px = profiles.launchProxy(cfg.proxy, ts.proxyUrl(), { routeAll });
          return px ? { proxy: px } : {};
        }()),
      });
      if (cfg.blockPasskeys) await refusePasskeys(persistent, this.log);
      if (cfg.presentAs) await presentAs(persistent, cfg.presentAs, this.log);
      captureDownloads(persistent, this.log);   // any Download button → the file store
      // LOGIN SYNC: the cookies the owner's device sent for this profile (see /v1/profiles/:name/cookies)
      try { const pf = path.join(dir, 'pending-cookies.json'); if (fs.existsSync(pf)) { let list = JSON.parse(fs.readFileSync(pf, 'utf8')); if (Array.isArray(list)) list = list.filter((c) => c && !/^(__cf_bm|cf_clearance|__cfruid|__cf_ob_info|lidc|AWSALB|AWSALBCORS|incap_ses|visid_incap)/i.test(String(c.name || ''))); if (Array.isArray(list) && list.length) { await persistent.addCookies(list); this.log.info?.(`[login-sync] ${safe}: ${list.length} cookie(s) from the owner's device applied`); } } } catch (e) { this.log.warn?.(`[login-sync] ${safe}: ${e.message}`); }
      const page = persistent.pages()[0] || await persistent.newPage();
      const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const at = Date.now();
      const session = { id, context: persistent, page, owner, profile: safe, persistent: true, createdAt: at, lastUsed: at, pages: 1, lastAnalysis: null };
      followPopups(persistent, session, this.log);
      // Listen from the first navigation — a redirect loop that starts on page one is exactly the
      // case worth catching, and attaching later would miss it. Capture is cheap; only EXPOSURE is
      // scoped (see diagnostics.js: the tool is QA's alone).
      diag.attach(page, session, this.log);
      attachRecorder(persistent, session, makeRecorder, this.log);
      this.sessions.set(id, session);
      mine.add(id);
      this.perOwner.set(owner, mine);
      this.stats.created++;
      this.log.info?.(`[pool] + ${id} (${owner}, profile "${safe}") — ${this.sessions.size}/${this.limits.maxContexts}`);
      return { sessionId: id, profile: safe, expiresAt: at + this.limits.ttlMs };
    }

    const browser = await this.launch();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      acceptDownloads: true,
      // Same reasoning as above: the platform's defaults describe where these pods actually are.
      locale: profiles.DEFAULTS.locale,
      timezoneId: profiles.DEFAULTS.timezone,
    });
    captureDownloads(context, this.log);
    const page = await context.newPage();

    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const session = { id, context, page, owner, createdAt: now, lastUsed: now, pages: 1, lastAnalysis: null };
    followPopups(context, session, this.log);
    diag.attach(page, session, this.log);   // the ephemeral path needs it too — QA runs here
    attachRecorder(context, session, makeRecorder, this.log);
    this.sessions.set(id, session);
    mine.add(id);
    this.perOwner.set(owner, mine);
    this.stats.created++;
    this.log.info?.(`[pool] + ${id} (${owner}) — ${this.sessions.size}/${this.limits.maxContexts}`);
    return { sessionId: id, expiresAt: now + this.limits.ttlMs };
  }

  /**
   * Turn the refusal on for sessions that are already open.
   *
   * The setting used to take effect only at launch, so the instruction was "reopen the session" —
   * and that is exactly the wrong thing to ask of someone who is halfway through a login, because
   * reopening lands them back at the start of it. Worse, it does not even work the way it reads:
   * closing and reopening returns to the same stuck page, so the fix looked broken.
   *
   * An init script can be added to a live context; it applies to the next document. So install it
   * and reload the page — the reload is unavoidable, because the call the page is stuck on was made
   * before anything could refuse it. Nothing about the login is lost: cookies are in the profile.
   */
  async applyPasskeyRefusal(owner, profile) {
    const touched = [];
    for (const id of (this.perOwner.get(owner) || new Set())) {
      const s = this.sessions.get(id);
      if (!s || s.profile !== profile) continue;
      try {
        await refusePasskeys(s.context, this.log);
        // Cheap and honest: a plain reload of wherever they are, not a navigation somewhere else.
        try { await s.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); }
        catch { /* a page mid-navigation reloads itself anyway */ }
        touched.push(id);
      } catch (e) {
        this.log.warn?.(`[pool] could not apply the passkey refusal to ${id}: ${e.message}`);
      }
    }
    return touched;
  }

  /**
   * EVERY session open on this install — for the owner's console only.
   *
   * A session opened by a connected tool belongs to the same person and the same browser; hiding it
   * from their console meant "watch it work" opened a page claiming nothing was running.
   */
  listAll() {
    return [...this.sessions.entries()].map(([id, s]) => {
      if (!s) return null;
      let url = 'about:blank';
      try { url = s.page.url(); } catch { /* page gone */ }
      return { sessionId: id, url, profile: s.profile || null, owner: s.owner || null, createdAt: s.createdAt, lastUsed: s.lastUsed, expiresAt: s.createdAt + this.limits.ttlMs };
    }).filter(Boolean);
  }

  /** What this caller is holding right now. Without this, hitting the limit is a dead end. */
  listFor(owner) {
    const ids = this.perOwner.get(owner) || new Set();
    return [...ids].map((id) => {
      const s = this.sessions.get(id);
      if (!s) return null;
      let url = 'about:blank';
      try { url = s.page.url(); } catch { /* page gone */ }
      return { sessionId: id, url, profile: s.profile || null, createdAt: s.createdAt, lastUsed: s.lastUsed, expiresAt: s.createdAt + this.limits.ttlMs };
    }).filter(Boolean);
  }

  async closeAllFor(owner, why = 'closed by owner') {
    const ids = [...(this.perOwner.get(owner) || new Set())];
    for (const id of ids) await this.close(id, why);
    return ids.length;
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error('no such session — it may have been closed for being idle'), { status: 404 });
    s.lastUsed = Date.now();
    return s;
  }

  async close(id, why = 'closed') {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    const mine = this.perOwner.get(s.owner);
    if (mine) { mine.delete(id); if (!mine.size) this.perOwner.delete(s.owner); }
    try { await s.context.close(); } catch { /* already gone */ }
    this.log.info?.(`[pool] - ${id} (${why}) — ${this.sessions.size}/${this.limits.maxContexts}`);
    return true;
  }

  /** Idle and expired sessions, plus the memory check that decides whether to stop taking work. */
  async sweep() {
    const now = Date.now();
    for (const [id, s] of [...this.sessions]) {
      if (now - s.lastUsed > this.limits.idleMs) { this.stats.closedIdle++; await this.close(id, 'idle'); continue; }
      if (now - s.createdAt > this.limits.ttlMs) { this.stats.closedTtl++; await this.close(id, 'expired'); }
    }
    /*
     * Chromium leaks over hours; that is not a bug anyone is going to fix for us. When memory
     * crosses the ceiling we stop accepting work and let the existing sessions finish, so the pod
     * restarts on our terms instead of being OOM-killed in the middle of somebody's run.
     */
    const cap = this.capacity();
    if (!this.draining && cap.memoryPct >= this.limits.memoryPct) {
      this.draining = true;
      this.log.warn?.(`[pool] draining at ${cap.memoryPct}% memory — no new sessions until this pod recycles`);
    }
    /*
     * AND UN-LATCH WHEN THE PRESSURE IS GONE. Draining was one-way, which deadlocked the service:
     * it latched at the ceiling, and the only way out was reaching zero sessions — but the session
     * holding it open was a two-hour research run, so nothing new could start (92 refusals) and the
     * pod could not recycle either. Memory had long since fallen back to 62%. Hysteresis, not the
     * same threshold, so a pod hovering at the line does not flap in and out of service.
     */
    if (this.draining && this.sessions.size > 0 && cap.memoryPct <= this.limits.memoryPct - 15) {
      this.draining = false;
      this.log.warn?.(`[pool] accepting again at ${cap.memoryPct}% — the pressure that started the drain is gone`);
    }
    /*
     * AND DO NOT WAIT FIVE MINUTES FOR AN IDLE SESSION TO AGE OUT. Draining stops new work, but the
     * pod only recycles once the LAST session closes, and an idle session is kept for reuse - reuse
     * that is never coming while we refuse work. A pod that latched at 80% sat at 67% (a Chromium
     * floor the 15-point hysteresis cannot reach) holding two idle sessions: not accepting, not
     * recycling, and every caller told to retry another worker that does not exist.
     *
     * A running walk touches its session every few seconds, so the grace never takes one out from
     * under a walk in progress.
     */
    if (this.draining) {
      for (const [id, s] of [...this.sessions]) {
        if (now - s.lastUsed > DRAIN_IDLE_MS) { this.stats.closedIdle++; await this.close(id, "draining"); }
      }
    }
    if (this.draining && this.sessions.size === 0) {
      this.log.warn?.('[pool] drained; exiting so the pod is replaced with a fresh one');
      setTimeout(() => process.exit(0), 250);
    }
  }

  /** Profiles already on disk — the logins you have built up, whether or not one is open now. */
  /*
   * WHAT IS A PROFILE, and what is merely a directory that happens to live here.
   *
   * The jobs, the playbooks and anything else stored beside the profiles share this volume, and
   * returning every non-hidden directory offered them as browser logins — picking one would have
   * launched Chromium against a folder of JSON.
   *
   * Asking what is INSIDE rather than keeping a list of names is the version that stays correct
   * when the next data directory is added: a profile has our settings file, or Chromium's own
   * Default directory once it has been launched at least once.
   */
  listProfiles() {
    try {
      return fs.readdirSync(PROFILE_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .filter((d) => {
          const dir = path.join(PROFILE_DIR, d.name);
          return fs.existsSync(path.join(dir, profiles.FILE))
            || fs.existsSync(path.join(dir, 'Default'))
            || fs.existsSync(path.join(dir, 'Preferences'));
        })
        .map((d) => d.name);
    } catch { return []; }
  }

  /** Every profile with what it is for, so a caller can match on the site rather than the name. */
  listProfilesDetailed() {
    return this.listProfiles().map((name) => ({ name, ...profiles.read(name) }));
  }

  /**
   * Remove a login entirely — its cookies, its settings, everything.
   *
   * Refuses one that is open: deleting a profile directory from under a running Chromium leaves a
   * browser writing into a folder that no longer exists, and the failure surfaces minutes later
   * somewhere unrelated.
   */
  async removeProfile(name) {
    const safe = profiles.safeName(name);
    for (const s of this.sessions.values()) {
      if (s.profile === safe) {
        throw Object.assign(new Error(`"${safe}" is open — close that session first`), { status: 409 });
      }
    }
    const dir = profiles.dirFor(safe);
    if (!fs.existsSync(dir)) throw Object.assign(new Error('no such profile'), { status: 404 });
    fs.rmSync(dir, { recursive: true, force: true });
    this.log.warn?.(`[pool] removed the profile "${safe}" and everything in it`);
    return safe;
  }

  /*
   * SHUTDOWN IS WHERE LOGINS ARE SAVED OR LOST, so it closes everything at once and bounds each one.
   *
   * `close()` flushes a persistent context's cookies, so a clean close is what preserves a session.
   * This loop used to run SERIALLY with no timeout, against the pod's 30 second grace period, with
   * five or six contexts open. That lost a hand-made Google login twice over: the serial total can
   * exceed the deadline so SIGKILL takes the remainder unflushed, and any one hanging context
   * starves every context after it in the map. A profile the owner signed in by hand ends up with
   * 63 cookies and no session, and the failure is completely silent.
   *
   * Parallel, so the wall clock is the slowest single close rather than the sum. Bounded, so a
   * wedged Chromium is abandoned instead of taking its neighbours' cookies with it. The cap is
   * deliberately well under a 30 second grace period, and settable for a pod that allows more.
   */
  async shutdown(opts = {}) {
    clearInterval(this._sweep);
    const perCloseMs = Math.max(1000, Number(opts.perCloseMs) || Number(process.env.POOL_CLOSE_MS) || 8000);
    const ids = [...this.sessions.keys()];
    const abandoned = [];
    const bounded = (id) => Promise.race([
      this.close(id, 'shutdown').then(() => null),
      new Promise((r) => setTimeout(() => r(id), perCloseMs)),
    ]).catch(() => id);

    for (const late of await Promise.all(ids.map(bounded))) if (late) abandoned.push(late);
    if (abandoned.length) {
      this.log.warn?.(`[pool] ${abandoned.length} context(s) would not close in ${perCloseMs}ms and were`
        + ` abandoned so the rest could flush: ${abandoned.join(', ')}`);
    }
    /* The browser itself is bounded too: hanging here would waste the same grace period. */
    try {
      await Promise.race([
        Promise.resolve(this.browser?.close()),
        new Promise((r) => setTimeout(r, perCloseMs)),
      ]);
    } catch { /* already gone */ }
    return { closed: ids.length - abandoned.length, abandoned };
  }
}

module.exports = { BrowserPool, refusePasskeys, followPopups, presentAs, PLATFORMS, passkeyRefusalScript, LIMITS, memoryLimitBytes, memoryUsedBytes, stealthChromium, CHROME_ARGS };
