'use strict';
/**
 * recorder/page.js — the browser-facing half of a recording: the owner's cookies for the profile,
 * the page made ready (consent wall gone, video playing with sound, full screen), and the video's
 * state for the engine's end rules. Nothing here knows about ffmpeg or displays.
 */
const path = require('path');

/** Consent walls in the languages the owner's exits speak; accept first (a recording wants the real page), reject as the fallback. */
const CONSENT_ACCEPT = /^(accept all|accept|i agree|agree|allow all|got it|ok|zaakceptuj wszystko|zgadzam się|alles accepteren|accepteren|akkoord|alle akzeptieren|akzeptieren|accepter tout|tout accepter|aceptar todo|accetta tutto|aceitar tudo)$/i;
const CONSENT_REJECT = /^(reject all|decline|odrzuć wszystko|alles afwijzen|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto)$/i;

/**
 * The profile's cookies as Playwright sees them: from the pool's live session when it holds the
 * profile, else from the profile opened briefly (headless, no display) and closed again. The file
 * copy of Chromium's cookie database does not carry a login reliably; this does.
 */
async function cookiesFor(profile, { liveContextFor, profileDir, log } = {}) {
  const live = liveContextFor ? liveContextFor(profile) : null;
  if (live) { try { const c = await live.cookies(); log && log.info && log.info(`[recorder] ${c.length} cookies from the live "${profile}" session`); return strip(c); } catch (e) { log && log.warn && log.warn(`[recorder] live cookies: ${e.message}`); } }
  const dir = path.join(profileDir || '/profiles', String(profile || 'default'));
  const { stealthChromium, CHROME_ARGS } = require('../pool');
  let context = null;
  try {
    context = await stealthChromium().launchPersistentContext(dir, { headless: true, args: CHROME_ARGS });
    const c = await context.cookies(); log && log.info && log.info(`[recorder] ${c.length} cookies from the "${profile}" profile on disk`); return strip(c);
  } catch (e) { log && log.warn && log.warn(`[recorder] profile cookies: ${e.message}`); return []; }
  finally { if (context) { try { await context.close(); } catch { /* gone */ } } }
}
function strip(cookies) { return cookies.map((c) => { const { sameParty, priority, sourceScheme, sourcePort, partitionKey, ...rest } = c; return rest; }); }

async function clickConsent(page, log) {
  for (const rx of [CONSENT_ACCEPT, CONSENT_REJECT]) {
    for (const frame of [page, ...page.frames()]) {
      try {
        const btn = frame.getByRole('button', { name: rx }).first();
        if (await btn.isVisible({ timeout: 800 }).catch(() => false)) { await btn.click({ timeout: 3000 }); log && log.info && log.info('[recorder] consent wall dismissed'); await page.waitForTimeout(1500); return true; }
      } catch { /* next frame */ }
    }
  }
  return false;
}

/** Play with sound and fill the screen. Returns what it managed, for the journal. */
async function preparePage(page, log) {
  const out = { consent: false, playing: false, fullscreen: false, muted: null };
  try { out.consent = await clickConsent(page, log); } catch { /* fine */ }
  try { await page.waitForSelector('video', { timeout: 15000 }); } catch { out.error = 'no video element on the page'; return out; }
  // a user gesture, then play + unmute + full screen from inside it (browsers demand one for both)
  try {
    await page.evaluate(() => {
      window.__gbRec = () => { const v = document.querySelector('video'); if (!v) return; v.muted = false; v.volume = 1; const p = v.play(); if (p && p.catch) p.catch(() => {}); const el = v.closest('.html5-video-player') || v; if (document.fullscreenElement !== el && el.requestFullscreen) el.requestFullscreen().catch(() => {}); };
      document.addEventListener('keydown', () => window.__gbRec(), { once: true, capture: true });
    });
    await page.keyboard.press('Shift');
    await page.waitForTimeout(1500);
  } catch (e) { log && log.warn && log.warn(`[recorder] gesture: ${e.message}`); }
  let st = await videoState(page).catch(() => null);
  if (st && st.paused) {   // some players want a real click on the video itself
    try { await page.click('video', { timeout: 3000, force: true }); await page.waitForTimeout(1200); st = await videoState(page).catch(() => null); } catch { /* still paused */ }
    if (st && st.paused) { try { await page.keyboard.press('k'); await page.waitForTimeout(1200); st = await videoState(page).catch(() => null); } catch { /* YouTube's shortcut, harmless elsewhere */ } }
  }
  if (st && !st.fullscreen) {   // no fullscreen API? make the video the whole page instead
    try { await page.addStyleTag({ content: 'video{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;background:#000!important;object-fit:contain!important} html,body{overflow:hidden!important}' }); } catch { /* fine */ }
  }
  if (st) { out.playing = !st.paused; out.fullscreen = !!st.fullscreen; out.muted = st.muted; }
  return out;
}

/** { ended, paused, muted, currentTime, duration, href, fullscreen } or null when no video is there. Skips a YouTube ad when it can. */
async function videoState(page) {
  return page.evaluate(() => {
    const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'); if (skip && skip.offsetParent !== null) { try { skip.click(); } catch (e) { /* fine */ } }
    const v = document.querySelector('video'); if (!v) return null;
    return { ended: v.ended, paused: v.paused, muted: v.muted, currentTime: v.currentTime || 0, duration: isFinite(v.duration) ? v.duration : 0, href: location.href, fullscreen: !!document.fullscreenElement };
  });
}

module.exports = { cookiesFor, preparePage, videoState, clickConsent, CONSENT_ACCEPT, CONSENT_REJECT };
