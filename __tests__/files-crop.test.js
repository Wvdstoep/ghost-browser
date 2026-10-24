/**
 * upload_file must CONFIRM the crop/adjust dialog that sites (YouTube's banner + photo) pop after a
 * file is chosen — otherwise the image never commits and the agent stalls hunting for a button.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-fc-'));
process.env.PROFILE_DIR = dir;
const fa = await import('../src/fileAssets.js');
const filesMod = await import('../src/tools/files.js');
const files = filesMod.default || filesMod;
beforeEach(() => fs.rmSync(dir, { recursive: true, force: true }));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function ctx(page) {
  const steps = [], said = [];
  return { steps, said, page: () => page, settle: async () => {}, step: (k, t) => steps.push([k, t]), observe: (t) => said.push(t), resetClickLoop: () => {}, session: () => ({}) };
}

describe('upload_file crop-confirm', () => {
  it.each(['image', 'post'])('uses a stored image labelled %s as the reference when no asset id is given', async (kind) => {
    fa.put({ mime: 'image/png', kind, name: 'reference.png', bytes: Buffer.from([1, 2, 3, 4]) });
    fa.put({ mime: 'video/mp4', kind: 'video', name: 'old-clip.mp4', bytes: Buffer.from([5, 6, 7, 8]) });
    let received;
    const input = { setInputFiles: async (f) => { received = f; } };
    const page = { $$: async (sel) => String(sel).includes('input[type=file]') ? [input] : [] };
    await files.upload_file(ctx(page), { kind: 'image' });
    expect(received.name).toBe('reference.png');
    expect(received.buffer).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('reports a missing reference without substituting a video', async () => {
    fa.put({ mime: 'video/mp4', kind: 'video', bytes: Buffer.from([5, 6, 7, 8]) });
    const c = ctx({ $$: async () => { throw new Error('must not upload'); } });
    await files.upload_file(c, { kind: 'image' });
    expect(c.said.join(' ')).toMatch(/No stored file of kind "image"/);
    expect(c.steps).toEqual([]);
  });

  it('does not replace a missing explicit asset with a different image', async () => {
    fa.put({ mime: 'image/png', kind: 'image', bytes: Buffer.from([1, 2]) });
    const c = ctx({});
    await files.upload_file(c, { assetId: 'missing', kind: 'image' });
    expect(c.said.join(' ')).toMatch(/No stored file with id "missing"/);
    expect(c.steps).toEqual([]);
  });

  it('clicks the crop dialog confirm ("Gereed") after setting the file, not Cancel', async () => {
    const id = fa.put({ mime: 'image/png', kind: 'cover', name: 'b.png', bytes: Buffer.from([1, 2, 3, 4]) });
    const clicks = [];
    const input = { setInputFiles: async () => {} };
    const gereed = { innerText: async () => 'Gereed', isVisible: async () => true, click: async () => { clicks.push('gereed'); } };
    const cancel = { innerText: async () => 'Annuleren', isVisible: async () => true, click: async () => { clicks.push('cancel'); } };
    let btnCall = 0;
    const page = { $$: async (sel) => {
      if (String(sel).includes('input[type=file]')) return [input];
      btnCall += 1; return btnCall === 1 ? [cancel, gereed] : [];   // one confirmable dialog, then none
    } };
    const c = ctx(page);
    await files.upload_file(c, { assetId: id });
    expect(clicks).toContain('gereed');
    expect(clicks).not.toContain('cancel');
    expect(c.said.join(' ')).toMatch(/confirmed/i);
  });

  it('does not fabricate a confirm when no crop dialog is present', async () => {
    const id = fa.put({ mime: 'image/png', kind: 'profile', name: 'p.png', bytes: Buffer.from([9, 9]) });
    const input = { setInputFiles: async () => {} };
    const page = { $$: async (sel) => (String(sel).includes('input[type=file]') ? [input] : []) };
    const c = ctx(page);
    await files.upload_file(c, { assetId: id });
    expect(c.said.join(' ')).toMatch(/No crop dialog needed/i);
  });
});
