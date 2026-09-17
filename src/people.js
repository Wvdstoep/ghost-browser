/**
 * PEOPLE — the memory per person across posts, and what the owner's edits teach (roadmap Phase 3).
 *
 * Every pass, the branches the crawl read become EXCHANGES on a person's record: what they said to the
 * owner, what the owner answered, on which post, when. From those, three things a drafter needs and a
 * seller wants: PROMISES the owner made ("I'll put together a walkthrough"), ASKS the person raised,
 * and COMMERCIAL SIGNALS ("what does it cost?", "can you build this for us?"). A person with a
 * signal is a LEAD — the front door of the Facebook channel, with the whole history attached.
 *
 * OUTCOMES: when the owner approves a draft, what they posted is compared with what was drafted.
 * Posted as-is / lightly edited / rewritten is counted per person and overall, and the last rewrites
 * are kept as lessons the drafter reads ("the owner always deletes this kind of opener").
 *
 * Files: /profiles/people/<platform>/<slug>.json, /profiles/people/outcomes.json. No model calls here.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'people');
const MAX_EXCHANGES = 40;
const MAX_LESSONS = 6;

const slug = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unknown';
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const PROMISE = /\b(i'?ll|i will|will (send|share|put together|write|dm|message)|let me (send|share|put together|write)|i can (send|share)|going to (send|share|write))\b/i;
const ASK = /\?|\b(how do|how did|what do you|which|could you|can you|would you|any tips|recommend)\b/i;
const COMMERCIAL = /\b(price|pricing|cost|how much|quote|invoice|hire|hiring|build (this|it|one) for|can you build|for us|for our|demo|trial|subscription|budget|pay|paid|buy|purchase|partner|collab|work together|dm me|send me (a|the) link)\b/i;

function file(platform, name) { return path.join(DIR, slug(platform), slug(name) + '.json'); }
function load(platform, name) { try { return JSON.parse(fs.readFileSync(file(platform, name), 'utf8')); } catch { return null; } }
function save(rec) { const f = file(rec.platform, rec.name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(rec)); fs.renameSync(f + '.tmp', f); return rec; }
function blank(platform, name, now) { return { name: norm(name), platform: slug(platform), firstSeen: now, lastSeen: now, posts: {}, exchanges: [], promises: [], asks: [], signals: [], outcomes: { drafted: 0, asIs: 0, edited: 0, rewritten: 0 } }; }

/**
 * Learn from a pass: `tree` is the crawled post ({postId, postText, nodes}), `entries` what ingest
 * produced ({node, branch, isMe, needsReply}). Only people the owner actually talks with are
 * remembered: the addressed ones, and anyone the owner replied to. Returns the names touched.
 */
function remember(platform, tree, entries, { now = Date.now(), urlOf = () => '' } = {}) {
  const touched = new Set();
  const postId = String((tree && tree.postId) || ''); const postTitle = norm(tree && tree.postText).slice(0, 90);
  const recs = new Map(); const get = (name) => { const k = slug(name); if (!recs.has(k)) recs.set(k, load(platform, name) || blank(platform, name, now)); return recs.get(k); };
  const seenIn = (rec, id) => rec.exchanges.some((x) => x.id === id);
  /* SOMEONE ELSE'S POST: the post's author is a person the owner talks with — their POST is the first
     exchange on their record, and the owner's root comment under it is "you → them". */
  const postAuthor = norm(tree && tree.postAuthor);
  const anyMe = (entries || []).find((e) => e && typeof e.isMe === 'function');
  const theirs = !!postAuthor && !!anyMe && !anyMe.isMe({ author: postAuthor }) && (entries || []).some((e) => e.node && (typeof e.isMe === 'function' ? e.isMe(e.node) : e.isMe));
  if (theirs && (tree.postText || '')) {
    const rec = get(postAuthor); const pid = 'post:' + postId;
    if (!seenIn(rec, pid)) rec.exchanges.push({ id: pid, t: now, who: 'them', kind: 'post', text: norm(tree.postText).slice(0, 400), postId, when: '' });
    rec.posts[postId] = { title: postTitle, lastAt: now, theirs: true }; rec.lastSeen = now; touched.add(rec.name);
  }
  for (const e of entries || []) {
    const n = e.node; if (!n || !n.author) continue;
    const isMe = typeof e.isMe === 'function' ? e.isMe : () => !!e.isMe;
    if (isMe(n)) {
      // the owner's reply: goes on the record of the person it answers (a root comment on their post: the author)
      const to = n.replyTo || (theirs && !n.isReply ? postAuthor : '') || ((e.branch || [])[0] && (e.branch || [])[0].author) || ''; if (!to || isMe({ author: to })) continue;
      const rec = get(to); if (!seenIn(rec, n.id)) {
        rec.exchanges.push({ id: n.id, t: now, who: 'you', text: norm(n.text).slice(0, 400), postId, when: n.when || '' });
        if (PROMISE.test(n.text || '')) { const p = norm(n.text).slice(0, 200); if (!rec.promises.some((x) => x.text === p)) rec.promises.push({ text: p, t: now, postId }); }
      }
      rec.posts[postId] = { ...(rec.posts[postId] || {}), title: postTitle, lastAt: now }; rec.lastSeen = now; touched.add(rec.name);
      continue;
    }
    // them: only when they were talking to the owner (root comment, reply to the owner, mention)
    const addressed = e.needsReply || (e.branch || []).some((m) => isMe(m)) || !n.isReply;
    if (!addressed) continue;
    const rec = get(n.author);
    if (!seenIn(rec, n.id)) {
      rec.exchanges.push({ id: n.id, t: now, who: 'them', text: norm(n.text).slice(0, 400), postId, when: n.when || '', url: urlOf(n) || '' });
      // they came BACK after an answer of the owner's in this branch: the conversation is alive — that is the
      // outcome a reply is for, and what the "worth your words" score is made of
      const idx = (e.branch || []).indexOf(n); const answeredBefore = idx > 0 && (e.branch || []).slice(0, idx).some((m) => isMe(m));
      if (answeredBefore) { rec.outcomes = rec.outcomes || { drafted: 0, asIs: 0, edited: 0, rewritten: 0 }; rec.outcomes.repliedBack = (rec.outcomes.repliedBack || 0) + 1; }
      const txt = norm(n.text);
      if (txt && ASK.test(txt)) { const a = txt.slice(0, 200); if (!rec.asks.some((x) => x.text === a)) rec.asks.push({ text: a, t: now, postId }); }
      if (txt && COMMERCIAL.test(txt)) { const sgl = txt.slice(0, 200); if (!rec.signals.some((x) => x.text === sgl)) rec.signals.push({ text: sgl, t: now, postId, url: urlOf(n) || '' }); }
    }
    rec.posts[postId] = { ...(rec.posts[postId] || {}), title: postTitle, lastAt: now }; rec.lastSeen = now; touched.add(rec.name);
  }
  for (const rec of recs.values()) {
    rec.exchanges.sort((a, b) => a.t - b.t || String(a.when).localeCompare(String(b.when)));
    if (rec.exchanges.length > MAX_EXCHANGES) rec.exchanges.splice(0, rec.exchanges.length - MAX_EXCHANGES);
    rec.promises = rec.promises.slice(-8); rec.asks = rec.asks.slice(-8); rec.signals = rec.signals.slice(-8);
    save(rec);
  }
  return [...touched];
}

/** What the drafter reads before writing to this person — nothing when there is no history yet. */
function profileOf(platform, name, { exceptPostId = '' } = {}) {
  const rec = load(platform, name); if (!rec) return '';
  const posts = Object.entries(rec.posts).filter(([id]) => id !== String(exceptPostId));
  const earlier = rec.exchanges.filter((x) => x.postId !== String(exceptPostId)).slice(-6);
  const lines = [];
  lines.push(`PERSON MEMORY — ${rec.name}: ${rec.exchanges.length} exchange(s) with you across ${Object.keys(rec.posts).length} post(s).`);
  if (posts.length) lines.push(`Earlier posts they engaged on: ${posts.map(([, p]) => `"${p.title}"`).slice(-3).join(', ')}.`);
  if (earlier.length) lines.push('Earlier exchanges (oldest first):\n' + earlier.map((x) => `  ${x.who === 'you' ? 'YOU' : rec.name}${x.kind === 'post' ? ' POSTED' : ''}: ${x.text.slice(0, 160)}`).join('\n'));
  if (rec.promises.length) lines.push(`You promised them: ${rec.promises.slice(-3).map((p) => `"${p.text.slice(0, 120)}"`).join('; ')} — honour or reference it, never re-promise.`);
  if (rec.asks.length) lines.push(`They asked before: ${rec.asks.slice(-3).map((a) => `"${a.text.slice(0, 100)}"`).join('; ')}.`);
  if (rec.signals.length) lines.push(`COMMERCIAL SIGNAL — they showed buying interest: ${rec.signals.slice(-2).map((s) => `"${s.text.slice(0, 120)}"`).join('; ')}. Answer helpfully and leave the door open; do not pitch.`);
  return lines.join('\n');
}

/* ── outcomes ── */
const OUT = path.join(DIR, 'outcomes.json');
function loadOutcomes() { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return { drafted: 0, asIs: 0, edited: 0, rewritten: 0, lessons: [] }; } }
function similarity(a, b) {
  const A = norm(a).toLowerCase(), B = norm(b).toLowerCase(); if (!A || !B) return 0; if (A === B) return 1;
  const wa = A.split(' '), wb = new Set(B.split(' ')); const common = wa.filter((w) => wb.has(w)).length;
  return common / Math.max(wa.length, wb.size);
}
/** The owner approved: what they posted vs what was drafted. as-is ≥ 0.97, edited ≥ 0.6, rewritten below. */
function recordOutcome(platform, name, { draft, posted }, now = Date.now()) {
  const sim = similarity(draft, posted);
  const kind = sim >= 0.97 ? 'asIs' : sim >= 0.6 ? 'edited' : 'rewritten';
  const o = loadOutcomes(); o.drafted++; o[kind]++;
  if (kind !== 'asIs' && draft && posted) { o.lessons.push({ t: now, draft: norm(draft).slice(0, 300), posted: norm(posted).slice(0, 300), kind }); o.lessons = o.lessons.slice(-MAX_LESSONS); }
  fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(o));
  if (name) { const rec = load(platform, name) || blank(platform, name, now); rec.outcomes = rec.outcomes || { drafted: 0, asIs: 0, edited: 0, rewritten: 0 }; rec.outcomes.drafted++; rec.outcomes[kind]++; save(rec); }
  return { kind, similarity: Number(sim.toFixed(2)) };
}
/** What the drafter reads about the owner's edits — the last rewrites as before/after. */
function editLessons() {
  const o = loadOutcomes(); if (!o.lessons.length) return '';
  return 'WHAT THE OWNER CHANGES IN DRAFTS — recent before → after; write like the AFTER, never like the BEFORE:\n'
    + o.lessons.slice(-3).map((l) => `  drafted: "${l.draft.slice(0, 160)}"\n  posted:  "${l.posted.slice(0, 160)}"`).join('\n');
}
function outcomes() { const o = loadOutcomes(); const rate = o.drafted ? Math.round((o.asIs / o.drafted) * 100) : null; return { ...o, asIsRate: rate }; }

/** "WORTH YOUR WORDS", 0–100: buying interest weighs most, a person who comes back after your answer next,
 *  then how much has been asked and exchanged. The queue can sort by it; the drafter can skip the dead ends. */
function worthOf(rec) {
  if (!rec) return 0;
  const o = rec.outcomes || {}; const back = Number(o.repliedBack) || 0;
  const score = (rec.signals && rec.signals.length ? 45 : 0) + Math.min(3, back) * 12 + Math.min(4, (rec.asks || []).length) * 4 + Math.min(6, (rec.exchanges || []).length) * 1.5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ── lists ── */
function list(platform, { leadsOnly = false } = {}) {
  const dir = path.join(DIR, slug(platform)); let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean)
    .filter((r) => !leadsOnly || (r.signals && r.signals.length))
    .map((r) => ({ name: r.name, platform: r.platform, exchanges: r.exchanges.length, posts: Object.keys(r.posts).length, lastSeen: r.lastSeen, lead: !!(r.signals && r.signals.length), worth: worthOf(r), repliedBack: (r.outcomes && r.outcomes.repliedBack) || 0, signals: (r.signals || []).slice(-2).map((s) => s.text), promises: (r.promises || []).slice(-2).map((p) => p.text), outcomes: r.outcomes }))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}
function isLead(platform, name) { const r = load(platform, name); return !!(r && r.signals && r.signals.length); }

module.exports = { remember, profileOf, recordOutcome, editLessons, outcomes, list, load, isLead, worthOf, slug, DIR, COMMERCIAL, PROMISE };
