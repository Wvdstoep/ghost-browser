'use strict';
/**
 * siteWalls.js — which sites the CLUSTER cannot load, learned from what pages actually did.
 *
 * WHY THIS EXISTS. LinkedIn was the one gated platform and it was declared by hand: a `needsDevice`
 * flag on its preset in sites/index.js. That works for exactly the site somebody thought to name,
 * and the routing rule the ring rests on is "the cluster NEVER runs a gated platform". A rule that
 * strong cannot depend on a human having remembered to add a site to a list — the first unlisted
 * gated site loops forever from the cluster, reports nothing useful, and there is no flag anywhere
 * that says why.
 *
 * So the flag becomes DATA, learned from real page behaviour: a site that redirect-loops or answers
 * a challenge from the cluster is recorded as walled, with the evidence and the time. The preset
 * flag stays as the SEED and the override — a site declared gated is gated whatever the sensor
 * thinks — and detection fills in everything nobody declared.
 *
 * A wall is not permanent. Cloudflare posture changes, an exit changes, a login is repaired: a site
 * that later loads clean from the cluster is cleared, with the clean load as its own evidence. The
 * cheapest way to be wrong here is to strand a site on the phone forever because it was walled once.
 *
 * Persisted on the profile volume so what was learned survives a restart, like profiles, jobs and
 * the owner's own sites do. One record per host; the newest evidence wins.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.PROFILE_DIR || '/profiles';
const FILE = path.join(DIR, 'site-walls.json');

/*
 * HOW MANY CLEAN LOADS CLEAR A WALL.
 *
 * One is too few: a challenge that happens to let a single request through would unstick a site that
 * is still gated, and the pass after it goes back to the cluster and loops. Clearing is the cheap
 * direction to be slow about, because a site wrongly left on the phone still WORKS — it is only
 * running somewhere better than it needs to.
 */
const CLEAN_TO_CLEAR = 3;

/** A bare host from anything: "linkedin.com", "https://www.linkedin.com/feed", a profile key. */
function hostOf(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}

/*
 * READ CACHED, BECAUSE THE SENSOR ASKS ON EVERY NAVIGATION.
 *
 * The clean-load path has to check whether a host is flagged before it can decide to do nothing,
 * which is the answer almost every time. Straight off the disk that is a synchronous JSON read per
 * page load in a browser pool, to learn that there is nothing to learn. Five seconds of staleness
 * costs nothing here: the flag changes on the scale of a pass, not a request, and every write
 * invalidates it immediately.
 */
const CACHE_MS = 5000;
let cache = null;
let cacheAt = 0;

function load() {
  if (cache && (Date.now() - cacheAt) < CACHE_MS) return cache;
  let v = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) v = parsed;
  } catch { v = {}; }
  cache = v;
  cacheAt = Date.now();
  return v;
}

function persist(map) {
  cache = map;
  cacheAt = Date.now();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
    return true;
  } catch { return false; }
}

/** Drop the read cache. For tests, and for anything that edits the file underneath us. */
function reload() { cache = null; cacheAt = 0; }

/**
 * Record that the cluster could not load this host, and why.
 *
 * `why` is the sensor's one-line account and `evidence` is what it actually saw, both kept because a
 * flag that routes work away from the cluster has to be able to justify itself to whoever finds it.
 */
function record(hostOrUrl, { why = '', evidence = '', url = '' } = {}) {
  const host = hostOf(hostOrUrl);
  if (!host) return null;
  const map = load();
  const prev = map[host] || {};
  map[host] = {
    host,
    walled: true,
    why: String(why || prev.why || 'the cluster could not load it'),
    evidence: String(evidence || prev.evidence || '').slice(0, 400),
    url: String(url || prev.url || '').slice(0, 300),
    at: Date.now(),
    /* How many times this has been sensed. A site walled once and never again is worth telling
       apart from one that walls every single pass. */
    hits: Number(prev.hits || 0) + 1,
    clean: 0,                    // a fresh wall resets any progress toward clearing
  };
  persist(map);
  return map[host];
}

/**
 * Record that the cluster DID load this host cleanly. Only clears the wall after CLEAN_TO_CLEAR of
 * them, and is a no-op for a host nobody has ever flagged (the overwhelmingly common case, so it
 * stays cheap and writes nothing).
 */
function clean(hostOrUrl, { url = '' } = {}) {
  const host = hostOf(hostOrUrl);
  if (!host) return null;
  const map = load();
  const rec = map[host];
  if (!rec || !rec.walled) return null;      // nothing learned about this host — nothing to undo
  const n = Number(rec.clean || 0) + 1;
  if (n < CLEAN_TO_CLEAR) {
    map[host] = { ...rec, clean: n };
    persist(map);
    return map[host];
  }
  map[host] = {
    host,
    walled: false,
    why: `loaded cleanly from the cluster ${n} times after being walled`,
    evidence: String(url || '').slice(0, 300),
    url: String(url || rec.url || '').slice(0, 300),
    at: Date.now(),
    hits: Number(rec.hits || 0),
    clean: n,
  };
  persist(map);
  return map[host];
}

/** Has the cluster been shown it cannot load this host? Accepts a host, a URL or a profile key. */
function walled(hostOrUrl) {
  const host = hostOf(hostOrUrl);
  if (!host) return false;
  const map = load();
  if (map[host] && map[host].walled) return true;
  /*
   * A wall learned on `linkedin.com` has to count for `www.linkedin.com/feed` and for a profile that
   * only ever names the bare site. Matched on the registrable tail rather than an exact string, or
   * the same wall would be learned once per subdomain and route only some of the work.
   */
  for (const k of Object.keys(map)) {
    if (!map[k] || !map[k].walled) continue;
    if (host === k || host.endsWith('.' + k)) return true;
  }
  return false;
}

/** Everything learned, newest first — for the screen that has to be able to explain the routing. */
function all() {
  return Object.values(load()).sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
}

/** Forget a host entirely. The owner's escape hatch when a sensor was simply wrong. */
function forget(hostOrUrl) {
  const host = hostOf(hostOrUrl);
  const map = load();
  if (!host || !map[host]) return false;
  delete map[host];
  persist(map);
  return true;
}

module.exports = { record, clean, walled, all, forget, hostOf, reload, FILE, CLEAN_TO_CLEAR };
