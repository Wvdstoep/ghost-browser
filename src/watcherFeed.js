/**
 * A WATCHER'S RESULT FEED — deduped, accumulating, handled-aware.
 *
 * A watcher fires every few minutes and collects the same still-present notifications again. A per-run
 * job.results list therefore piles up duplicates and forgets what the owner already dealt with. This
 * store fixes that: it keeps ONE list per watcher (its workflowId), keyed so the same THREAD is a
 * single entry, remembers when it was first and last seen, ranks by urgency, and carries a `handled`
 * flag the UI sets when the owner acts on it — so re-runs surface only what is genuinely new.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'watcher-feed');
const fileFor = (wid) => path.join(DIR, String(wid || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');

/*
 * KEY VERSION 2 — a thread, not a notification title. Facebook renders the same notification in
 * English on one load and Dutch on the next ("Jordan Woods and 4 others commented" / "… en 4 anderen
 * …"), and re-issues it every time one more person joins in. Keyed on the title, that one thread
 * became several items and got several drafts. The ids in the URL name the exact post/comment/reply
 * and never change, so they are the key; the notification wrapper (notif_id, ref) is dropped.
 */
const KEY_VERSION = 2;
const ID_PARAMS = ['post_id', 'comment_id', 'reply_comment_id', 'story_fbid', 'fbid', 'id'];
function threadKeyOf(url) {
  let u; try { u = new URL(String(url || '')); } catch { return null; }
  const ids = [];
  const m = u.pathname.match(/\/posts\/(\d+)/); if (m) ids.push('posts=' + m[1]);
  for (const k of ID_PARAMS) { const v = u.searchParams.get(k); if (v) ids.push(k + '=' + v); }
  if (!ids.length) return null;
  return (u.host + '|' + ids.join('&')).slice(0, 400);
}
const keyOf = (item) => threadKeyOf(item.url) || (String(item.url || '').trim() + '|' + String(item.title || '').trim().toLowerCase()).slice(0, 400);

function load(wid) {
  let d;
  try { d = JSON.parse(fs.readFileSync(fileFor(wid), 'utf8')); } catch { return { items: {}, config: {}, keyVersion: KEY_VERSION }; }
  if (!d.items) d.items = {};
  if (d.keyVersion !== KEY_VERSION) { rekey(d); d.keyVersion = KEY_VERSION; persist(wid, d); }
  return d;
}
function persist(wid, data) {
  try { fs.mkdirSync(DIR, { recursive: true }); const t = fileFor(wid) + '.tmp'; fs.writeFileSync(t, JSON.stringify(data)); fs.renameSync(t, fileFor(wid)); } catch { /* best effort */ }
}
/** One-time migration to thread keys: entries that turn out to be one thread are merged — the one
 *  holding a draft wins, seen-counts add up, handled sticks. */
function rekey(d) {
  const out = {};
  for (const it of Object.values(d.items)) {
    const k = keyOf(it); it.key = k;
    const ex = out[k];
    if (!ex) { out[k] = it; continue; }
    const keep = (it.draft && !ex.draft) ? it : ex; const drop = keep === it ? ex : it;
    keep.firstSeen = Math.min(keep.firstSeen || Date.now(), drop.firstSeen || Date.now());
    keep.lastSeen = Math.max(keep.lastSeen || 0, drop.lastSeen || 0);
    keep.seenCount = (keep.seenCount || 1) + (drop.seenCount || 1);
    keep.handled = !!(keep.handled || drop.handled);
    keep.urgency = Math.max(keep.urgency || 1, drop.urgency || 1);
    out[k] = keep;
  }
  d.items = out;
}

// Mention/reply/comment matter more than a like; used to rank the feed.
const URGENCY = { reply: 3, comment: 3, mention: 1, share: 1, reaction: 1, like: 1 };
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
    // the same thread seen again as something more urgent (a mention that became a reply) ranks up
    existing.urgency = Math.max(existing.urgency || 1, URGENCY[typeOf(item)] || 1);
    if (!existing.kind) existing.kind = item.kind || typeOf(item) || '';
    // keep a fresher draft if one arrived and the owner has not acted yet
    if (!existing.handled && item.draft && !existing.draft) existing.draft = item.draft;
    persist(wid, data);
    return { item: existing, isNew: false };
  }
  const entry = {
    key: k, title: item.title || '', fields: item.fields || {}, url: item.url || '',
    image: item.image || '', kind: item.kind || typeOf(item) || '', draft: item.draft || '',
    urgency: URGENCY[typeOf(item)] || 1, firstSeen: now, lastSeen: now, seenCount: 1, handled: false,
  };
  data.items[k] = entry;
  persist(wid, data);
  return { item: entry, isNew: true };
}

/** The feed, unhandled first, then drafts, then by urgency, then newest first. */
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

/** Per-watcher follow-up config: { followUpFlowId, followUpKinds:[], maxAgeDays }. Generic — any flow, any kinds. */
function getConfig(wid) { return load(wid).config || {}; }
function setConfig(wid, config) {
  const data = load(wid);
  data.config = Object.assign({}, data.config, config || {});
  persist(wid, data);
  return data.config;
}

/** How old the thing is, in days — from the collected "when" text ("11 u", "3 d", "1 w", "2 mnd") when
 *  there is one, else from when the watcher first saw it. */
function ageDays(item) {
  const w = String((item.fields && (item.fields.when || item.fields.age)) || '').toLowerCase();
  const m = w.match(/(\d+)\s*(mnd|maand|month|mo|min|uur|hour|hr|dag|day|week|wk|jaar|year|yr|u|h|m|d|w|j|y)\b/);
  if (m) {
    const n = Number(m[1]); const u = m[2];
    if (/^(mnd|maand|month|mo)$/.test(u)) return n * 30;
    if (/^(min|m)$/.test(u)) return n / 1440;
    if (/^(uur|hour|hr|u|h)$/.test(u)) return n / 24;
    if (/^(dag|day|d)$/.test(u)) return n;
    if (/^(week|wk|w)$/.test(u)) return n * 7;
    if (/^(jaar|year|yr|j|y)$/.test(u)) return n * 365;
  }
  return item.firstSeen ? (Date.now() - item.firstSeen) / 86400000 : 0;
}

/** Where an item stands, as one word the UI can show as a chip. */
function stateOf(it) {
  if (it.handled) return 'handled';
  if (it.posting) return 'posting';
  if (it.postFailed) return 'post-failed';
  if (it.draft) return 'drafted';
  if (it.draftChecked) return it.tooOld ? 'skipped-old' : 'none';
  if (it.followedUp && it.draftRunId) return 'drafting';
  return '';
}

module.exports = { upsert, list, markHandled, mark, counts, getConfig, setConfig, load, ageDays, stateOf, threadKeyOf };
