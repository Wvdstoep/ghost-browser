'use strict';
/**
 * uihelpers.js — shared upload plumbing used by both the image tools (images.js) and the file tools
 * (files.js), so the fixes live in ONE place:
 *
 *  - confirmUploadDialog: after a file goes into an input, sites (YouTube's banner + photo) pop a
 *    crop/adjust dialog that must be CONFIRMED ("Gereed"/"Klaar"/"Done") or the image never commits
 *    and the agent stalls. Find that button (native or a custom element) and click it.
 *  - resizeImageBytes: generated art is captured at display size (~700px), but YouTube rejects a
 *    banner under 1024x576. Resize to spec (scale-to-cover + centre-crop) with ffmpeg so nothing is
 *    ever undersized — the fix for "Afbeeldingen moeten minimaal 1024 x 576 pixels hebben".
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CONFIRM_RE = /^(gereed|klaar|done|toepassen|apply|opslaan|save|bijsnijden|selecteren|select|ok)$/i;

async function confirmUploadDialog(page) {
  let els = [];
  try { els = await page.$$('button, [role="button"], ytcp-button, tp-yt-paper-button'); } catch { return null; }
  for (const b of els.slice(0, 120)) {
    let t = '';
    try { t = ((await b.innerText()) || '').trim(); } catch { continue; }
    if (!t || t.length > 20 || !CONFIRM_RE.test(t)) continue;
    let vis = false; try { vis = await b.isVisible(); } catch { vis = false; }
    if (!vis) continue;
    try { await b.click(); return t; } catch { /* try the next candidate */ }
  }
  return null;
}

// Scale-to-cover + centre-crop to exactly w×h. Returns new bytes, or the original if ffmpeg is
// missing/fails (never throws — a correctly-sized-enough image is better than none).
function resizeImageBytes(bytes, w, h) {
  return new Promise((resolve) => {
    if (!bytes || !bytes.length) return resolve(bytes);
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const inP = path.join(os.tmpdir(), `rin-${tag}.png`);
    const outP = path.join(os.tmpdir(), `rout-${tag}.png`);
    try { fs.writeFileSync(inP, bytes); } catch { return resolve(bytes); }
    const done = (out) => { try { fs.unlinkSync(inP); } catch {} try { fs.unlinkSync(outP); } catch {} resolve(out && out.length ? out : bytes); };
    let ff;
    try {
      ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', inP,
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`, '-y', outP]);
    } catch { return done(null); }
    ff.on('error', () => done(null));
    ff.on('close', (code) => { let out = null; try { if (code === 0) out = fs.readFileSync(outP); } catch {} done(out); });
  });
}

// The size each channel-art kind must meet for YouTube (banner min 1024x576 → use the recommended
// 2048x1152; a profile photo is square).
const SPEC = { cover: [2048, 1152], banner: [2048, 1152], profile: [800, 800] };

module.exports = { confirmUploadDialog, resizeImageBytes, CONFIRM_RE, SPEC };
