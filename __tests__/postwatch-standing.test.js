/**
 * The standing rules of the post watcher, as regression tests — every rule that was learned the hard
 * way on the live post (2026-09-16/17) is pinned here so it cannot silently regress:
 *   - a root comment is the owner's to answer; a reply is, only when it is TO the owner, @mentions
 *     them, or the root author continues their own thread after being answered
 *   - people talking to each other under the post = side conversation (hidden, never drafted)
 *   - answered = a LATER reply of the owner's TO that author (replying to Dennis does not answer Peter)
 *   - a like from the owner counts as acknowledged
 *   - the owner's own messages are never "waiting"
 * Pure: an in-memory feed, no browser.
 */
import { describe, it, expect } from 'vitest';
import { ingest } from '../src/postWatch.js';

function fakeFeed() {
  const items = {};
  const keyOf = (item) => item.url;
  return {
    items,
    upsert(wid, item) { const k = keyOf(item); if (!items[k]) items[k] = { key: k, handled: false, fields: {}, ...item }; return { item: items[k], isNew: true }; },
    mark(wid, key, patch) { Object.assign(items[key], patch); return true; },
    list() { return Object.values(items); },
  };
}
// root: 0 is a valid root id — test presence, not truthiness
const N = (i, author, text, o = {}) => { const r = o.root !== undefined; return { i, id: String(o.id !== undefined ? o.id : i), cid: r ? String(o.root) : String(i), rid: r ? String(i) : null, isReply: r, author, replyTo: o.to || '', reactedByMe: !!o.reacted, text, when: '1 u', parentId: r ? String(o.root) : null }; };
const tree = (nodes) => ({ postId: 'P', group: 'g', postText: 'my post', postAuthor: 'Wesley Stoep', me: '', nodes });
const cfg = { meName: 'Wesley Stoep' };
const statusOf = (feed, author, text) => Object.values(feed.items).find((it) => it.fields.author === author && it.fields.said === text).fields.status;

describe('post watcher standing', () => {
  it('a root comment with no answer waits on the owner; one the owner replied to is answered', () => {
    const feed = fakeFeed();
    const out = ingest('w', tree([N(0, 'Adam', 'usually something better comes along'), N(1, 'Mike', 'takes understanding'), N(2, 'Wesley Stoep', 'agreed', { root: 1, to: 'Mike' })]), cfg, feed);
    expect(statusOf(feed, 'Adam', 'usually something better comes along')).toBe('waiting on you');
    expect(statusOf(feed, 'Mike', 'takes understanding')).toBe('answered');
    expect(out.filter((e) => e.needsReply).map((e) => e.node.author)).toEqual(['Adam']);
  });

  it('replying to Dennis does not answer Peter; Peter waits', () => {
    const feed = fakeFeed();
    ingest('w', tree([N(0, 'Dennis', 'the post is AI'), N(1, 'Peter', 'so?', { root: 0, to: 'Wesley Stoep' }), N(2, 'Wesley Stoep', 'fair, Dennis', { root: 0, to: 'Dennis' })]), cfg, feed);
    expect(statusOf(feed, 'Dennis', 'the post is AI')).toBe('answered');
    expect(statusOf(feed, 'Peter', 'so?')).toBe('waiting on you');
  });

  it('people talking to each other under the post are a side conversation, hidden and undrafted', () => {
    const feed = fakeFeed();
    const out = ingest('w', tree([N(0, 'Jordan', '4 months to build'), N(1, 'Joe', 'what are you learning?', { root: 0, to: 'Jordan' }), N(2, 'Jordan', 'a ton', { root: 0, to: 'Joe' }), N(3, 'Wesley Stoep', 'smart setup', { root: 0, to: 'Jordan' })]), cfg, feed);
    expect(statusOf(feed, 'Joe', 'what are you learning?')).toBe('side conversation');
    expect(Object.values(feed.items).find((it) => it.fields.author === 'Joe').handled).toBe(true);
    expect(out.some((e) => e.needsReply)).toBe(false);
  });

  it('an @mention of the owner inside someone else\'s thread is the owner\'s to answer', () => {
    const feed = fakeFeed();
    ingest('w', tree([N(0, 'Joe', 'probably a wrapper'), N(1, 'Wesley Stoep', 'not a wrapper', { root: 0, to: 'Joe' }), N(2, 'Joe', 'Wesley Stoep cut a video and I would review it', { root: 0, to: 'Joe' })]), cfg, feed);
    expect(statusOf(feed, 'Joe', 'Wesley Stoep cut a video and I would review it')).toBe('waiting on you');
  });

  it('the root author continuing their own thread after the owner answered is waiting; answered once the owner replies again', () => {
    const feed1 = fakeFeed();
    ingest('w', tree([N(0, 'Peter', '80/20'), N(1, 'Wesley Stoep', 'congrats, which game?', { root: 0, to: 'Peter' }), N(2, 'Peter', 'The Curse of Dracula', { root: 0, to: 'Peter' })]), cfg, feed1);
    expect(statusOf(feed1, 'Peter', 'The Curse of Dracula')).toBe('waiting on you');
    const feed2 = fakeFeed();
    ingest('w', tree([N(0, 'Peter', '80/20'), N(1, 'Wesley Stoep', 'congrats, which game?', { root: 0, to: 'Peter' }), N(2, 'Peter', 'The Curse of Dracula', { root: 0, to: 'Peter' }), N(3, 'Wesley Stoep', 'just checked the link', { root: 0, to: 'Peter' })]), cfg, feed2);
    expect(statusOf(feed2, 'Peter', 'The Curse of Dracula')).toBe('answered');
  });

  it('a like from the owner counts as acknowledged', () => {
    const feed = fakeFeed();
    const out = ingest('w', tree([N(0, 'Ramon', 'nada', { reacted: true })]), cfg, feed);
    expect(statusOf(feed, 'Ramon', 'nada')).toBe('you reacted');
    expect(out.some((e) => e.needsReply)).toBe(false);
  });

  it('the owner\'s own messages are never waiting and are handled', () => {
    const feed = fakeFeed();
    ingest('w', tree([N(0, 'Ilya', 'my stack'), N(1, 'Wesley Stoep', 'clean stack', { root: 0, to: 'Ilya' })]), cfg, feed);
    const mine = Object.values(feed.items).find((it) => it.fields.author === 'Wesley Stoep');
    expect(mine.fields.status).toBe('you'); expect(mine.handled).toBe(true);
  });
});
