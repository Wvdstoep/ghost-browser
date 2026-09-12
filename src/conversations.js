'use strict';
/**
 * conversations.js — the list of conversations the owner has DELIBERATELY started.
 *
 * This is the seam that connects two automations without a webhook: Flow 1 (start a chat) adds a
 * person here the moment the owner approves and SENDS an opener; Flow 2 (reply watcher) reads this
 * list and answers ONLY the people on it. A stranger who messages out of the blue is not on the list,
 * so the watcher leaves them alone — the owner chose who they are talking to, once, by approving the
 * first message, and everything after that stays inside those chosen threads.
 *
 * Deliberately its own tiny store (not the LeadFlow pipeline, which workflow runs are not wired to),
 * persisted on the profile volume so it survives a restart like profiles and jobs do.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.PROFILE_DIR || '/profiles';
const FILE = path.join(DIR, 'managed-conversations.json');

const norm = (s) => String(s || '').trim().toLowerCase();

function load() {
  try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

function persist(list) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 }); }
  catch { /* a list that cannot be written still works for this process */ }
}

/** Mark a conversation as one the owner manages. Deduped by thread link, else by name. */
function remember({ name, threadUrl } = {}) {
  const list = load();
  const nm = String(name || '').slice(0, 200);
  const url = String(threadUrl || '').slice(0, 500);
  if (!nm && !url) return list;                 // nothing to key on
  const i = list.findIndex((x) => (url && norm(x.threadUrl) === norm(url)) || (!url && nm && norm(x.name) === norm(nm)));
  const rec = { name: nm, threadUrl: url, at: new Date().toISOString() };
  if (i >= 0) list[i] = { ...list[i], ...rec }; else list.push(rec);
  persist(list);
  return list;
}

/** Everyone the owner is managing a conversation with. */
function all() { return load(); }

/** Is this incoming message from one of them? Matched on thread link first, then name. */
function isManaged({ name, threadUrl } = {}) {
  const list = load();
  return list.some((x) => (threadUrl && norm(x.threadUrl) === norm(threadUrl)) || (name && norm(x.name) === norm(name)));
}

module.exports = { remember, all, isManaged, FILE };
