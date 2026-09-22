/**
 * profiles.js — how a named profile presents itself.
 *
 * A profile is not just a cookie jar. It is an identity: an exit IP, a timezone, a language, a
 * screen. Those have to agree with each other, and the moment they do not they become a signal.
 *
 * FOUND LIVE. The Facebook login kept returning to the login page after a solved captcha, and
 * while chasing the browser fingerprint the actual mismatch was sitting in the launch options:
 *
 *     timezone: Europe/Amsterdam        (what the browser claimed)
 *     exit IP:  65.108.13.228 — Finland, Hetzner, flagged proxy: true
 *
 * A browser on Amsterdam time arriving from a Finnish datacentre is not a subtle tell. Neither
 * value was wrong on its own; together they were.
 *
 * So each profile stores its own settings next to its cookies, on the same volume, and they travel
 * with it. The one that matters most is `proxy` — a profile can exit wherever its owner chooses,
 * which is the only real answer to a datacentre IP — and once it does, its timezone should be set
 * to match wherever that is.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.PROFILE_DIR || '/profiles';
const FILE = 'profile.json';

/* Defaults describe the platform's own exit, so an unconfigured profile is at least CONSISTENT —
   Finland, because that is where these pods actually are. A profile routed elsewhere should say so
   rather than inherit this. */
const DEFAULTS = {
  timezone: process.env.TIMEZONE || 'Europe/Helsinki',
  locale: process.env.LOCALE || 'en-GB',
  proxy: null,        // { server, username?, password? } — where this identity exits
  userAgent: null,    // null = whatever the real Chromium reports, which is the safest answer
  /*
   * REFUSE PASSKEY PROMPTS.
   *
   * A container has no fingerprint reader, no TPM and no Secure Enclave, so a site that calls
   * navigator.credentials.get() gets a promise nothing will ever resolve. Facebook's two-factor
   * page does exactly that: the button spins forever AND its own "try another way" link stops
   * working, because the page is still waiting on the request it made.
   *
   * Refusing immediately lets the fallback appear. Deliberately a REFUSAL and never a simulated
   * authenticator: an auto-approving virtual authenticator would let a site register a passkey
   * against credentials that vanish with the session, so the next login would expect one that no
   * longer exists — worse than the problem it solves.
   */
  blockPasskeys: false,
  /*
   * WHAT THIS LOGIN IS FOR.
   *
   * The agent can move between stored profiles — "search LinkedIn" should use the LinkedIn login,
   * not whichever session happened to be open. It cannot work that out from a name like
   * "carla-test-facebook" reliably, and guessing wrong means acting on the wrong account.
   *
   * `site` is the domain it belongs to; `note` is anything a person wants to add ("my business
   * page", "personal"). Both are read by the agent when it decides which profile to use.
   */
  site: '',
  note: '',
  /*
   * WHAT THIS PROFILE SHOULD LOOK LIKE IT IS RUNNING ON.
   *
   * Both Facebook's and LinkedIn's "was this you?" screens name the device, and both said Linux.
   * That is the one signal here that is genuinely misleading now: the traffic leaves through the
   * owner's own line, from their own account, and the only thing still describing a datacentre is
   * the operating system of the container it happens to run in.
   *
   * Empty means the browser tells the truth, which is the right default for anything that is not
   * fighting a checkpoint. See presentAs() in pool.js for why this cannot be a user-agent string.
   */
  presentAs: '',
  /*
   * WELKE ROL DIT PROFIEL GEBRUIKT — de keuze, niet een gok.
   *
   * THE ROLE OF THIS PROFILE, CHOSEN RATHER THAN GUESSED.
   *
   * Until now a profile's role was worked out by comparing NAMES: the phone matched the profile
   * name against the role names. That holds until someone renames either side, or names a profile
   * the way a person actually would ("work-video"), and then the pairing is gone with no error and
   * no trace — the agent quietly becomes a generalist with no playbook. It happened twice to the
   * same CapCut walk, which then spent 70 steps working out a video editor from scratch.
   *
   * Empty still means "work it out from the site", so a profile nobody configured keeps getting its
   * specialist. The difference is that a deliberate choice can now be recorded, read back, and
   * changed. Validated here for SHAPE only — whether the id names a real role is the server's
   * business, because this module must not learn about the role store.
   */
  defaultRole: '',
};

const safeName = (name) => String(name || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'default';
const dirFor = (name) => path.join(DIR, safeName(name));

function read(name) {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(dirFor(name), FILE), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

/**
 * Only the fields that are understood, validated. A proxy string that Chromium cannot parse fails
 * the launch with an error nobody connects back to a settings screen, and a bad timezone throws at
 * context creation — both worth catching here instead.
 */
function normalize(input = {}) {
  const out = {};
  if (typeof input.timezone === 'string' && /^[A-Za-z]+\/[A-Za-z_+-]+$/.test(input.timezone)) {
    // Ask the runtime, rather than shipping a list of zone names that will be wrong eventually.
    try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); out.timezone = input.timezone; }
    catch { /* not a zone this runtime knows */ }
  }
  if (typeof input.locale === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(input.locale)) out.locale = input.locale;
  if (typeof input.userAgent === 'string' && input.userAgent.trim()) out.userAgent = input.userAgent.trim().slice(0, 400);
  if (typeof input.blockPasskeys === 'boolean') out.blockPasskeys = input.blockPasskeys;
  // Stored bare (facebook.com), because it is shown to a person and read by a model, not fetched.
  if (typeof input.site === 'string') out.site = input.site.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 120);
  if (typeof input.note === 'string') out.note = input.note.trim().slice(0, 300);
  /* Same character class as a role id. '' is a real value here: it CLEARS the choice and
     goes back to working it out from the site, so it must not be treated as "unchanged". */
  if (typeof input.defaultRole === 'string') out.defaultRole = input.defaultRole.trim().replace(/[^a-z0-9._-]/gi, '').slice(0, 60);
  // A closed set, because each value needs a matching set of Client Hints to go with it — a free
  // string here would produce a browser that disagrees with itself, which is worse than Linux.
  if (input.presentAs === '' || input.presentAs === null) out.presentAs = '';
  else if (input.presentAs === 'windows' || input.presentAs === 'mac') out.presentAs = input.presentAs;

  if (input.proxy === null) out.proxy = null;
  /*
   * `"tailscale"` rather than a hand-copied socks5 URL. The port is this image's business, and a
   * profile that hard-codes it breaks the day it changes; saying WHERE it exits rather than HOW is
   * also the thing a person can read back and understand.
   */
  else if (input.proxy === 'tailscale' || (input.proxy && input.proxy.server === 'tailscale')) out.proxy = 'tailscale';
  /* 'direct' is not the same as unset. Unset means "whatever the default is", which is now the
     tailnet; 'direct' is a profile deliberately going out from this server, and it has to survive
     the default changing under it. */
  else if (input.proxy === 'direct') out.proxy = 'direct';
  else if (input.proxy && typeof input.proxy === 'object' && typeof input.proxy.server === 'string') {
    const server = input.proxy.server.trim();
    // http, https and socks5 are what Chromium accepts. Anything else is a typo that would only
    // surface as a failed launch minutes later.
    if (/^(https?|socks5):\/\/[^\s/]+$/.test(server)) {
      out.proxy = { server };
      if (input.proxy.username) out.proxy.username = String(input.proxy.username).slice(0, 200);
      if (input.proxy.password) out.proxy.password = String(input.proxy.password).slice(0, 200);
    }
  }
  return out;
}

function write(name, input) {
  const dir = dirFor(name);
  fs.mkdirSync(dir, { recursive: true });
  const merged = { ...read(name), ...normalize(input) };
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

/** What the UI may see. The proxy password never leaves the server. */
function redacted(name) {
  const s = read(name);
  if (s.proxy === 'tailscale') return { ...s, proxy: 'tailscale' };
  return {
    ...s,
    proxy: s.proxy ? { server: s.proxy.server, username: s.proxy.username || null, password: s.proxy.password ? '••••' : null } : null,
  };
}

/** Resolve what a profile SAYS into what Chromium needs. */
/**
 * What a profile's setting means once the tailnet's actual state is known.
 *
 *   'direct'      out from this server, deliberately.
 *   'tailscale'   through the tailnet, and REFUSE to launch if it is not available.
 *   unset         whatever the default says, which is the tailnet when one is up.
 *   {server}      a proxy somebody configured by hand.
 *
 * THE REFUSAL IS THE POINT. This used to return null when the tailnet was unavailable, which meant
 * a profile configured for a home connection silently went out from a datacentre instead —
 * configured correctly, behaving wrongly, reporting neither. A login that quietly leaves from the
 * wrong country is how an account gets locked, so it does not launch at all.
 */
function launchProxy(setting, tailscaleSocks, { routeAll = false } = {}) {
  if (setting === 'direct') return null;
  if (!setting) {
    if (!routeAll || !tailscaleSocks) return null;
    return { server: tailscaleSocks };
  }
  if (setting === 'tailscale') {
    if (!tailscaleSocks) {
      throw Object.assign(new Error(
        'this login is set to leave through your tailnet, and the tailnet is not available — '
        + 'refusing to open it from this server instead.'),
      { status: 409,
        hint: 'Open the exit panel and connect your tailnet, or set this login to “always this '
            + 'server” in Setup if leaving from here is fine for it.' });
    }
    return { server: tailscaleSocks };
  }
  return setting;
}

module.exports = { read, write, normalize, redacted, launchProxy, dirFor, safeName, DEFAULTS, FILE };
