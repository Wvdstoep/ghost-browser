'use strict';
/**
 * recorder/sidecar.js — ONE recording's private machinery, up only while it records.
 *
 * A recording never touches the pool: it gets its own Xvfb display, its own PulseAudio server with
 * one null sink, its own Chromium on a throw-away copy of the profile's cookies, and one ffmpeg that
 * grabs exactly that display and that sink. The walks and watchers keep :99, their windows, their
 * per-profile locks and their silence. When the recording ends all four processes go away and the
 * throw-away profile is deleted — nothing stays up between recordings (see docs/RECORDER-PLAN.md).
 *
 * The argument builders are pure so the tests can pin them; the runtime functions spawn and wait.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DISPLAY_LOW = 100, DISPLAY_HIGH = 199;   // the pool owns :99; recordings live above it
const SIZES = { '720p': { width: 1280, height: 720 }, '1080p': { width: 1920, height: 1080 } };
const SINK = 'rec';

function sizeOf(quality) { return SIZES[String(quality || '720p')] || SIZES['720p']; }

/**
 * Where recordings live. On the cluster: the recordings volume at /recordings. On a laptop (the
 * open-source install runs on a desk, not a cluster): RECORDINGS_DIR, else a `recordings` folder next
 * to the profiles folder, so the data sits beside the rest of GB's state. A temp dir is the last resort.
 */
function recordingsRoot() {
  const writable = (p) => { try { fs.mkdirSync(p, { recursive: true }); fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
  if (process.env.RECORDINGS_DIR && writable(process.env.RECORDINGS_DIR)) return process.env.RECORDINGS_DIR;
  if (fs.existsSync('/recordings') && writable('/recordings')) return '/recordings';
  const beside = path.resolve(process.env.PROFILE_DIR || '/profiles', '..', 'recordings'); if (writable(beside)) return beside;
  const alt = path.join(os.tmpdir(), 'recordings'); fs.mkdirSync(alt, { recursive: true }); return alt;
}

/**
 * What this machine can do. The sidecar needs three Linux tools; the docker image ships all of them,
 * a bare install on Linux gets them with one apt line, and macOS/Windows run the image. Told plainly
 * to the owner instead of failing halfway through a start.
 */
function capabilities() {
  const has = (bin) => { for (const d of String(process.env.PATH || '').split(path.delimiter)) { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { /* next */ } } return false; };
  const tools = { Xvfb: has('Xvfb'), pulseaudio: has('pulseaudio'), ffmpeg: has('ffmpeg') };
  const missing = Object.keys(tools).filter((k) => !tools[k]);
  const linux = process.platform === 'linux';
  return { ok: linux && !missing.length, platform: process.platform, tools, missing, root: recordingsRoot(),
    hint: !linux ? 'screen recording runs inside the Ghost Browser docker image on this platform (docker run … wvdstoep/ghost-browser)'
      : missing.length ? `install ${missing.join(', ')} (Debian/Ubuntu: sudo apt install xvfb pulseaudio pulseaudio-utils ffmpeg) or run the docker image` : '' };
}

/** Bytes free on the recordings volume (0 when unknown). */
function freeBytes(dir) { try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return 0; } }

// ── pure builders ────────────────────────────────────────────────────────────────────────────────
function xvfbArgs(n, size) { return [`:${n}`, '-screen', '0', `${size.width}x${size.height}x24`, '-nolisten', 'tcp', '-ac', '-noreset']; }

/** A private PulseAudio: no default config (-n), one unix socket in its own runtime dir, one null sink. */
function pulseArgs(runtimeDir) {
  return ['--daemonize=no', '--exit-idle-time=-1', '--disallow-exit', '--disable-shm=yes', '--use-pid-file=no', '-n',
    '--log-target=stderr', '--log-level=error',
    '-L', `module-native-protocol-unix socket=${path.join(runtimeDir, 'native')} auth-anonymous=1`,
    '-L', `module-null-sink sink_name=${SINK} sink_properties=device.description=${SINK}`];
}

/** The pool's Chromium flags, sized for the recording, kiosk (the page IS the screen), autoplay allowed. */
function chromeArgs(base, size) {
  return [...(base || []).filter((a) => !String(a).startsWith('--window-size')),
    `--window-size=${size.width},${size.height}`, '--window-position=0,0', '--kiosk',
    '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate,MediaRouter', '--hide-scrollbars'];
}

/**
 * ffmpeg: the display at `fps`, the sink's monitor, H.264 at a fast preset with capped threads (a
 * recording must never starve the pool), AAC audio. `mode` 'mp4' writes one file (with -t when
 * `seconds` is set); 'hls' writes 10-second segments and a playlist that plays while recording.
 */
function ffmpegArgs({ display, size, fps = 30, out, mode = 'mp4', seconds = 0, threads = 2, crf = 23 }) {
  const a = ['-hide_banner', '-loglevel', 'error',
    '-thread_queue_size', '1024', '-f', 'x11grab', '-framerate', String(fps), '-video_size', `${size.width}x${size.height}`, '-draw_mouse', '0', '-i', `:${display}`,
    '-thread_queue_size', '1024', '-f', 'pulse', '-i', `${SINK}.monitor`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-threads', String(threads), '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'];
  if (seconds > 0) a.push('-t', String(seconds));
  if (mode === 'hls') a.push('-f', 'hls', '-hls_time', '10', '-hls_list_size', '0', '-hls_flags', 'independent_segments', '-hls_segment_filename', path.join(out, 'seg-%05d.ts'), path.join(out, 'index.m3u8'));
  else a.push('-movflags', '+faststart', '-y', out);
  return a;
}

/** The first display number above the pool's that no X server holds. */
function allocDisplay(taken = new Set(), sockDir = '/tmp') {
  for (let n = DISPLAY_LOW; n <= DISPLAY_HIGH; n++) {
    if (taken.has(n)) continue;
    if (fs.existsSync(path.join(sockDir, '.X11-unix', `X${n}`)) || fs.existsSync(path.join(sockDir, `.X${n}-lock`))) continue;
    return n;
  }
  return null;
}

// ── runtime ──────────────────────────────────────────────────────────────────────────────────────
const takenDisplays = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, proc, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    if (proc && proc.exitCode !== null) throw new Error(`${what} exited with ${proc.exitCode}`);
    await sleep(100);
  }
  throw new Error(`${what} did not come up within ${Math.round(ms / 1000)}s`);
}
function kill(proc, signal = 'SIGTERM') { try { if (proc && proc.exitCode === null) proc.kill(signal); } catch { /* gone */ } }

async function startDisplay(size, log) {
  const n = allocDisplay(takenDisplays); if (n == null) throw new Error('no free display for a recording');
  takenDisplays.add(n);
  const proc = spawn('Xvfb', xvfbArgs(n, size), { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => log && log.debug && log.debug(`[rec] Xvfb:${n} ${String(d).trim()}`));
  try { await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${n}`), 10000, proc, `Xvfb :${n}`); }
  catch (e) { takenDisplays.delete(n); kill(proc, 'SIGKILL'); throw e; }
  return { n, proc, stop: () => { kill(proc); takenDisplays.delete(n); } };
}

async function startPulse(id, log) {
  const dir = path.join(os.tmpdir(), `pulse-${id}`); fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, PULSE_RUNTIME_PATH: dir, PULSE_STATE_PATH: dir, PULSE_CONFIG_PATH: dir, HOME: process.env.HOME || os.tmpdir() };
  const proc = spawn('pulseaudio', pulseArgs(dir), { env, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => log && log.debug && log.debug(`[rec] pulse ${String(d).trim()}`));
  const sock = path.join(dir, 'native');
  try { await waitFor(() => fs.existsSync(sock), 10000, proc, 'pulseaudio'); }
  catch (e) { kill(proc, 'SIGKILL'); throw e; }
  const server = `unix:${sock}`;
  return { server, dir, proc, stop: () => { kill(proc); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } } };
}

/** A throw-away profile that carries ONLY the source profile's cookies (its identity settings ride along). */
function cloneCookies(profileDir, base, into) {
  const src = path.join(profileDir, String(base || 'default'));
  fs.mkdirSync(path.join(into, 'Default', 'Network'), { recursive: true });
  let n = 0;
  for (const rel of ['Default/Cookies', 'Default/Cookies-journal', 'Default/Network/Cookies', 'Default/Network/Cookies-journal', 'Local State']) {
    try { const f = path.join(src, rel); if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(into, rel)); n++; } } catch { /* partial is fine */ }
  }
  return n;
}

/** Chrome preferences for a recording's throw-away profile: no translate bubble, no permission prompts, nothing that draws over the video. */
function profilePrefs() {
  return { translate: { enabled: false }, translate_blocked_languages: [], profile: { default_content_setting_values: { notifications: 2, geolocation: 2, media_stream_camera: 2, media_stream_mic: 2 }, password_manager_enabled: false },
    credentials_enable_service: false, autofill: { profile_enabled: false, credit_card_enabled: false }, browser: { has_seen_welcome_page: true }, distribution: { skip_first_run_ui: true } };
}
function writePrefs(profileDir) {
  try { fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true }); fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify(profilePrefs())); return true; } catch { return false; }
}

/**
 * Chromium on the recording's display and sink, from the throw-away profile. `cfg` is the source
 * profile's settings (locale, timezone, exit) so the recording looks like the owner's browser.
 */
async function launchBrowser({ profileDir, display, pulseServer, size, cfg = {}, log }) {
  writePrefs(profileDir);
  const { stealthChromium, CHROME_ARGS } = require('../pool');
  const profiles = require('../profiles');
  let proxy = {};
  if (cfg.proxyServer) proxy = { proxy: { server: String(cfg.proxyServer) } };   // a recorder pod: GB's own exit proxy, by name
  else try {
    const ts = require('../tailscale'); const routeAll = require('../settings').read().routeThroughTailnet !== false;
    const px = profiles.launchProxy(cfg.proxy, ts.proxyUrl(), { routeAll }); if (px) proxy = { proxy: px };
  } catch (e) { log && log.warn && log.warn(`[rec] exit not applied: ${e.message}`); }
  const context = await stealthChromium().launchPersistentContext(profileDir, {
    headless: false, viewport: null, args: chromeArgs(CHROME_ARGS, size),
    env: { ...process.env, DISPLAY: `:${display}`, PULSE_SERVER: pulseServer, PULSE_SINK: SINK },
    ...(cfg.userAgent ? { userAgent: cfg.userAgent } : {}), ...(cfg.locale ? { locale: cfg.locale } : {}), ...(cfg.timezone ? { timezoneId: cfg.timezone } : {}),
    ...proxy,
  });
  return context;
}

function startFfmpeg(opts, pulseServer, log) {
  const args = ffmpegArgs(opts);
  const bin = fs.existsSync('/usr/bin/nice') ? 'nice' : 'ffmpeg';
  const argv = bin === 'nice' ? ['-n', '10', 'ffmpeg', ...args] : args;
  const proc = spawn(bin, argv, { env: { ...process.env, PULSE_SERVER: pulseServer }, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += String(d); if (err.length > 4000) err = err.slice(-4000); log && log.debug && log.debug(`[rec] ffmpeg ${String(d).trim()}`); });
  const done = new Promise((resolve) => proc.on('close', (code) => resolve({ code, err: err.trim() })));
  /** Ask ffmpeg to finish cleanly (it writes the trailer / playlist end); force it after `graceMs`. */
  const stop = async (graceMs = 8000) => {
    if (proc.exitCode !== null) return done;
    try { proc.stdin.write('q'); } catch { /* closed */ }
    const t = setTimeout(() => kill(proc, 'SIGINT'), graceMs); const t2 = setTimeout(() => kill(proc, 'SIGKILL'), graceMs * 2);
    const r = await done; clearTimeout(t); clearTimeout(t2); return r;
  };
  return { proc, done, stop };
}

module.exports = { SIZES, SINK, DISPLAY_LOW, DISPLAY_HIGH, sizeOf, recordingsRoot, capabilities, freeBytes, profilePrefs, writePrefs, xvfbArgs, pulseArgs, chromeArgs, ffmpegArgs, allocDisplay, startDisplay, startPulse, cloneCookies, launchBrowser, startFfmpeg };
