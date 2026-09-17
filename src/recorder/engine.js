'use strict';
/**
 * recorder/engine.js — a recording is a JOB WITH A JOURNAL (docs/RECORDER-PLAN.md, Phase 1).
 *
 * start() spins the sidecar up (display, sound, browser, encoder — all private to this recording),
 * prepares the page (consent wall, play, unmute, full screen), and ffmpeg writes 10-second HLS
 * segments to /recordings/<id>/ as it goes: nothing is held in memory, hours cost disk, the playlist
 * plays while recording and after. A tick every 5 s reads the stats from the files and checks the end
 * rules: the video ended, a duration, the owner's stop, the disk guard, the browser gone. Finishing
 * lets ffmpeg close the playlist, probes the duration and tears the sidecar down. A recording whose
 * process is gone when GB comes back is closed as `partial` — still playable.
 *
 * Every process-touching dependency is injected (`deps`) so the state machine is tested without a
 * browser; the real ones come from sidecar.js and page.js.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const STATES = ['starting', 'recording', 'finishing', 'done', 'partial', 'failed'];
const UNTIL = ['video-ends', 'duration', 'owner-stop'];
const TICK_MS = 5000;
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;   // the disk guard: end cleanly with 2 GiB left
const DEFAULT_MAX_MIN = { 'video-ends': 240, 'duration': 60, 'owner-stop': 360 };
const HARD_MAX_MIN = 12 * 60;

const now = () => Date.now();
const newId = () => `rec-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seconds and bytes from what ffmpeg wrote so far — the files are the truth. */
function statsOf(dir) {
  let segments = 0, bytes = 0, seconds = 0;
  try {
    for (const f of fs.readdirSync(dir)) { if (/^seg-\d+\.ts$/.test(f)) { segments++; try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* mid-write */ } } }
    const m3u8 = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8');
    for (const m of m3u8.matchAll(/#EXTINF:([\d.]+)/g)) seconds += Number(m[1]) || 0;
  } catch { /* nothing written yet */ }
  return { segments, bytes, seconds: Math.round(seconds) };
}

/** A playlist ffmpeg never got to close (a restart, a kill) is closed by hand so players know it ended. */
function closePlaylist(dir) {
  const f = path.join(dir, 'index.m3u8');
  try { const s = fs.readFileSync(f, 'utf8'); if (!/#EXT-X-ENDLIST/.test(s)) fs.appendFileSync(f, '\n#EXT-X-ENDLIST\n'); return true; } catch { return false; }
}

/** ffmpeg arguments that turn a finished playlist into one mp4 without re-encoding (Range-served). */
function concatArgs(dir) { return ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(dir, 'index.m3u8'), '-c', 'copy', '-movflags', '+faststart', path.join(dir, 'final.mp4')]; }

/** What identifies "the same video": YouTube's v parameter; elsewhere the address without its hash. */
function videoKey(href) { try { const u = new URL(String(href || '')); if (/youtube\.com$/.test(u.hostname) || /youtu\.be$/.test(u.hostname)) return u.searchParams.get('v') || u.pathname; u.hash = ''; return u.toString(); } catch { return String(href || ''); } }

function readJournal(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'recording.json'), 'utf8')); } catch { return null; } }

class Recorder {
  /**
   * @param {object} o
   * @param {string} o.root           /recordings (see sidecar.recordingsRoot)
   * @param {object} o.deps           { startDisplay, startPulse, launchBrowser, startFfmpeg, cookiesFor, preparePage, videoState, freeBytes, capabilities, sizeOf, concat }
   * @param {number} [o.maxConcurrent]
   */
  constructor({ root, deps, log, maxConcurrent = 2, tickMs = TICK_MS, clock = now }) {
    this.root = root; this.deps = deps; this.log = log || { info() {}, warn() {}, debug() {} };
    this.maxConcurrent = maxConcurrent; this.tickMs = tickMs; this.clock = clock;
    this.live = new Map();   // id → { rec, ctx: { display, pulse, context, page, ff }, stopReq }
    fs.mkdirSync(root, { recursive: true });
  }

  dirOf(id) { return path.join(this.root, String(id).replace(/[^a-z0-9_-]/gi, '')); }

  list() {
    const out = [];
    try { for (const d of fs.readdirSync(this.root)) { const j = readJournal(path.join(this.root, d)); if (j) out.push(this.view(j)); } } catch { /* empty */ }
    return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
  get(id) { const j = readJournal(this.dirOf(id)); return j ? this.view(j) : null; }
  view(j) { const live = this.live.get(j.id); return { ...j, live: !!live, playlist: `/v1/recordings/${j.id}/index.m3u8`, mp4: `/v1/recordings/${j.id}/mp4` }; }
  running() { return [...this.live.values()].map((l) => l.rec.id); }

  _save(rec) { const dir = this.dirOf(rec.id); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'recording.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(rec)); fs.renameSync(f + '.tmp', f); }
  _set(rec, patch) { Object.assign(rec, patch); this._save(rec); }

  /** Journals left `starting`/`recording`/`finishing` by a process that is gone: closed as partial, still playable. */
  adopt() {
    let n = 0;
    for (const r of this.list()) {
      if (!['starting', 'recording', 'finishing'].includes(r.state) || this.live.has(r.id)) continue;
      const dir = this.dirOf(r.id); closePlaylist(dir);
      const st = statsOf(dir);
      const rec = readJournal(dir); this._set(rec, { state: st.segments ? 'partial' : 'failed', endedAt: this.clock(), reason: 'the recorder process went away (a restart)', ...st });
      try { fs.rmSync(path.join(dir, 'profile'), { recursive: true, force: true }); } catch { /* best effort */ }
      n++;
    }
    return n;
  }

  /** start({ url, profile, quality, until, maxMinutes, title }) → the journal (state `starting`); the run continues on its own. */
  start(a = {}) {
    const url = String(a.url || '').trim(); if (!/^https?:\/\//.test(url)) throw new Error('url required');
    const caps = this.deps.capabilities(); if (!caps.ok) throw new Error(`cannot record here: ${caps.hint}`);
    if (this.live.size >= this.maxConcurrent) throw new Error(`already recording ${this.live.size} — the limit is ${this.maxConcurrent}`);
    if (this.deps.freeBytes(this.root) < MIN_FREE_BYTES) throw new Error('less than 2 GiB free on the recordings volume — remove old recordings first');
    const until = UNTIL.includes(a.until) ? a.until : 'video-ends';
    const maxMinutes = Math.min(HARD_MAX_MIN, Math.max(1, Number(a.maxMinutes) || DEFAULT_MAX_MIN[until]));
    const rec = { id: newId(), url, profile: String(a.profile || 'default').replace(/[^a-z0-9_-]/gi, '') || 'default', quality: a.quality === '1080p' ? '1080p' : '720p',
      until, maxMinutes, title: String(a.title || '').slice(0, 120), state: 'starting', startedAt: this.clock(), recordingAt: 0, endedAt: 0, seconds: 0, bytes: 0, segments: 0, error: null, reason: '', pageTitle: '', display: null };
    this._save(rec);
    const entry = { rec, ctx: {}, stopReq: '' }; this.live.set(rec.id, entry);
    entry.done = this._run(entry).catch((e) => { this.log.warn(`[recorder] ${rec.id} run: ${e.message}`); });
    return this.view(rec);
  }

  stop(id, reason = 'stopped by the owner') { const l = this.live.get(id); if (!l) return { error: 'not recording' }; if (!l.stopReq) l.stopReq = reason; return { ok: true, id }; }

  remove(id) { if (this.live.has(id)) return { error: 'still recording — stop it first' }; const dir = this.dirOf(id); if (!readJournal(dir)) return { removed: false }; fs.rmSync(dir, { recursive: true, force: true }); return { removed: true }; }

  async _run(entry) {
    const { rec, ctx } = entry; const d = this.deps; const dir = this.dirOf(rec.id); const size = d.sizeOf(rec.quality);
    try {
      const clone = path.join(dir, 'profile'); fs.mkdirSync(clone, { recursive: true });
      const cookies = await d.cookiesFor(rec.profile).catch((e) => { this.log.warn(`[recorder] ${rec.id} cookies: ${e.message}`); return []; });
      ctx.display = await d.startDisplay(size, this.log); this._set(rec, { display: ctx.display.n });
      ctx.pulse = await d.startPulse(rec.id, this.log);
      ctx.context = await d.launchBrowser({ profileDir: clone, display: ctx.display.n, pulseServer: ctx.pulse.server, size, cfg: d.profileConfig ? d.profileConfig(rec.profile) : {}, log: this.log });
      const extra = d.platformCookies ? d.platformCookies(rec.url, cookies) : [];   // a consent wall answered before it appears
      const all = [...cookies, ...extra];
      if (all.length) { try { await ctx.context.addCookies(all); } catch (e) { this.log.warn(`[recorder] ${rec.id} addCookies: ${e.message}`); } }
      ctx.page = ctx.context.pages()[0] || await ctx.context.newPage();
      await ctx.page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => this.log.warn(`[recorder] ${rec.id} goto: ${e.message}`));
      const prep = await d.preparePage(ctx.page, this.log).catch((e) => ({ error: e.message }));
      let pageTitle = ''; try { pageTitle = await ctx.page.title(); } catch { /* fine */ }
      ctx.ff = d.startFfmpeg({ display: ctx.display.n, size, out: dir, mode: 'hls' }, ctx.pulse.server, this.log);
      this._set(rec, { state: 'recording', recordingAt: this.clock(), pageTitle: String(pageTitle || '').slice(0, 200), prepared: prep });
      this.log.info(`[recorder] ${rec.id} recording ${rec.url} (${rec.quality}, until ${rec.until}, ≤${rec.maxMinutes} min) on :${ctx.display.n}`);
      let pausedSince = 0, firstHref = rec.url, reason = '';
      while (!reason) {
        await sleep(this.tickMs);
        const st = statsOf(dir); this._set(rec, st);
        if (entry.stopReq) { reason = entry.stopReq; break; }
        if (ctx.ff.proc && ctx.ff.proc.exitCode !== null) { reason = `the encoder ended (${ctx.ff.proc.exitCode})`; break; }
        if ((this.clock() - rec.recordingAt) / 60000 >= rec.maxMinutes) { reason = rec.until === 'duration' ? 'the requested length is reached' : `the ${rec.maxMinutes}-minute cap is reached`; break; }
        if (d.freeBytes(this.root) < MIN_FREE_BYTES) { reason = 'the recordings volume is nearly full'; break; }
        const v = await d.videoState(ctx.page).catch(() => null);
        if (v === null && rec.until === 'video-ends') { reason = 'the page is gone'; break; }
        if (v && rec.until === 'video-ends') {
          if (v.ended) { reason = 'the video ended'; break; }
          if (v.duration > 0 && v.currentTime >= v.duration - 0.75) { reason = 'the video ended'; break; }
          if (v.href && videoKey(v.href) !== videoKey(firstHref) && (this.clock() - rec.recordingAt) > 60000) { reason = 'the page moved on to another video'; break; }
          if (v.paused && !v.ended) { if (!pausedSince) pausedSince = this.clock(); else if (this.clock() - pausedSince > 30000) { await d.preparePage(ctx.page, this.log).catch(() => {}); pausedSince = 0; } }
          else pausedSince = 0;
        }
      }
      this._set(rec, { state: 'finishing', reason });
      const r = await ctx.ff.stop(10000).catch(() => ({ code: -1 }));
      closePlaylist(dir);
      const st = statsOf(dir);
      this._set(rec, { ...st, state: st.segments ? 'done' : 'failed', endedAt: this.clock(), error: st.segments ? null : `nothing was recorded (encoder ${r && r.code}${r && r.err ? ': ' + String(r.err).slice(-200) : ''})` });
      this.log.info(`[recorder] ${rec.id} ${rec.state}: ${reason} — ${st.seconds}s, ${Math.round(st.bytes / 1048576)} MB, ${st.segments} segments`);
    } catch (e) {
      const st = statsOf(dir); closePlaylist(dir);
      this._set(rec, { ...st, state: st.segments ? 'partial' : 'failed', endedAt: this.clock(), error: e.message });
      this.log.warn(`[recorder] ${rec.id} failed: ${e.message}`);
    } finally {
      if (ctx.ff) { try { await ctx.ff.stop(3000); } catch { /* ending */ } }
      if (ctx.context) { try { await ctx.context.close(); } catch { /* gone */ } }
      if (ctx.pulse) { try { ctx.pulse.stop(); } catch { /* gone */ } }
      if (ctx.display) { try { ctx.display.stop(); } catch { /* gone */ } }
      try { fs.rmSync(path.join(dir, 'profile'), { recursive: true, force: true }); } catch { /* best effort */ }
      this.live.delete(rec.id);
    }
  }

  /**
   * Retention: finished recordings older than `days` go, then the oldest finished ones until what is
   * kept fits `maxBytes`. Never a live one. Returns what went and why, for the nightly report.
   */
  prune({ days = 14, maxBytes = 30 * 1024 * 1024 * 1024, now = this.clock() } = {}) {
    const done = this.list().filter((r) => !this.live.has(r.id) && ['done', 'partial', 'failed'].includes(r.state)).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    const removed = []; let total = done.reduce((s, r) => s + (r.bytes || 0), 0);
    for (const r of done) {
      const old = now - (r.endedAt || r.startedAt || 0) > days * 86400000;
      if (!old && total <= maxBytes) continue;
      if (this.remove(r.id).removed) { total -= r.bytes || 0; removed.push({ id: r.id, bytes: r.bytes || 0, why: old ? `older than ${days} days` : 'over the size budget' }); }
    }
    return { removed, kept: done.length - removed.length, bytes: total };
  }

  /** The mp4 for a finished (or partial) recording: built once by stream copy, then served with Range. */
  async mp4(id) {
    const dir = this.dirOf(id); const j = readJournal(dir); if (!j) throw new Error('no such recording');
    if (this.live.has(id)) throw new Error('still recording — play the stream, or stop it first');
    const out = path.join(dir, 'final.mp4');
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
    closePlaylist(dir);
    const r = await (this.deps.concat ? this.deps.concat(dir) : runConcat(dir));
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`could not build the mp4 (${r.code}${r.err ? ': ' + String(r.err).slice(-200) : ''})`);
    return out;
  }
}

function runConcat(dir) {
  return new Promise((resolve) => {
    let err = ''; let p;
    try { p = spawn('nice', ['-n', '10', 'ffmpeg', ...concatArgs(dir)], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return resolve({ code: -1, err: e.message }); }
    p.stderr.on('data', (d) => { err += d; }); p.on('error', (e) => resolve({ code: -1, err: e.message })); p.on('close', (code) => resolve({ code, err }));
  });
}

module.exports = { Recorder, statsOf, closePlaylist, concatArgs, videoKey, STATES, UNTIL, MIN_FREE_BYTES, DEFAULT_MAX_MIN, HARD_MAX_MIN };
