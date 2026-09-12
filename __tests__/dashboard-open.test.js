/**
 * ONE NAVIGATION PER OPEN. Opening a platform card runs the console's open (adopt → for a preset
 * profile, navigate to preset.start) AND used to click "go" ~1.3s later as well. Two navigations on a
 * fresh profile: Chromium aborts whichever is still loading — a 500 (net::ERR_ABORTED) and a black
 * live view on a brand-new Hacker News profile. The dashboard now leaves the navigation to the preset
 * when one covers the profile, and only clicks "go" for a profile no preset knows.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dash = readFileSync(fileURLToPath(new URL('../public/js/dashboard.js', import.meta.url)), 'utf8');
const consoleJs = readFileSync(fileURLToPath(new URL('../public/js/console.js', import.meta.url)), 'utf8');

describe('runOpen — a preset-covered profile is navigated once, by the console', () => {
  const fn = dash.slice(dash.indexOf('function runOpen('), dash.indexOf('function watchLive('));
  it('skips the delayed "go" click when the profile is a preset or a preset covers its name', () => {
    expect(fn).toMatch(/startsWith\('preset:'\)/);
    expect(fn).toMatch(/PRESETS\.some\(\(x\) => x && x\.profile === r\.profileValue\)/);
    expect(fn).toMatch(/if \(target && !covered\) setTimeout/);
  });
  it('the console navigates a preset session to its start page itself — that is the one navigation', () => {
    expect(consoleJs).toMatch(/const preset = PRESETS\.find\(x => x\.profile === s\.profile\)/);
    expect(consoleJs).toMatch(/\/navigate', \{ method:'POST', body: JSON\.stringify\(\{ url: preset\.start \}\)/);
    expect(consoleJs).toMatch(/^let PRESETS = \[\]/m);   // script-scoped, so dashboard.js can read it
  });
  it('the desk rooms have cards (reddit, hacker news, indie hackers) so there is a place to sign in', () => {
    for (const id of ["id:'reddit'", "id:'hn'", "id:'indiehackers'"]) expect(dash).toContain(id);
  });
});
