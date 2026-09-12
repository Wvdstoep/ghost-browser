/**
 * upload_file must CONFIRM the crop/adjust dialog that sites (YouTube's banner + photo) pop after a
 * file is chosen — otherwise the image never commits and the agent stalls hunting for a button.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-fc-'));
process.env.PROFILE_DIR = dir;
const fa = await import('../src/fileAssets.js');
const filesMod = await import('../src/tools/files.js');
const files = filesMod.default || filesMod;
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function ctx(page) {
  const steps = [], said = [];
  return { steps, said, page: () => page, settle: async () => {}, step: (k, t) => steps.push([k, t]), observe: (t) => said.push(t), resetClickLoop: () => {}, session: () => ({}) };
}

describe('upload_file crop-confirm', () => {
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
