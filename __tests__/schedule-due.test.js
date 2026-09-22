/*
 * WHEN A WATCHER IS DUE — and, for a daily one, why a single minute was not enough.
 *
 * The daily rule used to be due only ON its minute: hours === hh && minutes === mm. The scheduler
 * ticks once a minute, so that is ONE chance a day, and it is lost whenever another pass holds the
 * browser at that minute (four watchers on this box run every 10 to 20 minutes), whenever the pod
 * rolls through it, or whenever a tick lands a second late. The property then goes unread for the day,
 * silently, while the card shows the previous reading as the newest there is.
 *
 * These tests pin the window that replaced it, and the gap gate that keeps a window from being a loop.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const wfs = require('../src/workflows');

const at = (s) => new Date(s);
const HOUR = 3600e3;
const daily = { type: 'schedule', every: 'day', at: '07:20' };

describe('a daily watcher', () => {
  /* Yesterday evening at 20:01, so the 22-hour gap is open by 07:20 the day after tomorrow. */
  const lastNight = at('2026-09-20T20:01:00').getTime();

  it('fires on its minute', () => {
    expect(wfs.scheduleDue(daily, lastNight, at('2026-09-22T07:20:30'))).toBe(true);
  });

  /* THE BUG: at 07:21 the old rule said no, and the next yes was twenty-four hours later. */
  it('still fires a minute late, because the browser was busy on the minute', () => {
    expect(wfs.scheduleDue(daily, lastNight, at('2026-09-22T07:21:00'))).toBe(true);
  });

  it('and hours late, because reading late beats not reading', () => {
    expect(wfs.scheduleDue(daily, lastNight, at('2026-09-22T14:00:00'))).toBe(true);
    expect(wfs.scheduleDue(daily, lastNight, at('2026-09-22T23:59:00'))).toBe(true);
  });

  it('does not fire before its time', () => {
    expect(wfs.scheduleDue(daily, lastNight, at('2026-09-22T07:19:00'))).toBe(false);
    expect(wfs.scheduleDue(daily, lastNight, at('2026-09-22T00:05:00'))).toBe(false);
  });

  /* The gap is what makes the window one pass rather than every tick for the rest of the day. */
  it('fires once, not on every tick after its time', () => {
    const ranToday = at('2026-09-22T07:20:10').getTime();
    expect(wfs.scheduleDue(daily, ranToday, at('2026-09-22T07:21:00'))).toBe(false);
    expect(wfs.scheduleDue(daily, ranToday, at('2026-09-22T18:00:00'))).toBe(false);
    /* And the next day it is due again. */
    expect(wfs.scheduleDue(daily, ranToday, at('2026-09-23T07:20:05'))).toBe(true);
  });

  it('is due as soon as it may be when it has never run', () => {
    expect(wfs.scheduleDue(daily, 0, at('2026-09-22T07:20:00'))).toBe(true);
    expect(wfs.scheduleDue(daily, 0, at('2026-09-22T06:00:00'))).toBe(false);
  });

  it('defaults to 08:00 when no time is set', () => {
    const noTime = { type: 'schedule', every: 'day' };
    expect(wfs.scheduleDue(noTime, 0, at('2026-09-22T07:59:00'))).toBe(false);
    expect(wfs.scheduleDue(noTime, 0, at('2026-09-22T08:00:00'))).toBe(true);
  });
});

describe('the interval watchers, unchanged', () => {
  it('fires once its interval has passed', () => {
    const t = at('2026-09-22T08:00:00');
    const fifteen = { type: 'schedule', every: 'minute', n: 15 };
    expect(wfs.scheduleDue(fifteen, t.getTime() - 14 * 60e3, t)).toBe(false);
    expect(wfs.scheduleDue(fifteen, t.getTime() - 15 * 60e3, t)).toBe(true);
    const hourly = { type: 'schedule', every: 'hour', n: 2 };
    expect(wfs.scheduleDue(hourly, t.getTime() - HOUR, t)).toBe(false);
    expect(wfs.scheduleDue(hourly, t.getTime() - 2 * HOUR, t)).toBe(true);
  });

  it('treats a missing n as one, and an unknown unit as never', () => {
    const t = at('2026-09-22T08:00:00');
    expect(wfs.scheduleDue({ type: 'schedule', every: 'minute' }, t.getTime() - 60e3, t)).toBe(true);
    expect(wfs.scheduleDue({ type: 'schedule', every: 'fortnight' }, 0, t)).toBe(false);
    expect(wfs.scheduleDue(null, 0, t)).toBe(false);
  });
});
