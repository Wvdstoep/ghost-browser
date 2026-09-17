/**
 * THE OPERATOR'S HANDS — everything an engineer operating Ghost Browser can do from outside the code,
 * as tools calling the browser's own internals (no HTTP, no other service): the guide and its own
 * memory, the log, runs and jobs with their traces, sessions and a look at a live page, the watchers
 * with health / feed / config / posts / probe, roles in full, flows (save, run, wait, runs).
 *
 * WHAT THE HANDS REFUSE, BY CONSTRUCTION (a prompt asks, a tool decides):
 *   - autoApprove is stripped from every flow saved here — nothing outward bypasses the owner's gate;
 *   - a watcher (schedule trigger) needs one agent step with a role and a budget; a one-off flow needs
 *     a verify step — an automation that cannot prove itself is the drift this operator exists to end;
 *   - nothing here posts, replies or acts on a platform; only the owner's Approve does that.
 *
 * `ctx` is handed in by server.js: closures over the modules there, so this file knows nothing about
 * express and can be tested with a fake ctx.
 */
const clip = (v, n = 8000) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + `… (${s.length - n} more chars)` : s; };
const obj = (props, required = []) => ({ type: 'object', properties: props, required });

const isWatcher = (flow) => Array.isArray(flow && flow.nodes) && flow.nodes.some((n) => n && n.type === 'trigger' && n.trigger && n.trigger.type === 'schedule');

/** Problems a flow has that this belt will not hand to the browser. Empty means good. */
function flowProblems(flow) {
  if (!flow || typeof flow !== 'object') return ['a flow must be an object {name, nodes, edges}'];
  const errs = []; const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  if (String(flow.name || '').trim().length < 3) errs.push('a name of at least 3 characters');
  if (!nodes.length) errs.push('at least one step');
  const trig = nodes.find((n) => n && n.type === 'trigger');
  if (!trig) errs.push('a trigger step to start it');
  for (const n of nodes) if (n && n.type === 'agent' && !(Number(n.maxSteps) > 0 || Number(n.maxPages) > 0)) errs.push(`the agent step "${n.label || n.id}" needs a budget (maxSteps and/or maxPages)`);
  if (isWatcher(flow)) {
    const t = trig.trigger; if (!t.every || !(Number(t.n) > 0)) errs.push('the schedule trigger needs {type:"schedule", every:"minute"|"hour"|"day", n:<number>}');
    if (!nodes.some((n) => n && n.type === 'agent' && n.role && String(n.goal || '').trim())) errs.push('a watcher needs one agent step with a role and a goal (what to gather each pass)');
  } else {
    if (!nodes.some((n) => n && n.type === 'verify')) errs.push('a verify step — a flow that cannot prove its outcome cannot be verified');
    for (const n of nodes) if (n && n.type === 'verify') {
      const url = String(n.url || ''); const tpl = (url.match(/\{\{\s*([\w.[\]]+)\s*\}\}/) || [])[1];
      if (tpl && tpl !== 'input' && !tpl.startsWith('input.')) errs.push(`the verify step "${n.label || n.id}" must not take its url from another step — write the address out or take it from {{input.…}}`);
      else if (!tpl && !/^https?:\/\//i.test(url)) errs.push(`the verify step "${n.label || n.id}" needs a literal http(s) url or one from the run's input`);
      if (!String(n.text || '').trim()) errs.push(`the verify step "${n.label || n.id}" needs the text to look for`);
    }
  }
  return errs;
}
const sanitizeFlow = (flow) => { const { autoApprove, ...rest } = flow; return { ...rest, autoApprove: false, active: isWatcher(flow) ? !!flow.active : false }; };

/** One trimmed line per step of a run. */
function summarizeRun(run) {
  if (!run || typeof run !== 'object') return run;
  const steps = (run.steps || []).map((s) => { const o = s.output && typeof s.output === 'object' ? s.output : null; const brief = o ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('__')).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 300) : Array.isArray(v) ? `[${v.length} item(s)]` : v])) : null; return { node: s.node_id, type: s.type, status: s.status, ...(s.error ? { error: String(s.error).slice(0, 300) } : {}), ...(brief ? { output: brief } : {}) }; });
  const verify = steps.filter((s) => s.type === 'verify');
  const verified = run.status === 'done' && verify.length > 0 && verify.every((s) => s.status === 'done' && s.output && s.output.found === true) && !steps.some((s) => s.status === 'error');
  return { runId: run.id, workflowId: run.workflow_id, status: run.status, started_at: run.started_at, ended_at: run.ended_at, error: run.error || null, verified, steps };
}

function registerOperatorTools(reg, ctx) {
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = ctx.now || Date.now;
  const R = (name, description, parameters, fn, opts) => reg.register(name, description, parameters, async (a) => clip(await fn(a || {})), opts);

  // ── knowing ──
  R('gb_guide', 'THE OPERATOR GUIDE — read it FIRST on every job (a section to narrow it): how roles, flows, watchers, feeds, routing, the post watcher, the approval gate and the poster work; the platform facts already learned; the debugging method.', obj({ section: { type: 'string', description: 'optional heading, e.g. "watchers", "facebook", "debugging"' } }), async ({ section }) => ctx.ops.readGuide(section), { repeatable: true });
  R('gb_memory_read', 'Your notebook from earlier jobs: what worked, what a platform does, what to avoid.', obj({}), async () => ctx.ops.readMemory() || '(empty)', { repeatable: true });
  R('gb_memory_write', 'Keep a lesson for the next job the moment you learn it: one concrete note (what, which flow/role/watcher, what fixed it).', obj({ note: { type: 'string' } }, ['note']), async ({ note }) => ({ ok: true, chars: ctx.ops.appendMemory(String(note).slice(0, 2000)) }));

  // ── seeing ──
  R('gb_logs', 'The browser\'s own log, most recent last: scheduler firings, what a pass expanded/read/verified/drafted, poster results, ERROR lines. Filter with grep (substring or /regex/) and a window in minutes.', obj({ grep: { type: 'string' }, since_minutes: { type: 'number', description: 'default 30' }, limit: { type: 'number', description: 'default 120' } }), async ({ grep, since_minutes, limit }) => ctx.ops.ringLines({ grep, since: since_minutes || 30, limit: limit || 120 }).join('\n') || '(nothing in that window)', { repeatable: true });
  R('gb_runs_recent', 'The most recent runs across all automations and watchers, summarized (status, steps, errors, verified).', obj({ limit: { type: 'number', description: 'default 15' } }), async ({ limit }) => {
    const all = []; for (const wf of ctx.workflows.all()) { try { for (const r of ctx.workflows.runsFor(wf.id, 5)) all.push(r); } catch (e) { /* none */ } }
    all.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
    return all.slice(0, Number(limit) || 15).map(summarizeRun);
  }, { repeatable: true });
  R('gb_jobs', 'Browser agent jobs alive now and recent history (id, status, role, workflow, run, proposals).', obj({}), async () => ctx.jobsSummary(), { repeatable: true });
  R('gb_job', 'One job in full: its steps (tool calls, notes, acts, asks, errors) — the trace of what the agent did on the page — and proposals parked at the gate.', obj({ jobId: { type: 'string' }, last: { type: 'number', description: 'last N steps, default 40' } }, ['jobId']), async ({ jobId, last }) => ctx.jobDetail(jobId, Number(last) || 40), { repeatable: true });
  R('gb_sessions', 'Open browser sessions (profile, what holds each). One profile = one browser; two things wanting it collide.', obj({}), async () => ctx.sessions(), { repeatable: true });
  R('gb_look', 'LOOK at a live profile\'s current page: its url, title, the numbered controls (buttons, links, fields) and the first lines of text — what a step or a watcher is looking at right now. Also stores a screenshot for the owner.', obj({ profile: { type: 'string', description: 'e.g. facebook' } }, ['profile']), async ({ profile }) => ctx.look(profile), { repeatable: true });
  R('gb_busy', 'Which watcher passes (and posters) run right now. Passes run in the watchers\' OWN browser copy, so a walk, a look or a post in the owner\'s profile may start regardless; only another pass, a probe or a poster waits for this to empty.', obj({}), async () => ({ running: [...ctx.runningWatchers], note: 'passes use their own browser copy — walks and looks need not wait' }), { repeatable: true });

  // ── watchers ──
  R('gb_watchers', 'Every WATCHER (scheduled flow): interval, active, config (mode, meName, routes, posts, horizon) and health (last pass numbers, running, stale). mode "posts" = the server-driven post watcher.', obj({}), async () => {
    const out = [];
    for (const w of ctx.workflows.all()) {
      const trig = (w.nodes || []).find((x) => x && x.type === 'trigger'); const t = (trig && trig.trigger) || w.trigger || {};
      if (t.type !== 'schedule') continue;
      const c = ctx.feed.getConfig(w.id) || {}; const h = ctx.health(w.id);
      out.push({ id: w.id, name: w.name, active: !!w.active, every: `${t.n} ${t.every}`, role: ((w.nodes || []).find((x) => x && x.type === 'agent') || {}).role || null, config: { mode: c.mode || 'role', meName: c.meName, followUps: c.followUps, followUpFlowId: c.followUpFlowId, postUrls: c.postUrls, maxAgeDays: c.maxAgeDays }, health: h });
    }
    return out;
  }, { repeatable: true });
  R('gb_watcher_health', 'One watcher\'s health: active, running, minutes since the last pass, stale, and the last pass in numbers.', obj({ watcherId: { type: 'string' } }, ['watcherId']), async ({ watcherId }) => ctx.health(watcherId), { repeatable: true });
  R('gb_watcher_feed', 'What a watcher has collected: items with standing (status/why), draft, state, and (post watcher) the thread transcript. Unhandled first.', obj({ watcherId: { type: 'string' }, limit: { type: 'number', description: 'default 30' }, onlyWaiting: { type: 'boolean' } }, ['watcherId']), async ({ watcherId, limit, onlyWaiting }) => {
    let items = ctx.feed.list(watcherId);
    if (onlyWaiting) items = items.filter((it) => !it.handled && (((it.fields || {}).status === 'waiting on you') || it.draft));
    return { counts: ctx.feed.counts(watcherId), items: items.slice(0, Number(limit) || 30).map((it) => ({ key: it.key, title: it.title, kind: it.kind, state: ctx.feed.stateOf(it), handled: !!it.handled, status: (it.fields || {}).status, why: (it.fields || {}).why, author: (it.fields || {}).author, said: String((it.fields || {}).said || (it.fields || {}).detail || '').slice(0, 200), when: (it.fields || {}).when, draft: it.draft ? String(it.draft).slice(0, 300) : '', posted: it.posted || null, url: it.url, thread: (it.fields || {}).thread ? String((it.fields || {}).thread).slice(0, 800) : undefined })) };
  }, { repeatable: true });
  R('gb_watcher_config', 'Set a watcher\'s config (merged): mode ("posts" = post watcher), meName (the owner\'s display name — required for the post watcher\'s standing), followUps [{kinds:[...], flowId}], maxAgeDays, maxDraftsPerPass, reactionCounts, hideAfterDays, profile.', obj({ watcherId: { type: 'string' }, config: { type: 'object' } }, ['watcherId', 'config']), async ({ watcherId, config }) => ctx.feed.setConfig(watcherId, config || {}));
  R('gb_watcher_posts', 'The posts a post watcher follows; add one by its link, or remove one.', obj({ watcherId: { type: 'string' }, add: { type: 'string' }, remove: { type: 'string' } }, ['watcherId']), async ({ watcherId, add, remove }) => {
    const c = ctx.feed.getConfig(watcherId) || {}; let urls = Array.isArray(c.postUrls) ? c.postUrls.slice() : [];
    if (add) { const pid = ctx.postIdOf(add); if (!pid) return { error: 'that is not a post link (needs post_id or /posts/<id>/)' }; if (!urls.some((u) => ctx.postIdOf(u) === pid)) urls.push(add); return ctx.feed.setConfig(watcherId, { postUrls: urls, mode: 'posts' }); }
    if (remove) { const pid = ctx.postIdOf(remove); urls = urls.filter((u) => ctx.postIdOf(u) !== pid); return ctx.feed.setConfig(watcherId, { postUrls: urls }); }
    return { postUrls: urls, mode: c.mode || '' };
  });
  R('gb_watcher_run', 'Run a watcher\'s pass NOW. Returns at once; a pass takes 2–8 minutes — wait with gb_watcher_wait. Answers busy when another pass holds the browser: wait, do not retry in a loop.', obj({ watcherId: { type: 'string' } }, ['watcherId']), async ({ watcherId }) => ctx.runWatcher(watcherId));
  R('gb_watcher_wait', 'WAIT for a watcher\'s pass to end (checks every 20s up to `seconds`, default 300, max 600) and return its health. One call, not a loop.', obj({ watcherId: { type: 'string' }, seconds: { type: 'number' } }, ['watcherId']), async ({ watcherId, seconds }) => {
    const budget = Math.min(600, Math.max(20, Number(seconds) || 300)) * 1000; const t0 = now();
    let h = ctx.health(watcherId); while (h.running && now() - t0 < budget) { await sleep(20000); h = ctx.health(watcherId); }
    return h.running ? { ...h, stillRunning: true, hint: 'still running — call gb_watcher_wait again' } : h;
  }, { repeatable: true });
  R('gb_watcher_toggle', 'Pause or resume a watcher (its schedule).', obj({ watcherId: { type: 'string' }, active: { type: 'boolean' } }, ['watcherId', 'active']), async ({ watcherId, active }) => ctx.setActive(watcherId, !!active));
  R('gb_watcher_probe', 'READ a page exactly as the watcher does, with its own session (no model): every comment article (author label, visible/hidden, first words) and the reveal controls still closed; expand:true first opens every "view replies / more comments" and reports what it clicked. The way to check a watcher\'s standing against the real thread. 20–90s.', obj({ watcherId: { type: 'string' }, url: { type: 'string' }, expand: { type: 'boolean' } }, ['watcherId', 'url']), async ({ watcherId, url, expand }) => ctx.probe(watcherId, url, !!expand), { repeatable: true });

  // ── browsing (the assistant's hands in the owner's logged-in profiles) ──
  R('gb_walk', 'BROWSE for the owner: start the browser agent in a logged-in profile with a precise goal (read-only unless the owner asked for an act — an act becomes a proposal the owner approves in the app). Returns a jobId at once; the walk takes 1–10 minutes — wait with gb_walk_wait. Refused while a watcher pass holds the browser.', obj({ goal: { type: 'string', description: 'exactly what to find/read/do, and what to report back' }, profile: { type: 'string', description: 'e.g. facebook, linkedin (gb_platforms lists them)' }, role: { type: 'string', description: 'optional role name to play' }, maxSteps: { type: 'number', description: 'default 40' }, maxPages: { type: 'number', description: 'default 12' } }, ['goal', 'profile']), async ({ goal, profile, role, maxSteps, maxPages }) => ctx.startWalk ? ctx.startWalk({ goal, profile, role, maxSteps, maxPages }) : { error: 'browsing is not wired on this server' });
  R('gb_walk_stop', 'STOP a walk you started (a wrong goal, a page that will not load). Its session stays; start another walk after.', obj({ jobId: { type: 'string' } }, ['jobId']), async ({ jobId }) => ctx.stopWalk ? ctx.stopWalk(jobId) : { error: 'not wired' });
  R('gb_walk_wait', 'WAIT for a walk to end (checks every 15s up to `seconds`, default 300, max 600) and return its report, proposals and last steps. One call, not a loop.', obj({ jobId: { type: 'string' }, seconds: { type: 'number' } }, ['jobId']), async ({ jobId, seconds }) => {
    const budget = Math.min(600, Math.max(15, Number(seconds) || 300)) * 1000; const t0 = now();
    let d = ctx.jobDetail(jobId, 12); while (d && !d.error && (d.status === 'running' || d.status === 'idle') && now() - t0 < budget) { await sleep(15000); d = ctx.jobDetail(jobId, 12); }
    return d && (d.status === 'running' || d.status === 'idle') ? { ...d, stillRunning: true, hint: 'still browsing — call gb_walk_wait again' } : d;
  }, { repeatable: true });

  // ── roles ──
  R('gb_tools', 'The tools the browser agent actually has (name, one line). A role\'s prompt or a step\'s goal may name only these.', obj({}), async () => ctx.agentTools(), { repeatable: true });
  R('gb_roles', 'The roles the agent can play (built-in and authored): name, label, site, description. Filter by site.', obj({ site: { type: 'string' } }), async ({ site }) => ctx.listRoles().filter((r) => !site || !r.site || r.site === site), { repeatable: true });
  R('gb_role_get', 'One role in full — its prompt (the playbook), tools, site. Most watcher and flow defects are a sentence in here.', obj({ name: { type: 'string' } }, ['name']), async ({ name }) => ctx.getRole(name) || { error: `no role ${name}` }, { repeatable: true });
  R('gb_role_save', 'Create an authored role: {label, site, description, tools:[...], prompt}. Returns its name — use it in an agent step.', obj({ role: { type: 'object' } }, ['role']), async ({ role }) => ctx.saveRole(null, role));
  R('gb_role_update', 'Rewrite an AUTHORED role in full (built-ins cannot be edited — save a clone instead). Small, specific edits: the exact move, the exact stop condition.', obj({ name: { type: 'string' }, role: { type: 'object' } }, ['name', 'role']), async ({ name, role }) => ctx.saveRole(name, role));

  // ── flows ──
  R('gb_flows', 'The automations and watchers saved in the browser: id, name, steps, active. Read before composing — fix what exists, never duplicate.', obj({}), async () => ctx.workflows.all().map((w) => ({ id: w.id, name: w.name, active: !!w.active, nodes: (w.nodes || []).length, watcher: isWatcher(w) })), { repeatable: true });
  R('gb_flow_get', 'One automation in full: nodes and edges.', obj({ flowId: { type: 'string' } }, ['flowId']), async ({ flowId }) => ctx.workflows.read(flowId) || { error: `no flow ${flowId}` }, { repeatable: true });
  R('gb_flow_save', 'Save an automation or a WATCHER (create without id, update with id). One-off: trigger + budgets + a verify step. Watcher: {id:"trigger", type:"trigger", trigger:{type:"schedule", every:"minute", n:15}} + one agent step {role, profile, goal, maxSteps}; may be active. Nothing is ever auto-approved. Node kinds: trigger, agent, check-login, fetch, script, extract, store, filter, branch, collect, verify. Returns the stored flow or what is still missing.', obj({ flow: { type: 'object' } }, ['flow']), async ({ flow }) => {
    const errs = flowProblems(flow); if (errs.length) return { saved: false, stillNeeds: errs };
    const rec = ctx.saveFlow(sanitizeFlow(flow)); return { saved: true, id: rec.id, name: rec.name, active: !!rec.active, nodes: (rec.nodes || []).length, watcher: isWatcher(rec) };
  });
  R('gb_flow_run', 'Run an automation now (a dry run that proves it); optional input becomes {{input.*}}. Returns the runId — wait with gb_flow_wait.', obj({ flowId: { type: 'string' }, input: { type: 'object' } }, ['flowId']), async ({ flowId, input }) => ctx.runFlow(flowId, input && typeof input === 'object' ? input : {}));
  R('gb_flow_wait', 'WAIT for a run to end (checks every 15s up to `seconds`, default 180, max 300) and return it summarized.', obj({ runId: { type: 'string' }, seconds: { type: 'number' } }, ['runId']), async ({ runId, seconds }) => {
    const budget = Math.min(300, Math.max(15, Number(seconds) || 180)) * 1000; const t0 = now(); let last = null;
    for (;;) { last = summarizeRun(ctx.workflows.readRun(runId)); if (!last || last.status !== 'running') return last || { error: `no run ${runId}` }; if (now() - t0 >= budget) return { ...last, stillRunning: true, hint: 'call gb_flow_wait again' }; await sleep(15000); }
  }, { repeatable: true });
  R('gb_flow_run_status', 'What a run did, summarized.', obj({ runId: { type: 'string' } }, ['runId']), async ({ runId }) => summarizeRun(ctx.workflows.readRun(runId)) || { error: `no run ${runId}` }, { repeatable: true });
  R('gb_flow_runs', 'Recent runs of one automation, newest first, summarized.', obj({ flowId: { type: 'string' } }, ['flowId']), async ({ flowId }) => ctx.workflows.runsFor(flowId, 10).map(summarizeRun), { repeatable: true });
  R('gb_platforms', 'The platform registry: where a login exists (signedIn), which profile holds it, what may be done there.', obj({}), async () => ctx.platforms(), { repeatable: true });

  return reg.names().length;
}

module.exports = { registerOperatorTools, flowProblems, sanitizeFlow, isWatcher, summarizeRun };
