/*
 * A SEARCH CONSOLE WATCHER — the browser reads the console, files it to Pulse, and shows what it read.
 *
 * This used to be three services and a poll. The master held a daily audit slot, dispatched a walk to
 * the browser, polled the job for its findings and forwarded them to Pulse. Every part of that could
 * only be seen from inside the master, and when a walk landed on a signed-out account the slot was
 * spent: nothing reached Pulse for eleven days while the screen still showed a reading from the 10th
 * as though it were current.
 *
 * The browser is the only thing here that can actually see the console, so it does the whole job: read,
 * file, show. It joins the watcher list as a watcher like any other and its results page carries no
 * buttons, because there is nothing to approve — every walk it runs is read-only by role.
 *
 * WHAT IT SHOWS. One row per finding, keyed on the console tab plus the row's own name, so the second
 * pass UPDATES "not indexed — 12" instead of adding a second one. Plus one status row, pinned to the
 * top, that says whether Pulse holds today's reading — read back from Pulse rather than assumed from
 * our own write, because a write that returned 200 and a store that has the row are different claims.
 *
 * Everything here is pure: the tick in server.js does the browser work and the filing, and hands the
 * results to these functions. That is what makes the freshness rule, the dedupe key and the row
 * shaping testable without a console, a Chromium or a Pulse.
 */
'use strict';

/*
 * EVERY TAB OF THE CONSOLE HAS AN ADDRESS, AND NONE OF THEM NEEDS FINDING.
 *
 * The first version of this walk was told to "go through the console — messages, manual actions, page
 * indexing, sitemaps, Core Web Vitals". Every clause there is a click, and the console renders in
 * whatever language the account uses: the walk opened 21 pages, read 15, was stopped at 142 steps,
 * and the tabs it never reached were simply never read. Handed addresses instead of directions, the
 * same walk reads six tabs in about eighteen steps.
 */
const CONSOLE_TABS = (property) => {
  const at = (path) => `https://search.google.com/search-console/${path}?resource_id=${encodeURIComponent(property || '')}`;
  return [
    { key: 'indexing', label: 'Pages — indexed, not indexed, and why', url: at('index') },
    { key: 'sitemap', label: 'Sitemaps — what was submitted and what Google made of it', url: at('sitemaps') },
    { key: 'manual_action', label: 'Manual actions — a penalty makes every other number irrelevant', url: at('manual-actions') },
    { key: 'security', label: 'Security issues', url: at('security-issues') },
    /*
     * MESSAGES ARE ACCOUNT-WIDE, NOT PROPERTY-SCOPED — which the audit found out for itself. Given the
     * same ?resource_id= as every other tab it answered "404 — pagina niet gevonden", and the walk
     * recorded that and moved on exactly as instructed. That is the design working: a wrong address
     * costs one tab and reports itself, instead of a walk wandering off and losing the other five.
     */
    { key: 'message', label: 'Messages Google has written to us (account-wide, not per property)',
      url: 'https://search.google.com/search-console/messages' },
    { key: 'vitals', label: 'Core Web Vitals', url: at('core-web-vitals') },
  ];
};

/** Which tab a finding came from, so a row can link back to the screen it was read on. */
function tabFor(kind, property) {
  const k = String(kind || '').trim();
  const tabs = CONSOLE_TABS(property);
  const hit = tabs.find((t) => t.key === k);
  return hit || tabs.find((t) => t.key === 'indexing');
}

/** The goal the walk is handed. The discipline lives in the gsc.audit role; this carries the addresses. */
function auditGoal({ app, property }) {
  const tabs = CONSOLE_TABS(property);
  return `Read the STATE of our own Search Console property for "${app}". Read-only: you never add, remove, verify, request or change anything.

PROPERTY: ${property}

OPEN THESE SIX ADDRESSES IN TURN. Each one IS a tab of the console — do not look for a menu, and do not click your way between them. This console renders in the account's own language, so the labels are not the words you expect, and hunting for them is how a ten-minute read becomes a hundred and forty steps that ends without reading half of it.

${tabs.map((t, i) => `${i + 1}. ${t.label}\n   ${t.url}`).join('\n')}

At each one: call read_table for the numbers, and read for anything the table does not carry. Then call save_gsc_health once per finding, with the label and value EXACTLY as the page shows them — never rounded, never translated, never summarised into one. A page that says nothing is a finding too: record that it was clean.

If an address does not open, or shows a screen you do not recognise, say which one and move to the next. Six tabs read is a whole audit; five tabs and a search for the sixth is neither.

You are not here for the Performance numbers — another walk reads those. You are here for whether our pages are getting in at all, and what Google says is stopping them.`;
}

/** The jobs a run's steps produced, in order. makeRunAgent puts the id on each step's output. */
function jobIdsOf(run) {
  const out = [];
  for (const st of (run && run.steps) || []) {
    const id = st && st.output && st.output.__jobId;
    if (id && !out.includes(id)) out.push(String(id));
  }
  return out;
}

/*
 * WHAT THE WALK WROTE DOWN. save_gsc_health accumulates findings on the job as they are read, so they
 * survive a walk that gets stopped halfway — and this is where they are collected back out.
 *
 * Deduped on kind + label, LAST WINS: a walk that re-reads a tab and sees the count move from 11 to 12
 * should report 12, not both. A finding with no kind or no label is dropped here rather than at Pulse,
 * so the count this hands back is the count that will be filed.
 */
function findingsOf(run, getJob, opts = {}) {
  const cap = Number(opts.max) || 200;
  const byKey = new Map();
  for (const id of jobIdsOf(run)) {
    let job = null;
    try { job = getJob(id); } catch { job = null; }
    for (const f of (job && job.gscHealth) || []) {
      if (!f) continue;
      const kind = String(f.kind || '').trim();
      const label = String(f.label || '').trim();
      if (!kind || !label) continue;
      byKey.set(kind + '|' + label.toLowerCase(), {
        kind, label,
        value: String(f.value == null ? '' : f.value).trim(),
        detail: String(f.detail || '').trim(),
      });
    }
  }
  return [...byKey.values()].slice(0, cap);
}

/*
 * WHAT MATTERS MOST, FIRST. A manual action makes every other number on the page irrelevant, so it
 * leads; then what Google has written to us; then whether our pages are getting in, and why not.
 *
 * This is expressed as URGENCY because that is the field the feed sorts on. Sorting the array alone
 * was not enough: the feed re-sorts what it holds, every row here arrives in the same millisecond, and
 * with one urgency for all of them the tie broke on firstSeen — giving exactly the reverse of this
 * order. The status row sits above all of it at 9.
 */
const KIND_ORDER = ['manual_action', 'message', 'indexing', 'sitemap', 'vitals'];
const urgencyFor = (kind) => {
  const at = KIND_ORDER.indexOf(String(kind || ''));
  return at < 0 ? 1 : KIND_ORDER.length - at;        // manual_action 5 … vitals 1, unknown 1
};

/**
 * One read-only feed row per finding. The KEY the feed derives from url + title must be stable across
 * passes, so the title is the row's own name and the changing number lives in the fields — a title
 * carrying the value would make every pass a new row and the page would fill with history.
 */
function feedRowsFor(findings, opts = {}) {
  const property = opts.property || '';
  const rows = (findings || []).map((f) => {
    const tab = tabFor(f.kind, property);
    const fields = { kind: f.kind, value: f.value || '(nothing shown)' };
    if (f.detail) fields.detail = f.detail;
    fields.read = 'read-only — nothing here is acted on';
    return { title: f.label, fields, url: tab.url, kind: f.kind, draft: '', readOnly: true, urgency: urgencyFor(f.kind) };
  });
  return rows.sort((a, b) => {
    const ai = KIND_ORDER.indexOf(a.kind); const bi = KIND_ORDER.indexOf(b.kind);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || String(a.title).localeCompare(String(b.title));
  });
}

/*
 * ROWS THAT CAN NO LONGER BE READ. A feed row is keyed on the console tab it came from, and that tab
 * carries the property — so changing the property (my-app.engineer turned out to be a DOMAIN property,
 * sc-domain:my-app.engineer, where the URL-prefix form was never verified) orphans every row the old
 * one produced. The new pass cannot reach them, and the page ends up showing the true state of the
 * property beside six rows insisting we have no access to it.
 *
 * So a pass retires them: handled, not deleted. Each was a true reading of something once.
 *
 * Deliberately narrow. Only a row whose url is a Search Console tab for a DIFFERENT property
 * qualifies: the status row (no url) and anything else in the feed are left alone.
 */
function staleRows(items, property) {
  const mine = new Set(CONSOLE_TABS(property).map((t) => t.url));
  return (items || []).filter((it) => {
    if (!it || it.handled) return false;
    const url = String(it.url || '');
    if (!/^https:\/\/search\.google\.com\/search-console\//.test(url)) return false;
    return !mine.has(url);
  });
}

/** Up to date means Pulse holds a reading from today. Pure, so the rule is testable. */
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
function upToDate(latestDay, now = new Date()) {
  return !!latestDay && String(latestDay) === dayOf(now);
}

/** How stale, in whole days, for a sentence a person can act on ("11 days old" beats "stale"). */
function daysBehind(latestDay, now = new Date()) {
  if (!latestDay) return null;
  const a = Date.parse(String(latestDay) + 'T00:00:00Z');
  if (!Number.isFinite(a)) return null;
  return Math.max(0, Math.round((Date.parse(dayOf(now) + 'T00:00:00Z') - a) / 86400000));
}

/*
 * THE STATUS ROW — "is Pulse up to date?", pinned to the top of the results.
 *
 * Its title never changes, because the feed keys a row on its title: a title carrying today's date
 * would leave one dead status row behind per pass. The answer lives in the fields, and it is the
 * answer PULSE gave when read back, never our own write. Eleven days of a stale reading displayed as
 * current is the exact failure this row exists to make impossible.
 */
const PULSE_TITLE = 'Search Console → Pulse';

function pulseRow(opts = {}) {
  const now = opts.now || new Date();
  const filed = opts.filed || {};
  const held = opts.held || {};
  const app = String(opts.app || '');
  const read = Number(opts.read) || 0;
  const fresh = upToDate(held.latestDay, now);
  const behind = daysBehind(held.latestDay, now);

  const state = !app ? 'no app named'
    : (!filed.wired && !held.wired) ? 'Pulse is not connected'
      : !held.ok ? 'could not read Pulse back'
        : fresh ? 'up to date' : (held.latestDay ? 'behind' : 'nothing filed yet');

  const fields = { pulse: state };
  fields['read this pass'] = read ? `${read} finding${read === 1 ? '' : 's'}` : 'nothing read — see the walk';
  if (filed.filed) fields['filed now'] = `${filed.filed} finding${filed.filed === 1 ? '' : 's'}`;
  if (filed.skipped) fields['not filed'] = `${filed.skipped} had no name to file under`;
  if (held.latestDay) fields['pulse holds'] = fresh ? `${held.latestDay} (today)` : `${held.latestDay} — ${behind} day${behind === 1 ? '' : 's'} old`;
  if (app) fields.app = app;
  /* WHY, in words, whenever the answer is not simply yes. A silent "behind" sends somebody hunting. */
  const why = String(filed.why || held.why || '');
  if (!fresh && why) fields.why = why.slice(0, 300);

  return {
    title: PULSE_TITLE,
    fields,
    url: '',
    kind: 'pulse',
    draft: '',
    readOnly: true,
    /* Above every finding: it is the one row that says whether the rest can be trusted as current. */
    urgency: 9,
  };
}

/*
 * HOW OFTEN THIS MAY READ GOOGLE, which is NOT what the watcher's interval says.
 *
 * The watcher editor on the phone and the desktop offers minute intervals, because it was written for
 * notification watchers where every five minutes is the point. Saving a Search Console watcher from
 * that form — to rename it, say — rewrites `every: 'day'` into `every: 'minute'`, and nothing
 * downstream would object: the console would be walked every few minutes by a model, on a signed-in
 * account, for numbers that move once a day.
 *
 * So the floor lives here, where no edit reaches it. A hand-started run says force and goes now.
 */
const MIN_GAP_MS = 20 * 3600 * 1000;

function duePass(cfg = {}, now = Date.now(), opts = {}) {
  if (opts.force) return { due: true };
  const gap = Number(cfg.minGapMs) || MIN_GAP_MS;
  const last = Number((cfg.lastPass || {}).startedAt) || 0;
  if (!last) return { due: true };                       // never read — read now
  const since = Number(now) - last;
  if (since >= gap) return { due: true };
  const mins = Math.max(1, Math.round((gap - since) / 60000));
  return { due: false, why: `the console was read ${Math.round(since / 60000)} min ago; next read in ${mins} min` };
}

module.exports = {
  CONSOLE_TABS, tabFor, auditGoal, jobIdsOf, findingsOf, feedRowsFor,
  pulseRow, PULSE_TITLE, upToDate, daysBehind, KIND_ORDER, urgencyFor, duePass, MIN_GAP_MS, staleRows,
};
