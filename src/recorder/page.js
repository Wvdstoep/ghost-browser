'use strict';
/**
 * recorder/page.js — the browser-facing half of a recording: the owner's cookies for the profile,
 * the page made ready (consent wall gone, video playing with sound, full screen), and the video's
 * state for the engine's end rules. Nothing here knows about ffmpeg or displays.
 */
const path = require('path');

/** Consent walls in the languages the owner's exits speak; accept first (a recording wants the real page), reject as the fallback. */
const CONSENT_ACCEPT = /^(accept all|accept|i agree|agree|allow all|got it|ok|zaakceptuj wszystko|zgadzam się|alles accepteren|accepteren|akkoord|alle akzeptieren|akzeptieren|accepter tout|tout accepter|aceptar todo|accetta tutto|aceitar tudo|hyväksy kaikki|godkänn alla|acceptér alle|accepter alle|godta alle|přijmout vše|elfogad mindent|acceptă tot|принять все)$/i;
const CONSENT_REJECT = /^(reject all|decline|odrzuć wszystko|alles afwijzen|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto|hylkää kaikki|avvisa alla|afvis alle|avvis alle|odmítnout vše|elutasít mindent|respinge tot|отклонить все)$/i;

/**
 * Cookies that answer a platform's consent wall BEFORE the page loads, in any language: YouTube and
 * Google honour SOCS=CAI as "consent given" (the same token yt-dlp sets). Only added when the
 * profile has none — a real choice the owner made is never overwritten.
 */
function platformCookies(url, existing = []) {
  let host = ''; try { host = new URL(url).hostname; } catch { return []; }
  const has = (name, domain) => existing.some((c) => c.name === name && String(c.domain || '').replace(/^\./, '') === domain);
  const out = [];
  if (/(^|\.)youtube\.com$/.test(host) || /(^|\.)google\.[a-z.]+$/.test(host)) {
    for (const domain of ['youtube.com', 'google.com']) if (!has('SOCS', domain)) out.push({ name: 'SOCS', value: 'CAI', domain: '.' + domain, path: '/', secure: true, sameSite: 'None', expires: Math.floor(Date.now() / 1000) + 365 * 86400 });
  }
  return out;
}

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

/**
 * A consent wall renders a moment AFTER the page (YouTube's a second or two later, client-side), so
 * this looks for up to `waitMs`, in the page and its frames, accept first then reject. Buttons carry
 * their text as content or as an aria-label; getByRole reads both.
 */
async function clickConsent(page, log, waitMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    for (const rx of [CONSENT_ACCEPT, CONSENT_REJECT]) {
      for (const frame of [page, ...page.frames()]) {
        try {
          const btn = frame.getByRole('button', { name: rx }).first();
          if (await btn.count() && await btn.isVisible({ timeout: 300 }).catch(() => false)) {
            await btn.click({ timeout: 5000 }); log && log.info && log.info(`[recorder] consent wall dismissed (${(await btn.textContent().catch(() => '')) || 'aria'}`.trim() + ')');
            await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(2000); return true;
          }
        } catch { /* next frame */ }
      }
    }
    await page.waitForTimeout(700);
  }
  return false;
}

/** Play with sound and fill the screen. Returns what it managed, for the journal. */
async function preparePage(page, log) {
  const out = { consent: false, playing: false, fullscreen: false, muted: null };
  try { out.consent = await clickConsent(page, log); } catch { /* fine */ }
  // attached, not visible: a player's <video> is often hidden or covered until it starts
  try { await page.waitForSelector('video', { state: 'attached', timeout: 15000 }); } catch { out.error = 'no video element on the page'; return out; }
  // a wall that came up late, after the video element was there
  if (!out.consent) { try { out.consent = await clickConsent(page, log, 3000); } catch { /* fine */ } }
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
  if (st && st.paused) {   // a big play button (YouTube's, most players') beats a click on the video, which can pause it
    try { const big = page.locator('.ytp-large-play-button, button[aria-label*="Play" i], button[title*="Play" i]').first(); if (await big.count() && await big.isVisible({ timeout: 500 }).catch(() => false)) { await big.click({ timeout: 3000 }); await page.waitForTimeout(1200); st = await videoState(page).catch(() => null); } } catch { /* next */ }
  }
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

module.exports = { cookiesFor, platformCookies, preparePage, videoState, clickConsent, CONSENT_ACCEPT, CONSENT_REJECT };
