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

const localPrompt = require('./localPrompt');

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
 * MISLABELLED TURNS — the model asked for one thing and a different thing ran.
 *
 * `download_file` was two tools under one name until 22 September 2026. The handler that actually
 * ran took whatever the page had GENERATED; the description the model was sometimes shown promised
 * a LINKED file fetched by `url` or by the index of a link, and that handler ignores `url`
 * completely. So a recorded call carrying a `url` is a turn where the intent and the effect do not
 * match, and after the rename that argument belongs to a different tool entirely.
 *
 * Such a turn teaches two wrong things at once: the wrong tool name for the intent, and an argument
 * that has no effect. Dropped — and counted, because a silent exclusion is one nobody can audit.
 *
 * Deliberately narrow. A `download_file` call with an `index` or no arguments did exactly what its
 * live handler does, so those stay: 14 authored roles depend on that behaviour and every one of
 * them is a media role that wants it.
 */
function mislabelled(turn) {
  const a = (turn && turn.action) || {};
  if (a.tool === 'download_file' && a.args && a.args.url) {
    return 'download_file carrying a url — that argument was ignored and now belongs to download_link';
  }
  return null;
}

/**
 * ONE JOB BECOMES A SEQUENCE OF DECISIONS.
 *
 * A turn is: everything observed so far, and the tool call the agent made next. That is exactly the
 * thing the model has to learn — not the prose, the CHOICE. The observation text is capped hard,
 * because a page's full text is thousands of tokens of noise around one decision, and a training set
 * made of page dumps teaches a model to read rather than to act.
 */
/**
 * DID THIS VERY CALL THROW?
 *
 * A tool that fails journals an `error` step naming itself within a step or two — `open: page.goto:
 * net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://www.reddit.com/...`. That makes the failure
 * attributable to the exact call rather than to the job, which is what lets the turn be dropped
 * without throwing away its neighbours.
 */
function threwRightAfter(steps, i) {
  const s = steps[i];
  if (!s || !s.tool) return false;
  const named = new RegExp(`^${String(s.tool).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  for (let k = i + 1; k < Math.min(i + 3, steps.length); k++) {
    const n = steps[k];
    if (!n) continue;
    if (n.kind === 'error' && named.test(String(n.text || n.detail || ''))) return true;
  }
  return false;
}

function turnsOf(job, { maxObs = 600, maxMarks = 2000, maxHistory = 6, keepThrown = false, onDrop = null } = {}) {
  const steps = Array.isArray(job && job.steps) ? job.steps : [];
  const goal = scrubText(String((job && job.goal) || ''));
  if (!goal) return [];
  const out = [];
  const history = [];

  for (const s of steps) {
    if (!s) continue;
    if (OBSERVE.has(s.kind)) {
      const t = scrubText(String(s.text || s.detail || '')).slice(0, maxObs);
      /*
       * THE NUMBERED LIST TRAVELS WITH THE OBSERVATION.
       *
       * Without it a turn whose answer is `click [13]` carries no information from which 13 could
       * follow, and training on it teaches the model to invent an index. Only looks recorded since
       * this was added carry marks; older jobs simply have none, which is the honest state and is
       * why the set is worth rebuilding as fresh runs land.
       */
      const marks = s.marks ? scrubText(String(s.marks)).slice(0, maxMarks) : undefined;
      if (t) history.push({ kind: s.kind, text: t, marks, url: s.url ? scrubText(String(s.url)).slice(0, 300) : undefined });
      if (history.length > maxHistory) history.shift();
      continue;
    }
    if (s.kind !== 'tool' || !s.tool) continue;
    /*
     * A CALL THAT FAILED IS NOT AN EXAMPLE. 1,471 of 72,673 recorded calls throw, and over a
     * thousand of those are a navigation to a host that refuses this machine. Teaching a model to
     * make a call that cannot work is worse than teaching it nothing — and the failure is
     * attributable to this exact call, so the turn goes and its neighbours stay.
     *
     * The narrow rule matters: 8,555 calls mention reddit.com and most are
     * `google({query:"site:reddit.com …"})`, which works perfectly. Searching ABOUT a site is not
     * navigating TO it, and a filter on the hostname would have discarded thousands of good turns.
     */
    const thrown = threwRightAfter(steps, steps.indexOf(s));
    if (thrown && !keepThrown) {
      /* Reported, not merely skipped. The pre-flight gate checks that no single exclusion ate the
         data, and an exclusion that does not report is one the gate cannot see — which is exactly
         the blind spot this filter was creating while claiming to be the important one. */
      if (onDrop) onDrop('the call itself threw');
      continue;
    }
    /* The decision itself. Arguments scrubbed, because a `type` call's text is often a real
       message to a real person and sometimes a credential somebody pasted. */
    out.push({
      goal,
      role: String((job && job.role) || 'general'),
      site: scrubText(String((job && job.profile) || '')),
      observed: history.slice(),
      action: { tool: String(s.tool), args: scrubValue(s.args || {}) },
      at: s.n || out.length + 1,
      /* Whether this is the job's OPENING move, which the step number cannot tell you: step 1 is
         the goal, so a first tool call usually sits at step 2. A turn with nothing observed is
         normally unusable — except this one, where having seen nothing is the whole situation. */
      first: out.length === 0,
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
  const tiers = { gold: 0, silver: 0, bronze: 0, void: 0 };
  const caught = {};
  const voidReasons = {};
  for (const job of (jobs || [])) {
    if (!job || !job.id) continue;
    const o = outcomeOf(job, deps);
    tiers[o.tier] = (tiers[o.tier] || 0) + 1;
    for (const f of o.failures) caught[f] = (caught[f] || 0) + 1;
    if (o.tier === 'void') voidReasons[o.voidReason || 'unknown'] = (voidReasons[o.voidReason || 'unknown'] || 0) + 1;
    labelled.push({ job, outcome: o });
  }

  /* Split by JOB, deterministically, before any turn is produced. */
  const train = [];
  const evalSet = [];
  const reject = [];
  const perRole = {};
  for (const { job, outcome } of labelled) {
    /*
     * VOID IS DROPPED ON THE FLOOR, in both directions.
     *
     * 950 of 2,223 jobs are void: 579 the owner stopped, 208 that ran out of model credit, 184 with
     * nothing to judge, 153 cut off by a deploy, 92 where the model's API died, 29 where the
     * browser closed. None of that is a decision the agent made. Rewarding it teaches nothing and
     * punishing it teaches the one lesson available — attempt less, finish sooner, never take on
     * anything long — which would be invisible in the loss and fatal in use.
     *
     * The credit ones also stop existing the moment the model runs on the ring: there is no
     * allowance to exhaust. They are an artefact of today's cloud LLM, not evidence about a policy.
     */
    if (outcome.tier === 'void') continue;

    /* Punished, and kept SEPARATE from the positives. See below for why not simply negative SFT. */
    if (outcome.tier === 'bronze') { reject.push({ job, outcome }); continue; }

    if (!keepTiers.has(outcome.tier)) continue;
    const role = String(job.role || 'general');
    perRole[role] = (perRole[role] || 0) + 1;
    if (perRole[role] > perRoleCap) continue;
    (hash(job.id) < evalFraction ? evalSet : train).push({ job, outcome });
  }

  /* Why each dropped turn was dropped, so the exclusion can be checked rather than trusted. */
  const dropped = {};
  /*
   * TWO MORE FILTERS, AND BOTH ARE ABOUT WEIGHT RATHER THAN CORRECTNESS.
   *
   * DEDUPE: 292 notification sweeps produce thousands of turns that differ only in a timestamp.
   * They add weight without adding information and they crowd out a role with twenty jobs.
   * Identity is (role, tool, arguments, the last thing seen) — the same decision in the same
   * situation, however many times it was recorded.
   *
   * PER-TOOL CAP: measured rather than assumed, and it turned out mild. `open` is 16.7% of calls
   * and `look` 10.4% — no tool dominates, so this trims a tail rather than rescuing a skew. It is
   * here because the distribution is a property of what was RUN, not of what is worth learning, and
   * a fleet that spends a month on one site would skew it hard.
   */
  const seenTurn = new Set();
  const perTool = {};
  const toolCap = opts.toolCap == null ? 4000 : opts.toolCap;

  const note = (why) => { dropped[why] = (dropped[why] || 0) + 1; };
  const toTurns = (rows, { dedupe = true, cap = true } = {}) => rows.flatMap(({ job, outcome }) => turnsOf(job, { ...opts, onDrop: note })
    .filter((t) => {
      const why = mislabelled(t);
      if (why) { dropped[why] = (dropped[why] || 0) + 1; return false; }
      /*
       * A decision taken with nothing seen is not reproducible — it is a guess that got recorded.
       * The opening move is the exception and it is the most informative turn there is: what do you
       * reach for when you know nothing yet. Keyed on the turn, not the step number, because step 1
       * is the goal and the first call sits at step 2 — which made the first version of this filter
       * discard every job's first decision.
       */
      if (!t.observed.length && !t.first) { dropped['nothing had been observed yet'] = (dropped['nothing had been observed yet'] || 0) + 1; return false; }
      if (dedupe) {
        /*
         * THE KEY IS THE TRAINING EXAMPLE ITSELF: goal, role, what was last seen, and the call.
         *
         * The goal was missing at first, and that made this quietly too aggressive — the goal is
         * part of the PROMPT, so two turns under different goals are different examples even when
         * the completion matches. "find three suppliers" and "find complaints about X" both opening
         * with the same search are two lessons, not one, and collapsing them discards real variety.
         */
        /* The marks belong in the key: two `click [3]` turns with the same goal on two different
           pages are two different decisions, and collapsing them keeps whichever came first while
           silently discarding the other page entirely. */
        const lastObs = t.observed[t.observed.length - 1] || {};
        const key = `${t.goal}|${t.role}|${t.action.tool}|${JSON.stringify(t.action.args)}|${lastObs.text || ''}|${lastObs.marks || ''}`;
        if (seenTurn.has(key)) { dropped['an identical decision in an identical situation'] = (dropped['an identical decision in an identical situation'] || 0) + 1; return false; }
        seenTurn.add(key);
      }
      if (cap) {
        perTool[t.action.tool] = (perTool[t.action.tool] || 0) + 1;
        if (perTool[t.action.tool] > toolCap) { dropped[`more than ${toolCap} examples of one tool`] = (dropped[`more than ${toolCap} examples of one tool`] || 0) + 1; return false; }
      }
      return true;
    })
    .map((t) => ({
      ...t, jobId: job.id, tier: outcome.tier, verified: outcome.external,
      ...(outcome.failures && outcome.failures.length ? { failed: outcome.failures } : {}),
    })));

  const trainTurns = toTurns(train);
  const evalTurns = toTurns(evalSet);
  /*
   * The reject pile is the one place a failed call BELONGS: it is the example of what not to do.
   * Kept undeduped and uncapped too — there are only 152 such jobs and every one is scarce.
   */
  const rejectTurns = reject.flatMap(({ job, outcome }) => turnsOf(job, { ...opts, keepThrown: true }).map((t) => ({
    ...t, jobId: job.id, tier: outcome.tier, verified: outcome.external,
    ...(outcome.failures && outcome.failures.length ? { failed: outcome.failures } : {}),
  })));

  return {
    manifest: {
      builtAt: new Date().toISOString(),
      jobsSeen: labelled.length,
      tiers,
      /* What the verifiers CAUGHT — a claim the job's own record contradicts. The most useful
         number in here, and the reason to keep adding verifiers. */
      claimsCaught: caught,
      /* And what was excluded as nobody's fault, so the exclusion is auditable rather than silent. */
      voidReasons,
      /* Turns thrown away because the call and its effect disagreed. See mislabelled(). */
      droppedTurns: dropped,
      kept: { train: train.length, eval: evalSet.length, reject: reject.length },
      turns: { train: trainTurns.length, eval: evalTurns.length, reject: rejectTurns.length },
      perRoleCap,
      toolCap,
      evalFraction,
      keptTiers: [...keepTiers],
      roles: Object.fromEntries(Object.entries(perRole).sort((a, b) => b[1] - a[1]).slice(0, 40)),
    },
    train: trainTurns,
    eval: evalTurns,
    /*
     * HOW FAILURE IS PUNISHED, AND WHY NOT AS NEGATIVE SFT.
     *
     * Supervised fine-tuning with a negative weight is unstable and pushes probability mass
     * nowhere in particular. The working method for a set shaped like this one is preference
     * optimisation, and specifically the unpaired kind (KTO): a pile of desirable examples and a
     * pile of undesirable ones, with no requirement that they pair up — which is exactly what 379
     * gold and 116 bronze are, since almost no bronze job has a gold twin doing the same task.
     *
     * So these are emitted as their own file, marked with WHICH check failed, and never mixed into
     * the positives. 116 is a small pile, and that is the honest state: the corpus contains very
     * little genuine misbehaviour once interruptions are removed.
     */
    reject: rejectTurns,
  };
}

/**
 * One JSONL line per turn, in the chat shape a tool-use fine-tune expects.
 *
 * THE PROMPT IS NOT WRITTEN HERE. It comes from localPrompt.js, the same file the local model is
 * served with, because the alternative has already cost one round: the first set built by this
 * function carried a hundred-character system prompt with no tool catalogue, while the live agent
 * sends the whole catalogue on every call. A model trained on one prompt and served another
 * underperforms its own evaluation for reasons that are almost impossible to find afterwards.
 *
 * `tools` is passed IN rather than required here. agent.js is the other end of this system and
 * requiring it from the builder makes a cycle; handing the catalogue in also lets a test build a
 * set without loading the entire agent.
 */
function toJsonl(turns, { tools = [], toolsFor = null, playbookFor = null } = {}) {
  /* Built once per role rather than once per turn: the catalogue is identical for every turn of a
     role and there are tens of thousands of turns. */
  const cache = new Map();
  const forRole = (role) => {
    if (!toolsFor) return tools;
    if (!cache.has(role)) cache.set(role, toolsFor(role) || tools);
    return cache.get(role);
  };
  return turns.map((t) => JSON.stringify({
    messages: [
      /*
       * THE ROLE'S OWN TOOLS, NOT EVERY TOOL.
       *
       * The live agent calls roles.toolsFor(role, TOOLS) and a role sees only what it may reach for
       * — a specialist is handed twenty-six tools, not sixty-six. Training on the full catalogue
       * would be the same train-and-serve mismatch as omitting it, one layer down, and it teaches
       * the model to consider tools that will not be on offer when it runs.
       */
      { role: 'system', content: localPrompt.systemFor({ role: t.role, site: t.site, tools: forRole(t.role), playbook: playbookFor ? playbookFor(t.role) : '' }) },
      { role: 'user', content: localPrompt.userFor({ goal: t.goal, observed: t.observed }) },
      { role: 'assistant', content: JSON.stringify({ tool: t.action.tool, args: t.action.args }) },
    ],
    meta: { jobId: t.jobId, tier: t.tier, verified: t.verified, role: t.role, at: t.at },
  })).join('\n');
}

module.exports = { build, turnsOf, toJsonl, scrubText, scrubValue, mislabelled, DROP_FIELDS, SCRUBS };
