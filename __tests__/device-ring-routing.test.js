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
