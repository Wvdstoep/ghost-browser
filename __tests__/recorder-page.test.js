/**
 * The page half of a recording, its pure parts: a consent wall answered by cookie before it appears
 * (YouTube/Google, any language), never overwriting a choice the profile already holds; the button
 * words a wall can carry when a cookie cannot answer it.
 */
import { describe, it, expect } from 'vitest';
import { platformCookies, CONSENT_ACCEPT, CONSENT_REJECT } from '../src/recorder/page.js';

describe('recording page prep', () => {
  it('answers YouTube\'s and Google\'s consent wall with SOCS=CAI for both domains, once', () => {
    const c = platformCookies('https://www.youtube.com/watch?v=abc');
    expect(c.map((x) => x.name + x.domain).sort()).toEqual(['SOCS.google.com', 'SOCS.youtube.com']);
    expect(c[0].value).toBe('CAI'); expect(c[0].secure).toBe(true); expect(c[0].expires).toBeGreaterThan(Date.now() / 1000);
    expect(platformCookies('https://google.com/search?q=x').length).toBe(2);
  });
  it('keeps a choice the profile already made, and adds nothing on other sites or a bad url', () => {
    const c = platformCookies('https://www.youtube.com/watch?v=abc', [{ name: 'SOCS', value: 'CAESEw…', domain: '.youtube.com' }]);
    expect(c.map((x) => x.domain)).toEqual(['.google.com']);
    expect(platformCookies('https://vimeo.com/1')).toEqual([]); expect(platformCookies('not a url')).toEqual([]);
  });
  it('knows the wall\'s buttons in the languages the exits speak, accept and reject apart', () => {
    for (const w of ['Accept all', 'Zaakceptuj wszystko', 'Alles accepteren', 'Hyväksy kaikki', 'Alle akzeptieren', 'Tout accepter']) expect(CONSENT_ACCEPT.test(w), w).toBe(true);
    for (const w of ['Reject all', 'Odrzuć wszystko', 'Hylkää kaikki', 'Alles afwijzen']) expect(CONSENT_REJECT.test(w), w).toBe(true);
    expect(CONSENT_ACCEPT.test('Reject all')).toBe(false); expect(CONSENT_ACCEPT.test('Accept all cookies and continue to the site')).toBe(false);
  });
});
