/**
 * jobs.js — what the agent is doing, what it found, and what it wants permission to do.
 *
 * A job is a conversation that happens to have a browser attached. It therefore needs three things
 * a plain request/response never does:
 *
 *   AN INBOX, because the person watching will want to say "not that group, the other one" while it
 *   is already working. Queued and picked up at the next step rather than interrupting mid-action —
 *   an agent halfway through typing a comment should finish the keystroke, then read the note.
 *
 *   A PROPOSAL QUEUE, because everything this agent does that matters happens under a real name on
 *   a real account. Joining, commenting, messaging and following are not reversible in any way that
 *   matters — the notification is already sent. So they are proposed, and a person decides.
 *
 *   A JOURNAL ON DISK, because the leads are the product. A pod restart mid-run must not lose forty
 *   minutes of reading, and "what did it actually do on my account" is a question that deserves an
 *   answer later, not just a scrollback.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'jobs');

const jobs = new Map();          // id -> job (the live object, transcript included)
const bus = new EventEmitter();
bus.setMaxListeners(0);

const now = () => new Date().toISOString();
const id = () => `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/*
 * The transcript is the model's own message history and it gets LARGE — page text, element lists,
 * every tool result. It stays in memory and never reaches disk: what belongs on disk is what a
 * person would want to read back, which is the steps, the leads and the decisions.
 */
const persistable = (j) => ({
  id: j.id, owner: j.owner, goal: j.goal, companyId: j.companyId, profile: j.profile,
  /* The assistant's plan, when a person's own words are the goal. Named here on purpose: the
     verdict was computed and dropped for 2,228 jobs because this shape did not name it. */
  plan: j.plan || null,
  // Which automation run this job belongs to, so an approval shows under ITS flow's results and not
  // every flow's — a workflow step's job carries its run and workflow ids; a one-off job carries none.
  workflowId: j.workflowId || null, runId: j.runId || null, nodeId: j.nodeId || null,
  sessionId: j.sessionId, status: j.status, createdAt: j.createdAt, endedAt: j.endedAt || null,
  /*
   * THE VERDICT, WHICH FOR 2,228 JOBS WAS COMPUTED AND THEN THROWN AWAY HERE.
   *
   * judge() takes it at the moment of finishing precisely because evidence ages — a captured file
   * is cleaned up, a recording deleted, a workflow run rolls out of its window. It set j.verdict,
   * the bus carried it to anything watching, and then this shape did not name the field, so nothing
   * reached disk. Every reader afterwards re-judged the job against whatever evidence still
   * happened to exist, which means gold decays into silver as the file it was proved by disappears.
   *
   * The training set is labelled from these, so the defect does not show as an error anywhere: it
   * shows as a model trained on quietly downgraded examples. Same failure as gscHealth above, one
   * field over, which is why that story is worth keeping in view.
   */
  verdict: j.verdict || null,
  /*
   * EVERY LIST A TOOL CAN FILL BELONGS HERE, and one that was missed is invisible rather than empty.
   *
   * A Search Console audit called save_gsc_health six times. addGscHealth pushed all six onto the
   * job and persisted it — and this shape, which is what gets written and what every reader is
   * handed, did not name gscHealth. So the findings lived exactly as long as the process did, the
   * master asked for them and got nothing, and the run recorded "the audit read nothing it could
   * file". Honest, and completely wrong: it had read plenty.
   *
   * The failure is silent by construction — a missing key reads as an empty list, and an empty list
   * is a perfectly ordinary outcome for a young property. Nothing anywhere could tell the two apart.
   */
  error: j.error || null, steps: j.steps, leads: j.leads, proposals: j.proposals, results: j.results || [], gigs: j.gigs || [], replies: j.replies || [], reach: j.reach || [], keywords: j.keywords || [], searchQueries: j.searchQueries || [], gscHealth: j.gscHealth || [], gscToken: j.gscToken || null, opportunities: j.opportunities || [], data: j.data || {},
  // Where the leads are going, so the panel can say it rather than the person guessing.
  sink: j.sink || null,
  // Which specialist ran it, so a conversation reopened later reads correctly.
  role: j.role || 'general',
  // The agent's own conclusion in full — see setReport.
  report: j.report || null,
});

function persist(j) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, `${j.id}.json`), JSON.stringify(persistable(j), null, 2), { mode: 0o600 });
  } catch { /* a job that cannot be written is still a job worth finishing */ }
}

function create({ owner, goal, companyId, profile, sessionId, workflowId, runId, nodeId, maxSteps = 0, maxPages = 0, feedKey = null, feedWorkflowId = null }) {
  const j = {
    id: id(), owner, goal, companyId: companyId || null, profile: profile || null, sessionId,
    workflowId: workflowId || null, runId: runId || null,
    /* When this job is a watcher follow-up drafting a reply, the feed item it belongs to — so the
       drafted proposal is written straight back onto that item the moment it is proposed. */
    feedKey: feedKey || null, feedWorkflowId: feedWorkflowId || null,
    /* WHICH STEP of the flow this is. The route card's intent is the step, not the role: the same
       step does the same act on every run, which is the repetition a card pays for. */
    nodeId: nodeId || null,
    /* What this job is allowed to spend. 0 means the instance default and no page counting, which
       is every job that existed before a caller could say. See the budgets in agent.js. */
    maxSteps: Number(maxSteps) > 0 ? Number(maxSteps) : 0,
    maxPages: Number(maxPages) > 0 ? Number(maxPages) : 0,
    status: 'running', createdAt: now(), endedAt: null, error: null,
    steps: [], leads: [], proposals: [], results: [], gigs: [], replies: [], reach: [], keywords: [], searchQueries: [], gscToken: null, opportunities: [], inbox: [], transcript: [], data: {},
    report: null,
    stop: new AbortController(),
  };
  jobs.set(j.id, j);
  persist(j);
  return j;
}

/**
 * The agent's conclusion, IN FULL. A step line is cut at 4000 characters because it is one line in a
 * story — but the finish summary is the deliverable, and a research pass writes a 10K-character
 * report into it. Cut to a step, the master's first go-to-market pass kept "who has the pain" and
 * lost the rooms, the verbatim words and what converts: the three sections a launch is written
 * from. So the summary also lives beside the steps, uncut within reason; the step stays a line.
 */
function setReport(j, text) {
  j.report = String(text || '').slice(0, 64000) || null;
  persist(j);
  return j;
}

/** One line in the story. Everything the UI shows is one of these. */
function step(j, kind, text, extra = {}) {
  const s = { n: j.steps.length + 1, at: now(), kind, text: String(text || '').slice(0, 4000), ...extra };
  j.steps.push(s);
  // Trim rather than grow without bound; the tail is what anyone reads.
  if (j.steps.length > 600) j.steps.splice(0, j.steps.length - 600);
  bus.emit(j.id, { type: 'step', jobId: j.id, step: s });
  persist(j);
  return s;
}

/**
 * ADD TO A STEP THAT IS ALREADY WRITTEN.
 *
 * Some of what a step means is only known after it finishes. `open` is recorded before the
 * navigation — deliberately, so a page that never loads still leaves a trace — and the numbered
 * list of what is on that page only exists once it has. Without this the list is shown to the model
 * and dropped from the record, which is exactly what made every click after an open unlearnable.
 *
 * Persists, because a mutation nobody writes down is the bug this is fixing.
 */
function annotate(j, step, extra) {
  if (!j || !step || !extra) return step;
  Object.assign(step, extra);
  persist(j);
  return step;
}

function addLead(j, lead) {
  const l = { at: now(), ...lead };
  /* The same post found twice through two different groups is one lead. Without this the list looks
     productive and is not. */
  const key = (x) => `${(x.url || '').trim()}|${(x.name || '').trim().toLowerCase()}`;
  if (j.leads.some((x) => key(x) === key(l))) return null;
  j.leads.push(l);
  bus.emit(j.id, { type: 'lead', jobId: j.id, lead: l });
  persist(j);
  return l;
}

/**
 * Ask before doing. Returns the proposal; the loop waits for it to be decided.
 */
function propose(j, proposal) {
  const p = {
    pid: `p-${j.proposals.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
    at: now(), state: 'pending', ...proposal,
  };
  j.proposals.push(p);
  bus.emit(j.id, { type: 'proposal', jobId: j.id, proposal: p });
  persist(j);
  return p;
}

/** Approve, optionally rewriting the text — editing a comment before it goes out is the normal case. */
function decide(j, pid, state, edit) {
  const p = j.proposals.find((x) => x.pid === pid);
  if (!p) return null;
  if (p.state !== 'pending') return p;   // decided once, and once only
  p.state = state;
  if (state === 'approved' && typeof edit === 'string' && edit.trim()) p.text = edit.trim().slice(0, 4000);
  p.decidedAt = now();
  bus.emit(j.id, { type: 'proposal', jobId: j.id, proposal: p });
  persist(j);
  return p;
}

/**
 * You, talking to it. Queued rather than injected mid-action — an agent halfway through typing
 * should finish the keystroke and then read the note — and it WAKES an idle conversation, which is
 * the whole point of idle not being an ending.
 */
function say(j, text) {
  const m = { at: now(), text: String(text || '').slice(0, 4000) };
  j.inbox.push(m);
  step(j, 'you', m.text);
  if (j.status === 'idle') {
    j.status = 'running';
    j.endedAt = null;
    bus.emit(j.id, { type: 'status', jobId: j.id, status: 'running' });
    persist(j);
  }
  return m;
}

/*
 * `idle` means "waiting for you", and it is NOT an ending. The loop stays alive holding the whole
 * transcript, so the next thing you say continues the same conversation rather than starting an
 * agent that has never seen any of it.
 */
const OVER = ['stopped', 'failed', 'interrupted'];
const isOver = (j) => OVER.includes(j.status);

/**
 * The conversation moved to a different login.
 *
 * Announced rather than quietly recorded, because a UI watching this job is showing a screencast of
 * the OLD browser and has no other way to know it has become a picture of the wrong thing.
 */
function switchedSession(j, { sessionId, profile }) {
  j.sessionId = sessionId;
  j.profile = profile || null;
  bus.emit(j.id, { type: 'session', jobId: j.id, sessionId, profile: j.profile });
  persist(j);
  return j;
}

/*
 * WHO CHECKS THE WORK, INJECTED RATHER THAN IMPORTED.
 *
 * The verdict needs the file store, the recorder and the workflow-run store to answer "is the file
 * there, did the recording finish, did the automation complete". This module knows about none of
 * them and should not: it stores jobs. So the server, which has all three in scope, hands the
 * checker in once at boot and jobs.js only calls it.
 */
let verifier = null;
function setVerifier(fn) { verifier = typeof fn === 'function' ? fn : null; }

/**
 * THE VERDICT IS TAKEN WHEN THE EVIDENCE IS FRESH.
 *
 * Labelling the whole store afterwards works, and it is how the first 1,147 were found — but
 * evidence ages. A captured file gets cleaned up, a recording is deleted, a workflow run rolls out
 * of its window. Checked here, at the moment of finishing, the answer is taken while all three are
 * still true.
 *
 * And the half that is worth it even if nothing is ever trained: an agent that reports an export it
 * never produced is worse than one that admits failure, because nobody finds out until they look
 * for the file. When a verifier contradicts the report, this says so out loud.
 */
function judge(j) {
  if (!verifier) return null;
  let v = null;
  try { v = verifier(j); } catch (e) { return null; }
  if (!v) return null;
  j.verdict = {
    tier: v.tier,
    why: v.why,
    external: v.external,
    failures: v.failures,
    ...(v.voidReason ? { voidReason: v.voidReason } : {}),
    ...(v.endedBy ? { endedBy: v.endedBy } : {}),
    at: now(),
  };
  if (v.failures && v.failures.length) {
    /* Not a warning about the job — a warning about the REPORT. The work may have been fine; what
       is wrong is that it claimed something the record contradicts. */
    step(j, 'blocked', `checked: ${v.why.join('; ')}`.slice(0, 600));
  }
  return j.verdict;
}

function finish(j, status, detail) {
  if (isOver(j)) return j;
  j.status = status;
  j.endedAt = status === 'idle' ? null : now();
  if (status === 'failed') j.error = String(detail || 'failed').slice(0, 600);
  step(j, status === 'idle' ? 'done' : 'end', detail || status);
  /* After the end step, so the verdict sees the finished record — including the end itself, which
     is how "the owner stopped it" becomes void rather than a failure. */
  const verdict = judge(j);
  bus.emit(j.id, { type: 'status', jobId: j.id, status, error: j.error, verdict });
  persist(j);
  return j;
}

function stop(j, why = 'stopped by you') {
  try { j.stop.abort(); } catch { /* already aborted */ }
  j.status = 'running';   // so finish() below is not skipped by an idle guard
  /* Anything still waiting on a decision would otherwise block the loop's own shutdown. */
  for (const p of j.proposals) if (p.state === 'pending') decide(j, p.pid, 'skipped');
  return finish(j, 'stopped', why);
}

/*
 * A restart loses the live conversation but NOT its journal — so answer from disk rather than 404.
 * The 404 was silently expensive: a caller waiting on the job (the master polls every run it
 * dispatched) cannot tell "no such job" from a transient error, so it left those runs `started`
 * FOREVER and the one browser session stayed permanently occupied. An interrupted job is a real,
 * TERMINAL answer — its browser context is gone, so it can never continue — and everything it found
 * before the restart is still in the record, which is what the caller actually came for.
 */
const get = (jid) => {
  const live = jobs.get(jid);
  if (live) return live;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, `${jid}.json`), 'utf8'));
    return ['running', 'idle'].includes(j.status) ? { ...j, status: 'interrupted' } : j;
  } catch { return null; }
};
/* One row per job, in the shape the console and the tools both read. */
const rowOf = (j) => ({ id: j.id, goal: j.goal, status: j.status, createdAt: j.createdAt,
  owner: j.owner, profile: j.profile || null,
  workflowId: j.workflowId || null, runId: j.runId || null, nodeId: j.nodeId || null,
  steps: j.steps.length, leads: j.leads.length,
  pending: j.proposals.filter((p) => p.state === 'pending').length });
const newestFirst = (a, b) => (a.createdAt < b.createdAt ? 1 : -1);

/** EVERY job on this install — what the owner's own console is entitled to see. */
const listAll = () => [...jobs.values()].sort(newestFirst).map(rowOf);

const listFor = (owner) => [...jobs.values()].filter((j) => j.owner === owner)
  .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  .map((j) => ({ id: j.id, goal: j.goal, status: j.status, createdAt: j.createdAt,
                 workflowId: j.workflowId || null, runId: j.runId || null, nodeId: j.nodeId || null,
                 steps: j.steps.length, leads: j.leads.length,
                 pending: j.proposals.filter((p) => p.state === 'pending').length }));

/** What the UI opens a job with: everything except the model's own transcript. */
const view = (j) => (j ? { ...persistable(j), inbox: undefined } : null);

/*
 * Jobs from before the last restart. They are finished by definition — nothing is driving them — so
 * they come back marked as such rather than as ghosts that look like they are still running.
 */
function loadHistory(limit = 40) {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .map((j) => (['running', 'idle'].includes(j.status) ? { ...j, status: 'interrupted' } : j))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  } catch { return []; }
}

/* A gig is a BRIEF worth bidding on — the freelance channel's product, the way leads are the
   outreach channel's. Same discipline: recorded the moment it is read, deduped by URL because the
   same brief reached through two searches is one opportunity. */
function addGig(j, gig) {
  const g = { at: now(), ...gig };
  j.gigs = j.gigs || [];
  const key = (x) => (x.url || '').trim() || (x.title || '').trim().toLowerCase();
  if (j.gigs.some((x) => key(x) === key(g))) return null;
  j.gigs.push(g);
  bus.emit(j.id, { type: 'gig', jobId: j.id, gig: g });
  persist(j);
  return g;
}

/* A client's reply on an offer we already sent — the inbox role's product. Deduped by URL + the
   first words of the message, so re-reading the same thread does not report it twice. */
/* One day's analytics numbers from a reach role — deduped per day, so re-reading a page is safe. */
function addReach(j, row) {
  const r = { at: now(), ...row };
  j.reach = j.reach || [];
  if (!r.day || j.reach.some((x) => x.day === r.day)) return null;
  j.reach.push(r);
  bus.emit(j.id, { type: 'reach', jobId: j.id, reach: r });
  persist(j);
  return r;
}

/* One keyword the SEO research found — deduped by the term (case-insensitive), so re-reading a tool
   page is safe. The research that shapes the pages that get indexed; structured, never prose. */
function addKeywords(j, row) {
  const r = { at: now(), ...row };
  j.keywords = j.keywords || [];
  const kw = String(r.keyword || '').trim().toLowerCase();
  if (!kw || j.keywords.some((x) => String(x.keyword || '').trim().toLowerCase() === kw)) return null;
  j.keywords.push(r);
  bus.emit(j.id, { type: 'keyword', jobId: j.id, keyword: r });
  persist(j);
  return r;
}

/* One search-term row read off the Search Console Performance page — deduped by term, so re-reading
   a page is safe. The measured-ranking twin of save_keywords (which is the pre-build research). */
function addSearch(j, row) {
  const r = { at: now(), ...row };
  j.searchQueries = j.searchQueries || [];
  const q = String(r.query || '').trim().toLowerCase();
  if (!q || j.searchQueries.some((x) => String(x.query || '').trim().toLowerCase() === q)) return null;
  j.searchQueries.push(r);
  bus.emit(j.id, { type: 'search', jobId: j.id, search: r });
  persist(j);
  return r;
}

/* The Search Console verification token the GB read off Google's "add property" screen — a single
   value the master plants into the app's env so the property can be verified. */
/*
 * THE STATE OF A PROPERTY, not its numbers.
 *
 * Performance is what a Search Console reader was built to read, and on a property that went live
 * yesterday it says nothing: nought clicks, one impression, average position four. Meanwhile the same
 * console is holding the things that ARE actionable on a fresh site — an unread message from Google,
 * a page-indexing report saying how many pages it accepted and why it refused the rest, whether the
 * sitemap was fetched, and whether there is a manual action, which would make every other number
 * moot. A reader that skips all of that and reports "no data yet" is technically honest and
 * practically useless.
 *
 * Findings accumulate: one call per thing seen, so a walk can report a message, three indexing
 * reasons and a sitemap without holding them all to the end and losing the lot if it is stopped.
 */
/* The addresses behind a row, cleaned: real http(s) URLs, deduped, order kept, bounded. */
function cleanPages(pages) {
  const out = [];
  for (const p of Array.isArray(pages) ? pages : []) {
    const u = String(p || '').trim();
    if (!/^https?:\/\//i.test(u)) continue;            // a row label or a count is not an address
    if (u.length > 500) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, 200);
}

function addGscHealth(j, row) {
  if (!row || !row.kind) return null;
  const r = {
    kind: String(row.kind).slice(0, 40),                 // message | indexing | sitemap | manual_action | vitals
    label: String(row.label || '').slice(0, 200),
    value: String(row.value ?? '').slice(0, 200),
    detail: String(row.detail || '').slice(0, 600),
    pages: cleanPages(row.pages),
    at: new Date().toISOString(),
  };
  j.gscHealth = j.gscHealth || [];
  /*
   * The same finding twice is the same finding — a walk that re-reads a tab must not double it.
   *
   * BUT A REPEAT THAT CARRIES ADDRESSES IS NOT A REPEAT. The walk records the reason row first
   * ("blocked by robots.txt = 9"), then opens it and reads the nine URLs behind it. That second call
   * has the same kind, label and value, so this check threw it away — and the addresses, which are
   * the only part anybody can act on, were silently lost. So: merge them in and hand the row back.
   */
  const already = j.gscHealth.find((x) => x.kind === r.kind && x.label === r.label && x.value === r.value);
  if (already) {
    const merged = cleanPages([...(already.pages || []), ...r.pages]);
    if (merged.length <= (already.pages || []).length) return null;   // nothing new: a true repeat
    already.pages = merged;
    already.at = r.at;
    if (r.detail && !already.detail) already.detail = r.detail;
    bus.emit(j.id, { type: 'gsc_health', jobId: j.id });
    persist(j);
    return already;
  }
  j.gscHealth.push(r);
  bus.emit(j.id, { type: 'gsc_health', jobId: j.id });
  persist(j);
  return r;
}

function addGscToken(j, token) {
  const t = String(token || '').trim();
  if (!t) return null;
  j.gscToken = t;
  bus.emit(j.id, { type: 'gsc_token', jobId: j.id });
  persist(j);
  return t;
}

/*
 * A product OPPORTUNITY the hunt found — the research roles' product, and the reason the hunt no
 * longer reports in prose. Every one carries its own EVIDENCE ROWS (url + the date the page showed),
 * because the hunt's whole claim is "a recurring, recent pain real people describe": without the
 * links and the dates that claim cannot be checked, and a narrative report is exactly where an
 * invented recency slips in. Deduped by name so re-reading a thread never doubles a candidate.
 */
function addOpportunity(j, o) {
  const r = { at: now(), ...o };
  j.opportunities = j.opportunities || [];
  const key = (x) => String(x.name || '').trim().toLowerCase();
  if (!key(r) || j.opportunities.some((x) => key(x) === key(r))) return null;
  j.opportunities.push(r);
  bus.emit(j.id, { type: 'opportunity', jobId: j.id, opportunity: r });
  persist(j);
  return r;
}

function addReply(j, reply) {
  const r = { at: now(), ...reply };
  j.replies = j.replies || [];
  const key = (x) => `${(x.url || '').trim()}|${(x.text || '').trim().slice(0, 80).toLowerCase()}`;
  if (j.replies.some((x) => key(x) === key(r))) return null;
  j.replies.push(r);
  bus.emit(j.id, { type: 'reply', jobId: j.id, reply: r });
  persist(j);
  return r;
}

/*
 * Structured OUTPUT a planning step hands to the next step — a script, a storyboard, any object or
 * text — under a name. This is the data seam of an automation: one step stores it, the next reads it
 * (the run threads j.data into the following step's goal). Not a record like a lead; an arbitrary value.
 */
function addResult(j, item) {
  j.results = j.results || [];
  const r = { at: now(), title: String(item.title || '').slice(0, 300),
    fields: (item.fields && typeof item.fields === 'object') ? item.fields : {},
    url: String(item.url || '').slice(0, 600), image: String(item.image || '').slice(0, 800),
    draft: String(item.draft || '').slice(0, 4000), kind: String(item.kind || '').slice(0, 60) };
  /* Same item twice is one: title + url is the identity. */
  const key = (x) => `${(x.title || '').trim().toLowerCase()}|${(x.url || '').trim()}`;
  if (j.results.some((x) => key(x) === key(r))) return null;
  j.results.push(r);
  if (j.workflowId) { try { require('./watcherFeed').upsert(j.workflowId, r); } catch (e) { /* feed best-effort */ } }
  bus.emit(j.id, { type: 'result', jobId: j.id, result: r });
  persist(j);
  return r;
}

function storeData(j, key, value) {
  j.data = j.data || {};
  const k = String(key || '').slice(0, 120).trim();
  if (!k) return j.data;
  j.data[k] = value;
  bus.emit(j.id, { type: 'data', jobId: j.id, key: k });
  persist(j);
  return j.data;
}

module.exports = { create, step, annotate, setReport, setVerifier, judge, isOver, switchedSession, addLead, addResult, addGig, addReply, addReach, addKeywords, addSearch, addGscToken, addGscHealth, addOpportunity, storeData, propose, decide, say, finish, stop, get, listFor, listAll, view, loadHistory, bus, jobs, DIR };
