/*
 * THE DEVICE RING'S ROUTING SOURCE IS SENSED, NOT TYPED.
 *
 * The rule the whole ring rests on is Principle 6: the cluster NEVER runs a gated platform — not as
 * a fallback, not "to try". A rule that strong depended on a `needsDevice: true` flag somebody had
 * typed onto LinkedIn's preset, so it held for exactly the one site anybody had thought of. The
 * first unlisted gated site loops from the cluster forever, reports nothing usable, and no flag
 * anywhere says why.
 *
 * Phase 3 makes the flag DATA, learned from what pages actually did. Phase 4 then dispatches the
 * pass to the device instead of skipping it, which is what the scheduler's TODO used to do.
 *
 * PROFILE_DIR is redirected before the store is required, because the store reads it once at load.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);

const DIR = mkdtempSync(join(tmpdir(), 'gb-walls-'));
process.env.PROFILE_DIR = DIR;

const walls = require('../src/siteWalls');
const diag = require('../src/diagnostics');
const sites = require('../src/sites');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const hub = readFileSync(new URL('../src/device-hub.js', import.meta.url), 'utf8');

const wipe = () => {
  try { if (existsSync(walls.FILE)) rmSync(walls.FILE); } catch { /* ignore */ }
  walls.reload();
};

describe('a wall is learned as data, with its evidence', () => {
  beforeEach(wipe);

  it('records the host, why, and what was actually seen', () => {
    const r = walls.record('https://www.linkedin.com/feed/', {
      why: 'redirect-looped from the cluster', evidence: 'loaded 7x in 20 navigations', url: 'https://www.linkedin.com/feed/',
    });
    expect(r.host).toBe('linkedin.com');
    expect(r.walled).toBe(true);
    expect(r.evidence).toMatch(/7x/);
    expect(r.hits).toBe(1);
    expect(walls.walled('linkedin.com')).toBe(true);
  });

  /* One wall must cover the whole site, or it is learned once per subdomain and routes only some. */
  it('and it covers the site, not one URL', () => {
    walls.record('linkedin.com', { why: 'x' });
    expect(walls.walled('https://www.linkedin.com/in/someone')).toBe(true);
    expect(walls.walled('m.linkedin.com')).toBe(true);
    expect(walls.walled('facebook.com')).toBe(false);
  });

  it('counts repeat sightings rather than overwriting them', () => {
    walls.record('linkedin.com', { why: 'a' });
    const r = walls.record('linkedin.com', { why: 'b' });
    expect(r.hits).toBe(2);
  });
});

describe('a wall can be un-learned, but not by one lucky load', () => {
  beforeEach(wipe);

  /*
   * Clearing is the cheap direction to be slow about: a site wrongly left on the phone still WORKS,
   * it is only running somewhere better than it needed to. A site wrongly cleared goes back to the
   * cluster and loops.
   */
  it('needs several clean loads, not one', () => {
    walls.record('linkedin.com', { why: 'x' });
    for (let i = 1; i < walls.CLEAN_TO_CLEAR; i += 1) {
      walls.clean('https://www.linkedin.com/feed/', { url: 'u' });
      expect(walls.walled('linkedin.com'), `still walled after ${i} clean load(s)`).toBe(true);
    }
    walls.clean('https://www.linkedin.com/feed/', { url: 'u' });
    expect(walls.walled('linkedin.com')).toBe(false);
  });

  it('and a fresh wall resets the progress toward clearing', () => {
    walls.record('linkedin.com', { why: 'x' });
    walls.clean('linkedin.com', {});
    walls.record('linkedin.com', { why: 'walled again' });   // back to square one
    walls.clean('linkedin.com', {});
    expect(walls.walled('linkedin.com')).toBe(true);
  });

  /* The overwhelmingly common case. It must not write a file for every clean page load. */
  it('a clean load of a host nobody flagged writes nothing', () => {
    expect(walls.clean('https://example.com/', {})).toBe(null);
    expect(existsSync(walls.FILE)).toBe(false);
  });

  it('the owner can forget a flag the sensor got wrong', () => {
    walls.record('example.com', { why: 'x' });
    expect(walls.forget('example.com')).toBe(true);
    expect(walls.walled('example.com')).toBe(false);
  });
});

/*
 * THE SENSOR READS HEADERS, NOT BODIES. Finding out whether a page was a challenge must not cost
 * more than the page did, and every response passes through this.
 */
describe('a Cloudflare challenge is told apart from an ordinary refusal', () => {
  it('believes Cloudflare when it says so itself', () => {
    expect(diag.challengeOf(403, { 'cf-mitigated': 'challenge' })).toMatch(/cf-mitigated/);
  });

  it('reads the older shape: a 403 or 503 served by cloudflare', () => {
    expect(diag.challengeOf(403, { server: 'cloudflare' })).toMatch(/403/);
    expect(diag.challengeOf(503, { Server: 'Cloudflare' })).toMatch(/503/);
  });

  /* The false positive that would route half the web to a phone. */
  it('but a plain 403 from something else is just a refusal', () => {
    expect(diag.challengeOf(403, { server: 'nginx' })).toBe(null);
    expect(diag.challengeOf(401, { server: 'cloudflare' })).toBe(null);
    expect(diag.challengeOf(200, { server: 'cloudflare' })).toBe(null);
    expect(diag.challengeOf(404, {})).toBe(null);
  });
});

describe('the router reads the preset AND what was learned', () => {
  beforeEach(wipe);

  /* The preset is the seed and the override: declared gated stays gated. */
  it('a declared site is gated whatever the sensor thinks', () => {
    expect(sites.needsDevice('linkedin')).toBe(true);
    expect(sites.needsDevice('p_linkedin')).toBe(true);
  });

  it('an undeclared site is not gated until it has been shown to be', () => {
    expect(sites.needsDevice('facebook')).toBe(false);
    walls.record('facebook.com', { why: 'challenge' });
    expect(sites.needsDevice('facebook'), 'learned walls route too').toBe(true);
  });

  it('and a site nobody has ever met is not gated', () => {
    expect(sites.needsDevice('nothing-we-know-of')).toBe(false);
  });
});

/*
 * PHASE 4 — the pass is handed to the device. These are source guards because the alternative is a
 * fake phone, and what matters here is the ORDER and the refusal, which read plainly in the source.
 */
describe('the scheduler dispatches a gated pass to the ring', () => {
  it('the TODO that skipped the pass entirely is gone', () => {
    expect(server).not.toMatch(/TODO on-device dispatch/);
    expect(server).toMatch(/async function runPassOnDevice/);
  });

  /* Principle 6, in the one place it can be broken. */
  it('no device means wait, never the cluster', () => {
    expect(server).toMatch(/NO DEVICE MEANS WAIT, NOT FALL BACK/);
    const at = server.indexOf('if (!dev) {');
    expect(at).toBeGreaterThan(0);
    const body = server.slice(at, at + 700);
    expect(body).toMatch(/waiting-device/);
    expect(body).toMatch(/continue;/);
  });

  /*
   * The lesson the gigs watcher already paid for: scheduleDue() reads the LAST RUN to decide whether
   * a watcher is due, so a mode that never persists one looks like it never ran and fires every tick.
   */
  it('and the run is persisted before the pass, or it fires every tick', () => {
    const at = server.indexOf('PHASE 4 — the pass is DISPATCHED');
    expect(at).toBeGreaterThan(0);
    const body = server.slice(at, at + 900);
    expect(body.indexOf('persistRun')).toBeLessThan(body.indexOf('runPassOnDevice('));
  });

  it('the pass opens the profile where the login lives, and reads with the device', () => {
    expect(server).toMatch(/const profile = 'p_' \+ wProfile;/);
    expect(server).toMatch(/deviceHub\.runCommand\(dev\.deviceId, \{ method: 'POST', path: '\/v1\/navigate'/);
    expect(server).toMatch(/path: '\/v1\/content'/);
  });

  /* Its targets come from the watcher's own config — never a second list that can disagree. */
  it('and it opens what the watcher was pointed at', () => {
    expect(server).toMatch(/never a second list that can disagree with it/);
    expect(server).toMatch(/Array\.isArray\(cfg\.postUrls\)/);
  });
});

describe('enqueue-and-await is a function, not a route body', () => {
  /*
   * It used to exist only inside the HTTP handler, so the scheduler could not run a command on a
   * device without making an HTTP request to itself — through its own middleware, with an auth
   * header it would have to mint, to reach code in the same process.
   */
  it('device-hub exposes runCommand, and the route uses the same path', () => {
    expect(hub).toMatch(/const runCommand = \(deviceId, spec = \{\}, timeoutMs = 180000\)/);
    expect(hub).toMatch(/runCommand,/);
    const at = hub.indexOf('app.post("/v1/device/:deviceId/command"');
    const body = hub.slice(at, at + 900);
    expect(body).toMatch(/runCommand\(req\.params\.deviceId, spec\)/);
  });

  it('and it rejects on timeout rather than hanging forever', () => {
    expect(hub).toMatch(/reject\(new Error\("device did not respond in time"\)\)/);
  });
});

/*
 * ── A MISSING LOGIN IS THE OTHER REASON TO NEED A DEVICE, AND IT IS PER SURFACE ───────────────────
 *
 * Search Console ran on the cluster for weeks reporting "you do not have access to this property".
 * It was not walled and it was not broken: the Google profile serving it is signed out ON PURPOSE,
 * because the same profile does web search and its own preset says searching signed out is
 * preferable. Signed out, search works and Search Console says nothing at all — and that nothing was
 * filed as findings and later read as a Google penalty.
 *
 * So the question is never "is this profile signed out". Answered that way, web search would be
 * pushed onto a phone it does not need. The question is what THIS SURFACE requires.
 */
describe('a surface can need a login even when its profile is deliberately signed out', () => {
  beforeEach(wipe);

  it('Search Console borrows the Google login but demands one', () => {
    const sc = sites.get('searchconsole');
    expect(sc).toBeTruthy();
    expect(sc.needsLogin).toBe(true);
    expect(sc.profile).toBe('google');           // the same account, not a second login
    expect(sites.borrowsProfile('searchconsole')).toBe(true);
    expect(sites.needsLogin('searchconsole')).toBe(true);
  });

  it('while search on the same profile needs none', () => {
    expect(sites.needsLogin('google')).toBe(false);
  });

  it('a url is matched to the surface it belongs to, longest host first', () => {
    expect(sites.surfaceFor('https://search.google.com/search-console/welcome').key).toBe('searchconsole');
    expect(sites.surfaceFor('https://www.google.com/search?q=x').key).toBe('google');
  });

  /* The whole point of deciding this per surface. */
  it('learning that Search Console is signed out does NOT move web search to the phone', () => {
    expect(sites.needsDevice('searchconsole')).toBe(false);
    walls.record('search.google.com', { reason: 'signed-out', why: 'signed out' });
    expect(sites.needsDevice('searchconsole'), 'the surface that needs the login routes').toBe(true);
    expect(sites.needsDevice('google'), 'search must stay on the cluster').toBe(false);
  });

  /* Different facts, different remedies: a wall means the phone, signed-out can also just be fixed. */
  it('and the reason is kept, because the remedies differ', () => {
    walls.record('search.google.com', { reason: 'signed-out', why: 'x' });
    expect(walls.reasonFor('search.google.com')).toBe('signed-out');
    walls.record('linkedin.com', { reason: 'wall', why: 'y' });
    expect(walls.reasonFor('linkedin.com')).toBe('wall');
  });
});

describe('the job path asks the ring, not just the watcher path', () => {
  /*
   * needsDevice was consulted in ONE line of the codebase — the scheduler watcher branch — so a job
   * the master dispatched asked nothing and ran on the cluster regardless.
   */
  it('a job is refused before a model or a session is spent', () => {
    expect(server).toMatch(/THE CLUSTER NEVER RUNS A GATED SURFACE/);
    /*
     * MEASURED INSIDE THE ROUTE, not across the file. `if (!cfg.llmModel)` occurs nine times in
     * server.js and the first is about 1700 lines above this route, so an unscoped indexOf compared
     * the gate against a completely different handler and failed for the wrong reason. This suite
     * already caught the same defect once in the master: a guard that can match the wrong region is
     * not a guard.
     */
    const route = server.indexOf("app.post('/v1/agent/jobs'");
    expect(route, 'the job route is still found by this anchor').toBeGreaterThan(0);
    const body = server.slice(route, route + 6000);
    const gate = body.indexOf('const gate = await ringGate(');
    const model = body.indexOf('if (!cfg.llmModel)');
    expect(gate, 'the gate is inside the job route').toBeGreaterThan(-1);
    expect(model, 'the model check is inside the job route').toBeGreaterThan(-1);
    /* Ordering is the point: refused BEFORE the model check, which is where the cost starts. */
    expect(gate).toBeLessThan(model);
  });

  it('and it answers 409 with the surface, the reason and the device that holds the login', () => {
    const at = server.indexOf('if (gate.blocked) {');
    const body = server.slice(at, at + 420);
    expect(body).toMatch(/needsDevice: true/);
    expect(body).toMatch(/surface: gate\.surface/);
    expect(body).toMatch(/reason: gate\.reason/);
    expect(body).toMatch(/device: gate\.device/);
  });

  /*
   * The role cannot answer this: one profile serves surfaces with opposite requirements. The goal is
   * where the work names the addresses it is going to.
   */
  it('the surface comes from the addresses in the goal, not from the role', () => {
    expect(server).toMatch(/function urlsInGoal\(goal\)/);
    expect(server).toMatch(/Reads the goal/);
  });

  /* One detector for "are we signed in", not two that can disagree. */
  it('the login check reuses the detector the console already uses', () => {
    expect(server).toMatch(/app\.post\('\/v1\/site-walls\/check'/);
    const at = server.indexOf("app.post('/v1/site-walls/check'");
    /* Sized to the route rather than to a guess: it grew when it learned to enter the surface. */
    const end = server.indexOf('app.get(', at);
    const body = server.slice(at, end > at ? end : at + 4000);
    expect(body).toMatch(/agent\.loginWall/);
    expect(body).toMatch(/reason: 'signed-out'/);
    expect(body).toMatch(/walls\.clean\(site\.site/);
  });

  /*
   * THE LANDING PAGE IS NEVER THE ANSWER.
   *
   * Search Console opens on a marketing page with a Get-started button signed in OR out, so the
   * first version of this check called that page signed-out and would have stranded the surface on
   * a phone permanently. Pressing through is what resolves it, and only then does the detector get
   * asked — which is why loginWall, which already knows accounts.google.com, now sees it.
   */
  it('and it enters the surface before it judges, rather than trusting the landing page', () => {
    const at = server.indexOf("app.post('/v1/site-walls/check'");
    const end = server.indexOf('app.get(', at);
    const body = server.slice(at, end > at ? end : at + 4000);
    expect(body).toMatch(/A LANDING PAGE IS NOT AN ANSWER/);
    expect(body).toMatch(/site\.enterBy/);
    /* The press comes first, then the verdict is taken again from the detector. */
    const press = body.indexOf('site.enterBy');
    const verdict = body.lastIndexOf('agent.loginWall');
    expect(press).toBeLessThan(verdict);
    /* And the address it happens to land on is reported, never used as the verdict. */
    expect(body).not.toMatch(/signedOutAt/);
  });

  it('the surface says how to get in, in the languages it renders in', () => {
    const sc = sites.get('searchconsole');
    expect(Array.isArray(sc.enterBy)).toBe(true);
    expect(sc.enterBy).toContain('Rozpocznij');
    expect(sc.enterBy).toContain('Get started');
    expect(sc.signedOutAt, 'the false premise is gone').toBeUndefined();
  });
});

/*
 * ── A REDIRECT LOOP HAPPENS IN SECONDS; REVISITING A PAGE TAKES MINUTES ──────────────────────────
 *
 * Caught on the live cluster, by my own probing. Checking Search Console navigated between
 * /search-console/about and the account chooser a few times over several minutes in one reused
 * session, and the loop sensor recorded search.google.com as Cloudflare-WALLED, evidence "loaded 6x
 * within the last 8 navigations (2 distinct)". Search Console was then routed to the phone for a
 * reason that did not exist — the same class of phantom as the Google penalty earlier the same day.
 *
 * `distinct <= 3` was meant to be the guard and cannot work: a redirect bouncing between two
 * addresses and a session visiting two pages repeatedly are both two distinct URLs repeating. Shape
 * cannot separate them. Time can.
 */
describe('a loop is told from browsing by time, not by shape', () => {
  const at = (h, m, s) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const tight = [];
  for (let i = 0; i < 6; i += 1) tight.push({ url: 'https://x.test/a', at: at(10, 0, i) });
  const slow = [0, 30, 60, 120, 180, 210, 240].map((sec, i) => ({
    url: i % 2 ? 'https://x.test/b' : 'https://x.test/a',
    at: at(10, Math.floor(sec / 60), sec % 60),
  }));

  it('shape alone calls both of them a loop, which is the whole problem', () => {
    expect(!!diag.loopOf(tight)).toBe(true);
    expect(!!diag.loopOf(slow)).toBe(true);
  });

  it('six loads inside three seconds is a loop', () => {
    expect(diag.tightRepeat(tight, 'https://x.test/a', 20)).toBe(true);
  });

  it('the same page four times across four minutes is not', () => {
    expect(diag.tightRepeat(slow, 'https://x.test/a', 20)).toBe(false);
  });

  it('and fewer than four repeats is never a loop, however tight', () => {
    const few = [{ url: 'https://x.test/a', at: at(10, 0, 0) }, { url: 'https://x.test/a', at: at(10, 0, 1) }];
    expect(diag.tightRepeat(few, 'https://x.test/a', 20)).toBe(false);
  });

  /* The sensor must consult it, or the export is decoration. */
  it('the sensor refuses to record a wall unless the repeat is tight', () => {
    const src = readFileSync(new URL('../src/diagnostics.js', import.meta.url), 'utf8');
    const at2 = src.indexOf('function senseLoop');
    const body = src.slice(at2, at2 + 900);
    expect(body).toMatch(/tightRepeat\(navigations, lp\.url, 20\)/);
    expect(body.indexOf('tightRepeat')).toBeLessThan(body.indexOf('walls().record'));
  });
});
