/**
 * THE WHOLE CHAIN, with the real transport: a page in the cluster's browser asks for a passkey, the
 * request goes through the REAL device hub (register, long-poll, result), a ring node's authenticator
 * answers after "the owner approves", and only the signed assertion comes back to the page, which the
 * site verifies with real WebAuthn checks. The node here is scripts/ring-node-ref.js, which implements
 * the wire contract in src/ringauth.js; a phone or laptop app implements the same contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { mountDeviceHub } from '../src/device-hub.js';
import { makeAsk, candidates } from '../src/ringauth.js';
import { installRelay, makeSoftAuthenticator } from '../src/authrelay.js';
import { makeFakeSaas } from '../testbed/fakesaas.js';
import { totp } from '../src/tools/craft-parts.js';
import { runNode } from '../scripts/ring-node-ref.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip */ }
let browser = null;
if (chromium) {
  const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
  try { browser = await chromium.launch(opts); }
  catch { try { if (process.env.GB_CHROMIUM) browser = await chromium.launch({ ...opts, executablePath: process.env.GB_CHROMIUM }); } catch { console.warn('[ringauth] no Chromium — skipping'); } }
}

const signInTo = async (page, origin, saas) => { await page.goto(origin + '/'); await page.fill('#user', saas.USER); await page.fill('#pw', saas.PASSWORD); await page.click('#go'); };

describe('candidates (pure)', () => {
  const hub = (devs) => ({ deviceList: () => devs });
  const d = (id, features, o = {}) => ({ deviceId: id, name: id, owner: 'o', online: true, caps: { features, realIp: false }, ...o });
  it('only online devices of this owner that advertise webauthn, real-IP first', () => {
    const list = candidates(hub([d('a', ['x']), d('b', ['webauthn']), d('c', ['webauthn'], { online: false }), d('e', ['webauthn'], { owner: 'other' }), d('f', ['webauthn'], { caps: { features: ['webauthn'], realIp: true } })]), 'o');
    expect(list.map((x) => x.deviceId)).toEqual(['f', 'b']);
  });
});

describe.skipIf(!browser)('passkey prompt → device ring → owner\'s authenticator → site', () => {
  let app, httpServer, base, hub, saas, origin, node, owner, prompts;
  const KEY = 'k';
  beforeAll(async () => {
    app = express(); app.use(express.json());
    const authed = (req, res, next) => { if (req.get('authorization') !== 'Bearer ' + KEY) return res.status(401).end(); req.client = { owner: 'o' }; next(); };
    hub = mountDeviceHub(app, authed);
    await new Promise((r) => { httpServer = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${httpServer.address().port}`;
    prompts = [];
    owner = makeSoftAuthenticator({ approve: async (req) => { prompts.push(req); return owner.ok !== false; } });
    node = await runNode({ base, key: KEY, deviceId: 'laptop', name: 'Owner laptop', authenticator: owner });
    saas = makeFakeSaas({ mfa: 'totp' }); origin = await saas.listen();
  }, 30000);
  afterAll(async () => { await node.stop(); httpServer.closeAllConnections?.(); httpServer.close(); await saas.close(); if (browser) await browser.close(); });

  const ask = (o = {}) => makeAsk(hub, { owner: 'o', log: { info() {} }, ...o });

  it('the node registers, and the hub routes passkey prompts to it', () => {
    expect(candidates(hub, 'o').map((d) => d.deviceId)).toEqual(['laptop']);
  });

  it('enrol, then sign in on a fresh cluster browser: every prompt crossed the hub and the site verified a real assertion', async () => {
    const c1 = await browser.newContext(); const p1 = await c1.newPage();
    await installRelay(c1, ask());
    await signInTo(p1, origin, saas);
    await p1.waitForSelector('#code'); await p1.fill('#code', totp(saas.TOTP_SECRET).code); await p1.click('#verify');
    await p1.waitForFunction(() => document.title === 'signed in');
    expect(await p1.evaluate(() => window.__enroll())).toBe(200);
    await c1.close(); saas.setMfa('passkey');
    expect(saas.hasPasskey).toBe(true);

    const c2 = await browser.newContext(); const p2 = await c2.newPage();
    const relay = await installRelay(c2, ask());
    await signInTo(p2, origin, saas);
    await p2.waitForSelector('#usepk'); await p2.click('#usepk');
    await p2.waitForFunction(() => document.title === 'signed in', null, { timeout: 15000 });
    expect(prompts.map((p) => p.kind)).toEqual(['create', 'get']);
    expect(prompts.at(-1)).toMatchObject({ rpId: 'localhost', site: 'localhost' });         // the owner is shown WHO is asking
    expect(relay.audit.map((a) => a.outcome)).toEqual(['answered']);
    await c2.close();
  }, 60000);

  it('the owner declining at the device fails the page like a dismissed prompt, and no session exists', async () => {
    owner.ok = false;
    const c = await browser.newContext(); const p = await c.newPage();
    await installRelay(c, ask());
    const logins = saas.state.logins;
    await signInTo(p, origin, saas); await p.waitForSelector('#usepk'); await p.click('#usepk');
    await p.waitForFunction(() => document.getElementById('status').textContent === 'passkey NotAllowedError', null, { timeout: 15000 });
    expect(saas.state.logins).toBe(logins);
    owner.ok = true; await c.close();
  }, 30000);

  it('a device that never answers: the prompt times out and fails safe (nothing approved by default)', async () => {
    const quiet = express(); quiet.use(express.json());
    const authed = (req, res, next) => { req.client = { owner: 'o' }; next(); };
    const h2 = mountDeviceHub(quiet, authed);
    const srv = await new Promise((r) => { const s = quiet.listen(0, '127.0.0.1', () => r(s)); });
    await fetch(`http://127.0.0.1:${srv.address().port}/v1/device/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'mute', name: 'Mute', caps: { features: ['webauthn'] } }) });
    const c = await browser.newContext(); const p = await c.newPage();
    await installRelay(c, makeAsk(h2, { owner: 'o', timeoutMs: 600, log: { info() {} } }));
    const logins = saas.state.logins;
    await signInTo(p, origin, saas); await p.waitForSelector('#usepk'); await p.click('#usepk');
    await p.waitForFunction(() => document.getElementById('status').textContent === 'passkey NotAllowedError', null, { timeout: 10000 });
    expect(saas.state.logins).toBe(logins);
    await c.close(); srv.closeAllConnections?.(); srv.close();
  }, 30000);

  it('no device online at all: refused with a reason, never a silent approval', async () => {
    const empty = { deviceList: () => [], runCommand: async () => { throw new Error('should not be called'); } };
    await expect(makeAsk(empty, { owner: 'o', log: { info() {} } })({ kind: 'get', site: 's' })).rejects.toThrow(/no device that can answer passkey prompts/);
    await expect(makeAsk(hub, { owner: 'o', target: () => 'ghost-device', log: { info() {} } })({ kind: 'get', site: 's' })).rejects.toThrow(/not online/);
  });
});
