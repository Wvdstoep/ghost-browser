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

/**
 * Open the post, then EVERY root comment's own page. The post page lazy-renders replies: after every
 * visible "N antwoorden bekijken" was clicked, Adam's and Mike's comments still showed no reply and no
 * control at all — while the same comments' deep links showed the owner's reply at once. So the post
 * page only gives the list of root comments; each branch is read from its comment link, complete.
 */
async function crawl(getPage, url, log, touch) {
  /* The pool reaps a session it thinks is idle, and a crawl that drives the page directly never
     looked busy to it - halfway through the branches the browser was simply gone ("Target page,
     context or browser has been closed"). So: touch the session on every step, and take the page
     afresh for every branch (getPage re-acquires the profile if it was closed). */
  const tree = await openAndRead(await getPage(), url, log, true, touch);
  const byId = new Map(); tree.nodes.forEach((n) => byId.set(n.id, n));
  const roots = tree.nodes.filter((n) => !n.isReply).slice(0, 40);
  for (const root of roots) {
    const link = `https://www.facebook.com/groups/${tree.group || 'x'}/posts/${tree.postId}/?comment_id=${root.id}`;
    try {
      const take = (sub) => { for (const n of sub.nodes) {
        if (n.id !== root.id && n.cid !== root.id) continue;          // only this branch
        n.i = root.i + (n.isReply ? (n.i + 1) / 10000 : 0);             // stays right after its root, in order
        byId.set(n.id, n);
      } };
      take(await openAndRead(await getPage(), link, null, false, touch));
      /* A reply TO a reply is not rendered on the root comment's page (the owner's "haha fair" under
         Joe, "Just checked the link" under Peter were invisible there) - the latest reply's own deep
         link renders the whole sub-thread. One more page for each branch that has replies. */
      const replies = [...byId.values()].filter((n) => n.isReply && n.cid === root.id).sort((a, b) => b.i - a.i);
      if (replies.length) take(await openAndRead(await getPage(), `${link}&reply_comment_id=${replies[0].id}`, null, false, touch));
    } catch (e) { if (log) log.error(`[post-watch] branch of ${root.author}: ${e.message}`); }
  }
  tree.nodes = [...byId.values()].sort((a, b) => a.i - b.i);
  tree.url = String(url); tree.crawledAt = Date.now();
  if (log) log.info(`[post-watch] ${roots.length} root comment(s) read from their own pages → ${tree.nodes.length} messages`);
  return tree;
}

/** One page: land on it (proving the post is there), optionally sort to all comments, reveal what is
 *  hidden, read the comment articles. */
async function openAndRead(page, url, log, sortAll, touch) {
  const { dismissConsent, settle } = require('./inspector');
  const pid = postIdOf(url);
  const alive = () => { try { if (touch) touch(); } catch { /* best effort */ } };
  alive();
  // Land on the post and PROVE it before reading: another walk on this profile can navigate the
  // session away mid-crawl, and a crawl of the wrong page reads "0 messages", which is worse than
  // an error. If the post's comments are not on screen, try once more from the top.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { await dismissConsent(page); } catch { /* no banner is the normal case */ }
    try { await settle(page); } catch { /* may still be rendering */ }
    await page.waitForTimeout(2500);
    const onPost = await page.evaluate((id) => {
      const here = location.href.includes(id) || !!document.querySelector(`a[href*="${id}"]`);
      return here && document.querySelectorAll('[role="article"]').length > 0;
    }, pid || '').catch(() => false);
    if (onPost) break;
    if (log) log.info(`[post-watch] not on the post yet (${page.url().slice(0, 80)}) — retrying`);
    await page.waitForTimeout(4000);
  }
  const { candidates, press } = helpers(page);
  // Show ALL comments (Facebook defaults to "most relevant", which hides some) — best effort.
  try { const sb = sortAll ? await candidates(SORT_BTN) : []; if (sb[0] && await press(sb[0])) { await page.waitForTimeout(900); const sa = await candidates(SORT_ALL); if (sa[0]) { await press(sa[0]); await page.waitForTimeout(1500); } } } catch { /* optional */ }
  /* Reveal every hidden reply / more comments / truncated text. ONE click per round, then re-query:
     Facebook re-renders the whole list after each expand, so handles from before the click are stale
     and a stale-handle failure used to read as "nothing left" — the crawl quit after ~9 expands with
     "1 antwoord bekijken" still closed under the owner's own replies. If a click does not shrink the
     set (a control that stays), move to the next candidate; stop when none remain. */
  const ex = await expandAll(page, candidates, press, alive);
  if (log) log.info(`[post-watch] expanded ${ex.clicks} control(s) on ${url}${ex.remaining.length ? ` — still closed: ${ex.remaining.slice(0, 6).join(' / ')}` : ''}`);
  const tree = await page.evaluate(extractInPage);
  tree.url = String(url); tree.crawledAt = Date.now(); tree.expand = ex;
  return tree;
}

/** Button finding + a real click with a fallback, shared by the crawl and the probe. */
function helpers(page) {
  const candidates = async (re) => {
    const out = [];
    for (const h of await page.$$('div[role="button"], span[role="button"], a[role="button"], [role="menuitem"]')) {
      let t = ''; try { t = (await h.innerText()).trim().replace(/\s+/g, ' '); } catch { continue; }
      if (re.test(t)) out.push(h);
    }
    return out;
  };
  const press = async (h) => {
    try { await h.evaluate((el) => el.scrollIntoView({ block: 'center' })); await page.waitForTimeout(250); await h.click({ timeout: 3000 }); return true; }
    catch { try { await h.dispatchEvent('click'); return true; } catch { return false; } }
  };
  return { candidates, press };
}

/** The expansion loop, with a record of what it did — the probe reports it. */
async function expandAll(page, candidates, press, touch) {
  let clicks = 0, lastCount = -1, skip = 0; const clicked = [];
  for (let round = 0; round < 60 && clicks < 120; round++) {
    try { if (touch) touch(); } catch { /* best effort */ }
    const cand = await candidates(EXPAND);
    if (!cand.length) break;
    if (cand.length === lastCount) skip++; else skip = 0;
    if (skip >= cand.length) break;
    lastCount = cand.length;
    let t = ''; try { t = (await cand[skip].innerText()).trim().replace(/\s+/g, ' '); } catch { /* gone */ }
    let vis = false; try { vis = await cand[skip].evaluate((el) => el.getClientRects().length > 0); } catch { /* gone */ }
    const ok = await press(cand[skip]);
    if (ok) clicks++;
    clicked.push(`${ok ? '+' : 'x'}${vis ? '' : '(hidden)'} ${t} [${cand.length}]`);
    await page.waitForTimeout(1000);
  }
  let remaining = []; try { remaining = []; for (const h of await candidates(EXPAND)) { try { remaining.push((await h.innerText()).trim().replace(/\s+/g, ' ')); } catch { /* gone */ } } } catch { /* none */ }
  return { clicks, clicked, remaining };
}

/* Runs INSIDE the page. Read-only. Facebook labels comment articles "Comment by X" / "Opmerking van X"
   and replies "Reply by X" / "Antwoord van X"; the timestamp link inside carries the stable ids. */
function extractInPage() {
  const q = (s, r) => Array.from((r || document).querySelectorAll(s));
  const label = (a) => a.getAttribute('aria-label') || '';
  const isC = (a) => /^(comment|opmerking|reply|antwoord)\b/i.test(label(a));
  const shown = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]');
  // visible only: Facebook keeps a hidden second copy of the thread, which doubled every root comment
  const arts = q('[role="article"]').filter((a) => isC(a) && shown(a));
  /* The label is "Opmerking van <Name> een dag geleden" or "Antwoord van <Name> op het antwoord van
     <Other> ongeveer een uur geleden" (EN: "Comment by <Name> 2 hours ago", "Reply by <Name> on the
     reply by <Other>"). It names the author AND who they answered - the reply target is more exact
     than DOM nesting, since Facebook flattens replies under the root comment. */
  const AGO = /\s+(?:ongeveer\s+|about\s+|over\s+)?(?:een|one|an?|\d+)\s+(?:seconde|second|minuut|minute|min|uur|hour|hr|dag|day|week|wk|maand|month|jaar|year)\w*\s+(?:geleden|ago)\b.*$/i;
  const parts = (a) => {
    const s = label(a).replace(/^(comment|opmerking|reply|antwoord)\s+(by|van|from|door)\s+/i, '').replace(AGO, '').trim();
    const m = s.match(/^(.*?)\s+(?:op (?:het antwoord|de opmerking|een opmerking) van|on (?:the |a )?(?:reply|comment) (?:by|from|of))\s+(.+)$/i);
    return m ? { author: m[1].trim(), replyTo: m[2].trim() } : { author: s, replyTo: '' };
  };
  const ACTION = /^(vind ik leuk|like|leuk|beantwoorden|reply|delen|share|bewerken|edit|verbergen|hide|meer weergeven|see more|zie meer|geliked|verzenden|send|auteur|author|volgen|follow|topbijdrager|top contributor|beheerder|admin|moderator|nieuw lid|new member|groepsexpert|group expert|·|\d+\s*(u|m|d|w|j|h|min|uur|dag|dagen|wk|week|weken|jaar|y|mo|mnd)\.?|\d+)$/i;
  const nodes = arts.map((a, i) => {
    const inner = q('[role="article"]', a);
    const links = q('a[href*="comment_id="]', a).filter((l) => !inner.some((x) => x.contains(l)));
    const link = links[0] || null;
    let cid = null, rid = null; try { const u = new URL(link.href); cid = u.searchParams.get('comment_id'); rid = u.searchParams.get('reply_comment_id'); } catch (e) { /* no link */ }
    const isReply = /^(reply|antwoord)/i.test(label(a));
    const parentArt = a.parentElement && a.parentElement.closest('[role="article"]');
    const { author, replyTo } = parts(a);
    const lines = q('div[dir="auto"], span[dir="auto"]', a).filter((d) => !inner.some((x) => x.contains(d)))
      .map((d) => (d.innerText || '').trim()).filter((t) => t && t !== author && t !== replyTo && !ACTION.test(t) && t.length > 1);
    const body = []; const seen = new Set();
    for (const t of lines) { if (seen.has(t)) continue; seen.add(t); if (lines.some((o) => o !== t && o.includes(t))) continue; body.push(t); }
    let text = body.join('\n');
    if (text.startsWith(author + '\n')) text = text.slice(author.length + 1);          // the name line
    if (replyTo && text.startsWith(replyTo + ' ')) text = text.slice(replyTo.length + 1); // the @mention prefix
    const when = link ? (link.innerText || '').trim() : '';
    // Did the owner already react to this one? The Like control reads "Verwijder Leuk" / "Remove Like"
    // (or is aria-pressed) once it is yours - the owner's usual way of acknowledging without words.
    const reactedByMe = q('[role="button"]', a).filter((b) => !inner.some((x) => x.contains(b))).some((b) => {
      const l = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).toLowerCase();
      return (/verwijder|remove|unlike|ongedaan/.test(l) && /leuk|like|reactie|reaction/.test(l)) || (b.getAttribute('aria-pressed') === 'true' && /leuk|like/.test(l));
    });
    return { i, id: rid || cid, cid, rid, isReply, author, replyTo, reactedByMe, text: text.trim().slice(0, 2000), when, parentIdx: parentArt ? arts.indexOf(parentArt) : -1 };
  });
  for (const n of nodes) { n.parentId = n.rid ? n.cid : (n.parentIdx >= 0 ? nodes[n.parentIdx].id : null); delete n.parentIdx; }
  // one node per id, whichever copy carries the words
  const byIdOnce = new Map(); for (const n of nodes) { if (!n.id) continue; const ex = byIdOnce.get(n.id); if (!ex || (n.text || '').length > (ex.text || '').length) byIdOnce.set(n.id, n); }
  const uniq = [...byIdOnce.values()].sort((a, b) => a.i - b.i);
  const u = new URL(location.href);
  const postId = u.searchParams.get('post_id') || (location.pathname.match(/\/posts\/(\d+)/) || [])[1] || u.searchParams.get('story_fbid') || null;
  const group = (location.pathname.match(/\/groups\/([^/]+)/) || [])[1] || null;
  /* THE POST, not a neighbour. The first non-comment article on a permalink page can be a suggested
     post in the sidebar (one pass drafted as a Dutch fish-keeper). The real post is the article that
     CONTAINS the comment thread; failing that, the largest one before the first comment, never in the
     complementary (sidebar) region. Its own text = its content minus the nested comments/controls. */
  const visible = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]');
  const cands = q('[role="article"]').filter((a) => !isC(a) && !a.closest('[role="complementary"]') && visible(a));
  // Deterministic: the post's own article links to ITS id (timestamp / permalink); suggestions link elsewhere.
  const pidNow = u.searchParams.get('post_id') || (location.pathname.match(/\/posts\/(\d+)/) || [])[1] || u.searchParams.get('story_fbid') || '';
  const linksTo = (a) => !!pidNow && q('a[href]', a).some((l) => { const h = l.getAttribute('href') || ''; return h.includes('/posts/' + pidNow) || h.includes('/permalink/' + pidNow) || h.includes('post_id=' + pidNow) || h.includes('story_fbid=' + pidNow) || h.includes('fbid=' + pidNow) || h.includes('multi_permalinks=' + pidNow); });
  const isBefore = (el) => arts[0] ? !!(el.compareDocumentPosition(arts[0]) & Node.DOCUMENT_POSITION_FOLLOWING) : true;
  // Every visible post body on the page, ranked: links to THIS post id > sits before the first comment > longest.
  const msgs = q('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]').filter(visible);
  const scored = msgs.map((m) => { const sc = m.closest('[role="article"]') || m.parentElement; const txt = (m.innerText || m.textContent || '').trim(); return { m, byId: sc ? linksTo(sc) : false, before: isBefore(m), len: txt.length, txt }; })
    .sort((a, b) => (Number(b.byId) - Number(a.byId)) || (Number(b.before) - Number(a.before)) || (b.len - a.len));
  const msg = scored[0] ? scored[0].m : null;
  let postArt = cands.find(linksTo) || cands.find((a) => arts.some((c) => a.contains(c))) || null;
  if (!postArt && arts[0]) { const before = cands.filter(isBefore); postArt = before.sort((x, y) => (y.textContent || '').length - (x.textContent || '').length)[0] || null; }
  const ownText = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[role="article"], form, [role="button"], [role="menu"], [aria-hidden="true"]').forEach((x) => x.remove()); return (c.textContent || '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim(); };
  const probe = scored.slice(0, 6).map((s) => ({ byId: s.byId, before: s.before, len: s.len, text: s.txt.slice(0, 70) }));
  const postText = ((msg && (msg.innerText || msg.textContent)) || (postArt ? ownText(postArt) : '') || '').replace(/…?\s*(meer weergeven|see more|zie meer)\b/gi, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 2500);
  const authorEl = postArt && postArt.querySelector('h2 a, h3 a, h4 a, strong a, [data-ad-rendering-role="profile_name"] a, h2, h3, h4');
  const postAuthor = authorEl ? (authorEl.innerText || '').trim().split('\n')[0].trim() : '';
  let me = ''; try { const p = document.querySelector('[aria-label="Je profiel"] img, [aria-label="Your profile"] img, [aria-label="Profiel"] img, [aria-label="Profile"] img'); me = p ? (p.getAttribute('alt') || '') : ''; } catch (e) { /* none */ }
  return { postId, group, postText, postAuthor, me, probe, nodes: uniq.filter((n) => n.id && n.author) };
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
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const mentionsMe = (n) => !!me && String(n.text || '').trim().toLowerCase().startsWith(me);
  for (const [rootId, list] of Object.entries(branches)) {
    const rootAuthor = (byId[rootId] || list[0] || {}).author || '';
    list.forEach((n, i) => {
      const parent = byId[n.parentId];
      const mine = isMe(n);
      /* WHO IS THIS FOR. A root comment is to the owner. A reply is to the owner when it answers the
         owner, @mentions them, or carries on a thread the owner is already in. People talking to each
         other under the post (Peter arguing with Dennis) are a side conversation: shown nowhere,
         drafted never - the owner is not the one being asked. */
      const talkedBefore = list.slice(0, i).some(isMe);
      // "continuing": the root author carrying on their OWN thread after the owner answered them
      // (Peter answering the owner's question) - not anyone replying to the root author.
      const toMe = n.isReply && (same(n.replyTo, me) || mentionsMe(n) || (same(n.author, rootAuthor) && same(n.replyTo, rootAuthor) && talkedBefore));
      const addressed = !mine && (!n.isReply || toMe);
      // A person is answered only when a LATER reply of the owner's in this branch is TO THEM (the
      // label says who each reply answers). Replying to Dennis does not answer Peter.
      const repliedTo = addressed && list.some((m, j) => j > i && isMe(m) && (same(m.replyTo, n.author) || (!m.replyTo && !n.isReply)));
      // A like from the owner is an acknowledgement too - that is how most comments get handled.
      const reacted = addressed && !!n.reactedByMe && cfg.reactionCounts !== false;
      const answered = repliedTo || reacted;
      const status = mine ? 'you' : (!addressed ? 'side conversation' : (repliedTo ? 'answered' : (reacted ? 'you reacted' : 'waiting on you')));
      const target = n.replyTo || (parent ? parent.author : '');
      const title = mine ? `you replied to ${target || 'a comment'}` : (n.isReply ? `${n.author} replied to ${toMe ? 'you' : (target || 'a comment')}` : `${n.author} commented on your post`);
      const fields = { type: n.isReply ? 'reply' : 'comment', author: n.author, said: n.text, when: n.when, status, postId: tree.postId, commentId: n.id, rootId, replyTo: target };
      const { item } = feed.upsert(wid, { title, fields, url: deepLink(tree, n), kind: n.isReply ? 'reply' : 'comment' });
      const patch = { fields: Object.assign({}, item.fields, fields), isMe: mine };
      if (mine || answered || !addressed) patch.handled = true;    // nothing for the owner to do here, and it stays gone
      feed.mark(wid, item.key, patch);
      out.push({ node: n, key: item.key, rootId, branch: list, needsReply: addressed && !answered, isMe });
    });
  }
  return out;
}

/**
 * SELF-CHECK BEFORE DRAFTING. Every item the crawl calls "waiting on you" is re-read from its own deep
 * link (the exact link the card carries) before a word is drafted. If that page shows a later reply of
 * the owner's to this person, or the owner's reaction, the crawl was wrong and the deep link wins:
 * the item is marked answered and the correction is logged. The crawl can be fooled by rendering; the
 * page the person is actually on cannot. Returns what it checked and corrected, for the pass health.
 */
async function verifyWaiting(getPage, tree, entries, cfg, feed, wid, log, touch) {
  const me = String(cfg.meName || tree.me || tree.postAuthor || '').trim().toLowerCase();
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const out = { checked: 0, corrected: 0, errors: 0 };
  for (const e of entries.filter((x) => x.needsReply)) {
    const it = feed.list(wid).find((x) => x.key === e.key);
    if (!it || it.handled || it.draft || it.draftChecked) continue;
    out.checked++;
    try {
      const sub = await openAndRead(await getPage(), it.url, null, false, touch);
      const branch = sub.nodes.filter((n) => n.id === e.rootId || n.cid === e.rootId).sort((a, b) => a.i - b.i);
      const idx = branch.findIndex((n) => n.id === e.node.id);
      const self = idx >= 0 ? branch[idx] : null;
      const repliedTo = idx >= 0 && branch.some((n, j) => j > idx && same(n.author, me) && (same(n.replyTo, e.node.author) || (!n.replyTo && !e.node.isReply)));
      const reacted = !!(self && self.reactedByMe) && cfg.reactionCounts !== false;
      if (repliedTo || reacted) {
        out.corrected++;
        e.needsReply = false;
        feed.mark(wid, e.key, { handled: true, fields: Object.assign({}, it.fields, { status: repliedTo ? 'answered' : 'you reacted', verified: 'deep link' }) });
        if (log) log.warn(`[post-watch] verify: ${e.node.author} was already ${repliedTo ? 'answered' : 'reacted to'} — the crawl missed it, the deep link wins`);
        // fold the missed messages into the tree so the next pass starts right
        for (const n of branch) if (!tree.nodes.some((m) => m.id === n.id)) { n.i = e.node.i + (n.i + 1) / 100000; tree.nodes.push(n); }
      } else feed.mark(wid, e.key, { fields: Object.assign({}, it.fields, { verified: 'deep link' }) });
    } catch (err) { out.errors++; if (log) log.error(`[post-watch] verify ${e.node.author}: ${err.message}`); }
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
    // a sticker / photo / "follow" with no words: nothing to answer, and a model would only invent one
    if (!String(e.node.text || '').trim()) { feed.mark(wid, e.key, { draftChecked: true, noText: true, handled: true }); return false; }
    return true;
  }).sort((a, b) => b.node.i - a.node.i).slice(0, cap);
  let made = 0;
  for (const e of todo) {
    const transcript = e.branch.map((n) => `${e.isMe(n) ? 'YOU' : n.author}${n.replyTo ? ' (to ' + (e.isMe({ author: n.replyTo }) ? 'you' : n.replyTo) + ')' : ''}: ${n.text}`).join('\n');
    const sys = `You draft replies for the owner of a Facebook post, written AS the owner in first person. ${VOICE} `
      + 'Write in the language of the POST and the thread (an English post gets English replies even when someone answers with one word). Use ONLY what the post and '
      + 'the thread say: never invent facts, projects, problems or a persona for the owner; if you lack context, keep it short and about their message. '
      + 'Output ONLY the reply text - no quotes, no preamble.';
    const user = `YOUR POST (you wrote this):\n${tree.postText || '(post text not captured - reply only to what they said)'}\n\nTHIS COMMENT THREAD, in order:\n${transcript}\n\nWrite ONE reply to ${e.node.author}'s last message: "${String(e.node.text).slice(0, 600)}". Speak to ${e.node.author} only, building on what was said in this thread. If it is just thanks or an emoji, one short warm line is enough.`;
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
/** Self-discovery: a quick read of the owner's notifications page for "commented on your post"
 *  rows - each names a post of the owner's that has activity. Deterministic, ~20s, no model, so the
 *  post watcher stands on its own (no other watcher has to be running). */
async function discoverOnPage(page, log) {
  const { settle } = require('./inspector');
  await page.goto('https://www.facebook.com/notifications', { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await settle(page); } catch { /* still rendering */ }
  await page.waitForTimeout(2500);
  for (let i = 0; i < 2; i++) { try { await page.mouse.wheel(0, 1600); } catch { /* no wheel */ } await page.waitForTimeout(1200); }
  const found = await page.evaluate(() => {
    const out = []; const seen = new Set();
    for (const a of Array.from(document.querySelectorAll('a[href*="notif_id="], a[href*="notif_t="]'))) {
      const href = a.href || '';
      const txt = ((a.getAttribute('aria-label') || '') + ' ' + (a.innerText || '')).replace(/\s+/g, ' ').trim();
      if (!/(je bericht|jouw bericht|your post)/i.test(txt)) continue;
      let u; try { u = new URL(href); } catch (e) { continue; }
      const pid = u.searchParams.get('post_id') || (u.pathname.match(/\/posts\/(\d+)/) || [])[1] || '';
      const g = (u.pathname.match(/\/groups\/([^/?]+)/) || [])[1] || '';
      if (!pid || !g || seen.has(pid)) continue;
      seen.add(pid); out.push({ postId: pid, group: g, text: txt.slice(0, 120) });
    }
    return out;
  }).catch(() => []);
  if (log) log.info(`[post-watch] notifications page: ${found.length} post(s) of yours with activity`);
  return found.map((f) => `https://www.facebook.com/groups/${f.group}/posts/${f.postId}/`);
}

/** Ground truth for one comment link: every comment article Facebook renders there, as the watcher's
 *  own session sees it (label, visible, first words), plus the reveal controls still closed. */
async function probePage(page, url, opts) {
  const { settle } = require('./inspector');
  await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await settle(page); } catch { /* still rendering */ }
  await page.waitForTimeout(4000);
  let expand = null;
  if (opts && opts.expand) { const { candidates, press } = helpers(page); expand = await expandAll(page, candidates, press); }
  const dump = await page.evaluate(() => {
    const q = (s, r) => Array.from((r || document).querySelectorAll(s));
    const arts = q('[role="article"]').filter((a) => /^(comment|opmerking|reply|antwoord)/i.test(a.getAttribute('aria-label') || ''));
    return { url: location.href, count: arts.length,
      items: arts.slice(0, 80).map((a) => ({ label: (a.getAttribute('aria-label') || '').slice(0, 110), vis: a.getClientRects().length > 0, text: (a.innerText || '').replace(/\s+/g, ' ').slice(0, 90) })),
      expanders: q('[role="button"]').map((b) => (b.innerText || '').trim()).filter((t) => /antwoord|repl|opmerking|comment/i.test(t)).slice(0, 25) };
  });
  dump.expand = expand;
  return dump;
}

function postIdOf(url) {
  try { const u = new URL(String(url)); return u.searchParams.get('post_id') || (u.pathname.match(/\/posts\/(\d+)/) || [])[1] || u.searchParams.get('story_fbid') || null; } catch { return null; }
}

module.exports = { crawl, store, ingest, verifyWaiting, draftAll, discover, discoverOnPage, probePage, postIdOf, extractInPage, VOICE };
