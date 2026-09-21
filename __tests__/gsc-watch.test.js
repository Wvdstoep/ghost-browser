/*
 * THE SEARCH CONSOLE WATCHER'S RULES, without a console, a Chromium or a Pulse.
 *
 * Three of these tests exist because of things that actually went wrong:
 *
 *   A FEED ROW KEYED ON A CHANGING TITLE FILLS THE PAGE WITH HISTORY. The feed keys an item on its
 *   url plus its title, so "not indexed — 12" as a title means the next pass adds a second row rather
 *   than updating the first. The number lives in the fields for exactly that reason.
 *
 *   STALE SHOWN AS CURRENT. Pulse displayed a 2026-09-10 reading for eleven days as though it were
 *   today's, because nothing ever asked which day the stored reading was from. Only today counts.
 *
 *   A WALK STOPPED HALFWAY STILL READ SOMETHING. Findings accumulate on the job as they are read, so
 *   the collector takes whatever is there and never requires a clean finish.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gsc = require('../src/gscWatch');

const PROPERTY = 'https://my-app.engineer/';
const runWith = (...jobIds) => ({ steps: jobIds.map((id) => ({ output: { __jobId: id } })) });
const jobs = (map) => (id) => map[id] || null;

describe('the addresses the walk is handed', () => {
  it('covers all six tabs, each with its own address', () => {
    const tabs = gsc.CONSOLE_TABS(PROPERTY);
    expect(tabs).toHaveLength(6);
    expect(tabs.map((t) => t.key)).toEqual(['indexing', 'sitemap', 'manual_action', 'security', 'message', 'vitals']);
    for (const t of tabs) expect(t.url).toMatch(/^https:\/\/search\.google\.com\/search-console\//);
  });

  it('scopes every property tab to the property, encoded', () => {
    for (const t of gsc.CONSOLE_TABS(PROPERTY)) {
      if (t.key === 'message') continue;
      expect(t.url).toContain('resource_id=' + encodeURIComponent(PROPERTY));
    }
  });

  /* Given a resource_id this tab answers 404. The walk found that out; the address stays account-wide. */
  it('leaves messages account-wide, because the property-scoped address 404s', () => {
    const msg = gsc.CONSOLE_TABS(PROPERTY).find((t) => t.key === 'message');
    expect(msg.url).toBe('https://search.google.com/search-console/messages');
    expect(msg.url).not.toContain('resource_id');
  });

  it('puts the property and every address in the goal, and says read-only', () => {
    const goal = gsc.auditGoal({ app: 'my-app.engineer', property: PROPERTY });
    expect(goal).toContain(PROPERTY);
    for (const t of gsc.CONSOLE_TABS(PROPERTY)) expect(goal).toContain(t.url);
    expect(goal).toMatch(/[Rr]ead-only/);
    expect(goal).toMatch(/save_gsc_health/);
  });
});

describe('collecting what the walk wrote down', () => {
  it('takes the findings off every job the run produced', () => {
    const run = runWith('j1', 'j2');
    const f = gsc.findingsOf(run, jobs({
      j1: { gscHealth: [{ kind: 'indexing', label: 'indexed', value: '4' }] },
      j2: { gscHealth: [{ kind: 'sitemap', label: 'sitemap.xml', value: 'Geslaagd' }] },
    }));
    expect(f).toHaveLength(2);
  });

  /* A walk that re-reads a tab and sees 11 become 12 reports 12, not both. */
  it('keeps the last reading of the same row, not two of them', () => {
    const f = gsc.findingsOf(runWith('j1'), jobs({
      j1: { gscHealth: [{ kind: 'indexing', label: 'not indexed', value: '11' }, { kind: 'indexing', label: 'not indexed', value: '12' }] },
    }));
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe('12');
  });

  it('treats the same label under two kinds as two findings', () => {
    const f = gsc.findingsOf(runWith('j1'), jobs({
      j1: { gscHealth: [{ kind: 'indexing', label: 'status', value: 'processing' }, { kind: 'vitals', label: 'status', value: 'not enough data' }] },
    }));
    expect(f).toHaveLength(2);
  });

  it('drops what could never be filed, rather than carrying it to Pulse', () => {
    const f = gsc.findingsOf(runWith('j1'), jobs({
      j1: { gscHealth: [{ kind: 'indexing', label: '' }, { label: 'orphan' }, null, { kind: 'sitemap', label: 'ok', value: 'x' }] },
    }));
    expect(f).toHaveLength(1);
    expect(f[0].label).toBe('ok');
  });

  it('survives a run whose job is gone, and one that read nothing', () => {
    expect(gsc.findingsOf(runWith('j1'), jobs({}))).toEqual([]);
    expect(gsc.findingsOf(runWith('j1'), () => { throw new Error('no such job'); })).toEqual([]);
    expect(gsc.findingsOf(null, jobs({}))).toEqual([]);
    expect(gsc.findingsOf({ steps: [{ output: null }, {}] }, jobs({}))).toEqual([]);
  });
});

describe('the rows the results page shows', () => {
  const findings = [
    { kind: 'indexing', label: 'not indexed', value: '12', detail: 'Google chose a different canonical' },
    { kind: 'manual_action', label: 'manual actions', value: 'Geen problemen gedetecteerd' },
    { kind: 'sitemap', label: 'none submitted', value: '' },
  ];

  /* The whole reason the value is a field: a row must be the SAME row next pass. */
  it('titles a row by its name only, so the next pass updates it instead of adding one', () => {
    const rows = gsc.feedRowsFor(findings, { property: PROPERTY });
    const notIndexed = rows.find((r) => r.title === 'not indexed');
    expect(notIndexed.title).toBe('not indexed');
    expect(notIndexed.title).not.toContain('12');
    expect(notIndexed.fields.value).toBe('12');

    const later = gsc.feedRowsFor([{ kind: 'indexing', label: 'not indexed', value: '9' }], { property: PROPERTY })[0];
    expect(later.title).toBe(notIndexed.title);
    expect(later.url).toBe(notIndexed.url);      // same key → the feed updates one row
    expect(later.fields.value).toBe('9');
  });

  it('carries no draft and is marked read-only, so the card offers nothing to press', () => {
    for (const r of gsc.feedRowsFor(findings, { property: PROPERTY })) {
      expect(r.draft).toBe('');
      expect(r.readOnly).toBe(true);
    }
  });

  it('links each row back to the tab it was read on', () => {
    const rows = gsc.feedRowsFor(findings, { property: PROPERTY });
    expect(rows.find((r) => r.kind === 'sitemap').url).toContain('/sitemaps');
    expect(rows.find((r) => r.kind === 'manual_action').url).toContain('/manual-actions');
  });

  it('leads with the finding that makes every other number irrelevant', () => {
    const rows = gsc.feedRowsFor(findings, { property: PROPERTY });
    expect(rows[0].kind).toBe('manual_action');
  });

  it('says so plainly when a row had nothing beside it', () => {
    const row = gsc.feedRowsFor([{ kind: 'sitemap', label: 'none submitted', value: '' }], {})[0];
    expect(row.fields.value).toBe('(nothing shown)');
  });
});

describe('is Pulse up to date — the one row that says whether the rest is current', () => {
  const now = new Date('2026-09-21T18:00:00Z');
  const ok = { ok: true, wired: true, filed: 6, skipped: 0 };

  it('says only today is up to date', () => {
    expect(gsc.upToDate('2026-09-21', now)).toBe(true);
    expect(gsc.upToDate('2026-09-20', now)).toBe(false);
    expect(gsc.upToDate(null, now)).toBe(false);
  });

  it('counts the days, so "behind" is a number a person can act on', () => {
    expect(gsc.daysBehind('2026-09-10', now)).toBe(11);
    expect(gsc.daysBehind('2026-09-21', now)).toBe(0);
    expect(gsc.daysBehind(null, now)).toBe(null);
    expect(gsc.daysBehind('not a day', now)).toBe(null);
  });

  it('reports up to date when Pulse itself holds today', () => {
    const row = gsc.pulseRow({ app: 'my-app.engineer', read: 6, filed: ok, held: { ok: true, wired: true, latestDay: '2026-09-21' }, now });
    expect(row.fields.pulse).toBe('up to date');
    expect(row.fields['pulse holds']).toContain('(today)');
    expect(row.fields['filed now']).toBe('6 findings');
  });

  /* The eleven silent days. Pulse held the 10th and the screen read as if it were current. */
  it('names the age when Pulse is behind', () => {
    const row = gsc.pulseRow({ app: 'my-app.engineer', read: 0, filed: { ok: false, wired: true, filed: 0, skipped: 0, why: 'nothing worth filing' }, held: { ok: true, wired: true, latestDay: '2026-09-10' }, now });
    expect(row.fields.pulse).toBe('behind');
    expect(row.fields['pulse holds']).toBe('2026-09-10 — 11 days old');
    expect(row.fields.why).toBe('nothing worth filing');
  });

  it('trusts what Pulse gave back, not our own write', () => {
    const row = gsc.pulseRow({ app: 'a', read: 6, filed: { ok: true, wired: true, filed: 6 }, held: { ok: true, wired: true, latestDay: '2026-09-10' }, now });
    expect(row.fields.pulse).toBe('behind');
  });

  it('distinguishes never connected from could not read', () => {
    const off = gsc.pulseRow({ app: 'a', read: 6, filed: { ok: false, wired: false, why: 'Pulse is not connected to this browser' }, held: { ok: false, wired: false, findings: [] }, now });
    expect(off.fields.pulse).toBe('Pulse is not connected');
    const unread = gsc.pulseRow({ app: 'a', read: 6, filed: { ok: true, wired: true, filed: 6 }, held: { ok: false, wired: true, why: 'could not reach Pulse: ENOTFOUND' }, now });
    expect(unread.fields.pulse).toBe('could not read Pulse back');
    expect(unread.fields.why).toMatch(/could not reach Pulse/);
  });

  it('says when no app has been named, instead of blaming Pulse', () => {
    const row = gsc.pulseRow({ app: '', read: 6, filed: {}, held: {}, now });
    expect(row.fields.pulse).toBe('no app named');
    expect(row.fields.app).toBeUndefined();
  });

  it('reports a pass that read nothing as exactly that', () => {
    const row = gsc.pulseRow({ app: 'a', read: 0, filed: { ok: false, wired: true, filed: 0, skipped: 0 }, held: { ok: true, wired: true, latestDay: null, findings: [] }, now });
    expect(row.fields['read this pass']).toMatch(/nothing read/);
    expect(row.fields.pulse).toBe('nothing filed yet');
  });

  it('counts what Pulse would not store, so "filed 5" is never mistaken for "read 6"', () => {
    const row = gsc.pulseRow({ app: 'a', read: 6, filed: { ok: true, wired: true, filed: 5, skipped: 1 }, held: { ok: true, wired: true, latestDay: '2026-09-21' }, now });
    expect(row.fields['not filed']).toMatch(/1 had no name/);
  });

  /* Its title is its identity in the feed: one status row for ever, not one per pass. */
  it('keeps one stable title whatever it says', () => {
    const a = gsc.pulseRow({ app: 'my-app.engineer', read: 6, filed: ok, held: { ok: true, wired: true, latestDay: '2026-09-21' }, now });
    const b = gsc.pulseRow({ app: 'my-app.engineer', read: 0, filed: {}, held: {}, now: new Date('2026-10-02T00:00:00Z') });
    expect(a.title).toBe(gsc.PULSE_TITLE);
    expect(b.title).toBe(a.title);
    expect(a.url).toBe(b.url);
    for (const k of Object.keys(a.fields)) expect(a.title).not.toContain(String(a.fields[k]));
  });

  it('sits above the findings and offers nothing to press', () => {
    const row = gsc.pulseRow({ app: 'a', read: 6, filed: ok, held: { ok: true, wired: true, latestDay: '2026-09-21' }, now });
    expect(row.urgency).toBe(9);
    expect(row.draft).toBe('');
    expect(row.readOnly).toBe(true);
  });
});

/*
 * WIRED AT EVERY DOOR. A watcher fires three ways — by hand from the results page, from the operator's
 * runWatcher tool, and unattended from the scheduler — and a mode present at one door but absent from
 * another does not error: it falls through to the plain role path, which runs the walk and then files
 * and shows nothing. The failure looks exactly like success from the outside.
 */
describe('the gsc mode is reachable however the watcher is fired', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');

  it('exists as its own pass', () => {
    expect(src).toMatch(/async function gscWatchTick\(wf, owner, opts\) \{/);
  });

  it('is dispatched at all three doors', () => {
    expect((src.match(/=== 'gsc'/g) || []).length).toBe(3);
    expect((src.match(/gscWatchTick\(/g) || []).length).toBe(4);   // the declaration plus three doors
  });

  it('files through the browser\'s own Pulse client, with no courier', () => {
    const fn = src.slice(src.indexOf('async function gscWatchTick'));
    expect(fn).toMatch(/require\('\.\/pulse'\)/);
    expect(fn).toMatch(/recordGscHealth\(app, findings\)/);
    /* Read back, never assumed: our own 200 is not evidence the row is in Pulse. */
    expect(fn.slice(0, fn.indexOf('log.info'))).toMatch(/gscHealth\(app\)/);
  });

  it('records the pass, so the watcher card does not read as never run', () => {
    const fn = src.slice(src.indexOf('async function gscWatchTick'), src.indexOf('async function gscWatchTick') + 4000);
    expect(fn).toMatch(/recordRolePass\(wf, startedAt, run\)/);
  });

  /* The scheduler stubs a run for the modes that do not drive a flow. This one drives, so a stub here
     would make scheduleDue() count one pass twice. */
  it('does not stub a run in the scheduler, because drive() persists its own', () => {
    const at = src.indexOf("=== 'gsc') {", src.indexOf('[workflow-sched] firing'));
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, at + 400);
    expect(branch).not.toMatch(/persistRun/);
    expect(branch).toMatch(/gscWatchTick\(wf, owner\)/);
  });
});
