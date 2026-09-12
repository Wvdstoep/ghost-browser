/**
 * The console has to work mounted under a path, and nothing else in it may assume otherwise.
 *
 * WHY THIS IS A TEST AND NOT A CODE REVIEW. This has now broken three times, each time differently
 * and each time silently:
 *
 *   1. Four call sites bypassed the api() helper and asked for /v1/… at the root. Mounted under
 *      /browser they hit LeadFlow instead of the console.
 *   2. A rename from at() to mounted() was done with a regex that only matched at('/v1 — so the
 *      helper itself kept calling at(path). There is ALSO a pointer-event helper called at(), and
 *      being a hoisted function declaration it won. Every API call produced a nonsense URL; the
 *      page still rendered, the first call 404ed, and the login form was left on screen looking
 *      like single sign-on had failed. One missed rename, two symptoms that looked unrelated.
 *
 * None of that shows up in a syntax check and none of it shows up until the page is loaded under a
 * prefix. So this reads the shipped file and asserts the property directly: every request goes
 * through the one function that knows where the console is mounted.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

/* The client script now lives in its own file — index.html links it rather than inlining it. Every
   property asserted below is about that script, so we read it directly. */
const script = fs.readFileSync(path.join(pub, 'js', 'console.js'), 'utf8');

describe('the split console is wired together', () => {
  it('index.html links the extracted stylesheet and both scripts', () => {
    expect(HTML).toMatch(/<link rel="stylesheet" href="css\/console\.css">/);
    expect(HTML).toMatch(/<script src="js\/console\.js"><\/script>/);
    expect(HTML).toMatch(/<script src="js\/dashboard\.js"><\/script>/);
  });
  it('loads console.js before dashboard.js — the controller reuses its globals', () => {
    expect(HTML.indexOf('<script src="js/console.js">'))
      .toBeLessThan(HTML.indexOf('<script src="js/dashboard.js">'));
  });
});

describe('every request knows where the console is mounted', () => {
  it('derives the base from its own location rather than being configured', () => {
    expect(script).toMatch(/const BASE = location\.pathname/);
    expect(script).toMatch(/const mounted = \(path\) => BASE \+ path/);
  });

  /* The bug that cost an evening: the helper called at(), which is something else entirely. */
  it('routes the api helper through mounted, not through anything else', () => {
    const start = script.indexOf('async function api(');
    // To the end of the function, rather than a fixed number of characters: a comment added above
    // the fetch pushed it out of a 400-char window and failed this for the wrong reason.
    const api = script.slice(start, script.indexOf('\n}', start));
    expect(api).toMatch(/fetch\(mounted\(path\)/);
  });

  it('has no fetch left asking for a root path', () => {
    const bare = script.match(/fetch\(\s*['"]\/[^'"]*['"]/g) || [];
    expect(bare).toEqual([]);
  });

  /* A websocket ignores <base> and cannot be relative, so these are the easiest to forget — and
     they fail as "the live view never connects", which reads as a browser problem. */
  it('builds both websocket URLs through mounted', () => {
    const sockets = script.match(/new WebSocket\([^)]*\)/g) || [];
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    for (const s of sockets) expect(s).toMatch(/mounted\(/);
  });

  /* A download is a URL the browser follows itself; getting it wrong sends someone to LeadFlow's
     404 page with no clue why. */
  it('builds the leads download link through mounted', () => {
    expect(script).toMatch(/csv'\)\.href = mounted\(/);
  });

  /*
   * The whole point of deriving rather than configuring: one build serves both. Pinned as a worked
   * example so the intent survives the next person to touch that regex.
   */
  it.each([
    ['/browser/', '/browser'],
    ['/browser/index.html', '/browser'],
    ['/', ''],
    ['/index.html', ''],
  ])('a page at %s asks for %s/v1/…', (pathname, expected) => {
    const BASE = pathname.replace(/\/[^/]*$/, '').replace(/\/+$/, '');
    expect(BASE).toBe(expected);
    expect(BASE + '/v1/capacity').toBe(expected + '/v1/capacity');
  });
});

describe('the sign-on handoff runs before the gate', () => {
  /*
   * Single sign-on shipped once doing nothing at all, because the handoff was parsed near the
   * bottom of the file and the gate is drawn from the top. For a feature whose entire job is that
   * the login form is never shown, WHEN it runs is the feature.
   */
  it('reads the handoff earlier in the file than it draws the gate', () => {
    const handoff = script.indexOf('function readHandoff(');
    const gate = script.indexOf('gateState()');
    expect(handoff).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(handoff).toBeLessThan(gate);
  });

  it('tries single sign-on before showing a password box', () => {
    const fn = script.slice(script.indexOf('async function gateState('), script.indexOf('async function gateState(') + 2200);
    expect(fn.indexOf("api('/api/auth/sso'")).toBeGreaterThan(-1);
    // ...and before the branch that decides between signup and login.
    expect(fn.indexOf("api('/api/auth/sso'")).toBeLessThan(fn.indexOf("mode = s.needsSignup"));
  });
});
