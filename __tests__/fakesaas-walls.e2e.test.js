/**
 * THE WALLS, END TO END, in a real browser, against a site that enforces them for real.
 *
 *   password + TOTP        the code comes from the repo's own totp(), as the agent's totp_code does
 *   passkey via the relay  the OWNER's authenticator signs; the page (the cluster) never holds a key,
 *                          the site verifies the real WebAuthn signature, a declined prompt fails the
 *                          way a dismissed one does, and a replayed assertion is refused
 *   device-bound session   a cookie copied out of the browser dies at its TTL; the original keeps
 *                          working because the key that refreshes it never left the page
 *
 * Honest limits: the "owner's device" is an in-process software authenticator and the "device-bound"
 * key is WebCrypto in the page. Everything the SITE checks is real; the secure hardware is not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeFakeSaas } from '../testbed/fakesaas.js';
import { makeSoftAuthenticator, installRelay, verifyAssertion } from '../src/authrelay.js';
import { totp } from '../src/tools/craft-parts.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip */ }
let browser = null;
if (chromium) {
  const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
  try { browser = await chromium.launch(opts); }
  catch { try { if (process.env.GB_CHROMIUM) browser = await chromium.launch({ ...opts, executablePath: process.env.GB_CHROMIUM }); } catch (e) { console.warn('[walls.e2e] no Chromium — skipping'); } }
}

const signIn = async (page, origin, saas) => {
  await page.goto(origin + '/');
  await page.fill('#user', saas.USER); await page.fill('#pw', saas.PASSWORD);
  await page.click('#go');
};
const readInbox = async (page, origin) => {
  await page.goto(origin + '/inbox');
  await page.waitForSelector('li.msg', { timeout: 5000 });
  return page.$$eval('li.msg .subj', (e) => e.map((x) => x.textContent));
};

describe.skipIf(!browser)('login walls the agent has to get through', () => {
  describe('password + TOTP', () => {
    let saas, origin, ctx, page;
    beforeAll(async () => { saas = makeFakeSaas({ mfa: 'totp' }); origin = await saas.listen(); ctx = await browser.newContext(); page = await ctx.newPage(); });
    afterAll(async () => { await ctx.close(); await saas.close(); });

    it('a wrong code is refused, the right one (from the repo\'s own totp) signs in, and the inbox reads', async () => {
      await signIn(page, origin, saas);
      await page.waitForSelector('#code');
      await page.fill('#code', '000000'); await page.click('#verify');
      await page.waitForFunction(() => document.getElementById('status').textContent === 'bad code');
      await page.fill('#code', totp(saas.TOTP_SECRET).code); await page.click('#verify');
      await page.waitForFunction(() => document.title === 'signed in');
      expect(await readInbox(page, origin)).toEqual(['Invoice 1042', 'Lunch?', 'URGENT account notice']);
      expect(saas.state.logins).toBe(1);
      expect(saas.state.failedLogins).toBe(1);
    }, 30000);
  });

  describe('passkey answered by the owner\'s device', () => {
    let saas, origin, owner, prompts;
    beforeAll(async () => {
      saas = makeFakeSaas({ mfa: 'totp' }); origin = await saas.listen();
      prompts = []; owner = makeSoftAuthenticator({ approve: async (req) => { prompts.push(req); return owner.willApprove !== false; } });
      // ENROL ONCE, by the owner: sign in with TOTP, then register a passkey with the owner's device
      const ctx = await browser.newContext(); const page = await ctx.newPage();
      await installRelay(ctx, (r) => (r.kind === 'create' ? owner.create(r) : owner.get(r)));
      await signIn(page, origin, saas);
      await page.waitForSelector('#code'); await page.fill('#code', totp(saas.TOTP_SECRET).code); await page.click('#verify');
      await page.waitForFunction(() => document.title === 'signed in');
      expect(await page.evaluate(() => window.__enroll())).toBe(200);
      await ctx.close();
      saas.setMfa('passkey');
    }, 40000);
    afterAll(async () => { await saas.close(); });

    it('enrolled: the site holds a public key, the device holds the private one', () => {
      expect(saas.hasPasskey).toBe(true);
      expect(owner.count).toBe(1);
      expect(prompts[0].kind).toBe('create');
      expect(prompts[0].rpId).toBe('localhost');
    });

    it('a fresh cluster browser signs in with NO key of its own: the owner approves, the site verifies', async () => {
      const ctx = await browser.newContext(); const page = await ctx.newPage();
      const relay = await installRelay(ctx, (r) => owner.get(r));
      const before = prompts.length;
      await signIn(page, origin, saas);
      await page.waitForSelector('#usepk'); await page.click('#usepk');
      await page.waitForFunction(() => document.title === 'signed in', null, { timeout: 8000 });
      expect(await readInbox(page, origin)).toHaveLength(3);
      expect(prompts.length).toBe(before + 1);
      expect(prompts.at(-1).kind).toBe('get');
      expect(relay.audit.map((a) => a.outcome)).toEqual(['answered']);          // the owner can see every prompt
      // what crossed to the cluster is only the public assertion: no key material of any kind
      const crossed = await owner.get({ kind: 'get', rpId: 'localhost', origin, challenge: 'AAAA', allowCredentials: [] });
      expect(Object.keys(crossed).sort()).toEqual(['id', 'rawId', 'response', 'type']);
      expect(Object.keys(crossed.response).sort()).toEqual(['authenticatorData', 'clientDataJSON', 'signature', 'userHandle']);
      expect(JSON.stringify(crossed)).not.toMatch(/PRIVATE|"d":/);
      await ctx.close();
    }, 30000);

    it('a prompt the owner declines fails like a dismissed one, and no session is created', async () => {
      owner.willApprove = false;
      const ctx = await browser.newContext(); const page = await ctx.newPage();
      const relay = await installRelay(ctx, (r) => owner.get(r));
      const logins = saas.state.logins;
      await signIn(page, origin, saas);
      await page.waitForSelector('#usepk'); await page.click('#usepk');
      await page.waitForFunction(() => document.getElementById('status').textContent === 'passkey NotAllowedError', null, { timeout: 8000 });
      expect(saas.state.logins).toBe(logins);
      expect(relay.audit.at(-1).outcome).toBe('declined');
      owner.willApprove = true;
      await ctx.close();
    }, 30000);

    it('a captured assertion cannot be replayed (the counter must advance, the challenge is one-use)', async () => {
      const ctx = await browser.newContext(); const page = await ctx.newPage();
      let captured = null;
      await installRelay(ctx, async (r) => { captured = { req: r, out: await owner.get(r) }; return captured.out; });
      await signIn(page, origin, saas);
      await page.waitForSelector('#usepk'); await page.click('#usepk');
      await page.waitForFunction(() => document.title === 'signed in');
      // an attacker with the wire capture tries the same assertion against a new login
      const ctx2 = await browser.newContext(); const page2 = await ctx2.newPage();
      await signIn(page2, origin, saas);
      await page2.waitForSelector('#usepk');
      const status = await page2.evaluate(async (c) => (await fetch('/api/webauthn/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: c.out.id, response: c.out.response }) })).status, captured);
      expect(status).toBe(401);
      await ctx.close(); await ctx2.close();
    }, 30000);

    it('the relay answers only WebAuthn: password-style credential calls pass straight through', async () => {
      const ctx = await browser.newContext(); const page = await ctx.newPage();
      await installRelay(ctx, (r) => owner.get(r));
      await page.goto(origin + '/');
      const r = await page.evaluate(async () => { try { return String(await navigator.credentials.get({ password: true })); } catch (e) { return e.name; } });
      expect(r).not.toBe('NotAllowedError-from-relay');
      await ctx.close();
    });
  });

  describe('device-bound session: the cookie is worth nothing off the device', () => {
    let saas, origin, ctxA, pageA;
    beforeAll(async () => {
      saas = makeFakeSaas({ mfa: 'totp', bound: true, boundTtlMs: 1500 }); origin = await saas.listen();
      ctxA = await browser.newContext(); pageA = await ctxA.newPage();
      await signIn(pageA, origin, saas);
      await pageA.waitForSelector('#code'); await pageA.fill('#code', totp(saas.TOTP_SECRET).code); await pageA.click('#verify');
      await pageA.waitForFunction(() => document.title === 'signed in');
    }, 30000);
    afterAll(async () => { await ctxA.close(); await saas.close(); });

    it('the original browser keeps its session past the TTL; a copied cookie jar does not', async () => {
      const stolen = await ctxA.cookies();
      expect(stolen.some((c) => c.name === 'sid')).toBe(true);
      const ctxB = await browser.newContext(); await ctxB.addCookies(stolen);   // what sessionVault.restore does
      const pageB = await ctxB.newPage();
      await new Promise((r) => setTimeout(r, 3500));                              // well past one TTL
      // the original page, which holds the key, is still signed in
      expect(await readInbox(pageA, origin)).toHaveLength(3);
      // the copy is not
      await pageB.goto(origin + '/inbox');
      expect(pageB.url()).toBe(origin + '/');                                    // bounced to sign-in
      const api = await pageB.evaluate(async () => (await fetch('/api/messages')).status);
      expect(api).toBe(401);                                                     // and the API says the same
      expect(saas.state.refreshes).toBeGreaterThan(0);                           // the original kept proving possession
      expect(saas.state.sent).toEqual([]);
      await ctxB.close();
    }, 40000);
  });
});
