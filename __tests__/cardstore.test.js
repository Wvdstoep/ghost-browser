/**
 * cardstore — cards persisted beside the sessions. The properties worth pinning: it round-trips a
 * card, an unreadable/absent store degrades to empty (every intent walks the UI, not a crash), and
 * a write failure is never fatal (the whole mechanism is an optimisation on top of a working
 * browser). Real fs in a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeCardStore } from '../src/cardstore.js';
import { distill, onVerified } from '../src/routecards.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const aCard = () => onVerified(distill({
  intent: 'facebook.page.post', origin: 'https://www.facebook.com',
  requests: [{ method: 'POST', url: 'https://www.facebook.com/api/graphql/', headers: { 'x-fb-lsd': 'x' }, postData: '{"text":"hi"}' }],
  now: 1,
}).card, 2);

describe('cardstore round-trips', () => {
  it('put then get returns the card; a fresh reader sees it from disk', () => {
    const s = makeCardStore({ dir });
    s.put(aCard());
    expect(s.get('https://www.facebook.com', 'facebook.page.post').lastVerified).toBe(2);
    const reader = makeCardStore({ dir });   // separate instance, reads the file
    expect(reader.get('https://www.facebook.com', 'facebook.page.post')).toBeTruthy();
  });

  it('forget removes it from disk', () => {
    const s = makeCardStore({ dir });
    s.put(aCard());
    s.forget('https://www.facebook.com', 'facebook.page.post');
    expect(makeCardStore({ dir }).get('https://www.facebook.com', 'facebook.page.post')).toBeNull();
  });

  it('findByIntent locates a card whichever origin it was learned on, and prefers a healthy one', () => {
    const s = makeCardStore({ dir });
    s.put(aCard());   // origin www.facebook.com, intent facebook.page.post
    // a walk that thinks in a different subdomain still finds it by intent
    expect(s.findByIntent('facebook.page.post')).toBeTruthy();
    expect(s.findByIntent('facebook.page.post').origin).toBe('https://www.facebook.com');
    expect(s.findByIntent('nothing.here')).toBeNull();
  });

  it('findByIntent falls back to a quarantined card only when no healthy one exists', () => {
    const s = makeCardStore({ dir });
    const q = { ...aCard(), origin: 'https://m.facebook.com', quarantined: true };
    const good = { ...aCard(), origin: 'https://www.facebook.com', quarantined: false };
    s.put(q); s.put(good);
    expect(s.findByIntent('facebook.page.post').quarantined).toBe(false);   // the healthy one wins
    s.forget('https://www.facebook.com', 'facebook.page.post');
    expect(s.findByIntent('facebook.page.post').quarantined).toBe(true);    // now only the quarantined one is left
  });

  it('list is shapes only — safe to render, no token values', () => {
    const s = makeCardStore({ dir });
    s.put(aCard());
    expect(JSON.stringify(s.list())).not.toMatch(/x-fb-lsd.*:.*"x"/);   // the NAME may appear, the VALUE never
    expect(s.list()).toHaveLength(1);
  });
});

describe('a broken store degrades to empty, never crashes', () => {
  it('absent file → empty store, every intent walks the UI', () => {
    const s = makeCardStore({ dir: path.join(dir, 'does-not-exist-yet') });
    expect(s.list()).toEqual([]);
    expect(s.get('https://x', 'y')).toBeNull();
  });

  it('garbage file → empty store, not a throw', () => {
    fs.writeFileSync(path.join(dir, 'route-cards.json'), '{ not json');
    const s = makeCardStore({ dir });
    expect(s.list()).toEqual([]);
  });

  it('an unwritable dir makes put best-effort, never fatal', () => {
    const s = makeCardStore({ dir, file: path.join('no', 'such', 'nested', 'x.json') });
    expect(() => s.put(aCard())).not.toThrow();
  });
});
