import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const { makeMobileAuth } = createRequire(import.meta.url)('../src/mobileAuth');
const verifier = 'v'.repeat(43);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
describe('system-browser to Android PKCE connection', () => {
  it('connects the authorized owner once, with the correct verifier', () => {
    const mintDevice = vi.fn(x => ({ ...x, token: 'device-key' }));
    const auth = makeMobileAuth({ mintDevice });
    const { code } = auth.issue('ben', challenge);
    expect(auth.redeem({ code, verifier, deviceId: 'phone', name: 'Pixel' }).token).toBe('device-key');
    expect(mintDevice).toHaveBeenCalledWith({ owner: 'ben', deviceId: 'phone', name: 'Pixel' });
    expect(() => auth.redeem({ code, verifier, deviceId: 'phone' })).toThrow(/expired/);
  });
  it('a different app intercepting the callback cannot redeem the code', () => {
    const mintDevice = vi.fn(); const auth = makeMobileAuth({ mintDevice }); const { code } = auth.issue('ben', challenge);
    expect(() => auth.redeem({ code, verifier: 'x'.repeat(43), deviceId: 'other' })).toThrow();
    expect(mintDevice).not.toHaveBeenCalled();
    auth.redeem({ code, verifier, deviceId: 'phone' });
    expect(mintDevice).toHaveBeenCalledTimes(1);
  });
  it('rejects expiry, malformed inputs and unauthenticated issuance', () => {
    let now = 1; const mintDevice = vi.fn(); const auth = makeMobileAuth({ mintDevice, now: () => now });
    const { code } = auth.issue('ben', challenge); now += 120001;
    expect(() => auth.redeem({ code, verifier, deviceId: 'phone' })).toThrow();
    expect(() => auth.issue('', challenge)).toThrow();
    expect(() => auth.issue('ben', 'bad')).toThrow();
    expect(() => auth.redeem({ code: 'bad', verifier, deviceId: 'phone' })).toThrow();
    expect(mintDevice).not.toHaveBeenCalled();
  });
  it('bounds pending codes and releases expired entries', () => {
    let now = 1; const auth = makeMobileAuth({ mintDevice: vi.fn(), now: () => now, maxPending: 1 });
    auth.issue('ben', challenge); expect(() => auth.issue('ben', challenge)).toThrow(/moment/);
    now += 120001; expect(auth.issue('ben', challenge).code).toHaveLength(43);
  });
});
