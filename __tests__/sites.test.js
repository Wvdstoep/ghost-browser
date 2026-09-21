/**
 * The sites this browser knows, and the logins it sets up for them.
 *
 * WHY PRESETS EXIST AT ALL. A profile was named by hand and labelled by hand, and the agent finds
 * the right account BY that label — so a profile called "carla-test-facebook" with an empty site
 * field is invisible to it. The login exists, the agent reports it has none, and neither half looks
 * broken. Getting it wrong was silent, and the only symptom was an agent that would not do what it
 * was told.
 *
 * These cannot be typed wrongly because there is nothing to type.
 */
import { describe, it, expect } from 'vitest';
import { SITES, get, list, profileNameFor } from '../src/sites/index.js';

describe('the presets', () => {
  it('covers the sites the roles actually know', () => {
    /*
     * `searchconsole` is a SURFACE rather than another login: it borrows the Google profile because
     * it is the same account, and exists separately because it needs that account SIGNED IN while
     * search on the same profile is deliberately used signed out. Without the split, learning that
     * Search Console cannot be read would have routed web search to a phone as well.
     */
    expect(Object.keys(SITES).sort()).toEqual(['facebook', 'google', 'hn', 'indiehackers', 'linkedin', 'reddit', 'searchconsole', 'upwork', 'useme']);
  });

  /*
   * A BORROWED PROFILE IS NOT A SECOND LOGIN. searchconsole must never mint its own profile, or the
   * owner signs into Google twice and the two sessions drift.
   */
  it('and a surface that borrows a login does not claim one of its own', () => {
    expect(SITES.searchconsole.profile).toBe('google');
    expect(SITES.searchconsole.needsLogin).toBe(true);
    expect(SITES.google.needsLogin).toBeUndefined();
  });

  /* This is the field the agent matches on. Every other decision here is a convenience; this one
     is the reason the file exists. */
  it('gives every preset the site label the agent matches on', () => {
    for (const [key, s] of Object.entries(SITES)) {
      expect(s.site, key).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(s.site, key).not.toMatch(/^https?:/);
    }
  });

  it('produces a profile name that cannot be mistyped', () => {
    expect(profileNameFor('facebook')).toBe('facebook');
    expect(profileNameFor('Linked In!')).toBe('linkedin');
  });

  /* Somebody setting up a login wants the login page, not a home page that redirects them
     somewhere else first. */
  it('opens each one where the setting up actually happens', () => {
    expect(SITES.facebook.start).toMatch(/facebook\.com\/login/);
    expect(SITES.linkedin.start).toMatch(/linkedin\.com\/login/);
    // Google needs no account — what has to be cleared there is the consent page.
    expect(SITES.google.start).toMatch(/google\.com\/search/);
  });

  /*
   * Both Facebook and LinkedIn name the device on their "was this you?" screens and both said
   * Linux, which is unusual enough on a home connection to be worth a second look. Google does not
   * ask, so it is left telling the truth.
   */
  it('presents as Windows only where the site actually asks about the device', () => {
    expect(SITES.facebook.defaults.presentAs).toBe('windows');
    expect(SITES.linkedin.defaults.presentAs).toBe('windows');
    expect(SITES.google.defaults.presentAs).toBe('');
  });

  /*
   * A container has no fingerprint reader, so a passkey prompt waits forever for one — the failure
   * that cost an evening. Refused where it is offered, left alone where it is not.
   */
  it('refuses passkeys on the sites that offer them', () => {
    expect(SITES.facebook.defaults.blockPasskeys).toBe(true);
    expect(SITES.linkedin.defaults.blockPasskeys).toBe(true);
    expect(SITES.google.defaults.blockPasskeys).toBe(false);
  });

  /* Somebody about to meet a captcha, a code or a consent wall should be told which. */
  it('says what is waiting on the other side', () => {
    for (const [key, s] of Object.entries(SITES)) expect(s.hint, key).toBeTruthy();
    expect(SITES.google.hint).toMatch(/consent/i);
    expect(SITES.linkedin.hint).toMatch(/passkey/i);
  });

  /*
   * THE EXIT IS DELIBERATELY NOT HERE ANY MORE.
   *
   * It was added to each preset after a fresh Facebook profile came out exiting from a datacentre.
   * That fixed the presets and left the same trap for every profile made any other way — so
   * routing through the tailnet became the DEFAULT for everything instead, and carrying it here
   * would be a second place for the same fact to be wrong.
   */
  it('leaves the exit to the default rather than repeating it per site', () => {
    for (const [key, s] of Object.entries(SITES)) {
      expect(s.defaults.proxy, key).toBeUndefined();
    }
  });

  it('is honest about an unknown one rather than inventing it', () => {
    expect(get('myspace')).toBeNull();
    expect(get('')).toBeNull();
  });
});

describe('offering them next to what already exists', () => {
  it('marks the ones already set up, so a picker can offer the rest', () => {
    const l = list(['facebook', 'something-else']);
    expect(l.find((x) => x.key === 'facebook').exists).toBe(true);
    expect(l.find((x) => x.key === 'linkedin').exists).toBe(false);
  });

  /*
   * I HAD THIS BACKWARDS, and the test asserted the wrong thing on purpose.
   *
   * The reasoning was "a hand-made profile is not the preset, and claiming otherwise hides an
   * unlabelled login". That holds for an UNLABELLED one and is simply wrong for a labelled one: the
   * site label is what the agent matches on, so a profile carrying it IS the login for that site
   * whatever somebody called it. Matching on the name alone offered "Set up Facebook" beside a
   * working Facebook login, and accepting it created an empty second one.
   */
  it('counts a login labelled with the site, whatever it is called', () => {
    const l = list([{ name: 'carla-test-facebook', site: 'facebook.com' }]);
    const fb = l.find((x) => x.key === 'facebook');
    expect(fb.exists).toBe(true);
    // ...and says WHICH one, so nobody has to guess whether their own profile counts.
    expect(fb.servedBy).toBe('carla-test-facebook');
  });

  it('still offers a site nothing is labelled for', () => {
    const l = list([{ name: 'carla-test-facebook', site: 'facebook.com' }]);
    expect(l.find((x) => x.key === 'linkedin').exists).toBe(false);
  });

  /* An UNLABELLED login is invisible to the agent, so it must not silently satisfy a preset —
     that was the correct half of the original reasoning and it stays. */
  it('does not count an unlabelled login that merely looks related', () => {
    expect(list([{ name: 'my-facebook-thing', site: '' }]).find((x) => x.key === 'facebook').exists).toBe(false);
  });

  it('still accepts plain names, for a caller that has not read the labels', () => {
    expect(list(['facebook']).find((x) => x.key === 'facebook').exists).toBe(true);
  });

  it('is case-insensitive about what is already there', () => {
    expect(list(['FaceBook']).find((x) => x.key === 'facebook').exists).toBe(true);
    expect(list([{ name: 'x', site: 'Facebook.com' }]).find((x) => x.key === 'facebook').exists).toBe(true);
  });
});

describe('freelance presets', () => {
  const { SITES } = require('../src/sites/index.js');
  it('the growth desk rooms are known sites — reddit, hacker news, indie hackers — each opening on its login with passkeys refused', () => {
    for (const [k, site] of [['reddit', 'reddit.com'], ['hn', 'news.ycombinator.com'], ['indiehackers', 'indiehackers.com']]) {
      const s = get(k);
      expect(s.site).toBe(site);
      expect(s.start.startsWith('https://')).toBe(true);
      expect(s.start).toMatch(/login|sign-in/);
      expect(s.defaults.blockPasskeys).toBe(true);
      expect(s.defaults.presentAs).toBe('windows');
    }
  });

  it('useme and upwork are known sites with login starts and passkeys refused', () => {
    for (const k of ['useme', 'upwork']) {
      expect(SITES[k]).toBeTruthy();
      expect(SITES[k].start).toMatch(/login/);
      expect(SITES[k].defaults.blockPasskeys).toBe(true);
    }
  });
});

describe('a preset may live in ANOTHER profile (a site whose only door is another site login)', () => {
  const { SITES, profileNameFor, borrowsProfile, list } = require('../src/sites/index.js');
  it('Indie Hackers opens in the google profile — a Google sign-in in a fresh isolated profile is the one Google refuses', () => {
    expect(SITES.indiehackers.profile).toBe('google');
    expect(profileNameFor('indiehackers')).toBe('google');
    expect(borrowsProfile('indiehackers')).toBe(true);
    expect(SITES.indiehackers.hint).toMatch(/Google/);
  });
  it('a preset that owns its profile is unchanged, and borrows nothing', () => {
    for (const k of ['facebook', 'linkedin', 'reddit', 'hn', 'google', 'useme', 'upwork']) {
      expect(profileNameFor(k)).toBe(k);
      expect(borrowsProfile(k)).toBe(false);
    }
  });
  it('the listing reports the borrowed profile, so a Google login already set up counts as set up', () => {
    const row = list([{ name: 'google', site: 'google.com' }]).find((x) => x.key === 'indiehackers');
    expect(row.profile).toBe('google');
    expect(row.exists).toBe(true);
  });
});

describe('single-browser mode: a preset opens THE browser, never a new profile', () => {
  const src = require('node:fs').readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("const preset = req.body && req.body.preset"), src.indexOf('const s = await pool.createSession('));
  it('a PINNED preset outranks the shared browser — measured beats assumed', () => {
    const { pinnedProfile } = require('../src/sites/index.js');
    expect(pinnedProfile('indiehackers')).toBe('google');
    expect(pinnedProfile('hn')).toBeNull();
    expect(route).toContain('const pinned = sites.pinnedProfile(req.body.preset)');
    expect(route).toContain('profileName = pinned || served || oneBrowser || sites.profileNameFor(req.body.preset)');
    expect(route).toContain('if (!pinned && !served && !oneBrowser && !sites.borrowsProfile(req.body.preset))');
  });

  it('a login that ALREADY EXISTS beats the shared browser — Reddit and Hacker News live in their own profiles', () => {
    const { servedProfile } = require('../src/sites/index.js');
    const have = [{ name: 'reddit', site: 'reddit.com' }, { name: 'hn', site: 'news.ycombinator.com' }, { name: 'facebook', site: 'facebook.com' }];
    expect(servedProfile('reddit', have)).toBe('reddit');
    expect(servedProfile('hn', have)).toBe('hn');
    expect(servedProfile('upwork', have)).toBeNull();                       // nobody signed in anywhere → the shared browser
    expect(servedProfile('reddit', [{ name: 'anything', site: 'reddit.com' }])).toBe('anything');   // matched on the label too
    expect(route).toContain('const served = pinned ? null : sites.servedProfile(req.body.preset, pool.listProfilesDetailed())');
    expect(route).toContain('profileName = pinned || served || oneBrowser || sites.profileNameFor(req.body.preset)');
  });

  it('reads the setting and uses browserProfile as the profile', () => {
    expect(route).toMatch(/settingsStore\.read\(\)/);
    expect(route).toMatch(/single\.singleBrowser \? \(single\.browserProfile \|\| 'facebook'\) : null/);
    expect(route).toContain('profileName = pinned || served || oneBrowser || sites.profileNameFor(req.body.preset)');
  });
  it('never writes a site label onto the shared browser — that would hide every other login from the agent', () => {
    expect(route).toContain('if (!pinned && !served && !oneBrowser && !sites.borrowsProfile(req.body.preset)) {');
  });
});
