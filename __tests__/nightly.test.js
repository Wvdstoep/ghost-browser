/** The nightly self-check fires once per UTC day in its quiet hour, never twice, and carries a goal that stays inward. */
import { describe, it, expect } from 'vitest';
import { due, markRun, GOAL, HOUR_UTC } from '../src/nightly.js';

const at = (h, m = 0, day = '2026-09-18') => Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);

describe('nightly self-check', () => {
  it('is due only in the quiet hour and only once a day', () => {
    expect(due(at(HOUR_UTC), {})).toBe(true);
    expect(due(at(HOUR_UTC, 59), {})).toBe(true);
    expect(due(at(HOUR_UTC + 1), {})).toBe(false);
    expect(due(at(14), {})).toBe(false);
    expect(due(at(HOUR_UTC), { lastDay: '2026-09-18' })).toBe(false);
    expect(due(at(HOUR_UTC, 0, '2026-09-19'), { lastDay: '2026-09-18' })).toBe(true);
  });
  it('marks the day it ran', () => {
    process.env.PROFILE_DIR = require('node:os').tmpdir() + '/nightly-' + Date.now();
    expect(markRun(at(HOUR_UTC, 5), {})).toBe('2026-09-18');
  });
  it('asks for an inward report, never an outward act', () => {
    expect(GOAL).toMatch(/gb_watcher_health/); expect(GOAL).toMatch(/gb_people leadsOnly/); expect(GOAL).toMatch(/Nothing outward/); expect(GOAL).toMatch(/reply with the night/);
  });
});
