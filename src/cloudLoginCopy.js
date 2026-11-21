'use strict';
/*
 * THE CLOUD'S COPY OF A PHONE LOGIN GOES (2026-11-21).
 *
 * A profile set to "phone + cluster" copied its login here (POST /v1/profiles/:name/cookies), and the same login
 * was then used from the datacenter while the phone used it from home. When the owner keeps a profile on the
 * phone again ("on this phone, tasks run here"), the copy has to be gone from every place the cluster keeps it,
 * or it simply comes back:
 *   1. pending-cookies.json   applied on every launch of the profile (pool.js)
 *   2. the vault snapshot     .gb-session.json, which puts a "lost" session back at launch (sessionVault.js)
 *   3. the browser's own jar  cleared now when the profile is open; otherwise purge-cookies.json makes the next
 *                             launch clear it (pool.js), before anything can load a page
 * Only the sites whose login came from the phone are touched; anything signed in on the cluster itself stays.
 * The watchers' copy of the profile ("<name>-watch", watchProfile.js) is cleaned the same way.
 */
const fs = require('fs');
const path = require('path');

const PURGE_FILE = 'purge-cookies.json';
const PENDING_FILE = 'pending-cookies.json';
const VAULT_FILE = '.gb-session.json';

/** The site (registrable part, "facebook.com") a cookie belongs to. */
function siteOf(c) {
  let host = String((c && c.domain) || '').replace(/^\./, '');
  if (!host && c && c.url) { try { host = new URL(c.url).hostname; } catch (e) { host = ''; } }
  const parts = host.toLowerCase().split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : '';
}
const inSite = (c, sites) => sites.includes(siteOf(c));
const domainRe = (site) => new RegExp(`(^|\\.)${site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }

/**
 * Forget the cloud's copy of the logins the phone sent for `profile`. `contexts` are the open browser contexts of
 * the profile and its watch copy (Playwright BrowserContext). Returns what was done, for the log and the app.
 */
async function forget({ profileDir, profile, contexts = [], sites: extra = [] }) {
  const dirs = [path.join(profileDir, profile), path.join(profileDir, `${profile}-watch`)];
  const pending = readJson(path.join(dirs[0], PENDING_FILE));
  const sites = [...new Set([...(Array.isArray(pending) ? pending.map(siteOf) : []), ...extra.map((s) => siteOf({ domain: s }))].filter(Boolean))];
  const out = { profile, sites, pendingRemoved: 0, vaultRemoved: 0, clearedOpen: 0, purgeAtLaunch: 0 };
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const pf = path.join(dir, PENDING_FILE);
    if (fs.existsSync(pf)) { try { fs.unlinkSync(pf); out.pendingRemoved += 1; } catch (e) { /* next */ } }
    if (!sites.length) continue;
    // The vault keeps { cookies: [...] } (sessionVault.save); only the phone's sites leave it.
    const vf = path.join(dir, VAULT_FILE);
    const snap = readJson(vf);
    if (snap && Array.isArray(snap.cookies)) {
      const keep = snap.cookies.filter((c) => !inSite(c, sites));
      out.vaultRemoved += snap.cookies.length - keep.length;
      try { if (keep.length) fs.writeFileSync(vf, JSON.stringify({ ...snap, cookies: keep }), { mode: 0o600 }); else fs.unlinkSync(vf); } catch (e) { /* next */ }
    }
    // The next launch clears the jar for these sites, whether or not it is open now (a context can be closed
    // and reopened from disk before this call ends).
    try {
      const was = readJson(path.join(dir, PURGE_FILE));
      const all = [...new Set([...(Array.isArray(was) ? was : []), ...sites])];
      fs.writeFileSync(path.join(dir, PURGE_FILE), JSON.stringify(all), { mode: 0o600 });
      out.purgeAtLaunch += 1;
    } catch (e) { /* next */ }
  }
  for (const ctx of contexts) {
    if (!ctx || typeof ctx.clearCookies !== 'function') continue;
    for (const site of sites) { try { await ctx.clearCookies({ domain: domainRe(site) }); out.clearedOpen += 1; } catch (e) { /* closed meanwhile */ } }
  }
  return out;
}

/** At launch (pool.js): clear what a purge asked for, then drop the request. Never throws. */
async function applyPurge(dir, context, log = console) {
  const file = path.join(dir, PURGE_FILE);
  const sites = readJson(file);
  if (!Array.isArray(sites) || !sites.length) return 0;
  let n = 0;
  for (const site of sites) { try { await context.clearCookies({ domain: domainRe(String(site)) }); n += 1; } catch (e) { log.warn?.(`[login-copy] ${site}: ${e.message}`); } }
  try { fs.unlinkSync(file); } catch (e) { /* gone */ }
  log.info?.(`[login-copy] ${path.basename(dir)}: the phone's login for ${sites.join(', ')} cleared from this browser`);
  return n;
}

module.exports = { forget, applyPurge, siteOf, PURGE_FILE, PENDING_FILE, VAULT_FILE };
