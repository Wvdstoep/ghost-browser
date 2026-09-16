/**
 * A WATCHER'S RESULT FEED — deduped, accumulating, handled-aware.
 *
 * A watcher fires every few minutes and collects the same still-present notifications again. A per-run
 * job.results list therefore piles up duplicates and forgets what the owner already dealt with. This
 * store fixes that: it keeps ONE list per watcher (its workflowId), keyed so the same person+post is a
 * single entry, remembers when it was first and last seen, ranks by urgency, and carries a `handled`
 * flag the UI sets when the owner acts on it — so re-runs surface only what is genuinely new.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'watcher-feed');
const fileFor = (wid) => path.join(DIR, String(wid || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');

function load(wid) {
  try { const d = JSON.parse(fs.readFileSync(fileFor(wid), 'utf8')); if (!d.items) d.items = {}; return d; } catch { return { items: {}, config: {} }; }
}
function persist(wid, data) {
  try { fs.mkdirSync(DIR, { recursive: true }); const t = fileFor(wid) + '.tmp'; fs.writeFileSync(t, JSON.stringify(data)); fs.renameSync(t, fileFor(wid)); } catch { /* best effort */ }
}

// Mention/reply/comment matter more than a like; used to rank the feed.
const URGENCY = { reply: 3, comment: 3, mention: 1, share: 1, reaction: 1, like: 1 };
const keyOf = (item) => (String(item.url || '').trim() + '|' + String(item.title || '').trim().toLowerCase()).slice(0, 400);
const typeOf = (item) => String((item.fields && (item.fields.type || item.fields.action)) || item.kind || '').toLowerCase();

/** Add or refresh one collected item. Returns { item, isNew }. A repeat only bumps lastSeen — it does
 *  NOT resurrect a handled entry, so acting on something makes it stay gone. */
function upsert(wid, item) {
  const data = load(wid);
  const k = keyOf(item);
  const now = Date.now();
  const existing = data.items[k];
  if (existing) {
    existing.lastSeen = now;
    existing.seenCount = (existing.seenCount || 1) + 1;
    // keep a fresher draft if one arrived and the owner has not acted yet
    if (!existing.handled && item.draft && !existing.draft) existing.draft = item.draft;
    persist(wid, data);
    return { item: existing, isNew: false };
  }
  const entry = {
    key: k, title: item.title || '', fields: item.fields || {}, url: item.url || '',
    image: item.image || '', kind: item.kind || '', draft: item.draft || '',
    urgency: URGENCY[typeOf(item)] || 1, firstSeen: now, lastSeen: now, seenCount: 1, handled: false,
  };
  data.items[k] = entry;
  persist(wid, data);
  return { item: entry, isNew: true };
}

/** The feed, unhandled first, then by urgency, then newest first. */
function list(wid) {
  const data = load(wid);
  return Object.values(data.items).sort((a, b) =>
    (Number(a.handled) - Number(b.handled))
    || (Number(!!b.draft) - Number(!!a.draft))
    || (b.urgency - a.urgency)
    || (b.firstSeen - a.firstSeen));
}

function markHandled(wid, key, handled = true) {
  const data = load(wid);
  if (!data.items[key]) return false;
  data.items[key].handled = !!handled;
  persist(wid, data);
  return true;
}

function counts(wid) {
  const items = list(wid);
  return { total: items.length, unhandled: items.filter((x) => !x.handled).length };
}

/** Merge arbitrary fields into one feed item (e.g. followedUp:true, draft:'...'). Generic. */
function mark(wid, key, patch) {
  const data = load(wid);
  if (!data.items[key]) return false;
  Object.assign(data.items[key], patch || {});
  persist(wid, data);
  return true;
}

/** Per-watcher follow-up config: { followUpFlowId, followUpKinds:[] }. Generic — any flow, any kinds. */
function getConfig(wid) { return load(wid).config || {}; }
function setConfig(wid, config) {
  const data = load(wid);
  data.config = Object.assign({}, data.config, config || {});
  persist(wid, data);
  return data.config;
}

module.exports = { upsert, list, markHandled, mark, counts, getConfig, setConfig, load };
