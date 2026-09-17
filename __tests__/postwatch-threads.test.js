/**
 * Threads the owner STARTED on someone else's post get the post-watcher treatment: only branches the
 * owner is in count, a reply to the owner waits on them, other people's root comments are not the
 * owner's business there, and the items say whose post it is. Pure: in-memory feed, no browser.
 */
import { describe, it, expect } from 'vitest';
import { ingest } from '../src/postWatch.js';

function fakeFeed() {
  const items = {};
  return {
    items,
    upsert(wid, item) { const k = item.url; if (!items[k]) items[k] = { key: k, handled: false, fields: {}, ...item }; return { item: items[k], isNew: true }; },
    mark(wid, key, patch) { Object.assign(items[key], patch); return true; },
    list() { return Object.values(items); },
  };
}
const N = (i, author, text, o = {}) => { const r = o.root !== undefined; return { i, id: String(o.id !== undefined ? o.id : i), cid: r ? String(o.root) : String(i), rid: r ? String(i) : null, isReply: r, author, replyTo: o.to || '', reactedByMe: !!o.reacted, text, when: '1 u', parentId: r ? String(o.root) : null }; };
const theirPost = (nodes) => ({ postId: 'Q', group: 'g', postText: 'Ilya: my auth stack is entra + supabase', postAuthor: 'Ilya Elbert', me: '', nodes });
const cfg = { meName: 'Wesley Stoep' };
const item = (feed, author, text) => Object.values(feed.items).find((it) => it.fields.author === author && it.fields.said === text);

describe("threads the owner started on other people's posts", () => {
  it('a reply to the owner\'s comment waits on the owner; the post author\'s and a stranger\'s alike', () => {
    const feed = fakeFeed();
    const out = ingest('w', theirPost([
      N(0, 'Wesley Stoep', 'super clean stack'),
      N(1, 'Ilya Elbert', 'i was so angry at entra lol', { root: 0, to: 'Wesley Stoep' }),
      N(2, 'Dennis', 'same here, 7 keys per app', { root: 0, to: 'Wesley Stoep' }),
    ]), cfg, feed);
    expect(item(feed, 'Ilya Elbert', 'i was so angry at entra lol').fields.status).toBe('waiting on you');
    expect(item(feed, 'Dennis', 'same here, 7 keys per app').fields.status).toBe('waiting on you');
    expect(out.filter((e) => e.needsReply).map((e) => e.node.author)).toEqual(['Ilya Elbert', 'Dennis']);
    const it_ = item(feed, 'Ilya Elbert', 'i was so angry at entra lol');
    expect(it_.title).toBe("Ilya Elbert replied to you on Ilya Elbert's post");
    expect(it_.fields.theirs).toBe(true); expect(it_.fields.postAuthor).toBe('Ilya Elbert'); expect(it_.fields.postTitle).toMatch(/^Ilya Elbert: /);
  });

  it('root comments by other people on their post are not the owner\'s; branches without the owner are left out entirely', () => {
    const feed = fakeFeed();
    ingest('w', theirPost([
      N(0, 'Wesley Stoep', 'super clean stack'),
      N(1, 'Peter', 'nice post Ilya'),
      N(2, 'Ilya Elbert', 'thanks Peter', { root: 1, to: 'Peter' }),
      N(3, 'Ilya Elbert', 'glad you like it Wesley', { root: 0, to: 'Wesley Stoep' }),
    ]), cfg, feed);
    expect(item(feed, 'Peter', 'nice post Ilya')).toBeUndefined();
    expect(item(feed, 'Ilya Elbert', 'thanks Peter')).toBeUndefined();
    expect(item(feed, 'Ilya Elbert', 'glad you like it Wesley').fields.status).toBe('waiting on you');
  });

  it('answered once the owner replies back to that person; the owner\'s own comment is never waiting', () => {
    const feed = fakeFeed();
    ingest('w', theirPost([
      N(0, 'Wesley Stoep', 'super clean stack'),
      N(1, 'Ilya Elbert', 'i was so angry at entra lol', { root: 0, to: 'Wesley Stoep' }),
      N(2, 'Wesley Stoep', 'haha the policy maze is unreal', { root: 0, to: 'Ilya Elbert' }),
    ]), cfg, feed);
    expect(item(feed, 'Ilya Elbert', 'i was so angry at entra lol').fields.status).toBe('answered');
    expect(item(feed, 'Wesley Stoep', 'super clean stack').fields.status).toBe('you');
    expect(item(feed, 'Wesley Stoep', 'super clean stack').handled).toBe(true);
  });

  it('the owner\'s own post still works as before (root comments wait)', () => {
    const feed = fakeFeed();
    ingest('w', { postId: 'P', group: 'g', postText: 'my post', postAuthor: 'Wesley Stoep', me: '', nodes: [N(0, 'Adam', 'nice')] }, cfg, feed);
    expect(item(feed, 'Adam', 'nice').fields.status).toBe('waiting on you'); expect(item(feed, 'Adam', 'nice').fields.theirs).toBe(false);
  });
});
