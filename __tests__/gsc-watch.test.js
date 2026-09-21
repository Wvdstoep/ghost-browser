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

  /*
   * THE FEED DOES THE SORTING, so the rank has to be in the field it sorts on. Sorting this array was
   * not enough: the feed re-sorts by urgency and then by firstSeen, every row lands in the same
   * millisecond, and one urgency for all of them broke the tie on insert order — reversed.
   */
  it('leads with the finding that makes every other number irrelevant', () => {
    const rows = gsc.feedRowsFor(findings, { property: PROPERTY });
    expect(rows[0].kind).toBe('manual_action');
  });

  it('ranks by urgency, which is what the feed orders on', () => {
    const rows = gsc.feedRowsFor(findings, { property: PROPERTY });
    const by = Object.fromEntries(rows.map((r) => [r.kind, r.urgency]));
    expect(by.manual_action).toBeGreaterThan(by.indexing);
    expect(by.indexing).toBeGreaterThan(by.sitemap);
    expect(gsc.urgencyFor('vitals')).toBe(1);
    expect(gsc.urgencyFor('weather')).toBe(1);
  });

  /* And under the status row, which is the one line that says whether any of this is current. */
  it('never outranks the Pulse status row', () => {
    const top = gsc.pulseRow({ app: 'my-app.engineer', read: 1, filed: {}, held: {} }).urgency;
    for (const r of gsc.feedRowsFor(findings, { property: PROPERTY })) expect(r.urgency).toBeLessThan(top);
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
    /* And the read-back happens BEFORE the status row is built, or the row would report our write. */
    expect(fn.slice(0, fn.indexOf('pulseRow('))).toMatch(/gscHealth\(app\)/);
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

/*
 * ONCE A DAY, WHATEVER THE INTERVAL SAYS.
 *
 * The watcher editor on the phone and the desktop offers minute intervals, because it was written for
 * notification watchers where every five minutes is the point. Saving a Search Console watcher from
 * that form -- to rename it, say -- rewrites `every: 'day'` into `every: 'minute'`, and nothing
 * downstream objects: the console then gets walked every few minutes by a model, on a signed-in
 * account, for numbers that move once a day. The floor lives in the pass, where no edit reaches it.
 */
describe('how often it may read Google', () => {
  const now = Date.parse('2026-09-21T18:00:00Z');
  const hoursAgo = (h) => ({ lastPass: { startedAt: now - h * 3600 * 1000 } });

  it('reads when it has never read', () => {
    expect(gsc.duePass({}, now).due).toBe(true);
    expect(gsc.duePass({ lastPass: {} }, now).due).toBe(true);
  });

  it('waits out the day even when the interval says minutes', () => {
    const r = gsc.duePass(hoursAgo(1), now);
    expect(r.due).toBe(false);
    expect(r.why).toMatch(/next read in \d+ min/);
  });

  it('reads again once the day has passed', () => {
    expect(gsc.duePass(hoursAgo(19), now).due).toBe(false);
    expect(gsc.duePass(hoursAgo(21), now).due).toBe(true);
  });

  /* Pressing Run IS the reason to cross it: somebody is asking for a reading now. */
  it('goes now when a person asked', () => {
    expect(gsc.duePass(hoursAgo(1), now, { force: true }).due).toBe(true);
  });

  it('lets the gap be set as data, without a deploy', () => {
    expect(gsc.duePass({ ...hoursAgo(2), minGapMs: 3600 * 1000 }, now).due).toBe(true);
    expect(gsc.MIN_GAP_MS).toBe(20 * 3600 * 1000);
  });

  it('is what the pass actually checks, before it spends anything', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
    const fn = src.slice(src.indexOf('async function gscWatchTick'));
    const guard = fn.indexOf('gscWatch.duePass(cfg');
    expect(guard).toBeGreaterThan(-1);
    /* Before the flow is driven, or it has already cost the walk it was meant to avoid. */
    expect(guard).toBeLessThan(fn.indexOf('workflows.drive('));
  });
});

/*
 * REPOINTING THE PROPERTY ORPHANS EVERY ROW THE OLD ONE MADE.
 *
 * my-app.engineer turned out to be a DOMAIN property (sc-domain:my-app.engineer, verified by a DNS TXT
 * record); the URL-prefix form https://my-app.engineer/ was never verified, because the site serves no
 * verification meta tag. Pointed at the wrong form the console answered "Je hebt geen toegang tot deze
 * property" six times and the walk filed that, correctly, as what it saw. A row is keyed on the tab it
 * came from and that tab carries the property, so the new pass creates new rows and cannot reach the
 * old ones: the page would show the true state of the property beside six rows denying we have access.
 */
describe('rows left behind by a property change', () => {
  const OLD = 'https://my-app.engineer/';
  const NEW = 'sc-domain:my-app.engineer';
  const rowsFor = (prop) => gsc.feedRowsFor([
    { kind: 'indexing', label: 'property access', value: 'Je hebt geen toegang tot deze property' },
    { kind: 'sitemap', label: 'property access', value: 'Je hebt geen toegang tot deze property' },
  ], { property: prop }).map((r, i) => ({ ...r, key: 'k' + i, handled: false }));

  it('retires what the current property cannot be reading', () => {
    const stale = gsc.staleRows(rowsFor(OLD), NEW);
    expect(stale).toHaveLength(2);
    expect(stale.every((r) => r.url.includes(encodeURIComponent(OLD)))).toBe(true);
  });

  it("leaves this property’s own rows alone", () => {
    expect(gsc.staleRows(rowsFor(NEW), NEW)).toEqual([]);
  });

  /* The status row has no url at all, and it is the one row that must never be retired. */
  it('never touches the status row', () => {
    const status = { ...gsc.pulseRow({ app: 'my-app.engineer', read: 1, filed: {}, held: {} }), key: 'p', handled: false };
    expect(gsc.staleRows([status], NEW)).toEqual([]);
  });

  it('leaves anything that is not a console tab alone', () => {
    const other = { key: 'x', url: 'https://useme.com/pl/jobs/foo,12345/', title: 'a gig', handled: false };
    expect(gsc.staleRows([other], NEW)).toEqual([]);
  });

  it('does not re-retire what is already handled', () => {
    const done = rowsFor(OLD).map((r) => ({ ...r, handled: true }));
    expect(gsc.staleRows(done, NEW)).toEqual([]);
  });

  it("is what the pass does, before it writes today’s rows", () => {
    const src = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
    const fn = src.slice(src.indexOf('async function gscWatchTick'));
    const retire = fn.indexOf('gscWatch.staleRows(');
    expect(retire).toBeGreaterThan(-1);
    expect(retire).toBeLessThan(fn.indexOf('gscWatch.feedRowsFor('));
    expect(fn.slice(retire - 300, retire + 300)).toMatch(/markHandled/);
  });
});
