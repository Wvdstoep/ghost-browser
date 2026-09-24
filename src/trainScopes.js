/*
 * trainScopes.js — WHICH PLATFORM A ROLE WORKS ON, AND THE THREE SCOPES A ROUND CAN TRAIN.
 *
 * A role is data: a JSON file under /profiles/roles or an entry in roles.js, with a site, a
 * description, a tool list and a prompt. Fifty-six built in, a hundred and twenty-eight authored.
 * That is far too many adapters, and most of them share a platform: twelve roles live on Facebook,
 * fourteen on Google properties, thirty-odd on useme. The habits a model has to learn — where the
 * menu is, what a finished form looks like, which mark to press on an offer page — belong to the
 * PLATFORM, not to the job. So weights are trained in three scopes, each on the turns of the scope
 * below it and chained from the adapter of the scope above it:
 *
 *   base                 every sighted turn there is. How to operate a browser at all.
 *   platform:<name>      every sighted turn on that platform, whatever the role. Its corners.
 *   role:<name>          that role's own turns, once it holds a slice of them. Its job.
 *
 * The role's own text — its prompt — stays in the system message at every scope. A fact belongs in
 * text and a habit in weights; the platform map (platformMap.js) is text for the same reason.
 *
 * WHICH PLATFORM. The role record says so when it names a site (explicit data wins); the role's
 * NAME says so for the authored roles that did not (reddit-*, hn-*, olx-*); anything else is the
 * open web, which is what base means. A role added tomorrow lands on its platform the moment its
 * file exists, and the collector, the planner and the serving chain see it from the next tick.
 *
 * Pure. No file, no clock. roles.js is read for the record only.
 */
'use strict';

const roles = require('./roles');

/** The platform with no platform: the open web, which is what the base adapter learns. */
const BASE = 'web';

/* A site as a record names it, to the name the rest of the pipeline uses. Matched on the host. */
const SITES = {
  'news.ycombinator.com': 'hackernews',
  'facebook.com': 'facebook', 'messenger.com': 'facebook',
  'linkedin.com': 'linkedin',
  'reddit.com': 'reddit',
  'google.com': 'google', 'gmail.com': 'google', 'search.google.com': 'google',
  'useme.com': 'useme',
  'upwork.com': 'upwork',
  'x.com': 'x', 'twitter.com': 'x',
  'producthunt.com': 'producthunt',
  'indiehackers.com': 'indiehackers',
  'olx.pl': 'olx',
  'youtube.com': 'youtube',
  'remoteok.com': 'remoteok',
  'capcut.com': 'studio',
};

/* For a role whose record names no site: what its name says. First match wins, so the specific
   (herald-reply-hacker-news) sits above the general (herald). */
const RULES = [
  ['hackernews', /^(hacker-news|hn-|herald-reply-hacker-news)/],
  ['reddit', /^(reddit|herald-reply-reddit|herald\.reddit|post\.reddit|reach\.reddit|research\.reddit)/],
  ['linkedin', /^(linkedin|herald-reply-linkedin|herald\.linkedin|post\.linkedin|reach\.linkedin|client\.linkedin|research\.linkedin)/],
  ['indiehackers', /^herald-reply-indie-hackers/],
  ['facebook', /^(facebook|messenger|herald\.facebook|herald-reply$|herald-room-post)/],
  ['useme', /^(useme|gmail-.*useme|google-complete-useme)/],
  ['upwork', /^upwork/],
  ['olx', /^olx/],
  ['remoteok', /^remoteok/],
  ['youtube', /^(youtube|video-upload-to-youtube|reach\.youtube|grab-current-video)/],
  ['google', /^(google|gsc|seo|gmail|maps-|leadflow-maps|research\.(reviews|market|web)|client\.web|reach\.search)/],
  ['x', /^reach\.x$/],
  ['producthunt', /^reach\.producthunt$/],
  ['studio', /^(video-|capcut|gemini|learn\.shot)/],
  ['alquarium', /^alquarium/],
];

/** 'https://www.facebook.com/groups' → 'facebook'; 'news.ycombinator.com' → 'hackernews'; 'useme' → 'useme'. */
function normalizeSite(site) {
  const s = String(site || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  if (!s) return '';
  if (SITES[s]) return SITES[s];
  for (const [host, p] of Object.entries(SITES)) {
    if (s.endsWith(`.${host}`)) return p;
    if (s === host.split('.')[0]) return p;
  }
  const labels = s.split('.').filter(Boolean);
  return (labels.length >= 2 ? labels[labels.length - 2] : s).replace(/[^a-z0-9-]/g, '') || '';
}

/**
 * The platform a role works on. `record` may be handed in (the set builder has the role files
 * open already); otherwise the role registry answers, built-in or authored.
 */
function platformOf(roleName, record) {
  const name = String(roleName || 'general').trim().toLowerCase();
  if (!name || name === 'general') return BASE;
  const rec = record !== undefined ? record : roles.get(name);
  const own = rec && rec !== roles.ROLES.general ? rec : null;
  if (own && own.platform) return normalizeSite(own.platform) || BASE;
  if (own && own.site) { const p = normalizeSite(own.site); if (p) return p; }
  for (const [p, re] of RULES) if (re.test(name)) return p;
  return BASE;
}

/* ── scopes ─────────────────────────────────────────────────────────────────────────────────── */

function scope(level, name = '') {
  if (level === 'base' || !level) return { level: 'base', name: '', key: 'base' };
  const n = String(name || '').trim().toLowerCase();
  return { level, name: n, key: `${level}:${n}` };
}

/** 'platform:facebook' → the scope; anything unreadable → base. */
function parse(key) {
  if (key && typeof key === 'object') return scope(key.level, key.name);
  const s = String(key || '').trim().toLowerCase();
  if (!s || s === 'base') return scope('base');
  const m = /^(platform|role):(.+)$/.exec(s);
  return m ? scope(m[1], m[2]) : scope('base');
}

/** The scope a round of this scope chains from. Base has none. */
function parentOf(s) {
  const sc = parse(s);
  if (sc.level === 'role') {
    const p = platformOf(sc.name);
    return p === BASE ? scope('base') : scope('platform', p);
  }
  if (sc.level === 'platform') return scope('base');
  return null;
}

/** Most specific first: the role's own scope, its platform's, then base. general has only base. */
function chainOf(roleName) {
  const name = String(roleName || 'general').trim().toLowerCase();
  const out = [];
  if (name && name !== 'general') out.push(scope('role', name));
  const p = platformOf(name);
  if (p !== BASE) out.push(scope('platform', p));
  out.push(scope('base'));
  return out;
}

/** A short name for a tag or a file: 'base', 'facebook', 'facebook-thread-reply'. */
function slug(s) {
  const sc = parse(s);
  if (sc.level === 'base') return 'base';
  return sc.name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || sc.level;
}

/** 'the facebook platform', 'the facebook-thread-reply role', 'base'. */
function label(s) {
  const sc = parse(s);
  if (sc.level === 'base') return 'base';
  return `${sc.name} (${sc.level})`;
}

/* ── reading a set line without parsing it ───────────────────────────────────────────────────── */

/* The meta block sits after the messages, so the LAST "role" key on the line is meta.role. A
   quote inside message text is escaped on the wire, so a bare "role":" is always a key. */
function roleOfLine(line) {
  const s = String(line || '');
  const i = s.lastIndexOf('"role":"');
  if (i < 0) return 'general';
  const j = s.indexOf('"', i + 8);
  return j < 0 ? 'general' : s.slice(i + 8, j);
}

/** The platform written on the line by the builder, or derived from its role for an older set. */
function platformOfLine(line) {
  const s = String(line || '');
  const i = s.lastIndexOf('"platform":"');
  if (i >= 0) { const j = s.indexOf('"', i + 12); if (j > i) return s.slice(i + 12, j); }
  return platformOf(roleOfLine(s));
}

/** Does this line belong to the scope? Base takes every line. */
function matches(s, line) {
  const sc = parse(s);
  if (sc.level === 'base') return true;
  if (sc.level === 'platform') return platformOfLine(line) === sc.name;
  return roleOfLine(line).toLowerCase() === sc.name;
}

module.exports = { BASE, SITES, RULES, normalizeSite, platformOf, scope, parse, parentOf, chainOf, slug, label, roleOfLine, platformOfLine, matches };
