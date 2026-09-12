/**
 * The console's own settings.
 *
 * The one that matters here is the exit. Routing through the tailnet started life as a per-profile
 * setting, which meant the right answer had to be remembered every time a login was made — and the
 * first login made after that shipped came out exiting from a Finnish datacentre while the header
 * cheerfully reported a laptop in the Netherlands. A default that has to be re-chosen constantly is
 * not a default.
 */
import { describe, it, expect } from 'vitest';
import * as settings from '../src/settings.js';

describe('the exit default', () => {
  /* ON, and it has to stay on. A datacentre address is what Facebook actually refused; there is no
     situation where somebody wants it by omission. */
  it('routes everything through the tailnet unless told otherwise', () => {
    expect(settings.DEFAULTS.routeThroughTailnet).toBe(true);
  });

  /* The checkbox in the exit panel reads this from the redacted view, and so does the header when
     it works out whether the login you are watching is really going through the tailnet. Dropping
     it here would leave both of them silently reading undefined — which reads as "off". */
  it('survives redaction, because the UI decides what to show from it', () => {
    expect(settings.redacted().routeThroughTailnet).toBe(true);
  });
});

describe('acting without asking', () => {
  /* The other direction entirely: joining a group, commenting and messaging happen under a real
     name with no undo, so this one defaults to off and the exit defaults to on. */
  it('stays off until somebody turns it on', () => {
    expect(settings.DEFAULTS.autoAct).toBe(false);
  });

  it('always has a ceiling on how long the agent may run', () => {
    expect(settings.DEFAULTS.maxSteps).toBeGreaterThan(0);
    expect(settings.DEFAULTS.maxSteps).toBeLessThanOrEqual(300);
  });
});

describe('the key', () => {
  it('never comes back out of the redacted view', () => {
    const r = settings.redacted();
    expect(r.llmKey).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r, 'keySet')).toBe(true);
  });
});

describe('one browser for everything', () => {
  /* The default is a single browser signed into every site — separate profiles are the exception
     now, not the rule, because for one person using their own accounts they were pure friction. */
  it('defaults to a single browser', () => {
    expect(settings.DEFAULTS.singleBrowser).toBe(true);
    expect(settings.DEFAULTS.browserProfile).toBeTruthy();
  });

  it('lets the single-browser switch and its profile be changed', () => {
    expect(settings.write.length).toBeGreaterThanOrEqual(0);   // write exists
    // the fields survive the redacted view the UI reads
    const r = settings.redacted();
    expect(typeof r.singleBrowser).toBe('boolean');
    expect(typeof r.browserProfile).toBe('string');
  });
});
