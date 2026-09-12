'use strict';
/**
 * assets.js — a per-session store of image BYTES, so a walk can make (or fetch) an image and then
 * use it a step later. It sits on the session beside the recorder, for the same reason: an image is
 * execution state of ONE logged-in browser (a brand mark drawn for this brand, a photo pulled inside
 * this session), not portable data. In memory only and small — a handful of images per walk — and
 * gone when the session is reaped, which is correct: a profile picture that was uploaded is on the
 * platform now, not something this process needs to keep.
 *
 * It is the seam that lets GENERATE and USE be two steps: make_brand_image (or, later, a Gemini/stock
 * fetch) puts bytes here and hands back an id; upload_image reads the id back and sets a file input
 * from it. Neither tool has to hold the bytes itself, and a walk can make three and pick one.
 */

function makeAssetStore() {
  const items = new Map();     // id → { id, kind, mime, name, source, bytes, at }
  let n = 0;

  return {
    /** Store bytes; returns the id a later tool uses to fetch them. `bytes` is a Buffer. */
    put({ kind = 'image', mime = 'image/png', name = null, source = 'unknown', bytes, at = 0 }) {
      if (!bytes || !bytes.length) return null;
      const id = `img-${++n}`;
      items.set(id, { id, kind, mime, name: name || `${kind}.${extFor(mime)}`, source, bytes, at });
      return id;
    },
    get(id) { return items.get(String(id)) || null; },
    /** For a tool that wants the freshest image of a kind (the cover it just made). */
    latest(kind = null) {
      let best = null;
      for (const a of items.values()) if (!kind || a.kind === kind) best = a;   // insertion order → last wins
      return best;
    },
    /** Safe to render/log — METADATA only, never the bytes. */
    list() {
      return [...items.values()].map(({ id, kind, mime, name, source, bytes }) => ({ id, kind, mime, name, source, bytes: bytes.length }));
    },
    get size() { return items.size; },
  };
}

function extFor(mime) {
  if (/png/i.test(mime)) return 'png';
  if (/jpe?g/i.test(mime)) return 'jpg';
  if (/webp/i.test(mime)) return 'webp';
  if (/gif/i.test(mime)) return 'gif';
  return 'bin';
}

module.exports = { makeAssetStore, extFor };
