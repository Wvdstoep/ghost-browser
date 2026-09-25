import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs'); const os = require('os'); const path = require('path');

describe('GPU nodes', () => {
  let dir, nodes;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-nodes-'));
    process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/nodes')];
    nodes = require('../src/nodes');
  });
  afterEach(() => { delete process.env.PROFILE_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it('mints a join, serves the script with everything filled in, counts its uses, expires and revokes it', () => {
    const j = nodes.mintJoin({ kind: 'modal', token: 'gbd_secret', deviceId: 'node-modal-abc', owner: 'wesley', publicUrl: 'https://hub.example/' });
    expect(j.name).toBe('Modal node 1');
    expect(nodes.joinFor(j.code)).toMatchObject({ kind: 'modal', deviceId: 'node-modal-abc' });
    const src = nodes.scriptFor(j);
    expect(src).toContain('HUB = "https://hub.example"');
    expect(src).toContain('TOKEN = "gbd_secret"');
    expect(src).toContain('DEVICE = "node-modal-abc"');
    expect(src).toContain('NAME = "Modal node 1"');
    expect(src).toContain('KIND = "modal"');
    expect(src).not.toContain('__HUB__');
    expect(nodes.pasteLine(j)).toBe(`curl -fsSL "https://hub.example/v1/training/node.py?join=${encodeURIComponent(j.code)}" | python3 -`);
    nodes.useJoin(j.code);
    expect(nodes.joins()[0]).toMatchObject({ uses: 1, expired: false });
    expect(nodes.joins()[0].token).toBeUndefined();
    expect(nodes.joinFor(j.code, Date.now() + nodes.JOIN_MS + 1000)).toBe(null);
    expect(nodes.revokeJoin(j.code)).toMatchObject({ code: j.code });
    expect(nodes.joinFor(j.code)).toBe(null);
    expect(nodes.revokeJoin('nope')).toBe(null);
  });

  it('names the second node of a kind, and an unknown kind is a plain GPU node', () => {
    nodes.mintJoin({ kind: 'colab', token: 't1', deviceId: 'd1' });
    const j2 = nodes.mintJoin({ kind: 'colab', token: 't2', deviceId: 'd2' });
    expect(j2.name).toBe('Colab node 2');
    expect(nodes.mintJoin({ kind: 'weird', token: 't3', deviceId: 'd3' }).kind).toBe('gpu');
  });

  it('refuses to start Modal without a client or a token, and keeps its state', async () => {
    process.env.MODAL_BIN = path.join(dir, 'no-such-modal');
    const a = await nodes.modalStart({ tokenId: 'ak', tokenSecret: 'as', joinUrl: 'https://x/y' });
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/no Modal client/);
    fs.writeFileSync(process.env.MODAL_BIN, '#!/bin/sh\necho hi\n');
    const b = await nodes.modalStart({ tokenId: '', tokenSecret: '', joinUrl: 'https://x/y' });
    expect(b.error).toMatch(/no Modal token/);
    delete process.env.MODAL_BIN;
    expect(nodes.modalPatch({ lastStart: '2026-09-25T12:00:00.000Z' }).lastStart).toBe('2026-09-25T12:00:00.000Z');
    expect(nodes.modalState().lastStart).toBe('2026-09-25T12:00:00.000Z');
  });
});
