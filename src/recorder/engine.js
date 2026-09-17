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
const RUNNING = ['starting', 'recording', 'finishing'];
const QUALITIES = ['720p', '1080p', '1080p60'];
const STALE_MS = 3 * 60 * 1000;   // a pod that has not reported for this long is taken as gone
const newToken = () => require('crypto').randomBytes(24).toString('hex');
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

/**
 * The playlist with only the segments that are HERE: a pod pushes every finished segment but its
 * playlist may already name the one still being written, and a player that follows the list into a
 * missing file gets a 404 at the live edge. Pure on the text; the caller says what exists.
 */
function trimPlaylist(m3u8, exists) {
  const lines = String(m3u8 || '').split('\n'); const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#EXTINF/.test(l)) { const seg = (lines[i + 1] || '').trim(); if (/^seg-\d+\.ts$/.test(seg) && !exists(seg)) { i++; continue; } out.push(l); continue; }
    out.push(l);
  }
  return out.join('\n');
}
function servePlaylist(dir) {
  const f = path.join(dir, 'index.m3u8'); let s; try { s = fs.readFileSync(f, 'utf8'); } catch { return null; }
  return trimPlaylist(s, (seg) => { try { return fs.statSync(path.join(dir, seg)).size > 0; } catch { return false; } });
}

/** A playlist ffmpeg never got to close (a restart, a kill) is closed by hand — trimmed to what is here — so players know it ended. */
function closePlaylist(dir) {
  const f = path.join(dir, 'index.m3u8');
  try {
    let s = fs.readFileSync(f, 'utf8'); if (/#EXT-X-ENDLIST/.test(s)) return true;
    s = trimPlaylist(s, (seg) => { try { return fs.statSync(path.join(dir, seg)).size > 0; } catch { return false; } });
    fs.writeFileSync(f, s.replace(/\s*$/, '') + '\n#EXT-X-ENDLIST\n'); return true;
  } catch { return false; }
}

/** The segments present, in order, as ffmpeg's concat list — the mp4 is built from FILES, never from a playlist that may name a missing one. */
function segmentList(dir) {
  let names = []; try { names = fs.readdirSync(dir).filter((f) => /^seg-\d+\.ts$/.test(f) && fs.statSync(path.join(dir, f)).size > 0).sort(); } catch { names = []; }
  return names.map((n) => `file '${path.join(dir, n).replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}
/** ffmpeg arguments that turn the segments into one mp4 without re-encoding (Range-served): the concat demuxer over `list.txt`, ADTS audio re-framed for mp4. */
function concatArgs(dir) { return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', path.join(dir, 'final.mp4')]; }

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
  constructor({ root, deps, log, maxConcurrent = 2, tickMs = TICK_MS, clock = now, launchGraceMs = 25000 }) {
    this.root = root; this.deps = deps; this.log = log || { info() {}, warn() {}, debug() {} };
    this.maxConcurrent = maxConcurrent; this.tickMs = tickMs; this.clock = clock; this.launchGraceMs = launchGraceMs;
    this.maxRemote = Math.max(1, Number(process.env.MAX_REMOTE_RECORDINGS) || 3);
    // the DEMAND signal for the capacity controller: how often recordings wanted a pod of their own and got none
    this.demand = { refusedRemote: 0, lastRefusedAt: 0 };
    this.live = new Map();   // id → { rec, ctx: { display, pulse, context, page, ff }, stopReq }
    fs.mkdirSync(root, { recursive: true });
    // PLAYBACK TICKETS: a native player or a download cannot carry the owner's session reliably, so the
    // media routes also accept a short-lived signed ticket in the URL — per recording, never a key.
    const sf = path.join(root, '.ticket-secret');
    try { this.secret = fs.readFileSync(sf, 'utf8').trim(); if (!this.secret) throw new Error('empty'); } catch { this.secret = newToken(); try { fs.writeFileSync(sf, this.secret, { mode: 0o600 }); } catch { /* memory only then */ } }
  }

  /** A ticket for one recording's media, valid `ttlMs` (12 h): "<expiry>.<hmac>" — the app puts it in the URL as ?t=. */
  ticket(id, ttlMs = 12 * 3600 * 1000) {
    const exp = this.clock() + ttlMs; const mac = require('crypto').createHmac('sha256', this.secret).update(`${id}|${exp}`).digest('hex').slice(0, 32);
    return { t: `${exp}.${mac}`, exp };
  }
  checkTicket(id, t) {
    const [exp, mac] = String(t || '').split('.'); if (!exp || !mac || Number(exp) < this.clock()) return false;
    const want = require('crypto').createHmac('sha256', this.secret).update(`${id}|${exp}`).digest('hex').slice(0, 32);
    return mac.length === want.length && require('crypto').timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  }

  dirOf(id) { return path.join(this.root, String(id).replace(/[^a-z0-9_-]/gi, '')); }

  list() {
    const out = [];
    try { for (const d of fs.readdirSync(this.root)) { const j = readJournal(path.join(this.root, d)); if (j) out.push(this.view(j)); } } catch { /* empty */ }
    return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
  get(id) { const j = readJournal(this.dirOf(id)); return j ? this.view(j) : null; }
  /** A recording in its own pod (mode "job") is live while its journal says so — its process is elsewhere. */
  view(j) {
    const { token, ...pub } = j; const live = this.live.has(j.id) || (j.mode === 'job' && RUNNING.includes(j.state)); const dir = this.dirOf(j.id);
    const has = (f) => { try { return fs.statSync(path.join(dir, f)).size > 0; } catch { return false; } };
    let chapters = []; try { chapters = JSON.parse(fs.readFileSync(path.join(dir, 'chapters.json'), 'utf8')); } catch { chapters = []; }
    return { ...pub, live, playlist: `/v1/recordings/${j.id}/index.m3u8`, mp4: `/v1/recordings/${j.id}/mp4`,
      thumb: has('thumb.jpg') ? `/v1/recordings/${j.id}/thumb.jpg` : '', sprite: has('sprite.jpg') ? `/v1/recordings/${j.id}/sprite.jpg` : '', chapters };
  }

  /**
   * After a recording ends: a thumbnail, a sprite strip (10 frames), and chapters from scene cuts —
   * niced, one recording at a time, never blocking anything. Injectable (`deps.ffmpeg`) for the tests.
   */
  async postProcess(id) {
    const dir = this.dirOf(id); const j = readJournal(dir); if (!j || RUNNING.includes(j.state) || !(j.segments > 0)) return null;
    if (this._post) { this._postQueue = (this._postQueue || []).concat(id); return null; }
    this._post = id;
    const run = this.deps.ffmpeg || runFfmpeg; const src = path.join(dir, 'index.m3u8'); const secs = Math.max(1, j.seconds || 1);
    try {
      const at = Math.min(Math.max(2, Math.floor(secs * 0.1)), Math.max(1, secs - 1));
      await run(['-ss', String(at), '-i', src, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-y', path.join(dir, 'thumb.jpg')]);
      const every = Math.max(1, Math.floor(secs / 10));
      await run(['-i', src, '-vf', `fps=1/${every},scale=320:-2,tile=5x2`, '-frames:v', '1', '-q:v', '5', '-y', path.join(dir, 'sprite.jpg')]);
      // chapters: scene cuts on a 1 fps, 320 px proxy — cheap even for hours; at most 60, at least 20 s apart
      const r = await run(['-i', src, '-vf', "fps=1,scale=320:-2,select='gt(scene,0.35)',showinfo", '-an', '-f', 'null', '-'], { capture: true });
      const times = [...String(r.err || '').matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 5);
      const chapters = []; for (const t of times) { if (chapters.length >= 60) break; if (!chapters.length || t - chapters[chapters.length - 1].t >= 20) chapters.push({ t: Math.round(t), label: `Chapter ${chapters.length + 1}` }); }
      fs.writeFileSync(path.join(dir, 'chapters.json'), JSON.stringify(chapters));
      this.log.info(`[recorder] ${id}: thumbnail, sprite and ${chapters.length} chapter(s)`);
      return { chapters: chapters.length };
    } catch (e) { this.log.warn(`[recorder] ${id} post-process: ${e.message}`); return null; }
    finally { this._post = null; const next = (this._postQueue || []).shift(); if (next) this.postProcess(next).catch(() => {}); }
  }

  /** A share link: a long-lived ticket (default 7 days) on a public player page — the owner's own content only. */
  share(id, days = 7) { const j = readJournal(this.dirOf(id)); if (!j) return null; const ttl = Math.min(30, Math.max(1, Number(days) || 7)) * 86400000; const tk = this.ticket(id, ttl); return { url: `/r/${id}?t=${tk.t}`, exp: tk.exp, days: ttl / 86400000 }; }
  /** Recordings this process holds (they die with it — the deploy gate waits for them). */
  running() { return [...this.live.values()].map((l) => l.rec.id); }
  /** Recordings in pods of their own (they survive a roll of this process). */
  runningRemote() { return this.list().filter((r) => r.mode === 'job' && RUNNING.includes(r.state)).map((r) => r.id); }

  _save(rec) { const dir = this.dirOf(rec.id); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'recording.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(rec)); fs.renameSync(f + '.tmp', f); }
  _set(rec, patch) { Object.assign(rec, patch); this._save(rec); }

  /** Journals left `starting`/`recording`/`finishing` by a process that is gone: closed as partial, still playable. */
  adopt() {
    let n = 0;
    for (const r of this.list()) {
      if (!RUNNING.includes(r.state) || this.live.has(r.id) || r.mode === 'job') continue;   // a pod of its own is reconcile()'s business
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
    const rec = { id: a.id && /^[a-z0-9-]+$/i.test(a.id) ? a.id : newId(), url, profile: String(a.profile || 'default').replace(/[^a-z0-9_-]/gi, '') || 'default', quality: QUALITIES.includes(a.quality) ? a.quality : '720p',
      until, maxMinutes, title: String(a.title || '').slice(0, 120), state: 'starting', startedAt: this.clock(), recordingAt: 0, endedAt: 0, seconds: 0, bytes: 0, segments: 0, error: null, reason: '', pageTitle: '', display: null, mode: 'local' };
    // A POD OF ITS OWN when the cluster allows it (Phase 3): resources added, not borrowed, and a roll of
    // this process cannot cut it. The pod reports back over HTTP with this recording's token. If the
    // Job cannot be created the recording runs here, and the journal says which.
    const remote = this.deps.remote;
    const remoteFull = remote && this.runningRemote().length >= this.maxRemote;
    if (remoteFull) { this.demand.refusedRemote++; this.demand.lastRefusedAt = this.clock(); this.log.warn(`[recorder] ${rec.id}: ${this.maxRemote} pod(s) of their own already recording — recording in this pod (demand ${this.demand.refusedRemote})`); }
    if (remote && a.mode !== 'local' && !remoteFull && remote.available()) {
      rec.mode = 'job'; rec.token = newToken(); rec.updatedAt = this.clock(); this._save(rec);
      const fallBack = (why) => { const cur = readJournal(this.dirOf(rec.id)); if (!cur || cur.mode !== 'job' || !RUNNING.includes(cur.state)) return; this.log.warn(`[recorder] ${rec.id}: no pod of its own (${why}) — recording in this pod instead`); this.demand.refusedRemote++; this.demand.lastRefusedAt = this.clock(); delete cur.token; this._set(cur, { mode: 'local', fallback: why }); this._runLocal(cur); };
      Promise.resolve().then(() => remote.launch(rec)).then((j) => {
        const cur = readJournal(this.dirOf(rec.id)); if (cur && cur.mode === 'job') this._set(cur, { jobName: (j && j.jobName) || '' }); this.log.info(`[recorder] ${rec.id} runs as ${j && j.jobName} (a pod of its own)`);
        // a Job the cluster accepted but cannot give a pod (a namespace quota, no room): take it back and record here
        if (remote.podExists) setTimeout(async () => { const cur2 = readJournal(this.dirOf(rec.id)); if (!cur2 || cur2.mode !== 'job' || cur2.state !== 'starting' || cur2.recordingAt) return; let has = true; try { has = await remote.podExists(cur2); } catch { has = true; } if (!has) { try { await remote.cancel(cur2); } catch { /* best effort */ } fallBack('the cluster gave the Job no pod (a quota, or no room)'); } }, this.launchGraceMs).unref?.();
      }).catch((e) => fallBack(e.message));
      return this.view(rec);
    }
    this._save(rec);
    this._runLocal(rec);
    return this.view(rec);
  }
  _runLocal(rec) { const entry = { rec, ctx: {}, stopReq: '' }; this.live.set(rec.id, entry); entry.done = this._run(entry).catch((e) => { this.log.warn(`[recorder] ${rec.id} run: ${e.message}`); }); return entry; }

  stop(id, reason = 'stopped by the owner') {
    const l = this.live.get(id); if (l) { if (!l.stopReq) l.stopReq = reason; return { ok: true, id }; }
    const j = readJournal(this.dirOf(id));
    if (j && j.mode === 'job' && RUNNING.includes(j.state)) { if (!j.stopRequested) this._set(j, { stopRequested: reason }); if (this.deps.remote && this.deps.remote.stop) { try { this.deps.remote.stop(j); } catch { /* the pod polls for it anyway */ } } return { ok: true, id, remote: true }; }
    return { error: 'not recording' };
  }

  remove(id) { const j = readJournal(this.dirOf(id)); if (this.live.has(id) || (j && j.mode === 'job' && RUNNING.includes(j.state))) return { error: 'still recording — stop it first' }; if (!j) return { removed: false }; fs.rmSync(this.dirOf(id), { recursive: true, force: true }); return { removed: true }; }

  /** What a recorder pod needs to begin: the ask, the owner's cookies, the profile's identity — and whether the owner has asked it to stop. */
  handoff(id) { const j = readJournal(this.dirOf(id)); if (!j) return null; return { id: j.id, url: j.url, profile: j.profile, quality: j.quality, until: j.until, maxMinutes: j.maxMinutes, title: j.title, stop: j.stopRequested || '' }; }
  tokenOf(id) { const j = readJournal(this.dirOf(id)); return (j && j.token) || ''; }

  /** The pod's journal, merged into ours: only its own fields, never ours (mode, token, url). Terminal states close the playlist. */
  remoteUpdate(id, patch = {}) {
    const j = readJournal(this.dirOf(id)); if (!j || j.mode !== 'job') return null;
    const allowed = ['state', 'pageTitle', 'prepared', 'reason', 'error', 'recordingAt', 'endedAt', 'display'];
    const p = {}; for (const k of allowed) if (patch[k] !== undefined) p[k] = patch[k];
    if (p.state && !STATES.includes(p.state)) delete p.state;
    // the numbers come from what has ARRIVED here, not from the pod's scratch (it deletes what it pushed)
    this._set(j, { ...p, ...statsOf(this.dirOf(id)), updatedAt: this.clock() });
    if (!RUNNING.includes(j.state)) closePlaylist(this.dirOf(id));
    return this.view(j);
  }

  /** Recordings in pods of their own: a pod that is gone, or silent for too long, leaves a playable partial. */
  async reconcile() {
    let n = 0;
    for (const r of this.list()) {
      if (r.mode !== 'job' || !RUNNING.includes(r.state)) continue;
      let alive = true; try { alive = this.deps.remote ? await this.deps.remote.alive(r) : false; } catch { alive = true; }
      const silent = this.clock() - (r.updatedAt || r.startedAt || 0) > STALE_MS;
      if (alive && !silent) continue;
      const dir = this.dirOf(r.id); closePlaylist(dir); const st = statsOf(dir); const j = readJournal(dir);
      this._set(j, { ...st, state: st.segments ? 'partial' : 'failed', endedAt: this.clock(), reason: alive ? 'the recorder pod went silent' : 'the recorder pod is gone' }); n++;
      this.log.warn(`[recorder] ${r.id}: ${j.reason} — closed as ${j.state}`);
    }
    return n;
  }

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
      if (st.segments) this.postProcess(rec.id).catch(() => {});
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
    const list = segmentList(dir); if (!list.trim()) throw new Error('no segments to build from');
    fs.writeFileSync(path.join(dir, 'list.txt'), list);
    const r = await (this.deps.concat ? this.deps.concat(dir) : runConcat(dir));
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`could not build the mp4 (${r.code}${r.err ? ': ' + String(r.err).slice(-200) : ''})`);
    return out;
  }
}

/** ffmpeg, niced, with its stderr when asked (showinfo prints there). Resolves { code, err }. */
function runFfmpeg(args, { capture = false } = {}) {
  return new Promise((resolve) => {
    let err = ''; let p;
    try { p = spawn('nice', ['-n', '10', 'ffmpeg', '-hide_banner', '-loglevel', capture ? 'info' : 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return resolve({ code: -1, err: e.message }); }
    p.stderr.on('data', (d) => { err += d; if (err.length > 400000) err = err.slice(-400000); });
    p.on('error', (e) => resolve({ code: -1, err: e.message })); p.on('close', (code) => resolve({ code, err }));
  });
}

function runConcat(dir) {
  return new Promise((resolve) => {
    let err = ''; let p;
    try { p = spawn('nice', ['-n', '10', 'ffmpeg', ...concatArgs(dir)], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return resolve({ code: -1, err: e.message }); }
    p.stderr.on('data', (d) => { err += d; }); p.on('error', (e) => resolve({ code: -1, err: e.message })); p.on('close', (code) => resolve({ code, err }));
  });
}

module.exports = { Recorder, statsOf, closePlaylist, trimPlaylist, servePlaylist, segmentList, concatArgs, videoKey, STATES, RUNNING, QUALITIES, STALE_MS, UNTIL, MIN_FREE_BYTES, DEFAULT_MAX_MIN, HARD_MAX_MIN };
