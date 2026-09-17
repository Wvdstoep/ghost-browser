/**
 * THE ASSISTANT — one chat, one agent, inside Ghost Browser.
 *
 * The owner types in plain words ("do I have Facebook notifications I should react to?", "keep an eye
 * on my LinkedIn posts", "why does the watcher draft nothing?"). Each message is ONE TURN of the
 * operator harness (harness.js) with the assistant's identity (assistantPrompt.js) and the operator's
 * full hand of tools plus browsing (tools.js): the model decides itself whether the answer is already
 * in a watcher's feed, whether a watcher must run now, whether a one-off walk in a logged-in profile is
 * needed, or whether something has to be built (role + flow + watcher) or fixed. The turn ends with
 * reply({text, …}) — or with plain prose, which IS the reply — and the answer lands in the chat.
 *
 * A chat is a file: /profiles/operator/chats/<id>.json — the turns (user text, assistant text, the
 * steps the assistant took, its cards for the app), a title, timestamps. The transcript across turns
 * is not replayed to the model; the last turns are digested into the orientation so the conversation
 * stays coherent while every turn starts with a clean, bounded context.
 *
 * No express in here: server.js hands in `startTurn` (how to run a harness turn) so this can be tested
 * with a scripted model.
 */
const fs = require('fs');
const path = require('path');

const CHAT_DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'operator', 'chats');
const MAX_TURNS_KEPT = 200;
const HISTORY_TURNS = 12;

/** The assistant's exit: what it says to the owner, plus what the app can render as cards. */
const REPLY_SPEC = {
  name: 'reply',
  description: 'ANSWER the owner and end this turn. text = the answer in the owner\'s language, plain and complete (markdown is fine: short headings, bullets, bold). details = optional evidence/what you did for a "details" fold. cards = optional actions for the app: {kind:"results", watcherId, title} opens a watcher\'s results; {kind:"approvals", title} opens the approvals; {kind:"url", url, title} opens a page. status "blocked" only when you could not do what was asked.',
  schema: { type: 'object', properties: { text: { type: 'string' }, details: { type: 'string' }, cards: { type: 'array', items: { type: 'object' } }, status: { type: 'string', enum: ['done', 'blocked'] } }, required: ['text'] },
  map: ({ text, details, cards, status }) => ({ status: status === 'blocked' ? 'blocked' : 'done', summary: String(text || '').slice(0, 600), report: { answer: String(text || ''), details: details ? String(details) : '', cards: Array.isArray(cards) ? cards.slice(0, 8) : [] } }),
  proseIsReply: true,
};

/** Human labels for the steps the app shows — the tool name is the fallback. */
const STEP_LABELS = {
  gb_guide: 'Reading the guide', gb_memory_read: 'Reading my notes', gb_memory_write: 'Keeping a note',
  gb_logs: 'Reading the log', gb_runs_recent: 'Checking recent runs', gb_jobs: 'Checking jobs', gb_job: 'Reading a job', gb_sessions: 'Checking browser sessions', gb_look: 'Looking at the page', gb_busy: 'Checking the browser',
  gb_watchers: 'Checking watchers', gb_watcher_health: 'Checking watcher health', gb_watcher_feed: 'Reading watcher results', gb_watcher_config: 'Updating watcher settings', gb_watcher_posts: 'Updating watched posts', gb_watcher_run: 'Running the watcher', gb_watcher_wait: 'Waiting for the pass', gb_watcher_toggle: 'Switching the watcher', gb_watcher_probe: 'Reading the thread',
  gb_tools: 'Checking the tool palette', gb_roles: 'Checking roles', gb_role_get: 'Reading a role', gb_role_save: 'Creating a role', gb_role_update: 'Updating a role',
  gb_flows: 'Checking automations', gb_flow_get: 'Reading an automation', gb_flow_save: 'Saving an automation', gb_flow_run: 'Running an automation', gb_flow_wait: 'Waiting for the run', gb_flow_runs: 'Checking runs', gb_flow_run_status: 'Checking the run', gb_platforms: 'Checking platforms',
  gb_walk: 'Browsing for you', gb_walk_wait: 'Browsing…', save_task_list: 'Planning', update_task: 'Progress', reply: 'Answering',
};
const labelOf = (name) => STEP_LABELS[name] || String(name || '').replace(/^gb_/, '').replace(/_/g, ' ');
/* The exit and the plan bookkeeping are not "steps" the owner needs to see (the task list shows live). */
const HIDDEN_STEPS = new Set(['reply', 'finish', 'save_task_list', 'update_task']);

function makeAssistant({ dir = CHAT_DIR, startTurn, now = Date.now, log } = {}) {
  if (typeof startTurn !== 'function') throw new Error('assistant needs startTurn');
  const L = log || { info() {}, warn() {}, error() {} };
  const live = new Map();   // chatId → OperatorRun of the turn in flight

  const file = (id) => path.join(dir, String(id).replace(/[^a-z0-9_-]/gi, '') + '.json');
  const load = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
  const save = (c) => { fs.mkdirSync(dir, { recursive: true }); const f = file(c.id); fs.writeFileSync(f + '.tmp', JSON.stringify(c)); fs.renameSync(f + '.tmp', f); return c; };

  function list() {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => load(f.slice(0, -5))).filter(Boolean)
        .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, turns: c.turns.length, running: live.has(c.id) }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch { return []; }
  }
  function create(title) {
    const id = `chat-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return save({ id, title: String(title || 'New chat').slice(0, 80), createdAt: now(), updatedAt: now(), turns: [] });
  }
  function remove(id) { if (live.has(id)) return false; try { fs.unlinkSync(file(id)); } catch { /* gone */ } return true; }

  /** The last turns as the model sees them at the start of a new turn. */
  function historyDigest(c) {
    const t = c.turns.slice(-HISTORY_TURNS);
    if (!t.length) return '';
    return 'THE CONVERSATION SO FAR (oldest first):\n' + t.map((x) => `${x.role === 'user' ? 'Owner' : 'You'}: ${String(x.text || '').slice(0, x.role === 'user' ? 600 : 900)}`).join('\n');
  }

  /** Steps as the app shows them: one per tool call, with its (short) result. */
  function stepsOf(run) {
    const out = []; const ev = run.events || [];
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]; if (e.kind !== 'tool' || HIDDEN_STEPS.has(e.name)) continue;
      const r = ev.slice(i + 1, i + 4).find((x) => x.kind === 'result' && x.name === e.name);
      out.push({ name: e.name, label: labelOf(e.name), args: e.args && typeof e.args === 'object' ? JSON.stringify(e.args).slice(0, 200) : '', text: r ? String(r.text || '').slice(0, 300) : '', t: e.t });
    }
    return out.slice(-60);
  }

  function view(id) {
    const c = load(id); if (!c) return null;
    const run = live.get(id);
    const liveView = run ? { jobId: run.id, status: run.status, iterations: run.iterations, tasks: run.tasks, steps: stepsOf(run), startedAt: run.startedAt } : null;
    return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, turns: c.turns, live: liveView };
  }

  /** The turn's end: the answer becomes the assistant's turn in the chat. */
  function land(c0, run) {
    const c = load(c0.id) || c0;
    const rep = run.report || {};
    let text = String(rep.answer || '').trim();
    if (!text) text = String(run.finalLine || '').replace(/^(DONE|BLOCKED):\s*/, '').trim() || (run.status === 'stopped' ? 'Stopped.' : 'I could not finish this one.');
    if (run.status === 'error') text = `Something went wrong on my side: ${run.error || 'unknown error'}. Ask again and I will retry.`;
    c.turns.push({ role: 'assistant', text, t: now(), status: run.status, jobId: run.id, iterations: run.iterations, details: String(rep.details || ''), cards: Array.isArray(rep.cards) ? rep.cards : [], steps: stepsOf(run) });
    while (c.turns.length > MAX_TURNS_KEPT) c.turns.shift();
    c.updatedAt = now(); save(c); live.delete(c.id);
  }

  /** The owner speaks: a new turn, or — while one runs — a word into it. */
  function send(id, text) {
    const c = load(id); if (!c) return { error: 'no such chat' };
    const t = String(text || '').trim(); if (!t) return { error: 'say something' };
    const running = live.get(id);
    if (running) { running.say(t); c.turns.push({ role: 'user', text: t, t: now(), spoken: true }); c.updatedAt = now(); save(c); return { ok: true, spoken: true, jobId: running.id }; }
    c.turns.push({ role: 'user', text: t, t: now() });
    if (c.title === 'New chat' || !c.title) c.title = t.slice(0, 60);
    c.updatedAt = now(); save(c);
    const run = startTurn({ goal: t, orientation: () => historyDigest(c), finishSpec: REPLY_SPEC, meta: { chatId: c.id } });
    hook(c, run);
    return { ok: true, jobId: run.id };
  }

  /** The turn's promise (`run.done`, set by whoever started it) lands the answer when it settles. */
  function hook(c, run) {
    live.set(c.id, run);
    const p = run.done && typeof run.done.then === 'function' ? run.done : Promise.resolve();
    p.then(() => land(c, run), (e) => { L.error(`[assistant] turn ${run.id}: ${(e && e.message) || e}`); land(c, run); });
  }

  /** A turn resumed after a restart re-attaches to its chat so its answer still lands. */
  function attach(run) { const id = run && run.meta && run.meta.chatId; const c = id && load(id); if (!c) return false; hook(c, run); return true; }
  function stop(id) { const r = live.get(id); if (!r) return { error: 'nothing running' }; r.stop(); return { ok: true }; }

  return { list, create, remove, view, send, stop, attach, land, live, labelOf, REPLY_SPEC, CHAT_DIR: dir };
}

module.exports = { makeAssistant, REPLY_SPEC, labelOf, CHAT_DIR };
