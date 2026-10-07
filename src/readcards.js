'use strict';
/**
 * readcards.js — route cards for READING, learned from what the UI walk showed.
 *
 * The write cards in routecards.js replay an ACT (a post, a create) and refuse to learn anything
 * else: reads are "not the acts we replay", and a card with no auth token is thrown away. That left
 * the commonest job a browser has — read a list off a page — with no fast path, and every open,
 * no-login site with none at all.
 *
 * A read is the one thing that can be proven for free. Nothing is created, so nothing is destroyed
 * by trying it twice, and the UI walk that just ran is a BASELINE to compare against: it read some
 * rows off the screen; the card is the request whose response contains those same rows. That is how
 * the right request is chosen out of the dozen a page fires (suggest-as-you-type, telemetry,
 * feature flags, the real search) — by what it returned, not by guessing from its URL.
 *
 *   LEARN   the UI walk's rows + every JSON response the page fetched  →  the request that holds the
 *           rows, the query parameters that carried the walk's inputs (slots), and where in the JSON
 *           each column lives (extract).
 *   REPLAY  one in-page fetch with the slots filled, then the same extract applied to the answer.
 *   VERIFY  the replayed rows must EQUAL what a UI walk reads for the same inputs. A 200 is not
 *           enough: a site that renames a field answers 200 with the wrong data, which is the
 *           silent failure this whole mechanism exists to prevent. Wrong shape → quarantine → UI.
 *
 * PURE: no Playwright, no fs, no network. Like routecards.js, a card holds shapes, never values it
 * did not need: the example URL carries the walk's query text, but no token or cookie value.
 */

const routecards = require('./routecards');

const MAX_JSON_BYTES = 1500000;   // a response bigger than this is not a list a card should replay
const MIN_COVERAGE = 0.8;         // how much of what the UI showed the response must contain

const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** Is this request a page's own data fetch? A GET made by fetch()/XHR, not an asset or a beacon. */
function isReadCandidate(req) {
  if (!req || !req.url) return false;
  if (String(req.method || 'GET').toUpperCase() !== 'GET') return false;
  const rt = String(req.resourceType || '').toLowerCase();
  if (rt !== 'xhr' && rt !== 'fetch') return false;          // no resource type = unknown = not learned
  if (routecards.IGNORE_EXT.test(req.url) || routecards.IGNORE_HOST.test(req.url)) return false;
  return true;
}

/** Read a dotted path out of a value. `a.b` and `a.0.b` both work; a miss is undefined, never a throw. */
function getPath(obj, p) {
  if (p === '' || p == null) return obj;
  let cur = obj;
  for (const k of String(p).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Every array-of-objects in a JSON value, with the dotted path that reaches it. */
function listsIn(json, base = '', depth = 0, out = []) {
  if (depth > 4 || json == null || typeof json !== 'object') return out;
  if (Array.isArray(json)) {
    if (json.length && json.every((x) => x && typeof x === 'object' && !Array.isArray(x))) out.push({ path: base, items: json });
    return out;
  }
  for (const k of Object.keys(json)) listsIn(json[k], base ? base + '.' + k : k, depth + 1, out);
  return out;
}

/** Scalar leaf paths of one object (one level of nesting is enough for a row). */
function leafPaths(obj, base = '', depth = 0, out = []) {
  if (obj == null || typeof obj !== 'object' || depth > 2) return out;
  for (const k of Object.keys(obj)) {
    const p = base ? base + '.' + k : k;
    const v = obj[k];
    if (v != null && typeof v === 'object') leafPaths(v, p, depth + 1, out);
    else out.push(p);
  }
  return out;
}

/**
 * Where in this JSON do the UI's rows live? `uiRows` is [{column: text}, …] exactly as the UI walk
 * read them. For each list in the response, each UI column is mapped to the field whose values
 * reproduce that column; the list that reproduces the most rows wins.
 *
 * Returns { listPath, fields:{column: fieldPath}, coverage } or null. coverage is the share of UI
 * rows found, in order and with every mapped column equal.
 */
function findExtract(json, uiRows) {
  if (!uiRows || !uiRows.length) return null;
  const columns = Object.keys(uiRows[0]);
  let best = null;
  for (const list of listsIn(json)) {
    const fields = {};
    for (const col of columns) {
      const want = uiRows.map((r) => norm(r[col])).filter(Boolean);
      if (!want.length) continue;
      const wantSet = new Set(want);
      let bestField = null; let bestHit = 0;
      for (const p of leafPaths(list.items[0])) {
        const have = list.items.map((it) => norm(getPath(it, p)));
        const hit = have.filter((h) => wantSet.has(h)).length;
        if (hit > bestHit) { bestHit = hit; bestField = p; }
      }
      if (bestField && bestHit / want.length >= MIN_COVERAGE) fields[col] = bestField;
    }
    if (!Object.keys(fields).length) continue;
    const got = applyExtract({ listPath: list.path, fields }, json);
    const cmp = compareRows(uiRows, got, Object.keys(fields));
    const score = cmp.coverage;
    if (!best || score > best.coverage || (score === best.coverage && Object.keys(fields).length > Object.keys(best.fields).length)) {
      best = { listPath: list.path, fields, coverage: score };
    }
  }
  return best;
}

/** Apply a card's extract to a response: the same rows the UI would have read. */
function applyExtract(extract, json) {
  if (!extract) return [];
  const list = getPath(json, extract.listPath);
  if (!Array.isArray(list)) return [];
  return list.map((it) => {
    const row = {};
    for (const [col, p] of Object.entries(extract.fields)) row[col] = norm(getPath(it, p));
    return row;
  });
}

/**
 * Do two row lists say the same thing? Compared on `columns` only (the ones both sides know),
 * after collapsing whitespace. `equal` is the strict verdict: same rows, same order. `coverage` is
 * the softer share of the baseline's rows that appear at the same position.
 */
function compareRows(baseline, replayed, columns) {
  const cols = columns || (baseline[0] ? Object.keys(baseline[0]) : []);
  const key = (r) => cols.map((c) => norm(r && r[c])).join('␟');
  const a = (baseline || []).map(key); const b = (replayed || []).map(key);
  let same = 0;
  for (let i = 0; i < a.length; i++) if (b[i] === a[i]) same++;
  const bSet = new Set(b);
  return {
    equal: a.length > 0 && a.length === b.length && same === a.length,
    coverage: a.length ? same / a.length : 0,
    missing: a.filter((x) => !bSet.has(x)).length,
    extra: b.length - a.length,
    baselineRows: a.length, replayRows: b.length,
  };
}

/**
 * Which query parameters carried the walk's inputs? `inputs` is {name: valueTyped}. A parameter whose
 * value equals (or, for a page that lowercases, case-insensitively equals) an input becomes a SLOT:
 * the card remembers `name ← param` and replay substitutes the new value there. Everything else in
 * the query string stays fixed in the example url, as the page sent it.
 */
function slotsFor(url, inputs = {}) {
  let u; try { u = new URL(url); } catch { return []; }
  const out = [];
  for (const [name, val] of Object.entries(inputs)) {
    for (const [param, pv] of u.searchParams.entries()) {
      if (norm(pv).toLowerCase() === norm(val).toLowerCase() && norm(val)) { out.push({ name, param }); break; }
    }
  }
  return out;
}

/**
 * DISTILL a read card. `candidates` are the page's own GETs with their parsed JSON answers:
 *   [{ method, url, status, headers, json }]
 * The card is the candidate whose answer reproduces the UI walk's rows best; below MIN_COVERAGE there
 * is no card (a request that only half explains the screen is not the request behind it).
 */
function distillRead({ intent, origin, candidates = [], uiRows = [], inputs = {}, now = 0 }) {
  if (!uiRows.length) return { ok: false, reason: 'the UI walk read no rows, so there is nothing to match a request against' };
  let pick = null;
  for (const c of candidates) {
    if (!c || c.json == null || (c.status && (c.status < 200 || c.status >= 300))) continue;
    if (origin && routecards.originOf(c.url) !== origin) continue;
    const ex = findExtract(c.json, uiRows);
    if (!ex || ex.coverage < MIN_COVERAGE) continue;
    const better = !pick || ex.coverage > pick.ex.coverage ||
      (ex.coverage === pick.ex.coverage && Object.keys(ex.fields).length > Object.keys(pick.ex.fields).length);
    if (better) pick = { c, ex };
  }
  if (!pick) return { ok: false, reason: 'no request the page made reproduces the rows the UI showed — walk the UI' };
  const shape = routecards.shapeOf({ method: 'GET', url: pick.c.url, headers: pick.c.headers || {} });
  const slots = slotsFor(pick.c.url, inputs);
  return {
    ok: true,
    coverage: pick.ex.coverage,
    card: {
      kind: 'read',
      intent, origin: shape.origin || origin,
      method: 'GET', url: pick.c.url,
      bodyKind: 'none', slots: slots.map((s) => s.name), urlSlots: slots,
      authAt: shape.authAt,                       // empty on an open site, and that is a valid read card
      auth: shape.authAt.length ? 'token' : 'none',
      extract: { listPath: pick.ex.listPath, fields: pick.ex.fields },
      columns: Object.keys(pick.ex.fields),
      confidence: 0, lastVerified: null, learnedAt: now, fails: 0, quarantined: false,
    },
  };
}

/** Build the in-page request for a read card. Null when a slot has no value (never send half a query). */
function buildReadReplay(card, values = {}) {
  if (!card || card.kind !== 'read' || !card.url) return null;
  let u; try { u = new URL(card.url); } catch { return null; }
  for (const s of card.urlSlots || []) {
    if (values[s.name] == null) return null;
    u.searchParams.set(s.param, String(values[s.name]));
  }
  return {
    url: u.toString(), method: 'GET', bodyKind: 'none', slots: [], authAt: card.authAt || [],
    values: {}, returnBody: true,
  };
}

/**
 * The verdict on one replayed answer. With a baseline, rows must EQUAL it. Without one (the steady
 * state, when nobody is walking the UI beside it), the answer must still have the card's SHAPE: the
 * list is there, it is non-empty, and every column the card promises is filled in. A renamed field
 * fails here instead of silently handing the caller empty strings.
 */
function judgeRead(card, { status, text }, baseline = null) {
  if (!(status >= 200 && status < 300)) return { ok: false, why: `the API answered ${status || 'nothing'}` };
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, why: 'the answer is no longer JSON' }; }
  const rows = applyExtract(card.extract, json);
  if (!rows.length) return { ok: false, rows, why: 'the list the card reads from is gone or empty' };
  const empty = card.columns.filter((c) => rows.every((r) => !r[c]));
  if (empty.length) return { ok: false, rows, why: `column(s) ${empty.join(', ')} came back empty — the API changed shape` };
  if (baseline) {
    const cmp = compareRows(baseline, rows, card.columns);
    if (!cmp.equal) return { ok: false, rows, cmp, why: `the rows differ from what the UI read (${cmp.missing} missing, ${cmp.extra} extra)` };
    return { ok: true, rows, cmp, why: 'the replayed rows equal the UI baseline' };
  }
  return { ok: true, rows, why: 'the answer has the card\'s shape' };
}

module.exports = {
  isReadCandidate, getPath, listsIn, findExtract, applyExtract, compareRows, slotsFor,
  distillRead, buildReadReplay, judgeRead, MIN_COVERAGE, MAX_JSON_BYTES,
};
