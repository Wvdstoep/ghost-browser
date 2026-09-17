/**
 * The extractor against REAL Facebook pages, saved as fixtures (captured with the watcher's probe,
 * `html:true`). Every DOM fact learned on the live post is pinned here: comment/reply articles by
 * aria-label, author + reply target from the label with the time suffix stripped, the Follow badge
 * kept out of the text, the hidden duplicate copy ignored, the post body found and not a sidebar
 * suggestion. Runs the page in a real Chromium (layout matters: visibility is part of the rules).
 * Skips cleanly when the fixtures or the browser are not on this machine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractInPage } from '../src/postWatch.js';

const FIX = path.join(__dirname, 'fixtures', 'fb');
const have = (f) => fs.existsSync(path.join(FIX, f));
let chromium = null;
try { chromium = (await import('playwright')).chromium; } catch { chromium = null; }

const canRun = !!chromium && have('post-page.html');
describe.skipIf(!canRun)('post watcher extractor on real pages', () => {
  let browser, page;
  beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 1280, height: 2400 } }); }, 60000);
  afterAll(async () => { try { await browser.close(); } catch { /* gone */ } });

  const load = async (file, url) => {
    const html = fs.readFileSync(path.join(FIX, file), 'utf8');
    await page.goto(url, { waitUntil: 'commit' }).catch(() => {});   // location.href carries the ids
    await page.route('**/*', (r) => r.abort()).catch(() => {});
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return page.evaluate(extractInPage);
  };

  it('post page: root comments with clean authors, no time suffix, no Follow badge in the text', async () => {
    const t = await load('post-page.html', 'https://www.facebook.com/groups/vibecodinglife/posts/2137606046827921/');
    expect(t.postId).toBe('2137606046827921');
    expect(t.nodes.length).toBeGreaterThan(5);
    for (const n of t.nodes) {
      expect(n.author).not.toMatch(/geleden|ago|\d+\s*u$/i);
      expect(n.text).not.toMatch(/^volgen$|^follow$/i);
      expect(n.author).not.toMatch(/ op (het antwoord|de opmerking) van /i);
    }
    expect(t.postText).toMatch(/70% wall/i);                       // the post, not a sidebar suggestion
    expect(new Set(t.nodes.map((n) => n.id)).size).toBe(t.nodes.length);   // hidden copy deduped
  }, 60000);

  it.skipIf(!have('reply-page.html'))('reply page: author AND reply target come from the label, replies-to-replies present', async () => {
    const t = await load('reply-page.html', 'https://www.facebook.com/groups/vibecodinglife/posts/2137606046827921/?comment_id=2137644956824030&reply_comment_id=2138317006756825');
    const replies = t.nodes.filter((n) => n.isReply);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.some((n) => n.replyTo && n.replyTo.length > 2)).toBe(true);
    const mine = t.nodes.filter((n) => /wesley stoep/i.test(n.author));
    expect(mine.length).toBeGreaterThan(0);
    for (const n of replies) { expect(n.cid).toBeTruthy(); expect(n.rid || n.id).toBeTruthy(); }
  }, 60000);
});
