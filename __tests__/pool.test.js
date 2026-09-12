/**
 * The limits that keep the service alive.
 *
 * Every assertion here is a way the service dies without it. A browser session is a live process
 * holding memory for its whole life, so "reject before creating" is not a nicety — a check made
 * after the context exists has already spent the memory it was supposed to protect.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BrowserPool, followPopups, presentAs } from '../src/pool.js';

const quiet = { info() {}, warn() {} };

// A browser that costs nothing, so the limits can be tested without launching Chromium.
function fakeBrowser() {
  const closed = [];
  return {
    closed,
    on() {},
    async newContext() {
      // A context emits 'page' when a sign-in popup opens, and the session follows it — see
      // followPopups. The stub carries that so the pool is exercised the way it really runs.
      const listeners = [];
      const pages = [];
      return {
        on(evt, fn) { if (evt === 'page') listeners.push(fn); },
        emitPage(p) { pages.push(p); listeners.forEach((fn) => fn(p)); },
        pages: () => pages,
        async newPage() {
          const p = { url: () => 'about:blank', async title() { return ''; }, isClosed: () => false, on() {} };
          pages.push(p);
          return p;
        },
        async close() { closed.push(Date.now()); },
      };
    },
    async close() {},
  };
}

function makePool(limits = {}) {
  const pool = new BrowserPool({ logger: { info() {}, warn() {} } });
  Object.assign(pool.limits, limits);
  pool.browser = fakeBrowser();
  pool.launch = async () => pool.browser;
  return pool;
}

describe('one session per user, by plan', () => {
  let pool;
  beforeEach(() => { pool = makePool(); });

  it('refuses a second concurrent session on a single-session plan', async () => {
    await pool.createSession({ owner: 'carla', maxConcurrent: 1 });
    await expect(pool.createSession({ owner: 'carla', maxConcurrent: 1 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('allows what a higher plan paid for', async () => {
    await pool.createSession({ owner: 'carla', maxConcurrent: 3 });
    await pool.createSession({ owner: 'carla', maxConcurrent: 3 });
    await expect(pool.createSession({ owner: 'carla', maxConcurrent: 3 })).resolves.toMatchObject({ sessionId: expect.any(String) });
    await expect(pool.createSession({ owner: 'carla', maxConcurrent: 3 })).rejects.toMatchObject({ status: 409 });
  });

  it("does not let one customer eat another customer's allowance", async () => {
    await pool.createSession({ owner: 'carla', maxConcurrent: 1 });
    await expect(pool.createSession({ owner: 'someone-else', maxConcurrent: 1 })).resolves.toBeTruthy();
  });

  it('frees the slot when the session closes', async () => {
    const { sessionId } = await pool.createSession({ owner: 'carla', maxConcurrent: 1 });
    await pool.close(sessionId);
    await expect(pool.createSession({ owner: 'carla', maxConcurrent: 1 })).resolves.toBeTruthy();
  });
});

describe('the worker refuses work before it hurts itself', () => {
  it('stops at the context cap and says to retry', async () => {
    const pool = makePool({ maxContexts: 2 });
    await pool.createSession({ owner: 'a', maxConcurrent: 1 });
    await pool.createSession({ owner: 'b', maxConcurrent: 1 });
    const err = await pool.createSession({ owner: 'c', maxConcurrent: 1 }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.retryAfter).toBeGreaterThan(0);
    expect(pool.stats.rejected).toBe(1);
  });

  it('refuses new sessions once memory crosses the ceiling', async () => {
    const pool = makePool();
    vi.spyOn(pool, 'capacity').mockReturnValue({ memoryPct: 95, sessions: 0, accepting: false });
    await expect(pool.createSession({ owner: 'a', maxConcurrent: 1 })).rejects.toMatchObject({ status: 503 });
  });

  it('refuses everything while draining', async () => {
    const pool = makePool();
    pool.draining = true;
    await expect(pool.createSession({ owner: 'a', maxConcurrent: 1 })).rejects.toMatchObject({ status: 503 });
  });
});

describe('sweeping', () => {
  it('closes a session nobody has touched, because most are abandoned rather than ended', async () => {
    const pool = makePool({ idleMs: 1000 });
    const { sessionId } = await pool.createSession({ owner: 'a', maxConcurrent: 1 });
    pool.sessions.get(sessionId).lastUsed = Date.now() - 5000;
    await pool.sweep();
    expect(pool.sessions.has(sessionId)).toBe(false);
    expect(pool.stats.closedIdle).toBe(1);
  });

  it('closes a session that has run past its absolute deadline even if it is busy', async () => {
    const pool = makePool({ ttlMs: 1000, idleMs: 60000 });
    const { sessionId } = await pool.createSession({ owner: 'a', maxConcurrent: 1 });
    const s = pool.sessions.get(sessionId);
    s.createdAt = Date.now() - 5000;
    s.lastUsed = Date.now();          // actively in use — the deadline still wins
    await pool.sweep();
    expect(pool.sessions.has(sessionId)).toBe(false);
    expect(pool.stats.closedTtl).toBe(1);
  });

  /*
   * THE DEADLOCK THIS CLOSES, measured on the live pod: draining latched at the 80% ceiling and was
   * one-way, so the only exit was reaching zero sessions — but the session holding it open was a
   * two-hour research run. Memory had long since fallen back to 62%, yet the pod refused 92 new
   * sessions and could not recycle either. Nothing could start and nothing could finish it.
   */
  it('accepts again once the pressure that started the drain is gone', async () => {
    const pool = makePool();
    pool.draining = true;
    pool.sessions.set('x', { id: 'x', owner: 'a', createdAt: Date.now(), lastUsed: Date.now(), context: { close: async () => {} } });
    vi.spyOn(pool, 'capacity').mockReturnValue({ memoryPct: 62, sessions: 1, accepting: false });
    await pool.sweep();
    expect(pool.draining).toBe(false);
  });

  it('does NOT flap back the moment it dips under the line — hysteresis, not the same threshold', async () => {
    const pool = makePool();
    pool.draining = true;
    pool.sessions.set('x', { id: 'x', owner: 'a', createdAt: Date.now(), lastUsed: Date.now(), context: { close: async () => {} } });
    vi.spyOn(pool, 'capacity').mockReturnValue({ memoryPct: 78, sessions: 1, accepting: false });  // limit is 80
    await pool.sweep();
    expect(pool.draining).toBe(true);
  });

  it('with no sessions left it still recycles rather than un-latching — a fresh pod is better', async () => {
    const pool = makePool();
    pool.draining = true;
    vi.spyOn(pool, 'capacity').mockReturnValue({ memoryPct: 20, sessions: 0, accepting: false });
    // The recycle path really does call process.exit, on a 250ms timer. Hold the mock past it, or
    // the timer fires after restore and takes the whole test run down with it.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    await pool.sweep();
    expect(pool.draining).toBe(true);   // un-latching needs a live session to protect
    await new Promise((r) => setTimeout(r, 400));
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });

  it('starts draining when memory crosses the ceiling instead of waiting for the OOM killer', async () => {
    const pool = makePool();
    vi.spyOn(pool, 'capacity').mockReturnValue({ memoryPct: 90, sessions: 1, accepting: false });
    pool.sessions.set('x', { id: 'x', owner: 'a', createdAt: Date.now(), lastUsed: Date.now(), context: { close: async () => {} } });
    await pool.sweep();
    expect(pool.draining).toBe(true);
  });
});

describe('a session belongs to whoever opened it', () => {
  it('is unknown after it is closed, rather than silently reused', async () => {
    const pool = makePool();
    const { sessionId } = await pool.createSession({ owner: 'a', maxConcurrent: 1 });
    await pool.close(sessionId);
    expect(() => pool.get(sessionId)).toThrow(/no such session/i);
  });
});

/*
 * Hitting the cap must not be a dead end.
 *
 * The first time the limit fired for real, the answer was a bare "at its session limit" — no way to
 * see the session causing it, no way to drop it, and the console simply stopped working. A cap is
 * only reasonable if the thing it caps is visible and removable.
 */
describe('seeing and dropping what you hold', () => {
  it('lists only your own sessions', async () => {
    const pool = makePool({ maxContexts: 4 });
    await pool.createSession({ owner: 'carla', maxConcurrent: 2 });
    await pool.createSession({ owner: 'carla', maxConcurrent: 2 });
    await pool.createSession({ owner: 'other', maxConcurrent: 1 });
    expect(pool.listFor('carla')).toHaveLength(2);
    expect(pool.listFor('other')).toHaveLength(1);
    expect(pool.listFor('nobody')).toHaveLength(0);
  });

  it('reports each session with something useful to decide on', async () => {
    const pool = makePool();
    const { sessionId } = await pool.createSession({ owner: 'carla', maxConcurrent: 1 });
    const [s] = pool.listFor('carla');
    expect(s).toMatchObject({ sessionId, url: expect.any(String) });
    expect(s.expiresAt).toBeGreaterThan(Date.now());
  });

  it('closes everything one owner holds, and nobody else\'s', async () => {
    const pool = makePool({ maxContexts: 4 });
    await pool.createSession({ owner: 'carla', maxConcurrent: 2 });
    await pool.createSession({ owner: 'carla', maxConcurrent: 2 });
    await pool.createSession({ owner: 'other', maxConcurrent: 1 });
    expect(await pool.closeAllFor('carla')).toBe(2);
    expect(pool.listFor('carla')).toHaveLength(0);
    expect(pool.listFor('other')).toHaveLength(1);
  });

  it('frees the plan allowance, so the way out actually works', async () => {
    const pool = makePool();
    await pool.createSession({ owner: 'carla', maxConcurrent: 1 });
    await expect(pool.createSession({ owner: 'carla', maxConcurrent: 1 })).rejects.toMatchObject({ status: 409 });
    await pool.closeAllFor('carla');
    await expect(pool.createSession({ owner: 'carla', maxConcurrent: 1 })).resolves.toBeTruthy();
  });
});

/*
 * A profile outlives the pod that used it.
 *
 * Chromium writes SingletonLock into the profile directory with the hostname and pid of whatever
 * holds it, and refuses to open a profile another process appears to be using. Correct on a
 * desktop, fatally wrong on a volume: the pod that held it is gone and its hostname will never
 * exist again, so the profile becomes permanently unopenable after any restart. The live error said
 * exactly that — "in use by another Chromium process (30) on another computer
 * (cmp-ghost-browser-app-6598c6c574-gvb4g)" — and every retry failed the same way.
 *
 * Clearing the lock is only safe because of the check these tests pin: one browser per profile,
 * enforced in this process, so a lock we clear can never be one we are actually using.
 */
describe('profiles and their locks', () => {
  it('refuses to open the same profile twice', async () => {
    const pool = makePool({ maxContexts: 4 });
    pool.sessions.set('a', { id: 'a', owner: 'carla', profile: 'facebook', createdAt: Date.now(), lastUsed: Date.now(), context: { close: async () => {} } });
    pool.perOwner.set('carla', new Set(['a']));
    await expect(pool.createSession({ owner: 'someone', maxConcurrent: 2, profile: 'facebook' }))
      .rejects.toMatchObject({ status: 409 });
  });

  /* Two different situations deserve two different sentences: your own forgotten session is
     something you can take back, someone else's is not. */
  it('says which profile is in the way, and whether it is yours', async () => {
    const pool = makePool({ maxContexts: 4 });
    pool.sessions.set('a', { id: 'a', owner: 'x', profile: 'facebook', createdAt: Date.now(), lastUsed: Date.now(), context: { close: async () => {} } });
    pool.perOwner.set('x', new Set(['a']));

    const mine = await pool.createSession({ owner: 'x', maxConcurrent: 3, profile: 'facebook' }).catch((e) => e);
    expect(mine.message).toMatch(/facebook/);
    expect(mine.message).toMatch(/take it over/i);

    const theirs = await pool.createSession({ owner: 'y', maxConcurrent: 2, profile: 'facebook' }).catch((e) => e);
    expect(theirs.message).toMatch(/in use by someone else/);
    expect(theirs.canTakeover).toBe(false);
  });

  it('lets a DIFFERENT profile past the guard', async () => {
    const pool = makePool({ maxContexts: 4 });
    pool.sessions.set('a', { id: 'a', owner: 'x', profile: 'facebook', createdAt: Date.now(), lastUsed: Date.now(), context: { close: async () => {} } });
    /* A different name is a different directory, so there is no lock to fight over. This asserts
       what the guard decides, not what Chromium then does — the persistent path launches a real
       browser, which is not something a unit test should be starting. */
    const err = await pool.createSession({ owner: 'y', maxConcurrent: 2, profile: 'linkedin' }).catch((e) => e);
    expect(err?.status).not.toBe(409);
  }, 30000);
});

/*
 * Taking a profile back.
 *
 * Closing a browser TAB does not close the session behind it. Open a profile on a phone, put the
 * phone down, and the laptop is refused by a session nobody is using and nobody can see — a guard
 * that is correct and useless at the same time. Held by the same owner, taking it over is what was
 * meant; held by someone else it stays refused, because two Chromiums on one profile directory
 * corrupt it.
 */
describe('taking over a profile', () => {
  const holding = (pool, owner, profile) => {
    pool.sessions.set('held', { id: 'held', owner, profile, createdAt: Date.now(), lastUsed: Date.now(), context: { close: async () => {} } });
    pool.perOwner.set(owner, new Set(['held']));
  };

  it('tells the owner it is theirs to take', async () => {
    const pool = makePool({ maxContexts: 4 });
    holding(pool, 'carla', 'facebook');
    const err = await pool.createSession({ owner: 'carla', maxConcurrent: 3, profile: 'facebook' }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.canTakeover).toBe(true);
    expect(err.blockedBy).toBe('held');
  });

  it('closes the old session when asked to take over', async () => {
    const pool = makePool({ maxContexts: 4 });
    holding(pool, 'carla', 'facebook');
    // The persistent path launches a real browser, so this asserts the OLD session went away —
    // which is the part the takeover flag is responsible for.
    await pool.createSession({ owner: 'carla', maxConcurrent: 3, profile: 'facebook', takeover: true }).catch(() => {});
    expect(pool.sessions.has('held')).toBe(false);
  }, 30000);

  it('refuses to take over someone else\'s session, flag or not', async () => {
    const pool = makePool({ maxContexts: 4 });
    holding(pool, 'someone-else', 'facebook');
    const err = await pool.createSession({ owner: 'carla', maxConcurrent: 3, profile: 'facebook', takeover: true }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.canTakeover).toBe(false);
    expect(pool.sessions.has('held')).toBe(true);
  });
});

/**
 * Following the browser into a sign-in popup.
 *
 * Found on LinkedIn: "Continue with Google" opens a POPUP, Playwright gives it its own Page, and
 * this console was streaming exactly one — the page the session started with. So the Google window
 * existed, had focus and was waiting for an email address, while the screen showed the untouched
 * login form behind it. Every click looked ignored.
 */
describe('sign-in popups', () => {
  it('makes the new window the session’s page', async () => {
    const pool = new BrowserPool({ logger: quiet });
    pool.launch = async () => fakeBrowser();
    const { sessionId } = await pool.createSession({ owner: 'carla', maxConcurrent: 1 });
    const s = pool.sessions.get(sessionId);
    const before = s.page;

    const popup = { url: () => 'https://accounts.google.com/', isClosed: () => false, on() {} };
    s.context.emitPage(popup);

    expect(s.page).toBe(popup);
    expect(s.page).not.toBe(before);
  });

  /* The numbers came from a different document entirely. Clicking [3] after a popup opened would
     click wherever [3] happened to be on the OLD page. */
  it('throws away the element numbers, which belonged to the old page', async () => {
    const pool = new BrowserPool({ logger: quiet });
    pool.launch = async () => fakeBrowser();
    const { sessionId } = await pool.createSession({ owner: 'carla', maxConcurrent: 1 });
    const s = pool.sessions.get(sessionId);
    s.lastAnalysis = { elements: [{ index: 1 }], url: 'https://linkedin.com', scrollY: 0 };
    s.context.emitPage({ url: () => 'https://accounts.google.com/', isClosed: () => false, on() {} });
    expect(s.lastAnalysis).toBeNull();
  });

  it('does not fail a session on a browser that cannot report new windows', () => {
    const s = { id: 's', page: null };
    expect(() => followPopups({}, s, quiet)).not.toThrow();
  });
});

/**
 * Presenting as another operating system.
 *
 * The part worth pinning is that it goes through CDP and not a user-agent string. Chrome states its
 * platform in three places — navigator.userAgent, navigator.userAgentData and the
 * Sec-CH-UA-Platform header — and only Emulation.setUserAgentOverride sets all three at once.
 * Overriding just the string leaves the other two saying Linux, and a browser that contradicts
 * itself is a stronger signal than one that is merely unusual.
 */
describe('presenting as another operating system', () => {
  const fakeCtx = (ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36') => {
    const sent = [];
    const listeners = [];
    const page = { evaluate: async () => ua };
    return {
      sent, listeners, page,
      pages: () => [page],
      on(evt, fn) { if (evt === 'page') listeners.push(fn); },
      async newCDPSession() { return { send: async (m, params) => sent.push([m, params]) }; },
    };
  };

  it('sets the user agent, the Client Hints and navigator.platform together', async () => {
    const ctx = fakeCtx();
    await presentAs(ctx, 'windows', quiet);
    const [method, params] = ctx.sent[0];
    expect(method).toBe('Emulation.setUserAgentOverride');
    expect(params.userAgent).toMatch(/Windows NT 10\.0; Win64; x64/);
    expect(params.platform).toBe('Win32');
    expect(params.userAgentMetadata.platform).toBe('Windows');
  });

  /* A string naming a Chrome this binary does not have disagrees with everything else it does. */
  it('takes the Chrome version from the browser actually running', async () => {
    const ctx = fakeCtx('Mozilla/5.0 (X11; Linux x86_64) Chrome/118.0.1.2 Safari/537.36');
    await presentAs(ctx, 'windows', quiet);
    const [, params] = ctx.sent[0];
    expect(params.userAgent).toContain('Chrome/118.0.1.2');
    expect(params.userAgentMetadata.fullVersion).toBe('118.0.1.2');
    expect(params.userAgentMetadata.brands.some((b) => b.version === '118')).toBe(true);
  });

  it('does nothing at all when it cannot read a version to agree with', async () => {
    const ctx = fakeCtx('something that is not a browser');
    await presentAs(ctx, 'windows', quiet);
    expect(ctx.sent).toEqual([]);
  });

  /* A sign-in popup still announcing Linux gives it away at the exact moment it matters. */
  it('applies to windows opened later, not just the one that exists now', async () => {
    const ctx = fakeCtx();
    await presentAs(ctx, 'windows', quiet);
    expect(ctx.listeners).toHaveLength(1);
    await ctx.listeners[0](ctx.page);
    expect(ctx.sent).toHaveLength(2);
  });

  it('ignores a platform it does not have a full set of hints for', async () => {
    const ctx = fakeCtx();
    expect(await presentAs(ctx, 'freebsd', quiet)).toBe(false);
    expect(ctx.sent).toEqual([]);
  });

  it('never fails a session over it — a truthful browser still works', async () => {
    const ctx = fakeCtx();
    ctx.newCDPSession = async () => { throw new Error('no cdp here'); };
    await expect(presentAs(ctx, 'windows', quiet)).resolves.toBe(true);
  });
});
