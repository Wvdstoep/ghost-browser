/*
 * 2026-11-02: app 0.92 keeps a profile under its own name on the phone ("AliExpress"), and the server
 * still asked for "p_AliExpress" in six places. Every session handed to the phone was refused. The
 * device now runs a profile under the name it advertises, and older apps keep working on "p_<name>".
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { deviceProfileFor, baseName } = require('../src/deviceProfile.js');
const { missesFor } = require('../src/device-hub.js');
const { createSessionRing } = require('../src/sessionRing.js');

const PHONE_092 = { realIp: true, profiles: ['default', 'AliExpress'] };
const PHONE_091 = { realIp: true, profiles: ['default', 'p_linkedin', 'aliexpress'] };

describe('the name a device holds a profile under', () => {
  it('is the same name on a 0.92 phone, case kept', () => {
    expect(deviceProfileFor(PHONE_092, 'AliExpress')).toBe('AliExpress');
    expect(deviceProfileFor(PHONE_092, 'p_AliExpress')).toBe('AliExpress');
    expect(deviceProfileFor(PHONE_092, 'aliexpress')).toBeNull();
  });

  it('is the p_ store on a phone from before 0.92', () => {
    expect(deviceProfileFor(PHONE_091, 'linkedin')).toBe('p_linkedin');
    expect(deviceProfileFor(PHONE_091, 'aliexpress')).toBe('aliexpress');
  });

  it('is nothing for a profile the device does not hold, and default is always held', () => {
    expect(deviceProfileFor(PHONE_092, 'facebook')).toBeNull();
    expect(deviceProfileFor({}, 'facebook')).toBeNull();
    expect(deviceProfileFor(PHONE_092, 'default')).toBe('default');
    expect(deviceProfileFor(undefined, '')).toBe('default');
    expect(baseName('p_linkedin')).toBe('linkedin');
  });

  it('decides whether a device can take work in that profile', () => {
    expect(missesFor(PHONE_092, { realIp: true, profile: 'AliExpress' })).toEqual([]);
    expect(missesFor(PHONE_091, { profile: 'linkedin' })).toEqual([]);
    expect(missesFor(PHONE_092, { profile: 'facebook' })).toEqual(['profile:facebook']);
  });
});

describe('a session handed to the phone', () => {
  const ringOn = (caps, seen) => createSessionRing({
    run: async (_id, spec) => { seen.push(spec.body); return { result: { result: JSON.stringify({ url: 'u', title: 't', ready: 'complete' }) } }; },
    pickDevice: () => ({ deviceId: 'd1', name: 'SM-F926B', caps }), log: {}, wait: async () => {},
  });

  it('runs in AliExpress on a 0.92 phone, never p_AliExpress', async () => {
    const seen = [];
    const ring = ringOn(PHONE_092, seen);
    const s = { id: 's', profile: 'AliExpress' }; ring.attach(s, ['me']); await ring.scroll(s, 100);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((b) => b.profile === 'AliExpress')).toBe(true);
  });

  it('runs in p_linkedin on an older phone', async () => {
    const seen = [];
    const ring = ringOn(PHONE_091, seen);
    const s = { id: 's', profile: 'linkedin' }; ring.attach(s, ['me']); await ring.scroll(s, 100);
    expect(seen.every((b) => b.profile === 'p_linkedin')).toBe(true);
  });

  it('asks for the plain name when the phone lacks it, so the app can say how to add it', async () => {
    const seen = [];
    const ring = ringOn(PHONE_092, seen);
    const s = { id: 's', profile: 'facebook' }; ring.attach(s, ['me']); await ring.scroll(s, 100);
    expect(seen.every((b) => b.profile === 'facebook')).toBe(true);
  });
});
