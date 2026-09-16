/**
 * POST WATCHER — the post is the source of truth, not the notification.
 *
 * A notification is a lossy summary ("Jordan and 4 others commented", in whichever language Facebook
 * feels like today): it cannot carry a conversation. So this watches the POST itself: open it, expand
 * every hidden reply, read the whole comment tree with its stable ids, and keep every branch under
 * the post as its own tracked conversation. Each person's new message gets its OWN draft, written
 * with the entire branch (and the post) as context, and the standing of each branch is known:
 * "waiting on you" / "answered" / "you". No model drives the browser here — the crawl is deterministic
 * (about a minute a post) and the drafting is a text call, so one pass covers every thread at once.
 *
 * Generic in shape: a tree of {id, parentId, author, text, when} nodes is what any threaded platform
 * produces; only crawl() knows Facebook's DOM.
 */
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const humanize = require('./humanize');

const DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'post-threads');

const VOICE = 'Plain words, short, like a real person typing on their phone. Contractions. 1-3 sentences unless the question truly needs more. '
  + 'Never open with "That\'s a solid/great/good ...", "Absolutely", "Great question", "Love this". No em dashes, no semicolons, no bullet lists, '
  + 'no sign-off, no hashtags, no emoji unless the thread is full of them. Starting lowercase is fine. Say one concrete thing from your own '
  + 'experience rather than a general observation. Never mention being an AI. Answer criticism thoughtfully, never defensively. No pitch.';

/* Controls that reveal more of the thread — in Dutch and English, and never the "Reply" control itself. */
const EXPAND = /^(?:(?:bekijk|view|show|see|toon)\s+)?(?:(?:all|alle|nog|more|meer)\s+)?\d*\s*(?:antwoorden?|repl(?:y|ies)|reacties?|opmerkingen|comments)(?:\s+(?:bekijken|weergeven|tonen))?$|^(?:meer|more)\s+(?:opmerkingen|comments|reacties)(?:\s+(?:weergeven|bekijken|laden|tonen))?$|^(?:vorige|previous|earlier)\s+(?:opmerkingen|comments|reacties)(?:\s+(?:weergeven|bekijken))?$|^(?:zie|see|show)\s+more$|^meer\s+weergeven$/i;
const SORT_BTN = /^(?:meest relevant|most relevant|nieuwste|newest|oudste|oldest)$/i;
const SORT_ALL = /^(?:alle opmerkingen|all comments|alle reacties)$/i;

/** Open the post on the given Playwright page, reveal the whole thread, and read it. */
async function crawl(page, url, log) {
  const { dismissConsent, settle } = require('./inspector');
  await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await dismissConsent(page); } catch { /* no banner is the normal case */ }
  try { await settle(page); } catch { /* may still be rendering */ }
  await page.waitForTimeout(1500);
  const clickMatching = async (re, limit) => {
    let n = 0;
    const handles = await page.$$('div[role="button"], span[role="button"], a[role="button"], [role="menuitem"]');
    for (const h of handles) {
      if (n >= limit) break;
      let t = ''; try { t = (await h.innerText()).trim().replace(/\s+/g, ' '); } catch { continue; }
      if (!re.test(t)) continue;
      try { await h.scrollIntoViewIfNeeded({ timeout: 2000 }); await h.click({ timeout: 4000 }); n++; await page.waitForTimeout(700); } catch { /* stale or covered — next */ }
    }
    return n;
  };
  // Show ALL comments (Facebook defaults to "most relevant", which hides some) — best effort.
  try { if (await clickMatching(SORT_BTN, 1)) { await page.waitForTimeout(800); await clickMatching(SORT_ALL, 1); await page.waitForTimeout(1500); } } catch { /* optional */ }
  // Reveal hidden replies / more comments / truncated text, round after round, until nothing is left.
  let total = 0;
  for (let round = 0; round < 14; round++) {
    const n = await clickMatching(EXPAND, 12);
    total += n;
    if (!n || total > 80) break;
    await page.waitForTimeout(1200);
  }
  if (log) log.info(`[post-watch] expanded ${total} control(s) on ${url}`);
  const tree = await page.evaluate(extractInPage);
  tree.url = String(url); tree.crawledAt = Date.now();
  return tree;
}

/* Runs INSIDE the page. Read-only. Facebook labels comment articles "Comment by X" / "Opmerking van X"
   and replies "Reply by X" / "Antwoord van X"; the timestamp link inside carries the stable ids. */
function extractInPage() {
  const q = (s, r) => Array.from((r || document).querySelectorAll(s));
  const label = (a) => a.getAttribute('aria-label') || '';
  const isC = (a) => /^(comment|opmerking|reply|antwoord)\b/i.test(label(a));
  const arts = q('[role="article"]').filter(isC);
  const nameOf = (a) => label(a).replace(/^(comment|opmerking|reply|antwoord)\s+(by|van|from|door)\s+/i, '').replace(/\s+\d+\s*(u|m|d|w|h|min|uur|dag|dagen|wk|week|weken|jaar|y|mo|mnd)\b.*$/i, '').trim();
  const ACTION = /^(vind ik leuk|like|leuk|beantwoorden|reply|delen|share|bewerken|edit|verbergen|hide|meer weergeven|see more|zie meer|geliked|verzenden|send|auteur|author|·|\d+\s*(u|m|d|w|j|h|min|uur|dag|dagen|wk|week|weken|jaar|y|mo|mnd)\.?|\d+)$/i;
  const nodes = arts.map((a, i) => {
    const inner = q('[role="article"]', a);
    const links = q('a[href*="comment_id="]', a).filter((l) => !inner.some((x) => x.contains(l)));
    const link = links[0] || null;
    let cid = null, rid = null; try { const u = new URL(link.href); cid = u.searchParams.get('comment_id'); rid = u.searchParams.get('reply_comment_id'); } catch (e) { /* no link */ }
    const isReply = /^(reply|antwoord)/i.test(label(a));
    const parentArt = a.parentElement && a.parentElement.closest('[role="article"]');
    const author = nameOf(a);
    const lines = q('div[dir="auto"], span[dir="auto"]', a).filter((d) => !inner.some((x) => x.contains(d)))
      .map((d) => (d.innerText || '').trim()).filter((t) => t && t !== author && !ACTION.test(t) && t.length > 1);
    const body = []; const seen = new Set();
    for (const t of lines) { if (seen.has(t)) continue; seen.add(t); if (lines.some((o) => o !== t && o.includes(t))) continue; body.push(t); }
    const when = link ? (link.innerText || '').trim() : '';
    return { i, id: rid || cid, cid, rid, isReply, author, text: body.join('\n').slice(0, 2000), when, parentIdx: parentArt ? arts.indexOf(parentArt) : -1 };
  });
  for (const n of nodes) { n.parentId = n.rid ? n.cid : (n.parentIdx >= 0 ? nodes[n.parentIdx].id : null); delete n.parentIdx; }
  const u = new URL(location.href);
  const postId = u.searchParams.get('post_id') || (location.pathname.match(/\/posts\/(\d+)/) || [])[1] || u.searchParams.get('story_fbid') || null;
  const group = (location.pathname.match(/\/groups\/([^/]+)/) || [])[1] || null;
  const msg = document.querySelector('[data-ad-preview="message"], [data-ad-rendering-role="story_message"]');
  const postArt = q('[role="article"]').find((a) => !isC(a));
  const postText = (msg ? msg.innerText : (postArt ? postArt.innerText : '')).trim().slice(0, 2500);
  const authorEl = postArt && postArt.querySelector('h2 a, h3 a, h4 a, strong a, [data-ad-rendering-role="profile_name"] a');
  const postAuthor = authorEl ? (authorEl.innerText || '').trim() : '';
  let me = ''; try { const p = document.querySelector('[aria-label="Je profiel"] img, [aria-label="Your profile"] img, [aria-label="Profiel"] img, [aria-label="Profile"] img'); me = p ? (p.getAttribute('alt') || '') : ''; } catch (e) { /* none */ }
  return { postId, group, postText, postAuthor, me, nodes: nodes.filter((n) => n.id && n.author) };
}

function store(tree) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, String(tree.postId || 'unknown').replace(/[^0-9a-zA-Z_-]/g, '_') + '.json'), JSON.stringify(tree)); } catch { /* best effort */ }
}

const deepLink = (tree, n) => `https://www.facebook.com/groups/${tree.group || 'x'}/?post_id=${tree.postId}&comment_id=${n.rid ? n.cid : n.id}${n.rid ? '&reply_comment_id=' + n.rid : ''}`;

/** Fold the tree into the watcher's feed: one item per message, keyed by its ids, with the standing
 *  of its branch. Returns the entries in branch order with what each one needs. */
function ingest(wid, tree, cfg, feed) {
  const me = String(cfg.meName || tree.me || tree.postAuthor || '').trim().toLowerCase();
  const isMe = (n) => !!me && String(n.author || '').trim().toLowerCase() === me;
  const byId = {}; tree.nodes.forEach((n) => { byId[n.id] = n; });
  const rootOf = (n) => { let cur = n, g = 0; while (cur.parentId && byId[cur.parentId] && g++ < 12) cur = byId[cur.parentId]; return cur.id; };
  const branches = {}; tree.nodes.forEach((n) => { const r = rootOf(n); (branches[r] = branches[r] || []).push(n); });
  const out = [];
  for (const [rootId, list] of Object.entries(branches)) {
    let lastMe = -1; list.forEach((n, i) => { if (isMe(n)) lastMe = i; });
    list.forEach((n, i) => {
      const parent = byId[n.parentId];
      const mine = isMe(n);
      const status = mine ? 'you' : (i > lastMe ? 'waiting on you' : 'answered');
      const title = mine ? 'you replied' : (n.isReply ? `${n.author} replied to ${parent ? (isMe(parent) ? 'you' : parent.author) : 'a comment'}` : `${n.author} commented on your post`);
      const fields = { type: n.isReply ? 'reply' : 'comment', author: n.author, said: n.text, when: n.when, status, postId: tree.postId, commentId: n.id, rootId, replyTo: parent ? parent.author : '' };
      const { item } = feed.upsert(wid, { title, fields, url: deepLink(tree, n), kind: n.isReply ? 'reply' : 'comment' });
      const patch = { fields: Object.assign({}, item.fields, fields), isMe: mine };
      if (mine || status === 'answered') patch.handled = true;    // nothing to do here, and it stays gone
      feed.mark(wid, item.key, patch);
      out.push({ node: n, key: item.key, rootId, branch: list, needsReply: !mine && status === 'waiting on you', isMe });
    });
  }
  return out;
}

/** Draft ONE dedicated reply per person waiting on the owner, with the post and the whole branch as
 *  context. Text-only: no browser, so every thread gets its draft in one pass. */
async function draftAll(wid, tree, entries, cfg, llmCfg, feed, log) {
  const maxAge = Number(cfg.maxAgeDays) || 7;
  const cap = Number(cfg.maxDraftsPerPass) || 8;
  const todo = entries.filter((e) => e.needsReply).filter((e) => {
    const it = feed.list(wid).find((x) => x.key === e.key);
    if (!it || it.handled || it.draft || it.draftChecked) return false;
    if (feed.ageDays(it) > maxAge) { feed.mark(wid, e.key, { draftChecked: true, tooOld: true }); return false; }
    return true;
  }).sort((a, b) => b.node.i - a.node.i).slice(0, cap);
  let made = 0;
  for (const e of todo) {
    const transcript = e.branch.map((n) => `${e.isMe(n) ? 'YOU' : n.author}: ${n.text}`).join('\n');
    const sys = `You draft replies for the owner of a Facebook post, written AS the owner in first person. ${VOICE} Output ONLY the reply text - no quotes, no preamble.`;
    const user = `YOUR POST:\n${tree.postText || '(no text captured)'}\n\nTHIS COMMENT THREAD, in order:\n${transcript}\n\nWrite ONE reply to ${e.node.author}'s last message: "${String(e.node.text).slice(0, 600)}". Speak to ${e.node.author} only, building on what was said in this thread. If it is just thanks or an emoji, one short warm line is enough.`;
    try {
      const out = await llm.chat({ host: llmCfg.llmHost, model: llmCfg.llmModel, key: llmCfg.llmKey, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] });
      const text = humanize((out && out.content) || '');
      if (text) { feed.mark(wid, e.key, { draft: text, draftJobId: '', draftPid: '', followedUp: true, draftedBy: 'post-watch' }); made++; }
      else feed.mark(wid, e.key, { draftChecked: true });
    } catch (err) { if (log) log.error(`[post-watch] draft for ${e.node.author}: ${err.message}`); }
  }
  return made;
}

/** Posts to watch = the configured list plus any post of the owner's that another watcher's feed
 *  (the notifications one) has seen activity on. Persisted back into the config, deduped by post id. */
function discover(wid, cfg, feed) {
  const urls = Array.isArray(cfg.postUrls) ? cfg.postUrls.slice() : [];
  const ids = new Set(urls.map((u) => postIdOf(u)).filter(Boolean));
  const from = cfg.discoverFrom || 'facebook-notifications-watcher';
  if (from && from !== wid) {
    for (const it of feed.list(from)) {
      if (!/(je bericht|your post|jouw bericht)/i.test(String(it.title || '') + ' ' + String((it.fields || {}).detail || ''))) continue;
      const pid = postIdOf(it.url); if (!pid || ids.has(pid)) continue;
      const group = (String(it.url).match(/\/groups\/([^/?]+)/) || [])[1]; if (!group) continue;
      ids.add(pid); urls.push(`https://www.facebook.com/groups/${group}/posts/${pid}/`);
    }
  }
  if (urls.length !== (cfg.postUrls || []).length) feed.setConfig(wid, { postUrls: urls });
  return urls;
}
function postIdOf(url) {
  try { const u = new URL(String(url)); return u.searchParams.get('post_id') || (u.pathname.match(/\/posts\/(\d+)/) || [])[1] || u.searchParams.get('story_fbid') || null; } catch { return null; }
}

module.exports = { crawl, store, ingest, draftAll, discover, postIdOf, VOICE };
