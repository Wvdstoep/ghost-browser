/**
 * THE OPERATOR HARNESS — a Claude-Code-grade loop, self-contained in Ghost Browser.
 *
 * One job = one goal in plain words ("make a Reddit post watcher", "why does the LinkedIn watcher
 * draft nothing?"). The loop gives the model the operator's tools, feeds every result back, and
 * keeps the run honest with the mechanisms that make an agent loop survive real work:
 *
 *   - a TASK LIST the model writes first and updates (save_task_list / update_task): the plan is
 *     state, not prose, and it is re-anchored into context every 20 iterations;
 *   - an IDENTICAL-CALL BREAKER: the same tool with the same arguments (unless the tool is
 *     repeatable — a wait, a read) is refused with a nudge, and a run that keeps doing it stops;
 *   - a NO-PROGRESS BREAKER: a long streak of failed tool calls ends the run instead of the budget;
 *   - a BUDGET that grows with progress: a job starts with `startIterations` and earns more as tasks
 *     get done, never past `maxIterations`;
 *   - CONTEXT PRUNING with pinned orientation: when the transcript grows past the window, old tool
 *     results are trimmed to one line; the system prompt, the goal and the orientation stay;
 *   - a FINISH CONTRACT: the run ends through `finish({status, summary, report})` — DONE or BLOCKED,
 *     with a report a person and the app can read — and a model that stops calling tools without
 *     finishing is nudged, then finished as blocked;
 *   - a JOURNAL persisted after every iteration (events, tasks, report, the transcript for resume)
 *     so a pod that rolls mid-job loses nothing but the step in flight;
 *   - UNATTENDED by design: there is no ask_user; the owner can `say` something into the run and it
 *     arrives as the next user turn.
 */
const fs = require('fs');
const path = require('path');

const JOB_DIR = path.join(process.env.PROFILE_DIR || '/profiles', 'operator', 'jobs');
const MAX_RESULT_CHARS = 12000;
const MAX_CONTEXT_CHARS = 140000;
const RE_ANCHOR_EVERY = 20;

const clip = (v, n = MAX_RESULT_CHARS) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars trimmed — ask for less, or a narrower filter)` : (s || ''); };
const looksFailed = (out) => { const s = typeof out === 'string' ? out : JSON.stringify(out || {}); return /^\{"error"|refused|"error":|not found|failed:/i.test(String(s).slice(0, 200)); };

class OperatorRun {
  constructor({ id, goal, chat, llm, registry, systemPrompt, orientation, log, now = Date.now, startIterations = 150, maxIterations = 400, persistDir = JOB_DIR }) {
    if (!chat || !registry || !systemPrompt) throw new Error('OperatorRun needs chat, registry, systemPrompt');
    this.id = id || `op-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.goal = String(goal || '').trim();
    this.chat = chat; this.llm = llm || {}; this.registry = registry; this.systemPrompt = systemPrompt;
    this.orientation = typeof orientation === 'function' ? orientation : () => '';
    this.log = log || { info() {}, warn() {}, error() {} }; this.now = now;
    this.startIterations = startIterations; this.maxIterations = maxIterations; this.persistDir = persistDir;
    this.status = 'queued'; this.iterations = 0; this.budget = startIterations;
    this.tasks = []; this.events = []; this.messages = []; this.report = null; this.finalLine = '';
    this.startedAt = now(); this.endedAt = 0; this.error = null;
    this._pendingSay = []; this._stop = false; this._recentCalls = []; this._nudges = 0; this._failStreak = 0; this._repeatStreak = 0;
    this._registerBuiltins();
  }

  /* built-ins: the plan as state, and the only way out */
  _registerBuiltins() {
    const reg = this.registry;
    if (!reg.has('save_task_list')) reg.register('save_task_list', 'Write your plan as a task list (do this FIRST). Replaces the list.', { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, required: ['title'] } } }, required: ['tasks'] }, async ({ tasks }) => {
      this.tasks = (Array.isArray(tasks) ? tasks : []).slice(0, 30).map((t, i) => ({ i, title: String(t.title || '').slice(0, 200), note: String(t.note || '').slice(0, 500), done: false }));
      return { ok: true, tasks: this.tasks };
    });
    if (!reg.has('update_task')) reg.register('update_task', 'Mark a task done (and say what you learned in its note) or update its note. Done tasks earn more iterations.', { type: 'object', properties: { index: { type: 'number' }, done: { type: 'boolean' }, note: { type: 'string' } }, required: ['index'] }, async ({ index, done, note }) => {
      const t = this.tasks[Number(index)]; if (!t) return { error: `no task ${index}` };
      if (typeof done === 'boolean' && done && !t.done) { t.done = true; this.budget = Math.min(this.maxIterations, this.budget + 40); }
      if (note) t.note = String(note).slice(0, 500);
      return { ok: true, task: t, budgetLeft: this.budget - this.iterations };
    });
    if (!reg.has('finish')) reg.register('finish', 'END the job. status "done" only when the evidence proves the outcome; "blocked" when code, the owner or the platform stands in the way. The summary is one line the owner reads first; the report is the record.', { type: 'object', properties: { status: { type: 'string', enum: ['done', 'blocked'] }, summary: { type: 'string' }, report: { type: 'object', description: '{request, changed:[…], runs:[…], evidence, notProven?, needsCode?, lesson}' } }, required: ['status', 'summary'] }, async ({ status, summary, report }) => {
      this.report = report && typeof report === 'object' ? report : { summary };
      this.finalLine = `${status === 'done' ? 'DONE' : 'BLOCKED'}: ${String(summary || '').slice(0, 600)}`;
      this.status = status === 'done' ? 'done' : 'blocked';
      return { ok: true, ended: true };
    });
  }

  /** The owner speaks into the run; it lands as the next user turn. */
  say(text) { const t = String(text || '').trim(); if (t) this._pendingSay.push(t); }
  stop() { this._stop = true; }

  _event(kind, data) { this.events.push({ t: this.now(), kind, ...data }); if (this.events.length > 600) this.events.splice(0, this.events.length - 600); }

  _persist() {
    try {
      fs.mkdirSync(this.persistDir, { recursive: true });
      const rec = { id: this.id, goal: this.goal, status: this.status, iterations: this.iterations, budget: this.budget, tasks: this.tasks, events: this.events.slice(-400), report: this.report, finalLine: this.finalLine, startedAt: this.startedAt, endedAt: this.endedAt, error: this.error, messages: this.messages.slice(-80) };
      const f = path.join(this.persistDir, this.id + '.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(rec)); fs.renameSync(f + '.tmp', f);
    } catch { /* best effort */ }
  }

  view() {
    return { id: this.id, goal: this.goal, status: this.status, iterations: this.iterations, budget: this.budget, tasks: this.tasks, report: this.report, finalLine: this.finalLine, startedAt: this.startedAt, endedAt: this.endedAt, error: this.error, events: this.events.slice(-120) };
  }

  _orientationMessage() {
    const open = this.tasks.filter((t) => !t.done).map((t) => `- [ ] ${t.i}. ${t.title}${t.note ? ' — ' + t.note : ''}`);
    const done = this.tasks.filter((t) => t.done).map((t) => `- [x] ${t.i}. ${t.title}${t.note ? ' — ' + t.note : ''}`);
    let o = ''; try { o = String(this.orientation() || ''); } catch { o = ''; }
    return `[Orientation]\nGOAL: ${this.goal}\n${o ? '\n' + o + '\n' : ''}\nTASKS:\n${[...open, ...done].join('\n') || '(none yet — save_task_list first)'}\nBudget: ${Math.max(0, this.budget - this.iterations)} iterations left. End with finish({status, summary, report}).`;
  }

  _prune() {
    const size = () => this.messages.reduce((n, m) => n + String(m.content || '').length, 0);
    if (size() <= MAX_CONTEXT_CHARS) return;
    // keep the system prompt + the first user turn; trim old tool results to one line, oldest first
    for (let i = 2; i < this.messages.length - 24 && size() > MAX_CONTEXT_CHARS * 0.8; i++) {
      const m = this.messages[i];
      if (m.role === 'tool' && String(m.content || '').length > 200) m.content = String(m.content).slice(0, 160) + ' … [trimmed earlier result]';
    }
    if (size() > MAX_CONTEXT_CHARS) {
      // still too big: drop the oldest middle turns entirely, keeping the head and the recent tail
      const head = this.messages.slice(0, 2), tail = this.messages.slice(-24);
      this.messages = [...head, { role: 'user', content: '[Earlier turns were trimmed to fit the context. Your task list and notes carry what was learned.]' }, ...tail];
    }
  }

  async run() {
    this.status = 'running'; this._event('start', { goal: this.goal });
    this.messages = [{ role: 'system', content: this.systemPrompt }, { role: 'user', content: this._orientationMessage() }];
    this._persist();
    try {
      while (!this._stop && this.status === 'running') {
        if (this.iterations >= this.budget) { this._finishAs('blocked', `iteration budget spent (${this.iterations}) before the outcome was proven`); break; }
        this.iterations++;
        if (this._pendingSay.length) { const t = this._pendingSay.splice(0).join('\n'); this.messages.push({ role: 'user', content: `The owner says: ${t}` }); this._event('say', { text: t }); }
        if (this.iterations % RE_ANCHOR_EVERY === 0) this.messages.push({ role: 'user', content: this._orientationMessage() });
        this._prune();
        let reply;
        try { reply = await this.chat({ host: this.llm.host, model: this.llm.model, key: this.llm.key, messages: this.messages, tools: this.registry.definitions() }); }
        catch (e) { this._event('llm-error', { message: e.message }); if (++this._failStreak >= 4) { this._finishAs('error', `the model stopped answering: ${e.message}`); break; } await new Promise((r) => setTimeout(r, 4000)); continue; }
        const calls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
        const content = String(reply.content || '');
        if (content) this._event('thought', { text: content.slice(0, 1200) });
        // the assistant turn, with its calls, in the provider's own shape
        this.messages.push({ role: 'assistant', content, ...(reply.raw && reply.raw.message && reply.raw.message.tool_calls ? { tool_calls: reply.raw.message.tool_calls } : {}) });
        if (!calls.length) {
          // no tool: either it finished in prose (not allowed — finish is a tool) or it is thinking out loud
          if (/^\s*(DONE|BLOCKED):/m.test(content) && ++this._nudges >= 1) { const m = content.match(/^\s*(DONE|BLOCKED):\s*(.+)$/m); this._finishAs(m[1] === 'DONE' ? 'done' : 'blocked', m[2].slice(0, 600)); break; }
          if (++this._nudges > 3) { this._finishAs('blocked', 'the model stopped using tools without finishing — no proven outcome'); break; }
          this.messages.push({ role: 'user', content: 'Use a tool now (read, change, run, verify), or end the job with finish({status, summary, report}). Prose alone does nothing.' });
          this._persist(); continue;
        }
        this._nudges = 0;
        for (const call of calls) {
          if (this._stop || this.status !== 'running') break;
          const name = String(call.name || ''); const args = call.args && typeof call.args === 'object' ? call.args : {};
          const tool = this.registry.get(name);
          const sig = name + ':' + JSON.stringify(args);
          const repeat = tool && !tool.repeatable && this._recentCalls.includes(sig);
          this._recentCalls.push(sig); if (this._recentCalls.length > 6) this._recentCalls.shift();
          let out;
          if (repeat) {
            this._repeatStreak++;
            out = { error: `you already called ${name} with exactly these arguments and have its result above — do something different (a different argument, another tool, or finish)` };
            if (this._repeatStreak >= 4) { this._finishAs('blocked', `stuck repeating ${name} — no progress`); this._pushTool(call, out); break; }
          } else {
            this._repeatStreak = 0;
            this._event('tool', { name, args: clip(args, 400) });
            out = await this.registry.execute(name, args);
            if (looksFailed(out)) this._failStreak++; else this._failStreak = 0;
            this._event('result', { name, text: clip(out, 600) });
            if (this._failStreak >= 8) { this._pushTool(call, out); this._finishAs('blocked', `eight tool calls in a row failed — the environment is not answering as expected`); break; }
          }
          this._pushTool(call, out);
        }
        this._persist();
      }
      if (this._stop && this.status === 'running') this._finishAs('stopped', 'stopped by the owner');
    } catch (e) { this.error = e.message; this._finishAs('error', e.message); }
    this.endedAt = this.now(); this._event('end', { status: this.status, finalLine: this.finalLine }); this._persist();
    return this.view();
  }

  _pushTool(call, out) { this.messages.push({ role: 'tool', content: clip(out), ...(call.id ? { tool_call_id: call.id } : {}) }); }
  _finishAs(status, summary) { if (this.status !== 'running') return; this.status = status; this.finalLine = `${status === 'done' ? 'DONE' : 'BLOCKED'}: ${String(summary || '').slice(0, 600)}`; if (!this.report) this.report = { summary }; }
}

/** Jobs persisted on disk (for the list after a restart; a run in flight at a roll shows as interrupted). */
function listPersisted(dir = JOB_DIR) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (r.status === 'running') r.status = 'interrupted'; delete r.messages; return r; } catch { return null; } }).filter(Boolean).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)); } catch { return []; }
}

module.exports = { OperatorRun, listPersisted, JOB_DIR };
