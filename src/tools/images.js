'use strict';
/**
 * tools/images.js — the browser's hands for FILES: make an image, and put one onto a page.
 *
 * A freshly created page is blank, and the two things that fix that first — a profile picture and a
 * cover — are FILES the platform wants uploaded. The browser could neither make an image nor set a
 * file input, so onboarding a page stopped at "type some text". These two tools close that gap with
 * ZERO external dependency: make_brand_image draws a clean brand mark on a canvas IN the page (no
 * Gemini login, no stock API, no network), and upload_image sets a file input from the stored bytes.
 *
 * Both put/read bytes through the CROSS-SESSION asset store (fileAssets.js), so GENERATE and USE can
 * be two steps IN DIFFERENT SESSIONS: an image generated on the Gemini/AI-Studio login is the same
 * asset the YouTube or CapCut login uploads. That is the whole reason the factory works — a picture
 * made in one browser has to reach a step running in another. (They used to use a per-session store,
 * which is why generated media never crossed; unifying on fileAssets is the fix.)
 */

const fileAssets = require('../fileAssets');
const { extFor } = fileAssets;
const { confirmUploadDialog, resizeImageBytes, SPEC } = require('./uihelpers');

// Drawn in the page context (page.evaluate). Pure DOM/canvas — no external image, so the canvas is
// never tainted and toDataURL always succeeds. Returns a PNG data URL.
/* eslint-disable */
const DRAW = ({ w, h, label, sub, accent, kind }) => {
  function hexToRgb(hex) {
    let s = String(hex || '').replace('#', '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    const n = parseInt(s.slice(0, 6) || '4f46e5', 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function shade({ r, g, b }, amt) {
    const f = (x) => Math.max(0, Math.min(255, Math.round(x + amt)));
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }
  const rgb = hexToRgb(accent);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, shade(rgb, 18));
  grad.addColorStop(1, shade(rgb, -46));
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  // a soft off-centre glow so it does not read as a flat block
  const glow = g.createRadialGradient(w * 0.72, h * 0.28, 10, w * 0.72, h * 0.28, Math.max(w, h) * 0.6);
  glow.addColorStop(0, 'rgba(255,255,255,0.16)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const fam = 'system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
  if (kind === 'profile') {
    g.font = `700 ${Math.floor(h * 0.36)}px ${fam}`;
    g.fillText(label, w / 2, h / 2);
  } else {
    g.font = `700 ${Math.floor(h * 0.26)}px ${fam}`;
    g.fillText(label, w / 2, h * 0.44);
    if (sub) { g.globalAlpha = 0.9; g.font = `500 ${Math.floor(h * 0.09)}px ${fam}`; g.fillText(sub, w / 2, h * 0.66); g.globalAlpha = 1; }
  }
  return c.toDataURL('image/png');
};
/* eslint-enable */

/*
 * PASTE AN IMAGE INTO A PROMPT BOX — the Ctrl+V a person does without thinking.
 *
 * A generator asked for "a banner in #5fe87f" produces a banner in a green. Asked for a banner that
 * goes WITH THIS MARK, with the mark attached, it produces one that belongs to the same identity —
 * the same weights, the same geometry, the same green. The difference is not the wording, it is that
 * the model can see the thing it is matching.
 *
 * Chat prompt boxes do not have a file input sitting on the page; the attach control opens a menu, and
 * the menu opens the operating system's file dialog, which a browser automation cannot answer. What
 * they DO all have is a paste handler, because pasting a screenshot is how people use them. So this
 * hands the box exactly what the clipboard would: a real File on a real ClipboardEvent.
 *
 * dispatchEvent returning false means something called preventDefault — which here is the good case:
 * it is the page saying "I have taken this". That is reported, because "the event was ignored" and
 * "the image is attached" look identical in a screenshot until the thumbnail renders.
 */
/* eslint-disable */
const PASTE_IMAGE = ({ b64, mime, name }) => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const file = new File([arr], name, { type: mime });

  const editable = (el) => !!el && (el.isContentEditable || /^textarea$/i.test(el.tagName)
    || (/^input$/i.test(el.tagName) && /^(text|search|)$/i.test(el.type || '')));
  const visible = (el) => !!(el.offsetParent || el.getClientRects().length);

  /* Where a person would have clicked before pressing Ctrl+V: whatever is focused, else the last
     visible writing box on the page — chat apps put theirs at the bottom. */
  let el = document.activeElement;
  if (!editable(el) || !visible(el)) {
    const boxes = [...document.querySelectorAll('[contenteditable="true"],textarea')].filter(visible);
    el = boxes.length ? boxes[boxes.length - 1] : null;
  }
  if (!el) return { ok: false, why: 'there is no writing box on this page to paste into' };
  try { el.focus(); } catch (e) { /* focus is a courtesy; the event still lands */ }

  let dt;
  try {
    dt = new DataTransfer();
    dt.items.add(file);
  } catch (e) { return { ok: false, why: 'this browser would not build a clipboard payload: ' + e.message }; }

  let handled = false;
  try {
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    handled = el.dispatchEvent(ev) === false;   // false = preventDefault = the page took it
  } catch (e) { return { ok: false, why: 'the paste event would not dispatch: ' + e.message }; }

  const label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || '';
  return { ok: true, handled, tag: (el.tagName || '').toLowerCase(), label: String(label).slice(0, 70) };
};
/* eslint-enable */

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const two = (parts[0][0] || '') + (parts.length > 1 ? (parts[parts.length - 1][0] || '') : '');
  return (two || parts[0].slice(0, 2)).toUpperCase();
}

module.exports = {
  /**
   * Draw a clean brand image — a square mark for the profile picture, a wide banner for the cover —
   * from the brand's name and accent colour, and store it. Needs nothing external; the point is that
   * a blank page gets an identity in the first minute without waiting on any image service.
   */
  async make_brand_image(ctx, a) {
    const kind = a.kind === 'cover' ? 'cover' : 'profile';
    const name = String(a.name || a.text || 'Brand').slice(0, 60);
    const accent = /^#?[0-9a-fA-F]{3,8}$/.test(String(a.accent || '')) ? String(a.accent) : '#4f46e5';
    const [w, h] = kind === 'cover' ? [1640, 624] : [512, 512];
    const label = kind === 'profile' ? initials(name) : name;
    const sub = kind === 'cover' ? String(a.tagline || '').slice(0, 80) : '';
    let dataUrl;
    try {
      dataUrl = await ctx.page().evaluate(DRAW, { w, h, label, sub, accent, kind });
    } catch (e) {
      ctx.observe(`Could not draw the ${kind} image (${e.message}). Try again, or skip the image and set the About/text.`);
      return;
    }
    const bytes = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
    const id = fileAssets.put({ kind, mime: 'image/png', name: `${kind}.png`, bytes });
    if (!id) { ctx.observe('The image came out empty — try again.'); return; }
    try { if (ctx.resetClickLoop) ctx.resetClickLoop(); } catch { /* progress bookkeeping is never fatal */ }
    ctx.step('image', `made a ${kind} brand image for "${name}"`);
    ctx.observe(`Made a ${kind} brand image (asset ${id}, ${bytes.length} bytes). To use it: open the page's ${kind === 'profile' ? 'profile-photo' : 'cover-photo'} editor so its upload control (a file field) is on screen, then call upload_image with assetId "${id}".`);
  },

  /**
   * A PICTURE OF THE SCREEN WE ARE LOOKING AT, for a page that describes it.
   *
   * download_image takes a picture OUT of a page — one somebody else put there. This makes one OF the
   * page, which is the only way to show our own product doing the thing an answer page is describing.
   *
   * IT MEASURES WHAT IT TOOK, and that is not a nicety. An image published without its width and
   * height shifts the layout as it loads, which search measures and counts against the page — so the
   * store that these end up in refuses an image that cannot say how big it is. A tool that returned
   * bytes alone would produce pictures nothing could publish.
   */
  async screenshot_page(ctx, a) {
    const page = ctx.page();
    let shot = null, box = null;
    try {
      if (a.index !== undefined && a.index !== null && ctx.elementAt) {
        /* A named element: the form, the panel, the result — usually far more useful than the whole
           window, which is mostly chrome and empty space. */
        const el = ctx.elementAt(a.index);
        if (el && el.handle) { shot = await el.handle.screenshot({ type: 'png' }); box = await el.handle.boundingBox(); }
      }
      if (!shot) {
        shot = await page.screenshot({ type: 'png' });
        box = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null);
      }
    } catch (e) {
      ctx.observe(`The screen could not be photographed (${e.message}). Look, make sure the page has finished loading, and try once more.`);
      return;
    }
    if (!shot || !shot.length) { ctx.observe('The picture came out empty — look and try again.'); return; }
    const width = Math.round((box && box.width) || 0);
    const height = Math.round((box && box.height) || 0);
    if (!width || !height) {
      ctx.observe('The picture was taken but its size could not be measured, and an image published without its size shifts the page as it loads. Look and try again.');
      return;
    }
    /*
     * THE KIND IS MACHINERY, NOT A LABEL. It was taken from whatever the walk typed, and a walk duly
     * typed "cluster-nodes-view" — a perfectly sensible description, and one that made the picture
     * invisible to the round looking for a screenshot. What the walk describes is the NAME; the kind
     * is how the rest of the system finds it, so the tool decides it.
     */
    const id = fileAssets.put({
      kind: 'screenshot', mime: 'image/png',
      name: String(a.name || a.kind || 'screen').replace(/[^a-z0-9-]+/gi, '-').slice(0, 60) + '.png',
      source: 'screenshot', width, height, bytes: shot,
    });
    if (!id) { ctx.observe('The picture could not be stored — try again.'); return; }
    try { if (ctx.resetClickLoop) ctx.resetClickLoop(); } catch { /* progress bookkeeping is never fatal */ }
    ctx.step('image', `photographed the screen (${width}x${height}, asset ${id})`);
    /*
     * ASK FOR THE ALT TEXT NOW, while the walk is still looking at the thing. A description written
     * later from a filename is the "screenshot of the dashboard" that tells a blind reader and an
     * image search exactly nothing.
     */
    ctx.observe(`Took the picture (${width}x${height}, asset ${id}). Now say in ONE plain sentence what is actually ON that screen — the fields, the buttons, the values you can see — because that sentence becomes the alt text, and "a screenshot of the app" describes nothing to somebody who cannot see it.`);
  },

  /**
   * Paste a stored image into the page's prompt box, the way a person pastes a screenshot into a
   * chat. This is how a reference image reaches an image generator: its attach button opens the
   * operating system's file dialog, which no automation can answer, but its paste handler is right
   * there and is the path people actually use.
   */
  async paste_image(ctx, a) {
    const asset = fileAssets.get(a.assetId) || (a.kind ? fileAssets.latest(a.kind) : fileAssets.latest());
    if (!asset) {
      ctx.observe(`No stored image to paste${a.assetId ? ` (asset "${a.assetId}" not found)` : ''}${a.kind ? ` of kind "${a.kind}"` : ''}. Nothing was prepared for this walk, so carry on without a reference image.`);
      return;
    }
    let r;
    try {
      r = await ctx.page().evaluate(PASTE_IMAGE, {
        b64: Buffer.from(asset.bytes).toString('base64'),
        mime: asset.mime || 'image/png',
        name: asset.name || 'reference.png',
      });
    } catch (e) {
      ctx.observe(`The image could not be pasted (${e.message}). Carry on and describe the brand in words instead — a missing reference is not a reason to stop.`);
      return;
    }
    if (!r || !r.ok) {
      ctx.observe(`The image was not pasted: ${(r && r.why) || 'unknown'}. Click into the prompt box first so it has focus, then try paste_image once more. If it still will not take, describe the brand in words and carry on.`);
      return;
    }
    try { if (ctx.resetClickLoop) ctx.resetClickLoop(); } catch { /* progress bookkeeping is never fatal */ }
    ctx.step('image', `pasted a ${asset.kind || 'reference'} image into the ${r.tag} prompt box`);
    /*
     * NEVER CLAIM IT ATTACHED. The event was delivered; whether the app rendered a thumbnail is a
     * different question, and the only honest way to know is to look. A walk that assumes the
     * reference is there writes a prompt about "the attached logo" that the model never received.
     */
    ctx.observe(`Pasted the image into the ${r.tag}${r.label ? ` ("${r.label}")` : ''} prompt box, and the page ${r.handled ? 'accepted the paste' : 'did not visibly take it'}. Now call look: a thumbnail or file chip should be sitting in or above the box. If it IS there, write your prompt referring to the attached image. If it is NOT, try clicking into the box and pasting once more, and if that fails too, write the prompt describing the brand in words instead.`);
  },

  /**
   * Put a stored image onto the page by setting a file input from it. Works on the hidden
   * input[type=file] a platform reveals when you open its photo editor — no OS dialog involved.
   * After it, a Save/Apply/crop confirmation usually remains, which the walk does through act.
   */
  async upload_image(ctx, a) {
    const asset = fileAssets.get(a.assetId) || (a.kind ? fileAssets.latest(a.kind) : fileAssets.latest());
    if (!asset) { ctx.observe(`No stored image to upload${a.assetId ? ` (asset "${a.assetId}" not found)` : ''}. Make one first with make_brand_image, or download one with download_image.`); return; }
    const page = ctx.page();
    let input = null;
    try {
      // Prefer an image-accepting file input; fall back to the last file input on the page (platforms
      // often keep the real one hidden and trigger it from a styled button).
      input = await page.$('input[type=file][accept*="image"]');
      if (!input) { const all = await page.$$('input[type=file]'); input = all.length ? all[all.length - 1] : null; }
    } catch (e) { /* fall through to the not-found message */ }
    if (!input) {
      ctx.observe('No file input is on the page yet. Open the photo editor first (click the page\'s camera / "Edit"/"Add photo" control so its uploader appears), then call upload_image again.');
      return;
    }
    // SOURCE FIX, at the last gate: size the image to the platform's spec RIGHT BEFORE it goes in — a
    // channel banner must be >= 1024x576 (we send 2048x1152), a photo square. Whatever the asset's
    // origin (canvas make_brand_image at 1640x624, a Gemini capture, a resize that did not run), the
    // upload now cannot be undersized. This is the fix "in the source", not a one-off resize.
    const upKind = a.kind || asset.kind;
    let upBytes = asset.bytes, upMime = asset.mime, upName = asset.name;
    if (SPEC[upKind]) {
      const rb = await resizeImageBytes(asset.bytes, SPEC[upKind][0], SPEC[upKind][1]);
      if (rb && rb.length) { upBytes = rb; upMime = 'image/png'; upName = String(asset.name || upKind).replace(/\.\w+$/, '') + '.png'; }
    }
    try {
      await input.setInputFiles({ name: upName, mimeType: upMime, buffer: upBytes });
    } catch (e) {
      ctx.observe(`Could not set the file (${e.message}). The uploader may want a click first — open the photo editor and retry.`);
      return;
    }
    await ctx.settle(1200);
    // Auto-confirm the crop/adjust dialog (Gereed/Klaar/Done) — otherwise the image never commits and
    // the agent stalls hunting for a button. Twice, in case it chains crop → apply.
    let confirmed = await confirmUploadDialog(page);
    if (confirmed) { await ctx.settle(1000); const again = await confirmUploadDialog(page); if (again) { await ctx.settle(800); confirmed = `${confirmed}, ${again}`; } }
    // An upload is real progress — reset the click-loop counter, or the Save AFTER a profile upload and
    // the Save AFTER a cover upload (same label "Save changes") get counted as one loop and blocked.
    try { if (ctx.resetClickLoop) ctx.resetClickLoop(); } catch { /* progress bookkeeping is never fatal */ }
    ctx.step('upload', `uploaded the ${asset.kind} image${confirmed ? ` — confirmed "${confirmed}"` : ''}`);
    ctx.observe(confirmed
      ? `Uploaded the ${asset.kind} image and confirmed the crop dialog ("${confirmed}") — it is set. Continue to the next field, or click Publiceren/Publish (as an act) when everything is done.`
      : `Uploaded the ${asset.kind} image. If a crop/Save dialog is on screen, confirm it (Gereed/Done); then continue, and click Publiceren when done.`);
  },

  /**
   * GET AN IMAGE OUT OF THE PAGE — a real photo an image tool (Gemini) just generated in its chat, or
   * one on a stock page. Reads the picture's own source and fetches the bytes INSIDE the logged-in
   * page (so a generator's or stock site's entitlement applies, and nothing but a reference crosses),
   * then stores it exactly like a made image. By default it takes the most recent large picture — the
   * one just generated — but you can point it at a numbered element if the look shows the image.
   *
   * NOTE: the exact way to reach the generated image is platform-shaped and confirmed by walking the
   * flow once; this is the mechanism the role drives.
   */
  /* FILE ENGINE: any LINKED file — a PDF, a zip, an export, a video — fetched inside the logged-in page
     (so the site's entitlement applies) and stored with its real name. index = a numbered link the look
     showed; url = a direct address. Falls back to the browser's own request when the page's fetch is
     refused (cross-origin). */
  async download_file(ctx, a) {
    const fileEngine = require('../fileEngine');
    const page = ctx.page();
    let url = String(a.url || '').trim();
    if (!url && a.index != null) { try { url = await page.$eval(`[data-agent-index="${a.index}"]`, (el) => el.href || el.getAttribute('href') || el.src || (el.closest('a') && el.closest('a').href) || ''); } catch { url = ''; } }
    if (!url) { ctx.observe('No file address: pass url, or the index of a link the look showed.'); return; }
    try { url = new URL(url, page.url()).toString(); } catch { ctx.observe(`That is not a usable address: ${url}`); return; }
    let bytes = null, mime = '', cd = '';
    try {
      const got = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: 'include' }); if (!r.ok) return { err: r.status }; const b = await r.blob(); const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b); }); return { mime: r.headers.get('content-type') || b.type || '', cd: r.headers.get('content-disposition') || '', dataUrl }; }, url).catch(() => null);
      if (got && !got.err && got.dataUrl) { bytes = Buffer.from(String(got.dataUrl).split(',')[1] || '', 'base64'); mime = got.mime; cd = got.cd; }
    } catch { bytes = null; }
    if (!bytes) {
      try { const r = await page.request.get(url, { timeout: 120000 }); if (r.ok()) { bytes = await r.body(); const h = r.headers(); mime = h['content-type'] || ''; cd = h['content-disposition'] || ''; } } catch { bytes = null; }
    }
    if (!bytes || !bytes.length) { ctx.observe(`Could not fetch the file at ${url} — it may need a click on the page (a download button), which the browser captures by itself.`); return; }
    mime = String(mime || fileEngine.mimeFor(url)).split(';')[0].trim() || 'application/octet-stream';
    const name = a.name ? fileEngine.nameFrom({ contentDisposition: `filename="${a.name}"`, mime }) : fileEngine.nameFrom({ contentDisposition: cd, url, mime });
    let source = ''; try { source = new URL(url).hostname; } catch { source = ''; }
    const id = fileAssets.put({ kind: fileEngine.kindOf(mime), mime, name, bytes, source: `link:${source}` });
    ctx.step('file', `downloaded ${fileEngine.describe({ name, mime, size: bytes.length, source })} as asset ${id}`);
    ctx.observe(`Downloaded ${name} (${fileEngine.kindOf(mime)}, ${Math.round(bytes.length / 1024)} KB) — asset "${id}". The owner can see and save it from the chat; upload_file with assetId "${id}" puts it on another page.`);
  },

  async download_image(ctx, a) {
    const page = ctx.page();
    // 1) Find the image ELEMENT — a handle we can both read a src from AND screenshot. The handle is
    // the key: a Gemini image is a blob/CORS URL the in-page fetch usually cannot read (which is why
    // capture kept failing and the agent fell back to Gemini's own download button, saving to disk
    // instead of our store), but an element can ALWAYS be screenshotted.
    let handle = null;
    try {
      if (a.index != null) {
        const marked = await page.$(`[data-agent-index="${a.index}"]`);
        /* An img or nothing. It used to fall back to the numbered element itself, which for a
           result card means capturing the card — its border, its padding and its buttons — and
           calling that the picture. Better to look for the image the normal way than to file a
           photograph of somebody else's interface. */
        if (marked) handle = await marked.$('img').catch(() => null);
        if (!handle) {
          const isImg = marked && await marked.evaluate((el) => el.tagName === 'IMG').catch(() => false);
          if (isImg) handle = marked;
        }
      }
      if (!handle) {
        const jh = await page.evaluateHandle(() => {
          const imgs = [...document.querySelectorAll('img')].filter((im) => (im.naturalWidth || im.width) >= 200 && (im.naturalHeight || im.height) >= 200);
          const gen = imgs.filter((im) => /blob:|googleusercontent|lh3|\/generated|\/images?\//i.test(im.currentSrc || im.src || ''));
          const pool = gen.length ? gen : imgs;
          return pool[pool.length - 1] || null;   // most recent large = the one just generated
        });
        handle = jh && jh.asElement ? jh.asElement() : null;
      }
    } catch { /* fall through to the not-found message */ }
    if (!handle) { ctx.observe('No generated image is on the page yet. If it is still generating, wait and look again; then call download_image.'); return; }

    // 2) FULL-RES FAST PATH: fetch the element's own src inside the page, credentialed. Works for a
    // direct-URL image and keeps its full resolution.
    let bytes = null, mime = 'image/png';
    try {
      const src = await handle.evaluate((el) => el.currentSrc || el.src || null).catch(() => null);
      if (src) {
        const dataUrl = await page.evaluate(async (u) => {
          try {
            const r = await fetch(u, { credentials: 'include' });
            if (!r.ok) return null;
            const b = await r.blob();
            return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); });
          } catch { return null; }
        }, src).catch(() => null);
        if (dataUrl) {
          mime = (/^data:([^;]+)/.exec(dataUrl) || [])[1] || 'image/png';
          const b = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
          if (b.length) bytes = b;
        }
      }
    } catch { /* fall through to the screenshot */ }

    /*
     * 2b) THE PIXELS OF THE IMAGE ITSELF, via a canvas — because a screenshot is of a REGION.
     *
     * The first diagram published from this path came out with three little icons in its top-right
     * corner: Gemini's own share, copy and download buttons. Nothing captured them by mistake — an
     * element screenshot takes whatever is painted over that rectangle, and their toolbar sits on top
     * of the picture. So the fallback cannot help but photograph another product's furniture onto our
     * page, and there is no arrangement of it that fixes that.
     *
     * Drawing the image into a canvas reads the IMAGE, not the screen: no overlay, no rounded card,
     * no hairline border, and at its real resolution rather than its display size. A blob: URL made
     * by the page is same-origin so the canvas stays clean; a cross-origin one taints it and throws,
     * which is exactly when the screenshot below is still the right answer.
     */
    if (!bytes || !bytes.length) {
      try {
        const dataUrl = await handle.evaluate((el) => {
          try {
            const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
            if (!w || !h) return null;
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(el, 0, 0, w, h);
            return c.toDataURL('image/png');       // throws on a tainted canvas
          } catch { return null; }
        }).catch(() => null);
        if (dataUrl) {
          const b = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
          if (b.length) { bytes = b; mime = 'image/png'; }
        }
      } catch { /* fall through to the screenshot */ }
    }

    // 3) RELIABLE PATH: screenshot the image element itself. This ALWAYS works — a blob URL, a
    // CORS-restricted googleusercontent image, a canvas — none of it matters, because we capture what
    // is rendered on screen. A touch below original resolution, and it can catch a toolbar the page
    // paints over the picture, which is why it now runs last of three rather than second of two.
    if (!bytes || !bytes.length) {
      try { const shot = await handle.screenshot({ type: 'png' }); if (shot && shot.length) { bytes = shot; mime = 'image/png'; } }
      catch { /* nothing more to try */ }
    }
    if (!bytes || !bytes.length) { ctx.observe('Could not read the image — it may still be rendering. Wait, look again, then call download_image.'); return; }

    // Size it to spec so a platform never rejects it as too small ("min 1024x576"): a banner/cover →
    // 2048x1152, a profile photo → square. Captured art is display-size (~700px); this crops/scales
    // it to the exact size the site wants. Other kinds (scene frames) keep their captured size.
    /* FILE ENGINE: the picture at its own resolution is the result; only a picture destined for a
       site slot (profile, cover, post) is sized to that slot's spec. "sized for post" on a generated
       image the owner asked for was the wrong default — the owner got a thumbnail. */
    const kind = a.kind || 'original';
    let outBytes = bytes;
    if (SPEC[kind] && kind !== 'original') { outBytes = await resizeImageBytes(bytes, SPEC[kind][0], SPEC[kind][1]); mime = 'image/png'; }
    let source = ''; try { source = new URL(page.url()).hostname; } catch { source = ''; }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const id = fileAssets.put({ kind: kind === 'original' ? 'image' : kind, mime, name: `${(a.name || source || 'image').replace(/[^a-z0-9._-]+/gi, '-')}-${stamp}.${extFor(mime)}`, bytes: outBytes, source: source ? `page:${source}` : 'page' });
    ctx.step('image', `downloaded an image (${outBytes.length} bytes${kind !== 'original' ? `, sized for ${kind}` : ', original size'}) as asset ${id}`);
    ctx.observe(`Downloaded the image — asset "${id}" (${bytes.length} bytes). To use it on a page in THIS or a LATER step (even another login): upload_image or upload_file with assetId "${id}".`);
  },
};
