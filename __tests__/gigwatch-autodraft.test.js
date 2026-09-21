/*
 * WHICH FRESH GIGS EARN A MODEL CALL.
 *
 * The owner's complaint, exactly: "i see fresh gigs in the watcher while I dont have a draft".
 * Drafting only ever happened when something called the draft route, and nothing did, so the watcher
 * filled with ranked gigs and no words. On this board a gig collects five offers in fourteen minutes
 * and ninety in six days, so arriving late is the same as not arriving.
 *
 * But drafting EVERYTHING is the opposite mistake: a draft is a model call, and the standing rule is
 * tokens only on money-moments. A six-day-old gig with ninety offers is not one.
 *
 * The fixture below is the real useme-gigs feed as it stood when this was written, scores, ages,
 * offer counts and all. Both failure modes it guards against are silent: spending on the gigs least
 * likely to answer, or quietly drafting nothing.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { pickForAutoDraft } = require('../src/gigWatch');

const row = (title, ageDays, score, offers, extra = {}) =>
  ({ key: title, title, fields: { type: 'gig', ageDays, score, offers }, ...extra });

/* The live board, 2026-09-21. The two with drafts are the two already sent. */
const FEED = [
  row('Modernizacja i rozwoj istniejacego sklepu B2B PHP', 0, -4, 15),
  row('Przejecie i rozwoj istniejacego sklepu B2B PHP/MySQL', 0, 11, 3),
  row('Przebudowa strony www + optymalizacja SEO', 4, -12.4, 104),
  row('Polaczenie Salesforce-Woocommerce', 3, 4.9, 41),
  row('Integracja API systemu hotelowego z BigQuery', 2, 7.8, 52),
  row('Wgranie plikow csv do baselinkera', 3, 5.6, 44),
  row('Wdrozenie automatyzacji AI (Make.com/n8n)', 6, 8.3, 67),
  row('Audyt sklepu B2B na platformie IdoSell', 2, 8.6, 24),
  row('Senior Shopify Plus Developer', 2, 9.9, 21),
  row('Pobieranie danych z allegro', 6, 16, 90),
  row('Konfiguracja konwersji przez AnyDesk', 0, 11.3, 5, { handled: true, posted: true, draft: 'Dzien dobry...' }),
  row('Integracja SAP BaseLinker Shopify', 5, 11.1, 19, { handled: true, posted: true, draft: 'Dzien dobry...' }),
];

describe('pickForAutoDraft — the gigs worth spending a model call on', () => {
  it('takes the fresh gig with three offers and leaves its negative-scored neighbour', () => {
    const picked = pickForAutoDraft(FEED, {});
    expect(picked.map((p) => p.title)).toEqual([
      'Przejecie i rozwoj istniejacego sklepu B2B PHP/MySQL',
    ]);
    /* Same day, 15 offers, score -4: fresh is not enough on its own. */
    expect(picked.map((p) => p.title)).not.toContain('Modernizacja i rozwoj istniejacego sklepu B2B PHP');
  });

  it('never re-drafts what was already sent, however well it scores', () => {
    const picked = pickForAutoDraft(FEED, { autoDraftTop: 5, autoDraftMinScore: -99 });
    expect(picked.map((p) => p.title)).not.toContain('Konfiguracja konwersji przez AnyDesk');
    expect(picked.map((p) => p.title)).not.toContain('Integracja SAP BaseLinker Shopify');
  });

  /* The gig with the HIGHEST score on the board is six days old with ninety offers. */
  it('does not chase the best score when it is six days and ninety offers old', () => {
    const picked = pickForAutoDraft(FEED, { autoDraftTop: 5 });
    expect(picked.map((p) => p.title)).not.toContain('Pobieranie danych z allegro');
  });

  it('ranks best-first and stops at the cap', () => {
    const picked = pickForAutoDraft(FEED, { autoDraftTop: 3, autoDraftMaxAgeDays: 7, autoDraftMinScore: -99 });
    expect(picked).toHaveLength(3);
    expect(picked.map((p) => p.fields.score)).toEqual([16, 11, 9.9]);
  });

  it('is off when the owner turns it off, and when the cap is zero', () => {
    expect(pickForAutoDraft(FEED, { autoDraft: false })).toEqual([]);
    expect(pickForAutoDraft(FEED, { autoDraftTop: 0 })).toEqual([]);
  });

  it('never exceeds five, whatever the config asks for', () => {
    expect(pickForAutoDraft(FEED, { autoDraftTop: 99, autoDraftMaxAgeDays: 99, autoDraftMinScore: -99 }))
      .toHaveLength(5);
  });

  it('skips a gig that is mid-post, so two sweeps cannot both draft it', () => {
    const racing = [row('mid flight', 0, 20, 2, { posting: true })];
    expect(pickForAutoDraft(racing, {})).toEqual([]);
  });

  it('skips anything already carrying words, even without the drafted flag', () => {
    expect(pickForAutoDraft([row('has words', 0, 20, 2, { draft: '  Dzien dobry  ' })], {})).toEqual([]);
    expect(pickForAutoDraft([row('flagged', 0, 20, 2, { draftState: 'drafted' })], {})).toEqual([]);
  });

  it('ignores replies and posts — only gigs get priced', () => {
    const reply = { key: 'r', title: 'a client answered', fields: { type: 'reply', ageDays: 0, score: 50 } };
    expect(pickForAutoDraft([reply], {})).toEqual([]);
  });

  /* A row with no age is not proof of staleness, and dropping it would silently skip real work. */
  it('keeps a gig whose age is unknown rather than assuming it is stale', () => {
    const noAge = { key: 'n', title: 'no age', fields: { type: 'gig', score: 5 } };
    expect(pickForAutoDraft([noAge], {})).toHaveLength(1);
  });

  it('tolerates a ragged feed instead of throwing mid-sweep', () => {
    expect(pickForAutoDraft([null, undefined, {}, { fields: null }], {})).toEqual([]);
    expect(pickForAutoDraft(null, {})).toEqual([]);
    expect(pickForAutoDraft(undefined, {})).toEqual([]);
  });
});
