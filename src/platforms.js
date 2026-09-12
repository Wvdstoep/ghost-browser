'use strict';
/**
 * platforms.js — THE PLATFORM REGISTRY. One place that says what a platform is and how it may be
 * worked, held here because this is where the LOGINS live.
 *
 * WHY IT EXISTS. Per-platform knowledge was hard-coded in three services and disagreed with itself.
 * Herald's desk.js carried four maps (which platform a room name belongs to, a room's canonical URL,
 * how long to wait between reads, which role does the reading/replying); Herald's gb.js carried a
 * fifth (which profile holds which login) — and in that one a trailing comment had swallowed the end
 * of the line, so producthunt, youtube, x, google and web silently had NO profile names at all and
 * every walk on them ran in the shared session. LeadFlow carried a sixth. The Indie-Hackers pin was
 * written twice, in two repositories. Adding Threads or Instagram meant three services, five edits,
 * a deploy, and three components that could disagree — which is why "add the platforms where the
 * audience hides" had never happened.
 *
 * So a platform is DATA now, the way a site preset and a role already are. This file ships the
 * records with EXACTLY today's behaviour (nothing changes on the day it lands), lets the owner
 * override any field without a deploy, and answers three questions for everyone:
 *
 *   what is it        kind, label, site, where a room's URL comes from
 *   may we speak      read / reply / dm — and dm is the one that matters: 'ok' only where a first
 *                     private message is ordinary (a business platform), 'invited-only' where it is
 *                     ordinary ONLY after they spoke to us, 'never' where it would lose the account
 *   at what pace      readGapMs between reads, repliesPerDay per room
 *
 * WHAT IT IS NOT. It is not a login, not a session and not a role's text. It names the profile a
 * login lives in and the roles that work it; the profile store and the role store stay where they are.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.PROFILE_DIR || '/profiles';
const FILE = path.join(DIR, 'platforms.json');

/*
 * THE SHIPPED RECORDS — today's constants, gathered. The ORDER is meaningful: `detect` takes the
 * first record whose `match` fits, and it is the order Herald's PLATFORM_OF had, so a room named
 * "r/webdev on Reddit" still lands on reddit and not somewhere else.
 *
 * dm: 'ok'           a first private message is ordinary here (LinkedIn: people expect to be written
 *                    to about their work).
 *     'invited-only' only after they spoke to us first — the shipped invite rule decides.
 *     'never'        a stranger's DM lands in a request folder nobody opens, and asking is the
 *                    fastest way to lose the account.
 */
const SEED = [
  {
    key: 'reddit', label: 'Reddit', site: 'reddit.com', start: 'https://www.reddit.com/login',
    kind: 'community', profiles: ['reddit'], loginProfile: null,
    readNeedsLogin: false,   // a stranger can read it
    read: true, reply: true, dm: 'invited-only',
    readGapMs: 25 * 60 * 1000, repliesPerDay: 2,
    roles: { scan: 'research.reddit', scout: 'research.reddit', reply: null, dm: 'general' },
    /* A subreddit's canonical URL is derivable from its name; nothing else here is. */
    room: { capture: 'r\\/([A-Za-z0-9_]+)', template: 'https://www.reddit.com/r/$1/new/' },
    match: ['^r\\/', 'reddit\\.com\\/r\\/'],
    roomShape: 'a subreddit — read /new, answer in the thread',
  },
  {
    key: 'facebook', label: 'Facebook', site: 'facebook.com', start: 'https://www.facebook.com/login',
    kind: 'personal', profiles: ['facebook'], loginProfile: null,
    readNeedsLogin: true,   // a stranger is bounced to a login wall
    read: true, reply: true, dm: 'invited-only',
    readGapMs: 15 * 60 * 1000, repliesPerDay: 2,
    roles: { scan: 'research.web', scout: 'facebook.scout', reply: 'herald.facebook.groups.engage', dm: 'facebook.conversation' },
    room: {},
    match: ['facebook', '\\bfb group', 'facebook\\.com\\/groups'],
    roomShape: 'a group — read the feed, answer under the post',
  },
  {
    key: 'linkedin', label: 'LinkedIn', site: 'linkedin.com', start: 'https://www.linkedin.com/login',
    /* THE ONLY COLD PRIVATE CHANNEL, and it is earned by being a business platform: a message about
       somebody's work is what the place is for. It also defends hardest — pace it. */
    kind: 'business', profiles: ['linkedin', 'linkdin'], loginProfile: null,
    readNeedsLogin: true,   // a stranger is bounced to a login wall
    read: true, reply: true, dm: 'ok',
    readGapMs: 20 * 60 * 1000, repliesPerDay: 2,
    roles: { scan: 'research.linkedin', scout: 'linkedin.scout', reply: null, dm: 'linkedin.conversation' },
    room: {},
    match: ['linkedin'],
    roomShape: 'a feed or a group — comment under the post',
  },
  {
    key: 'hn', label: 'Hacker News', site: 'news.ycombinator.com', start: 'https://news.ycombinator.com/login',
    kind: 'community', profiles: ['hn', 'hackernews'], loginProfile: null,
    readNeedsLogin: false,   // a stranger can read it
    read: true, reply: true, dm: 'never',
    readGapMs: 20 * 60 * 1000, repliesPerDay: 2,
    roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: null },
    room: { url: 'https://news.ycombinator.com/newest' },
    match: ['hacker ?news', '\\bhn\\b', 'news\\.ycombinator'],
    roomShape: 'the newest list — reply in the thread',
  },
  {
    key: 'discord', label: 'Discord', site: 'discord.com', start: 'https://discord.com/login',
    kind: 'community', profiles: ['discord'], loginProfile: null,
    readNeedsLogin: true,   // a stranger is bounced to a login wall
    read: true, reply: true, dm: 'invited-only',
    readGapMs: 15 * 60 * 1000, repliesPerDay: 2,
    roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: 'general' },
    room: {},
    match: ['discord'],
    roomShape: 'a server channel — answer in the channel',
  },
  {
    key: 'producthunt', label: 'Product Hunt', site: 'producthunt.com', start: 'https://www.producthunt.com/',
    kind: 'community', profiles: ['producthunt'], loginProfile: null,
    readNeedsLogin: false,   // a stranger can read it
    read: true, reply: true, dm: 'never',
    readGapMs: 15 * 60 * 1000, repliesPerDay: 2,
    roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: null },
    room: { url: 'https://www.producthunt.com/' },
    match: ['product ?hunt'],
    roomShape: 'a launch page — comment on the launch',
  },
  {
    key: 'indiehackers', label: 'Indie Hackers', site: 'indiehackers.com', start: 'https://www.indiehackers.com/sign-in',
    /*
     * ITS LOGIN LIVES IN THE GOOGLE PROFILE, by measurement rather than policy: Indie Hackers signs
     * in through Google, and a Google sign-in inside a brand-new isolated profile is the one Google
     * refuses. This is the pin that used to be written twice, in two repositories.
     */
    kind: 'community', profiles: ['indiehackers'], loginProfile: 'google',   // both exist on disk; the pin still wins
    readNeedsLogin: false,   // a stranger can read it
    read: true, reply: true, dm: 'never',
    readGapMs: 15 * 60 * 1000, repliesPerDay: 2,
    roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: null },
    room: {},
    match: ['indie ?hackers'],
    roomShape: 'a group or a milestone post — comment as the maker',
  },
  /*
   * OUR OWN PRODUCT IS NOT HARDCODED HERE, AND THAT WAS A MISTAKE WORTH RECORDING.
   *
   * It was added to this list so the browser would know it and a walk could be sent there. It duly
   * appeared on the Platforms screen — and NOT on Accounts, where the cards you can actually click to
   * sign in live, because that screen builds its own list from the shipped catalogue plus the sites
   * the OWNER has authored. A platform you can see and cannot sign into is worse than one that is
   * simply absent.
   *
   * There was already a mechanism for exactly this: an authored site (POST /v1/profiles/custom)
   * becomes a preset, a card on Accounts, its own isolated profile, AND a record in this registry.
   * One door, already built. So the platform registers itself and every app it builds through that
   * door instead, which is also the only version that can work for an app nobody has heard of yet —
   * a list compiled into this image can never contain tomorrow's app.
   */

  {
    /*
     * THE IMAGE WORKBENCH — a TOOL, not a room. It is in this registry for the one thing the registry
     * is really for: saying which browser profile holds a login. A picture walk dispatched at
     * "platform: google" had no record here, so the lookup found nothing, fell through to the
     * single-browser default and opened the image generator in the FACEBOOK jar; and the second time,
     * in a google profile that turns out to be signed out of Gemini. The account that IS signed in —
     * and is a PRO account with the image models on it — lives in the googleaistudio profile. That
     * fact belongs written down once, here, where every caller reads it.
     *
     * Nothing speaks in it: no reading, no replying, never a DM. A brand has no presence on a
     * workbench. Those fields say so rather than being left to default into something friendlier.
     */
    key: 'googleaistudio', label: 'Google AI Studio', site: 'aistudio.google.com',
    start: 'https://aistudio.google.com/prompts/new_chat',
    kind: 'tool', profiles: ['googleaistudio'], loginProfile: 'googleaistudio',
    readNeedsLogin: true,
    read: false, reply: false, dm: 'never',
    readGapMs: 0, repliesPerDay: 0,
    roles: { scan: null, scout: null, reply: null, dm: null },
    room: {},
    match: ['ai ?studio', 'aistudio', 'google ?ai ?studio'],
    roomShape: 'not a room — an image and text workbench the desk generates in',
  },
  {
    key: 'youtube', label: 'YouTube', site: 'youtube.com', start: 'https://www.youtube.com/',
    kind: 'community', profiles: ['youtube'], loginProfile: 'google',
    readNeedsLogin: false,   // a stranger can read it
    read: true, reply: true, dm: 'never',
    readGapMs: 15 * 60 * 1000, repliesPerDay: 2,
    roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: null },
    room: {},
    match: ['youtube'],
    roomShape: 'a video\'s comments',
  },
  {
    key: 'x', label: 'X', site: 'x.com', start: 'https://x.com/login',
    kind: 'personal', profiles: ['x', 'twitter'], loginProfile: null,
    readNeedsLogin: true,   // a stranger is bounced to a login wall
    read: true, reply: true, dm: 'never',
    readGapMs: 15 * 60 * 1000, repliesPerDay: 2,
    roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: null },
    room: {},
    match: ['\\bx\\b', 'twitter'],
    roomShape: 'a thread — reply in it',
  },
  {
    key: 'useme', label: 'Useme', site: 'useme.com', start: 'https://useme.com/pl/login/',
    kind: 'freelance', profiles: ['useme'], loginProfile: null,
    readNeedsLogin: false,   // a stranger can read it
    read: true, reply: false, dm: 'ok',
    readGapMs: 20 * 60 * 1000, repliesPerDay: 0,
    roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: 'general' },
    room: {}, match: ['useme'], roomShape: 'a job listing — apply, do not comment',
  },
  {
    key: 'upwork', label: 'Upwork', site: 'upwork.com', start: 'https://www.upwork.com/ab/account-security/login',
    kind: 'freelance', profiles: ['upwork'], loginProfile: null,
    readNeedsLogin: false,   // a stranger can read it
    read: true, reply: false, dm: 'ok',
    readGapMs: 20 * 60 * 1000, repliesPerDay: 0,
    roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: 'general' },
    room: {}, match: ['upwork'], roomShape: 'a job listing — apply, do not comment',
  },
  {
    key: 'google', label: 'Google', site: 'google.com', start: 'https://www.google.com/search?q=test',
    /* Search and Maps. Nobody is reached here — it is how people and places are FOUND. */
    kind: 'search', profiles: ['google'], loginProfile: null,
    readNeedsLogin: false,   // a stranger can read it
    read: true, reply: false, dm: 'never',
    readGapMs: 12 * 60 * 1000, repliesPerDay: 0,
    roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: null },
    room: {}, match: ['google maps', '\\bmaps\\b'], roomShape: '',
  },
  {
    /*
     * THE FALLBACK, and it must stay last: `detect` returns it when nothing else fits, which is the
     * honest answer for a room the dossier named in prose. A person looks at those.
     */
    key: 'web', label: 'The open web', site: '', start: '',
    kind: 'community', profiles: ['google'], loginProfile: null,
    readNeedsLogin: false,   // a stranger can read it
    read: true, reply: false, dm: 'never',
    readGapMs: 12 * 60 * 1000, repliesPerDay: 1,
    roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: null },
    room: {}, match: [], roomShape: '',
  },
];

/* What the owner may change without a deploy. Nothing here can invent a role or a login: the role
   store and the profile store still decide whether what is named exists. */
const OVERRIDABLE = new Set(['label', 'kind', 'read', 'readNeedsLogin', 'reply', 'dm', 'readGapMs', 'repliesPerDay', 'roles', 'profiles', 'loginProfile', 'start', 'room', 'roomShape', 'match', 'search']);
const DM_VALUES = new Set(['ok', 'invited-only', 'never']);

function load() {
  try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return (v && typeof v === 'object') ? v : {}; }
  catch { return {}; }
}
function persist(store) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 }); }
  catch { /* a registry that cannot be written still serves this process */ }
}

const clampGap = (v, fallback) => {
  const n = Number(v);
  /* A gap under a minute is not a pace, it is a crawler — the thing that loses the account. */
  return Number.isFinite(n) && n >= 60 * 1000 && n <= 6 * 3600 * 1000 ? Math.round(n) : fallback;
};

/** One record with the owner's override folded in, field by field, so a partial patch is partial. */
function merge(seed, patch = {}) {
  const out = { ...seed, roles: { ...seed.roles }, room: { ...seed.room }, profiles: [...seed.profiles], match: [...seed.match] };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!OVERRIDABLE.has(k) || v === undefined) continue;
    if (k === 'roles') out.roles = { ...out.roles, ...(v && typeof v === 'object' ? v : {}) };
    else if (k === 'room') out.room = { ...(v && typeof v === 'object' ? v : {}) };
    else if (k === 'profiles' || k === 'match') out[k] = Array.isArray(v) ? v.map(String).slice(0, 20) : out[k];
    else if (k === 'dm') out.dm = DM_VALUES.has(v) ? v : out.dm;
    else if (k === 'readGapMs') out.readGapMs = clampGap(v, out.readGapMs);
    else if (k === 'repliesPerDay') out.repliesPerDay = Math.max(0, Math.min(20, Number(v) || 0));
    else if (k === 'read' || k === 'reply') out[k] = !!v;
    else out[k] = v;
  }
  return out;
}

/**
 * Every platform, shipped and authored, in detection order. A site the owner added as data
 * (userSites) becomes a record too — read-only, no replies, no DMs until they say otherwise, which
 * is the safe reading of "I added a login for this".
 */
function list({ withUserSites = true } = {}) {
  const store = load();
  const built = SEED.map((s) => merge(s, store[s.key]));
  const keys = new Set(built.map((r) => r.key));
  const authored = [];
  if (withUserSites) {
    let sites = [];
    try { sites = require('./userSites').list(); } catch { sites = []; }
    for (const u of sites) {
      if (!u || keys.has(u.key)) continue;
      authored.push(merge({
        key: u.key, label: u.label, site: u.site, start: u.start,
        kind: 'community', profiles: [u.key], loginProfile: null,
        read: true, reply: false, dm: 'never',
        readGapMs: 15 * 60 * 1000, repliesPerDay: 0,
        roles: { scan: 'research.web', scout: 'research.web', reply: null, dm: null },
        room: {}, match: [], roomShape: '', custom: true,
      }, store[u.key]));
    }
  }
  /* The fallback stays last whatever was added, so `detect` cannot return it early. */
  const web = built.filter((r) => r.key === 'web');
  return built.filter((r) => r.key !== 'web').concat(authored, web);
}

const get = (key) => list().find((r) => r.key === String(key || '').toLowerCase()) || null;

/** Which platform a room name, URL or sentence belongs to — the first record whose match fits. */
function detect(text, records = null) {
  const s = String(text || '');
  for (const r of (records || list())) {
    for (const m of (r.match || [])) {
      let re; try { re = new RegExp(m, 'i'); } catch { continue; }
      if (re.test(s)) return r.key;
    }
  }
  return 'web';
}

/** A room's canonical URL where the caller gave none — derivable for some platforms, not for most. */
function roomUrl(key, name, given = '', records = null) {
  if (given && /^https?:\/\//i.test(given)) return String(given).trim();
  const r = (records || list()).find((x) => x.key === String(key || '').toLowerCase());
  const room = (r && r.room) || {};
  if (room.capture && room.template) {
    let re; try { re = new RegExp(room.capture); } catch { re = null; }
    const m = re && String(name || '').match(re);
    if (m) return room.template.replace(/\$(\d)/g, (_, i) => m[Number(i)] || '');
  }
  return room.url || '';
}

/**
 * The records with their LIVE login state folded in, which is what a Platforms tab is for: is this
 * signed in, in which profile, when was it last used, and what was the last refusal.
 *
 * `signedIn` is true when a profile exists under one of the record's names, OR one is labelled with
 * its site — the same rule the preset list uses, because a login called "carla-test-facebook"
 * labelled facebook.com IS the Facebook login.
 */
function withLogins(detailedProfiles = [], records = null) {
  const rows = (detailedProfiles || []).map((p) => (typeof p === 'string' ? { name: p } : p || {}));
  const health = load()._health || {};
  return (records || list()).map((r) => {
    const names = r.loginProfile ? [r.loginProfile, ...r.profiles] : r.profiles;
    const byName = names.find((n) => rows.some((x) => String(x.name || '').toLowerCase() === n));
    const labelled = r.site ? rows.find((x) => String(x.site || '').toLowerCase() === r.site) : null;
    const servedBy = byName || (labelled ? labelled.name : null);
    const h = health[r.key] || {};
    return { ...r, signedIn: !!servedBy, servedBy, lastUsedAt: h.usedAt || null, lastRefusal: h.why || null, lastRefusalAt: h.refusedAt || null };
  });
}

/** Record that a walk actually ran here, or that the platform pushed back. Both are what a tab shows. */
function note(key, { used = false, refusedWhy = '' } = {}) {
  const k = String(key || '').toLowerCase();
  if (!k) return null;
  const store = load();
  const health = store._health || (store._health = {});
  const h = health[k] || (health[k] = {});
  const now = new Date().toISOString();
  if (used) h.usedAt = now;
  if (refusedWhy) { h.why = String(refusedWhy).slice(0, 300); h.refusedAt = now; }
  persist(store);
  return h;
}

/** Change one platform's rules without a deploy. Unknown and unsafe fields are dropped, not obeyed. */
function override(key, patch = {}) {
  const seed = SEED.find((s) => s.key === String(key || '').toLowerCase());
  const known = seed || list().find((r) => r.key === String(key || '').toLowerCase());
  if (!known) { const e = new Error('no such platform'); e.status = 404; throw e; }
  const store = load();
  const cur = store[known.key] || {};
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) if (OVERRIDABLE.has(k)) next[k] = v;
  store[known.key] = next;
  persist(store);
  return get(known.key);
}

/** Back to what shipped. */
function reset(key) {
  const store = load();
  const k = String(key || '').toLowerCase();
  if (!(k in store)) return false;
  delete store[k];
  persist(store);
  return true;
}

module.exports = { SEED, list, get, detect, roomUrl, withLogins, note, override, reset, FILE, OVERRIDABLE };
