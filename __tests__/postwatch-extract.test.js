/**
 * The extractor against REAL Facebook pages, saved as gzipped fixtures (captured with the watcher's
 * probe, `html:true`). Every DOM fact learned on the live post is pinned here: comment/reply articles
 * by aria-label, author + reply target from the label with the time suffix stripped, the Follow badge
 * kept out of the text, the hidden duplicate copy ignored, the post body found and not a sidebar
 * suggestion. Runs the page in a real Chromium (layout matters: visibility is part of the rules).
 * Skips cleanly where the fixtures or a launchable Chromium are not present (the VPS host has no
 * browser deps; the pod image and CI do).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractInPage, markControls, readerBroken, postReply } from '../src/postWatch.js';
import { createRequire } from 'node:module';
const { EXPAND } = (() => { const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'postWatch.js'), 'utf8'); return { EXPAND: eval(src.match(/^const EXPAND = (\/.*\/i);/m)[1]) }; })();
void createRequire;

const FIX = path.join(__dirname, 'fixtures', 'fb');
const have = (f) => fs.existsSync(path.join(FIX, f + '.gz'));
const read = (f) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, f + '.gz'))).toString('utf8');

let chromium = null, browser = null;
try { chromium = (await import('playwright')).chromium; } catch { chromium = null; }
if (chromium && have('post-page.html')) {
  try { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }); }
  catch (e) { browser = null; console.warn(`[postwatch-extract] no launchable Chromium here (${String(e.message).split('\n')[0]}) — skipping; runs in the pod image / CI`); }
}

describe.skipIf(!browser)('post watcher extractor on real pages', () => {
  let page;
  beforeAll(async () => { page = await browser.newPage({ viewport: { width: 1280, height: 2400 } }); }, 60000);
  afterAll(async () => { try { await browser.close(); } catch { /* gone */ } });

  /* The saved page is SERVED at its real address (location.href carries the ids); everything else it asks for
     is refused. Navigating with every request aborted and then injecting the HTML raced: "Execution context
     was destroyed" whenever the error page landed after setContent. */
  const load = async (file, url) => {
    const html = read(file);
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    // the post at any of its addresses (a comment link adds ?comment_id=...), nothing else
    const base = url.split('?')[0];
    await page.route('**/*', (r) => (r.request().url().split('?')[0] === base ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }) : r.abort()));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return page.evaluate(extractInPage);
  };

  it('post page: root comments with clean authors, no time suffix, no Follow badge in the text, the post itself', async () => {
    const t = await load('post-page.html', 'https://www.facebook.com/groups/vibecodinglife/posts/2137606046827921/');
    expect(t.postId).toBe('2137606046827921');
    expect(t.nodes.length).toBeGreaterThan(5);
    for (const n of t.nodes) {
      expect(n.author).not.toMatch(/geleden|ago|\d+\s*u$/i);
      expect(n.text).not.toMatch(/^volgen$|^follow$/i);
      expect(n.author).not.toMatch(/ op (het antwoord|de opmerking) van /i);
    }
    expect(t.postText).toMatch(/70% wall/i);                                  // the post, not a sidebar suggestion
    expect(new Set(t.nodes.map((n) => n.id)).size).toBe(t.nodes.length);    // one node per id
  }, 60000);

  it.skipIf(!have('reply-page.html'))('reply page: author AND reply target from the label, replies-to-replies present, owner recognised', async () => {
    const t = await load('reply-page.html', 'https://www.facebook.com/groups/vibecodinglife/posts/2137606046827921/?comment_id=2137644956824030&reply_comment_id=2138317006756825');
    const replies = t.nodes.filter((n) => n.isReply);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.some((n) => n.replyTo && n.replyTo.length > 2)).toBe(true);
    expect(t.nodes.some((n) => /wesley stoep/i.test(n.author))).toBe(true);
    for (const n of replies) { expect(n.cid).toBeTruthy(); expect(n.rid || n.id).toBeTruthy(); }
  }, 60000);

  /* ONE READER FOR EVERY LAYOUT (2026-11-21). mobile-post-page.html is the owner's post as their phone showed it
     (probe on SM-F926B, scripts left out): Facebook's mobile layout, which the old reader read as "0 messages". */
  const MOBILE = 'https://www.facebook.com/groups/vibecodinglife/posts/2140662833188909/';
  const loadMobile = async () => { await page.setViewportSize({ width: 412, height: 915 }); try { return await load('mobile-post-page.html', MOBILE); } finally { await page.setViewportSize({ width: 1280, height: 2400 }); } };

  it.skipIf(!have('mobile-post-page.html'))('phone layout: every comment, with its author, its words, and replies under the comment they answer', async () => {
    const t = await loadMobile();
    expect(t.postId).toBe('2140662833188909');
    expect(t.postAuthor).toBe('Wesley Stoep');
    expect(t.postText).toMatch(/^Something I have been chewing on watching this group\./);
    expect(t.nodes.length).toBeGreaterThanOrEqual(20);
    expect(readerBroken(t)).toBe('');
    const roots = t.nodes.filter((n) => !n.isReply);
    expect(roots.map((n) => n.author)).toEqual(expect.arrayContaining(['Adam Zen Wine', 'Karl Hennigan', 'Pushap Raj Verma', 'Michelle Renee', 'Cade Parkes']));
    // the owner's answer to Adam: a reply, to Adam, in Adam's branch, the @mention taken off the words
    const adam = t.nodes.find((n) => n.author === 'Adam Zen Wine');
    const answer = t.nodes.find((n) => n.author === 'Wesley Stoep' && /^Fair, and honestly you're right/.test(n.text));
    expect(answer).toMatchObject({ isReply: true, replyTo: 'Adam Zen Wine', cid: adam.id, parentId: adam.id });
    // Karl's branch: Karl, the owner, Karl again, the owner again, each answering the one before
    const karl = t.nodes.filter((n) => n.cid === t.nodes.find((x) => x.author === 'Karl Hennigan' && !x.isReply).id);
    expect(karl.map((n) => `${n.author}>${n.replyTo || ''}`)).toEqual(['Karl Hennigan>', 'Wesley Stoep>Karl Hennigan', 'Karl Hennigan>Wesley Stoep', 'Wesley Stoep>Karl Hennigan']);
    for (const n of t.nodes) {
      expect(n.text).not.toMatch(/[-]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/);   // Facebook's icon font is never words
      expect(n.text).not.toMatch(/^(Beantwoorden|Leuk|Auteur)$/m);
      expect(n.author).not.toMatch(/^(Auteur|·)$/);
      expect(n.when).toMatch(/mnd/);
    }
  }, 60000);

  it.skipIf(!have('mobile-post-page.html'))('phone layout: a comment has the same id on every read (a fingerprint of its name and words: the phone gives no comment links)', async () => {
    const a = await loadMobile(); const b = await loadMobile();
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(new Set(a.nodes.map((n) => n.id)).size).toBe(a.nodes.length);
    for (const n of a.nodes) expect(n.id).toMatch(/^v[0-9a-z]+$/);
  }, 60000);

  it('desktop layout: Facebook\'s own ids, the post\'s author, and "1 antwoord bekijken" never in what someone wrote', async () => {
    const t = await load('post-page.html', 'https://www.facebook.com/groups/vibecodinglife/posts/2137606046827921/');
    expect(t.postAuthor).toBe('Wesley Stoep');
    expect(t.nodes.length).toBeGreaterThanOrEqual(30);
    for (const n of t.nodes) { expect(n.id).toMatch(/^\d+$/); expect(n.text).not.toMatch(/antwoorden? bekijken|view \d+ repl/i); }
    expect(t.nodes.find((n) => n.author === 'Mike Chytráček').text).toBe("It's because development takes understanding of development.");
    expect(readerBroken(t)).toBe('');
  }, 60000);

  it('the "open more" controls are found by their words, never the Reply control itself', async () => {
    await load('post-page.html', 'https://www.facebook.com/groups/vibecodinglife/posts/2137606046827921/');
    const n = await page.evaluate(markControls, { src: EXPAND.source, flags: EXPAND.flags, tag: 't1' });
    const words = await page.$$eval('[data-gb-ctl="t1"]', (els) => els.map((e) => e.textContent.trim()));
    expect(n).toBeGreaterThan(0);
    expect(words).toContain('1 antwoord bekijken');      // "antwoorden?" never matched the singular: it stayed closed
    for (const w of words) expect(w).not.toMatch(/^(beantwoorden|antwoorden|reply)$/i);
  }, 60000);

  it.skipIf(!have('mobile-post-page.html'))('the poster finds a comment on the phone layout by its fingerprint, and its own Reply (dry run)', async () => {
    const t = await loadMobile();
    const michelle = t.nodes.find((n) => n.author === 'Michelle Renee');
    const salah = t.nodes.find((n) => n.author === 'Salah Junior Dev');
    await page.setViewportSize({ width: 412, height: 915 });
    try {
      const r = await postReply(page, `${MOBILE}?comment_id=${salah.id}`, 'Thanks Salah', { meName: 'Wesley Stoep', dryRun: true });
      expect(r).toMatchObject({ dryRun: true });
      expect(r.detail).toMatch(/Salah Junior Dev/);
      // already answered by the owner (Wesley's "Love it Michelle"): the real run would not post
      const live = await postReply(page, `${MOBILE}?comment_id=${michelle.id}`, 'Thanks Michelle', { meName: 'Wesley Stoep' });
      expect(live).toMatchObject({ posted: false, alreadyAnswered: true });
    } finally { await page.setViewportSize({ width: 1280, height: 2400 }); }
  }, 120000);
});

describe('the reader checks itself', () => {
  it('Reply controls on the page but nothing read is broken (the phone\'s first pass read "0 messages" in silence)', () => {
    expect(readerBroken({ nodes: [], replyControls: 23 })).toMatch(/23 Reply control/);
  });
  it('far fewer comments than Facebook shows is broken; a quiet post or a close count is not', () => {
    expect(readerBroken({ nodes: new Array(3).fill({}), shownCount: 26 })).toMatch(/shows 26 comments, 3 read/);
    expect(readerBroken({ nodes: new Array(20).fill({}), shownCount: 26 })).toBe('');
    expect(readerBroken({ nodes: [], replyControls: 0, shownCount: 0 })).toBe('');
  });
  it('"1 antwoord bekijken" opens more; a bare Reply word never does', () => {
    for (const t of ['1 antwoord bekijken', '3 antwoorden bekijken', 'Alle 7 antwoorden bekijken', 'View 1 reply', 'View all 3 replies', 'Meer opmerkingen weergeven']) expect(EXPAND.test(t), t).toBe(true);
    for (const t of ['Beantwoorden', 'Antwoorden', 'Reply', 'Comments', 'Opmerkingen']) expect(EXPAND.test(t), t).toBe(false);
  });
});
