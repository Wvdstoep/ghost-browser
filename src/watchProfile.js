/**
 * THE WATCHERS' OWN BROWSER. A watcher pass used to crawl in the owner's login profile, so for the
 * 5–8 minutes of a pass nothing else could use that browser: a walk the owner asked for in the chat
 * waited, the poster waited, a look waited. Now a pass runs in a COPY of the profile — `<name>-watch`,
 * cloned from the login profile once (Chromium's user-data-dir, minus its lock files) and topped up
 * with the login profile's cookies at the start of every pass while that browser is open. The owner's
 * browser stays free; the copy stays signed in on its own between passes.
 *
 * Both browsers carry the same session cookies from the same machine and exit — to the platform it is
 * one person with two tabs. Passes still take turns among themselves (they share the copy).
 */
const fs = require('fs');
const path = require('path');

const SUFFIX = '-watch';
const SKIP = /^(Singleton.*|lockfile|.*\.lock|DevToolsActivePort|\.org\.chromium\.Chromium\..*|RunningChromeVersion)$/;

const watchName = (base) => String(base || '').endsWith(SUFFIX) ? String(base) : String(base || 'facebook') + SUFFIX;

/** Copy a directory tree, skipping Chromium's lock/socket files; best effort per file. */
function copyTree(from, to, depth = 0) {
  fs.mkdirSync(to, { recursive: true });
  for (const d of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.test(d.name)) continue;
    const a = path.join(from, d.name), b = path.join(to, d.name);
    try {
      if (d.isDirectory()) { if (depth < 12) copyTree(a, b, depth + 1); }
      else if (d.isFile()) fs.copyFileSync(a, b);
    } catch { /* a file Chromium holds open; the rest still copies */ }
  }
}

/**
 * The watch copy's name, creating it from the login profile the first time. `dir` is the profiles
 * root. Returns the name to open; the copy exists afterwards (empty if there was nothing to clone —
 * the browser then makes a fresh, signed-out profile, and the health line says so via the cookies).
 */
function ensureWatchProfile(dir, base) {
  const name = watchName(base);
  const src = path.join(dir, String(base)), dst = path.join(dir, name);
  const exists = (p) => { try { return fs.existsSync(path.join(p, 'Default')) || fs.existsSync(path.join(p, 'Cookies')); } catch { return false; } };
  if (!exists(dst)) {
    if (exists(src)) copyTree(src, dst); else fs.mkdirSync(dst, { recursive: true });
    // the profile's own settings (locale, timezone, exit) travel with it — same fingerprint, same exit
    try { const cfg = path.join(src, 'profile.json'); if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(dst, 'profile.json')); } catch { /* defaults then */ }
  }
  return name;
}

/** Fresh cookies from the login browser into the watch browser (both Playwright contexts, both open). */
async function syncCookies(fromContext, toContext) {
  if (!fromContext || !toContext || typeof fromContext.cookies !== 'function' || typeof toContext.addCookies !== 'function') return 0;
  const cookies = await fromContext.cookies();
  if (!cookies.length) return 0;
  await toContext.addCookies(cookies.map((c) => { const { sameParty, priority, sourceScheme, sourcePort, ...rest } = c; return rest; }));
  return cookies.length;
}

module.exports = { ensureWatchProfile, syncCookies, watchName, copyTree, SUFFIX };
