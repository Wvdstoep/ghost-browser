'use strict';
/**
 * tools/record.js — screen_record: capture the browser's OWN screen as a video asset.
 *
 * start_recording opens a CDP screencast (the same JPEG stream the live view uses) into a per-session
 * buffer; the agent then does its thing — opens tabs, scrolls, shows a page working — and
 * stop_recording encodes those frames to an MP4 with ffmpeg and stores it in the CROSS-SESSION asset
 * store, so real footage of the live console (or any page) can go straight into an edit with
 * upload_file. This is what lets GhostBrowser film ITSELF for its own promo.
 *
 * The recording state lives on the session object (session._rec) so it survives between the two tool
 * calls. Frames are capped so a long tour cannot exhaust memory.
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fileAssets = require('../fileAssets');

const MAX_FRAMES = 3000;   // ~a few minutes at a handful of fps; a guard against runaway memory

// Encode concatenated JPEG frames (an mjpeg stream) to an MP4 file, then read it back. Returns the
// mp4 bytes, or null if ffmpeg is missing or fails.
function encode(frames, fps) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
    let ff;
    try {
      ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-f', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', '-y', out]);
    } catch { return resolve(null); }
    ff.on('error', () => resolve(null));
    ff.stdin.on('error', () => { /* broken pipe if ffmpeg died — handled by close */ });
    ff.on('close', (code) => {
      let bytes = null;
      try { if (code === 0) bytes = fs.readFileSync(out); } catch { bytes = null; }
      try { fs.unlinkSync(out); } catch { /* best effort */ }
      resolve(bytes && bytes.length ? bytes : null);
    });
    for (const f of frames) { try { ff.stdin.write(f); } catch { break; } }
    try { ff.stdin.end(); } catch { /* already closed */ }
  });
}

/**
 * Begin a screencast on `page` into `session._rec`. Shared by the start_recording TOOL (agent-driven)
 * and the workflow driver's per-node AUTO-record (server-driven), so a flow node can film itself with
 * no dependence on the agent remembering to call the tool. Returns true if recording actually started.
 */
async function beginRecording(session, page) {
  if (!session || !page || session._rec) return false;
  let cdp;
  try {
    cdp = await session.context.newCDPSession(page);
    await cdp.send('Page.enable');
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  } catch { return false; }
  const rec = { cdp, frames: [], startedAt: Date.now() };
  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch { /* stream ended */ }
    if (rec.frames.length < MAX_FRAMES) rec.frames.push(Buffer.from(data, 'base64'));
  });
  session._rec = rec;
  return true;
}

/**
 * Stop the screencast on `session`, encode to MP4 and store it as a cross-session asset. Returns
 * { id, secs, frames, bytes } or null (nothing recording / no frames / ffmpeg failed). Never throws,
 * so an auto-record failure can never take down the node it was filming.
 */
async function endRecording(session, { name } = {}) {
  const rec = session && session._rec;
  if (!rec) return null;
  session._rec = null;
  try { await rec.cdp.send('Page.stopScreencast'); } catch { /* already stopped */ }
  try { await rec.cdp.detach(); } catch { /* fine */ }
  const frames = rec.frames;
  const secs = Math.max(0.5, (Date.now() - rec.startedAt) / 1000);
  if (!frames.length) return null;
  const fps = Math.min(30, Math.max(1, Math.round(frames.length / secs)));
  const mp4 = await encode(frames, fps);
  if (!mp4) return null;
  const id = fileAssets.put({ mime: 'video/mp4', kind: 'screen', name: name || `screen-${Date.now()}.mp4`, bytes: mp4 });
  if (!id) return null;
  return { id, secs: Math.round(secs), frames: frames.length, bytes: mp4.length };
}

module.exports = {
  beginRecording,
  endRecording,

  /** Begin recording the current page's screen into a buffer. Pair with stop_recording. */
  async start_recording(ctx, _a) {
    const session = ctx.session();
    if (session._rec) { ctx.observe('Already recording — call stop_recording to save the current clip before starting another.'); return; }
    const ok = await beginRecording(session, ctx.page());
    if (!ok) { ctx.observe('Could not start recording.'); return; }
    ctx.step('note', 'started a screen recording');
    ctx.observe('Recording the screen now. Do the thing you want on camera — open a tab, scroll, show it working — then call stop_recording to save it as a video asset.');
  },

  /** Stop recording, encode the frames to an MP4, and store it as a reusable video asset. */
  async stop_recording(ctx, a) {
    const session = ctx.session();
    if (!session._rec) { ctx.observe('Nothing is recording. Call start_recording first, do something on screen, then stop_recording.'); return; }
    const saved = await endRecording(session, { name: a.name || `screen-${Date.now()}.mp4` });
    if (!saved) { ctx.observe('Could not save the recording — no frames were captured (the page never changed), or ffmpeg failed.'); return; }
    ctx.step('download', `saved a ${saved.secs}s screen recording (${saved.bytes} bytes) as asset ${saved.id}`);
    ctx.observe(`Saved the screen recording — asset "${saved.id}" (${saved.secs}s, ${saved.frames} frames). A later step uses it with upload_file assetId "${saved.id}".`);
  },
};
