/*
 * practice.js — THE PLATFORM AND ROLE COLLECTOR: A THIN ROLE DOES ITS OWN JOB, SIGNED IN.
 *
 * The collector in harvest.js is the BASE collector: random public sites, random read-and-record
 * tasks, no login, no role. That is exactly what the base adapter needs and exactly what a
 * platform or a role adapter cannot learn from - a Facebook reply role has never seen a Facebook
 * page in the public collector's data, because the public collector may not sign in.
 *
 * So this is the other collector. It takes the thinnest role whose platform has a profile with a
 * saved login, asks the teacher for tasks THAT ROLE would receive, and runs them as that role in
 * that profile, one at a time. Every turn of such a run lands on the role and on the platform, and
 * the judge grades it like any other. The platform's habits arrive from the platform's own pages.
 *
 * WHAT KEEPS IT SAFE, in code:
 *   - the act gate. Everything outward - a post, a reply, a message, a bid - is a proposal until
 *     the owner approves it; this collector refuses to run at all while automatic acting is on.
 *   - no accounts. A task that signs up, signs in, changes settings or handles a password is
 *     thrown away, whatever the role says.
 *   - a walk that needs a device (a real pointer, a login that lives on the phone) is handed to
 *     the device ring by startWalk, or refused with its reason; it never runs from here anyway.
 *   - one profile, one walk. A signed-in profile is a person's account; two walks in it fight.
 *   - a budget: CAP_PER_HOUR runs, and a role is not practised again for REST_MS after a run, so
 *     the thin roles take turns instead of one role taking the hour.
 *
 * Pure decisions here; the tick in server.js does the asking and the starting.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const harvest = require('./harvest');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'practice.json');

const CAP_PER_HOUR = 6;
const REST_MS = 60 * 60 * 1000;
const QUEUE_PER_ROLE = 6;
const KEEP_HISTORY = 300;

const ACCOUNT = /\b(sign ?up|signup|register|registration|create an? account|log ?in|login|sign ?in|password|2fa|two-factor|verification code|change (my |the )?(email|password|settings)|delete (my |the )?account)\b/i;
const TOOL_WORDS = harvest.TOOL_WORDS || /\b(run_script|fetch_data|read_table|choose_option|click_text|press_key|switch_tab|current_url|use_role)\b/i;

/* A profile named after its platform, and the two that are not. */
const ALIAS = { hn: 'hackernews', linkdin: 'linkedin', gmail: 'google' };

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 1)); fs.renameSync(`${p}.tmp`, p); };
const blank = () => ({ on: false, queue: [], recent: [], history: [], perRole: {}, stoppedBecause: '', current: null });
const load = () => ({ ...blank(), ...(readJson(FILE(), null) || {}) });
const save = (s) => { writeJson(FILE(), s); return s; };

const on = () => !!load().on;
function setOn(v) { const s = load(); s.on = !!v; if (v) s.stoppedBecause = ''; save(s); return s.on; }
function stop(why) { const s = load(); s.on = false; s.stoppedBecause = String(why || '').slice(0, 200); save(s); return s; }

/** The platform a profile holds a login for, from its name. '' when it is not a platform profile. */
function platformOfProfile(name, normalizeSite) {
  const key = String(name || '').toLowerCase().replace(/^p_/, '').replace(/-(watch|ads|flow|trends|aistudio)$/, '');
  if (ALIAS[key]) return ALIAS[key];
  return normalizeSite ? normalizeSite(key) : key;
}

/**
 * Which role to practise next.
 * @param gaps      harvest.roleGapsFrom rows: { role, platform, examples, needsRealUse }
 * @param logins    [{ profile, platform }] - profiles with a saved login and the platform they hold
 * @param perRole   { role: { lastAt } } - when each role was last practised
 */
function planFor({ gaps = [], logins = [], perRole = {}, now = Date.now(), restMs = REST_MS } = {}) {
  const byPlatform = new Map();
  for (const l of logins || []) if (l && l.platform && !byPlatform.has(l.platform)) byPlatform.set(l.platform, l.profile);
  const rows = (gaps || [])
    .filter((g) => g && g.platform && g.platform !== 'web' && byPlatform.has(g.platform))
    .filter((g) => { const last = Date.parse((perRole[g.role] || {}).lastAt || '') || 0; return !last || now - last > restMs; })
    .sort((a, b) => a.examples - b.examples);
  if (!rows.length) {
    const held = (gaps || []).filter((g) => g && g.platform && g.platform !== 'web').length;
    return { role: null, why: held ? 'every thin role on a signed-in platform was practised within the hour, or its platform has no profile with a login' : 'no thin role belongs to a platform' };
  }
  const g = rows[0];
  return { role: g.role, platform: g.platform, profile: byPlatform.get(g.platform), examples: g.examples, why: `${g.role} has ${g.examples} sighted example(s) and ${byPlatform.get(g.platform)} holds a ${g.platform} login` };
}

/** The brief: tasks this specialist would be handed, on its own platform, signed in. */
function askFor({ role = {}, platform = '', history = [], want = 6 } = {}) {
  const already = (history || []).filter((h) => h.role === role.name).slice(-20).map((h) => `- ${h.prompt}`).join('\n');
  const system = [
    'You write tasks for a browser agent that works as ONE specialist on ONE platform, signed in,',
    'to be used as TRAINING EXAMPLES for a smaller model. Write them exactly as the person who runs',
    'this specialist would type them: plain requests, no tool names, no step numbers.',
    '',
    'HARD RULES. A task that breaks one is thrown away:',
    '  - NEVER an account task: no signing up or in, no password, no verification code, no settings.',
    '  - Anything outward - a post, a reply, a message, a bid - is fine to ASK for: the agent drafts it',
    '    and a person approves it before it is sent. Write such tasks as the specialist would get them.',
    '  - Stay on the platform this specialist works on.',
    '',
    'WHAT MAKES ONE VALUABLE: it is the specialist\'s real job, it ends in something checkable',
    '(a draft, rows recorded, a page read and summarised), and it is specific enough to be wrong.',
    '',
    'One task per line. No numbering, no commentary, nothing else.',
  ].join('\n');
  const user = [
    `THE SPECIALIST: ${role.name || 'unknown'} on ${platform || 'its platform'}`,
    `What it does: ${String(role.description || '').slice(0, 400) || 'no description'}`,
    role.prompt ? `Its instructions, for context:\n${String(role.prompt).slice(0, 1500)}` : '',
    '',
    already ? `Already practised — write nothing resembling these:\n${already}` : 'Nothing practised yet.',
    '',
    `Write ${want} tasks.`,
  ].filter((x) => x !== '').join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Keep the safe ones. Outward acts are allowed here - the gate holds them; accounts never. */
function vet(lines, { history = [] } = {}) {
  const seen = new Set((history || []).map((h) => String(h.prompt || '').trim().toLowerCase()));
  const kept = [];
  const rejected = [];
  for (const raw of lines || []) {
    const p = String(raw || '').replace(/^\s*[-*\d.)\s]+/, '').replace(/^\[[^\]]+\]\s*/, '').trim();
    if (!p) continue;
    const why = (() => {
      if (p.length < 20) return 'too short to have a right answer';
      if (p.length > 500) return 'too long — that is a recipe, not a request';
      if (ACCOUNT.test(p)) return 'an account task — never';
      if (TOOL_WORDS.test(p)) return 'names a tool, which no person would type';
      if (seen.has(p.toLowerCase())) return 'already practised';
      return '';
    })();
    if (why) { rejected.push({ prompt: p.slice(0, 120), why }); continue; }
    seen.add(p.toLowerCase());
    kept.push(p);
  }
  return { kept, rejected };
}

/** Add tasks for one role, bounded per role. */
function push(role, platform, profile, prompts) {
  const s = load();
  const have = (s.queue || []).filter((q) => q.role === role).length;
  const room = Math.max(0, QUEUE_PER_ROLE - have);
  const add = (prompts || []).slice(0, room).map((prompt) => ({ prompt, role, platform, profile }));
  s.queue = [...(s.queue || []), ...add].slice(0, 60);
  save(s);
  return add.length;
}

/** The next task for a role, recorded as practised. */
function take(role) {
  const s = load();
  const i = (s.queue || []).findIndex((q) => q.role === role);
  if (i < 0) return null;
  const [entry] = s.queue.splice(i, 1);
  const now = Date.now();
  s.recent = [...(s.recent || []), now].filter((t) => now - t < 7200000);
  s.history = [...(s.history || []), { at: new Date(now).toISOString(), prompt: entry.prompt, role: entry.role, platform: entry.platform, profile: entry.profile, jobId: null }].slice(-KEEP_HISTORY);
  s.perRole[entry.role] = { ...(s.perRole[entry.role] || {}), lastAt: new Date(now).toISOString(), runs: ((s.perRole[entry.role] || {}).runs || 0) + 1 };
  s.current = { role: entry.role, platform: entry.platform, profile: entry.profile, prompt: entry.prompt, at: new Date(now).toISOString() };
  save(s);
  return entry;
}

function attachJob(jobId) {
  const s = load();
  const h = s.history || [];
  if (!h.length || !jobId) return null;
  h[h.length - 1] = { ...h[h.length - 1], jobId: String(jobId) };
  if (s.current) s.current.jobId = String(jobId);
  save(s);
  return h[h.length - 1];
}

/** Whether a run may start now - the same shape as the base collector's rule, one walk wide. */
function decide({ on: isOn = false, busy = false, autoAct = false, live = 0, queued = 0, recent = [], keys = null, now = Date.now() } = {}) {
  if (!isOn) return { run: false, why: 'the practice collector is off' };
  if (autoAct) return { run: false, why: 'automatic acting is ON — practice runs only while the act gate holds outward steps for approval' };
  if (busy || live > 0) return { run: false, why: 'a practice walk is still running' };
  const lastHour = (recent || []).filter((t) => now - t < 3600000).length;
  if (lastHour >= CAP_PER_HOUR) return { run: false, why: `${lastHour} runs in the last hour — the cap is ${CAP_PER_HOUR}` };
  if (keys && keys.usable === 0) return { run: false, why: 'every model key is out of allowance — waiting' };
  if (!queued) return { run: false, why: 'no task queued for the role to practise' };
  return { run: true, why: 'a role is thin, its platform is signed in, the browser is free' };
}

function state({ busy = false, keys = null, now = Date.now() } = {}) {
  const s = load();
  const lastHour = (s.recent || []).filter((t) => now - t < 3600000).length;
  return {
    on: !!s.on,
    stoppedBecause: s.stoppedBecause || '',
    current: s.current || null,
    queued: (s.queue || []).length,
    queue: (s.queue || []).slice(0, 12),
    lastHour, capPerHour: CAP_PER_HOUR,
    history: (s.history || []).slice(-20).reverse(),
    perRole: s.perRole || {},
    busy: !!busy,
    keys,
  };
}

module.exports = { on, setOn, stop, planFor, askFor, vet, push, take, attachJob, decide, state, load, save, platformOfProfile, CAP_PER_HOUR, REST_MS, QUEUE_PER_ROLE, FILE };
