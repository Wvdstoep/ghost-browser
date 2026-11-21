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
const people = require('./people');

const DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'post-threads');

const VOICE = 'Plain words, short, like a real person typing on their phone. Contractions. 1-3 sentences unless the question truly needs more. '
  + 'Never open with "That\'s a solid/great/good ...", "Absolutely", "Great question", "Love this". No em dashes, no semicolons, no bullet lists, '
  + 'no sign-off, no hashtags, no emoji unless the thread is full of them. Starting lowercase is fine. Say one concrete thing from your own '
  + 'experience rather than a general observation. Never mention being an AI. Answer criticism thoughtfully, never defensively. No pitch.';

/* Controls that reveal more of the thread — in Dutch and English, and never the "Reply" control itself. */
const EXPAND = /^(?!(?:antwoord(?:en)?|repl(?:y|ies)|odpowiedz|odpowiedź|comments?|opmerkingen|reacties?|komentarze?)$)(?:(?:bekijk|view|show|see|toon)\s+)?(?:(?:all|alle|nog|more|meer)\s+)?\d*\s*(?:antwoord(?:en)?|repl(?:y|ies)|reacties?|opmerkingen|comments)(?:\s+(?:bekijken|weergeven|tonen))?$|^(?:meer|more)\s+(?:opmerkingen|comments|reacties)(?:\s+(?:weergeven|bekijken|laden|tonen))?$|^(?:vorige|previous|earlier)\s+(?:opmerkingen|comments|reacties)(?:\s+(?:weergeven|bekijken))?$|^(?:zie|see|show)\s+more$|^meer\s+weergeven$/i;
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
  /* A comment's own page exists only under Facebook's own id (desktop links carry it). On the phone a comment
     has no link: the post page, with every "View N replies" opened, is the whole thread. */
  const roots = tree.nodes.filter((n) => !n.isReply && /^\d+$/.test(String(n.id))).slice(0, 40);
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
  tree.broken = readerBroken(tree);
  if (tree.broken && log) log.warn(`[post-watch] reader broken on ${url}: ${tree.broken}`);
  if (log) log.info(`[post-watch] ${roots.length} root comment(s) read from their own pages → ${tree.nodes.length} messages`);
  return tree;
}

/**
 * THE READER CHECKS ITSELF. A post with comments read as "0 messages" looked exactly like a quiet post, so the
 * phone's first pass failed in silence. Broken: Reply controls on the page but no comment came out of them, or
 * far fewer comments than the count Facebook prints. Returns why, or '' when the read is believable.
 */
function readerBroken(tree) {
  const read = (tree.nodes || []).length;
  const controls = Number(tree.replyControls) || 0;
  const shownCount = Number(tree.shownCount) || 0;
  if (controls > 0 && read === 0) return `${controls} Reply control(s) on the page, 0 comments read`;
  if (shownCount >= 4 && read < Math.ceil(shownCount / 2)) return `Facebook shows ${shownCount} comments, ${read} read`;
  return '';
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
    /* ON THE POST, in any layout: its id in the address (or a link to it), and something a person can answer
       with on screen: a comment box, or a Reply under a comment. */
    const onPost = await page.evaluate((id) => {
      const here = !id || location.href.includes(id) || !!document.querySelector(`a[href*="${id}"]`);
      const box = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).some((b) => b.getClientRects().length > 0);
      const reply = Array.from(document.querySelectorAll('body *')).some((el) => el.children.length === 0 && /^(?:reply|beantwoorden|antwoorden|odpowiedz|odpowiedź)$/i.test((el.textContent || '').trim()) && el.getClientRects().length > 0);
      return here && (box || reply);
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
  /* Controls by their WORDS, in any layout ("1 antwoord bekijken" is a role=button on desktop and a plain block
     on the phone): the page marks the deepest visible element whose text matches, and those are the handles. */
  let seq = 0;
  const candidates = async (re) => {
    const tag = 'c' + (++seq);
    // ONE argument: Playwright passes only one to a page function (the phone's page takes more, the cluster's not)
    const n = await page.evaluate(markControls, { src: re.source, flags: re.flags.replace('g', ''), tag }).catch(() => 0);
    return n ? page.$(`[data-gb-ctl="${tag}"]`) : [];
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

/*
 * ONE READER FOR EVERY LAYOUT (2026-11-21). Runs INSIDE the page. Read-only.
 *
 * The owner's phone gets Facebook's mobile layout, the cluster the desktop one, and the old reader knew only
 * the desktop's markup (comment articles and their aria-labels): on the phone it read "0 messages" from a post
 * with 26 comments. Owner: "we need to think about not that one change breaks 2 versions". So this reads what
 * a PERSON sees, which is the same in both layouts and in every language Facebook speaks to the owner:
 *
 *   - a comment is the block around ONE "Reply" control, bounded above by the Like row before it (the
 *     previous comment's, or the post's own);
 *   - its first line is the name (badges like "Author" dropped), the rest is the text (actions and times dropped);
 *   - a reply's writing starts further right than what it answers: nesting comes from indentation;
 *   - its id is Facebook's own comment id when the block links to it (desktop), else a fingerprint of name and
 *     text, the same on every pass;
 *   - the count Facebook prints ("26 comments") comes back too, with how many Reply controls were on the page,
 *     so a reader that misses most of them says so instead of reading "0 messages".
 *
 * Visible means laid out on screen. Not aria-hidden: mobile Facebook marks the VISIBLE name aria-hidden (it
 * repeats the text in a label), desktop marks a hidden duplicate copy, which drops out here by its layout or,
 * at the latest, by its id. Lines come from the element structure, not the stylesheet, so a saved page without
 * its styles reads the same. An aria-label that names the author and who they answered ("Reply by X on the
 * reply by Y") is used when the page has one: it is what a screen reader says, not layout.
 */
function extractInPage() {
  const REPLY = /^(?:reply|beantwoorden|antwoorden|odpowiedz|odpowiedź)$/i;
  const LIKE = /^(?:like|leuk|vind ik leuk|lubię to!?|polub|liked|geliked)$/i;
  const BADGE = /^(?:auteur|author|autor|topbijdrager|top contributor|najaktywniejszy|beheerder|admin|administrator|moderator|nieuw lid|new member|nowy członek|groepsexpert|group expert|volgen|follow|obserwuj|bewerkt|edited|edytowano|·|•)$/i;
  const ACTION = /^(?:vind ik leuk|like|leuk|lubię to!?|beantwoorden|reply|antwoorden|odpowiedz|odpowiedź|delen|share|udostępnij|bewerken|edit|verbergen|hide|meer weergeven|see more|zie meer|więcej|geliked|liked|verzenden|send|vertaling bekijken|see translation|zobacz tłumaczenie|\d+)$/i;
  const WHEN = /^(?:\d+\s*(?:s|sec|seconden?|min|minuten?|m|u|uur|h|hr|hrs|godz\.?|d|dag|dagen|dni|w|wk|weken?|tyg\.?|j|jaar|y|yr|mnd|mo|mies\.?)\.?|\d{1,2}\s+[a-zA-Zéû]{3,10}\.?(?:\s+\d{4})?(?:\s+om\s+\d{1,2}:\d{2})?|gisteren|yesterday|wczoraj|zojuist|just now|przed chwilą)$/i;
  const COUNT = /^(\d[\d.,]*)\s*(?:opmerkingen|opmerking|comments?|reacties|reactie|komentarz(?:e|y)?)$/i;
  // "1 antwoord bekijken", "View all 3 replies": a control that opens more, never part of what someone wrote
  const MORE = /^(?!(?:antwoord(?:en)?|repl(?:y|ies)|odpowiedz|odpowiedź|comments?|opmerkingen|reacties?|komentarze?)$)(?:(?:bekijk|view|show|see|toon|zobacz)\s+)?(?:(?:all|alle|nog|more|meer|wszystkie|kolejne)\s+)?\d*\s*(?:antwoord(?:en)?|repl(?:y|ies)|odpowied\w*|reacties?|opmerkingen|comments?|komentarz\w*)(?:\s+(?:bekijken|weergeven|tonen))?$/i;
  // Facebook's icon font (private-use characters) draws badges and separators: read as a separator, never as words
  const norm = (t) => String(t || '')
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/[-]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*·\s*){2,}/g, ' · ')
    .trim();
  const shown = (el) => {
    if (!el || !el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && String(cs.opacity).trim() !== '0';
  };
  /* The lines of a piece of the page, as a person reads them: text in the same block element is one line, a new
     block element starts the next, and a "·" splits a line ("Mike · 1 d"). */
  const BLOCK = 'div,p,li,h1,h2,h3,h4,h5,h6,blockquote,section,article,ul,ol,table,tr,td,header,footer,form';
  const linesOf = (root, keep) => {
    const out = []; let cur = ''; let owner = null;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (w.nextNode()) {
      const n = w.currentNode;
      if (n.nodeType === 1) { if (n.tagName === 'BR') { out.push(cur); cur = ''; } continue; }
      const el = n.parentElement;
      if (!el || !shown(el) || (keep && !keep(el))) continue;
      const blk = el.closest(BLOCK);
      if (blk !== owner) { out.push(cur); cur = ''; owner = blk; }
      cur += n.textContent;
    }
    out.push(cur);
    return out.map(norm).flatMap((l) => l.split(/\s+·\s+|^·\s+|\s+·$/)).map(norm).filter((l) => l && l !== '·');
  };
  const rect = (el) => el.getBoundingClientRect();
  // where a block's writing starts: a reply's text sits further right than its parent's, whatever the row's width
  const textLeft = (root) => {
    let min = Infinity;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const n = w.currentNode;
      if (!/[\p{L}\p{N}]/u.test(n.textContent) || !shown(n.parentElement)) continue;
      let r = null;
      try { const rg = document.createRange(); rg.selectNodeContents(n); r = rg.getBoundingClientRect(); } catch (e) { r = null; }
      if (!r) r = rect(n.parentElement);
      if (r.width > 0 && r.left < min) min = r.left;
    }
    return Number.isFinite(min) ? Math.round(min) : Math.round(rect(root).left);
  };
  // the deepest elements whose own visible text is exactly one of these words: the controls themselves
  const controls = (re) => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const t = norm(el.textContent);
      if (!t || t.length > 40 || !re.test(t) || !shown(el)) continue;
      if (Array.from(el.children).some((c) => re.test(norm(c.textContent)))) continue;
      out.push(el);
    }
    return out;
  };
  const replies = controls(REPLY);
  const likes = controls(LIKE);
  const yOf = (el) => rect(el).top + window.scrollY;
  const countIn = (el, list) => list.filter((x) => el.contains(x)).length;
  const blocks = [];
  for (const r of replies) {
    const top = yOf(r);
    // the Like row above this one: the previous comment's, or the post's own action row
    let floor = -Infinity;
    for (const l of likes) { const b = rect(l).bottom + window.scrollY; if (b <= top - 4 && b > floor) floor = b; }
    let block = r; let up = r.parentElement;
    while (up && up !== document.body && countIn(up, replies) === 1 && yOf(up) >= floor - 2) { block = up; up = up.parentElement; }
    if (block === r || blocks.some((b) => b.el === block)) continue;
    blocks.push({ el: block, reply: r });
  }
  // the label a screen reader reads, when the page has one: "Reply by X on the reply by Y 2 hours ago"
  const AGO = /\s+(?:ongeveer\s+|about\s+|over\s+)?(?:een|one|an?|\d+)\s+(?:seconde|second|minuut|minute|min|uur|hour|hr|dag|day|week|wk|maand|month|jaar|year)\w*\s+(?:geleden|ago)\b.*$/i;
  const labelOf = (el) => {
    const a = el.closest('[aria-label]');
    const l = a ? a.getAttribute('aria-label') || '' : '';
    return /^(comment|opmerking|reply|antwoord|komentarz|odpowiedź)\b/i.test(l) ? l : '';
  };
  const fromLabel = (l) => {
    const s2 = l.replace(/^(comment|opmerking|reply|antwoord|komentarz|odpowiedź)\s+(by|van|from|door|użytkownika|od)\s+/i, '').replace(AGO, '').trim();
    const m = s2.match(/^(.*?)\s+(?:op (?:het antwoord|de opmerking|een opmerking) van|on (?:the |a )?(?:reply|comment) (?:by|from|of))\s+(.+)$/i);
    return m ? { author: m[1].trim(), replyTo: m[2].trim() } : { author: s2, replyTo: '' };
  };
  const hash = (t) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); };
  const nodes = blocks.map((b, i) => {
    const lines = linesOf(b.el);
    const label = labelOf(b.el);
    const lab = label ? fromLabel(label) : null;
    let k = 0; while (k < lines.length && (BADGE.test(lines[k]) || WHEN.test(lines[k]))) k++;
    const author = lab && lab.author ? lab.author : (lines[k] || '');
    const rest = []; let when = '';
    for (const t of lines) {
      if (t === author) continue;
      if (WHEN.test(t)) { if (!when) when = t; continue; }
      if (BADGE.test(t) || ACTION.test(t) || MORE.test(t) || t.length < 2) continue;
      rest.push(t);
    }
    const text = rest.filter((t, j) => rest.indexOf(t) === j).join('\n');
    // Facebook's own ids, when the block links to its comment (desktop); a block holds one comment only
    let cid = null; let rid = null;
    for (const a of b.el.querySelectorAll('a[href*="comment_id="]')) {
      try { const u = new URL(a.href); cid = u.searchParams.get('comment_id'); rid = u.searchParams.get('reply_comment_id'); if (cid) break; } catch (e) { /* not a url */ }
    }
    const reactedByMe = Array.from(b.el.querySelectorAll('[role="button"], [aria-pressed]')).some((x) => {
      const l = ((x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')).toLowerCase();
      return (/verwijder|remove|unlike|ongedaan|usuń|cofnij/.test(l) && /leuk|like|reactie|reaction|lubię|reakcj/.test(l)) || (x.getAttribute('aria-pressed') === 'true' && /leuk|like|lubię/.test(l));
    });
    return { i, el: b.el, reply: b.reply, left: textLeft(b.el), author, labelReplyTo: lab ? lab.replyTo : '', labelReply: /^(reply|antwoord|odpowiedź)/i.test(label), text: text.slice(0, 2000), when, cid, rid, reactedByMe };
  }).filter((n) => n.author);
  // nesting from indentation: the nearest earlier block whose writing starts further left
  nodes.forEach((n, j) => {
    let p = null;
    for (let q = j - 1; q >= 0; q--) if (nodes[q].left < n.left - 6) { p = nodes[q]; break; }
    n.parent = p;
  });
  const rootOf = (n) => { let c = n; let g = 0; while (c.parent && g++ < 20) c = c.parent; return c; };
  for (const n of nodes) n.fp = 'v' + hash(n.author.toLowerCase() + '|' + n.text.replace(/\s+/g, ' ').slice(0, 160).toLowerCase());
  nodes.forEach((n, j) => {
    const root = rootOf(n);
    n.isReply = !!n.parent || n.labelReply || !!n.rid;
    if (n.cid) n.id = n.rid || n.cid;                                  // Facebook's own
    else { n.id = n.fp; n.cid = n.isReply ? root.fp : n.fp; n.rid = n.isReply ? n.fp : null; }
    n.parentId = n.isReply ? (n.parent ? (n.parent.rid || n.parent.cid || n.parent.fp) : n.cid) : null;
    // who they answered: the label when there is one, else an @mention of an earlier name, else the parent
    let replyTo = n.labelReplyTo || '';
    if (!replyTo && n.isReply) {
      const earlier = nodes.slice(0, j).map((m) => m.author).sort((a, b) => b.length - a.length);
      const m = earlier.find((a) => a && n.text.startsWith(a));
      replyTo = m || (n.parent ? n.parent.author : '');
    }
    if (replyTo && (n.text.startsWith(replyTo + ' ') || n.text.startsWith(replyTo + '\n'))) n.text = n.text.slice(replyTo.length + 1).trim();   // the @mention prefix
    n.replyTo = replyTo;
  });
  const byIdOnce = new Map();
  for (const n of nodes) { const ex = byIdOnce.get(n.id); if (!ex || (n.text || '').length > (ex.text || '').length) byIdOnce.set(n.id, n); }
  // each comment's own Reply control carries its id, so the poster presses exactly that one (the only write here)
  for (const n of byIdOnce.values()) { try { n.reply.setAttribute('data-gb-cid', String(n.id)); } catch (e) { /* detached */ } }
  const uniq = [...byIdOnce.values()].sort((a, b) => a.i - b.i).map((n) => ({ i: n.i, id: n.id, cid: n.cid, rid: n.rid, isReply: n.isReply, author: n.author, replyTo: n.replyTo, reactedByMe: n.reactedByMe, text: n.text, when: n.when, parentId: n.parentId }));
  // THE COUNT FACEBOOK SHOWS ("26 comments"), the largest one on the page
  let shownCount = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length > 3) continue;
    const t = norm(el.textContent);
    if (!t || t.length > 30) continue;
    const m = t.match(COUNT);
    if (m && shown(el)) { const v = Number(m[1].replace(/[.,]/g, '')); if (v > shownCount && v < 100000) shownCount = v; }
  }
  const u = new URL(location.href);
  const postId = u.searchParams.get('post_id') || (location.pathname.match(/\/posts\/(\d+)/) || [])[1] || u.searchParams.get('story_fbid') || null;
  const group = (location.pathname.match(/\/groups\/([^/]+)/) || [])[1] || null;
  /* THE POST. Desktop marks its body (data-ad-preview / story_message) and that is used when present; otherwise
     the post is what is written above the first comment, after its header: a name right before the time
     ("Wesley Stoep", "19 sep.") or the heading a screen reader reads ("Bericht van Wesley Stoep"). */
  const first = nodes[0] ? nodes[0].el : null;
  const before = (el) => !first || !!(el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING);
  const marked = Array.from(document.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]'))
    .filter((m) => shown(m) && before(m) && !m.closest('[role="complementary"]'))
    .sort((a, b) => (b.textContent || '').length - (a.textContent || '').length);
  let postText = marked[0] ? linesOf(marked[0]).join('\n') : '';
  let postAuthor = '';
  const head = linesOf(document.body, (el) => before(el) && !el.closest('[role="complementary"], [role="navigation"], [role="banner"], header, nav'));
  let meta = -1;
  for (let j = 0; j < head.length - 1 && meta < 0; j++) {
    if (WHEN.test(head[j]) || head[j].length > 80 || BADGE.test(head[j])) continue;
    if (WHEN.test(head[j + 1])) meta = j;
  }
  const said = head.map((t) => t.match(/^(?:bericht van|post by|posted by|post od|wpis od)\s+(.+)$/i)).find(Boolean);
  if (meta >= 0) postAuthor = head[meta];
  else if (said) postAuthor = said[1].trim();
  let start = meta >= 0 ? meta + 1 : 0;
  while (start < head.length && WHEN.test(head[start])) start++;
  if (!postText) {
    const body = head.slice(start).filter((t) => !WHEN.test(t) && !BADGE.test(t) && !ACTION.test(t) && !COUNT.test(t) && !MORE.test(t) && !/^\d+$/.test(t));
    postText = body.join('\n');
  }
  if (!postAuthor && postText) {
    // desktop: the line right above the marked post body is its author
    const at = head.findIndex((t) => t.length > 20 && postText.startsWith(t.slice(0, 40)));
    for (let j = at - 1; j >= 0 && !postAuthor; j--) if (!WHEN.test(head[j]) && !BADGE.test(head[j]) && head[j].length <= 60) postAuthor = head[j];
  }
  postText = postText.replace(/…?\s*(meer weergeven|see more|zie meer|więcej)\b/gi, ' ').replace(/[ \t]{2,}/g, ' ').trim().slice(0, 2500);
  let me = '';
  try { const p = document.querySelector('[aria-label="Je profiel"] img, [aria-label="Your profile"] img, [aria-label="Profiel"] img, [aria-label="Profile"] img, [aria-label="Twój profil"] img'); me = p ? (p.getAttribute('alt') || '') : ''; } catch (e) { /* none */ }
  return { postId, group, postText, postAuthor, me, shownCount, replyControls: replies.length, read: uniq.length, nodes: uniq.filter((n) => n.id && n.author) };
}

/* Runs INSIDE the page: mark the controls whose visible text matches (the deepest such element, on screen), so
   the caller can take them as handles. The same in every layout: a person finds "View 3 replies" by its words,
   not by its tag. Returns how many. */
function markControls({ src, flags, tag }) {
  const re = new RegExp(src, flags);
  const norm = (t) => String(t || '').replace(/[​-‏⁠﻿]/g, '').replace(/[-]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/g, ' ').replace(/\s+/g, ' ').trim();
  const shown = (el) => { const r = el.getBoundingClientRect(); if (!el.getClientRects().length || r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  document.querySelectorAll('[data-gb-ctl="' + tag + '"]').forEach((x) => x.removeAttribute('data-gb-ctl'));
  let n = 0;
  for (const el of document.querySelectorAll('body *')) {
    const t = norm(el.textContent);
    if (!t || t.length > 60 || !re.test(t) || !shown(el)) continue;
    if (Array.from(el.children).some((c) => re.test(norm(c.textContent)))) continue;
    el.setAttribute('data-gb-ctl', tag); n++;
  }
  return n;
}

function store(tree) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, String(tree.postId || 'unknown').replace(/[^0-9a-zA-Z_-]/g, '_') + '.json'), JSON.stringify(tree)); } catch { /* best effort */ }
}

const deepLink = (tree, n) => `https://www.facebook.com/groups/${tree.group || 'x'}/?post_id=${tree.postId}&comment_id=${n.rid ? n.cid : n.id}${n.rid ? '&reply_comment_id=' + n.rid : ''}`;

/** Fold the tree into the watcher's feed: one item per message, keyed by its ids, with the standing
 *  of its branch. Returns the entries in branch order with what each one needs. */
/** A name as the page shows it minus a trailing relative time ("2 weken geleden", "3 h", "about an hour ago"). */
function cleanName(v) {
  return String(v || '').replace(/\s+(?:ongeveer\s+|about\s+|over\s+)?(?:een|one|an?|\d+)\s*(?:seconde|second|sec|minuut|minute|min|uur|hour|hr|dag|day|week|wk|maand|month|mnd|jaar|year|yr|[umdwhjy]|mo)\w*\.?(?:\s+(?:geleden|ago))?\s*$/i, '').replace(/\s*·\s*$/, '').trim();
}
function ingest(wid, tree, cfg, feed) {
  const me = String(cfg.meName || tree.me || tree.postAuthor || '').trim().toLowerCase();
  const isMe = (n) => !!me && String(n.author || '').trim().toLowerCase() === me;
  const byId = {}; tree.nodes.forEach((n) => { byId[n.id] = n; });
  const rootOf = (n) => { let cur = n, g = 0; while (cur.parentId && byId[cur.parentId] && g++ < 12) cur = byId[cur.parentId]; return cur.id; };
  const branches = {}; tree.nodes.forEach((n) => { const r = rootOf(n); (branches[r] = branches[r] || []).push(n); });
  const out = [];
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const mentionsMe = (n) => !!me && String(n.text || '').trim().toLowerCase().startsWith(me);
  /* SOMEONE ELSE'S POST. The owner commented under a post of another person's; that person (or anyone)
     replied. Only the branches the owner is in are the owner's business here: a root comment by
     somebody else is their conversation with the post's author, never the owner's to answer. */
  /* NAMES. A label sometimes keeps its time ("Wesley Stoep 2 weken geleden"); strip it once here, so the
     owner is recognised as the owner and a person is one person. */
  tree.nodes.forEach((n) => { n.author = cleanName(n.author); n.replyTo = cleanName(n.replyTo); });
  /* WHOSE POST. The page's author when it yields one; else what the discovery knew — "replied to your
     comment" rows mark a post as theirs, "your post" rows mark it as the owner's (that wins); else,
     with no author and no discovery, an owner who wrote a ROOT comment there is a guest. */
  const mineIds = Array.isArray(cfg.mineIds) ? cfg.mineIds.map(String) : [];
  const theirsIds = Array.isArray(cfg.theirsIds) ? cfg.theirsIds.map(String) : [];
  const pid = String(tree.postId);
  const theirs = tree.postAuthor ? (!!me && !same(tree.postAuthor, me)) : (!mineIds.includes(pid) && (theirsIds.includes(pid) || tree.nodes.some((n) => !n.isReply && isMe(n))));
  const whose = tree.postAuthor && !same(tree.postAuthor, me) ? `${tree.postAuthor}'s` : 'their';
  for (const [rootId, list] of Object.entries(branches)) {
    const rootAuthor = (byId[rootId] || list[0] || {}).author || '';
    if (theirs && !list.some(isMe)) continue;
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
      const addressed = !mine && (theirs ? toMe : (!n.isReply || toMe));
      // A person is answered only when a LATER reply of the owner's in this branch is TO THEM (the
      // label says who each reply answers). Replying to Dennis does not answer Peter.
      const repliedTo = addressed && list.some((m, j) => j > i && isMe(m) && (same(m.replyTo, n.author) || (!m.replyTo && !n.isReply)));
      // A like from the owner is an acknowledgement too - that is how most comments get handled.
      const reacted = addressed && !!n.reactedByMe && cfg.reactionCounts !== false;
      const answered = repliedTo || reacted;
      const status = mine ? 'you' : (!addressed ? 'side conversation' : (repliedTo ? 'answered' : (reacted ? 'you reacted' : 'waiting on you')));
      const target = n.replyTo || (parent ? parent.author : '');
      const title = mine ? `you replied to ${target || 'a comment'}` : (n.isReply ? `${n.author} replied to ${toMe ? 'you' : (target || 'a comment')}${theirs ? ` on ${whose} post` : ''}` : (theirs ? `${n.author} commented on ${whose} post` : `${n.author} commented on your post`));
      // WHY it is (or is not) the owner's, in the words a card can show; and the branch as a transcript
      // the owner would otherwise open Facebook to read.
      const why = mine ? 'your reply' : !addressed ? `${n.author} and ${target || 'someone'} talking to each other` : !n.isReply ? 'commented on your post' : same(n.replyTo, me) ? 'replied to you' : mentionsMe(n) ? 'mentions you' : 'continued after your answer';
      const thread = list.map((m) => `${isMe(m) ? 'YOU' : m.author}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
      const fields = { type: n.isReply ? 'reply' : 'comment', author: n.author, said: n.text, when: n.when, status, why, postId: tree.postId, postTitle: (theirs && tree.postAuthor ? `${tree.postAuthor}: ` : '') + String(tree.postText || '').replace(/\s+/g, ' ').slice(0, 90), postAuthor: tree.postAuthor || '', theirs, commentId: n.id, rootId, replyTo: target, thread };
      const { item } = feed.upsert(wid, { title, fields, url: deepLink(tree, n), kind: n.isReply ? 'reply' : 'comment' });
      const patch = { fields: Object.assign({}, item.fields, fields), isMe: mine };
      if (mine || answered || !addressed) patch.handled = true;    // nothing for the owner to do here, and it stays gone
      feed.mark(wid, item.key, patch);
      out.push({ node: n, key: item.key, rootId, branch: list, needsReply: addressed && !answered, isMe });
    });
  }
  /* THEIR POST, STALE ITEMS: what this pass did not produce there (a stranger's root comment kept from
     a pass that thought the post was the owner's) is not the owner's to answer — folded away. */
  if (theirs) {
    const produced = new Set(out.map((e) => e.key));
    for (const it of feed.list(wid)) if (it && (it.fields || {}).postId === pid && !produced.has(it.key) && !it.handled) feed.mark(wid, it.key, { handled: true, fields: Object.assign({}, it.fields, { status: 'side conversation', why: 'on someone else\'s post, not addressed to you', theirs: true }) });
  }
  /* PEOPLE MEMORY (people.js): every branch lands on the records of the people the owner talks with;
     a person with a commercial signal is a lead, and the card says so. Never breaks a pass. */
  try {
    people.remember('facebook', tree, out, { urlOf: (n) => deepLink(tree, n), theirs });
    for (const e of out) if (!e.isMe && people.isLead('facebook', e.node.author)) { const it = feed.list(wid).find((x) => x.key === e.key); if (it && !(it.fields || {}).lead) feed.mark(wid, e.key, { fields: Object.assign({}, it.fields, { lead: true }) }); }
  } catch (err) { /* memory is a bonus, never the pass */ }
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
  /* THE OWNER'S OWN REPLIES AS THE VOICE SAMPLE. The crawl already holds them; five recent ones, in
     the owner's words, beat any description of a voice. Remembered across posts (voice.json), so a
     new post's first draft already sounds right. */
  const meName = String(cfg.meName || tree.me || tree.postAuthor || '').trim().toLowerCase();
  const own = tree.nodes.filter((n) => String(n.author || '').trim().toLowerCase() === meName && n.text && n.text.length >= 40 && n.text.length <= 600).sort((a, b) => b.i - a.i).map((n) => n.text.trim());
  const voice = rememberVoice(own);
  const examples = voice.slice(0, 5).map((t) => `- ${t.replace(/\s+/g, ' ')}`).join('\n');
  let made = 0;
  for (const e of todo) {
    const transcript = e.branch.map((n) => `${e.isMe(n) ? 'YOU' : n.author}${n.replyTo ? ' (to ' + (e.isMe({ author: n.replyTo }) ? 'you' : n.replyTo) + ')' : ''}: ${n.text}`).join('\n');
    const sys = `You draft replies for the owner of a Facebook post, written AS the owner in first person. ${VOICE} `
      + (examples ? `\n\nHOW THE OWNER ACTUALLY WRITES - recent replies in their own words; match this voice, rhythm and length, not a generic tone:\n${examples}\n\n` : '')
      + 'Write in the language of the POST and the thread (an English post gets English replies even when someone answers with one word). Use ONLY what the post and '
      + 'the thread say: never invent facts, projects, problems or a persona for the owner; if you lack context, keep it short and about their message. '
      + 'Output ONLY the reply text - no quotes, no preamble.';
    // what is known about this person from other posts, and what the owner tends to change in drafts
    let memory = ''; let lessons = ''; try { memory = people.profileOf('facebook', e.node.author, { exceptPostId: tree.postId }); lessons = people.editLessons(); } catch (err) { memory = ''; lessons = ''; }
    const pid = String(tree.postId); const mineIds = Array.isArray(cfg.mineIds) ? cfg.mineIds.map(String) : []; const theirsIds = Array.isArray(cfg.theirsIds) ? cfg.theirsIds.map(String) : [];
    const theirs = tree.postAuthor ? String(tree.postAuthor).trim().toLowerCase() !== meName : (!mineIds.includes(pid) && (theirsIds.includes(pid) || tree.nodes.some((n) => !n.isReply && String(n.author || '').trim().toLowerCase() === meName)));
    const user = `${theirs ? `THE POST (by ${tree.postAuthor || 'someone else'} — not yours; you commented under it)` : 'YOUR POST (you wrote this)'}:\n${tree.postText || '(post text not captured - reply only to what they said)'}\n\nTHIS COMMENT THREAD, in order:\n${transcript}\n\n${memory ? memory + '\n\n' : ''}${lessons ? lessons + '\n\n' : ''}Write ONE reply to ${e.node.author}'s last message: "${String(e.node.text).slice(0, 600)}". Speak to ${e.node.author} only, building on what was said in this thread. If it is just thanks or an emoji, one short warm line is enough.`;
    try {
      const out = await llm.chat({ host: llmCfg.llmHost, model: llmCfg.llmModel, key: llmCfg.llmKey, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] });
      const text = humanize((out && out.content) || '');
      if (text) { feed.mark(wid, e.key, { draft: text, draftJobId: '', draftPid: '', followedUp: true, draftedBy: 'post-watch' }); made++; }
      else feed.mark(wid, e.key, { draftChecked: true });
    } catch (err) { if (log) log.error(`[post-watch] draft for ${e.node.author}: ${err.message}`); }
  }
  return made;
}

/** The owner's voice, kept across posts: newest first, deduped, capped. Returns the current list. */
function rememberVoice(newOnes) {
  const fp = path.join(DIR, 'voice.json');
  let cur = []; try { cur = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { cur = []; }
  const seen = new Set(cur.map((t) => t.slice(0, 80)));
  const add = (newOnes || []).filter((t) => t && !seen.has(t.slice(0, 80)));
  if (add.length) { cur = add.concat(cur).slice(0, 30); try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(fp, JSON.stringify(cur)); } catch { /* best effort */ } }
  return cur;
}

/** ADAPTIVE CADENCE. A post with fresh activity is read every pass; a quiet one hourly; a dead one
 *  daily - with jitter, so the pattern is neither wasteful nor a metronome. Due = lastCrawl + interval. */
function dueUrls(cfg, urls, now) {
  const last = cfg.lastCrawl || {}; const t = now || Date.now();
  return urls.filter((u) => {
    const lc = last[u] || 0; if (!lc) return true;
    let newestDays = 99; try { const tr = JSON.parse(fs.readFileSync(path.join(DIR, String(postIdOf(u)) + '.json'), 'utf8')); for (const n of tr.nodes || []) { const d = ageDaysOf(n); if (d < newestDays) newestDays = d; } } catch { /* unknown → treat as active */ newestDays = 0; }
    const base = newestDays < 0.25 ? 15 : newestDays < 3 ? 60 : 24 * 60;   // minutes
    const jitter = 1 + ((Math.sin(lc / 7919) + 1) / 2 - 0.5) * 0.4;         // deterministic ±20%
    return t - lc >= base * 60000 * jitter;
  });
}
/** ADAPTIVE CADENCE, AS DATA: per post — when it was last read, how fresh its newest message is, the
 *  interval that follows from it (15 min active / hourly quiet / daily dead, ±20 % jitter) and when
 *  the next read is due. What dueUrls decides, made visible for the health line, the app and the agent. */
function cadenceOf(cfg, urls, now) {
  const last = (cfg && cfg.lastCrawl) || {}; const t = now || Date.now();
  return (urls || []).map((u) => {
    const lc = last[u] || 0;
    let newestDays = null; try { const tr = JSON.parse(fs.readFileSync(path.join(DIR, String(postIdOf(u)) + '.json'), 'utf8')); for (const n of tr.nodes || []) { const d = ageDaysOf(n); if (newestDays === null || d < newestDays) newestDays = d; } } catch { newestDays = null; }
    const nd = newestDays === null ? 0 : newestDays;
    const base = nd < 0.25 ? 15 : nd < 3 ? 60 : 24 * 60;
    const jitter = lc ? 1 + ((Math.sin(lc / 7919) + 1) / 2 - 0.5) * 0.4 : 1;
    const intervalMin = Math.round(base * jitter);
    const dueAt = lc ? lc + intervalMin * 60000 : t;
    return { url: u, postId: postIdOf(u), lastCrawl: lc || null, newestDays: newestDays === null ? null : Number(nd.toFixed(2)), pace: base === 15 ? 'active' : base === 60 ? 'quiet' : 'dormant', intervalMin, dueInMin: Math.max(0, Math.round((dueAt - t) / 60000)), due: t >= dueAt };
  });
}
function ageDaysOf(n) {
  const w = String(n.when || '').toLowerCase();
  const m = w.match(/(\d+)\s*(mnd|maand|month|mo|min|uur|hour|hr|dag|day|week|wk|jaar|year|yr|u|h|m|d|w|j|y)\b/);
  if (!m) return /seconde|second|zojuist|just now|een paar/.test(w) ? 0 : 99;
  const k = Number(m[1]); const u = m[2];
  if (/^(mnd|maand|month|mo)$/.test(u)) return k * 30; if (/^(min|m)$/.test(u)) return k / 1440; if (/^(uur|hour|hr|u|h)$/.test(u)) return k / 24;
  if (/^(dag|day|d)$/.test(u)) return k; if (/^(week|wk|w)$/.test(u)) return k * 7; return k * 365;
}

/** Posts to watch = the configured list plus any post of the owner's that another watcher's feed
 *  (the notifications one) has seen activity on. Persisted back into the config, deduped by post id. */
function discover(wid, cfg, feed) {
  const urls = Array.isArray(cfg.postUrls) ? cfg.postUrls.slice() : [];
  const ids = new Set(urls.map((u) => postIdOf(u)).filter(Boolean));
  const from = cfg.discoverFrom || 'facebook-notifications-watcher';
  if (from && from !== wid) {
    for (const it of feed.list(from)) {
      const t = String(it.title || '') + ' ' + String((it.fields || {}).detail || '');
      if (!/(je bericht|your post|jouw bericht|je opmerking|jouw opmerking|je reactie|jouw reactie|your comment|your reply)/i.test(t)) continue;
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
      const mine = /(je bericht|jouw bericht|your post)/i.test(txt);
      // a reply to a COMMENT of the owner's on someone else's post: a conversation the owner started there
      const theirs = !mine && /(je opmerking|jouw opmerking|je reactie|jouw reactie|your comment|your reply|op je reactie|op je opmerking)/i.test(txt);
      if (!mine && !theirs) continue;
      let u; try { u = new URL(href); } catch (e) { continue; }
      const pid = u.searchParams.get('post_id') || (u.pathname.match(/\/posts\/(\d+)/) || [])[1] || '';
      const g = (u.pathname.match(/\/groups\/([^/?]+)/) || [])[1] || '';
      if (!pid || !g || seen.has(pid)) continue;
      seen.add(pid); out.push({ postId: pid, group: g, text: txt.slice(0, 120), theirs });
    }
    return out;
  }).catch(() => []);
  if (log) log.info(`[post-watch] notifications page: ${found.filter((f) => !f.theirs).length} post(s) of yours with activity, ${found.filter((f) => f.theirs).length} thread(s) of yours under other people's posts`);
  const urls = found.map((f) => `https://www.facebook.com/groups/${f.group}/posts/${f.postId}/`);
  urls.theirs = found.filter((f) => f.theirs).map((f) => f.postId);
  urls.mine = found.filter((f) => !f.theirs).map((f) => f.postId);
  return urls;
}

/** Ground truth for one comment link, as the watcher's own session sees it: what the reader reads there (every
 *  comment with its author, who it answers and its first words), the count Facebook shows, the Reply controls,
 *  and the reveal controls still closed. The same in every layout, because it IS the reader. */
async function probePage(page, url, opts) {
  const { settle } = require('./inspector');
  await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await settle(page); } catch { /* still rendering */ }
  await page.waitForTimeout(4000);
  let expand = null;
  if (opts && opts.expand) { const { candidates, press } = helpers(page); expand = await expandAll(page, candidates, press); }
  const t = await page.evaluate(extractInPage);
  const dump = {
    url: page.url(), count: t.nodes.length, shownCount: t.shownCount, replyControls: t.replyControls, broken: readerBroken(t),
    postAuthor: t.postAuthor, postText: String(t.postText || '').slice(0, 160),
    items: t.nodes.slice(0, 80).map((n) => ({ id: n.id, author: n.author, replyTo: n.replyTo, isReply: n.isReply, when: n.when, text: String(n.text || '').replace(/\s+/g, ' ').slice(0, 90) })),
  };
  dump.expand = expand;
  // fixtures: the rendered page itself, so the reader can be tested against real HTML offline
  // scripts left out: they are most of the bytes, run nothing in a fixture, and carry the session's tokens
  if (opts && opts.html) { try { dump.html = await page.evaluate(() => { const c = document.documentElement.cloneNode(true); c.querySelectorAll('script, noscript, link[rel="preload"], link[rel="modulepreload"]').forEach((x) => x.remove()); return '<!doctype html>' + c.outerHTML; }); } catch { dump.html = ''; } }
  return dump;
}

/**
 * THE POSTER, AS CODE, in any layout. Posting an approved reply is four deterministic steps, never an agent walk
 * (the agent burned a 50-step budget wandering Facebook's comment redirects). Open the comment's link, find THAT
 * comment with the reader (by Facebook's id, or by the fingerprint of its name and words, which is what the phone
 * gives), check nobody answered it meanwhile, press its own Reply, type the exact words into the box that opened
 * (a textarea on the phone, a rich editor on desktop), send, and prove the reply is on the page under the owner's
 * name. Never types twice. `dryRun` does everything except typing.
 */
async function postReply(page, url, text, opts) {
  const o = opts || {}; const meName = String(o.meName || '').trim().toLowerCase();
  const alive = () => { try { if (o.touch) o.touch(); } catch { /* best effort */ } };
  let u; try { u = new URL(url); } catch { return { posted: false, detail: 'bad url' }; }
  const rid = u.searchParams.get('reply_comment_id'); const cid = u.searchParams.get('comment_id');
  const targetId = rid || cid; if (!targetId) return { posted: false, detail: 'no comment id in the link' };
  const { dismissConsent, settle } = require('./inspector');
  const { candidates, press } = helpers(page);
  const land = async () => {
    await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { await dismissConsent(page); } catch { /* none */ }
    try { await settle(page); } catch { /* rendering */ }
    await page.waitForTimeout(3000); alive();
    // the target may sit behind a collapsed "N antwoorden bekijken": reveal what is on this page
    await expandAll(page, candidates, press, alive);
    return page.evaluate(extractInPage);
  };
  let tree = await land();
  let target = tree.nodes.find((n) => String(n.id) === String(targetId));
  if (!target) { await page.waitForTimeout(3000); tree = await land(); target = tree.nodes.find((n) => String(n.id) === String(targetId)); }
  if (!target) return { posted: false, detail: `comment ${targetId} not found on its page (tried twice; ${tree.nodes.length} comment(s) read there)` };
  // answered meanwhile? a later reply of the owner's TO this person, in this branch
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const idx = tree.nodes.indexOf(target);
  const branchRoot = target.isReply ? target.cid : target.id;
  const already = !!meName && tree.nodes.slice(idx + 1).some((n) => same(n.author, meName) && (n.cid === branchRoot || n.id === branchRoot) && (same(n.replyTo, target.author) || n.parentId === target.id));
  if (already) return { posted: false, alreadyAnswered: true, detail: 'already answered on the page' };
  // the read above marked each comment's own Reply control with the comment's id
  const rb = (await page.$$(`[data-gb-cid="${String(targetId).replace(/[^\w-]/g, '')}"]`))[0] || null;
  if (!rb) return { posted: false, detail: 'no Reply control under that comment' };
  if (o.dryRun) return { posted: false, dryRun: true, detail: `found ${target.author}'s comment ${targetId} and its Reply control; would type ${text.length} chars` };
  if (!(await press(rb))) return { posted: false, detail: 'its Reply control did not respond' };
  // the box that opened: whatever has the focus and takes text
  let kind = '';
  for (let i = 0; i < 12 && !kind; i++) {
    await page.waitForTimeout(400);
    kind = await page.evaluate(() => { const a = document.activeElement; if (!a) return ''; if (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') return 'field'; return a.getAttribute('contenteditable') === 'true' || a.getAttribute('role') === 'textbox' ? 'editor' : ''; }).catch(() => '');
  }
  if (!kind) return { posted: false, detail: 'reply box did not open' };
  await page.keyboard.type(text, { delay: 12 }); alive();
  await page.waitForTimeout(800);
  const probe = text.replace(/\s+/g, ' ').trim().slice(0, 40).toLowerCase();
  const seen = async () => { try { const t = await page.evaluate(extractInPage); return t.nodes.some((n) => same(n.author, meName) && String(n.text || '').replace(/\s+/g, ' ').toLowerCase().includes(probe)); } catch { return false; } };
  // the send control by its words or label, the one nearest the box (a textarea on the phone: Enter is a new line there)
  const findSend = () => page.evaluateHandle(() => {
    const a = document.activeElement; const ar = a ? a.getBoundingClientRect() : null;
    const SEND = /^(?:opmerking plaatsen|plaatsen|post|post comment|comment|reageren|verzenden|send|wyślij|opublikuj|skomentuj)$/i;
    const cands = Array.from(document.querySelectorAll('[role="button"], button, [aria-label]')).filter((b) => {
      if (b === a || !b.getClientRects().length) return false;
      const words = [(b.getAttribute('aria-label') || '').trim(), (b.textContent || '').replace(/\s+/g, ' ').trim()];
      return words.some((w) => SEND.test(w));
    });
    if (!ar) return cands[0] || null;
    const d = (b) => { const r = b.getBoundingClientRect(); return Math.hypot((r.left + r.right) / 2 - (ar.left + ar.right) / 2, (r.top + r.bottom) / 2 - (ar.top + ar.bottom) / 2); };
    return cands.sort((x, y) => d(x) - d(y))[0] || null;
  }).then((h) => h.asElement()).catch(() => null);
  if (kind === 'editor') {
    await page.keyboard.press('Enter');
    for (let i = 0; i < 12; i++) { await page.waitForTimeout(1000); if (await seen()) return { posted: true, detail: 'reply visible on the page with your name' }; }
  }
  const submit = await findSend();
  if (submit) {
    if (await press(submit)) for (let i = 0; i < 12; i++) { await page.waitForTimeout(1000); if (await seen()) return { posted: true, detail: 'reply visible on the page after pressing send' }; }
  }
  return { posted: false, typed: true, detail: 'typed but could not confirm it on the page — not retried (never twice)' };
}

function postIdOf(url) {
  try { const u = new URL(String(url)); return u.searchParams.get('post_id') || (u.pathname.match(/\/posts\/(\d+)/) || [])[1] || u.searchParams.get('story_fbid') || null; } catch { return null; }
}

module.exports = { readerBroken, markControls, crawl, store, ingest, verifyWaiting, draftAll, discover, discoverOnPage, dueUrls, cadenceOf, rememberVoice, probePage, postReply, postIdOf, extractInPage, cleanName, VOICE };
