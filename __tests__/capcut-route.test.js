/*
 * THE CAPCUT ROUTE — the capability, and the knowledge two walks paid for.
 *
 * Both previous attempts failed for reasons nobody wrote down, so the second repeated the first:
 *
 *   j-mtiljjit (20/09, 81 steps, stopped by hand, no report) — upload_file WORKED four times, but the
 *   walk could not see the clip in the media panel, re-opened /editor, and uploaded again. diagnostics
 *   named it: REDIRECT LOOP, /editor bounced to /my-edit eight times in ten navigations.
 *
 *   j-mucm0xwu (22/09, 84 steps) — no role, so "no card for this intent — walk the UI", then five
 *   run_script probes and out of budget, reporting ON the editor instead of producing a video.
 *
 * And underneath both: the footage could not get in at all. start_recording stores into fileAssets,
 * which upload_file reads; the PLATFORM recorder writes /recordings/<id>/final.mp4 on another volume.
 * A real 122 MB recording had no route into CapCut, however well the agent was instructed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

let RECDIR;
let files;
let roles;

beforeAll(() => {
  // RECORDINGS_DIR is read at module load, so it must be set before the require.
  RECDIR = mkdtempSync(join(tmpdir(), 'gb-recordings-'));
  process.env.RECORDINGS_DIR = RECDIR;
  files = require('../src/recordings.js');
  roles = require('../src/roles.js');

  // A finished recording: a video plus the metadata the recorder writes beside it.
  mkdirSync(join(RECDIR, 'rec-done-1'), { recursive: true });
  writeFileSync(join(RECDIR, 'rec-done-1', 'final.mp4'), Buffer.from('not really mp4, but bytes'));
  writeFileSync(join(RECDIR, 'rec-done-1', 'recording.json'),
    JSON.stringify({ title: 'Falling In: seedgear/discount', seconds: 247 }));

  // One still encoding: the directory exists, the video does not yet.
  mkdirSync(join(RECDIR, 'rec-busy-2'), { recursive: true });
  writeFileSync(join(RECDIR, 'rec-busy-2', 'recording.json'), JSON.stringify({ title: 'half done' }));

  // One that finished with an empty file — a failed encode, which is not footage.
  mkdirSync(join(RECDIR, 'rec-empty-3'), { recursive: true });
  writeFileSync(join(RECDIR, 'rec-empty-3', 'final.mp4'), Buffer.alloc(0));
});

afterAll(() => { try { rmSync(RECDIR, { recursive: true, force: true }); } catch { /* temp dir */ } });

describe('a platform recording can be uploaded', () => {
  it('a finished recording comes back shaped like a file asset', () => {
    const a = files.recordingAsset('rec-done-1');
    expect(a).toBeTruthy();
    expect(a.mime).toBe('video/mp4');
    expect(a.kind).toBe('clip');
    expect(a.bytes.length).toBeGreaterThan(0);
    expect(a.source).toBe('recording');
  });

  it('it is named after the recording, not after its id', () => {
    // The owner recognises "Falling In…", not rec-done-1 — and the name is what CapCut shows in the
    // media panel, which is the thing the walk has to find again in step 3.
    expect(files.recordingAsset('rec-done-1').name).toBe('Falling In_ seedgear_discount.mp4');
  });

  it('a recording still encoding is null, not half a file', () => {
    expect(files.recordingAsset('rec-busy-2')).toBeNull();
  });

  it('a failed encode (empty file) is null too', () => {
    expect(files.recordingAsset('rec-empty-3')).toBeNull();
  });

  it('an id is an id, never a path', () => {
    for (const bad of ['../../etc/passwd', 'rec/../../x', 'a\\b', '', '   ', null]) {
      expect(files.recordingAsset(bad), String(bad)).toBeNull();
    }
  });

  it('an unknown recording is null rather than a throw', () => {
    expect(files.recordingAsset('rec-does-not-exist')).toBeNull();
  });
});

/*
 * NO ROLE TEST HERE, ON PURPOSE.
 *
 * I wrote a capcut.short role in roles.js and pinned its rules here — and then found the real one:
 * /profiles/roles/capcut-video-editor.json, owner-authored DATA, driven by the automation
 * /profiles/workflows/capcut-vertical-demo-edit-desktop-node.json. It runs on the DESKTOP node,
 * where click_xy and drag_xy (with Input.setInterceptDrags) actually exist. I had looked for it in
 * the code and concluded there was nothing; roles and automations live in the profile store.
 *
 * So the role is gone from roles.js. Two roles for one job, one of them aimed at the cluster browser
 * that has no drag primitives, is how a future run picks the wrong one. What is left below is the
 * part that was genuinely missing: a platform recording could not reach a page at all.
 */
