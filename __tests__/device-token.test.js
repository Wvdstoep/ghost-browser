/**
 * A durable device login: minted once behind the owner's sign-in, it joins the same keys map the bearer
 * auth checks (so it resolves to the owner, console:true), survives a restart via its file, rotates on
 * re-enrol, and revokes per device. No server, no cluster — the module against a temp file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dt; let dir;
beforeEach(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-')); process.env.PROFILE_DIR = dir; dt = await import('../src/deviceTokens.js?' + Math.random()); });

describe('durable device login', () => {
  it('mints an owner-scoped token that resolves like the console, and persists it', () => {
    const keys = new Map();
    const rec = dt.mint(keys, { owner: 'carla', deviceId: 'fold', name: 'Carla Fold' });
    expect(rec.token).toMatch(/^gbd_[0-9a-f]{48}$/);
    const entry = keys.get(rec.token);
    expect(entry).toMatchObject({ owner: 'carla', console: true, device: true, deviceId: 'fold', name: 'Carla Fold', plan: 'device' });
    expect(entry.maxConcurrent).toBe(3);
    // persisted to disk, and never the raw token in the owner's device list
    expect(fs.existsSync(dt.FILE())).toBe(true);
    expect(dt.list('carla')).toEqual([{ deviceId: 'fold', name: 'Carla Fold', createdAt: rec.createdAt }]);
    expect(JSON.stringify(dt.list('carla'))).not.toContain(rec.token);
  });
  it('load() brings persisted tokens back into a fresh keys map after a restart', () => {
    const rec = dt.mint(new Map(), { owner: 'carla', deviceId: 'fold' });
    const keys2 = new Map(); expect(dt.load(keys2)).toBe(1);
    expect(keys2.get(rec.token)).toMatchObject({ owner: 'carla', console: true });
  });
  it('re-enrolling the same device rotates the token (the old one stops working)', () => {
    const keys = new Map();
    const a = dt.mint(keys, { owner: 'carla', deviceId: 'fold' });
    const b = dt.mint(keys, { owner: 'carla', deviceId: 'fold' });
    expect(b.token).not.toBe(a.token);
    expect(keys.has(a.token)).toBe(false); expect(keys.has(b.token)).toBe(true);
    expect(dt.list('carla').length).toBe(1);
  });
  it('revoke removes one device, owner-scoped, and only that owner\'s', () => {
    const keys = new Map();
    const a = dt.mint(keys, { owner: 'carla', deviceId: 'fold' });
    dt.mint(keys, { owner: 'carla', deviceId: 'laptop' });
    dt.mint(keys, { owner: 'someone', deviceId: 'fold' });
    expect(dt.revoke(keys, 'carla', 'fold')).toBe(1);
    expect(keys.has(a.token)).toBe(false);
    expect(dt.list('carla').map((d) => d.deviceId)).toEqual(['laptop']);
    expect(dt.revoke(keys, 'carla', 'nope')).toBe(0);
    expect(dt.list('someone').length).toBe(1);   // another owner's device untouched
  });
});
