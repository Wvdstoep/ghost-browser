/*
 * "WHICH ACCOUNT?" MUST NOT BE READ AS "SIGNED OUT", AND MUST NEVER BE ANSWERED BY GUESSING.
 *
 * From production: the gsc.audit job sat on accounts.google.com/v3/signin/accountchooser for 31
 * minutes with zero steps while the owner was signed in the entire time. Two Gmail accounts live in
 * that profile and one holds the property, so Google asked which — and because the chooser is served
 * from the same host as the sign-in form, loginWall called it a wall. The audit then recorded "no
 * access" on the property, which reads as a Google penalty rather than an unanswered question. That
 * exact misreading has already produced one phantom penalty in this codebase.
 *
 * The second half matters more than the first: picking the wrong Google account is not a harmless
 * retry, it reads a stranger's Search Console and files the numbers as ours. A wrong answer here is
 * worse than no answer, so these tests pin that an unconfigured chooser REPORTS and never picks.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isChooser, isSignIn, decide } = require('../src/accountChooser');

const CHOOSER = 'https://accounts.google.com/v3/signin/accountchooser?continue=https://search.google.com/search-console';
const SIGNIN = 'https://accounts.google.com/v3/signin/identifier?continue=https://search.google.com/';

describe('an account chooser is its own answer, not a missing login', () => {
  it('recognises the chooser the audit actually sat on', () => {
    expect(isChooser(CHOOSER)).toBe(true);
    expect(isChooser('https://accounts.google.com/signin/selectaccount?prompt=select_account')).toBe(true);
    expect(isChooser('https://accounts.google.com/AccountChooser?hl=pl')).toBe(true);
  });

  /* The distinction the whole fix rests on: same host, different question. */
  it('does not confuse it with a sign-in form, which IS a missing session', () => {
    expect(isChooser(SIGNIN)).toBe(false);
    expect(isSignIn(SIGNIN)).toBe(true);
    expect(isSignIn(CHOOSER)).toBe(false);
  });

  it('says nothing about pages that are neither', () => {
    for (const u of ['https://search.google.com/search-console', 'https://search.google.com/search-console/about', '', null, undefined]) {
      expect(isChooser(u)).toBe(false);
      expect(isSignIn(u)).toBe(false);
    }
  });

  it('is not fooled by another host that merely mentions the word', () => {
    expect(isChooser('https://example.com/accountchooser')).toBe(false);
  });
});

describe('which account is configured, never inferred', () => {
  it('picks the configured account when the chooser is up', () => {
    const d = decide(CHOOSER, 'owner@gmail.com');
    expect(d.act).toBe('pick');
    expect(d.email).toBe('owner@gmail.com');
  });

  /*
   * THE IMPORTANT ONE. With two accounts and nothing configured, a flow that picks the first tile
   * reads the wrong property and files it as ours. Reporting is the correct outcome.
   */
  it('refuses to choose when no account is configured, and says why', () => {
    const d = decide(CHOOSER, '');
    expect(d.act).toBe('report');
    expect(d.why).toMatch(/no account is configured/);
    expect(d.why).toMatch(/wrong account/);
  });

  it('refuses a configured value that is not an address rather than hunting for it', () => {
    const d = decide(CHOOSER, 'the main one');
    expect(d.act).toBe('report');
    expect(d.why).toMatch(/not an address/);
  });

  it('is case and whitespace tolerant about the configured address', () => {
    expect(decide(CHOOSER, '  Owner@Gmail.COM ').email).toBe('owner@gmail.com');
  });

  it('does nothing at all when the page is not a chooser, configured or not', () => {
    expect(decide('https://search.google.com/search-console', 'owner@gmail.com').act).toBe('none');
    expect(decide(SIGNIN, 'owner@gmail.com').act).toBe('none');   // a wall is the wall detector's job
  });
});

/*
 * ── A SIGNED-OUT PROFILE IS NOT A GOOGLE PENALTY, AND A RE-AUTH PROMPT IS NOT A STEP ───────────
 *
 * Measured 2026-09-21. The gsc.connect job spent 39 minutes walking Google's re-auth gauntlet,
 * /signin/challenge/pwd then /signin/challenge/pk, holding the `google` profile the owner needed in
 * order to sign in, and reporting nothing usable. The dashboard meanwhile showed "Je hebt geen
 * toegang tot deze property" and raised a MANUAL ACTION flag, which is the phantom-penalty failure
 * this codebase has already produced once: it could not open the manual-actions tab, so "we did not
 * look" was rendered as an alarm and sent the owner hunting for a Google sanction.
 *
 * The cause sat one layer below the account chooser. That profile held 63 google.com cookies and
 * not one auth cookie, so it was simply signed out. The owner's real session was in a different
 * profile entirely.
 *
 * Both guards exist to turn a 39-minute stall into one accurate sentence, and neither may ever try
 * to answer a password or passkey prompt: signing in is the owner's act, by hand, once.
 */
describe('signed out, challenged, or actually in', () => {
  const CH_PWD = 'https://accounts.google.com/v3/signin/challenge/pwd?TL=ACv9tzFibv4YKbZh';
  const CH_PK = 'https://accounts.google.com/v3/signin/challenge/pk?TL=ACv9tzFibv4YKbZh';
  const INSIDE = 'https://search.google.com/search-console?resource_id=sc-domain%3Amy-app.engineer';
  const ck = (names, domain) => names.map((n) => ({ name: n, domain: domain || '.google.com' }));
  const LIVE = ck(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', 'LSID']);

  const { isChallenge, hasSession, googleState } = require('../src/accountChooser');

  it('recognises the exact challenges the job was caught walking', () => {
    expect(isChallenge(CH_PWD)).toBe(true);
    expect(isChallenge(CH_PK)).toBe(true);
    expect(isChallenge('https://accounts.google.com/v3/signin/challenge/totp')).toBe(true);
  });

  it('does not call the console or the chooser a challenge', () => {
    expect(isChallenge(INSIDE)).toBe(false);
    expect(isChallenge('https://accounts.google.com/v3/signin/accountchooser')).toBe(false);
    expect(isChallenge('')).toBe(false);
  });

  /* THE MEASURED CASE: many google cookies, no auth cookie. 63 of them, and signed out. */
  it('calls a jar with cookies but no auth cookie signed out', () => {
    const junk = ck(['NID', 'AEC', '1P_JAR', 'CONSENT', 'OTZ', 'SEARCH_SAMESITE']);
    const r = hasSession(junk);
    expect(r.signedIn).toBe(false);
    expect(r.found).toEqual([]);
  });

  it('calls a real session signed in', () => {
    const r = hasSession(LIVE);
    expect(r.signedIn).toBe(true);
    expect(r.found).toContain('SAPISID');
  });

  it('ignores another site cookies named the same', () => {
    expect(hasSession(ck(['SID', 'SAPISID'], '.example.com')).signedIn).toBe(false);
  });

  it('survives an empty or missing jar instead of throwing mid-run', () => {
    for (const j of [[], null, undefined, [null, {}]]) expect(hasSession(j).signedIn).toBe(false);
  });

  /*
   * THE POINT OF ALL OF IT: the sentence handed back must say a login is missing and must NOT read
   * as a Google penalty, because that misreading already shut the whole search channel once.
   */
  it('blames the missing login, not Google, and says who to sign in as', () => {
    const r = googleState(INSIDE, [], 'wesley.biab@gmail.com');
    expect(r.state).toBe('signed-out');
    expect(r.why).toMatch(/no Google session/i);
    expect(r.why).toMatch(/by hand/i);
    expect(r.why).toContain('wesley.biab@gmail.com');
    expect(r.why).toMatch(/not a Google permission problem/i);
  });

  it('reports a challenge as a wall to be signed in by hand, never pushed through', () => {
    const r = googleState(CH_PK, LIVE, 'wesley.biab@gmail.com');
    expect(r.state).toBe('challenge');
    expect(r.why).toMatch(/re-verify/i);
    expect(r.why).toMatch(/by hand/i);
  });

  /* Signed out beats everything: there is no point naming a chooser we will never reach. */
  it('answers signed-out first, even when the url looks like a chooser', () => {
    expect(googleState('https://accounts.google.com/v3/signin/accountchooser', [], '').state).toBe('signed-out');
  });

  it('says plainly when it is actually inside', () => {
    const r = googleState(INSIDE, LIVE, 'wesley.biab@gmail.com');
    expect(r.state).toBe('in');
    expect(r.why).toBe('');
  });

  it('still points at the chooser when signed in and asked which account', () => {
    const r = googleState('https://accounts.google.com/v3/signin/accountchooser', LIVE, '');
    expect(r.state).toBe('chooser');
  });
});
