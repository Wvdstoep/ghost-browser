/*
 * platformMap.js — WHAT EACH PLATFORM LOOKS LIKE, WRITTEN DOWN FROM THE RUNS THAT WORKED.
 *
 * A model cannot know a page it has never seen, and a fact baked into weights is stale the day the
 * layout changes. So the corners of a platform — which addresses its work happens on, what was
 * pressed there and what was typed — are TEXT: built from the training set's sighted turns, kept
 * per platform, and put in the system message of every role on that platform, for the teacher and
 * the student alike (localPrompt.systemFor). Rebuilt with every set; editable by nobody, because
 * it is a measurement.
 *
 * What it records, per platform, from the turns that were kept (gold and silver runs only):
 *   pages     the addresses seen, with digits and long ids folded to *, most visited first
 *   pressed   on each page, the marks that were clicked — the mark's own words
 *   typed     on each page, the fields that were typed into
 *
 * Kept short on purpose: a system message is paid for on every step, so a platform gets at most
 * PAGES pages and a page at most MARKS marks. The map says where things ARE; the playbook says
 * what to do about them.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const platforms = require('./trainScopes');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'platform-map.json');

const PAGES = 8;
const MARKS = 6;
const TEXT_MAX = 900;

/* 'https://www.facebook.com/groups/123456/posts/98765?x=1' becomes facebook.com/groups/STAR/posts/STAR,
   with STAR the asterisk - the character cannot be written inside this comment. */
function pagePattern(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return '';
  u = u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '');
  const [host, ...parts] = u.split('/');
  const segs = parts.filter(Boolean).map((seg) => (/\d/.test(seg) || seg.length > 24 ? '*' : seg.toLowerCase())).slice(0, 4);
  return [host.toLowerCase(), ...segs].join('/');
}

/** The last address a turn's user message mentions — the page the decision was taken on. */
function urlOf(userText) {
  const s = String(userText || '');
  const on = [...s.matchAll(/You are on: (https?:\/\/[^\s"'\\]+)/g)];
  if (on.length) return on[on.length - 1][1];
  const any = [...s.matchAll(/https?:\/\/[^\s"'\\)]+/g)];
  return any.length ? any[any.length - 1][0] : '';
}

/** The words of mark [n] in the numbered list at the end of the user message. */
function markText(userText, n) {
  const s = String(userText || '');
  const re = new RegExp(`^\\[${Number(n)}\\]\\s*(.+)$`, 'm');
  const m = re.exec(s);
  if (!m) return '';
  return m[1].replace(/\s+/g, ' ').replace(/^(button|link|input|textbox|checkbox|combobox|menuitem|tab|option)\s+/i, '').replace(/^["“]|["”]$/g, '').trim().slice(0, 48);
}

/** One line of a set file into what the map keeps: platform, page, and the press or the typing. */
function noteOf(line) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  const msgs = (row && row.messages) || [];
  const user = msgs.find((m) => m.role === 'user');
  const asst = msgs.find((m) => m.role === 'assistant');
  if (!user || !asst) return null;
  let call;
  try { call = JSON.parse(asst.content); } catch { return null; }
  if (!call || !call.tool) return null;
  const page = pagePattern(urlOf(user.content));
  if (!page) return null;
  const platform = platforms.platformOfLine(line);
  const args = call.args || {};
  const out = { platform, page, pressed: '', typed: '' };
  if (call.tool === 'click' && args.index != null) out.pressed = markText(user.content, args.index);
  else if (call.tool === 'click_text' && args.text) out.pressed = String(args.text).slice(0, 48);
  else if (call.tool === 'type' && args.index != null) out.typed = markText(user.content, args.index);
  else if (call.tool === 'type' && args.selector) out.typed = String(args.selector).slice(0, 48);
  return out;
}

/** The map of every platform, from a set file. Sighted lines only — a blind turn saw no page. */
function build(file, { sightedOnly = true } = {}) {
  const map = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { builtAt: new Date().toISOString(), platforms: {} }; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (sightedOnly && !line.includes('"sighted":true')) continue;
    const n = noteOf(line);
    if (!n) continue;
    const p = map[n.platform] || (map[n.platform] = { turns: 0, pages: {} });
    p.turns++;
    const pg = p.pages[n.page] || (p.pages[n.page] = { seen: 0, pressed: {}, typed: {} });
    pg.seen++;
    if (n.pressed) pg.pressed[n.pressed] = (pg.pressed[n.pressed] || 0) + 1;
    if (n.typed) pg.typed[n.typed] = (pg.typed[n.typed] || 0) + 1;
  }
  return { builtAt: new Date().toISOString(), platforms: map };
}

const top = (obj, n) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n);

/** The text a system message carries for one platform, or '' when nothing is known. */
function textOf(map, platform) {
  const p = map && map.platforms && map.platforms[platform];
  if (!p || !p.turns) return '';
  const lines = [`PLATFORM NOTES (${platform}, from ${p.turns} recorded steps)`];
  for (const [page, pg] of top(Object.fromEntries(Object.entries(p.pages).map(([k, v]) => [k, v.seen])), PAGES)) {
    const info = p.pages[page];
    const pressed = top(info.pressed, MARKS).map(([t, c]) => `${t}${c > 1 ? ` ×${c}` : ''}`);
    const typed = top(info.typed, 3).map(([t]) => t);
    let line = `- ${page} (${pg} visits)`;
    if (pressed.length) line += ` — pressed: ${pressed.join(', ')}`;
    if (typed.length) line += ` — typed into: ${typed.join(', ')}`;
    lines.push(line);
  }
  let out = lines.join('\n');
  if (out.length > TEXT_MAX) out = `${out.slice(0, TEXT_MAX - 1)}…`;
  return out;
}

/* ── the stored map ──────────────────────────────────────────────────────────────────────────── */

let cache = { stamp: '', map: null };
function load() {
  let stamp = 'missing';
  try { const s = fs.statSync(FILE()); stamp = `${s.size}:${s.mtimeMs}`; } catch { /* none yet */ }
  if (cache.map && cache.stamp === stamp) return cache.map;
  let map = null;
  try { map = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { map = { builtAt: '', platforms: {} }; }
  cache = { stamp, map };
  return map;
}

/** Build from the set and write it down. */
function rebuild(file) {
  const map = build(file);
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(map));
    fs.renameSync(`${FILE()}.tmp`, FILE());
  } catch { /* the map is a courtesy; the next build tries again */ }
  cache = { stamp: '', map: null };
  return map;
}

/** The notes for a role's platform, from the stored map. */
function textFor(roleName) {
  const p = platforms.platformOf(roleName);
  if (p === platforms.BASE) return '';
  return textOf(load(), p);
}

/** For the screen: platforms, their page counts, when built. */
function state() {
  const m = load();
  return {
    builtAt: m.builtAt || '',
    platforms: Object.entries(m.platforms || {}).map(([name, p]) => ({ name, turns: p.turns, pages: Object.keys(p.pages || {}).length })).sort((a, b) => b.turns - a.turns),
  };
}

module.exports = { build, textOf, textFor, rebuild, load, state, noteOf, pagePattern, markText, urlOf, FILE, PAGES, MARKS };
