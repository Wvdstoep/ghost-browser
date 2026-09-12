'use strict';
/**
 * userSites.js — the sites the OWNER adds, the same way sites/index.js declares the ones we ship.
 *
 * WHY THIS EXISTS. sites/index.js is code: adding CapCut, Kling or an AI-studio meant an edit, a
 * build and a deploy. But a profile is not code — it is a name, a URL to sign in on, and the roles
 * that may work there. So the owner authors those here as DATA: give a login URL and (if any exist)
 * the roles to attach, and a new profile card appears, bound to its own isolated login, opening on
 * that URL. Everything downstream is unchanged, because sites/index.js MERGES these in — a user site
 * becomes a preset like any other: `POST /v1/sessions {preset:<key>}` sets it up and opens it, and
 * /v1/profiles/presets lists it. This file only stores; the merge and the flow are already built.
 *
 * Persisted on the profile volume so an authored site survives a restart, like profiles and jobs do.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.PROFILE_DIR || '/profiles';
const FILE = path.join(DIR, 'user-sites.json');

// The keys sites/index.js already owns. A user key that collides with one of these would be shadowed
// by the built-in (built-ins win in get()), so we never mint one — we suffix it until it is free.
const RESERVED = new Set(['facebook', 'linkedin', 'useme', 'upwork', 'google', 'reddit', 'hn', 'indiehackers']);

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** A bare host from anything the owner pastes — "capcut.com", "https://www.capcut.com/login" … */
function hostOf(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}

/** A full sign-in URL from anything the owner pastes. Missing scheme → https. */
function startOf(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function load() {
  try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

function persist(list) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 }); }
  catch { /* a list that cannot be written still works for this process */ }
}

/** A key that is a stable slug, unique across built-ins and everything already authored. */
function freeKey(label, site, existing) {
  const base = slug(label) || slug(site) || 'site';
  let key = base, n = 1;
  const taken = (k) => RESERVED.has(k) || existing.some((x) => x.key === k);
  while (taken(key)) key = base + (++n);
  return key;
}

/**
 * Author a new site. Needs a URL; a label and roles are optional. Returns the stored entry, or
 * throws with a plain message a form can show.
 */
function create({ label, url, roles } = {}) {
  const site = hostOf(url);
  const start = startOf(url);
  if (!site || !start) { const e = new Error('A valid site URL is required (e.g. capcut.com).'); e.status = 400; throw e; }
  const list = load();
  const name = String(label || '').trim() || site;
  const entry = {
    key: freeKey(name, site, list),
    label: name.slice(0, 60),
    site,
    start,
    roles: (Array.isArray(roles) ? roles : []).map((r) => String(r || '').trim()).filter(Boolean).slice(0, 40),
    defaults: { presentAs: 'windows', blockPasskeys: true, note: 'custom' },
    at: new Date().toISOString(),
  };
  list.push(entry);
  persist(list);
  return entry;
}

/** Change the roles attached to a site (the part most likely to change after it exists). */
function setRoles(key, roles) {
  const list = load();
  const i = list.findIndex((x) => x.key === key);
  if (i < 0) return null;
  list[i].roles = (Array.isArray(roles) ? roles : []).map((r) => String(r || '').trim()).filter(Boolean).slice(0, 40);
  persist(list);
  return list[i];
}

function get(key) { return load().find((x) => x.key === String(key || '')) || null; }
function list() { return load(); }

function remove(key) {
  const list = load();
  const next = list.filter((x) => x.key !== String(key || ''));
  if (next.length === list.length) return false;
  persist(next);
  return true;
}

module.exports = { create, setRoles, get, list, remove, FILE };
