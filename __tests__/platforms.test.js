/*
 * THE PLATFORM REGISTRY — one place that says what a platform is and how it may be worked.
 *
 * These pin the two things that make it worth having. First: on the day it lands NOTHING CHANGES —
 * every constant the three services carried is here, with the same value, so behaviour is identical
 * and only the ownership moved. Second: the rules that keep an account alive (a first DM only where
 * it is ordinary, a pace that is not a crawler) cannot be edited away by an override.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'gb-platforms-'));
process.env.PROFILE_DIR = tmp;

const platforms = require('../src/platforms');

beforeEach(() => { try { if (existsSync(platforms.FILE)) rmSync(platforms.FILE); } catch { /* fresh anyway */ } });
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* windows */ } });

describe('what shipped is exactly what the three services carried', () => {
  it('keeps the read gaps Herald paced by', () => {
    const gap = (k) => platforms.get(k).readGapMs;
    expect(gap('reddit')).toBe(25 * 60 * 1000);
    expect(gap('linkedin')).toBe(20 * 60 * 1000);
    expect(gap('hn')).toBe(20 * 60 * 1000);
    expect(gap('web')).toBe(12 * 60 * 1000);
    /* Everything else was Herald's 15-minute default. */
    expect(gap('facebook')).toBe(15 * 60 * 1000);
  });

  it('keeps the roles each platform is read and answered with', () => {
    expect(platforms.get('reddit').roles.scan).toBe('research.reddit');
    expect(platforms.get('linkedin').roles.scan).toBe('research.linkedin');
    expect(platforms.get('hn').roles.scan).toBe('research.web');
    expect(platforms.get('facebook').roles.reply).toBe('herald.facebook.groups.engage');
  });

  /*
   * READING A ROOM AND SCOUTING FOR PEOPLE ARE TWO JOBS, and folding them into one field silently
   * changed behaviour the first time it was tried: the desk's Facebook reads landed on facebook.scout,
   * a role that holds save_lead and cannot post, so a room read would have started saving leads
   * instead of reporting threads. Herald reads a room and REPORTS; LeadFlow reads for PEOPLE and SAVES.
   */
  it('separates reading a room from scouting for people', () => {
    const fb = platforms.get('facebook');
    expect(fb.roles.scan).toBe('research.web');        // Herald: read the group, report the threads
    expect(fb.roles.scout).toBe('facebook.scout');     // LeadFlow: find people, save each as a lead
    const li = platforms.get('linkedin');
    expect(li.roles.scan).toBe('research.linkedin');
    expect(li.roles.scout).toBe('linkedin.scout');
    expect(li.roles.dm).toBe('linkedin.conversation');
    /* Rooms have a scout. A TOOL — the image workbench — has nobody in it to find, and giving it a
       scout role to satisfy a loop would advertise a capability that does not exist. */
    for (const r of platforms.list().filter((x) => x.kind !== 'tool')) expect(typeof r.roles.scout).toBe('string');
  });

  it('places a room the way Herald placed it, in the same order', () => {
    expect(platforms.detect('r/webdev')).toBe('reddit');
    expect(platforms.detect('https://www.reddit.com/r/SaaS/')).toBe('reddit');
    expect(platforms.detect('the Bakkers FB group')).toBe('facebook');
    expect(platforms.detect('LinkedIn: DevOps NL')).toBe('linkedin');
    expect(platforms.detect('Show HN')).toBe('hn');
    expect(platforms.detect('news.ycombinator.com/newest')).toBe('hn');
    expect(platforms.detect('Indie Hackers')).toBe('indiehackers');
    expect(platforms.detect('a mailing list somebody described in prose')).toBe('web');
  });

  it('derives the room URLs that are derivable and no others', () => {
    expect(platforms.roomUrl('reddit', 'r/webdev')).toBe('https://www.reddit.com/r/webdev/new/');
    expect(platforms.roomUrl('hn', 'Show HN')).toBe('https://news.ycombinator.com/newest');
    expect(platforms.roomUrl('producthunt', 'Product Hunt')).toBe('https://www.producthunt.com/');
    expect(platforms.roomUrl('linkedin', 'DevOps NL')).toBe('');
    /* A URL the caller already has always wins. */
    expect(platforms.roomUrl('reddit', 'r/webdev', 'https://example.com/x')).toBe('https://example.com/x');
  });

  it('carries the profile names, INCLUDING the ones a swallowed comment had deleted', () => {
    /* herald/src/gb.js had `indiehackers: [], // …comment… producthunt: [...], youtube: [...], x: [...]`
       on ONE line: everything after the comment marker was gone, so those platforms had no profile
       names at all and every walk on them ran in the shared session, signed out. */
    expect(platforms.get('producthunt').profiles).toContain('producthunt');
    expect(platforms.get('youtube').profiles).toContain('youtube');
    expect(platforms.get('x').profiles).toEqual(expect.arrayContaining(['x', 'twitter']));
    expect(platforms.get('google').profiles).toContain('google');
    expect(platforms.get('web').profiles).toContain('google');
    expect(platforms.get('linkedin').profiles).toEqual(expect.arrayContaining(['linkedin', 'linkdin']));
    expect(platforms.get('hn').profiles).toEqual(expect.arrayContaining(['hn', 'hackernews']));
  });

  it('keeps the Indie Hackers pin, which used to be written twice in two repositories', () => {
    expect(platforms.get('indiehackers').loginProfile).toBe('google');
    /* It named NO profile of its own and was matched to google only by a site label. Both an
       'indiehackers' and the 'google' profile hold its cookies on disk now; the pin still wins. */
    expect(platforms.get('indiehackers').profiles).toEqual(['indiehackers']);
  });

  it('the fallback is last, so detect can never return it early', () => {
    const keys = platforms.list().map((r) => r.key);
    expect(keys[keys.length - 1]).toBe('web');
  });
});

describe('who may be spoken to, and how loudly', () => {
  it('a first private message is ordinary only on a business platform', () => {
    expect(platforms.get('linkedin').dm).toBe('ok');
    expect(platforms.get('facebook').dm).toBe('invited-only');
    expect(platforms.get('reddit').dm).toBe('invited-only');
    /* Where a stranger's DM lands in a request folder nobody opens, the answer is no, not "gently". */
    expect(platforms.get('hn').dm).toBe('never');
    expect(platforms.get('producthunt').dm).toBe('never');
    expect(platforms.get('x').dm).toBe('never');
  });

  it('nobody is reached through Google — it is how they are found', () => {
    const g = platforms.get('google');
    expect(g.kind).toBe('search');
    expect(g.reply).toBe(false);
    expect(g.dm).toBe('never');
  });

  it('every record answers all three questions', () => {
    for (const r of platforms.list()) {
      expect(typeof r.read).toBe('boolean');
      expect(typeof r.reply).toBe('boolean');
      expect(['ok', 'invited-only', 'never']).toContain(r.dm);
      /* A read gap is a politeness rule for a room somebody else owns. A tool is the owner's own
         workbench, read on demand, so the floor applies to rooms only. */
      if (r.kind !== 'tool') expect(r.readGapMs).toBeGreaterThanOrEqual(60 * 1000);
    }
  });

  /*
   * A TOOL IS IN THE REGISTRY FOR ONE REASON: to say which browser profile holds its login.
   *
   * A picture walk dispatched at "platform: google" had no record here, so the lookup found nothing,
   * fell through to the single-browser default and opened the image generator in the FACEBOOK jar.
   * The account that is actually signed in — PRO, with the image models on it — lives in the
   * googleaistudio profile. That belongs written down once, where every caller reads it.
   *
   * What it must NOT do is look like a room. Nothing is read there, nothing is replied to, no brand
   * has a presence on a workbench, and a record that quietly defaulted to friendlier values would put
   * it in front of a desk looking for somewhere to post.
   */
  it('the image workbench is a tool, and says so in every field that matters', () => {
    const t = platforms.get('googleaistudio');
    expect(t.kind).toBe('tool');
    expect(t.loginProfile).toBe('googleaistudio');
    expect(t.read).toBe(false);
    expect(t.reply).toBe(false);
    expect(t.dm).toBe('never');
    expect(t.roles.scan).toBeNull();
    expect(t.roles.scout).toBeNull();
  });
});

describe('the owner can change the rules without a deploy — but not break them', () => {
  it('takes a partial patch and leaves the rest of the record alone', () => {
    platforms.override('reddit', { repliesPerDay: 1 });
    expect(platforms.get('reddit').repliesPerDay).toBe(1);
    expect(platforms.get('reddit').roles.scan).toBe('research.reddit');
    expect(platforms.get('reddit').readGapMs).toBe(25 * 60 * 1000);
  });

  it('refuses a pace that is a crawler rather than a pace', () => {
    platforms.override('reddit', { readGapMs: 1000 });
    expect(platforms.get('reddit').readGapMs).toBe(25 * 60 * 1000);
    platforms.override('reddit', { readGapMs: 40 * 60 * 1000 });
    expect(platforms.get('reddit').readGapMs).toBe(40 * 60 * 1000);
  });

  it('refuses a dm setting that is not one of the three answers', () => {
    platforms.override('hn', { dm: 'sure why not' });
    expect(platforms.get('hn').dm).toBe('never');
    platforms.override('hn', { dm: 'invited-only' });
    expect(platforms.get('hn').dm).toBe('invited-only');
  });

  it('ignores a field nobody may set from outside', () => {
    platforms.override('reddit', { key: 'evil', site: 'evil.example' });
    expect(platforms.get('reddit').site).toBe('reddit.com');
    expect(platforms.get('evil')).toBe(null);
  });

  it('resets to what shipped', () => {
    platforms.override('reddit', { repliesPerDay: 9 });
    expect(platforms.get('reddit').repliesPerDay).toBe(9);
    expect(platforms.reset('reddit')).toBe(true);
    expect(platforms.get('reddit').repliesPerDay).toBe(2);
  });

  it('a platform that does not exist is a 404, not a new record', () => {
    expect(() => platforms.override('tiktok', { dm: 'ok' })).toThrow(/no such platform/);
  });
});

describe('the tab can say whether we are even signed in', () => {
  it('a profile named after the platform counts', () => {
    const rows = platforms.withLogins([{ name: 'reddit' }, { name: 'google' }]);
    const reddit = rows.find((r) => r.key === 'reddit');
    expect(reddit.signedIn).toBe(true);
    expect(reddit.servedBy).toBe('reddit');
    expect(rows.find((r) => r.key === 'linkedin').signedIn).toBe(false);
  });

  it('a profile LABELLED with the site counts, whatever it is called', () => {
    const rows = platforms.withLogins([{ name: 'carla-test-facebook', site: 'facebook.com' }]);
    const fb = rows.find((r) => r.key === 'facebook');
    expect(fb.signedIn).toBe(true);
    expect(fb.servedBy).toBe('carla-test-facebook');
  });

  it('Indie Hackers is signed in when GOOGLE is, because that is where its login lives', () => {
    const rows = platforms.withLogins([{ name: 'google' }]);
    expect(rows.find((r) => r.key === 'indiehackers').signedIn).toBe(true);
  });

  it('remembers when a platform was last used and what it last refused', () => {
    platforms.note('reddit', { used: true });
    platforms.note('reddit', { refusedWhy: 'asked us to slow down' });
    const r = platforms.withLogins([]).find((x) => x.key === 'reddit');
    expect(r.lastUsedAt).toMatch(/^\d{4}-/);
    expect(r.lastRefusal).toBe('asked us to slow down');
    expect(r.lastRefusalAt).toMatch(/^\d{4}-/);
  });

  it('health notes never turn into a platform of their own', () => {
    platforms.note('reddit', { used: true });
    expect(platforms.list().some((r) => r.key === '_health')).toBe(false);
  });
});

/*
 * THE OWNER'S CONSOLE SEES THE OWNER'S BROWSER.
 *
 * Live: a Maps walk was 74 steps into a search on the google profile and the console's LIVE NOW said
 * "Nothing running right now" — so "watch it work" opened a page insisting nothing was happening.
 * A caller's identity comes from its key (LeadFlow's is "gb_42c3f"); the console signs in as the
 * PERSON. listFor(owner) therefore hid the owner's own browser from the one human who owns all of it.
 */
describe('what the console is entitled to see', () => {
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/server.js'), 'utf8');
  const jobsSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/jobs.js'), 'utf8');
  const poolSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/pool.js'), 'utf8');

  it('marks a cookie-signed-in request as the console, not as a key', () => {
    expect(server).toMatch(/req\.client = \{ owner: who\.username, console: true,/);
  });

  it('lists every session and every job for the console — and only its own for a key', () => {
    /* The entitlement is unchanged; each session is now enriched with what holds it, so the choice
       sits on its own line rather than inline in the response. */
    expect(server).toMatch(/const list = \(req\.client\.console \? pool\.listAll\(\) : pool\.listFor\(req\.client\.owner\)\)/);
    /* The list is now mapped over to mark the queued ones, so the choice sits one line up. */
    expect(server).toMatch(/const list = req\.client\.console \? jobs\.listAll\(\) : jobs\.listFor\(req\.client\.owner\);/);
    /* The key path must stay scoped: one connected tool still cannot read another's work. */
    expect(jobsSrc).toMatch(/const listFor = \(owner\) => \[\.\.\.jobs\.values\(\)\]\.filter\(\(j\) => j\.owner === owner\)/);
  });

  it('both listings exist and carry which profile the work is on', () => {
    expect(jobsSrc).toMatch(/const listAll = \(\)/);
    expect(jobsSrc).toMatch(/profile: j\.profile \|\| null/);
    expect(poolSrc).toMatch(/listAll\(\) \{/);
    expect(poolSrc).toMatch(/sessionId: id, url, profile: s\.profile \|\| null, owner: s\.owner \|\| null/);
  });

  it('listAll is exported from both', () => {
    const jobs = require('../src/jobs.js');
    expect(typeof jobs.listAll).toBe('function');
    expect(Array.isArray(jobs.listAll())).toBe(true);
  });
});

/*
 * THE SESSION QUEUE — one conversation at a time, and everyone else waits their turn.
 *
 * Live: four approved Herald replies and a planned post all died on
 *   "409: that session already has a conversation — say something in it, or stop it first".
 * The session was held by a job belonging to ANOTHER organ's key, and a key lists only its own jobs
 * — so Herald could not see the holder, could not stop it, and had nothing to do but fail. A dead
 * end built from two reasonable rules. The resource lives here, so the queue does too.
 */
describe('a busy session queues the next job instead of refusing it', () => {
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/server.js'), 'utf8');

  it('no longer answers a second job with a 409', () => {
    expect(server).not.toMatch(/that session already has a conversation — say something in it, or stop it first/);
    expect(server).toMatch(/const free = sessionFree\(session\);/);
  });

  it('never interrupts a walk that is running', () => {
    const fn = server.slice(server.indexOf('function sessionFree('), server.indexOf('/** Start whatever is next in line'));
    expect(fn).toMatch(/if \(!held \|\| jobs\.isOver\(held\)\) return \{ free: true \};/);
    /* Only an IDLE job — finished and merely parked — is taken over. */
    expect(fn).toMatch(/if \(held\.status === 'idle' && !pending\) return \{ free: true, release: held\.id \};/);
    expect(fn).toMatch(/return \{ free: false, heldBy: held\.id/);
  });

  it('never discards an act the owner still owes a decision on', () => {
    const fn = server.slice(server.indexOf('function sessionFree('), server.indexOf('/** Start whatever is next in line'));
    expect(fn).toMatch(/const pending = \(held\.proposals \|\| \[\]\)\.some\(\(p\) => p && p\.state === 'pending'\);/);
    expect(fn).toMatch(/it is waiting for your decision on an act/);
  });

  it('claims the session only when the job actually starts', () => {
    /* Claiming it at creation would take the page from the walk still clicking in it — the exact
       thing the queue exists to prevent. */
    expect(server).toMatch(/The session is claimed WHEN THE JOB ACTUALLY STARTS/);
    /* Three ordered facts rather than one multi-line regex: this file is CRLF, so a needle carrying
       a plain newline matches nothing and the assertion passes for the wrong reason. */
    const block = server.slice(server.indexOf('if (free.free) {'), server.indexOf('const q = queueFor(sessionId);'));
    expect(block).toContain('session.job = job.id;');
    expect(block).toContain('launch();');
    expect(block.indexOf('session.job')).toBeLessThan(block.indexOf('launch()'));
  });

  it('answers 202 with a place in the line, so a caller can say "second, not failed"', () => {
    expect(server).toMatch(/return res\.status\(202\)\.json\(\{/);
    expect(server).toMatch(/queued: true, position: q\.length, heldBy: free\.heldBy, why: free\.why,/);
  });

  it('a queued job reads as queued when it is polled', () => {
    expect(server).toMatch(/const place = queuePosition\(j\.id\);/);
    expect(server).toMatch(/\.\.\.\(place \? \{ queued: true, position: place \} : \{\}\)/);
  });

  it('is pumped on a timer, because a job can end five different ways', () => {
    expect(server).toMatch(/setInterval\(\(\) => \{ pumpQueues\(\)\.catch\(\(\) => \{\}\); \}, 5000\)/);
    expect(server).toMatch(/a queue that hooks four of those five is a queue/);
  });

  it('gives up honestly rather than holding work for ever', () => {
    expect(server).toMatch(/const QUEUE_TTL_MS = 60 \* 60 \* 1000;/);
    expect(server).toMatch(/waited over an hour for the browser and gave up/);
    expect(server).toMatch(/the browser session it was waiting for was closed/);
    expect(server).toMatch(/const QUEUE_MAX = 20;/);
  });
});

/*
 * THE IMAGE IS BUILT FROM `git archive` ON A WINDOWS CHECKOUT.
 *
 * git archive applies the worktree end-of-line conversion, so entrypoint.sh left the repo with CRLF
 * even though the stored blob is LF. A shebang ending in a carriage return is not a path to any
 * interpreter, and v195 crashlooped on both pods with
 *
 *     exec /usr/local/bin/entrypoint.sh: no such file or directory
 *
 * The browser was down until v196. .gitattributes pins the files the Linux image RUNS.
 */
describe('what the image runs keeps unix line endings', () => {
  const attrs = require('node:fs').readFileSync(require('node:path').join(__dirname, '../.gitattributes'), 'utf8');

  it('pins every shell script, however it is checked out or exported', () => {
    expect(attrs).toMatch(/^\*\.sh text eol=lf$/m);
  });

  it('pins the entrypoint by name — it is the one that took the pod down', () => {
    expect(attrs).toMatch(/^entrypoint\.sh text eol=lf$/m);
  });

  it('the entrypoint the image copies in has no carriage returns', () => {
    const sh = require('node:fs').readFileSync(require('node:path').join(__dirname, '../entrypoint.sh'), 'utf8');
    expect(sh.startsWith('#!/bin/sh\n')).toBe(true);
    expect(sh.includes(String.fromCharCode(13))).toBe(false);
  });
});

/*
 * A DRAINED POD THAT CANNOT RECYCLE IS A DEAD SERVICE.
 *
 * Carla cleared Herald for a clean start and its first read came back "this worker is draining -
 * retry, another will take it". There is no other worker. The pod had latched draining at 80% memory
 * hours before and then sat at 67%, which is Chromium's floor with a couple of sessions open and
 * above the un-latch threshold of 65% (the ceiling less the 15-point hysteresis). Two IDLE sessions
 * kept the count above zero, so the "drained, exit, be replaced" path never fired either. Not
 * accepting work and not recycling, for hours.
 */
describe('a draining pod gets itself replaced', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/pool.js'), 'utf8');

  it('closes its idle sessions instead of waiting five minutes for each to age out', () => {
    expect(src).toMatch(/if \(this\.draining\) \{\s*\n\s*for \(const \[id, s\] of \[\.\.\.this\.sessions\]\) \{/);
    expect(src).toMatch(/now - s\.lastUsed > DRAIN_IDLE_MS/);
  });

  it('but leaves a grace, because a walk between two slow steps has not stopped using its session', () => {
    expect(src).toMatch(/const DRAIN_IDLE_MS = 2 \* 60 \* 1000;/);
  });

  it('and the ordinary idle limit is unchanged for a pod that is NOT draining', () => {
    expect(src).toMatch(/idleMs:\s+NUM\(process\.env\.IDLE_MS, 5 \* 60 \* 1000\)/);
  });

  it('the closing still happens before the exit check, so zero is reached on the same sweep', () => {
    const drainClose = src.indexOf('now - s.lastUsed > DRAIN_IDLE_MS');
    const exit = src.indexOf('drained; exiting so the pod is replaced');
    expect(drainClose).toBeGreaterThan(0);
    expect(exit).toBeGreaterThan(drainClose);
  });

  it('and the un-latch on genuinely recovered memory is still there', () => {
    expect(src).toMatch(/accepting again at \$\{cap\.memoryPct\}%/);
  });
});

/*
 * WHICH DOORS ARE SHUT TO A STRANGER. Herald spent a browser session discovering that a Discord
 * server needs an account, and would have spent one every morning after. Whether READING a platform
 * needs a signed-in profile is a fact about the platform, so it lives on the record with the rest.
 */
describe('the registry says which platforms need a sign-in to read', () => {
  const by = Object.fromEntries(platforms.SEED.map((r) => [r.key, r]));

  it('the walled ones: an account or you see a login wall', () => {
    for (const k of ['discord', 'facebook', 'linkedin', 'x']) expect({ [k]: by[k].readNeedsLogin }).toEqual({ [k]: true });
  });

  it('the open ones: a subreddit, a Show HN, a search result', () => {
    for (const k of ['reddit', 'hn', 'google', 'web', 'indiehackers', 'producthunt']) expect({ [k]: by[k].readNeedsLogin }).toEqual({ [k]: false });
  });

  it('every record answers it, so a caller never has to guess from undefined', () => {
    for (const r of platforms.SEED) expect({ key: r.key, t: typeof r.readNeedsLogin }).toEqual({ key: r.key, t: 'boolean' });
  });

  it('and the owner can override it, like the rest of a record', () => {
    expect(platforms.OVERRIDABLE.has('readNeedsLogin')).toBe(true);
  });

  /* signedIn is the other half of the answer, and withLogins already provides it. */
  it('it rides out beside signedIn, which is what makes the pair usable', () => {
    const rows = platforms.withLogins([{ name: 'reddit' }]);
    const reddit = rows.find((r) => r.key === 'reddit');
    const discord = rows.find((r) => r.key === 'discord');
    expect(reddit.signedIn).toBe(true);
    expect(discord.signedIn).toBe(false);
    expect(discord.readNeedsLogin).toBe(true);
  });
});

/*
 * "OPEN AT MOST 15 PAGES" WAS A REQUEST, NOT A LIMIT.
 *
 * Herald's daily read of one Facebook group ran two hours and twenty-nine minutes, 123 tool calls,
 * 29 distinct pages, on a brief of fifteen. The trail shows the drift: the six search phrases it was
 * given, then twenty more it invented (Stripe GitHub, blocked deceptive, URGENT locked, code audit),
 * and member profile pages that were never in the brief. Each page was defensible; the read was not.
 *
 * Nothing counted pages. The only hard number was a GLOBAL maxSteps of 120 shared by a five-minute
 * room skim and a two-hour research walk, and one page costs several steps.
 */
describe('a walk cannot spend more pages than it was given', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/agent.js'), 'utf8');
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/server.js'), 'utf8');
  const jobsSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/jobs.js'), 'utf8');

  it('counts pages from the address bar, so every way of moving counts and a re-read does not', () => {
    expect(src).toMatch(/const u = page\(\)\.url\(\); if \(u && u !== lastPageUrl\) \{ lastPageUrl = u; pagesSpent\+\+; \}/);
  });

  /* Asking it to stop is what the old step budget did, and this walk sailed past that too. */
  it('REFUSES the tools that go somewhere new, rather than asking nicely', () => {
    expect(src).toMatch(/const GOES_SOMEWHERE_NEW = new Set\(\['open', 'dig', 'google'\]\);/);
    expect(src).toMatch(/if \(maxPages && pagesSpent >= maxPages && GOES_SOMEWHERE_NEW\.has\(call\.name\)\) \{/);
    expect(src).toMatch(/refused — the \$\{maxPages\}-page budget for this job is spent/);
  });

  it('but leaves everything needed to WRITE THE REPORT open', () => {
    for (const t of ['look', 'read', 'scroll', 'sweep', 'finish']) expect({ t, blocked: /GOES_SOMEWHERE_NEW = new Set\(\[[^\]]*'' \+ t/.test(src) }).toEqual({ t, blocked: false });
    expect(src).not.toMatch(/GOES_SOMEWHERE_NEW = new Set\(\[[^\]]*finish/);
  });

  it('and asks for the report the moment the budget is spent', () => {
    expect(src).toMatch(/if \(maxPages && pagesSpent >= maxPages && !wrappingUp\) \{/);
    expect(src).toMatch(/-page budget spent \(\$\{pagesSpent\} pages\)/);
  });

  it('the budgets are per JOB, with the global as the default', () => {
    expect(src).toMatch(/const maxSteps = Number\(job\.maxSteps\) > 0 \? Number\(job\.maxSteps\) : settings\.maxSteps;/);
    expect(src).toMatch(/const maxPages = Number\(job\.maxPages\) > 0 \? Number\(job\.maxPages\) : 0;/);
    expect(jobsSrc).toMatch(/maxSteps: Number\(maxSteps\) > 0 \? Number\(maxSteps\) : 0,/);
  });

  /* 0 pages means uncounted: every walk that existed before budgets behaves exactly as it did. */
  it('a job with no budget is the old behaviour, not a job with none left', () => {
    expect(src).toMatch(/0 = uncounted, the old behaviour/);
  });

  it('a caller cannot buy an unbounded walk by typing a big number', () => {
    expect(server).toMatch(/maxSteps: Math\.min\(300, Math\.max\(0, Math\.round\(Number\(maxSteps\) \|\| 0\)\)\)/);
    expect(server).toMatch(/maxPages: Math\.min\(200, Math\.max\(0, Math\.round\(Number\(maxPages\) \|\| 0\)\)\)/);
  });

  it('and the messages quote the budget the walk is actually held to', () => {
    expect(src).not.toMatch(/budget of \$\{settings\.maxSteps\} steps/);
    expect(src).toMatch(/You have used your whole budget of \$\{maxSteps\} steps/);
  });
});

/* A walk was charged a page for standing still: lastPageUrl started empty, so the count moved on the
   very first turn before anything was opened, and a 15-page brief was really 14. */
describe('the page budget starts where the walk starts', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/agent.js'), 'utf8');

  it('seeds the counter with the page the session is already on', () => {
    expect(src).toMatch(/let lastPageUrl = \(\(\) => \{ try \{ return page\(\)\.url\(\) \|\| ''; \} catch \{ return ''; \} \}\)\(\);/);
  });

  it('and a session with no page yet does not throw on the way in', () => {
    expect(src).toMatch(/catch \{ return ''; \}/);
  });
});

/*
 * CAPACITY WAS OVERSOLD THREE WAYS, AND THE ORGANS WERE CAPPED LIKE CUSTOMERS.
 *
 * Every reply Herald sent in one afternoon failed, and the owner's own console went black opening
 * Indie Hackers. One pod, three numbers that disagreed about how many browsers it could hold: the pool
 * ADVERTISED 8 (a typed default); the one 'gb_' key the provisioner mints per cluster is ':team', so
 * Herald, LeadFlow and the master TOGETHER got 3; and a named profile is a whole Chromium at ~1.1 GiB,
 * so three of them put the 4 GiB pod at its 80% guard and it started draining — refusing everyone.
 * Three reads on three profiles filled it; the reply on a fourth profile got "your plan allows 3" and
 * a 503, and improvised. The owner got the 503 too, queued behind her own organs.
 */
describe('the session ceiling is what memory affords, not a typed number', () => {
  const pool = require('../src/pool');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/pool.js'), 'utf8');

  it('derives maxContexts from the memory limit at ~1.15 GiB per browser', () => {
    expect(src).toMatch(/maxContexts:\s+NUM\(process\.env\.MAX_CONTEXTS, contextsMemoryAffords\(\)\)/);
    expect(src).toMatch(/const PER_BROWSER = 1\.15 \* 1024 \* 1024 \* 1024;/);
    expect(pool.LIMITS.maxContexts).toBeGreaterThanOrEqual(1);
  });

  /* A 4 GiB pod says 3, a 6 GiB pod says 5 — refused cleanly at the ceiling, never drained at 80%. */
  it('never says zero, and MAX_CONTEXTS still overrides for an install that knows better', () => {
    expect(src).toMatch(/Math\.max\(1, Math\.floor\(memoryLimitBytes\(\) \/ PER_BROWSER\)\)/);
    expect(src).toMatch(/process\.env\.MAX_CONTEXTS/);
  });
});

describe('the owner keeps one slot', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/pool.js'), 'utf8');
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/server.js'), 'utf8');

  it('a reserved session may go one past the ceiling', () => {
    expect(src).toMatch(/reserved = false \} = \{\}\) \{/);
    expect(src).toMatch(/this\.sessions\.size >= this\.limits\.maxContexts \+ \(reserved \? 1 : 0\)/);
  });

  it('and only the console asks for it', () => {
    expect(server).toMatch(/reserved: !!req\.client\.console,/);
  });

  /* A slot is not a licence to be OOM-killed: the memory guard sits ABOVE the reserved check. */
  it('memory still applies to a reserved session', () => {
    const mem = src.indexOf('this worker is at its memory ceiling');
    const slot = src.indexOf('this.limits.maxContexts + (reserved ? 1 : 0)');
    expect(mem).toBeGreaterThan(0);
    expect(mem).toBeLessThan(slot);
  });
});

describe('a platform-minted organ key is not a customer', () => {
  const { parseKeys, PLANS } = require('../src/keys');

  it('a gb_ key is held to the pod, whatever plan it was minted on', () => {
    const m = parseKeys('gb_0123456789abcdef:team');
    expect([...m.values()][0].maxConcurrent).toBe(64);
  });

  it('in the JSON form too', () => {
    const m = parseKeys(JSON.stringify({ gb_0123456789abcdef: { plan: 'team', owner: 'herald' } }));
    expect([...m.values()][0].maxConcurrent).toBe(64);
  });

  /* The plans are still the lever for everyone else — this is about the platform's own organs. */
  it('a customer key keeps its plan', () => {
    const m = parseKeys('cust_0123456789abcdef:team');
    expect([...m.values()][0].maxConcurrent).toBe(PLANS.team.maxConcurrent);
  });
});

describe('the registry names profiles that exist on the disk', () => {
  const by = Object.fromEntries(platforms.SEED.map((r) => [r.key, r]));

  /* It had an empty list and was matched to google only by a site label; both profiles hold its cookies. */
  it('indiehackers names its own profile, and the pin to google still wins', () => {
    expect(by.indiehackers.profiles).toEqual(['indiehackers']);
    expect(by.indiehackers.loginProfile).toBe('google');
  });
});

/*
 * ── "NOT YOUR SESSION", IN YOUR OWN BROWSER ──────────────────────────────────────────────────────
 *
 * The owner watched a Google login sit parked on a sign-in page for twenty minutes. They needed to
 * sign in — the whole search loop was blocked on it — and could not, because the session had been
 * opened by an organ's key rather than by them. The console listed it and refused to close it.
 *
 * Two things were wrong. A key may only close what it opened, which is right and stays; but the
 * CONSOLE is the signed-in owner of this install, and refusing them was a rule with nobody behind
 * it. And the screen could not say what held the session anyway: every organ shares ONE minted key,
 * so the owner field is the same eight characters for the master, Herald and LeadFlow alike.
 *
 * A session's real identity is the JOB in it — reach.search is Search Console, learn.shot is a
 * picture for an answer page — and the job's status says whether it is working or has finished and
 * is merely holding the door shut.
 */
describe('the owner can see and close what is holding their browser', () => {
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/server.js'), 'utf8');
  const dash = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/dashboard.js'), 'utf8');

  it('each session says which job holds it, and whether that job is still running', () => {
    expect(server).toMatch(/function heldBy\(sessionId\)/);
    expect(server).toMatch(/return \{ jobId: live\.id, role: live\.role \|\| 'general', status: live\.status/);
    expect(server).toMatch(/job: heldBy\(s\.sessionId\), yours: s\.owner === req\.client\.owner/);
  });

  /* The live one if there is one, otherwise the most recent — a finished job still holding a
     session is exactly the thing worth seeing, so it is never hidden. */
  it('and a finished job holding a session is reported, not hidden', () => {
    expect(server).toMatch(/j\.find\(\(x\) => x\.status === 'running'\) \|\| j\.sort/);
  });

  it('the console may close any session in its own browser; a key still may not', () => {
    expect(server).toMatch(/if \(s\.owner !== req\.client\.owner && !req\.client\.console\) return res\.status\(403\)/);
    /* Said out loud in the close reason, so it is not a silent override. */
    expect(server).toMatch(/the owner of this browser/);
  });

  it('and the card names what holds a login instead of saying only that one is open', () => {
    expect(dash).toMatch(/finished and is still holding this login/);
    expect(dash).toMatch(/opened by /);
  });
});

/*
 * ── THREE CARDS SAID LIVE, ONE BROWSER SESSION EXISTED, AND STOP DID NOTHING ─────────────────────
 *
 * "Live" counted every job that was running OR idle. Idle is what a walk becomes when it has
 * FINISHED — the conversation stays open so it can be resumed — and such a job usually holds no
 * session at all. So the dashboard showed three live platforms while the pool held one session, and
 * pressing Stop on the other two did nothing AND said nothing: no session to close (the id was
 * empty, so the call was skipped) and no running job to end (parked ones were filtered out of
 * stopJobs). No error, no change, still "live". It read as a broken button.
 *
 * Three separate faults, and all three had to go: idle counted as live, Stop could not act on a
 * parked job, and a stop that did nothing said nothing.
 */
describe('live means a browser is busy, and stop always reports what it did', () => {
  const dash = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/dashboard.js'), 'utf8');

  it('only a running job makes a profile live; a parked one never does', () => {
    expect(dash).toMatch(/const runningJobs = allJobs\.filter\(j => j\.status === 'running'\)/);
    expect(dash).toMatch(/const parkedJobs = allJobs\.filter\(j => j\.status === 'idle'\)/);
    expect(dash).toMatch(/for \(const j of runningJobs\) \{ if \(j\.profile\) \{ active\.add\(j\.profile\)/);
    /* The old rule, which is what produced three live cards over one session. */
    expect(dash).not.toMatch(/filter\(j => j\.status === 'running' \|\| j\.status === 'idle'\)/);
  });

  it('a parked conversation is shown as parked, not as the browser being busy', () => {
    expect(dash).toMatch(/finished conversations are/);
    expect(dash).toMatch(/nothing is running/);
  });

  /* Stop is offered over parked jobs, so it must be able to end them. */
  it('stop ends parked jobs as well as running ones', () => {
    expect(dash).toMatch(/const stopJobs = liveJobs\.filter\(j => j\.status === 'running'\)\.concat\(parkedHere\)/);
  });

  it('and a stop with nothing to act on says so instead of going quiet', () => {
    expect(dash).toMatch(/there is no open session and no job to end/);
    expect(dash).toMatch(/if \(!ended && !closed\) alert\(/);
  });
});

/*
 * ── A LIST THE VIEW DOES NOT NAME IS INVISIBLE, NOT EMPTY ────────────────────────────────────────
 *
 * A Search Console audit called save_gsc_health six times. The store pushed all six onto the job and
 * persisted it — and `persistable()`, which is both what gets written to disk and what every reader
 * is handed, did not name gscHealth. The findings lived exactly as long as the process did. The
 * master asked for them, got nothing, and recorded "the audit read nothing it could file": honest,
 * and completely wrong. It had read plenty.
 *
 * What makes this worth a permanent guard rather than a fix is that it is silent BY CONSTRUCTION. A
 * missing key reads as an empty list, and an empty list is an ordinary outcome for a young property —
 * so nothing anywhere could tell "found nothing" from "lost everything". The next list added to a job
 * will be added the same way, by someone who has no reason to know this file has two places to edit.
 */
describe('every list a tool can fill survives the trip to disk', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/jobs.js'), 'utf8');

  it('the view names every array the store appends to', () => {
    /* `j.x = j.x || []` is how each of these begins — the store's own way of saying "a list". */
    const lists = [...new Set([...src.matchAll(/j\.(\w+) = j\.\1 \|\| \[\];/g)].map((m) => m[1]))];
    expect(lists.length).toBeGreaterThan(4);
    /*
     * To the END of the object, not a fixed number of characters.
     *
     * This used to slice 1,800 characters and call it persistable. Adding a comment inside the
     * object then pushed the last fields out of that window, and the guard reported lists as
     * lost that were sitting right there — which teaches you to distrust the guard, on the one
     * test written because a silently dropped field cost six audit findings.
     */
    const NL = String.fromCharCode(10);
    const body = src.slice(src.indexOf('const persistable'));
    const stop = body.indexOf(NL + '});');
    const view = stop > 0 ? body.slice(0, stop) : body;
    const missing = lists.filter((k) => !view.includes(`${k}:`));
    expect(missing, `these lists are written to the job but never returned: ${missing.join(', ')}`).toEqual([]);
  });

  /* The one that was lost, named, so the fix cannot be quietly reverted. */
  it('and the audit findings in particular', () => {
    expect(src).toMatch(/gscHealth: j\.gscHealth \|\| \[\]/);
  });
});
