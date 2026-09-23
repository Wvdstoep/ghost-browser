/*
 * roleEngine.js — WHICH SPECIALIST THIS TASK NEEDS, AND WHY THAT ONE.
 *
 * A profile's stored role answers "what does this login usually do". It does not answer "what does
 * THIS task need", and that is the question when a request arrives in the chat with no role named —
 * the case that ran on the cluster as `general`, opened a video editor it had no playbook for, and
 * died after seventy steps.
 *
 * So: one function, five sources in descending confidence, and the reason travels with the answer.
 *
 *   named    somebody said which role. Never second-guessed.
 *   chosen   the profile carries a role somebody set on it.
 *   goal     no stored choice, but the goal names an address a role knows.
 *   site     the profile's own site matches a role's.
 *   none     none of the above, so it runs general — said plainly, not defaulted in silence.
 *
 * THE ONE ORDERING DECISION WORTH ARGUING ABOUT is `chosen` before `goal`. The other way round reads
 * well — "a goal naming capcut.com wants the CapCut specialist" — and it is how a task-first engine
 * would naturally work. It is also how a role gets hijacked by a passing mention: "make the short,
 * then post the link on facebook.com" would swap the video editor for a reply desk, and the person
 * who deliberately set this profile's role would have no idea why.
 *
 * A deliberate human choice outranks a string found in a sentence. But the alternative is never
 * swallowed: when the goal points somewhere else, the answer SAYS so and names the role it would
 * have picked, so the correction is one word instead of an investigation. That is the whole point of
 * carrying the reason — "why did it run as general?" was unanswerable twice.
 */
'use strict';

const { siteKey, roleChoice } = require('./profileRole');

/*
 * Address-shaped words in a goal. Deliberately loose, because it does not have to be right on its
 * own: only a candidate whose siteKey matches a role's is ever used, so "e.g." and "etc." and every
 * other false positive filter themselves out against real data instead of against a blocklist that
 * would need maintaining forever.
 */
const HOSTISH = /\b((?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,})\b/gi;

/** Every address in the goal that a role actually knows, in the order they appear. */
/**
 * Every host the goal names, whether or not a role knows it.
 *
 * [sitesInGoal] deliberately returns only hosts a role SPECIALISES in, because that is what makes
 * one the right choice. This is the opposite question and it needs asking too: a goal naming a site
 * nobody specialises in is still a goal about somewhere else, and that fact has to be visible.
 */
function hostsInGoal(goal) {
  const out = [];
  const seen = new Set();
  let m;
  HOSTISH.lastIndex = 0;
  while ((m = HOSTISH.exec(String(goal || ''))) !== null) {
    const k = siteKey(m[1]);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ host: m[1], key: k });
  }
  return out;
}

/**
 * Does the goal point somewhere other than this profile's own site?
 *
 * Returns the first such host, or null. "Somewhere else" means the goal names at least one host and
 * none of them is this profile's site — one mention of another domain alongside the profile's own
 * is an ordinary cross-reference, not a different task.
 */
function elsewhereInGoal(goal, profile) {
  const hosts = hostsInGoal(goal);
  if (!hosts.length) return null;
  const mine = siteKey(profile);
  if (mine && hosts.some((h) => h.key === mine)) return null;
  return hosts[0];
}

function sitesInGoal(goal, roles) {
  const text = String(goal || '');
  const known = new Map();
  for (const row of (roles.list() || [])) {
    const k = siteKey(row.site);
    if (k && !known.has(k)) known.set(k, row);
  }
  const out = [];
  const seen = new Set();
  let m;
  HOSTISH.lastIndex = 0;
  while ((m = HOSTISH.exec(text)) !== null) {
    const k = siteKey(m[1]);
    if (!k || seen.has(k) || !known.has(k)) continue;
    seen.add(k);
    out.push({ host: m[1], key: k, row: known.get(k) });
  }
  return out;
}

/**
 * @param {object} task   { goal, profile, named }  named = a role the caller asked for, if any
 * @param {object} deps   { profiles, roles }
 * @returns {{role: string, source: string, why: string, alternatives: object[]}}
 */
/**
 * Tools the goal names outright.
 *
 * Only a word that IS a tool counts, matched against the role store's own idea of what exists. The
 * point is a goal that says "use save_place" — an instruction so explicit that any role which
 * cannot obey it is the wrong role, whatever else recommends it.
 */
function toolsNamedIn(goal, known) {
  if (!known || !known.size) return [];
  const out = [];
  const seen = new Set();
  /* No word-boundary escape here on purpose: written through a patch it has twice arrived as a
     literal backspace character, producing a regex that compiles and matches nothing. A leading
     non-word character does the same job and cannot be mangled. */
  for (const m of String(goal || "").matchAll(/(?:^|[^a-z0-9_])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)/g)) {
    const w = m[1];
    if (known.has(w) && !seen.has(w)) { seen.add(w); out.push(w); }
  }
  return out;
}

/** What a role may reach for, or null when it may reach for everything. */
function ownTools(roles, name) {
  try { const r = roles.get(name); return r && Array.isArray(r.tools) ? r.tools : null; } catch { return null; }
}

/**
 * The answer we were going to give, unless it cannot do what the goal explicitly asks for.
 *
 * MEASURED, NOT IMAGINED. A goal reading "use save_place with its name, address, phone and website"
 * was given google.research, which does not carry save_place. It was refused twice across
 * sixty-two steps and wrote nothing. The agent reported honestly — "found five plumbers", never
 * "saved" — so no verifier had anything to catch, and the run simply produced nothing.
 *
 * A named tool is the least ambiguous instruction a goal can contain. A specialist that cannot
 * follow it is not a specialist for this work, and `general` carries everything.
 */
function ableTo(decision, goal, deps) {
  const { roles } = deps;
  let known = null;
  try { known = new Set((roles.list() || []).flatMap((r) => (Array.isArray(r.tools) ? r.tools : []))); }
  catch { known = null; }
  const wanted = toolsNamedIn(goal, known);
  if (!wanted.length) return decision;

  const have = ownTools(roles, decision.role);
  if (!have) return decision;                       // a role with every tool can do anything asked
  const missing = wanted.filter((w) => !have.includes(w));
  if (!missing.length) return decision;

  return {
    ...decision,
    role: 'general',
    source: 'needs',
    why: `the goal asks for ${missing.join(', ')}, which ${decision.role} does not carry`,
    alternatives: [
      ...(decision.alternatives || []),
      { role: decision.role, source: decision.source, why: `${decision.role} was the closest specialist, but it cannot ${missing[0]}` },
    ],
  };
}

function roleForTask(task = {}, deps) {
  const { profiles, roles } = deps || {};
  if (!profiles || !roles) throw new Error('roleForTask needs { profiles, roles }');
  const { goal = '', profile = '', named = '' } = task;
  const alternatives = [];

  /* 1. Somebody said which one. That is the end of it. */
  const asked = String(named || '').trim();
  if (asked && asked.toLowerCase() !== 'general' && roles.get(asked)) {
    return { role: roles.canonical(asked), source: 'named', why: 'you named this role', alternatives };
  }
  if (asked && asked.toLowerCase() !== 'general' && !roles.get(asked)) {
    /* Asked for something that does not exist: fall through, but never silently. */
    alternatives.push({ role: asked, source: 'named', why: `there is no role called "${asked}"` });
  }

  const goalSites = sitesInGoal(goal, roles);
  const choice = roleChoice(profile, { profiles, roles });

  /* 2. The profile's own stored choice — a decision somebody made about this login. */
  if (choice.source === 'chosen') {
    /* Something the goal points at that is NOT the role we are about to use. */
    const other = goalSites.find((s) => roles.canonical(s.row.name) !== choice.role);
    if (other) {
      alternatives.push({
        role: roles.canonical(other.row.name), source: 'goal',
        why: `the goal mentions ${other.host}, whose specialist is ${roles.canonical(other.row.name)} — name it to use that instead`,
      });
    }
    return ableTo({ role: choice.role, source: 'chosen', why: `${profile || 'this profile'} is set to use ${choice.role}`, alternatives }, goal, deps);
  }

  /* 3. No stored choice, so the address in the goal is the strongest evidence there is. */
  if (goalSites.length) {
    const first = goalSites[0];
    for (const s of goalSites.slice(1)) {
      alternatives.push({ role: roles.canonical(s.row.name), source: 'goal', why: `the goal also mentions ${s.host}` });
    }
    return ableTo({
      role: roles.canonical(first.row.name), source: 'goal',
      why: `the goal mentions ${first.host}, and ${roles.canonical(first.row.name)} knows that site`,
      alternatives,
    }, goal, deps);
  }

  /* 4. The profile's site. Today's rule, kept, so an unconfigured profile is not a generalist. */
  if (choice.source === 'site') {
    /*
     * UNLESS THE GOAL IS PLAINLY ABOUT SOMEWHERE ELSE.
     *
     * Measured on a real run: the goal named ecb.europa.eu, the profile in use was facebook, and the
     * job ran as facebook.scout. That role does not carry download_link, so the download was refused
     * before it began — and the agent then reported that it had downloaded the file anyway. The
     * verifier caught the claim, correctly, but the run had been set up to fail from the first step.
     *
     * A site specialist is worth having because of its playbook FOR THAT SITE. Pointed at a
     * different domain it is only a narrower toolbox and instructions about the wrong place, which
     * is strictly worse than a generalist. The profile still decides which LOGIN is used; it should
     * not decide the role for work that is not about it.
     */
    const away = elsewhereInGoal(goal, profile);
    if (away) {
      alternatives.push({
        role: choice.role, source: 'site',
        why: `${profile} normally uses ${choice.role} — name it if this really is ${profile} work`,
      });
      return {
        role: 'general', source: 'elsewhere',
        why: `the goal is about ${away.host}, not ${profile}, so a ${profile} specialist would only narrow what it can do`,
        alternatives,
      };
    }
    return ableTo({ role: choice.role, source: 'site', why: `${profile || 'this profile'} belongs to a site ${choice.role} knows`, alternatives }, goal, deps);
  }

  /* 5. Nothing points anywhere. Said out loud, because a silent general is the failure this exists
        to end — an agent with no playbook, working the site out from scratch. */
  if (choice.missing) {
    alternatives.push({ role: choice.missing, source: 'chosen', why: `${profile} names "${choice.missing}", which no longer exists` });
  }
  return {
    role: 'general', source: 'none',
    why: 'no role names this work, this profile has none set, and the goal names no site a role knows',
    alternatives,
  };
}

/** The decision in one line, for a log and for the chat to show before the work starts. */
function explainChoice(d) {
  if (!d) return '';
  const head = d.source === 'none' ? `running as a generalist — ${d.why}` : `using ${d.role} — ${d.why}`;
  if (!d.alternatives || !d.alternatives.length) return head;
  return `${head}. ${d.alternatives.map((a) => a.why).join('. ')}`;
}

module.exports = { roleForTask, toolsNamedIn, hostsInGoal, elsewhereInGoal, explainChoice, sitesInGoal };
