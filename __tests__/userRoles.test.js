/**
 * Roles a person authored — the marketplace's foundation.
 *
 * The guarantees worth pinning here are the ones the whole feature rests on: a built-in can never be
 * shadowed by a user role, a role naming a tool that does not exist is refused rather than silently
 * crippled, a pack installs whole or not at all, and a model's reply becomes a SAFE draft no matter
 * what it says. Everything the UI and the endpoints do sits on top of these.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// PROFILE_DIR must be set before the store is imported — it reads it at module load, exactly as the
// profiles store does. So we point it at a throwaway dir and import after.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-roles-'));
process.env.PROFILE_DIR = dir;
const store = await import('../src/userRoles.js');
const roles = await import('../src/roles.js');

// A small stand-in palette so these tests never depend on the exact set of tools the agent ships.
const PALETTE = ['look', 'read', 'open', 'click', 'type', 'scroll', 'back', 'note', 'finish',
  'list_profiles', 'use_profile', 'sweep', 'act', 'save_lead'];

const good = () => ({
  label: 'Reddit · Complaint scout',
  site: 'reddit',
  description: 'Reads Reddit for people complaining about a problem you solve.',
  tools: ['look', 'read', 'scroll', 'note', 'finish', 'save_lead'],
  prompt: 'Your job is to find people voicing a problem, and only that. Never post, comment or reply.',
});

beforeEach(() => {
  // Wipe every stored role between tests so counts are predictable.
  fs.rmSync(path.join(dir, 'roles'), { recursive: true, force: true });
});
afterAll(() => {
  roles.useExternal(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('storing an authored role', () => {
  it('saves a valid role and mints a stable id from the label', () => {
    const r = store.save(good(), PALETTE);
    expect(r.id).toBe('reddit-complaint-scout');
    expect(r.source).toBe('user');
    expect(store.read(r.id).label).toBe('Reddit · Complaint scout');
  });

  it('refuses a role with too short a name or playbook', () => {
    expect(() => store.save({ ...good(), label: 'x' }, PALETTE)).toThrow(/name of at least/);
    expect(() => store.save({ ...good(), prompt: 'too short' }, PALETTE)).toThrow(/playbook of at least/);
  });

  it('refuses a role naming a tool that does not exist — a typo must not silently widen it', () => {
    let err;
    try { store.save({ ...good(), tools: ['look', 'teleport'] }, PALETTE); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/do not exist: teleport/);
  });

  it('allows null tools to mean "every tool", like a built-in', () => {
    const r = store.save({ ...good(), tools: null }, PALETTE);
    expect(store.getRole(r.id).tools).toBeNull();
  });

  it('editing keeps the id and createdAt, and can be forgotten', () => {
    const r = store.save(good(), PALETTE);
    const edited = store.save({ ...good(), id: r.id, label: 'Reddit · Renamed' }, PALETTE);
    expect(edited.id).toBe(r.id);
    expect(edited.createdAt).toBe(r.createdAt);
    expect(store.remove(r.id)).toBe(true);
    expect(store.read(r.id)).toBeNull();
    expect(store.remove(r.id)).toBe(false);
  });

  it('lists roles tagged with where they came from, in the agent-ready shape', () => {
    store.save(good(), PALETTE);
    const rows = store.listRoles();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'reddit-complaint-scout', source: 'user', site: 'reddit' });
    const asAgentSees = store.getRole('reddit-complaint-scout');
    expect(asAgentSees).toMatchObject({ site: 'reddit', prompt: expect.stringContaining('find people') });
    expect(Array.isArray(asAgentSees.tools)).toBe(true);
  });
});

describe('packs', () => {
  it('exports the named roles as a recipe, without ids or timestamps', () => {
    const a = store.save(good(), PALETTE);
    store.save({ ...good(), label: 'Reddit · Other' }, PALETTE);
    const pack = store.exportPack([a.id], 'My set');
    expect(pack.kind).toBe('ghost-roles-pack');
    expect(pack.roles).toHaveLength(1);
    expect(pack.roles[0]).not.toHaveProperty('id');
    expect(pack.roles[0].label).toBe('Reddit · Complaint scout');
  });

  it('installs a pack whole, tagging each role with the pack it came from', () => {
    const pack = { kind: 'ghost-roles-pack', name: 'Starter', roles: [good(), { ...good(), label: 'Reddit · Two' }] };
    const installed = store.importPack(pack, PALETTE);
    expect(installed).toHaveLength(2);
    expect(installed.every((r) => r.source === 'pack:starter')).toBe(true);
    expect(store.all()).toHaveLength(2);
  });

  it('refuses a pack whole if any role names a missing tool — no half installs', () => {
    const pack = { kind: 'ghost-roles-pack', name: 'Bad', roles: [good(), { ...good(), tools: ['nope'] }] };
    expect(() => store.importPack(pack, PALETTE)).toThrow(/cannot be installed/);
    expect(store.all()).toHaveLength(0);
  });

  it('rejects something that is not a pack', () => {
    expect(() => store.importPack({ roles: [] }, PALETTE)).toThrow(/not a roles pack/);
  });
});

describe('coerceDraft — a model reply becomes a safe draft', () => {
  it('pulls JSON out of a fenced, prose-wrapped reply', () => {
    const reply = 'Sure! Here is the role:\n```json\n{"label":"X scout","site":"x","tools":["look","read"],"prompt":"do the thing well and carefully"}\n```\nHope that helps.';
    const d = store.coerceDraft(reply, PALETTE);
    expect(d.label).toBe('X scout');
    expect(d.site).toBe('x');
    expect(d.tools).toEqual(['look', 'read']);
  });

  it('drops tools that are not in the palette', () => {
    const d = store.coerceDraft('{"tools":["look","teleport","read"]}', PALETTE);
    expect(d.tools).toEqual(['look', 'read']);
  });

  it('defaults to the basics when the reply names nothing usable', () => {
    const d = store.coerceDraft('{"tools":["teleport"]}', PALETTE);
    expect(d.tools).toEqual(expect.arrayContaining(['look', 'read', 'list_profiles', 'use_profile']));
  });

  it('normalises an unknown site to null and never throws on garbage', () => {
    expect(store.coerceDraft('{"site":"myspace"}', PALETTE).site).toBeNull();
    expect(() => store.coerceDraft('not json at all', PALETTE)).not.toThrow();
    expect(store.coerceDraft('not json at all', PALETTE).tools.length).toBeGreaterThan(0);
  });
});

describe('roles.js merges the store without letting it shadow a built-in', () => {
  it('resolves a user role by id, but a built-in always wins a name collision', () => {
    roles.useExternal({
      getRole: (id) => (id === 'reddit.mine' ? { site: 'reddit', label: 'Mine', description: '', tools: ['look'], prompt: 'p' }
        : id === 'general' ? { site: null, label: 'HIJACK', description: '', tools: null, prompt: 'evil' } : null),
      listRoles: () => [{ name: 'reddit.mine', label: 'Mine', description: '', site: 'reddit', group: 'Yours', source: 'user' }],
    });
    // A user role fills a gap...
    expect(roles.get('reddit.mine').label).toBe('Mine');
    expect(roles.canonical('reddit.mine')).toBe('reddit.mine');
    // ...but 'general' is a built-in, so the provider's attempt to redefine it is ignored.
    expect(roles.get('general')).toBe(roles.ROLES.general);
    // The list carries both, tagged.
    const l = roles.list();
    expect(l.find((r) => r.name === 'general').source).toBe('builtin');
    expect(l.find((r) => r.name === 'reddit.mine').source).toBe('user');
    // toolsFor resolves a user role's tools against the real palette.
    const fakePalette = [{ function: { name: 'look' } }, { function: { name: 'act' } }];
    expect(roles.toolsFor('reddit.mine', fakePalette).map((t) => t.function.name)).toEqual(['look']);
  });

  it('with no provider registered, behaves exactly as before', () => {
    roles.useExternal(null);
    expect(roles.get('reddit.mine')).toBe(roles.ROLES.general);
    expect(roles.list().every((r) => r.source === 'builtin')).toBe(true);
  });
});
