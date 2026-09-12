/**
 * Superadmin overview — the platform (my-app) superadmin's cross-tenant foundation. Each GB pod is one
 * owner's isolated instance; the platform dashboard fans out to every pod's read-only /v1/admin/overview
 * and stitches Users / Flows / Roles together. The endpoint must be READ-ONLY and gated by the SSO
 * identity (email in SUPERADMIN_USERS) — never the console owner or a bearer key — so the view travels
 * with the platform login. Token verification itself is covered by sso.test.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js'), 'utf8');

describe('superadmin overview endpoint', () => {
  it('exposes a read-only GET /v1/admin/overview (no mutating verb on the admin surface)', () => {
    expect(src).toMatch(/app\.get\(\s*['"]\/v1\/admin\/overview['"]/);
    expect(src).not.toMatch(/app\.(post|put|delete)\(\s*['"]\/v1\/admin\//);
  });
  it('is gated by the SSO superadmin identity, not the console owner or an API key', () => {
    expect(src).toContain('function superadminGate');
    expect(src).toContain('SUPERADMIN_USERS');
    expect(src).toContain('sso.verifyLeadflowToken');
    expect(src).toMatch(/\/v1\/admin\/overview['"]\s*,\s*superadminGate/);
  });
  it('reports the owner, flows and created roles — the three superadmin pages', () => {
    // the overview stitches into Users(owner) / Flows(workflows) / Roles(userRoles)
    expect(src).toMatch(/owner:\s*acct/);
    expect(src).toContain('workflows.all()');
    expect(src).toContain('userRoles.all()');
  });
  it('provides a superadmin-gated aggregator that fans out to tenant pods', () => {
    expect(src).toMatch(/app\.get\(\s*['"]\/v1\/admin\/tenants-overview['"]\s*,\s*superadminGate/);
    expect(src).toContain('GB_TENANT_URLS');
    // fans out to each tenant's own overview (server-side, sidestepping pod isolation + CORS)
    expect(src).toMatch(/fetch\(base \+ ['"]\/v1\/admin\/overview['"]/);
  });
});

describe('SSO isolation — one browser, one owner', () => {
  it('the SSO route refuses a LeadFlow user who is neither the owner nor a superadmin', () => {
    // a mismatched identity must be rejected, never logged in as the owner (which would share sessions);
    // the real owner (same identity) and a superadmin are the only ones allowed through.
    expect(src).toContain('const who = sso.ownerName(claims)');
    expect(src).toContain('const sameOwner = String(who).toLowerCase() === String(rec.username).toLowerCase()');
    expect(src).toContain('if (!sameOwner && !isSuper)');
    expect(src).toMatch(/belongs to another account/);
    expect(src).toMatch(/status\(403\)/);
  });
});

/*
 * THE RED 403 ON EVERY PAGE LOAD.
 *
 * The dashboard decided whether to show the Superadmin nav by CALLING /v1/admin/overview and
 * catching the refusal. It worked, and it meant every ordinary sign-in printed a red 403 in the
 * browser's console — noise that reads exactly like a broken page, and which twice sent the owner
 * hunting a bug that was not there while a real one was in front of her.
 *
 * A question about who you are belongs on the route that answers who you are.
 */
describe('the console asks who it is, instead of being refused', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read2 = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
  const srv = read2('src', 'server.js');
  const dash = read2('public', 'js', 'dashboard.js');

  it('the sign-in state says whether this login is a superadmin', () => {
    const at = srv.indexOf("app.get('/api/auth/state'");
    expect(at).toBeGreaterThan(0);
    expect(srv.slice(at, at + 1200)).toMatch(/superadmin: !!\(who && SUPERADMIN\.has\(String\(who\.username \|\| ''\)\.toLowerCase\(\)\)\)/);
  });

  it('and the nav reads that, rather than probing an endpoint it may not have', () => {
    const at = dash.indexOf('Reveal the Superadmin nav');
    const body = dash.slice(at, at + 800);
    expect(body).toMatch(/api\('\/api\/auth\/state'\)/);
    expect(body).toMatch(/if \(s\.superadmin && navAdmin\)/);
    expect(body).not.toMatch(/api\('\/v1\/admin\/overview'\)/);
  });

  /* The gate itself is unchanged: knowing you are not one is not the same as being let in. */
  it('while the admin routes are still gated exactly as before', () => {
    expect(srv).toMatch(/app\.get\('\/v1\/admin\/overview', superadminGate/);
    expect(srv).toMatch(/return res\.status\(403\)\.json\(\{ error: 'not a superadmin' \}\)/);
  });
});
