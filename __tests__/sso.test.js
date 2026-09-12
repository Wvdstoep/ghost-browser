/**
 * One login.
 *
 * The console grew up standalone, with its own owner account and its own password. That was right
 * on its own host and wrong the moment it became a page of LeadFlow: being asked to sign in a
 * second time, inside an app you are already signed into, is the clearest possible sign that two
 * things were bolted together rather than merged.
 *
 * LeadFlow already signs a token for every user. Given the same secret this verifies one offline —
 * no call back to the API, so no page load depends on it being up, and no second account exists.
 *
 * What is pinned here is mostly what it must REFUSE. This turns a signature into a session on a
 * browser holding somebody's logged-in Facebook, so every one of these is load-bearing.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyLeadflowToken, ownerName } from '../src/sso.js';

const SECRET = 'a-real-secret-not-the-placeholder';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(claims, { secret = SECRET, alg = 'HS256' } = {}) {
  const head = b64({ alg, typ: 'JWT' });
  const body = b64(claims);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const soon = () => Math.floor(Date.now() / 1000) + 3600;

describe('accepting a LeadFlow session', () => {
  it('verifies a real token and returns who it is', () => {
    const claims = verifyLeadflowToken(sign({ id: 7, email: 'carla@example.com', exp: soon() }), SECRET);
    expect(claims).toMatchObject({ id: 7, email: 'carla@example.com' });
  });

  it('names the owner after the person, not the number', () => {
    expect(ownerName({ id: 7, email: 'carla@example.com' })).toBe('carla@example.com');
    expect(ownerName({ id: 7 })).toBe('leadflow-7');
  });
});

describe('what it refuses', () => {
  /* Off unless deliberately configured. A browser that can be signed into by anyone presenting an
     unverifiable token would be worse than one that asks twice. */
  it('is off entirely with no secret configured', () => {
    expect(() => verifyLeadflowToken(sign({ id: 1, exp: soon() }), '')).toThrow(/not configured/);
  });

  it('refuses a token signed with a different secret', () => {
    expect(() => verifyLeadflowToken(sign({ id: 1, exp: soon() }, { secret: 'someone else' }), SECRET))
      .toThrow(/not signed by LeadFlow/);
  });

  /* The classic JWT hole: trusting the algorithm the token itself names. "alg":"none" would
     otherwise verify against nothing at all. */
  it('refuses a token that names its own algorithm as none', () => {
    const head = b64({ alg: 'none', typ: 'JWT' });
    const body = b64({ id: 1, exp: soon() });
    expect(() => verifyLeadflowToken(`${head}.${body}.`, SECRET)).toThrow(/not signed the way/);
  });

  it('refuses an expired session, and says which problem it is', () => {
    const stale = sign({ id: 1, exp: Math.floor(Date.now() / 1000) - 10 });
    expect(() => verifyLeadflowToken(stale, SECRET)).toThrow(/expired/);
  });

  /*
   * THE ONE THAT MATTERS MOST. The lead-ingest tokens this browser is handed are signed with the
   * same secret — they have to be, LeadFlow signs both. One of those is given TO a browser rather
   * than held by a person, and is scoped to a single search precisely so it can do nothing else.
   * Letting it log in would hand a full console session to anything that ever received one.
   */
  it('refuses a scoped ingest token as a sign-in', () => {
    const ingest = sign({ scope: 'browser-ingest', userId: 1, searchId: 42, exp: soon() });
    expect(() => verifyLeadflowToken(ingest, SECRET)).toThrow(/scoped token, not a sign-in/);
  });

  it('refuses a token that does not say who it is', () => {
    expect(() => verifyLeadflowToken(sign({ exp: soon() }), SECRET)).toThrow(/does not say who/);
  });

  it.each([['', 'not a token'], ['abc', 'not a token'], ['a.b', 'not a token']])
    ('refuses %s', (tok) => expect(() => verifyLeadflowToken(tok, SECRET)).toThrow(/not a token/));

  it('refuses a body that is not readable JSON', () => {
    const head = b64({ alg: 'HS256', typ: 'JWT' });
    const body = 'bm90LWpzb24';
    const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
    expect(() => verifyLeadflowToken(`${head}.${body}.${sig}`, SECRET)).toThrow(/no readable claims/);
  });

  /* A token with no expiry is forever. LeadFlow always sets one; accepting one without is a
     deliberate decision and this records that it is allowed, so nobody has to guess later. */
  it('accepts a token with no expiry, because LeadFlow always sets one', () => {
    expect(verifyLeadflowToken(sign({ id: 3 }), SECRET)).toMatchObject({ id: 3 });
  });
});
