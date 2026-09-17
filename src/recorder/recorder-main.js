'use strict';
/**
 * recorder/recorder-main.js — ONE recording, as a pod of its own (MODE=recorder, Phase 3).
 *
 * Fetches the handoff from Ghost Browser (the ask, the owner's cookies, the profile's identity) with
 * the recording's token, records with the same engine and sidecar as the in-pod path into a scratch
 * disk, and pushes every finished segment, the playlist and its journal to GB as it goes — segments
 * are deleted here once GB has them, so the scratch disk never fills. GB stores and serves them like
 * its own. The owner's stop arrives through the handoff's `stop` flag. Exit 0 when the journal is final.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const GB = String(process.env.GB_URL || '').replace(/\/$/, '');
const ID = String(process.env.RECORDING_ID || '');
const TOKEN = String(process.env.RECORDING_TOKEN || '');
const log = { info: (m) => console.log(m), warn: (m) => console.log('WARN', m), debug: () => {} };

function api(method, p, body, type = 'application/json') {
  return new Promise((resolve, reject) => {
    const u = new URL(GB + p); const mod = u.protocol === 'https:' ? https : http;
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = mod.request({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, headers: { Authorization: `Bearer ${TOKEN}`, ...(data ? { 'Content-Type': type, 'Content-Length': data.length } : {}) }, timeout: 120000 }, (res) => {
      let out = ''; res.on('data', (d) => { out += d; }); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(out ? JSON.parse(out) : {}); } catch { resolve({ raw: out }); } } else reject(new Error(`${method} ${p} → ${res.statusCode}: ${out.slice(0, 200)}`)); });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data); req.end();
  });
}

/** Segments in `dir` that are complete (a newer one exists after them, or the recording is over) and not yet pushed. */
function readySegments(dir, pushed, final = false) {
  let names = []; try { names = fs.readdirSync(dir).filter((f) => /^seg-\d+\.ts$/.test(f)).sort(); } catch { return []; }
  const done = final ? names : names.slice(0, -1);   // the last one may still be written to
  return done.filter((n) => !pushed.has(n));
}

async function main() {
  if (!GB || !ID || !TOKEN) throw new Error('GB_URL, RECORDING_ID and RECORDING_TOKEN are required');
  const sc = require('./sidecar'); const pg = require('./page'); const { Recorder } = require('./engine');
  const caps = sc.capabilities(); if (!caps.ok) throw new Error(`cannot record here: ${caps.hint}`);
  const h = await api('GET', `/v1/recordings/${ID}/handoff`);
  log.info(`[recorder-pod] ${ID}: ${h.url} (${h.quality}, until ${h.until}, ≤${h.maxMinutes} min, ${(h.cookies || []).length} cookies)`);
  const root = sc.recordingsRoot();
  const deps = { capabilities: sc.capabilities, freeBytes: sc.freeBytes, sizeOf: sc.sizeOf, startDisplay: sc.startDisplay, startPulse: sc.startPulse, launchBrowser: sc.launchBrowser, startFfmpeg: sc.startFfmpeg,
    cookiesFor: async () => h.cookies || [], preparePage: pg.preparePage, videoState: pg.videoState, platformCookies: pg.platformCookies, profileConfig: () => h.cfg || {} };
  const r = new Recorder({ root, deps, log, maxConcurrent: 1 });
  const v = r.start({ id: ID, url: h.url, profile: h.profile, quality: h.quality, until: h.until, maxMinutes: h.maxMinutes, title: h.title, mode: 'local' });
  const dir = r.dirOf(v.id); const pushed = new Set(); let lastJournal = '';
  async function push(final = false) {
    for (const n of readySegments(dir, pushed, final)) {
      const f = path.join(dir, n); const bytes = fs.readFileSync(f);
      await api('PUT', `/v1/recordings/${ID}/segments/${n}`, bytes, 'video/mp2t'); pushed.add(n);
      try { fs.unlinkSync(f); } catch { /* fine */ }
    }
    try { await api('PUT', `/v1/recordings/${ID}/segments/index.m3u8`, fs.readFileSync(path.join(dir, 'index.m3u8')), 'application/vnd.apple.mpegurl'); } catch { /* not written yet */ }
    const j = r.get(ID); const body = JSON.stringify({ state: j.state, seconds: j.seconds, bytes: j.bytes, segments: j.segments, pageTitle: j.pageTitle, prepared: j.prepared, reason: j.reason, error: j.error, recordingAt: j.recordingAt, endedAt: j.endedAt, display: j.display });
    if (body !== lastJournal || final) { await api('PUT', `/v1/recordings/${ID}/journal`, body); lastJournal = body; }
    return j;
  }
  while (true) {
    await new Promise((res) => setTimeout(res, 5000));
    let j; try { j = await push(false); } catch (e) { log.warn(`[recorder-pod] push: ${e.message}`); j = r.get(ID); }
    try { const c = await api('GET', `/v1/recordings/${ID}/handoff`); if (c.stop && r.running().includes(ID)) { log.info(`[recorder-pod] stop asked: ${c.stop}`); r.stop(ID, String(c.stop)); } } catch { /* GB may be rolling; keep recording */ }
    if (j && !['starting', 'recording', 'finishing'].includes(j.state)) break;
  }
  // the last segment, the closed playlist, the final journal — retried, GB may be mid-roll
  for (let i = 0; i < 30; i++) { try { const j = await push(true); log.info(`[recorder-pod] ${ID} ${j.state}: ${j.reason || j.error || ''} — ${j.seconds}s, ${j.segments} segments`); return; } catch (e) { log.warn(`[recorder-pod] final push (${i + 1}/30): ${e.message}`); await new Promise((res) => setTimeout(res, 10000)); } }
  throw new Error('could not deliver the final segments');
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { log.warn(`[recorder-pod] FAIL ${e.stack || e.message}`); process.exit(1); });
module.exports = { readySegments, api };
