/*
 * A ROLE'S DEVICE REQUIREMENT, IN WORDS A PERSON CHOOSES BY.
 *
 * `{ cdp: true, features: ['click_xy','drag','upload_file'] }` is right for the router and useless
 * for the person deciding whether this is the correct specialist for their profile. And the door
 * that exists to be read before choosing was silent about it entirely: GET /v1/agent/roles/:id
 * projected the role onto name/site/group/label/description/tools/prompt and dropped `require` —
 * the same class of mistake as getRole dropping it, which is why the device gate never fired.
 *
 * The rule the tests below protect is the honesty one: a capability this module has not been taught
 * comes back as its own name, never as a plausible phrase. A confident wrong description of what a
 * role needs is how work gets sent to a machine that cannot do it.
 */
import { describe, it, expect } from 'vitest';
import { requireWords, runsOnWords, FEATURES, FLAGS, andList } from '../src/requireWords.js';

describe('a requirement in words', () => {
  it('says so plainly when there is no requirement at all', () => {
    for (const v of [null, undefined, {}, 'nonsense', 7]) {
      const w = requireWords(v);
      expect(w.any).toBe(false);
      expect(w.sentence).toMatch(/Runs anywhere/);
    }
  });

  it('reads as one sentence for the CapCut requirement', () => {
    const w = requireWords({ cdp: true, features: ['click_xy', 'drag', 'upload_file'] });
    expect(w.sentence).toBe('This role needs a desktop browser it can drive directly, and must be able to '
      + 'click an exact point, drag something across the page and choose a file to upload.');
  });

  it('separates the machine it needs from what it must be able to do', () => {
    /* "needs a desktop browser and click an exact point" reads as one confused requirement. */
    const w = requireWords({ cdp: true, features: ['click_xy'] });
    expect(w.sentence).toMatch(/needs .*, and must be able to /);
  });

  it('uses only one clause when only actions are required', () => {
    expect(requireWords({ features: ['type'] }).sentence).toBe('This role must be able to type.');
  });

  it('names a platform the way a person would', () => {
    expect(requireWords({ platform: 'android' }).sentence).toMatch(/needs a phone/);
    expect(requireWords({ platform: 'desktop' }).sentence).toMatch(/needs a desktop computer/);
  });

  it('PRINTS an unknown capability rather than inventing a phrase for it', () => {
    const w = requireWords({ features: ['warp_drive'] });
    expect(w.sentence).toBe('This role must be able to "warp_drive".');
    expect(w.needs.find((n) => n.key === 'feature:warp_drive').known).toBe(false);
  });

  it('marks every taught capability as known, so a UI can flag the ones it cannot explain', () => {
    const w = requireWords({ cdp: true, features: ['drag', 'warp_drive'] });
    expect(w.needs.filter((n) => n.known).map((n) => n.key)).toEqual(['cdp', 'feature:drag']);
  });

  it('teaches drag under both names devices and roles actually use', () => {
    /* The desktop node advertises `drag`; older roles ask for `drag_xy`. A reader should not have
       to know which, and neither spelling may fall through to the unknown branch. */
    expect(FEATURES.drag).toBeTruthy();
    expect(FEATURES.drag_xy).toBe(FEATURES.drag);
  });

  it('covers exactly the four flags the router matches by name', () => {
    expect(Object.keys(FLAGS).sort()).toEqual(['cdp', 'mobileApp', 'model', 'realIp']);
  });

  it('writes a list the way a person writes one', () => {
    expect(andList([])).toBe('');
    expect(andList(['a'])).toBe('a');
    expect(andList(['a', 'b'])).toBe('a and b');
    expect(andList(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('who can run it right now', () => {
  it('names the device when the router found one', () => {
    const r = runsOnWords({ deviceId: 'd1', name: 'WojMagEmi', candidates: [] });
    expect(r.device).toBe('WojMagEmi');
    expect(r.summary).toBe('Ready to run on WojMagEmi.');
  });

  it('says what each device is short of, in the same words', () => {
    const r = runsOnWords({ deviceId: null, candidates: [{ name: 'Carla phone', misses: ['feature:drag', 'feature:upload_file'] }] });
    expect(r.summary).toBe('No connected device can run this yet — Carla phone cannot drag something '
      + 'across the page and choose a file to upload.');
  });

  it('never reports a device as lacking nothing — that printed "cannot ."', () => {
    const r = runsOnWords({ deviceId: null, candidates: [{ name: 'Carla phone', misses: ['feature:drag'] }, { name: 'WojMagEmi', misses: [] }] });
    expect(r.summary).not.toMatch(/cannot \./);
    expect(r.summary).toBe('Ready to run on WojMagEmi.');
  });

  it('is explicit that the cluster cannot cover for a missing device', () => {
    const r = runsOnWords({ deviceId: null, candidates: [] });
    expect(r.summary).toMatch(/the cluster browser cannot do this on its own/);
  });

  it('survives being handed nothing at all', () => {
    expect(runsOnWords(null).summary).toMatch(/No devices are connected/);
    expect(runsOnWords({}).candidates).toEqual([]);
  });

  it('translates a flag it knows and passes through one it does not', () => {
    const r = runsOnWords({ deviceId: null, candidates: [{ name: 'p', misses: ['cdp', 'quantum'] }] });
    expect(r.candidates[0].lacks).toEqual([FLAGS.cdp, 'quantum']);
  });
});
