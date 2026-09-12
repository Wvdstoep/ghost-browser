/**
 * The cross-session file conveyor — a file downloaded on one site's session must be uploadable from
 * another's, so it lives on disk keyed by id, not in one session's memory.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-fa-'));
process.env.PROFILE_DIR = dir;
const fa = await import('../src/fileAssets.js');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('fileAssets store', () => {
  it('stores bytes and reads the exact bytes back by id, with mime + ext', () => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const id = fa.put({ mime: 'video/mp4', kind: 'clip', bytes });
    expect(id).toMatch(/^f[0-9a-f]+$/);
    const got = fa.get(id);
    expect(got.mime).toBe('video/mp4');
    expect(got.ext).toBe('mp4');
    expect(got.kind).toBe('clip');
    expect(Buffer.compare(got.bytes, bytes)).toBe(0);
  });
  it('refuses empty bytes and returns null for a missing id', () => {
    expect(fa.put({ mime: 'image/png', bytes: Buffer.alloc(0) })).toBeNull();
    expect(fa.get('missing')).toBeNull();
  });
  it('lists stored files without their bytes', () => {
    fa.put({ mime: 'image/png', bytes: Buffer.from([9, 9, 9]) });
    const l = fa.list();
    expect(l.length).toBeGreaterThan(0);
    expect(l[0].bytes).toBeUndefined();
    expect(l[0].size).toBeGreaterThan(0);
  });

  it('removes a stored file (bytes + sidecar) so the Files tab can delete it', () => {
    const id = fa.put({ mime: 'image/png', kind: 'cover', bytes: Buffer.from([1, 2, 3, 4]) });
    expect(fa.get(id)).not.toBeNull();
    expect(fa.remove(id)).toBe(true);
    expect(fa.get(id)).toBeNull();
    expect(fa.list().some((m) => m.id === id)).toBe(false);
  });
});

/*
 * ── THE FIRST DIAGRAM THIS PLATFORM EVER GENERATED WAS THROWN AWAY AT THE DOOR ───────────────────
 *
 * An answer page asked for "the deploy log showing a helm upgrade with a rollback line". No screen
 * shows that — a screenshot is a moment and that is a sequence — so the walk went to AI Studio,
 * drew it, and downloaded it. Then the page store refused it: an image published without its width
 * and height shifts the layout as it loads, and the store will not serve one that cannot say how big
 * it is. The walk had done everything right and there was nothing in it to fix.
 *
 * screenshot_page measures what it takes. download_image did not, and neither did the brand canvas,
 * the file upload, or an organ posting bytes — five callers, one of which had been taught. So the
 * shelf reads the size out of the bytes itself, and no future caller has to remember.
 */
describe('an image is measured on the way in, whoever files it', () => {
  /* Real headers, hand-built: the point is that no decoder and no dependency is involved. */
  const png = (w, h) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return b;
  };
  const gif = (w, h) => {
    const b = Buffer.alloc(24);
    b.write('GIF89a', 0, 'ascii');
    b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
    return b;
  };
  const jpeg = (w, h) => {
    /* A comment segment first, so the marker walk has to step over something to find the frame. */
    const b = Buffer.alloc(64);
    b.writeUInt16BE(0xffd8, 0);
    b.writeUInt16BE(0xfffe, 2); b.writeUInt16BE(6, 4);
    b.writeUInt16BE(0xffc0, 10); b.writeUInt16BE(17, 12);
    b[14] = 8; b.writeUInt16BE(h, 15); b.writeUInt16BE(w, 17);
    return b;
  };

  it('a PNG carries its size in the header, and the shelf keeps it', () => {
    const got = fa.get(fa.put({ mime: 'image/png', kind: 'diagram', bytes: png(1408, 768) }));
    expect(got.width).toBe(1408);
    expect(got.height).toBe(768);
  });

  it('so do a GIF and a JPEG, whose size sits behind its markers', () => {
    expect(fa.get(fa.put({ mime: 'image/gif', bytes: gif(640, 480) })).width).toBe(640);
    const j = fa.get(fa.put({ mime: 'image/jpeg', bytes: jpeg(1200, 630) }));
    expect(j.width).toBe(1200);
    expect(j.height).toBe(630);
  });

  /* A caller that DID measure knows better than a header — a resized upload, say. */
  it('a size the caller measured itself is never overwritten', () => {
    const got = fa.get(fa.put({ mime: 'image/png', width: 800, height: 400, bytes: png(1408, 768) }));
    expect(got.width).toBe(800);
    expect(got.height).toBe(400);
  });

  /*
   * Storing it anyway is deliberate. Most of this shelf is not images, and a video or a PDF that
   * cannot be measured must still file — only the page store cares about dimensions, and it says so
   * itself rather than having this one guess on its behalf.
   */
  it('and something unmeasurable still files, just without a size', () => {
    expect(fa.imageSize(Buffer.from([1, 2, 3]))).toBeNull();
    const got = fa.get(fa.put({ mime: 'image/png', bytes: Buffer.from([1, 2, 3, 4, 5]) }));
    expect(got.width).toBeUndefined();
    expect(got.size).toBe(5);
  });
});
