/**
 * sso.js — one login, because this is one app now.
 *
 * The console grew up standalone, with its own owner account and its own signed cookie. That was
 * right when it lived on its own host. It is wrong the moment it becomes a page of LeadFlow: being
 * asked to sign in a second time, inside an app you are already signed into, is the clearest
 * possible signal that two things were bolted together rather than merged.
 *
 * HOW IT WORKS. LeadFlow already signs a JWT for every signed-in user. Given the same secret, this
 * console can verify one — so the page hands its own token over, the console checks the signature
 * and the expiry, and issues the session it would have issued after a password. No second account,
 * no second password, no shared user table.
 *
 * WHY A SHARED SECRET AND NOT A CALL BACK TO LEADFLOW. A verification request would make every page
 * load depend on the API being up, and would need a credential of its own to make. An HMAC needs
 * neither: the token either verifies or it does not, offline, in microseconds.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is trust a token by default. With no secret configured, SSO is
 * off and the console behaves exactly as it always has. A browser that can be signed into by anyone
 * presenting an unverifiable token would be worse than one that asks twice.
 */

const crypto = require('crypto');

/** Decode without verifying. Only ever used for the parts that are safe before a signature check. */
function decodeSegment(seg) {
  try { return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')); }
  catch { return null; }
}

/**
 * Verify a LeadFlow HS256 token. Returns its claims, or throws with a reason worth reading — an
 * expired token and a wrong secret are different problems with different fixes, and collapsing
 * them into "invalid" costs an hour of looking in the wrong place.
 */
function verifyLeadflowToken(token, secret) {
  if (!secret) throw Object.assign(new Error('single sign-on is not configured on this browser'), { status: 501 });
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw Object.assign(new Error('that is not a token'), { status: 400 });

  const [headB64, bodyB64, sigB64] = parts;
  const head = decodeSegment(headB64);
  // Only HS256. Accepting the algorithm the token names is the classic JWT hole: a token claiming
  // "alg":"none" would otherwise verify against nothing at all.
  if (!head || head.alg !== 'HS256') {
    throw Object.assign(new Error('that token is not signed the way this expects'), { status: 400 });
  }

  const expected = crypto.createHmac('sha256', secret).update(`${headB64}.${bodyB64}`).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sigB64);
  // Constant-time: a comparison that returns early leaks how much of the signature matched.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error('that token was not signed by LeadFlow'), { status: 401 });
  }

  const claims = decodeSegment(bodyB64);
  if (!claims) throw Object.assign(new Error('that token has no readable claims'), { status: 400 });
  if (claims.exp && Date.now() >= claims.exp * 1000) {
    throw Object.assign(new Error('that LeadFlow session has expired — sign in again there'), { status: 401 });
  }
  /*
   * The ingest tokens this browser POSTS leads with are signed by the same secret. One must not be
   * usable to log in: it is handed to a browser rather than held by a person, and it is scoped to a
   * search precisely so that it cannot do anything else.
   */
  if (claims.scope) {
    throw Object.assign(new Error('that is a scoped token, not a sign-in'), { status: 403 });
  }
  if (!claims.id && !claims.userId && !claims.email) {
    throw Object.assign(new Error('that token does not say who it is'), { status: 400 });
  }
  return claims;
}

/** A name for the owner record, derived from whoever LeadFlow says this is. */
const ownerName = (claims) =>
  String(claims.email || claims.username || `leadflow-${claims.id ?? claims.userId}`).slice(0, 80);

module.exports = { verifyLeadflowToken, ownerName };
