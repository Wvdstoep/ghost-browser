/**
 * tools/ — the tools extracted out of run().
 *
 * WHY THESE TESTS ARE SHORT, and the whole point of the split: every one of these behaviours was
 * already covered, but only through the entire agent loop — a fake page, a scripted model, a job
 * store, fifty lines of setup to prove that "save this sentence" saves a sentence. A tool that is
 * its own module is testable as one, which is what makes the next tool cheap to add.
 */
import { describe, it, expect, vi } from 'vitest';
import * as registry from '../src/tools/index.js';
import profiles from '../src/tools/profiles.js';

function ctx(over = {}) {
  const steps = [], said = [];
  return {
    steps, said,
    observe: (t) => said.push(t),
    step: (kind, text) => steps.push({ kind, text }),
    switchedSession: vi.fn(),
    describeProfiles: () => 'fb — facebook (in use)',
    page: () => ({ url: () => 'https://example.test/here' }),
    session: () => ({ id: 's1', profile: 'fb' }),
    setSession: vi.fn(),
    switchProfile: null,
    ...over,
  };
}

describe('the registry', () => {
  it('claims exactly the tools that have been moved, and nothing else', () => {
    // The loop falls through to its remaining switch for anything absent, so a name claimed here
    // and not implemented would silently do nothing at all.
    for (const name of ['list_profiles', 'use_profile', 'remember_about_me', 'save_my_writing',
                        'describe_my_voice', 'waiting_on', 'whose_is_this', 'record_reply',
                        'conversation', 'save_gig', 'save_reach', 'save_opportunity',
                        'diagnostics', 'note', 'finish',
                        'scroll', 'back', 'look', 'read', 'open']) {
      expect(registry.has(name), name).toBe(true);
      expect(typeof registry.REGISTRY[name], name).toBe('function');
    }
    /* Still in the switch. These are the ones the GUARDS act on — a click can be refused, a type
       can publish, an act waits for a person — so they move last, where a mistake is hardest to see
       and the policy that protects a real account is nearest. */
    for (const notYet of ['click', 'type', 'act', 'sweep', 'google', 'dig', 'save_lead']) {
      expect(registry.has(notYet), notYet).toBe(false);
    }
  });

  it('never claims a name it cannot run', () => {
    for (const [name, fn] of Object.entries(registry.REGISTRY)) {
      expect(typeof fn, name).toBe('function');
    }
  });
});

describe('use_profile — a switch is a different browser, not a setting', () => {
  it('hands the new session back, so the loop stops driving the old one', async () => {
    /*
     * The bug this guards: every helper reads the CURRENT page, and a switch that updated only some
     * of them left the agent working the browser it had left while the person watched the new one
     * do nothing.
     */
    const next = { id: 's2', profile: 'li' };
    const c = ctx({ switchProfile: vi.fn(async () => next) });
    await profiles.use_profile(c, { profile: 'li' });
    expect(c.setSession).toHaveBeenCalledWith(next);
    expect(c.switchedSession).toHaveBeenCalledWith({ sessionId: 's2', profile: 'li' });
    expect(c.said.join(' ')).toMatch(/Switched to "li"/);
  });

  it('says so plainly when switching is not available in this run', async () => {
    const c = ctx({ switchProfile: null });
    await profiles.use_profile(c, { profile: 'li' });
    expect(c.said[0]).toMatch(/not available in this run/);
    expect(c.setSession).not.toHaveBeenCalled();
  });

  it('list_profiles reads, and does not open anything', async () => {
    const c = ctx();
    await profiles.list_profiles(c);
    expect(c.said[0]).toMatch(/fb — facebook/);
    expect(c.setSession).not.toHaveBeenCalled();
  });
});

describe('current_url', () => {
  it('reads a youtube channel id out of the path so a link can be built, not guessed', async () => {
    const c = ctx({ page: () => ({ url: () => 'https://studio.youtube.com/channel/UCabc123DEF/editing/branding', title: async () => 'YouTube Studio' }) });
    await registry.run('current_url', c);
    expect(c.said.join(' ')).toMatch(/UCabc123DEF/);
    expect(c.said.join(' ')).toMatch(/studio\.youtube\.com\/channel\/UCabc123DEF/);
  });
  it('still reports the plain URL when there is no id in the path', async () => {
    const c = ctx({ page: () => ({ url: () => 'https://example.test/here', title: async () => 'X' }) });
    await registry.run('current_url', c);
    expect(c.said.join(' ')).toMatch(/example\.test\/here/);
  });
});
