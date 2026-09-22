/*
 * ONE ROLE, ONE METHOD PER DEVICE.
 *
 * A role had a single `require`, and that quietly decided which machine could ever run it:
 * capcut-video-editor asks for `{cdp, click_xy, drag, upload_file}`, so the phone was excluded
 * forever — though a phone could do the same job by long-pressing and dragging with a finger. One
 * requirement was really two statements squashed together: what the WORK needs, and how THIS KIND
 * of machine does it.
 *
 * The second half is the one that matters most here: a hand-over carries the method for the device
 * that took the job and NOTHING else. "Drag the clip onto the timeline" and "long-press the clip,
 * then drag with your finger" are both correct, and only one of them is correct HERE. Sending both
 * is how an agent starts guessing, and guessing is what cost seventy steps on a video editor.
 */
import { describe, it, expect } from 'vitest';
import { normDevices, variantsOf, chooseVariant, playbookFor, whyNothingFits, KINDS } from '../src/roleDevices.js';
import { normRequire } from '../src/userRoles.js';

const DESK = 'Drag the clip from the library onto the timeline.';
const PHONE = 'Long-press the clip, then drag it down with your finger.';

const capcut = () => ({
  prompt: 'Open CapCut, import the clip, trim it, export it.',
  require: { cdp: true, features: ['click_xy', 'drag', 'upload_file'] },
  devices: normDevices({
    desktop: { require: { cdp: true, features: ['drag', 'upload_file'] }, method: DESK },
    android: { require: { mobileApp: true, features: ['native_tap'] }, method: PHONE },
  }, normRequire),
});

/** A ring where only the named platforms are online. */
const ringWith = (...platforms) => (need) => (
  platforms.includes(need.platform)
    ? { deviceId: `d-${need.platform}`, name: `the ${need.platform}`, reason: 'matched' }
    : { deviceId: null, reason: `no online device has ${JSON.stringify(need)}`, candidates: [] });

describe('the device section', () => {
  it('keeps only device kinds the ring itself knows', () => {
    const d = normDevices({ desktop: { method: 'a' }, toaster: { method: 'b' } }, normRequire);
    expect(Object.keys(d)).toEqual(['desktop']);
    expect(KINDS).toEqual(['desktop', 'android', 'cluster']);
  });

  it('sets a variant\'s platform from its KEY and never from its body', () => {
    /* Writing platform again inside devices.android is redundant at best and a contradiction at
       worst, and a contradiction here would route phone work to a desktop. */
    const d = normDevices({ android: { require: { platform: 'desktop', mobileApp: true } } }, normRequire);
    expect(d.android.require.platform).toBe('android');
  });

  it('drops a variant that says nothing at all', () => {
    /* Keeping it would make the role look device-aware while behaving exactly as it did. */
    expect(normDevices({ desktop: {} }, normRequire)).toBeNull();
    expect(normDevices({ desktop: { method: '   ' } }, normRequire)).toBeNull();
  });

  it('refuses junk rather than half-storing it', () => {
    for (const v of [null, undefined, 'x', 7, []]) expect(normDevices(v, normRequire)).toBeNull();
  });

  it('caps a method so a role cannot become a document', () => {
    const d = normDevices({ desktop: { method: 'x'.repeat(9000) } }, normRequire);
    expect(d.desktop.method.length).toBe(8000);
  });
});

describe('the ways a role can run', () => {
  it('tries device variants BEFORE the general requirement', () => {
    /* A role that took the trouble to say how the desktop does this work means that method, not
       the generic requirement it was originally written with. */
    expect(variantsOf(capcut()).map((v) => v.kind)).toEqual(['desktop', 'android', 'any']);
  });

  it('is unchanged for a role with no device section — one variant, the old requirement', () => {
    const r = { prompt: 'p', require: { cdp: true } };
    const v = variantsOf(r);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: 'any', require: { cdp: true }, method: '' });
  });

  it('gives a role with no requirement at all a single empty variant', () => {
    const v = variantsOf({ prompt: 'p' });
    expect(v).toHaveLength(1);
    expect(v[0].require).toBeNull();
  });
});

describe('choosing the variant a real device can run', () => {
  it('takes the desktop when only the desktop is connected', () => {
    const c = chooseVariant(capcut(), ringWith('desktop'));
    expect(c.variant.kind).toBe('desktop');
  });

  it('takes the PHONE when only the phone is connected — the case that used to be impossible', () => {
    /* The single requirement asked for cdp, which no phone has, so the role was desktop-only by
       omission even where the work was perfectly doable on a phone. */
    const c = chooseVariant(capcut(), ringWith('android'));
    expect(c.variant.kind).toBe('android');
  });

  it('needs no device at all for a role that requires nothing', () => {
    const c = chooseVariant({ prompt: 'p' }, () => { throw new Error('must not ask the ring'); });
    expect(c.variant.kind).toBe('any');
    expect(c.route).toBeNull();
  });

  it('reports every way it tried when nothing fits', () => {
    const c = chooseVariant(capcut(), ringWith());
    expect(c.variant).toBeNull();
    expect(c.tried.map((t) => t.kind)).toEqual(['desktop', 'android', 'any']);
    const why = whyNothingFits(c.tried);
    expect(why).toMatch(/your desktop:/);
    expect(why).toMatch(/your phone:/);
    expect(why).toMatch(/its general requirement:/);
  });

  it('survives a router that throws instead of answering', () => {
    const c = chooseVariant(capcut(), () => { throw new Error('ring is down'); });
    expect(c.variant).toBeNull();
    expect(whyNothingFits(c.tried)).toMatch(/ring is down/);
  });

  it('says something usable when a role states no way to run at all', () => {
    expect(whyNothingFits([])).toMatch(/states no way to run it/);
  });
});

describe('the playbook handed to the device', () => {
  it('carries the base method plus THIS device\'s, and not the other one', () => {
    const r = capcut();
    const desk = playbookFor(r, chooseVariant(r, ringWith('desktop')).variant);
    expect(desk).toContain(r.prompt);
    expect(desk).toContain(DESK);
    expect(desk).not.toContain(PHONE);

    const phone = playbookFor(r, chooseVariant(r, ringWith('android')).variant);
    expect(phone).toContain(PHONE);
    expect(phone).not.toContain(DESK);
  });

  it('says out loud that this is the method that applies here', () => {
    /* So the agent does not weigh it against something it half-remembers. */
    const r = capcut();
    expect(playbookFor(r, chooseVariant(r, ringWith('desktop')).variant))
      .toMatch(/ON THIS DEVICE \(your desktop\) — this is the method that applies here, and the only one:/);
  });

  it('is exactly the base prompt when the variant adds no method', () => {
    const r = { prompt: 'just do it', require: { cdp: true } };
    expect(playbookFor(r, variantsOf(r)[0])).toBe('just do it');
  });

  it('is the method alone when a role has no base prompt', () => {
    const r = { devices: normDevices({ desktop: { method: DESK } }, normRequire) };
    expect(playbookFor(r, variantsOf(r)[0])).toContain(DESK);
  });

  it('survives being handed nothing', () => {
    expect(playbookFor(null, null)).toBe('');
    expect(playbookFor({ prompt: 'p' }, null)).toBe('p');
  });
});
