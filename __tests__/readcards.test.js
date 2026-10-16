/** readcards — the pure half: pick the request by what it returned, refuse an answer that changed shape. */
import { describe, it, expect } from 'vitest';
import { distillRead, buildReadReplay, judgeRead, findExtract, compareRows, isReadCandidate, slotsFor } from '../src/readcards.js';

const ui = [{ title: 'Alpha', by: 'ann' }, { title: 'Beta', by: 'bob' }];
const search = { hits: [{ id: 1, title: 'Alpha', author: 'ann' }, { id: 2, title: 'Beta', author: 'bob' }] };
const decoy = { suggestions: [{ text: 'Alpha' }] };
const cand = (url, json) => ({ method: 'GET', url, status: 200, headers: {}, json });

describe('which request is the card', () => {
  it('is the one whose answer reproduces the UI rows, not the decoy that half does', () => {
    const out = distillRead({ intent: 'x', origin: 'http://a', uiRows: ui, inputs: { query: 'al' }, now: 1,
      candidates: [cand('http://a/api/suggest?q=al', decoy), cand('http://a/api/search?query=al&n=20', search)] });
    expect(out.ok).toBe(true);
    expect(out.card.url).toContain('/api/search');
    expect(out.card.extract).toEqual({ listPath: 'hits', fields: { title: 'title', by: 'author' } });
    expect(out.card.urlSlots).toEqual([{ name: 'query', param: 'query' }]);
    expect(out.card.auth).toBe('none');
  });
  it('is nothing when no request explains the screen', () => {
    const out = distillRead({ intent: 'x', origin: 'http://a', uiRows: ui, candidates: [cand('http://a/api/suggest?q=a', decoy)] });
    expect(out.ok).toBe(false);
  });
  it('carries a token position when the request had one, so a logged-in read is still a card', () => {
    const c = { ...cand('http://a/api/search?query=al', search), headers: { authorization: 'Bearer SECRET123' } };
    const out = distillRead({ intent: 'x', origin: 'http://a', uiRows: ui, inputs: { query: 'al' }, candidates: [c] });
    expect(out.card.authAt).toEqual([{ in: 'header', name: 'authorization' }]);
    expect(JSON.stringify(out.card)).not.toContain('SECRET123');
  });
  it('only a GET made by fetch/XHR is a candidate', () => {
    expect(isReadCandidate({ method: 'GET', url: 'http://a/api/x', resourceType: 'fetch' })).toBe(true);
    expect(isReadCandidate({ method: 'GET', url: 'http://a/api/x' })).toBe(false);
    expect(isReadCandidate({ method: 'POST', url: 'http://a/api/x', resourceType: 'fetch' })).toBe(false);
    expect(isReadCandidate({ method: 'GET', url: 'http://a/app.js', resourceType: 'fetch' })).toBe(false);
  });
});

describe('replay and verdict', () => {
  const card = distillRead({ intent: 'x', origin: 'http://a', uiRows: ui, inputs: { query: 'al' }, candidates: [cand('http://a/api/search?query=al&n=20', search)] }).card;
  it('fills the slot and keeps every other parameter as the page sent it', () => {
    const r = buildReadReplay(card, { query: 'be ta' });
    expect(new URL(r.url).searchParams.get('query')).toBe('be ta');
    expect(new URL(r.url).searchParams.get('n')).toBe('20');
  });
  it('refuses to build half a query', () => { expect(buildReadReplay(card, {})).toBeNull(); });
  it('accepts an answer equal to the baseline', () => {
    expect(judgeRead(card, { status: 200, text: JSON.stringify(search) }, ui).ok).toBe(true);
  });
  it('refuses a 200 whose field was renamed — the silent failure', () => {
    const renamed = { hits: search.hits.map((h) => ({ id: h.id, name: h.title, author: h.author })) };
    const v = judgeRead(card, { status: 200, text: JSON.stringify(renamed) });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/title/);
  });
  it('refuses rows that differ from the UI baseline even when the shape is right', () => {
    const other = { hits: [{ title: 'Alpha', author: 'ann' }, { title: 'Gamma', author: 'bob' }] };
    expect(judgeRead(card, { status: 200, text: JSON.stringify(other) }, ui).ok).toBe(false);
  });
  it('refuses a non-JSON answer, a 5xx, and an empty list', () => {
    expect(judgeRead(card, { status: 200, text: '<html>' }).ok).toBe(false);
    expect(judgeRead(card, { status: 503, text: '' }).ok).toBe(false);
    expect(judgeRead(card, { status: 200, text: '{"hits":[]}' }).ok).toBe(false);
  });
});

describe('small parts', () => {
  it('compareRows is order- and whitespace-aware', () => {
    expect(compareRows(ui, [{ title: ' Alpha', by: 'ann' }, { title: 'Beta', by: 'bob' }]).equal).toBe(true);
    expect(compareRows(ui, [ui[1], ui[0]]).equal).toBe(false);
  });
  it('slotsFor matches case-insensitively and ignores unrelated params', () => {
    expect(slotsFor('http://a/s?Q=Hello&n=1', { query: 'hello' })).toEqual([{ name: 'query', param: 'Q' }]);
  });
  it('findExtract returns null for rows nothing contains', () => {
    expect(findExtract(search, [{ title: 'Zeta' }])).toBeNull();
  });
});
