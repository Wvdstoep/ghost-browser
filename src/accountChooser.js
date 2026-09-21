/*
 * "WHICH ACCOUNT?" IS NOT "SIGNED OUT".
 *
 * A Google profile holding more than one account does not land on the console and does not land on a
 * sign-in form. It lands on an account chooser — which is served from accounts.google.com, the exact
 * host loginWall treats as proof of a missing session. So a correctly signed-in profile reported a
 * wall, the audit recorded "no access" on the property, and that reads as a penalty rather than as a
 * question nobody answered.
 *
 * Seen live: the gsc.audit job sat on /v3/signin/accountchooser for 31 minutes with zero steps while
 * the owner was signed in the whole time, because two Gmail accounts live in that profile and one of
 * them holds the property.
 *
 * WHICH ONE IS NEVER GUESSED. Picking the wrong Google account is not a retry — it reads someone
 * else's Search Console, and a wrong answer here is worse than no answer because it looks like data.
 * So the account is owner-set config; with nothing configured this reports the chooser and stops,
 * which is a fact a human can act on, unlike a silent wall.
 */
'use strict';

/** The chooser, by address. Its own host is also the sign-in host, so the PATH is what separates them. */
function isChooser(url) {
  const u = String(url || '').toLowerCase();
  if (!u.includes('accounts.google.com')) return false;
  return u.includes('accountchooser')            // /v3/signin/accountchooser
    || u.includes('/signin/selectaccount')       // the OAuth prompt=select_account form
    || u.includes('/accountchooser');
}

/*
 * A sign-in FORM is a different answer and must keep reporting a wall: there is genuinely no session
 * and no amount of clicking tiles will make one. Separated so a caller cannot conflate them.
 */
function isSignIn(url) {
  const u = String(url || '').toLowerCase();
  if (!u.includes('accounts.google.com')) return false;
  if (isChooser(u)) return false;
  return u.includes('/signin') || u.includes('/servicelogin') || u.includes('/v3/signin');
}

/**
 * What to do about a chooser, decided before anything is clicked so the decision is testable.
 * Returns { act: 'pick'|'report'|'none', email, why }.
 */
function decide(url, email) {
  if (!isChooser(url)) return { act: 'none', email: '', why: 'not an account chooser' };
  const want = String(email || '').trim().toLowerCase();
  if (!want) {
    return {
      act: 'report',
      email: '',
      why: 'an account chooser is up and no account is configured — set the Google account that owns'
        + ' the property rather than letting a flow pick one, because the wrong account reads someone'
        + " else's data and reports it as ours",
    };
  }
  if (!want.includes('@')) {
    return { act: 'report', email: want, why: `configured Google account "${want}" is not an address` };
  }
  return { act: 'pick', email: want, why: `choosing the configured account ${want}` };
}

/**
 * Click the tile for the configured account. Counts before clicking, because "the tile is not there"
 * and "the tile is there but would not click" are different facts and a click timeout reports both
 * the same way — the mistake that made a signed-in profile look unreachable once already.
 */
async function choose(page, email, opts = {}) {
  const log = opts.log || null;
  const url = (() => { try { return String(page.url() || ''); } catch (e) { return ''; } })();
  const d = decide(url, email);
  if (d.act !== 'pick') return { picked: false, ...d, url };

  let n = 0;
  try { n = await page.getByText(d.email, { exact: false }).count(); } catch (e) { n = 0; }
  if (!n) {
    /*
     * The configured account is not ON the chooser. That is a real finding, not a retry: the profile
     * is signed in as somebody else entirely, and saying so beats clicking whatever tile is first.
     */
    let offered = [];
    try {
      offered = await page.evaluate(() => Array.from(document.body.innerText.matchAll(/[\w.+-]+@[\w.-]+\.\w+/g)).map((m) => m[0]).slice(0, 6));
    } catch (e) { offered = []; }
    return {
      picked: false, act: 'report', email: d.email, url,
      offered,
      why: `the configured account ${d.email} is not on this chooser`
        + (offered.length ? ` — it offers ${offered.join(', ')}` : ' — and it lists no addresses'),
    };
  }

  try {
    await page.getByText(d.email, { exact: false }).first().click({ timeout: 8000 });
  } catch (e) {
    return { picked: false, act: 'report', email: d.email, url, why: `the tile for ${d.email} was on the page but would not click: ${String((e && e.message) || e).split('\n')[0].slice(0, 120)}` };
  }
  try { await page.waitForLoadState('domcontentloaded', { timeout: 20000 }); } catch (e) { /* ignore */ }
  try { await page.waitForTimeout(2000); } catch (e) { /* ignore */ }
  let after = '';
  try { after = String(page.url() || ''); } catch (e) { after = ''; }
  if (log && log.info) log.info(`[google] picked ${d.email} on the account chooser -> ${after.slice(0, 90)}`);
  return { picked: true, act: 'pick', email: d.email, url, after, why: d.why };
}

/*
 * A RE-AUTH CHALLENGE IS A WALL, NOT A STEP. Google answers a stale session with
 * /signin/challenge/<kind> — pwd for a password, pk for a passkey, totp, dp and others. None of
 * them may be answered by automation: a login is the owner's act, performed by hand once in the
 * console. Measured cost of not knowing this: 39 minutes of a job walking pwd then pk, holding the
 * profile the owner needed in order to sign in, while the dashboard showed a manual-action alarm it
 * had invented from its own inability to read the page.
 */
function isChallenge(url) {
  const u = String(url || '').toLowerCase();
  if (!u.includes('accounts.google.com')) return false;
  return /\/signin\/challenge(\/|\?|$)/.test(u) || u.includes('/challenge/pwd') || u.includes('/challenge/pk');
}

/*
 * THE COOKIES THAT ARE A GOOGLE SESSION. Absent these, a profile is signed out no matter how many
 * other google.com cookies it carries — the profile that stalled held 63 of them and none of these.
 */
const AUTH_COOKIES = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LSID'];

/**
 * Is this cookie jar signed in to Google? Pure, so it can be tested without a browser.
 * Returns { signedIn, found, missing }.
 */
function hasSession(cookies) {
  const names = new Set((cookies || [])
    .filter((c) => c && /(^|\.)google\.com$/.test(String(c.domain || '').replace(/^\./, '')))
    .map((c) => String(c.name || '')));
  /* SAPISID or __Secure-1PSID is the pair Google actually authenticates with; SID alone can linger. */
  const found = AUTH_COOKIES.filter((n) => names.has(n));
  const strong = found.includes('SAPISID') || found.includes('__Secure-1PSID') || found.includes('SID');
  return { signedIn: strong, found, missing: AUTH_COOKIES.filter((n) => !names.has(n)) };
}

/**
 * One sentence a human can act on, for the state a Google surface is actually in.
 * Kept separate from choose() because this decides whether to bother opening anything at all.
 */
function googleState(url, cookies, email) {
  const sess = hasSession(cookies);
  if (!sess.signedIn) {
    return {
      state: 'signed-out',
      why: 'the browser profile holds no Google session (no SID/SAPISID cookie), so Search Console'
        + ' reports no access to the property. Sign in once by hand in the console'
        + (email ? ` as ${email}` : '') + '. This is not a Google permission problem.',
    };
  }
  if (isChallenge(url)) {
    return {
      state: 'challenge',
      why: 'Google is asking to re-verify this session (password or passkey) and no automation may'
        + ' answer that. Sign in once by hand in the console'
        + (email ? ` as ${email}` : '') + '.',
    };
  }
  if (isChooser(url)) return { state: 'chooser', why: 'Google is asking which account to use' };
  return { state: 'in', why: '' };
}

module.exports = { isChooser, isSignIn, isChallenge, hasSession, googleState, decide, choose };
