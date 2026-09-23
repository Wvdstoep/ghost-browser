/*
 * WHICH SPECIALIST THIS TASK NEEDS, AND WHY THAT ONE.
 *
 * A profile's stored role answers "what does this login usually do". It does not answer "what does
 * THIS task need", and that is the question the chat asks constantly: a CapCut request arrived with
 * no role, ran as `general`, opened a video editor it had no playbook for and died after seventy
 * steps. "Why did it run as general?" was unanswerable, twice. That is the thing under test here —
 * not just the pick, but the reason travelling with it.
 */
import { describe, it, expect } from 'vitest';
import { roleForTask, explainChoice, sitesInGoal } from '../src/roleEngine.js';

const CAPCUT = { name: 'capcut-video-editor', site: 'capcut.com' };
const FB = { name: 'facebook-reply-desk', site: 'facebook.com' };
const GOOGLE = { name: 'google-search-desk', site: 'google.com' };
const ROWS = [CAPCUT, FB, GOOGLE];

const roles = {
  list: () => ROWS,
  get: (id) => ROWS.find((r) => r.name === id) || (id === 'general' ? { name: 'general' } : null),
  canonical: (id) => String(id || '').toLowerCase(),
};
const withProfiles = (byName) => ({ profiles: { read: (n) => byName[n] || {} }, roles });

describe('addresses in a goal', () => {
  it('finds only the ones a role actually knows', () => {
    /* No blocklist of false positives to maintain: "e.g." and "etc." filter themselves out against
       real role data. */
    const hits = sitesInGoal('go to www.capcut.com and export, e.g. 1080p, then check nothing.else', roles);
    expect(hits.map((h) => h.key)).toEqual(['capcut']);
  });

  it('keeps them in the order they appear, without repeats', () => {
    const hits = sitesInGoal('open capcut.com, post to facebook.com, back to capcut.com', roles);
    expect(hits.map((h) => h.key)).toEqual(['capcut', 'facebook']);
  });

  it('finds nothing in a goal with no addresses', () => {
    expect(sitesInGoal('make a viral short from that recording', roles)).toEqual([]);
    expect(sitesInGoal('', roles)).toEqual([]);
  });
});

describe('the engine picks, in descending confidence', () => {
  it('a named role wins and is never second-guessed', () => {
    const d = roleForTask({ named: 'facebook-reply-desk', profile: 'p_capcut', goal: 'go to capcut.com' }, withProfiles({}));
    expect(d).toMatchObject({ role: 'facebook-reply-desk', source: 'named' });
  });

  it('a named role that does not exist falls through but is reported, never swallowed', () => {
    const d = roleForTask({ named: 'capcut-editor-v2', profile: 'p_capcut', goal: '' }, withProfiles({}));
    expect(d.source).toBe('site');
    expect(d.role).toBe('capcut-video-editor');
    expect(explainChoice(d)).toMatch(/there is no role called "capcut-editor-v2"/);
  });

  it('"general" is treated as nobody having named one', () => {
    /* The assistant sends general when it has no opinion, which is how the whole failure started. */
    const d = roleForTask({ named: 'general', profile: 'p_capcut', goal: '' }, withProfiles({}));
    expect(d.role).toBe('capcut-video-editor');
  });

  it('the profile\'s stored choice comes next', () => {
    const d = roleForTask({ profile: 'work-video', goal: 'make a short' },
      withProfiles({ 'work-video': { defaultRole: 'capcut-video-editor' } }));
    expect(d).toMatchObject({ role: 'capcut-video-editor', source: 'chosen' });
    expect(d.why).toMatch(/work-video is set to use capcut-video-editor/);
  });

  it('A STORED CHOICE IS NOT HIJACKED BY A PASSING MENTION — the ordering decision', () => {
    /*
     * "make the short, then post the link on facebook.com" must not swap the video editor for a
     * reply desk. A deliberate human choice outranks a string found in a sentence, and the person
     * who set the role would have no idea why it changed.
     */
    const d = roleForTask({ profile: 'work-video', goal: 'make the short, then post the link on facebook.com' },
      withProfiles({ 'work-video': { defaultRole: 'capcut-video-editor' } }));
    expect(d.role).toBe('capcut-video-editor');
    expect(d.source).toBe('chosen');
  });

  it('…but it SAYS what the goal pointed at, so the correction is one word', () => {
    const d = roleForTask({ profile: 'work-video', goal: 'post the link on facebook.com' },
      withProfiles({ 'work-video': { defaultRole: 'capcut-video-editor' } }));
    expect(d.alternatives).toHaveLength(1);
    expect(d.alternatives[0]).toMatchObject({ role: 'facebook-reply-desk', source: 'goal' });
    expect(explainChoice(d)).toMatch(/the goal mentions facebook\.com, whose specialist is facebook-reply-desk — name it to use that instead/);
  });

  it('does not nag when the goal agrees with the stored choice', () => {
    const d = roleForTask({ profile: 'work-video', goal: 'open capcut.com and export' },
      withProfiles({ 'work-video': { defaultRole: 'capcut-video-editor' } }));
    expect(d.alternatives).toEqual([]);
  });

  it('with no stored choice, the address in the goal is the strongest evidence there is', () => {
    /* A goal naming capcut.com while working in the google profile wants the CapCut specialist. */
    const d = roleForTask({ profile: 'p_google', goal: 'go to capcut.com and make a short' }, withProfiles({}));
    expect(d).toMatchObject({ role: 'capcut-video-editor', source: 'goal' });
    expect(d.why).toMatch(/the goal mentions capcut\.com/);
  });

  it('lists the other addresses it saw rather than picking silently', () => {
    const d = roleForTask({ profile: 'scratch', goal: 'open capcut.com then facebook.com' }, withProfiles({}));
    expect(d.role).toBe('capcut-video-editor');
    expect(d.alternatives.map((a) => a.role)).toEqual(['facebook-reply-desk']);
  });

  it('falls back to the profile\'s own site, so an unconfigured profile is not a generalist', () => {
    const d = roleForTask({ profile: 'p_capcut', goal: 'make a viral short' }, withProfiles({}));
    expect(d).toMatchObject({ role: 'capcut-video-editor', source: 'site' });
  });

  it('matches the profile\'s declared site, not only its name', () => {
    const d = roleForTask({ profile: 'work-video', goal: 'make a short' },
      withProfiles({ 'work-video': { site: 'capcut.com' } }));
    expect(d).toMatchObject({ role: 'capcut-video-editor', source: 'site' });
  });

  it('SAYS it is running as a generalist instead of defaulting in silence', () => {
    /* The silent general is the failure this exists to end: an agent with no playbook, working the
       site out from scratch. */
    const d = roleForTask({ profile: 'scratch', goal: 'tidy up my notes' }, withProfiles({}));
    expect(d).toMatchObject({ role: 'general', source: 'none' });
    expect(explainChoice(d)).toMatch(/^running as a generalist — /);
  });

  it('reports a stored role that no longer exists even while falling back to general', () => {
    const d = roleForTask({ profile: 'scratch', goal: 'tidy up' },
      withProfiles({ scratch: { defaultRole: 'capcut-editor-v2' } }));
    expect(d.role).toBe('general');
    expect(explainChoice(d)).toMatch(/names "capcut-editor-v2", which no longer exists/);
  });

  it('refuses to guess without its stores', () => {
    expect(() => roleForTask({ profile: 'p' })).toThrow(/needs/);
  });

  it('explains nothing as nothing rather than throwing', () => {
    expect(explainChoice(null)).toBe('');
  });
});

describe('a goal about somewhere else entirely', () => {
  /*
   * MEASURED ON A REAL RUN, NOT IMAGINED.
   *
   * The goal named ecb.europa.eu. The profile in use was facebook. The job ran as the facebook
   * specialist, whose tool list does not carry download_link, so the download was refused at the
   * first attempt — and the agent then reported that it had downloaded the file anyway. The
   * verifier caught that claim and filed the run bronze, correctly, but the run had been made
   * impossible before it started.
   *
   * A site specialist earns its place through its playbook FOR THAT SITE. Pointed somewhere else it
   * is only a smaller toolbox and instructions about the wrong place: strictly worse than a
   * generalist, and silently so.
   */
  const onFacebook = withProfiles({ facebook: { site: 'facebook.com' } });

  it('DOES NOT HAND A FACEBOOK SPECIALIST A JOB ABOUT ecb.europa.eu', () => {
    const d = roleForTask(
      { goal: 'Go to https://www.ecb.europa.eu/stats/ and download the CSV', profile: 'facebook' },
      onFacebook,
    );
    expect(d.role).toBe('general');
    expect(d.source).toBe('elsewhere');
    expect(d.why).toContain('ecb.europa.eu');
  });

  it('still offers the profile own role, in case it really was that work', () => {
    const d = roleForTask({ goal: 'Open https://example.com and read it', profile: 'facebook' }, onFacebook);
    expect(d.alternatives.some((a) => a.source === 'site')).toBe(true);
  });

  it('keeps the facebook specialist when the goal names that same site', () => {
    /* The ordinary case, which must not regress. It arrives by the ADDRESS in the goal rather than
       the profile fallback — a goal naming facebook.com is answered by the role that knows
       facebook.com, one rule earlier — so the route differs and the answer is the same. */
    const d = roleForTask({ goal: 'Read my facebook.com notifications', profile: 'facebook' }, onFacebook);
    expect(d.role).toBe('facebook-reply-desk');
    expect(d.source).not.toBe('elsewhere');
  });

  it('keeps the site specialist when the goal names no address at all', () => {
    /* "check my groups" is about the profile by default — nothing points elsewhere. */
    const d = roleForTask({ goal: 'Check my groups for people asking for a developer', profile: 'facebook' }, onFacebook);
    expect(d.source).toBe('site');
  });

  it('a named role still wins over all of it', () => {
    const d = roleForTask(
      { goal: 'Go to https://www.ecb.europa.eu and download the CSV', profile: 'facebook', named: 'google-search-desk' },
      onFacebook,
    );
    expect(d.source).toBe('named');
  });
});
