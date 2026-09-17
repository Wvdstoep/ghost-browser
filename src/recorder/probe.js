'use strict';
/**
 * recorder/probe.js — Phase 0's proof: record ONE page for a few seconds through the sidecar and
 * measure the result (is there an audio stream, is it silent, how big). Stored in the file store like
 * any capture so the app can play it. The real engine (Phase 1) builds on the same sidecar.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sc = require('./sidecar');

function run(bin, args) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p; try { p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out, err: e.message })); p.on('close', (code) => resolve({ code, out, err }));
  });
}

/** Streams and loudness of a media file: { streams: ['video','audio'], meanDb, maxDb } (dB below full scale; -91 = digital silence). */
async function measure(file) {
  const pr = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
  const streams = pr.out.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const vd = await run('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(vd.err), max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(vd.err);
  return { streams, meanDb: mean ? Number(mean[1]) : null, maxDb: max ? Number(max[1]) : null };
}

/**
 * probe({ url, profile, seconds, quality, profileDir, cfg, log, store }) → { fileId, name, seconds, bytes, audio, display }
 * `store(bytes, name)` puts the mp4 in the file store and returns its id. Every process is torn down
 * in `finally`, whatever happened.
 */
async function probe({ url, profile = 'default', seconds = 20, quality = '720p', profileDir, cfg = {}, log, store, warmupMs = 4000 }) {
  const size = sc.sizeOf(quality); const id = `probe-${Date.now().toString(36)}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-probe-')); const clone = path.join(work, 'profile'); const out = path.join(work, 'probe.mp4');
  let display = null, pulse = null, context = null, ff = null;
  const t0 = Date.now();
  try {
    sc.cloneCookies(profileDir, profile, clone);
    display = await sc.startDisplay(size, log);
    pulse = await sc.startPulse(id, log);
    context = await sc.launchBrowser({ profileDir: clone, display: display.n, pulseServer: pulse.server, size, cfg, log });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => { log && log.warn && log.warn(`[rec] probe goto: ${e.message}`); });
    await page.waitForTimeout(warmupMs);
    // a page with a video: make sure it plays, unmuted, and fills the screen
    await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.muted = false; v.volume = 1; const p = v.play(); if (p && p.catch) p.catch(() => {}); } }).catch(() => {});
    ff = sc.startFfmpeg({ display: display.n, size, out, mode: 'mp4', seconds: Math.max(3, Math.min(600, Number(seconds) || 20)) }, pulse.server, log);
    const r = await ff.done;
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg ended with ${r.code}: ${r.err.slice(-400)}`);
    const bytes = fs.readFileSync(out);
    const audio = await measure(out);
    const name = `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
    const fileId = store ? store(bytes, name) : null;
    return { fileId, name, seconds: Math.round((Date.now() - t0) / 1000), bytes: bytes.length, audio, display: display.n, sound: audio.streams.includes('audio') && audio.maxDb != null && audio.maxDb > -60 };
  } finally {
    if (ff) { try { await ff.stop(3000); } catch { /* ending */ } }
    if (context) { try { await context.close(); } catch { /* gone */ } }
    if (pulse) pulse.stop();
    if (display) display.stop();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { probe, measure };
