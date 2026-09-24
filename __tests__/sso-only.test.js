// SSO-ONLY mode. A platform-managed Ghost Browser (connected from the Tools tab) belongs to ONE
// platform user and must be entered ONLY through the platform SSO handoff. Local password accounts are
// disabled — otherwise anyone reaching the tool's URL before the owner's first sign-in could claim
// ownership via the "create the owner account" form. The full route stack pulls in Playwright etc. and
// isn't bootable headless, so these pin the load-bearing lines directly.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
const consoleJs = readFileSync(fileURLToPath(new URL('../public/js/console.js', import.meta.url)), 'utf8');

describe('SSO-only server gate', () => {
  it('is enabled by SSO_ONLY but only when LEADFLOW is configured (never locks out with no SSO path)', () => {
    expect(server).toMatch(/const SSO_ONLY = .*process\.env\.SSO_ONLY.*&&\s*!!process\.env\.LEADFLOW_JWT_SECRET/s);
  });

  it('blocks local signup when SSO-only, and login only until the owner has set a password', () => {
    /* Signup stays shut: nobody may claim an instance before its owner's first hand-off. Login
       is the fallback that never depends on the platform - it opens the moment a password exists. */
    const signup = server.slice(server.indexOf("app.post('/api/auth/signup'"), server.indexOf("app.post('/api/auth/login'"));
    const login = server.slice(server.indexOf("app.post('/api/auth/login'"), server.indexOf('ONE LOGIN'));
    expect(signup).toMatch(/if \(SSO_ONLY\) return ssoOnlyBlock/);
    expect(login).toMatch(/if \(SSO_ONLY && !accounts\.hasPassword\(\)\)/);
    expect(login).not.toMatch(/if \(SSO_ONLY\) return ssoOnlyBlock/);
  });

  it('lets the signed-in owner set the password that opens the instance without the platform', () => {
    expect(server).toMatch(/app\.post\('\/api\/auth\/password', authed/);
    const state = server.slice(server.indexOf("app.get('/api/auth/state'"), server.indexOf("app.post('/api/auth/signup'"));
    expect(state).toMatch(/hasPassword: accounts\.hasPassword\(\)/);
  });

  it('does NOT block the SSO route (that is the only way in)', () => {
    const ssoRoute = server.slice(server.indexOf("app.post('/api/auth/sso'"), server.indexOf("app.post('/api/auth/logout'"));
    expect(ssoRoute).not.toMatch(/SSO_ONLY/);
  });

  it('reports ssoOnly in /api/auth/state so the frontend can hide the password gate', () => {
    const state = server.slice(server.indexOf("app.get('/api/auth/state'"), server.indexOf("app.post('/api/auth/signup'"));
    expect(state).toMatch(/ssoOnly: SSO_ONLY/);
  });

  it('frontend KEEPS the email/password form when ssoOnly, and says what to do', () => {
    /* A hand-off that failed used to leave a page with nothing to press. */
    expect(consoleJs).toMatch(/if \(s\.ssoOnly\)/);
    expect(consoleJs).toMatch(/password you set here/i);
    expect(consoleJs).not.toMatch(/\['u', 'p', 'gateGo'/);
    expect(consoleJs).toMatch(/\/api\/auth\/password/);
  });
});
