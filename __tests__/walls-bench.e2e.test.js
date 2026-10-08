/** The scoreboard is a claim; this keeps it honest. Each wall must beat the naive agent for the stated reason. */
import { describe, it, expect } from 'vitest';
import { runBench } from '../scripts/walls-bench.js';

let ok = true;
try { const { chromium } = await import('playwright'); const b = await chromium.launch({ args: ['--no-sandbox'] }).catch(async (e) => { if (process.env.GB_CHROMIUM) return chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.GB_CHROMIUM }); throw e; }); await b.close(); }
catch { ok = false; console.warn('[walls-bench] no Chromium — skipping'); }

describe.skipIf(!ok)('walls benchmark', () => {
  it('every wall fails the naive agent and passes with the mechanism; the open read is right either way and cheaper with a card', async () => {
    const res = await runBench();
    const by = (w, s) => res.find((r) => r.wall === w && r.strategy === s);
    for (const w of ['totp', 'passkey', 'bound-session', 'injection', 'stale-data']) {
      expect(by(w, 'naive').passed, `${w} / naive should fail`).toBe(false);
      expect(by(w, 'gb').passed, `${w} / gb should pass: ${by(w, 'gb').detail}`).toBe(true);
    }
    expect(by('open-read', 'naive').passed).toBe(true);
    expect(by('open-read', 'gb').passed).toBe(true);
    expect(by('open-read', 'gb').requests).toBe(1);
    expect(by('open-read', 'naive').requests).toBeGreaterThan(1);
    expect(res.every((r) => r.simulated)).toBe(true);                         // nothing is reported without saying what was simulated
  }, 120000);
});
