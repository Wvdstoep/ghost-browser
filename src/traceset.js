/*
 * traceset.js — THE RECORDED RUNS, TURNED INTO A TRAINING SET THAT IS SAFE TO MOVE.
 *
 * Every job already stores what the agent did as `{n, at, kind, tool, args, text}` steps, which is a
 * function-calling dataset that nobody had to write: 155,365 steps, 72,661 of them a tool call with
 * its real arguments, all made against real logged-in pages. This turns that into training turns.
 *
 * Three rules, and each one exists because ignoring it ruins the result:
 *
 *   1. SCRUB BEFORE ANYTHING LEAVES. The corpus holds 533 files with an email address in them, plus
 *      a Search Console token and a Facebook CSRF pair. A training set is copied, shared and
 *      eventually uploaded, so redaction happens HERE, on the way out, not as a later step somebody
 *      forgets. Anything unrecognised is dropped rather than passed through.
 *   2. LABEL FROM VERIFIERS, NOT FROM THE REPORT. See verify.js. The agent's own summary is
 *      testimony; a model trained on testimony learns to testify.
 *   3. CUT THE EVALUATION SPLIT FIRST. Held back before a single turn is written, by JOB and never by
 *      turn — turns from one job are near-duplicates of each other, so splitting by turn leaks the
 *      answer into the exam and every later measurement becomes a lie that flatters the model.
 */
'use strict';

const { outcomeOf } = require('./verify');

/* ── redaction ──────────────────────────────────────────────────────────────────────────────── */

/** Fields dropped whole: identity, plumbing, and anything that is a credential by nature. */
const DROP_FIELDS = new Set(['owner', 'companyId', 'sessionId', 'sink', 'gscToken', 'workflowId', 'runId']);

/**
 * Values that must never survive, matched on the text rather than the field name — a token pasted
 * into a step's arguments does not arrive under a helpful key.
 */
const SCRUBS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  [/\bya29\.[A-Za-z0-9_-]{10,}/g, '<token>'],
  [/\bgb_[A-Za-z0-9]{8,}/g, '<key>'],
  [/\b(?:Bearer|bearer)\s+[A-Za-z0-9._-]{12,}/g, 'Bearer <token>'],
  [/("(?:fb_dtsg|lsd|jazoest|__hs|__rev|__hsi|__spin_t|__spin_r|av|__user)"\s*:\s*")[^"]{4,}(")/g, '$1<token>$2'],
  /* No leading \b: a word boundary cannot exist before a "+", so the anchored version silently
     matched nothing and every international number in the corpus would have shipped verbatim. */
  [/(?:\+|\b00)[0-9][0-9\s().-]{7,}[0-9]/g, '<phone>'],
  [/("(?:password|pass|pwd|secret|apiKey|api_key|token)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2'],
];

/** Redact a string. Order matters: the specific patterns run before the greedy ones. */
function scrubText(s) {
  let out = String(s == null ? '' : s);
  for (const [re, to] of SCRUBS) out = out.replace(re, to);
  return out;
}

/** Redact any JSON-able value, recursively, dropping keys that are credentials by name. */
function scrubValue(v, depth = 0) {
  if (depth > 6) return null;
  if (v == null) return v;
  if (typeof v === 'string') return scrubText(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => scrubValue(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (DROP_FIELDS.has(k)) continue;
      if (/pass|secret|token|cookie|auth|key$/i.test(k)) { out[k] = '<redacted>'; continue; }
      out[k] = scrubValue(val, depth + 1);
    }
    return out;
  }
  return null;
}

/* ── turns ──────────────────────────────────────────────────────────────────────────────────── */

const OBSERVE = new Set(['read', 'open', 'look', 'click', 'scroll', 'note', 'blocked']);

/**
 * ONE JOB BECOMES A SEQUENCE OF DECISIONS.
 *
 * A turn is: everything observed so far, and the tool call the agent made next. That is exactly the
 * thing the model has to learn — not the prose, the CHOICE. The observation text is capped hard,
 * because a page's full text is thousands of tokens of noise around one decision, and a training set
 * made of page dumps teaches a model to read rather than to act.
 */
function turnsOf(job, { maxObs = 600, maxHistory = 6 } = {}) {
  const steps = Array.isArray(job && job.steps) ? job.steps : [];
  const goal = scrubText(String((job && job.goal) || ''));
  if (!goal) return [];
  const out = [];
  const history = [];

  for (const s of steps) {
    if (!s) continue;
    if (OBSERVE.has(s.kind)) {
      const t = scrubText(String(s.text || s.detail || '')).slice(0, maxObs);
      if (t) history.push({ kind: s.kind, text: t, url: s.url ? scrubText(String(s.url)).slice(0, 300) : undefined });
      if (history.length > maxHistory) history.shift();
      continue;
    }
    if (s.kind !== 'tool' || !s.tool) continue;
    /* The decision itself. Arguments scrubbed, because a `type` call's text is often a real
       message to a real person and sometimes a credential somebody pasted. */
    out.push({
      goal,
      role: String((job && job.role) || 'general'),
      site: scrubText(String((job && job.profile) || '')),
      observed: history.slice(),
      action: { tool: String(s.tool), args: scrubValue(s.args || {}) },
      at: s.n || out.length + 1,
    });
  }
  return out;
}

/* ── the set ────────────────────────────────────────────────────────────────────────────────── */

/** Deterministic hash, so the same job lands in the same split on every rebuild. */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/**
 * Build the set.
 *
 * `perRoleCap` is not tidiness: facebook-notification-watch has 292 jobs and learn.shot has 84, so
 * without a cap the model learns to be a notification sweeper that occasionally takes screenshots.
 *
 * @param {object[]} jobs      every job record
 * @param {object}   deps      { files, recordings } for the verifiers
 * @param {object}   opts      { evalFraction, perRoleCap, keepTiers }
 */
function build(jobs, deps = {}, opts = {}) {
  const evalFraction = opts.evalFraction == null ? 0.15 : opts.evalFraction;
  const perRoleCap = opts.perRoleCap == null ? 120 : opts.perRoleCap;
  const keepTiers = new Set(opts.keepTiers || ['gold', 'silver']);

  const labelled = [];
  const tiers = { gold: 0, silver: 0, bronze: 0 };
  const caught = {};
  for (const job of (jobs || [])) {
    if (!job || !job.id) continue;
    const o = outcomeOf(job, deps);
    tiers[o.tier] = (tiers[o.tier] || 0) + 1;
    for (const f of o.failures) caught[f] = (caught[f] || 0) + 1;
    labelled.push({ job, outcome: o });
  }

  /* Split by JOB, deterministically, before any turn is produced. */
  const train = [];
  const evalSet = [];
  const perRole = {};
  for (const { job, outcome } of labelled) {
    if (!keepTiers.has(outcome.tier)) continue;
    const role = String(job.role || 'general');
    perRole[role] = (perRole[role] || 0) + 1;
    if (perRole[role] > perRoleCap) continue;
    (hash(job.id) < evalFraction ? evalSet : train).push({ job, outcome });
  }

  const toTurns = (rows) => rows.flatMap(({ job, outcome }) => turnsOf(job, opts).map((t) => ({
    ...t, jobId: job.id, tier: outcome.tier, verified: outcome.external,
  })));

  const trainTurns = toTurns(train);
  const evalTurns = toTurns(evalSet);

  return {
    manifest: {
      builtAt: new Date().toISOString(),
      jobsSeen: labelled.length,
      tiers,
      /* What the verifiers CAUGHT — a claim the job's own record contradicts. The most useful
         number in here, and the reason to keep adding verifiers. */
      claimsCaught: caught,
      kept: { train: train.length, eval: evalSet.length },
      turns: { train: trainTurns.length, eval: evalTurns.length },
      perRoleCap,
      evalFraction,
      keptTiers: [...keepTiers],
      roles: Object.fromEntries(Object.entries(perRole).sort((a, b) => b[1] - a[1]).slice(0, 40)),
    },
    train: trainTurns,
    eval: evalTurns,
  };
}

/** One JSONL line per turn, in the chat shape a tool-use fine-tune expects. */
function toJsonl(turns) {
  return turns.map((t) => JSON.stringify({
    messages: [
      { role: 'system', content: `You are Ghost Browser working as ${t.role}${t.site ? ` in the ${t.site} profile` : ''}. Answer with one tool call.` },
      { role: 'user', content: `GOAL: ${t.goal}\n\nSEEN SO FAR:\n${t.observed.map((o) => `- ${o.kind}: ${o.text}`).join('\n') || '- nothing yet'}` },
      { role: 'assistant', content: JSON.stringify({ tool: t.action.tool, args: t.action.args }) },
    ],
    meta: { jobId: t.jobId, tier: t.tier, verified: t.verified, role: t.role, at: t.at },
  })).join('\n');
}

module.exports = { build, turnsOf, toJsonl, scrubText, scrubValue, DROP_FIELDS, SCRUBS };
