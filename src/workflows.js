'use strict';
/**
 * workflows.js — automations as data, and the engine that runs them.
 *
 * A workflow is a small graph the owner draws on the Automation canvas: a trigger, then a line of
 * steps. Each AGENT step runs one role on one profile with a goal; its findings become the step's
 * OUTPUT, and the next step's goal can reference that output with {{…}}. That handoff — one step
 * feeding the next — is the whole point, and it is why this file has two halves:
 *
 *   1. THE STORE. One JSON file per workflow on the same /profiles volume the roles and profiles
 *      already persist to. Runs are journalled the same way, so "what happened last night" survives
 *      a restart exactly like a job's leads do.
 *   2. THE ENGINE. `drive()` walks the steps in order, keeping a CONTEXT bag of every step's output,
 *      templating each goal against it, and calling an injected `runAgent` for the browser work. The
 *      injection is deliberate: the orchestration — order, templating, the context, the run journal —
 *      is pure and unit-tested, while the one piece that needs a real browser and model is handed in.
 *
 * SAFE BY CONSTRUCTION. Everything here is additive and isolated: a workflow run dispatches ordinary
 * agent jobs through the machinery that already exists, on the profile A2 would pick, through the act
 * gate that already governs it. A broken workflow fails its own run and touches nothing else.
 *
 * P1 (this file) covers a LINE: trigger → agent → agent, plus `store` steps for stashing a value.
 * Branch / filter / for-each / human-approval / schedule are P2–P3 and slot in as new node types.
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.PROFILE_DIR || '/profiles';
const DIR = path.join(BASE, 'workflows');
const RUNDIR = path.join(BASE, 'workflow-runs');
/* `verify` opens a URL in a profile and answers whether a phrase is on the page — deterministic,
   no model. It is the check that caught the false "replied", placed as a step. */
/* `check-login` opens a page in a profile and answers whether we are signed in — no model, and no
   language, so it holds on every platform. A signed-out profile is a fact worth knowing BEFORE a
   walk spends a browser session discovering it. */
/*
 * `fetch` and `extract` carry NO MODEL. Every reading step used to be an `agent` step, and the
 * model is what a run costs: one build spent 2.97M tokens and produced nothing, four of them
 * exhausted a weekly allowance, and the master cannot think at all without one. A listing is not a
 * judgement — it is a request and a pattern — so reading it should cost nothing, every day, forever.
 */
const NODE_TYPES = ['trigger', 'agent', 'store', 'filter', 'branch', 'collect', 'verify', 'check-login', 'fetch', 'extract', 'script'];
const FILTER_OPS = ['exists', 'contains', 'eq', 'gt', 'lt'];

function ensure(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* first write surfaces it */ } }
const file = (dir, id) => path.join(dir, `${id}.json`);

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// ── the store ────────────────────────────────────────────────────────────────────────────────────
function read(id) { try { return JSON.parse(fs.readFileSync(file(DIR, String(id)), 'utf8')); } catch { return null; } }

function all() {
  ensure(DIR);
  let names; try { names = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  return names.map((f) => read(f.replace(/\.json$/, ''))).filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function uniqueId(name, keep) {
  const base = slug(name) || 'workflow';
  let id = base, n = 2;
  while (read(id) && id !== keep) { id = `${base}-${n}`; n += 1; }
  return id;
}

/**
 * Is this a workflow we will store and run? `roleNames` is the set of real role names (built-in +
 * user), passed in so an agent step cannot name a role that does not exist. Returns plain-language
 * problems; empty means good.
 */
function validate(wf, roleNames) {
  const errs = [];
  if (String(wf && wf.name || '').trim().length < 3) errs.push('a name of at least 3 characters');
  const nodes = Array.isArray(wf && wf.nodes) ? wf.nodes : null;
  if (!nodes || !nodes.length) errs.push('at least one step');
  if (nodes) {
    const ids = new Set(nodes.map((n) => n && n.id));
    if (!nodes.some((n) => n && n.type === 'trigger')) errs.push('a trigger to start it');
    for (const n of nodes) {
      if (!n || !n.id) { errs.push('every step needs an id'); continue; }
      if (NODE_TYPES.indexOf(n.type) < 0) { errs.push(`unknown step type "${n.type}"`); continue; }
      if (n.type === 'agent') {
        if (!String(n.goal || '').trim()) errs.push(`the step "${n.label || n.id}" needs a goal`);
        /* A templated role is decided at run time, so it cannot be checked here — see the run-time
           resolution in runNode. Everything else is still checked against the real list. */
        if (Array.isArray(roleNames) && n.role && !/\{\{/.test(n.role) && roleNames.indexOf(n.role) < 0) errs.push(`the step "${n.label || n.id}" names a role that does not exist`);
      }
      if (n.type === 'store' && !String(n.key || '').trim()) errs.push(`a store step needs a key`);
      if (n.type === 'filter' && !String(n.inKey || '').trim()) errs.push(`the filter "${n.label || n.id}" needs a list to filter`);
      if (n.type === 'branch' && !String(n.inKey || '').trim()) errs.push(`the branch "${n.label || n.id}" needs something to test`);
      if (n.type === 'collect' && !String(n.inKey || '').trim()) errs.push(`the collect "${n.label || n.id}" needs a list to collect from`);
      if (n.type === 'verify') {
        if (!String(n.url || '').trim()) errs.push(`the verify step "${n.label || n.id}" needs a url to open`);
        if (!String(n.text || '').trim()) errs.push(`the verify step "${n.label || n.id}" needs the text to look for`);
      }
      if (n.type === 'check-login' && !String(n.url || '').trim()) errs.push(`the sign-in check "${n.label || n.id}" needs a url to open`);
      if (n.type === 'fetch' && !String(n.url || '').trim()) errs.push(`the fetch step "${n.label || n.id}" needs a url to get`);
      if (n.type === 'script') {
        if (!String(n.url || '').trim()) errs.push(`the script step "${n.label || n.id}" needs the url of the page to open`);
        if (!String(n.script || '').trim()) errs.push(`the script step "${n.label || n.id}" needs the script to run in that page`);
      }
      if (n.type === 'extract') {
        if (!String(n.inKey || '').trim()) errs.push(`the extract step "${n.label || n.id}" needs the text to read (inKey — usually the fetch step's outKey)`);
        if (!String(n.pattern || '').trim()) errs.push(`the extract step "${n.label || n.id}" needs a pattern`);
        else { try { new RegExp(n.pattern, 'g'); } catch (e) { errs.push(`the extract step "${n.label || n.id}" has a pattern that is not a valid expression: ${e.message}`); } }
      }
    }
    for (const e of (Array.isArray(wf.edges) ? wf.edges : [])) {
      if (!ids.has(e.from) || !ids.has(e.to)) errs.push('a connection points at a step that is not there');
    }
  }
  return errs;
}

function save(wf, roleNames) {
  ensure(DIR);
  const errs = validate(wf, roleNames);
  if (errs.length) { const e = new Error(`This automation still needs ${errs.join('; ')}.`); e.status = 400; throw e; }
  const existing = wf.id ? read(wf.id) : null;
  const id = existing ? wf.id : uniqueId(wf.name);
  const rec = {
    id,
    name: String(wf.name).trim().slice(0, 120),
    trigger: wf.trigger && typeof wf.trigger === 'object' ? wf.trigger : { type: 'manual' },
    nodes: (Array.isArray(wf.nodes) ? wf.nodes : []).slice(0, 100).map(cleanNode),
    edges: (Array.isArray(wf.edges) ? wf.edges : []).slice(0, 200).map((e) => (e.fromPort ? { from: e.from, to: e.to, fromPort: String(e.fromPort).slice(0, 10) } : { from: e.from, to: e.to })),
    /*
     * WHO SHIPPED IT. Blank for one the owner drew; an organ's name for one an organ registered and
     * reconciles by name at boot. The tab reads this to say where a flow came from, to say who
     * starts it rather than the misleading "manual", and to refuse a delete that would silently
     * stop the desk. Preserved across saves so editing a flow never orphans it from its organ.
     */
    owner: String((wf.owner != null ? wf.owner : (existing && existing.owner)) || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40),
    active: !!wf.active,
    autoApprove: !!wf.autoApprove,   // auto-send replies without a per-reply approval (paced)
    createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file(DIR, id), JSON.stringify(rec, null, 2), { mode: 0o600 });
  return rec;
}

function cleanNode(n) {
  const out = { id: String(n.id), type: n.type, label: String(n.label || '').slice(0, 80) };
  if (n.pos && typeof n.pos === 'object') out.pos = { x: Number(n.pos.x) || 0, y: Number(n.pos.y) || 0 };
  if (n.type === 'agent') {
    out.role = n.role ? String(n.role) : null;
    out.profile = n.profile ? String(n.profile) : null;   // null = pick from the role's platform
    out.goal = String(n.goal || '').slice(0, 8000);
    out.outKey = slug(n.outKey || n.label || n.id) || n.id;
    // for-each: run this step once per item in a list an earlier step produced. {{item}} is that item.
    if (n.forEach) out.forEach = String(n.forEach).slice(0, 120);
    // record: film this step. The driver auto-starts a screencast when the step begins and saves the
    // MP4 to the Files tab when it ends — a per-node toggle in the builder, no agent tools needed.
    if (n.record) out.record = true;
    /*
     * THE STEP'S OWN BUDGET. A reply is open, find the box, send, and a read is a feed and a few
     * posts; neither is a 120-step research walk, which is what a step got when nothing said
     * otherwise. 0 (or absent) keeps the browser's default, exactly as before.
     */
    if (Number(n.maxPages) > 0) out.maxPages = Math.min(200, Math.round(Number(n.maxPages)));
    if (Number(n.maxSteps) > 0) out.maxSteps = Math.min(300, Math.round(Number(n.maxSteps)));
    /*
     * THE REPLAY LETTER. A route card is the ENVELOPE: which url, which fields, and where the live
     * token sits. These are the fields that fill it for THIS run, templated exactly like a goal is —
     * so ONE card serves every repeat of the job with that repeat's own text, and a reply whose
     * wording differs each time is still one card rather than a new recording.
     *
     * Without this the agent's replay path read settings.replayValues, which nothing in the codebase
     * ever set, so even a trusted card came back null from buildReplay and every repeat paid for a
     * full model walk. A step with no values simply walks the UI, exactly as before.
     */
    if (n.values && typeof n.values === 'object' && !Array.isArray(n.values)) {
      const v = {};
      for (const k of Object.keys(n.values).slice(0, 40)) {
        v[String(k).slice(0, 120)] = String(n.values[k] == null ? '' : n.values[k]).slice(0, 4000);
      }
      if (Object.keys(v).length) out.values = v;
    }
  }
  if (n.type === 'check-login') {
    out.profile = n.profile ? String(n.profile) : null;
    out.url = String(n.url || '').slice(0, 2000);          // templated at run time
    out.outKey = slug(n.outKey || n.label || n.id) || n.id;
  }
  if (n.type === 'verify') {
    out.profile = n.profile ? String(n.profile) : null;
    out.url = String(n.url || '').slice(0, 2000);          // templated at run time
    out.text = String(n.text || '').slice(0, 4000);        // templated at run time
    out.outKey = slug(n.outKey || n.label || n.id) || n.id;
  }
  if (n.type === 'trigger') out.trigger = n.trigger && typeof n.trigger === 'object' ? n.trigger : { type: 'manual' };
  if (n.type === 'store') { out.key = slug(n.key) || 'value'; out.value = String(n.value || '').slice(0, 8000); }
  if (n.type === 'filter') {
    out.inKey = String(n.inKey || '').slice(0, 120);       // the list to keep from, e.g. collect.leads
    out.outKey = slug(n.outKey || n.label || n.id) || n.id;
    out.field = String(n.field || '').slice(0, 60);        // the field on each item to test (blank = the item itself)
    out.op = FILTER_OPS.indexOf(n.op) >= 0 ? n.op : 'exists';
    out.value = String(n.value || '').slice(0, 200);
  }
  if (n.type === 'branch') {
    // A yes/no gate: tests a value and sends the run down its 'true' or 'false' output.
    out.inKey = String(n.inKey || '').slice(0, 120);
    out.op = FILTER_OPS.indexOf(n.op) >= 0 ? n.op : 'exists';
    out.value = String(n.value || '').slice(0, 200);
  }
  if (n.type === 'fetch') {
    /* One address, in this browser's own session. GET only: a step that cannot act needs no gate. */
    out.url = String(n.url || '').slice(0, 2000);           // templated against the context, like a goal
    out.pick = String(n.pick || '').slice(0, 120);          // optional dot path into JSON
    out.outKey = slug(n.outKey || n.label || n.id) || n.id;
  }
  if (n.type === 'extract') {
    /* handled below */
  }
  if (n.type === 'script') {
    /*
     * ONE PAGE, ONE READ-ONLY SCRIPT, NO MODEL. The page is opened in the profile's real browser
     * (cookies, rendering, the lot), so a listing that answers a plain request with 403 still reads.
     * The script runs in the page and its value is the step's output. Held to the same refusal list
     * as the agent's run_script: it may read, never click, submit, fetch or navigate.
     */
    out.url = String(n.url || '').slice(0, 2000);           // templated against the context, like a goal
    out.profile = n.profile ? String(n.profile) : null;     // where the login lives; null = a throwaway
    out.script = String(n.script || '').slice(0, 8000);     // the same ceiling run_script has
    out.outKey = slug(n.outKey || n.label || n.id) || n.id;
  }
  if (n.type === 'extract') {
    /* One pattern over what an earlier step fetched. Named groups become the fields of each row. */
    out.inKey = String(n.inKey || '').slice(0, 120);        // usually the fetch step's outKey
    out.pattern = String(n.pattern || '').slice(0, 2000);
    out.flags = String(n.flags || 'gi').replace(/[^gimsuy]/g, '').slice(0, 6) || 'gi';
    out.limit = Math.min(500, Math.max(1, Math.round(Number(n.limit) || 50)));
    out.outKey = slug(n.outKey || n.label || n.id) || n.id;
  }
  if (n.type === 'collect') {
    // Map a list to a flat array by pulling one field from each item — the fan-out companion to
    // filter. A per-scene step produces {items:[{data:{clip}},…]}; collect turns it into [clip,clip,…]
    // so the next step (assemble) gets a clean ordered list instead of a wall of JSON.
    out.inKey = String(n.inKey || '').slice(0, 120);   // the list, e.g. clips.items
    out.field = String(n.field || '').slice(0, 80);    // the field on each item to pull (blank = the item)
    out.outKey = slug(n.outKey || n.label || n.id) || n.id;
  }
  return out;
}

function remove(id) { try { fs.unlinkSync(file(DIR, String(id))); return true; } catch { return false; } }

function exportPack(id) {
  const wf = read(id); if (!wf) return null;
  // A recipe, not a copy of an install: drop ids/timestamps/run state.
  return {
    kind: 'ghost-workflow', name: wf.name, trigger: wf.trigger, owner: wf.owner || undefined,
    nodes: wf.nodes, edges: wf.edges, exportedAt: new Date().toISOString(),
  };
}
function importPack(pack, roleNames) {
  if (!pack || pack.kind !== 'ghost-workflow') { const e = new Error('That is not a workflow.'); e.status = 400; throw e; }
  return save({ ...pack, id: null }, roleNames);
}

// ── the engine ─────────────────────────────────────────────────────────────────────────────────
/** The steps in the order they run: follow the edges from the trigger; fall back to array order. */
function order(wf) {
  const nodes = wf.nodes || [];
  const byId = {}; for (const n of nodes) byId[n.id] = n;
  const edges = wf.edges || [];
  const start = nodes.find((n) => n.type === 'trigger') || nodes[0];
  if (!start) return [];
  const seq = []; const seen = new Set();
  let cur = start;
  while (cur && !seen.has(cur.id)) {
    seq.push(cur); seen.add(cur.id);
    const next = edges.find((e) => e.from === cur.id);
    cur = next ? byId[next.to] : null;
  }
  // Anything not reached by an edge still runs, in array order, so a half-wired draft is not silent.
  for (const n of nodes) if (!seen.has(n.id)) seq.push(n);
  return seq;
}

const getPath = (obj, p) => String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Does one item pass a filter rule? `field` blank tests the item itself. Never throws. */
function filterMatch(item, field, op, value) {
  const v = field ? getPath(item, field) : item;
  switch (op) {
    case 'contains': return String(v == null ? '' : v).toLowerCase().indexOf(String(value).toLowerCase()) >= 0;
    case 'eq': return String(v) === String(value);
    case 'gt': return Number(v) > Number(value);
    case 'lt': return Number(v) < Number(value);
    case 'exists': default: return v != null && v !== '' && !(Array.isArray(v) && !v.length);
  }
}

/** A node with its role and profile filled in from the run — see the templating note in runNode. */
function resolveNode(node, context) {
  const role = node.role ? template(node.role, context) : node.role;
  const profile = node.profile ? template(node.profile, context) : node.profile;
  // The replay letter is filled from this run's own data, the same way the goal is.
  const values = node.values
    ? Object.fromEntries(Object.entries(node.values).map((e) => [e[0], template(e[1], context)]))
    : null;
  if (role === node.role && profile === node.profile && !values) return node;
  return { ...node, role: role || null, profile: profile || null, ...(values ? { values } : {}) };
}

/** Fill {{key}} / {{key.path}} from the run context. Objects become JSON so a goal can carry a list. */
function template(str, context) {
  return String(str == null ? '' : str).replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_m, p) => {
    const v = getPath(context, p.replace(/\[(\d+)\]/g, '.$1'));
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** A branch's yes/no on a single value (a list counts by length for gt/lt, by non-empty for exists). */
function condMatch(v, op, value) {
  switch (op) {
    case 'contains': return String(v == null ? '' : (Array.isArray(v) ? v.join(' ') : v)).toLowerCase().indexOf(String(value).toLowerCase()) >= 0;
    case 'eq': return String(v) === String(value);
    case 'gt': return Number(Array.isArray(v) ? v.length : v) > Number(value);
    case 'lt': return Number(Array.isArray(v) ? v.length : v) < Number(value);
    case 'exists': default: return Array.isArray(v) ? v.length > 0 : (v != null && v !== '');
  }
}

/**
 * Rebuild one finished step's contribution to the scheduler state when resuming an interrupted run.
 * Returns true if the node can count as done (its output fully restores what later steps read); false
 * means it must re-run. Mirrors exactly what runNode writes for each node type.
 */
function seedFromStep(node, st, context, branchOf) {
  const o = st.output;
  if (node.type === 'trigger') return true;
  if (node.type === 'store') { if (o && typeof o === 'object') { Object.assign(context, o); return true; } return false; }
  if (node.type === 'collect') { if (o && typeof o === 'object') { Object.assign(context, o); return true; } return false; }
  /* A fetch's BODY is deliberately not journalled (a feed is megabytes), so a resumed fetch re-runs
     — which is free and correct: the data may have moved on since the run was interrupted. */
  if (node.type === 'extract') { if (o && typeof o === 'object' && 'rows' in o) { context[node.id] = o; if (node.outKey && node.outKey !== node.id) context[node.outKey] = o; return true; } return false; }
  if (node.type === 'branch') { if (o && typeof o === 'object' && 'result' in o) { branchOf[node.id] = o.result; return true; } return false; }
  if (node.type === 'agent') { context[node.id] = o; if (node.outKey && node.outKey !== node.id) context[node.outKey] = o; return true; }
  if (node.type === 'verify') { if (o && typeof o === 'object' && 'found' in o) { context[node.id] = o; if (node.outKey && node.outKey !== node.id) context[node.outKey] = o; return true; } return false; }
  if (node.type === 'check-login') { if (o && typeof o === 'object' && 'signedIn' in o) { context[node.id] = o; if (node.outKey && node.outKey !== node.id) context[node.outKey] = o; return true; } return false; }
  return false;   // filter (kept list not persisted) and anything unknown → re-run
}

/**
 * Run a workflow — as a GRAPH, not just a line. Nodes run once every step they depend on has resolved
 * (finished or been ruled out); independent ready steps run IN PARALLEL, which is where a Reddit
 * branch and a Google branch end up on their two profiles at the same time (A2). A `branch` step tests
 * a value and makes only its 'true' or 'false' output live, so the other path's steps are skipped and
 * that skip cascades. `runAgent` is injected so the whole scheduler is testable without a browser.
 * Never throws: a step's failure is recorded and stops the run.
 */
// Natural pacing between auto-sent replies. Posting a burst of comments back-to-back is exactly what
// gets an account flagged; a person spaces them out. So auto-reply waits a RANDOM gap between each one
// (default 1–4 min) — one at a time, with an uneven human rhythm, never all at once.
const PACE_MIN_MS = 60 * 1000, PACE_MAX_MS = 240 * 1000;
const paceMs = () => PACE_MIN_MS + Math.floor(Math.random() * (PACE_MAX_MS - PACE_MIN_MS));

async function drive(wf, { runAgent, runVerify = null, runFetch = null, runScript = null, input = null, persist = () => {}, now = () => new Date().toISOString(), runId, resume = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  /*
   * THE RUN'S INPUT. A reply needs its thread and its text; a read needs its room. Seeded under
   * `input` so a goal can say {{input.threadUrl}}, and kept on the run so a resume seeds it again.
   */
  const seed = (input && typeof input === 'object') ? input : ((resume && resume.input && typeof resume.input === 'object') ? resume.input : null);
  const context = seed ? { input: JSON.parse(JSON.stringify(seed)) } : {};
  const autoApprove = !!wf.autoApprove;   // the automation's "auto-send replies" toggle
  const nodes = wf.nodes || [];
  const byId = {}; nodes.forEach((n) => { byId[n.id] = n; });
  const edges = (wf.edges || []).filter((e) => byId[e.from] && byId[e.to]);
  const incoming = {}; nodes.forEach((n) => { incoming[n.id] = []; });
  edges.forEach((e) => incoming[e.to].push(e));

  const done = new Set(), dead = new Set(), branchOf = {};

  // Fresh run, or the continuation of one a restart interrupted. On resume we replay the scheduler
  // state (context, which nodes are done/dead, branch verdicts) from the steps that finished before
  // the crash, keep those step records, and let the frontier re-run everything that hadn't — so a
  // deploy mid-run costs redoing at most the step that was in flight, not the whole automation.
  const run = resume
    ? { ...resume, status: 'running', ended_at: null }
    : { id: runId || `${wf.id}-${Date.now()}`, workflow_id: wf.id, name: wf.name, status: 'running', started_at: now(), ended_at: null, steps: [], ...(seed ? { input: seed } : {}) };
  if (resume) {
    const kept = [];
    for (const st of (resume.steps || [])) {
      const node = byId[st.node_id]; if (!node) continue;
      if (st.status === 'done' && seedFromStep(node, st, context, branchOf)) { done.add(node.id); kept.push(st); }
      else if (st.status === 'skipped') { dead.add(node.id); kept.push(st); }
      // a step that was 'running'/'error' (or a done node whose context can't be rebuilt) is dropped,
      // so its node re-runs. A filter is never seeded — its kept list isn't persisted — so it recomputes.
    }
    run.steps = kept;
  }
  persist(run);
  const resolved = (id) => done.has(id) || dead.has(id);
  // An edge is LIVE once its source is done — and, for a branch source, only on the matching port.
  const edgeLive = (e) => {
    if (!done.has(e.from)) return false;
    return byId[e.from].type === 'branch' ? ((e.fromPort === 'true') === !!branchOf[e.from]) : true;
  };
  const depsResolved = (n) => incoming[n.id].every((e) => resolved(e.from));
  const hasLiveIn = (n) => incoming[n.id].length === 0 || incoming[n.id].some(edgeLive);

  async function runNode(node) {
    const step = { node_id: node.id, label: node.label || node.id, type: node.type, status: 'running', started_at: now(), output: null, error: null };
    run.steps.push(step); persist(run);
    try {
    if (node.type === 'trigger') {
      step.status = 'done';
    } else if (node.type === 'store') {
      const val = template(node.value, context);
      context[node.key] = val; step.output = { [node.key]: val }; step.status = 'done';
    } else if (node.type === 'branch') {
      const v = getPath(context, String(node.inKey).replace(/\[(\d+)\]/g, '.$1'));
      const res = condMatch(v, node.op, node.value);
      branchOf[node.id] = res; step.output = { result: res }; step.status = 'done';
    } else if (node.type === 'filter') {
      const list = getPath(context, String(node.inKey).replace(/\[(\d+)\]/g, '.$1'));
      const arr = Array.isArray(list) ? list : [];
      const kept = arr.filter((it) => filterMatch(it, node.field, node.op, node.value));
      context[node.id] = kept; if (node.outKey && node.outKey !== node.id) context[node.outKey] = kept;
      step.output = { kept: kept.length, of: arr.length }; step.status = 'done';
    } else if (node.type === 'fetch') {
      /*
       * GET IT IN THIS SESSION, WITH NO MODEL. The browser context's request API shares its cookies,
       * so a logged-in feed answers exactly as it would in the page — and because it is not the page,
       * nothing has to be navigated away from. A step that only GETs cannot act, so it needs no
       * approval gate; and it costs nothing, so a scout may run every hour forever.
       */
      if (typeof runFetch !== 'function') throw new Error('this browser cannot run a fetch step');
      const url = template(node.url, context);
      if (!/^https?:\/\//i.test(url)) throw new Error(`this step's url is not an http(s) address (${url.slice(0, 80) || 'empty'}) — write it out, or take it from the run's input`);
      const got = await runFetch({ node: resolveNode(node, context), url, pick: node.pick || null, context, workflowId: wf.id, runId: run.id });
      const body = got && got.body != null ? String(got.body) : '';
      const res = { url, status: got.status, shape: got.shape, chars: body.length, body };
      context[node.id] = res; if (node.outKey && node.outKey !== node.id) context[node.outKey] = res;
      /* The body is NOT journalled: a feed is megabytes and a run record is read by a person. */
      step.output = { url, status: got.status, shape: got.shape, chars: body.length };
      if (got.status >= 400) { step.error = `${url} answered ${got.status}`; throw new Error(step.error); }
      step.status = 'done';
    } else if (node.type === 'script') {
      /*
       * READ THE PAGE ITSELF, WITH NO MODEL. The proven scout's read step was a two-act job — open the
       * page, run this exact script — and still cost fourteen model calls, because an agent looks,
       * dismisses, re-looks and narrates around the act. This is the act without the narration: the
       * browser opens the url as the profile, clears a consent wall if one is there, runs the script,
       * and hands back the value. Nothing to approve, nothing to pay for, so it may run every hour.
       */
      if (typeof runScript !== 'function') throw new Error('this browser cannot run a script step');
      const url = template(node.url, context);
      if (!/^https?:\/\//i.test(url)) throw new Error(`this step's url is not an http(s) address (${url.slice(0, 80) || 'empty'}) — write it out, or take it from the run's input`);
      const got = await runScript({ node: resolveNode(node, context), url, script: node.script, context, workflowId: wf.id, runId: run.id });
      const value = got ? got.value : null;
      const res = { url, value, kind: Array.isArray(value) ? 'list' : (value === null ? 'null' : typeof value), count: Array.isArray(value) ? value.length : undefined };
      context[node.id] = res; if (node.outKey && node.outKey !== node.id) context[node.outKey] = res;
      /* Journal the shape and a short preview, never the whole value: a run record is read by a person. */
      const preview = JSON.stringify(value === undefined ? null : value);
      step.output = { url, kind: res.kind, count: res.count, chars: preview.length, preview: preview.slice(0, 400) };
      step.status = 'done';
    } else if (node.type === 'extract') {
      /*
       * ONE PATTERN, MANY ROWS, NO MODEL. A listing is a repeated shape, so reading it is a regex and
       * not a judgement. Named groups become named fields, so the next step gets data rather than a
       * wall of text — and it is deterministic, which a model reading HTML is not.
       */
      const from = getPath(context, String(node.inKey).replace(/\[(\d+)\]/g, '.$1'));
      const text = from == null ? '' : (typeof from === 'string' ? from : (from.body != null ? String(from.body) : JSON.stringify(from)));
      let re;
      try { re = new RegExp(node.pattern, node.flags.includes('g') ? node.flags : node.flags + 'g'); }
      catch (e) { throw new Error(`the pattern is not a valid expression: ${e.message}`); }
      const rows = [];
      for (const m of text.matchAll(re)) {
        rows.push(m.groups && Object.keys(m.groups).length
          ? Object.fromEntries(Object.entries(m.groups).map(([k, v]) => [k, v == null ? null : String(v).trim()]))
          : (m[1] != null ? String(m[1]).trim() : String(m[0]).trim()));
        if (rows.length >= node.limit) break;
      }
      const res = { rows, count: rows.length, of: text.length };
      context[node.id] = res; if (node.outKey && node.outKey !== node.id) context[node.outKey] = res;
      step.output = res; step.status = 'done';
    } else if (node.type === 'collect') {
      // Pull one field from each item of a list into a flat array — dropping blanks — so a fan-out's
      // {items:[{data:{clip}}…]} becomes a clean [clip,clip,…] the next step can hand straight on.
      const list = getPath(context, String(node.inKey).replace(/\[(\d+)\]/g, '.$1'));
      const arr = Array.isArray(list) ? list : [];
      const out = arr.map((it) => (node.field ? getPath(it, node.field) : it)).filter((v) => v != null && v !== '');
      context[node.outKey] = out; step.output = { [node.outKey]: out }; step.status = 'done';
    } else if (node.type === 'agent') {
      if (node.forEach) {
        // Run the step once per item in an earlier step's list, {{item}} being that item; the outputs
        // collect into an array. A Reddit scout that found 8 leads → 8 drafts, one per lead.
        const list = getPath(context, String(node.forEach).replace(/\[(\d+)\]/g, '.$1'));
        const items = Array.isArray(list) ? list : [];
        const results = [];
        for (let i = 0; i < items.length; i++) {
          const ctx = { ...context, item: items[i], index: i };
          results.push(await runAgent({ node: resolveNode(node, ctx), goal: template(node.goal, ctx), context: ctx, autoApprove, workflowId: wf.id, runId: run.id }));
          // Auto-send only: pause a human-length, random beat before the next reply so the account
          // does not fire a burst. In manual mode the owner's own pace between approvals does this.
          if (autoApprove && i < items.length - 1) { const ms = paceMs(); step.pacingMs = ms; persist(run); await sleep(ms); }
        }
        const out = { items: results, count: results.length };
        context[node.id] = out; if (node.outKey && node.outKey !== node.id) context[node.outKey] = out;
        step.output = out; step.status = 'done';
      } else {
        const goal = template(node.goal, context);
        step.goal = goal;
        /*
         * THE ROLE AND THE PROFILE ARE TEMPLATED TOO, so ONE flow serves every platform: an organ
         * passes {{input.role}} and {{input.profile}} and the same reply flow works on Facebook, on
         * Reddit and on LinkedIn. Without this a flow is welded to one platform and an organ needs a
         * copy of it per platform, which is the sort of duplication the registry exists to end.
         */
        const out = await runAgent({ node: resolveNode(node, context), goal, context, autoApprove, workflowId: wf.id, runId: run.id });
        context[node.id] = out;
        if (node.outKey && node.outKey !== node.id) context[node.outKey] = out;
        step.output = out;
        if (out && out.__jobId) step.job_id = out.__jobId;
        step.status = 'done';
      }
    } else if (node.type === 'check-login') {
      /*
       * ASK BEFORE SPENDING A SESSION. Four of the nine platforms the desk replies on need a login
       * merely to READ, so a signed-out profile there turns "could not see the thread" into
       * "unconfirmed" — the one outcome that is never retried. This makes it a fact instead.
       */
      if (typeof runVerify !== 'function') throw new Error('this browser cannot run a sign-in check');
      const at = template(node.url, context);
      step.goal = `is this browser signed in at ${at}`;
      const out = await runVerify({ node: resolveNode(node, context), url: at, text: '', signIn: true, context, workflowId: wf.id, runId: run.id });
      const res = { signedIn: !!(out && out.signedIn), url: at };
      context[node.id] = res; if (node.outKey && node.outKey !== node.id) context[node.outKey] = res;
      step.output = res; step.status = 'done';
    } else if (node.type === 'verify') {
      /*
       * DID THE WORDS LAND? Open the page in the step's profile and look for the text — a slice from
       * the middle, on letters and digits only, the same way the act gate confirms a comment. The
       * answer is data a branch can test; no model is asked for its opinion.
       */
      if (typeof runVerify !== 'function') throw new Error('this browser cannot run a verify step');
      const url = template(node.url, context), text = template(node.text, context);
      /*
       * AN EMPTY TEMPLATE IS THE REASON, AND IT IS SAYABLE. A proof may take its address from the
       * run INPUT (the caller knows it — and a run with no input stays the no-op it always was), but
       * never from an earlier STEP's output: when that field is missing the run dies at its last node
       * with the work already done. Live: an extraction step returned 25 posts and the run still failed.
       */
      for (const [what, raw, got] of [['url', String(node.url || ''), url], ['text', String(node.text || ''), text]]) {
        if (got.trim() || raw.indexOf('{{') < 0) continue;
        const a = raw.indexOf('{{'), b = raw.indexOf('}}', a + 2);
        const field = b > a ? raw.slice(a + 2, b).trim() : '';
        if (!field || field === 'input' || field.indexOf('input.') === 0) continue;   // the caller's to supply
        throw new Error(`this step's ${what} is taken from {{${field}}} and that resolved to nothing — the step before it did not produce that field. Write the ${what === 'url' ? 'address' : 'text'} out, or take it from the run's input: what proves an outcome is known before the run.`);
      }
      step.goal = `verify "${text.slice(0, 60)}" on ${url}`;
      const out = await runVerify({ node: resolveNode(node, context), url, text, context, workflowId: wf.id, runId: run.id });
      const res = { found: !!(out && out.found), url, ...(out && out.__jobId ? { __jobId: out.__jobId } : {}) };
      context[node.id] = res; if (node.outKey && node.outKey !== node.id) context[node.outKey] = res;
      step.output = res; step.status = 'done';
    } else {
      step.status = 'skipped';
    }
    step.ended_at = now(); done.add(node.id); persist(run);
    } catch (e) {
      step.status = 'error'; step.error = String((e && e.message) || e); step.ended_at = now(); persist(run);
      throw e;
    }
  }

  // Walk the frontier: every step whose dependencies have all resolved. Split it into the ones with a
  // live path in (run them, in parallel) and the ones whose every incoming edge is dead (skip them).
  let guard = 0;
  while ((done.size + dead.size) < nodes.length && guard++ <= nodes.length + 1) {
    const frontier = nodes.filter((n) => !resolved(n.id) && depsResolved(n));
    if (!frontier.length) break;                         // nothing more can run (a cycle, or truly done)
    const skip = frontier.filter((n) => !hasLiveIn(n));
    for (const n of skip) {
      dead.add(n.id);
      run.steps.push({ node_id: n.id, label: n.label || n.id, type: n.type, status: 'skipped', started_at: now(), ended_at: now(), output: null, error: null });
    }
    if (skip.length) persist(run);
    const runnable = frontier.filter((n) => hasLiveIn(n));
    if (!runnable.length) continue;
    try {
      await Promise.all(runnable.map((n) => runNode(n)));   // the step that threw is already marked
    } catch (e) {
      run.status = 'error'; run.ended_at = now(); persist(run);
      return run;
    }
  }
  run.status = 'done'; run.ended_at = now(); persist(run);
  return run;
}

// run journal on disk, so a status poll survives a restart mid-run
function persistRun(run) { ensure(RUNDIR); try { fs.writeFileSync(file(RUNDIR, run.id), JSON.stringify(run, null, 2), { mode: 0o600 }); } catch { /* a run that cannot be written still runs */ } }
function readRun(id) { try { return JSON.parse(fs.readFileSync(file(RUNDIR, String(id)), 'utf8')); } catch { return null; } }
function runsFor(workflowId, limit = 20) {
  ensure(RUNDIR);
  let names; try { names = fs.readdirSync(RUNDIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  return names.map((f) => readRun(f.replace(/\.json$/, ''))).filter((r) => r && r.workflow_id === workflowId)
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || ''))).slice(0, limit);
}

/*
 * WHICH FLOWS ACTUALLY WORK — one pass over the run directory, keyed by flow.
 *
 * A flow list without this is why the browser accumulated 114 flows and reused none of them: a
 * builder could see every flow's SHAPE and nothing about whether any of them had ever reached its
 * outcome. The proof existed in the run files the whole time; nobody read it back.
 *
 * "Verified" here means exactly what it means everywhere else in this engine: the run finished, it
 * had at least one verify step, every verify step found its text, and no step errored. `verifiedEver`
 * is the reuse signal (this flow has worked at least once); `lastVerified` is the freshness signal
 * (it still worked the last time it ran). A flow that passed in March and broke in April should
 * advertise both facts, because they lead to different decisions.
 *
 * Deliberately ONE directory pass. runsFor() rescans every run file for a single flow, so asking it
 * per flow costs flows x runs on every list call — with 114 flows that is the kind of accident that
 * makes an endpoint quietly unusable.
 */
function latestOutcomes() {
  ensure(RUNDIR);
  let names; try { names = fs.readdirSync(RUNDIR).filter((f) => f.endsWith('.json')); } catch { return {}; }
  const out = {};
  for (const f of names) {
    let r = null; try { r = readRun(f.replace(/\.json$/, '')); } catch { r = null; }
    if (!r || !r.workflow_id) continue;
    const steps = Array.isArray(r.steps) ? r.steps : [];
    const verifies = steps.filter((s) => s && s.type === 'verify');
    const green = r.status === 'done' && verifies.length > 0
      && verifies.every((s) => s.status === 'done' && s.output && s.output.found === true)
      && !steps.some((s) => s && s.status === 'error');
    const cur = out[r.workflow_id]
      || { runs: 0, verifiedRuns: 0, verifiedEver: false, lastRunAt: null, lastRunStatus: null, lastVerified: false };
    cur.runs += 1;
    if (green) { cur.verifiedRuns += 1; cur.verifiedEver = true; }
    const at = String(r.started_at || '');
    if (!cur.lastRunAt || at >= String(cur.lastRunAt)) {
      cur.lastRunAt = at || cur.lastRunAt;
      cur.lastRunStatus = r.status || null;
      cur.lastVerified = green;
    }
    out[r.workflow_id] = cur;
  }
  return out;
}

/** Every persisted run still marked 'running' — i.e. one whose driver died with the process. */
function interruptedRuns() {
  ensure(RUNDIR);
  let names; try { names = fs.readdirSync(RUNDIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  return names.map((f) => readRun(f.replace(/\.json$/, ''))).filter((r) => r && r.status === 'running');
}

/**
 * On boot, pick up any run a restart interrupted. Each resumes from where it left off (see drive's
 * resume path); a run whose workflow is gone, or that has already been resumed too many times (a step
 * that crash-loops), is marked 'interrupted' instead of retried forever. Fire-and-forget, exactly as
 * a normal run is — recovery never blocks startup.
 */
function recoverRuns({ runAgent, runVerify = null, runFetch = null, persist = persistRun, now = () => new Date().toISOString(), log } = {}) {
  const runs = interruptedRuns();
  // Only the NEWEST interrupted run of each automation is worth resuming — an older one is a stale
  // duplicate the newer attempt superseded, and resuming both would double the work and (since they
  // share the automation's profile) collide on the browser's profile directory.
  const newest = {};
  for (const r of runs) { const k = r.workflow_id; if (!newest[k] || String(r.started_at || '') > String(newest[k].started_at || '')) newest[k] = r; }
  const resumable = [];
  for (const run of runs) {
    const wf = read(run.workflow_id);
    const isNewest = newest[run.workflow_id] === run;
    if (!wf || !isNewest || (run.resumes || 0) >= 3) {
      run.status = 'interrupted'; run.ended_at = now();
      run.error = run.error || (!wf ? 'its automation no longer exists' : !isNewest ? 'superseded by a newer run of this automation' : 'gave up resuming after repeated restarts');
      persist(run); continue;
    }
    run.resumes = (run.resumes || 0) + 1; persist(run);
    resumable.push({ run, wf });
  }
  // Resume SEQUENTIALLY: the runs share one browser, so two resuming at once fight over the same
  // profile directory (ProcessSingleton). One at a time is both correct and how a person would run them.
  (async () => {
    for (const { run, wf } of resumable) {
      if (log && log.info) log.info(`[workflow] resuming interrupted run ${run.id} (attempt ${run.resumes})`);
      try { await drive(wf, { runAgent, runVerify, runFetch, persist, runId: run.id, resume: run }); }
      catch (e) { try { const r = readRun(run.id) || run; r.status = 'error'; r.error = `resume failed: ${(e && e.message) || e}`; r.ended_at = now(); persist(r); } catch { /* */ } }
    }
  })();
  return resumable.length;
}

/*
 * WHAT HAPPENED, AS ONE WORD. A step used to hand back counts of the records it saved and nothing
 * about whether it did the thing. Derived from the job's own steps — the same kinds the act gate
 * writes — so a branch can test {{send.outcome}} and Herald can read one field instead of prose.
 */
function outcomeOf(steps = []) {
  const kinds = (Array.isArray(steps) ? steps : []).map((s) => s && s.kind);
  if (kinds.includes('acted')) return 'posted';
  if (kinds.includes('unconfirmed')) return 'unconfirmed';
  if (kinds.includes('blocked')) return 'blocked';
  return 'none';
}

/*
 * HOW OFTEN A SCHEDULED FLOW IS MEANT TO FIRE, and how long it may be silent before that silence is
 * news. A single 45-minute threshold was right while every watcher ran every few minutes; the Search
 * Console watcher reads once a day, and on that rule its card said STALE for twenty-three hours out of
 * twenty-four while working perfectly. A warning that is always on teaches the owner to ignore the
 * field, and then the watcher that HAS gone quiet looks just like the one that has not.
 *
 * One interval plus half of one as grace. The 45-minute floor stays, so nothing that was accurate
 * before becomes twitchy: a 15-minute watcher is still stale at 45 minutes, an hourly one at 90, a
 * daily one at 36 hours.
 */
const UNIT_MS = { minute: 60e3, hour: 3600e3, day: 24 * 3600e3 };
const STALE_FLOOR_MS = 45 * 60e3;

/*
 * IS THIS SCHEDULE DUE? Interval units the scheduler understands, as data: adding one is a line here,
 * never a per-schedule change. `lastMs` is when the last run STARTED, which the run record carries.
 */
const SCHED_UNIT_MS = { minute: 60e3, hour: 3600e3 };
function scheduleDue(cfg, lastMs, when = new Date()) {
  if (!cfg) return false;
  if (cfg.every === 'day') {
    const [hh, mm] = String(cfg.at || '08:00').split(':').map((x) => parseInt(x, 10) || 0);
    /*
     * AT OR AFTER ITS TIME, not exactly on it. The scheduler ticks once a minute, so an exact-minute
     * match is ONE chance a day - missed whenever another pass holds the browser at that minute (four
     * watchers here run every 10 to 20 minutes), whenever the pod rolls through it, or whenever a tick
     * lands a second late. The property then goes unread for the day, silently, while the card still
     * shows the previous reading as the newest there is.
     *
     * The 22-hour gap keeps this a window and not a loop: one pass a day, late if need be.
     */
    const target = new Date(when.getTime());
    target.setHours(hh, mm, 0, 0);
    return when.getTime() >= target.getTime() && (when.getTime() - lastMs) > 22 * 3600e3;
  }
  const ms = SCHED_UNIT_MS[cfg.every];
  if (ms) { const n = Math.max(1, Number(cfg.n) || 1); return (when.getTime() - lastMs) >= n * ms; }
  return false;
}

function intervalMs(trigger) {
  const t = trigger && typeof trigger === 'object' ? trigger : {};
  if (String(t.type || '') !== 'schedule') return 0;
  const unit = UNIT_MS[String(t.every || '')];
  if (!unit) return 0;
  /* `every: 'day'` carries an `at` time rather than an n, and n is meaningless there. */
  return String(t.every) === 'day' ? unit : Math.max(1, Number(t.n) || 1) * unit;
}

function triggerOf(wf) {
  const nodes = (wf && Array.isArray(wf.nodes)) ? wf.nodes : [];
  const node = nodes.find((n) => n && n.type === 'trigger' && n.trigger);
  return (node && node.trigger) || (wf && wf.trigger) || null;
}

function staleAfterMs(wf) {
  const every = intervalMs(triggerOf(wf));
  return Math.max(STALE_FLOOR_MS, Math.round(every * 1.5));
}

module.exports = {
  DIR, RUNDIR, NODE_TYPES, FILTER_OPS, slug, outcomeOf,
  read, all, validate, save, remove, exportPack, importPack,
  order, template, resolveNode, getPath, filterMatch, condMatch, drive, seedFromStep,
  persistRun, readRun, runsFor, latestOutcomes, interruptedRuns, recoverRuns,
  intervalMs, triggerOf, staleAfterMs, STALE_FLOOR_MS, scheduleDue,
};
