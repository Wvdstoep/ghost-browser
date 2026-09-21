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
