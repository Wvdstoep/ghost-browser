/**
 * playbook.js — what this account has already learned about where leads are.
 *
 * THE PROBLEM IT SOLVES. Every run started from nothing. It rediscovered that Facebook has a post
 * search, tried phrasings somebody had already tried last week, swept a group that has produced
 * nothing in a month, and forgot all of it the moment the conversation ended. A prompt cannot fix
 * that: telling a model "you know Facebook" does not tell it that "programmeur gezocht" returns
 * recruiters while "wie kan mij helpen met een webshop" returns customers. Only doing it does, and
 * only if the answer is written down.
 *
 * SO IT KEEPS SCORE, AND THE SCORE IS EARNED RATHER THAN CLAIMED. Nothing here asks the model how
 * it did. A sweep records how many posts a place returned; the leads saved before the next sweep
 * are attributed to it. A model that thinks it did well and a model that did well are different
 * things, and only one of them shows up in these numbers.
 *
 * WHAT IT IS DELIBERATELY NOT is a ranking that hides its own history. Every entry carries the raw
 * counts, so "nothing here yet" and "thirty posts and never a lead" stay distinguishable — the
 * first deserves another try and the second does not, and an average alone cannot tell them apart.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'playbooks');

/* A place is a search or a group. The key is what identifies it across runs. */
const keyOf = (place) => {
  if (!place || !place.kind) return null;
  const what = String(place.what || '').trim().toLowerCase();
  if (!what) return null;
  return `${place.kind}:${place.scope ? String(place.scope).toLowerCase() + ':' : ''}${what}`;
};

const fileFor = (site) => path.join(DIR, `${String(site || 'facebook').replace(/[^a-z0-9_-]/gi, '')}.json`);

function read(site = 'facebook') {
  try { return { places: {}, ...JSON.parse(fs.readFileSync(fileFor(site), 'utf8')) }; }
  catch { return { places: {} }; }
}

function write(site, book) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fileFor(site), JSON.stringify(book, null, 2), { mode: 0o600 });
  } catch { /* a playbook that cannot be written is not worth failing a run over */ }
  return book;
}

/**
 * A place was swept. Records what it returned — not what anyone thought of it.
 */
function recordSweep(site, place, { posts = 0, tooOld = 0, at = new Date().toISOString() } = {}) {
  const key = keyOf(place);
  if (!key) return null;
  const book = read(site);
  const e = book.places[key] || { kind: place.kind, what: place.what, scope: place.scope || null,
                                  sweeps: 0, posts: 0, tooOld: 0, leads: 0, lastSwept: null, lastLead: null };
  e.sweeps += 1;
  e.posts += posts;
  e.tooOld += tooOld;
  e.lastSwept = at;
  book.places[key] = e;
  write(site, book);
  return e;
}

/**
 * A lead was saved. Attributed to the place most recently swept, because that is where it came
 * from — the agent is not asked, and could not be relied on to remember.
 */
function recordLead(site, place, { at = new Date().toISOString() } = {}) {
  const key = keyOf(place);
  if (!key) return null;
  const book = read(site);
  const e = book.places[key];
  if (!e) return null;
  e.leads += 1;
  e.lastLead = at;
  write(site, book);
  return e;
}

/*
 * WORTH TRYING AGAIN, OR NOT.
 *
 * A place is written off only on evidence: swept properly more than a few times, a real number of
 * posts read, and never once a lead. Anything thinner than that is "not tried enough yet", because
 * writing somewhere off after one quiet afternoon is how you lose the group that produces a
 * customer a month.
 */
const DEAD_AFTER_SWEEPS = 3;
const DEAD_AFTER_POSTS = 25;

const isDead = (e) => e.leads === 0 && e.sweeps >= DEAD_AFTER_SWEEPS && e.posts >= DEAD_AFTER_POSTS;

/**
 * The playbook as the agent reads it: what has worked, what has not, and what has not been tried.
 *
 * Ordered by leads per sweep rather than by leads, so a search tried once that found two beats one
 * tried twenty times that found three — the first is a better bet for the next twenty minutes.
 */
function asContext(site = 'facebook', { limit = 12 } = {}) {
  const book = read(site);
  const all = Object.values(book.places || {});
  if (!all.length) return '';

  const worked = all.filter((e) => e.leads > 0)
    .sort((a, b) => (b.leads / Math.max(1, b.sweeps)) - (a.leads / Math.max(1, a.sweeps)))
    .slice(0, limit);
  const dead = all.filter(isDead).slice(0, limit);

  const line = (e) => `- ${e.kind === 'group' ? 'group' : 'search'} "${e.what}"`
    + (e.scope ? ` in ${e.scope}` : '')
    + ` — ${e.leads} lead(s) from ${e.posts} post(s) over ${e.sweeps} sweep(s)`
    + (e.lastLead ? `, last one ${e.lastLead.slice(0, 10)}` : '');

  const parts = [];
  if (worked.length) {
    parts.push(`WHAT HAS WORKED BEFORE, best first — start here rather than guessing:\n${worked.map(line).join('\n')}`);
  }
  if (dead.length) {
    parts.push(`SWEPT REPEATEDLY AND NEVER PRODUCED ANYONE — do not spend time here again:\n${dead.map(line).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Everything, for a person who wants to see what it thinks it knows. */
const summary = (site = 'facebook') => {
  const all = Object.values(read(site).places || {});
  return {
    site,
    places: all.map((e) => ({ ...e, dead: isDead(e), perSweep: +(e.leads / Math.max(1, e.sweeps)).toFixed(2) }))
      .sort((a, b) => b.perSweep - a.perSweep || b.leads - a.leads),
  };
};

const forget = (site = 'facebook') => write(site, { places: {} });

module.exports = { read, recordSweep, recordLead, asContext, summary, forget, keyOf, isDead,
                   DEAD_AFTER_SWEEPS, DEAD_AFTER_POSTS, DIR };
