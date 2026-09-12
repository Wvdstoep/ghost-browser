/**
 * A BACKGROUND TAB IS NOT PAINTED. Chromium renders only the front tab of a window, so a CDP
 * screencast bound to a background page streams solid black frames — at full rate, with the socket
 * up and the page perfectly healthy, which is why a screenshot of the SAME page comes back correct
 * (Playwright captures it another way). That is the "live view stays black" report, and it returns
 * whenever the session's page is not in front: a sign-in popup, a second tab, a reused profile.
 * So the stream raises its tab first — at the start and again every time it follows a new window.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const live = readFileSync(fileURLToPath(new URL('../src/live.js', import.meta.url)), 'utf8');

describe('the live stream raises the tab it streams', () => {
  const startOn = live.slice(live.indexOf('const startOn = async'), live.indexOf('cdp.on(\'Page.screencastFrame\''));

  it('brings the page to the front BEFORE opening the CDP session and starting the screencast', () => {
    expect(startOn).toMatch(/bringToFront\(\)/);
    expect(startOn.indexOf('bringToFront')).toBeLessThan(startOn.indexOf('newCDPSession'));
    expect(startOn.indexOf('bringToFront')).toBeLessThan(startOn.indexOf('Page.startScreencast'));
  });

  it('never fails the stream over it — a page that will not raise still streams', () => {
    expect(startOn).toMatch(/try \{ await page\.bringToFront\(\); \} catch/);
  });

  it('following a popup goes through the same path, so the new window is raised too', () => {
    // the watcher re-binds by calling startOn(next) — it must not start a screencast of its own
    expect(live).toMatch(/await startOn\(next\)/);
    expect(live.match(/Page\.startScreencast/g)).toHaveLength(1);
  });
});
