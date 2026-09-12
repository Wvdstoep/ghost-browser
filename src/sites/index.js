'use strict';
/**
 * sites/index.js — the sites this browser knows, and how a login to each should be set up.
 *
 * WHY PRESETS RATHER THAN A NAME AND SOME FIELDS.
 *
 * A profile had to be named by hand and then labelled by hand — the site, a note, which operating
 * system to present as. The agent finds the right account BY that label, so a profile called
 * "carla-test-facebook" with an empty site field is invisible to it: the login exists, the agent
 * says it has none, and nothing about either half looks broken. Getting it wrong is silent, and the
 * only symptom is an agent that will not do what it is told.
 *
 * So the sites it knows are declared here, once, with the settings that are right for each. Picking
 * one creates the profile already labelled and already configured. There is nothing to type and
 * therefore nothing to mistype.
 *
 * WHAT EACH PRESET DECIDES, and why these and not others:
 *
 *   site        what the agent matches on. The whole reason presets exist.
 *   start       where to open it. A person setting up a login wants the login page, not a home
 *               page that will redirect them somewhere else first.
 *   presentAs   both Facebook and LinkedIn name the device on their "was this you?" screens, and
 *               both said Linux, which is unusual enough on a home connection to be worth a second
 *               look. Google does not care.
 *   (the exit) is deliberately NOT here. Routing through the tailnet is the default for every
 *               login now, rather than something each preset has to remember — the version where
 *               each one carried it lasted exactly as long as it took to add a preset that forgot.
 *   passkeys    refused on the sites that offer them, because a container has no fingerprint reader
 *               and the prompt hangs forever waiting for one — the failure that cost an evening.
 */

const SITES = {
  facebook: {
    label: 'Facebook',
    site: 'facebook.com',
    start: 'https://www.facebook.com/login',
    // Groups and posts: the richest source of people saying what they need, and the one that
    // challenges a new login hardest.
    defaults: { presentAs: 'windows', blockPasskeys: true, note: 'personal' },
    hint: 'Sign in, and solve whatever it asks — a code, a captcha, "was this you?". Do it once here and the agent uses this login from then on.',
  },
  linkedin: {
    label: 'LinkedIn',
    site: 'linkedin.com',
    start: 'https://www.linkedin.com/login',
    defaults: { presentAs: 'windows', blockPasskeys: true, note: 'business' },
    hint: 'Sign in. If it offers a passkey, choose another way — a container has no fingerprint reader and that prompt never finishes.',
  },
  /*
   * FREELANCE PLATFORMS — where the labour channel earns. The owner signs in once (KYC and
   * identity are theirs); the freelance roles then work these sessions. Useme is the Polish B2B
   * route and also settles invoicing; Upwork is the volume market.
   */
  useme: {
    label: 'Useme',
    site: 'useme.com',
    start: 'https://useme.com/pl/login/',
    defaults: { presentAs: 'windows', blockPasskeys: true, note: 'freelance PL' },
    hint: 'Sign in with your Useme account. This is the Polish freelance route — it also handles the invoicing side of a job.',
  },
  upwork: {
    label: 'Upwork',
    site: 'upwork.com',
    start: 'https://www.upwork.com/ab/account-security/login',
    defaults: { presentAs: 'windows', blockPasskeys: true, note: 'freelance global' },
    hint: 'Sign in, and clear whatever it challenges — Upwork checks new devices hard. Once this login holds, the agent scouts and drafts on it.',
  },
  /*
   * THE ROOMS THE GROWTH DESK POSTS INTO. Herald's desk reads these communities daily and posts into
   * them as the maker (a Show & Tell, a Show HN, a launch note) — which needs the OWNER signed in
   * there once, in that room's own profile. Reddit was a card on the dashboard with no preset behind
   * it; Hacker News and Indie Hackers were missing altogether, so there was nowhere to sign in.
   */
  reddit: {
    label: 'Reddit',
    site: 'reddit.com',
    start: 'https://www.reddit.com/login',
    defaults: { presentAs: 'windows', blockPasskeys: true, note: 'communities' },
    hint: 'Sign in with your own account — the desk posts and replies in subreddits as YOU, the maker, never as a page. Reddit may ask for an email code the first time.',
  },
  hn: {
    label: 'Hacker News',
    site: 'news.ycombinator.com',
    start: 'https://news.ycombinator.com/login',
    defaults: { presentAs: 'windows', blockPasskeys: true, note: 'communities' },
    hint: 'Sign in (or create an account) — a Show HN is posted from your own account. New accounts should read and comment a little before submitting.',
  },
  indiehackers: {
    label: 'Indie Hackers',
    site: 'indiehackers.com',
    start: 'https://www.indiehackers.com/sign-in',
    /*
     * IT LIVES IN THE GOOGLE PROFILE, deliberately. Indie Hackers offers Google as the way in, and a
     * Google sign-in inside a brand-new isolated profile is the one that Google challenges hardest and
     * usually refuses. Tried in both, it works in the GOOGLE profile and not in the shared browser,
     * so this preset opens there — a pin beats single-browser mode, because it is measured rather
     * than assumed. `profile` is the general form: any site whose only door is another site's login
     * can name the profile that actually holds it.
     */
    profile: 'google',
    defaults: { presentAs: 'windows', blockPasskeys: true, note: 'communities' },
    hint: 'Sign in with Google — this opens in your Google profile, where that login already works. A fresh isolated profile is what Google refuses.',
  },
  google: {
    label: 'Google',
    site: 'google.com',
    // The consent page is the thing to clear, and it is what a research run trips over first.
    start: 'https://www.google.com/search?q=test',
    defaults: { presentAs: '', blockPasskeys: false, note: 'search' },
    hint: 'Accept the consent page once. You do not have to sign in — searching works signed out, and staying signed out is less to lose.',
  },
};

// Sites the OWNER authored (a URL + roles), stored as data. They MERGE in here so a user site is a
// preset like any shipped one — the session-open flow, the profile setup and the listing are unchanged.
const userSites = require('../userSites');

/** A profile name that is stable, predictable, and cannot be typed wrongly. */
const slugName = (key) => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/* WHICH PROFILE A PRESET OPENS IN: its own, named after itself — unless the preset names another one
   (see indiehackers), in which case that login is the one to use and no second profile is created. */
const profileNameFor = (key) => {
  const s = SITES[String(key || '').toLowerCase()];
  return (s && s.profile) ? slugName(s.profile) : slugName(key);
};
/*
 * THE PIN: the profile a preset's login DEMONSTRABLY lives in, when it is not its own and not the
 * shared browser either. It outranks single-browser mode, because it is evidence rather than policy —
 * Indie Hackers signs in through Google and, tried in both, it works in the google profile and not in
 * the shared one. Nothing is created or relabelled for a pinned preset.
 */
const pinnedProfile = (key) => {
  const s = SITES[String(key || '').toLowerCase()];
  return (s && s.profile) ? slugName(s.profile) : null;
};

/*
 * THE PROFILE THAT ALREADY HOLDS THIS LOGIN, if there is one — by its name, or by the site label the
 * owner's setup wrote on it. This is what makes the ordering honest: a login that EXISTS is used, and
 * the shared browser is for sites nobody has signed into anywhere yet. Reddit is the case that proves
 * it — the owner signed in to Reddit in the reddit profile, so that is where a Reddit session belongs,
 * whatever the install's default jar is.
 */
const servedProfile = (key, existing = []) => {
  const row = list(existing).find((r) => r.key === String(key || '').toLowerCase());
  return (row && row.exists && row.servedBy) ? row.servedBy : null;
};

/* True when the preset borrows someone else's profile — the caller must NOT relabel that profile. */
const borrowsProfile = (key) => {
  const s = SITES[String(key || '').toLowerCase()];
  return !!(s && s.profile && slugName(s.profile) !== slugName(key));
};

// A stored user site, dressed as a preset. hint is generic because the owner, not us, knows the site.
const asPreset = (u) => u && ({
  label: u.label, site: u.site, start: u.start,
  defaults: u.defaults || { presentAs: 'windows', blockPasskeys: true, note: 'custom' },
  hint: 'Sign in once on this page. From then on the agent uses this login and works the roles you attached here.',
  custom: true, roles: u.roles || [],
});

// A built-in wins over a user key of the same slug, so an authored site can never shadow a shipped one.
const get = (key) => SITES[String(key || '').toLowerCase()] || asPreset(userSites.get(key)) || null;

/**
 * The presets, each saying whether a login already exists for it — so a UI can offer "set up
 * LinkedIn" and "open Facebook" without knowing anything about either.
 */
function list(existing = []) {
  /*
   * WHAT COUNTS AS ALREADY SET UP.
   *
   * The name, OR any profile carrying this site's label — and the second half matters more. A
   * login called "carla-test-facebook" labelled facebook.com IS the Facebook login: that label is
   * what the agent matches on, so a profile carrying it is set up whatever somebody called it.
   *
   * Matching on the name alone offered "Set up Facebook" beside a working Facebook login, and
   * accepting created an empty second one next to the real thing.
   *
   * Accepts plain names or objects with a site, so a caller that has not read the labels still gets
   * the old behaviour rather than an error.
   */
  const rows = existing.map((p) => (typeof p === 'string' ? { name: p } : p || {}));
  const byName = new Set(rows.map((r) => String(r.name || '').toLowerCase()));

  // One row per preset — the same shape whether it is shipped (SITES) or authored (userSites), so a
  // picker treats them alike. Authored rows carry `custom`, their `url` and `roles` so a UI can
  // render, open and remove them; a built-in row simply lacks those.
  const rowFor = (key, s, extra) => {
    const name = profileNameFor(key);
    const labelled = rows.find((r) => String(r.site || '').toLowerCase() === s.site);
    return {
      key,
      label: s.label,
      site: s.site,
      profile: name,
      start: s.start,
      hint: s.hint,
      exists: byName.has(name) || !!labelled,
      // WHICH login serves this site, so a picker can say so rather than leaving somebody to guess
      // whether their own profile counts.
      servedBy: byName.has(name) ? name : (labelled ? labelled.name : null),
      ...(extra || {}),
    };
  };

  const built = Object.entries(SITES).map(([key, s]) => rowFor(key, s));
  const authored = userSites.list().map((u) =>
    rowFor(u.key, { label: u.label, site: u.site, start: u.start, hint: asPreset(u).hint },
      { custom: true, url: u.start, roles: u.roles || [] }));
  return built.concat(authored);
}

module.exports = { SITES, get, list, profileNameFor, borrowsProfile, pinnedProfile, servedProfile };
