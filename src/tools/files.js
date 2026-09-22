'use strict';
/**
 * tools/files.js — the conveyor's hands: get a FILE (image or video) off a page, put a stored file
 * onto a page, and wait for a slow generation to finish.
 *
 * These are the general-file counterparts of images.js's image-only tools, and they store into the
 * PERSISTENT fileAssets store (not the per-session one), so a clip downloaded on the Veo session is
 * the same asset the CapCut session uploads. That cross-session hand-off is the whole point — it is
 * what lets a storyboard's scenes flow site → site into one finished video.
 */
const { recordingAsset, RECORDINGS_DIR } = require('../recordings');
const fileAssets = require('../fileAssets');
const { confirmUploadDialog, resizeImageBytes, SPEC } = require('./uihelpers');


// Fetch a URL's bytes INSIDE the logged-in page, so the session's entitlement (a generator's, a
// stock site's) applies and nothing but a reference crosses. Returns { mime, bytes } or null.
async function fetchInPage(page, url) {
  const dataUrl = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) return null;
      const b = await r.blob();
      return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); });
    } catch { return null; }
  }, url).catch(() => null);
  if (!dataUrl) return null;
  const mime = (/^data:([^;]+)/.exec(dataUrl) || [])[1] || 'application/octet-stream';
  const bytes = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
  return bytes.length ? { mime, bytes } : null;
}

module.exports = {
  /**
   * Get a generated FILE off the page — the most recent video, then a download link, then the most
   * recent large image; or a numbered element if you point at one. Stored to the cross-session store.
   */
  async download_file(ctx, a) {
    const page = ctx.page();
    let src = null;
    try {
      src = await page.evaluate((idx) => {
        const srcOf = (el) => {
          if (!el) return null;
          if (/^(VIDEO|AUDIO|IMG|SOURCE|A)$/.test(el.tagName)) return el.currentSrc || el.src || el.href || null;
          const v = el.querySelector && el.querySelector('video[src], video source[src], audio[src], audio source[src], img');
          if (v) return v.currentSrc || v.src || null;
          const dl = el.querySelector && el.querySelector('a[download], a[href*=".mp4"], a[href*=".mp3"], a[href*=".wav"], a[href*="download"]');
          return dl ? dl.href : null;
        };
        if (idx != null) { const s = srcOf(document.querySelector(`[data-agent-index="${idx}"]`)); if (s) return s; }
        const vids = [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src || ((v.querySelector('source') || {}).src)).filter(Boolean);
        if (vids.length) return vids[vids.length - 1];
        // Audio next — a generated voiceover / music track is usually a blob in an <audio> element.
        const auds = [...document.querySelectorAll('audio')].map((a) => a.currentSrc || a.src || ((a.querySelector('source') || {}).src)).filter(Boolean);
        if (auds.length) return auds[auds.length - 1];
        const dls = [...document.querySelectorAll('a[download], a[href*=".mp4"], a[href*=".webm"], a[href*=".mp3"], a[href*=".wav"], a[href*=".m4a"]')].map((x) => x.href).filter(Boolean);
        if (dls.length) return dls[dls.length - 1];
        const imgs = [...document.querySelectorAll('img')].filter((im) => (im.naturalWidth || im.width) >= 200).map((im) => im.currentSrc || im.src).filter(Boolean);
        return imgs.length ? imgs[imgs.length - 1] : null;
      }, a.index != null ? Number(a.index) : null);
    } catch { /* fall through to the not-found message */ }
    if (!src) { ctx.observe('No generated file (video, audio or image) is on the page yet. If it is still rendering, call wait_for_ready first. If the result only downloads via a button, CLICK that button — the download is captured automatically.'); return; }
    const got = await fetchInPage(page, src);
    if (!got) { ctx.observe(`Could not read the file bytes from ${String(src).slice(0, 60)}… — it may only come via its own download button. CLICK that button; the download is captured automatically into the file store.`); return; }
    const kind = a.kind || (/video/i.test(got.mime) ? 'video' : /audio/i.test(got.mime) ? 'audio' : 'image');
    const id = fileAssets.put({ mime: got.mime, kind, name: a.name || null, bytes: got.bytes });
    if (!id) { ctx.observe('The file read back empty or could not be stored — try again once it has finished.'); return; }
    ctx.step('download', `saved a ${kind} (${got.bytes.length} bytes) as asset ${id}`);
    ctx.observe(`Downloaded the file — asset "${id}" (${got.mime}, ${got.bytes.length} bytes). A later step uses it with upload_file assetId "${id}".`);
  },

  /** Put a STORED file (by asset id) onto the current page's file input — image or video. */
  async upload_file(ctx, a) {
    /*
     * A PLATFORM RECORDING IS NOT A FILE ASSET, and that is why a real recording could not be edited.
     *
     * start_recording/stop_recording store their clip in fileAssets, which is what this tool reads.
     * The recorder that the PLATFORM spawns writes somewhere else entirely — /recordings/<id>/final.mp4
     * on its own volume — so a 4-minute, 122 MB recording the owner could see in the console had no
     * route into CapCut at all. The agent was not being dense; it had no tool that could reach it.
     *
     * So a recordingId is accepted alongside an assetId. Nothing is copied into the asset store: the
     * bytes are read at upload time and handed to the page's file input, exactly as an asset's are.
     */
    const asset = a.recordingId ? recordingAsset(a.recordingId) : fileAssets.get(a.assetId || a.id);
    if (!asset) {
      ctx.observe(a.recordingId
        ? `No recording "${a.recordingId}" with a finished video. Recordings live in ${RECORDINGS_DIR}/<id>/final.mp4 — check the id the console showed, and that it says "done" rather than still encoding.`
        : `No stored file with id "${a.assetId || a.id}". Download it first with download_file (or check the id from the earlier step).`);
      return;
    }
    const page = ctx.page();
    let input = null;
    try { const all = await page.$$('input[type=file]'); input = all.length ? all[all.length - 1] : null; } catch { /* none */ }
    if (!input) { ctx.observe('No file input is on the page yet. Open the site\'s upload / "Add media" control so its file input appears, then call upload_file again.'); return; }
    // Size an IMAGE to spec at the last gate (a banner/cover >= 1024x576 → 2048x1152, a photo square),
    // so an undersized image can never reach the platform. Videos and other kinds pass through as-is.
    let upBytes = asset.bytes, upMime = asset.mime, upName = asset.name;
    const upKind = a.kind || asset.kind;
    if (SPEC[upKind] && /^image\//.test(asset.mime || '')) {
      const rb = await resizeImageBytes(asset.bytes, SPEC[upKind][0], SPEC[upKind][1]);
      if (rb && rb.length) { upBytes = rb; upMime = 'image/png'; upName = String(asset.name || upKind).replace(/\.\w+$/, '') + '.png'; }
    }
    try { await input.setInputFiles({ name: upName, mimeType: upMime, buffer: upBytes }); }
    catch (e) { ctx.observe(`Could not set the file (${e.message}). The uploader may want a click first — open the upload control and retry.`); return; }
    await ctx.settle(1500);
    // Auto-confirm the crop/adjust dialog if one popped — otherwise the image never commits and the
    // agent stalls hunting for a button. Try twice: some sites chain crop → "apply" → "save".
    let confirmed = await confirmUploadDialog(page);
    if (confirmed) { await ctx.settle(1200); const again = await confirmUploadDialog(page); if (again) { await ctx.settle(1000); confirmed = `${confirmed}, ${again}`; } }
    try { if (ctx.resetClickLoop) ctx.resetClickLoop(); } catch { /* bookkeeping is never fatal */ }
    ctx.step('upload', `uploaded ${asset.name} (${asset.kind})${confirmed ? ` — confirmed "${confirmed}"` : ''}`);
    ctx.observe(confirmed
      ? `Uploaded "${asset.name}" and confirmed the crop/adjust dialog ("${confirmed}") — the image is set. Continue to the next field or Publish.`
      : `Uploaded "${asset.name}". No crop dialog needed confirming. If one is on screen, confirm it (Gereed/Done); otherwise continue to the next field or Publish.`);
  },

  /**
   * Wait for a slow generation or export to finish. Polls the page every few seconds until a text cue
   * appears (e.g. "Download", "Complete") — or, with no cue, until a video/download link shows up —
   * then hands back so the next step can read or download the result. Times out gracefully.
   */
  async wait_for_ready(ctx, a) {
    const page = ctx.page();
    const cue = String(a.text || a.cue || '').trim().toLowerCase();
    const secs = Math.min(600, Math.max(5, Number(a.seconds) || 180));
    const deadline = Date.now() + secs * 1000;
    let ready = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        ready = await page.evaluate((c) => {
          if (!c) return !!document.querySelector('video, a[download], a[href*=".mp4"]');
          return ((document.body && document.body.innerText) || '').toLowerCase().includes(c);
        }, cue);
      } catch { /* keep waiting */ }
      if (ready) break;
    }
    if (ready) {
      ctx.step('note', cue ? `"${cue}" appeared — ready` : 'a file looks ready');
      ctx.observe(`Ready${cue ? ` — "${cue}" is on the page now` : ' — a video or download is on the page'}. Look, then continue (download_file if the file is ready).`);
    } else {
      ctx.step('note', `waited ${secs}s${cue ? ` for "${cue}"` : ''} — not ready yet`);
      ctx.observe(`Still not ready after ${secs}s${cue ? ` (no "${cue}" yet)` : ''}. Look at the page — it may need more time (call wait_for_ready again) or a click to start or finish the render.`);
    }
  },
};

