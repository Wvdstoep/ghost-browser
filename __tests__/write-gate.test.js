/*
 * WORDS THAT ONLY LOOK LIKE A WRITE, BECAUSE DUTCH COMPOUNDS.
 *
 * The gate matches write words as PREFIXES, deliberately: Dutch inflects them, plaats becomes
 * Plaatsen and verzend becomes Verzenden, and a whole-word check rejected exactly the buttons the
 * gate exists for.
 *
 * It over-reaches on compounds. Measured live on a Marktplaats search: a click on Volgende - the
 * next-page button - was refused as though it published something to other people, because
 * Volgende begins with volgen. Postcode begins with post and would go the same way, and that field
 * sits in the same search bar.
 *
 * Both halves are tested here. A fix that let Volgende through and also let Volgen through would
 * post to somebody's real account, which is the thing the gate is for.
 */
import { describe, it, expect } from 'vitest';
import { looksLikeWrite } from '../src/agent.js';

describe('the write gate lets ordinary navigation through', () => {
  for (const word of ['Volgende', 'Vorige', 'Postcode', 'Postbus', 'Zoek', 'Meer weergeven']) {
    it(`${word} is navigation, not publishing`, () => {
      expect(looksLikeWrite({ text: word })).toBe(false);
    });
  }
});

describe('and still stops anything other people would see', () => {
  for (const word of ['Volgen', 'Plaats advertentie', 'Plaatsen', 'Verzenden', 'Reageer',
    'Lid worden', 'Delen', 'Publiceren', 'Vind ik leuk', 'Connect']) {
    it(`${word} still needs approval`, () => {
      expect(looksLikeWrite({ text: word })).toBe(true);
    });
  }

  it('reads the aria-label when the button has no words of its own', () => {
    expect(looksLikeWrite({ text: '', ariaLabel: 'Volgen' })).toBe(true);
    expect(looksLikeWrite({ text: '', ariaLabel: 'Volgende pagina' })).toBe(false);
  });
});