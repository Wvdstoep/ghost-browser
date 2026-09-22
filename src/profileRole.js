/*
 * profileRole.js — WHICH ROLE A PROFILE USES, AND WHERE THAT ANSWER CAME FROM.
 *
 * A profile is a login; a role is the playbook for working in it. The two belong together, and
 * until now the pairing was worked out by comparing NAMES: the phone matched the profile name
 * against the role names. That holds right up until someone renames either side, or names a profile
 * the way a person actually would ("work-video"), and then the pairing is gone with no error and no
 * trace — the agent quietly becomes a generalist with no playbook. It happened twice to the same
 * CapCut walk, which then spent seventy steps working out a video editor from scratch.
 *
 * There are also THREE doors into a run — the workflow route, the assistant's walk (the phone's
 * chat), and the hand-over to a device — and a rule added to one of them is not on the others. That
 * is how the CapCut request came in through the chat and missed the device requirement entirely. So
 * this answer lives in one module that all three doors and the UI read, rather than in whichever
 * door someone last touched.
 *
 * THE SOURCE TRAVELS WITH THE ANSWER. "capcut-video-editor" and "capcut-video-editor, because the
 * names happened to match" are very different facts, and only the second silently stops being true
 * when something is renamed. Every automatic pick has to be able to say why, because "why did it
 * run as general?" was unanswerable both times it mattered.
 */
'use strict';

/**
 * A profile name and a role's site reduced to the same word: "p_capcut", "capcut.com" and
 * "www.capcut.com" all become "capcut".
 *
 * The www strip is not cosmetic: without it "www.capcut.com" keyed as "www", which matches nothing
 * it should and would put every www-prefixed site under one word.
 */
function siteKey(s) {
  return String(s || '').toLowerCase().replace(/^p_/, '').replace(/^www\./, '')
    .split('.')[0].replace(/[^a-z0-9]/g, '');
}

/**
 * Three sources, in descending confidence:
 *
 *   chosen   someone set `defaultRole` on the profile. Nothing overrides it.
 *   site     no choice stored, but a role knows this profile's site. Today's rule, kept as the
 *            fallback so a profile nobody configured still gets its specialist rather than general.
 *   none     neither, so the work runs general — said plainly rather than defaulted in silence.
 *
 * A stored role that no longer exists is reported as `missing` and never silently ignored: the
 * profile was configured on purpose and the configuration has rotted, which is the one case that
 * looks configured and behaves like a generalist.
 *
 * @param {string} name    profile name ("capcut", "p_capcut")
 * @param {object} deps    { profiles, roles } — injected so this is testable without a browser
 */
function roleChoice(name, deps) {
  const { profiles, roles } = deps || {};
  if (!profiles || !roles) throw new Error('roleChoice needs { profiles, roles }');
  let cfg = {};
  try { cfg = profiles.read(name) || {}; } catch { cfg = {}; }

  const stored = String(cfg.defaultRole || '').trim();
  if (stored && roles.get(stored)) return { role: roles.canonical(stored), source: 'chosen' };

  /* The profile's declared site first, then its name — a profile called "work-video" with
     site capcut.com should still find the CapCut specialist. */
  for (const candidate of [cfg.site, name]) {
    const key = siteKey(candidate);
    if (!key) continue;
    const own = (roles.list() || []).find((x) => siteKey(x.site) === key);
    if (own) {
      const canon = roles.canonical(own.name);
      return { role: canon, source: 'site', suggested: canon, ...(stored ? { missing: stored } : {}) };
    }
  }
  return { role: 'general', source: 'none', ...(stored ? { missing: stored } : {}) };
}

module.exports = { siteKey, roleChoice };
