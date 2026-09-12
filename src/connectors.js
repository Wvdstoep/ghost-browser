'use strict';
/**
 * connectors.js — external APIs the OWNER connects, as DATA (not code).
 *
 * THE PROBLEM THIS ENDS. A tool that talks to a customer's own system — their vector database, their
 * CRM, their knowledge base — used to mean a code change, a build and a deploy for every customer.
 * But a connection is not code: it is a name, a base URL, an API key, and which paths to call. So the
 * owner authors those here as DATA, and the GENERIC tools (knowledge_query / knowledge_store) resolve
 * a named connector at call time. A new customer is a new connector row — no code, no build, no
 * deploy. Same idea as roles-as-data and profiles-as-data, for integrations.
 *
 * Persisted on the profile volume so a connector survives a restart, like roles/profiles/jobs.
 * The API key is stored here and returned to the in-process tool via get(); list()/redacted() never
 * expose it.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.PROFILE_DIR || '/profiles';
const FILE = path.join(DIR, 'connectors.json');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function baseOf(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const p = new URL(u); return (p.origin + p.pathname).replace(/\/$/, ''); } catch { return ''; }
}

function load() {
  try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function persist(list) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 }); }
  catch { /* still usable in-process */ }
}
function freeKey(label, existing) {
  const base = slug(label) || 'connector';
  let key = base, n = 1;
  while (existing.some((x) => x.key === key)) key = base + (++n);
  return key;
}

/** Create/author a connector. { label, baseUrl, apiKey?, kind?, queryPath?, storePath? } → the row. */
function create(input = {}) {
  const list = load();
  const label = String(input.label || input.name || '').trim() || 'Connector';
  const baseUrl = baseOf(input.baseUrl || input.url);
  if (!baseUrl) throw Object.assign(new Error('a base URL is required'), { status: 400 });
  const row = {
    key: input.key && !list.some((x) => x.key === input.key) ? input.key : freeKey(label, list),
    label,
    baseUrl,
    apiKey: input.apiKey ? String(input.apiKey) : null,
    kind: input.kind || 'knowledge',
    queryPath: input.queryPath || '/query',
    storePath: input.storePath || '/ingest',
    createdAt: new Date().toISOString(),
  };
  list.push(row);
  persist(list);
  return redactedOne(row);
}

/** Full row INCLUDING the key — for the in-process tool only. Null if absent. */
function get(key) {
  return load().find((x) => x.key === key) || null;
}

const redactedOne = (r) => r && ({ key: r.key, label: r.label, baseUrl: r.baseUrl, kind: r.kind, queryPath: r.queryPath, storePath: r.storePath, hasKey: !!r.apiKey, createdAt: r.createdAt });
/** Everyone-safe list — never the key. */
function list() { return load().map(redactedOne); }

function remove(key) {
  const before = load();
  const after = before.filter((x) => x.key !== key);
  persist(after);
  return before.length !== after.length;
}

module.exports = { create, get, list, remove, FILE };
