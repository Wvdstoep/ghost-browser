/*
 * harvest.js — COLLECTING TRAINING DATA WITHOUT SOMEBODY TYPING ALL DAY.
 *
 * Every run in this corpus was typed by the owner, one at a time, and waited for. That is why the
 * set is 2,313 runs after months rather than after a week, and why it leans on whatever the owner
 * happened to be curious about: `open` has four thousand examples and `choose_option` had TWO until
 * this afternoon, when a prompt was written by hand specifically to exercise it.
 *
 * So this is the same loop the owner was performing, done by the browser: one run at a time, the
 * next starting when the last one ends, with the prompts chosen from what the corpus is MISSING
 * rather than from what anybody feels like asking.
 *
 * THREE THINGS IT IS DELIBERATELY NOT.
 *
 *   IT IS NOT A SECOND WALK MACHINE. It hands prompts to startWalk, the same path the chat uses.
 *     A parallel mechanism would drift: different budgets, different journalling, a second place
 *     where a bug has to be fixed twice.
 *   IT IS NOT UNBOUNDED. Each run costs model credit and this business runs on nothing. The cap is
 *     per hour, it is checked before every dispatch, and running out of allowance switches the
 *     whole thing off rather than retrying into an empty account.
 *   IT IS NOT LOGGED IN. Unattended work stays on public pages. A loop that drives the owner's real
 *     accounts while nobody is watching is how an account gets restricted, and the standing rule
 *     here is that accounts are born and used by a person, not by a scheduler.
 *
 * WHAT MAKES THE PROMPTS WORTH RUNNING, WHICH IS THE WHOLE POINT.
 *
 * A model asked for "some browser tasks" writes twenty variations of searching Google. The value is
 * in the gaps, and the gaps are measured: the built set knows how many examples each tool has, the
 * verifiers know which run shapes can be confirmed from outside, and the round store knows what has
 * already been trained on. Those numbers go into the request, so the engine asks for work that
 * exercises `read_table` when read_table has forty examples, and asks for work that RECORDS things
 * when the corpus is short of runs that anything external can confirm.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'harvest.json');

/*
 * Twelve runs an hour, which is one every five minutes, and a walk takes two to ten. So the cap
 * binds only when runs are quick — it is there to stop a runaway, not to pace the normal case.
 */
const CAP_PER_HOUR = 12;

/** Ask for more prompts while a few are still queued, so the loop never waits on a model call. */
const QUEUE_LOW = 3;
const QUEUE_MAX = 40;

/** Enough history that the generator can be told what not to repeat, bounded so the file stays small. */
const KEEP_HISTORY = 300;

/*
 * VETTING IS CODE, NOT AN INSTRUCTION.
 *
 * The generator is told to produce read-and-record work only. It will sometimes produce "post a
 * reply" anyway, and an instruction that is only in a prompt is an instruction that holds until the
 * model has a bad day. A rejected prompt costs nothing — the engine simply asks for more — so these
 * err heavily towards refusing.
 */
/*
 * A NOUN IS NOT AN ACT, AND HALF THESE WORDS ARE BOTH.
 *
 * The first version listed the verbs flat and threw away a perfectly good Project Gutenberg task on
 * its very first batch: "open the first 5 results ... each book" was refused as an outward act
 * because `book` was on the list. So are `post`, `order`, `like`, `share`, `buy` and `pay` — every
 * one of them an ordinary noun. Refusing those does not merely waste a model call, it silently
 * excludes whole subjects: anything about books, orders, posts or prices.
 *
 * So two lists. The first have no innocent reading and match anywhere. The second count only where
 * a verb can actually stand — the start of a clause, or after and/then/to/please/also — which is
 * where an instruction to DO something sits. "Set the sort order to price", "in order to" and "the
 * first post" all survive; "Post a reply", "Send them a message" and "Book a table" do not.
 */
const OUTWARD_ALWAYS = /\b(comment|commenting|reply|replying|message|messaging|dm|publish|publishing|subscribe|unsubscribe|upvote|downvote|donate|checkout|purchase|retweet|repost)\b/i;
const OUTWARD_VERB = /(?:^|[.;:!?]\s*|\band\s+|\bthen\s+|\bto\s+|\bplease\s+|\balso\s+)(post|send|apply|bid|follow|like|share|book|buy|order|pay|vote|rate|review)\b/i;
const OUTWARD = { test: (s) => OUTWARD_ALWAYS.test(s) || OUTWARD_VERB.test(s) };
const ACCOUNT = /\b(sign ?up|signup|register|registration|create an? account|log ?in|login|sign ?in|password|verify my|confirm my email)\b/i;
/*
 * Off limits from a datacentre address. LinkedIn and Upwork both read the cluster's IP as a robot
 * and a refused walk teaches the model nothing except what a block page looks like; the owner's own
 * device is where that work belongs.
 */
const OFF_LIMITS = /\b(linkedin|upwork|fiverr|freelancer|indeed|glassdoor)\b/i;
/** A prompt that names a tool is not a prompt a person would type, and train/serve parity is the point. */
const TOOL_WORDS = /\b(run_script|fetch_data|read_table|choose_option|click_text|press_key|save_lead|save_place|switch_tab|current_url|download_link|make_document|screenshot_page|use_role)\b/i;

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* there already */ }
  fs.writeFileSync(p, JSON.stringify(v, null, 1));
};

const blank = () => ({ on: false, queue: [], recent: [], history: [], stoppedBecause: '', aiming: [] });
const load = () => ({ ...blank(), ...(readJson(FILE(), null) || {}) });
const save = (s) => { writeJson(FILE(), s); return s; };

const on = () => !!load().on;
function setOn(v) {
  const s = load();
  s.on = !!v;
  /* Turning it on clears the reason it stopped, or the screen keeps explaining a decision the owner
     has already overridden. */
  if (s.on) s.stoppedBecause = '';
  return save(s).on;
}

/*
 * TOOLS THE COLLECTOR MUST NEVER GO AFTER, however empty their column is.
 *
 * gapsFrom reads the live catalogue so a tool shipped next month becomes a target on its first day.
 * That is the right default and it produced this on its first real batch, on screen, as something
 * the loop was aiming at:
 *
 *     save_totp_secret (0)   act (0)
 *
 * The first is a two-factor secret. The second is the approval-gated outward action. A count of zero
 * is not an argument for exercising either, and "it had no examples" is exactly the reasoning that
 * would have had a scheduler collecting authenticator codes overnight.
 *
 * So the gap list is narrowed by KIND rather than by name-matching, and the four kinds are:
 *
 *   CREDENTIALS.       Anything touching a secret or a token. Never, by anything unattended.
 *   OUTWARD ACTS.      act, and replying — the things that cannot be unsaid.
 *   THE OWNER'S OWN.   Their voice, their writing, their conversations, their profiles, their
 *                      knowledge base. Unattended work has no business writing to any of it.
 *   SPENDING.          Recording video and generating images cost real infrastructure per run, and
 *                      a loop is the wrong place to discover that.
 *
 * Everything left is browsing, reading, and recording what was found - which is the whole of what
 * this engine is for.
 */
const NEVER_CHASE = new Set([
  // credentials
  'save_totp_secret', 'totp_code', 'save_gsc_token', 'save_gsc_health',
  // outward acts
  'act', 'record_reply', 'save_reply', 'upload_file', 'upload_image', 'paste_image',
  // the owner's own identity and memory
  'use_my_profile', 'use_profile', 'describe_my_voice', 'remember_about_me', 'save_my_writing',
  'remember_conversation', 'managed_conversations', 'conversation', 'waiting_on', 'whose_is_this',
  'knowledge_store', 'save_gig', 'save_reach',
  // things that spend real infrastructure per call
  'start_recording', 'stop_recording', 'make_brand_image',
]);

/**
 * WHAT THE CORPUS IS SHORT OF, as a list a person can read and a model can act on.
 *
 * Tools only, and by count rather than by share: a share tells you `open` is 18% of the set, which
 * is interesting and not actionable. "choose_option has 2 examples" is actionable, and it is the
 * sentence that produces a prompt about a dropdown.
 *
 * `known` is the live tool catalogue rather than a list kept here, so a tool added next month shows
 * up as a gap on the day it ships instead of being quietly absent for ever.
 */
function gapsFrom({ perTool = {}, known = [], floor = 200 } = {}) {
  const counted = new Map(Object.entries(perTool));
  const rows = [];
  for (const name of known) {
    /* A count of zero is not an argument for handling a two-factor secret. See NEVER_CHASE. */
    if (NEVER_CHASE.has(name)) continue;
    const n = Number(counted.get(name) || 0);
    if (n < floor) rows.push({ tool: name, examples: n });
  }
  /* Thinnest first: the tool with nothing is where a single run changes the most. */
  rows.sort((a, b) => a.examples - b.examples);
  return rows;
}

/**
 * The request put to the model. Grounded in the three numbers that actually decide value.
 *
 * Written as a plain brief rather than a schema, because a schema produces prompts that read like
 * form fields, and the whole requirement is that these read like a person typing.
 */
function askFor({ gaps = [], history = [], want = 8, sites = [] } = {}) {
  const thin = gaps.slice(0, 12).map((g) => `${g.tool} (${g.examples} example${g.examples === 1 ? '' : 's'})`).join(', ');
  const already = history.slice(-40).map((h) => `- ${h.prompt}`).join('\n');
  const where = sites.length ? sites.join(', ') : 'any public Dutch or international site that needs no login';

  const system = [
    'You write tasks for a browser agent, to be used as TRAINING EXAMPLES for a smaller model.',
    '',
    'Write them exactly as a person would type them to an assistant. No tool names, no step numbers,',
    'no urls you have not seen — name a site by its domain if you must and let the agent find the page.',
    '',
    'HARD RULES. A task that breaks one of these is thrown away:',
    '  - READ AND RECORD ONLY. Never post, comment, reply, message, apply, buy, book, pay or follow.',
    '  - NO ACCOUNTS. Never sign up, register, log in or handle a password.',
    '  - PUBLIC PAGES ONLY. Nothing that needs a login.',
    '  - NOT LinkedIn, Upwork, Fiverr, Freelancer, Indeed or Glassdoor.',
    '',
    'WHAT MAKES ONE VALUABLE, in order:',
    '  1. It forces the agent to use a browser skill the training set is short of (below).',
    '  2. It ends in something CHECKABLE — rows recorded, a file downloaded, a document written —',
    '     because a task that only reads leaves nothing anyone outside the agent can confirm.',
    '  3. It is specific enough to have a right answer, so a wrong one is visible.',
    '',
    'One task per line. No numbering, no commentary, nothing else.',
  ].join('\n');

  const user = [
    `The training set is short of these skills: ${thin || 'nothing in particular'}.`,
    '',
    `Where to work: ${where}.`,
    '',
    already ? `Already collected — write nothing resembling these:\n${already}` : 'Nothing collected yet.',
    '',
    `Write ${want} tasks.`,
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * Keep the ones that are safe and useful, and say why each of the others went.
 *
 * The rejections are returned rather than swallowed: a generator that has started producing "reply
 * to the top comment" every time is something the owner should be able to see on the screen, and a
 * silent filter looks identical to a model that has nothing left to suggest.
 */
function vet(lines, { history = [] } = {}) {
  const seen = new Set(history.map((h) => String(h.prompt || '').trim().toLowerCase()));
  const kept = [];
  const rejected = [];
  for (const raw of lines || []) {
    const p = String(raw || '').replace(/^\s*[-*\d.)\s]+/, '').trim();
    if (!p) continue;
    const why = (() => {
      if (p.length < 25) return 'too short to have a right answer';
      if (p.length > 400) return 'too long — that is a recipe, not a request';
      if (ACCOUNT.test(p)) return 'asks for an account or a sign-in';
      if (OUTWARD.test(p)) return 'asks for something other people would see';
      if (OFF_LIMITS.test(p)) return 'a site that refuses this address';
      if (TOOL_WORDS.test(p)) return 'names a tool, which no person would type';
      if (seen.has(p.toLowerCase())) return 'already collected';
      return '';
    })();
    if (why) { rejected.push({ prompt: p.slice(0, 120), why }); continue; }
    seen.add(p.toLowerCase());
    kept.push(p);
  }
  return { kept, rejected };
}

/*
 * BUSY MEANS RUNNING AND ALIVE, AND THE DIFFERENCE IS THE WHOLE FUNCTION.
 *
 * The collector's first version asked only whether any job had status 'running'. Measured within
 * minutes of shipping it: 160 jobs carried that status and the oldest had carried it for
 * twenty-eight days. A pod roll cuts a walk off mid-flight and nothing ever writes an ending for it,
 * so the status simply stays. The collector saw a permanently busy browser and never dispatched a
 * single run — the toggle was on, seven prompts were queued, and nothing happened.
 *
 * The training scheduler had already solved this, in decide(), with a comment explaining why: three
 * rounds died with SIGSEGV, and without a staleness window the first would have blocked every round
 * after it for ever while the screen read "training". This is that rule, applied to walks.
 *
 * A job carrying no timestamp at all counts as NOT alive. Guessing the other way is how the original
 * bug comes back, and the cost of being wrong is asymmetric: a collector that waits when it should
 * run loses a few minutes, a collector that runs on a busy browser fights the owner for it.
 */
const WALK_SILENT_MS = 10 * 60 * 1000;

function busyFrom(all, now = Date.now(), silentMs = WALK_SILENT_MS) {
  for (const j of all || []) {
    if (!j || j.status !== 'running') continue;
    const steps = j.steps && j.steps.length ? j.steps : null;
    const stamp = (steps && steps[steps.length - 1] && steps[steps.length - 1].at) || j.createdAt || '';
    const last = Date.parse(stamp) || 0;
    if (last && now - last < silentMs) return true;
  }
  return false;
}

/**
 * WHETHER TO START A RUN RIGHT NOW. A pure function of what is known, so it is testable and so the
 * screen and the loop can never disagree about the reason.
 */
function decide({ on: isOn = false, busy = false, queue = [], recent = [], capPerHour = CAP_PER_HOUR, now = Date.now() } = {}) {
  const no = (why) => ({ run: false, why });
  if (!isOn) return no('collection is switched off');
  /* The browser is one browser. Two walks in a profile is the thing startWalk already waits out,
     and queueing behind it here would only move the wait somewhere less visible. */
  if (busy) return no('a run is using the browser');
  const inHour = (recent || []).filter((t) => now - t < 3600000).length;
  if (inHour >= capPerHour) return no(`${inHour} run(s) in the last hour, and the cap is ${capPerHour}`);
  if (!(queue || []).length) return no('nothing queued — waiting for the next batch of prompts');
  return { run: true, why: `${queue.length} prompt(s) queued`, prompt: queue[0] };
}

/** Take the next prompt off the queue and record that it went. */
function take(jobId) {
  const s = load();
  const prompt = s.queue.shift();
  if (!prompt) return null;
  s.recent = [...(s.recent || []), Date.now()].filter((t) => Date.now() - t < 7200000);
  s.history = [...(s.history || []), { at: new Date().toISOString(), prompt, jobId: jobId || null }].slice(-KEEP_HISTORY);
  save(s);
  return prompt;
}

/** Add vetted prompts, newest last, bounded. */
function push(prompts, aiming = []) {
  const s = load();
  s.queue = [...(s.queue || []), ...(prompts || [])].slice(0, QUEUE_MAX);
  if (aiming.length) s.aiming = aiming.slice(0, 12);
  return save(s).queue.length;
}

/**
 * Switch off with a reason on the record.
 *
 * Used when the account runs out of allowance. A loop that kept dispatching into an empty account
 * would fill the corpus with void runs whose only lesson is what a billing error looks like, and it
 * would do it silently, which is worse.
 */
function stop(why) {
  const s = load();
  s.on = false;
  s.stoppedBecause = String(why || '').slice(0, 200);
  return save(s);
}

/** Everything the screen needs, in one read. */
function state({ busy = false, capPerHour = CAP_PER_HOUR, now = Date.now() } = {}) {
  const s = load();
  const plan = decide({ on: s.on, busy, queue: s.queue, recent: s.recent, capPerHour, now });
  return {
    on: !!s.on,
    queued: (s.queue || []).length,
    next: (s.queue || [])[0] || null,
    inLastHour: (s.recent || []).filter((t) => now - t < 3600000).length,
    capPerHour,
    collected: (s.history || []).length,
    aiming: s.aiming || [],
    stoppedBecause: s.stoppedBecause || '',
    plan,
    recent: (s.history || []).slice(-8).reverse(),
  };
}

module.exports = {
  on, setOn, state, decide, take, push, stop, vet, gapsFrom, askFor, load, busyFrom, WALK_SILENT_MS,
  CAP_PER_HOUR, QUEUE_LOW, QUEUE_MAX, FILE, NEVER_CHASE,
};
