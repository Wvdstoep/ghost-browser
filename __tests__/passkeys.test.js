/**
 * The passkey refusal, exercised without a browser.
 *
 * WHY THIS EXISTS. At Facebook's two-factor step the confirm button spun forever and the page's own
 * "try another way" link stopped responding with it. Nothing was broken: the page had called
 * navigator.credentials.get() and a container has no fingerprint reader, no TPM and no Secure
 * Enclave to answer it, so the promise simply never settled. The page was still waiting on itself,
 * and there is no way out of that from inside the page.
 *
 * The fix refuses the call instead of answering it. That choice is deliberate and it is the part
 * worth pinning: a virtual authenticator set to auto-approve would also unstick the page, and would
 * also let a site REGISTER a passkey against credentials that vanish with the session — so the next
 * login would demand a passkey that no longer exists anywhere. That converts a login you can still
 * finish another way into one you cannot.
 *
 * The other risk is the wrapper's reach. Password managers and federated sign-in go through the very
 * same two methods, so a wrapper that catches everything would log people out of things that have
 * nothing to do with passkeys. Both are checked here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { passkeyRefusalScript, BrowserPool } from '../src/pool.js';

/* Enough of a browser to run the script against: the two credential methods, and the feature-
   detection surface a site checks before it decides to offer a passkey at all. */
function fakeWindow() {
  const calls = [];
  const credentials = {
    get: vi.fn(async (o) => { calls.push(['get', o]); return { type: 'password' }; }),
    create: vi.fn(async (o) => { calls.push(['create', o]); return { type: 'password' }; }),
  };
  const win = {
    navigator: { credentials },
    PublicKeyCredential: {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      isConditionalMediationAvailable: async () => true,
    },
    DOMException: class extends Error { constructor(m, n) { super(m); this.name = n; } },
    setTimeout,
    calls,
  };
  return win;
}

const run = (win) => new Function('window', 'navigator', 'DOMException', 'setTimeout',
  `(${passkeyRefusalScript.toString()})()`)(win, win.navigator, win.DOMException, win.setTimeout);

describe('what a page sees once passkeys are refused', () => {
  let win;
  let realGet;
  // Captured BEFORE the script runs: the wrapper replaces the method, so reading it afterwards
  // would be reading the wrapper and proving nothing.
  beforeEach(() => { win = fakeWindow(); realGet = win.navigator.credentials.get; run(win); });

  it('refuses a passkey request the way a person dismissing the prompt would', async () => {
    await expect(win.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(1) } }))
      .rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('refuses passkey REGISTRATION too, so nothing ephemeral can be enrolled', async () => {
    await expect(win.navigator.credentials.create({ publicKey: { rp: { id: 'x' } } }))
      .rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  /* The whole point: it has to settle. A hang is what we are fixing. */
  it('settles quickly instead of hanging, which is the bug', async () => {
    const started = Date.now();
    await win.navigator.credentials.get({ publicKey: {} }).catch(() => {});
    expect(Date.now() - started).toBeLessThan(3000);
  });

  /* ...but not in the same tick. An instant failure reads as "no authenticator here, do not offer
     this route" to some pages, which hides the very fallback we are trying to reach. */
  it('does not fail in the same tick, which reads as synthetic', async () => {
    let settled = false;
    win.navigator.credentials.get({ publicKey: {} }).catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('leaves password credentials completely alone', async () => {
    await expect(win.navigator.credentials.get({ password: true })).resolves.toEqual({ type: 'password' });
    expect(realGet).toHaveBeenCalledWith({ password: true });   // it reached the real one
  });

  it('leaves federated sign-in alone', async () => {
    await expect(win.navigator.credentials.get({ federated: { providers: ['https://accounts.google.com'] } }))
      .resolves.toEqual({ type: 'password' });
  });

  it('leaves a bare call alone', async () => {
    await expect(win.navigator.credentials.get()).resolves.toEqual({ type: 'password' });
  });

  /* A well-built site asks this first and never shows the passkey button at all — the best outcome,
     because the person never sees a control that cannot work. */
  it('answers the feature check honestly: there is no platform authenticator here', async () => {
    await expect(win.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).resolves.toBe(false);
    await expect(win.PublicKeyCredential.isConditionalMediationAvailable()).resolves.toBe(false);
  });
});

describe('where it must not throw', () => {
  it('does nothing on a page with no credentials API rather than breaking the page', () => {
    const win = fakeWindow();
    win.navigator = { credentials: undefined };
    expect(() => run(win)).not.toThrow();
  });

  it('survives a browser with no PublicKeyCredential at all', () => {
    const win = fakeWindow();
    win.PublicKeyCredential = undefined;
    expect(() => run(win)).not.toThrow();
  });
});

/*
 * Applying it to a session that is ALREADY open.
 *
 * The first cut only applied the refusal at launch, so the UI said "reopen the session". That is
 * the wrong thing to ask of someone mid-login — and it read as broken, because closing and
 * reopening lands on the same stuck page. Confirmed live: the fallback only appeared after a
 * reconnect, which is a step nobody should have to discover.
 */
describe('turning it on while a session is open', () => {
  const poolWith = (sessions) => {
    const p = Object.create(BrowserPool.prototype);
    p.log = { info: () => {}, warn: () => {} };
    p.sessions = new Map(sessions.map((s) => [s.id, s]));
    p.perOwner = new Map();
    for (const s of sessions) {
      if (!p.perOwner.has(s.owner)) p.perOwner.set(s.owner, new Set());
      p.perOwner.get(s.owner).add(s.id);
    }
    return p;
  };
  const session = (id, owner, profile) => ({
    id, owner, profile,
    context: { addInitScript: vi.fn(async () => {}) },
    page: { reload: vi.fn(async () => {}) },
  });

  it('installs the refusal and reloads, so the stuck page comes back usable', async () => {
    const s = session('s1', 'carla', 'fb');
    const touched = await poolWith([s]).applyPasskeyRefusal('carla', 'fb');
    expect(touched).toEqual(['s1']);
    expect(s.context.addInitScript).toHaveBeenCalledOnce();
    expect(s.page.reload).toHaveBeenCalledOnce();   // the pending call cannot be refused retroactively
  });

  it('touches only the sessions on that profile', async () => {
    const fb = session('s1', 'carla', 'fb');
    const other = session('s2', 'carla', 'linkedin');
    await poolWith([fb, other]).applyPasskeyRefusal('carla', 'fb');
    expect(other.context.addInitScript).not.toHaveBeenCalled();
  });

  /* Sessions are owner-scoped everywhere else; a settings change must not reach across. */
  it('never touches someone else\u2019s session', async () => {
    const mine = session('s1', 'carla', 'fb');
    const theirs = session('s2', 'someone', 'fb');
    const touched = await poolWith([mine, theirs]).applyPasskeyRefusal('carla', 'fb');
    expect(touched).toEqual(['s1']);
    expect(theirs.context.addInitScript).not.toHaveBeenCalled();
  });

  /* A page that is mid-navigation rejects reload. The script is already installed by then, which is
     the part that matters — the navigation it is doing will pick it up. */
  it('counts the session as done even if the reload throws', async () => {
    const s = session('s1', 'carla', 'fb');
    s.page.reload = vi.fn(async () => { throw new Error('navigating'); });
    expect(await poolWith([s]).applyPasskeyRefusal('carla', 'fb')).toEqual(['s1']);
  });

  it('carries on past a session whose context has died', async () => {
    const dead = session('s1', 'carla', 'fb');
    dead.context.addInitScript = vi.fn(async () => { throw new Error('context closed'); });
    const live = session('s2', 'carla', 'fb');
    expect(await poolWith([dead, live]).applyPasskeyRefusal('carla', 'fb')).toEqual(['s2']);
  });

  it('reports nothing touched when the profile has no open session', async () => {
    expect(await poolWith([]).applyPasskeyRefusal('carla', 'fb')).toEqual([]);
  });
});
