/*
 * PULSE, FROM THE BROWSER — so a walk that reads a console can file what it read, with no courier.
 *
 * Until now the chain was: the browser reads Search Console and stores findings on the job, the
 * master polls the job and forwards them to Pulse. Three services and a poll for a fact that was
 * already in hand, and the middle one was the single point of failure: a locked-out walk spent the
 * master's whole daily audit slot, and nothing reached Pulse for eleven days.
 *
 * WIRED BY THE PLATFORM, NOT BY HAND. The provisioner injects PULSE_OPS_URL and PULSE_REPORTER_KEY
 * from the catalog's `consumes` — the same path that wires the master and Herald. Two details worth
 * knowing:
 *
 *   It is NOT the app key. GB is also registered as an app in Pulse (PULSE_APP_KEY) and Pulse
 *   refuses an app key at the operator door on purpose: "a built app can report, never read." The
 *   reporter key is a different credential for a different door.
 *
 *   It is NOT PULSE_URL either. That name belongs to the app wiring and, on this cluster, points at
 *   a service that does not resolve. PULSE_OPS_URL is wired from the provider's own service.
 *
 * NOTHING HERE THROWS UPWARD. A watcher's job is to read the console and show what it read; filing
 * is the second half. If Pulse is unconnected, unreachable or refuses the key, the walk still
 * happened and the findings are still worth showing, so every call answers with what happened
 * instead of failing the pass. "Filed" and "collected" are different facts and the caller gets both.
 */
'use strict';

const OPS_PATH = '/v1/ops/';

/** The operator door, or '' when the platform has not wired one. PULSE_URL is deliberately last. */
function opsUrl(env = process.env) {
  const u = String(env.PULSE_OPS_URL || env.PULSE_URL || '').trim().replace(/\/+$/, '');
  return u;
}

function opsKey(env = process.env) {
  return String(env.PULSE_REPORTER_KEY || '').trim();
}

/** Can we file at all? Both halves or neither — a URL with no key is a 401 waiting to happen. */
function wired(env = process.env) {
  return !!(opsUrl(env) && opsKey(env));
}

/** Why not, in words a person can act on rather than a silent false. */
function why(env = process.env) {
  if (!opsUrl(env) && !opsKey(env)) return 'Pulse is not connected to this browser';
  if (!opsUrl(env)) return 'Pulse has a key but no address (PULSE_OPS_URL is unset)';
  if (!opsKey(env)) return 'Pulse has an address but no reporter key (PULSE_REPORTER_KEY is unset)';
  return '';
}

/*
 * The row shape Pulse stores, and the clamps it applies anyway. Done here too so a caller can see
 * what will be dropped BEFORE it is dropped: a finding with no kind or no label is not stored, and
 * silently sending one and reporting success would make "filed 6" mean nothing.
 */
const KINDS = new Set(['message', 'indexing', 'sitemap', 'manual_action', 'vitals']);

function rowsFor(findings) {
  const out = [];
  for (const f of findings || []) {
    if (!f) continue;
    const kind = String(f.kind || '').trim();
    const label = String(f.label || '').trim();
    if (!kind || !label) continue;          // Pulse skips these; so do we, and we say how many
    out.push({
      kind: KINDS.has(kind) ? kind : 'indexing',
      label: label.slice(0, 200),
      value: String(f.value == null ? '' : f.value).slice(0, 200),
      detail: String(f.detail || '').slice(0, 600),
    });
  }
  return out;
}

/** Today, as Pulse insists on seeing it. A bad day string is a 400, not a stored row. */
const today = (d = new Date()) => d.toISOString().slice(0, 10);

async function call(name, args, opts = {}) {
  const env = opts.env || process.env;
  const fetchFn = opts.fetch || global.fetch;
  if (!wired(env)) return { ok: false, wired: false, why: why(env) };
  try {
    const r = await fetchFn(opsUrl(env) + OPS_PATH + name, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + opsKey(env) },
      body: JSON.stringify(args || {}),
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
    if (!r.ok) return { ok: false, wired: true, status: r.status, why: (body && body.error) || ('pulse said ' + r.status) };
    /*
     * THE OPERATOR DOOR WRAPS ITS ANSWER: { ok, operation, effect, result }. Read flat, every call
     * succeeds and reports nothing — zero findings from a store holding six, presented as "Pulse holds
     * nothing yet". The envelope is kept beside it for anything that wants the operation's own words.
     */
    const payload = (body && typeof body === 'object' && 'result' in body) ? body.result : body;
    return { ok: true, wired: true, status: r.status, body: payload, envelope: body };
  } catch (e) {
    /* Unreachable is not the same as refused, and the sentence should say which. */
    return { ok: false, wired: true, why: 'could not reach Pulse: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * File what a Search Console walk read. Returns { ok, filed, skipped, why } — `skipped` is the
 * findings Pulse would have dropped, counted here so "filed" is a number that means something.
 */
async function recordGscHealth(app, findings, opts = {}) {
  const rows = rowsFor(findings);
  const skipped = (findings || []).length - rows.length;
  if (!rows.length) return { ok: false, wired: wired(opts.env || process.env), filed: 0, skipped, why: 'nothing worth filing' };
  const day = opts.day || today();
  const r = await call('record_gsc_health', { app, day, findings: rows }, opts);
  if (!r.ok) return { ...r, filed: 0, skipped };
  return { ok: true, wired: true, filed: Number((r.body && r.body.saved) || 0), skipped, day, app };
}

/**
 * What Pulse holds now — the answer to "is Pulse up to date?", which is the only way to show that
 * honestly. Reading it back beats trusting our own last write: a write that 200'd and a store that
 * has the row are different claims.
 */
async function gscHealth(app, opts = {}) {
  const r = await call('gsc_health', { app, days: opts.days || 30 }, opts);
  if (!r.ok) return { ...r, findings: [], latestDay: null };
  const findings = Array.isArray(r.body && r.body.findings) ? r.body.findings : [];
  const days = findings.map((f) => String(f.day || '')).filter(Boolean).sort();
  return { ok: true, wired: true, findings, latestDay: days.length ? days[days.length - 1] : null };
}

/** Up to date means Pulse holds a reading from today. Pure, so the rule is testable. */
function upToDate(latestDay, now = new Date()) {
  return !!latestDay && latestDay === today(now);
}

module.exports = { opsUrl, opsKey, wired, why, rowsFor, today, recordGscHealth, gscHealth, upToDate, KINDS };
