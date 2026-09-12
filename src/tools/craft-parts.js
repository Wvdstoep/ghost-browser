'use strict';
/**
 * tools/craft-parts.js — the pure half of craft.js: the RFC 6238 authenticator, the base32 it reads,
 * what counts as a secret, the print wrapper and the filename.
 *
 * WHY ITS OWN FILE. tools/index.js builds the registry with Object.assign, so every enumerable key a
 * tool module exports becomes a callable tool name — and the registry's own guard ("never claims a
 * name it cannot run") rightly fails on one that is not on the palette. These are not tools; they are
 * the arithmetic the tools are made of, and they are exactly the part that must be provably right
 * (a TOTP that is one step out is a lockout). So they live here, tested directly.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fileAssets = require('../fileAssets');

const PROFILE_DIR = process.env.PROFILE_DIR || '/profiles';
const TOTP_FILE = path.join(PROFILE_DIR, 'totp.json');

/* ── a document, as a document ─────────────────────────────────────────────────────────────────── */

/*
 * THE HOUSE STYLESHEET. A CV that arrives as unstyled HTML says more about the sender than its
 * contents do, and the model composing one should be spending its attention on what the document
 * SAYS. So print-sane defaults come for free: a real page size, readable measure, a type scale that
 * survives a printer, and no orphaned headings. An author who sends their own <style> keeps it —
 * this is a floor, never a ceiling.
 */
const HOUSE_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10.5pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #14161a; }
  h1 { font-size: 20pt; margin: 0 0 2pt; letter-spacing: -0.01em; }
  h2 { font-size: 11.5pt; margin: 16pt 0 6pt; text-transform: uppercase; letter-spacing: 0.08em; color: #4a5058; border-bottom: 0.6pt solid #d7dbe0; padding-bottom: 3pt; }
  h3 { font-size: 10.5pt; margin: 10pt 0 1pt; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  p, li { margin: 0 0 5pt; }
  ul { margin: 0 0 8pt; padding-left: 14pt; }
  a { color: #14161a; text-decoration: none; border-bottom: 0.5pt solid #b9bfc7; }
  .muted, .meta { color: #5b626b; }
  .row { display: flex; justify-content: space-between; gap: 12pt; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 3pt 6pt 3pt 0; vertical-align: top; }
  img { max-width: 100%; }
`;

/** Wrap a fragment into a print-ready document; a full document the author sent is left alone. */
function documentHtml(html, title) {
  const s = String(html || '');
  if (/<html[\s>]/i.test(s)) return s;
  const hasStyle = /<style[\s>]/i.test(s);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${String(title || 'Document').replace(/[<>&]/g, '')}</title>`
    + (hasStyle ? '' : `<style>${HOUSE_CSS}</style>`)
    + `</head><body>${s}</body></html>`;
}

/*
 * A NAME A PLATFORM WILL ACCEPT. The file is uploaded as bytes with a name, never written to a path,
 * so this is about what a recipient sees rather than about traversal — but a name like "....pdf" is
 * its own kind of unprofessional, so runs of dots collapse and leading punctuation goes.
 */
const safeName = (name, fallback) => {
  const cleaned = String(name || '')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-\s]+/, '')
    .trim().replace(/\s+/g, '-').slice(0, 60);
  const base = cleaned || fallback;
  return /\.pdf$/i.test(base) ? base : `${base.replace(/\.\w+$/, '')}.pdf`;
};

/* ── an authenticator app, in the browser ──────────────────────────────────────────────────────── */

/** RFC 4648 base32 → bytes. Padding, spaces and lower case are what a page actually shows. */
function base32Decode(input) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const i = A.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP — the same six digits an authenticator app would show right now. */
function totp(secret, { now = Date.now(), step = 30, digits = 6 } = {}) {
  const key = base32Decode(secret);
  if (!key.length) return null;
  const counter = Math.floor(now / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 4294967296), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return {
    code: String(bin % (10 ** digits)).padStart(digits, '0'),
    secondsLeft: step - Math.floor((now / 1000) % step),
  };
}

/** An otpauth:// URI, a "secret: xxxx" line, or the bare base32 — whatever the page gave. */
function secretFrom(text) {
  const s = String(text || '').trim();
  const uri = s.match(/[?&]secret=([A-Za-z2-7= ]+)/i);
  if (uri) return uri[1].replace(/\s+/g, '');
  const labelled = s.match(/secret\s*[:=]\s*([A-Za-z2-7= ]{16,})/i);
  if (labelled) return labelled[1].replace(/\s+/g, '');
  const bare = s.replace(/\s+/g, '');
  return /^[A-Za-z2-7=]{16,}$/.test(bare) ? bare : '';
}

const readSecrets = () => { try { return JSON.parse(fs.readFileSync(TOTP_FILE, 'utf8')) || {}; } catch { return {}; } };
const writeSecrets = (all) => {
  try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch { /* it exists */ }
  fs.writeFileSync(TOTP_FILE, JSON.stringify(all, null, 1), { mode: 0o600 });
};
const accountKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 60);


module.exports = { totp, base32Decode, secretFrom, documentHtml, safeName, HOUSE_CSS, TOTP_FILE, readSecrets, writeSecrets, accountKey };
