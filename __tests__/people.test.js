/**
 * People memory across posts and outcome learning: exchanges land on the right person, promises /
 * asks / commercial signals are picked out, the drafter's profile reads right and excludes the current
 * post, outcomes classify as-is / edited / rewritten and keep lessons, leads list. Temp PROFILE_DIR.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let people;
beforeAll(async () => { process.env.PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-')); people = await import('../src/people.js'); });

const me = 'Wesley Stoep';
const isMe = (n) => String(n.author || '').toLowerCase() === me.toLowerCase();
const node = (id, author, text, extra = {}) => ({ id, author, text, isReply: !!extra.replyTo, replyTo: extra.replyTo || '', when: extra.when || '', i: Number(id.replace(/\D/g, '')) });
function entriesOf(branch) { return branch.map((n) => ({ node: n, branch, isMe, needsReply: !isMe(n) && (!n.isReply || n.replyTo === me) })); }

describe('people memory', () => {
  it('remembers exchanges per person with promises, asks and commercial signals, across posts', () => {
    const b1 = [node('c1', 'Ilya Elbert', 'Which stack do you use for auth? Entra was brutal'), node('c2', me, "I'll put together a walkthrough on the Entra part", { replyTo: 'Ilya Elbert' }), node('c3', 'Ilya Elbert', 'i was so angry at entra with all the policies lol', { replyTo: me })];
    const touched = people.remember('facebook', { postId: 'p1', postText: 'Vibe coding post', nodes: b1 }, entriesOf(b1), { now: 1000, urlOf: (n) => 'https://fb/' + n.id });
    expect(touched).toEqual(['Ilya Elbert']);
    const b2 = [node('c9', 'Ilya Elbert', 'what does it cost to have you build this for us?')];
    people.remember('facebook', { postId: 'p2', postText: 'Second post', nodes: b2 }, entriesOf(b2), { now: 2000 });
    const r = people.load('facebook', 'Ilya Elbert');
    expect(r.exchanges.map((x) => x.who)).toEqual(['them', 'you', 'them', 'them']);
    expect(Object.keys(r.posts)).toEqual(['p1', 'p2']);
    expect(r.promises[0].text).toMatch(/put together a walkthrough/);
    expect(r.asks[0].text).toMatch(/Which stack/);
    expect(r.signals[0].text).toMatch(/what does it cost/); expect(r.signals[0].postId).toBe('p2');
    expect(people.isLead('facebook', 'Ilya Elbert')).toBe(true);
    // c3 came after the owner's c2 in the same branch: he came back — the outcome a reply is for
    expect(r.outcomes.repliedBack).toBe(1);
    expect(people.worthOf(r)).toBeGreaterThanOrEqual(60); expect(people.worthOf(null)).toBe(0);
    // a second pass over the same branch adds nothing twice
    people.remember('facebook', { postId: 'p1', postText: 'Vibe coding post', nodes: b1 }, entriesOf(b1), { now: 3000 });
    expect(people.load('facebook', 'Ilya Elbert').exchanges.length).toBe(4);
  });

  it('leaves side conversations out and starts a record only for people the owner talks with', () => {
    const b = [node('d1', 'Peter', 'nice game'), node('d2', 'Dennis', 'meh', { replyTo: 'Peter' })];
    const entries = [{ node: b[0], branch: b, isMe, needsReply: true }, { node: b[1], branch: b, isMe, needsReply: false }];
    people.remember('facebook', { postId: 'p3', postText: 'x', nodes: b }, entries, { now: 4000 });
    expect(people.load('facebook', 'Peter').exchanges.length).toBe(1);
    // Dennis talked to Peter, not to the owner — but the branch holds no owner reply, so Dennis is "them" on a root-less…
    // …no: he is a reply not to the owner in a branch without the owner: not remembered
    expect(people.load('facebook', 'Dennis')).toBeNull();
  });

  it('gives the drafter a profile that excludes the current post and carries the promise and the signal', () => {
    const p = people.profileOf('facebook', 'Ilya Elbert', { exceptPostId: 'p2' });
    expect(p).toMatch(/PERSON MEMORY — Ilya Elbert: 4 exchange/); expect(p).toMatch(/"Vibe coding post"/); expect(p).not.toMatch(/"Second post"/);
    expect(p).toMatch(/You promised them/); expect(p).toMatch(/COMMERCIAL SIGNAL/); expect(p).toMatch(/never re-promise/);
    expect(people.profileOf('facebook', 'Nobody')).toBe('');
  });

  it('classifies outcomes and keeps rewrites as lessons the drafter reads', () => {
    expect(people.recordOutcome('facebook', 'Ilya Elbert', { draft: 'Thanks Ilya, that is fair.', posted: 'Thanks Ilya, that is fair.' }).kind).toBe('asIs');
    expect(people.recordOutcome('facebook', 'Ilya Elbert', { draft: 'Thanks Ilya, that is a fair point about Entra and the keys.', posted: 'Thanks Ilya, that is a fair point about Entra and keys!' }).kind).toBe('edited');
    expect(people.recordOutcome('facebook', 'Ilya Elbert', { draft: 'Great question! Absolutely, I would be happy to elaborate on that.', posted: 'ha yeah entra is a pain' }).kind).toBe('rewritten');
    const o = people.outcomes(); expect(o).toMatchObject({ drafted: 3, asIs: 1, edited: 1, rewritten: 1, asIsRate: 33 });
    expect(people.editLessons()).toMatch(/drafted: "Great question!/); expect(people.editLessons()).toMatch(/posted:  "ha yeah entra/);
    expect(people.load('facebook', 'Ilya Elbert').outcomes).toMatchObject({ drafted: 3, asIs: 1, edited: 1, rewritten: 1, repliedBack: 1 });
  });

  it('lists people newest first and leads only on request', () => {
    const all = people.list('facebook'); expect(all.map((p) => p.name)).toEqual(['Peter', 'Ilya Elbert']);
    const leads = people.list('facebook', { leadsOnly: true }); expect(leads.map((p) => p.name)).toEqual(['Ilya Elbert']); expect(leads[0].signals[0]).toMatch(/cost/);
  });
});
