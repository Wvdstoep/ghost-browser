/*
 * WHICH ROLE A PROFILE USES — and why that answer has to carry its source.
 *
 * The pairing used to be worked out by comparing NAMES. It held until someone renamed either side,
 * or named a profile the way a person actually would, and then it was gone with no error: the agent
 * became a generalist with no playbook. It happened twice to the same CapCut walk, which then spent
 * seventy steps working out a video editor from scratch, and "why did it run as general?" was
 * unanswerable both times.
 *
 * So each case below is a state that produced, or would produce, a silent generalist.
 */
import { describe, it, expect } from 'vitest';
import { siteKey, roleChoice } from '../src/profileRole.js';

/* Stand-ins for the two stores, so this needs no volume and no browser. */
const store = (byName) => ({
  read: (n) => byName[n] || {},
});
const roleStore = (rows) => ({
  list: () => rows,
  get: (id) => rows.find((r) => r.name === id || r.id === id) || null,
  canonical: (id) => String(id || '').toLowerCase(),
});

const CAPCUT = { name: 'capcut-video-editor', site: 'capcut.com' };
const LINKEDIN = { name: 'linkedin-reply-desk', site: 'linkedin.com' };
const ROLES = roleStore([CAPCUT, LINKEDIN]);

describe('siteKey folds the names a profile and a role are spelled with', () => {
  it.each([
    ['p_capcut', 'capcut'],
    ['capcut.com', 'capcut'],
    ['www.capcut.com', 'capcut'],
    ['CapCut.COM', 'capcut'],
    ['p_linked-in', 'linkedin'],
  ])('%s → %s', (input, want) => expect(siteKey(input)).toBe(want));

  it('strips www BEFORE splitting — otherwise every www site keys as "www"', () => {
    expect(siteKey('www.capcut.com')).not.toBe('www');
    expect(siteKey('www.linkedin.com')).not.toBe(siteKey('www.capcut.com'));
  });

  it('is empty for nothing, so an unnamed profile matches nothing rather than everything', () => {
    for (const v of ['', null, undefined, '...', '///']) expect(siteKey(v)).toBe('');
  });
});

describe('the profile chooses its role', () => {
  const deps = (byName) => ({ profiles: store(byName), roles: ROLES });

  it('a stored choice wins, even when the names match nothing', () => {
    const c = roleChoice('work-video', deps({ 'work-video': { defaultRole: 'capcut-video-editor' } }));
    expect(c).toMatchObject({ role: 'capcut-video-editor', source: 'chosen' });
  });

  it('a stored choice wins over a site that points somewhere else', () => {
    const c = roleChoice('p_linkedin', deps({ p_linkedin: { site: 'linkedin.com', defaultRole: 'capcut-video-editor' } }));
    expect(c.role).toBe('capcut-video-editor');
    expect(c.source).toBe('chosen');
  });

  it('with no choice stored, the site match still applies — an unconfigured profile is not a generalist', () => {
    const c = roleChoice('p_capcut', deps({}));
    expect(c).toMatchObject({ role: 'capcut-video-editor', source: 'site', suggested: 'capcut-video-editor' });
  });

  it('matches on the declared site before the name, so "work-video" with site capcut.com works', () => {
    const c = roleChoice('work-video', deps({ 'work-video': { site: 'capcut.com' } }));
    expect(c).toMatchObject({ role: 'capcut-video-editor', source: 'site' });
  });

  it('falls back to general and SAYS so, rather than defaulting in silence', () => {
    const c = roleChoice('scratchpad', deps({}));
    expect(c).toEqual({ role: 'general', source: 'none' });
  });

  it('a stored role that no longer exists is reported, not silently ignored', () => {
    /* The configuration rotted: the profile looks configured, reports a role, and behaves as a
       generalist. That is the one state worth shouting about. */
    const c = roleChoice('scratchpad', deps({ scratchpad: { defaultRole: 'capcut-editor-v2' } }));
    expect(c).toMatchObject({ role: 'general', source: 'none', missing: 'capcut-editor-v2' });
  });

  it('a rotted choice still names what was meant when the site can cover for it', () => {
    const c = roleChoice('p_capcut', deps({ p_capcut: { defaultRole: 'capcut-editor-v2' } }));
    expect(c).toMatchObject({ role: 'capcut-video-editor', source: 'site', missing: 'capcut-editor-v2' });
  });

  it('a profile that cannot be read at all answers general instead of throwing', () => {
    const c = roleChoice('p', { profiles: { read: () => { throw new Error('volume gone'); } }, roles: ROLES });
    expect(c.role).toBe('general');
  });

  it('refuses to guess without its stores, rather than quietly answering general', () => {
    expect(() => roleChoice('p_capcut')).toThrow(/needs/);
  });
});
