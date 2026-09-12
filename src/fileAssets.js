'use strict';
/**
 * fileAssets.js — a persistent, cross-session file store: the automation conveyor.
 *
 * The per-session image store (assets.js) lives in ONE session's memory, so a file downloaded on the
 * Gemini session could never be uploaded from the CapCut session. This store is on DISK, under the
 * profile volume, so any step — in any session, and any run after a restart — can pick a file up by
 * its id. That is the whole conveyor: download_file puts a file here and hands back an id; a later
 * step's upload_file reads the id back and sets a file input. Bytes go to <id>.<ext>, a tiny sidecar
 * <id>.json carries the mime/name so a different session can rebuild the upload without guessing.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'file-assets');
const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'application/pdf': 'pdf',
};
const extFor = (mime) => EXT[String(mime || '').toLowerCase()]
  || (String(mime || '').split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';

const ensure = () => { try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* best effort */ } };
const metaPath = (id) => path.join(DIR, `${id}.json`);

/** Store bytes on disk; returns the id a later tool uses to fetch them. `bytes` is a Buffer. */
/*
 * WIDTH AND HEIGHT ARE PART OF WHAT A PICTURE IS.
 *
 * A screenshot was taken, measured, and stored — and the size was dropped on the way in, so what came
 * back off the shelf was bytes with no dimensions. The page store refuses an image that cannot say
 * how big it is, because one published without its size shifts the layout as it loads and that is
 * measured and counted against the page. So a walk took the picture, the collection could not use it,
 * and nothing anywhere said why.
 *
 * Optional, because most things on this shelf are not images.
 */
/*
 * IF THE CALLER DID NOT MEASURE IT, MEASURE IT HERE.
 *
 * screenshot_page measures what it took, because it was taught to after a picture was refused. Every
 * OTHER way an image reaches this shelf — download_image, make_brand_image, an upload, an organ
 * posting bytes — files it with no size at all, and the page store refuses those for the same good
 * reason: an image published without its width and height shifts the layout as it loads.
 *
 * That cost a whole walk. The first diagram this platform ever generated for an answer page came
 * back from AI Studio, downloaded fine, and was thrown away at the door — the walk had done nothing
 * wrong and there was nothing to fix in it.
 *
 * Teaching each caller to measure would leave the next one to forget, so the shelf reads the size out
 * of the bytes itself. Every image format writes its dimensions in a header near the front, so this
 * needs no decoder and no dependency: PNG in the IHDR chunk, GIF in its screen descriptor, WebP in
 * whichever of its three chunk types it uses, JPEG in the frame header the markers have to be walked
 * to reach. Anything unrecognised measures as nothing and is stored as before.
 */
function imageSize(bytes) {
  const b = bytes;
  if (!b || b.length < 24) return null;
  try {
    /* PNG: an 8-byte signature, then IHDR — width and height as big-endian 32-bit at 16 and 20. */
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    /* GIF: "GIF87a"/"GIF89a", then the logical screen size as little-endian 16-bit. */
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    /* WebP: RIFF....WEBP, then one of three chunk types, each writing the size its own way. */
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const n = b.readUInt32LE(21);
        return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    }
    /* JPEG: the size lives in the frame header, which is only reachable by walking the markers. */
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i += 1; continue; }
        const m = b[i + 1];
        /* Standalone markers carry no length, so they are stepped over rather than skipped by one. */
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        const len = b.readUInt16BE(i + 2);
        if (len < 2) break;
        /* SOF0-SOF15 are the frame headers; c4/c8/cc share the range and are not. Height first. */
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* a truncated or malformed header measures as nothing, which is the honest answer */ }
  return null;
}

function put({ mime = 'application/octet-stream', name = null, kind = 'file', width = 0, height = 0, source = '', bytes } = {}) {
  if (!bytes || !bytes.length) return null;
  if ((!(Number(width) > 0) || !(Number(height) > 0)) && /^image\//i.test(String(mime || ''))) {
    const m = imageSize(bytes);
    if (m && m.width > 0 && m.height > 0) { width = m.width; height = m.height; }
  }
  ensure();
  const id = 'f' + crypto.randomBytes(8).toString('hex');
  const ext = extFor(mime);
  try {
    fs.writeFileSync(path.join(DIR, `${id}.${ext}`), bytes, { mode: 0o600 });
    fs.writeFileSync(metaPath(id), JSON.stringify({
      id, mime, name: name || `${kind}.${ext}`, kind, ext, size: bytes.length,
      ...(Number(width) > 0 && Number(height) > 0 ? { width: Math.round(width), height: Math.round(height) } : {}),
      ...(source ? { source: String(source).slice(0, 40) } : {}),
      at: new Date().toISOString(),
    }), { mode: 0o600 });
  } catch { return null; }
  return id;
}

/** Read a stored file back — { id, mime, name, kind, ext, size, path, bytes } — or null. */
function get(id) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(String(id)), 'utf8'));
    const file = path.join(DIR, `${meta.id}.${meta.ext}`);
    return { ...meta, path: file, bytes: fs.readFileSync(file) };
  } catch { return null; }
}

/** The most recent stored file (optionally of a kind), fully read — for a "use the one I just made"
 *  step where the caller did not keep the id. Newest by stored-at time. */
function latest(kind = null) {
  const metas = list().filter((m) => !kind || m.kind === kind);
  if (!metas.length) return null;
  metas.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return get(metas[0].id);
}

/** Metadata of every stored file (no bytes). */
function list() {
  ensure();
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** Forget a stored file — its bytes and its sidecar. Returns whether anything was removed. */
function remove(id) {
  let ok = false;
  try { const m = JSON.parse(fs.readFileSync(metaPath(String(id)), 'utf8')); fs.unlinkSync(path.join(DIR, `${m.id}.${m.ext}`)); ok = true; } catch { /* bytes already gone */ }
  try { fs.unlinkSync(metaPath(String(id))); ok = true; } catch { /* meta already gone */ }
  return ok;
}

module.exports = { put, get, latest, list, remove, extFor, imageSize, DIR };
