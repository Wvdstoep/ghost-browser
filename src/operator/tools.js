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
const clip = (v, n = 6000) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + `… (${s.length - n} more chars)` : s; };
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
  R('gb_walk', 'BROWSE for the owner: start the browser agent in a logged-in profile with a precise goal (read-only unless the owner asked for an act — an act becomes a proposal the owner approves in the app). Returns a jobId at once; the walk takes 1–10 minutes — wait with gb_walk_wait. Refused while a watcher pass holds the browser.', obj({ goal: { type: 'string', description: 'exactly what to find/read/do, and what to report back' }, ask: { type: 'string', description: "the OWNER'S OWN WORDS - what they actually asked you for, verbatim, before you turned it into a plan. This is what the job is recorded as, so it must read like a person talking, not like instructions. Always pass it when a person asked for this; leave it out only when nobody did (a watcher, a flow)." }, profile: { type: 'string', description: 'e.g. facebook, linkedin (gb_platforms lists them)' }, role: { type: 'string', description: 'optional role name to play' }, maxSteps: { type: 'number', description: 'default 40' }, maxPages: { type: 'number', description: 'default 12' } }, ['goal', 'profile']), async ({ goal, ask, profile, role, maxSteps, maxPages }) => ctx.startWalk ? ctx.startWalk({ goal, ask, profile, role, maxSteps, maxPages }) : { error: 'browsing is not wired on this server' }, { repeatable: true });
  /* A walk handed to a device has NO cluster job: gb_walk_wait cannot see it, and asking it to
     produced "no such job" and then a second hand-over of the same goal. This is the handle. */
  R('gb_device_log', 'WHAT ONE OF THE OWNER\'S DEVICES IS DOING right now. Use this after a gb_walk that answered '
    + '"running on your device" — that walk has NO jobId and gb_walk_wait cannot see it. Call it every '
    + 'minute or so while the device works, and pass `after` with the previous `next` to get only what is new.',
    obj({ device: { type: 'string', description: 'the device name the hand-over reported, e.g. WojMagEmi' }, after: { type: 'number' } }, ['device']),
    async ({ device, after }) => ctx.deviceProgress ? ctx.deviceProgress(device, after) : { error: 'not wired' }, { repeatable: true });
  R('gb_files_recent', 'FILES the browser captured from a page\'s Download button (images, videos, documents) — newest first. After a walk that created something and downloaded it, this is where it is.', obj({ kind: { type: 'string', description: 'image | video | audio | file' }, limit: { type: 'number' } }), async ({ kind, limit }) => ctx.filesRecent ? ctx.filesRecent(kind, limit) : { error: 'not wired' }, { repeatable: true });
  R('gb_file_show', 'SHOW a captured file to the owner in the chat (an image appears under this step, with a save button on their device). Use it right after the walk downloaded the result.', obj({ id: { type: 'string' } }, ['id']), async ({ id }) => ctx.fileShow ? ctx.fileShow(id) : { error: 'not wired' });
  /* THE RECORDER (docs/RECORDER-PLAN.md): screen recording with sound, any length, in a browser of its own — the
     owner's profile is never touched. A recording outlives the turn: start it, answer at once. */
  R('record_start', 'RECORD a video page with sound (any length) in a browser of its own, from the owner\'s profile. Give the EXACT video address (find it first with a read-only gb_walk). until: "video-ends" (default, the page\'s video ends), "duration" (maxMinutes), "owner-stop" (until the owner stops it). Returns recordingId at once; the recording runs on by itself after this turn — answer the owner right away, never wait for it. The app shows it live, then playable, then downloadable.', obj({ url: { type: 'string' }, profile: { type: 'string', description: 'the platform\'s profile (YouTube = google)' }, until: { type: 'string', enum: ['video-ends', 'duration', 'owner-stop'] }, maxMinutes: { type: 'number' }, quality: { type: 'string', enum: ['720p', '1080p', '1080p60'], description: '720p is the default and enough for talk; 1080p for detail; 1080p60 for fast motion' }, title: { type: 'string', description: 'a name the owner will recognise' } }, ['url', 'profile']), async (a) => ctx.recordStart ? ctx.recordStart(a) : { error: 'recording is not wired on this server' });
  R('record_status', 'HOW a recording is doing: state (starting | recording | finishing | done | partial | failed), seconds, size, why it ended.', obj({ id: { type: 'string' } }, ['id']), async ({ id }) => ctx.recordStatus ? ctx.recordStatus(id) : { error: 'not wired' }, { repeatable: true });
  R('record_stop', 'STOP a recording now; what was recorded so far stays playable.', obj({ id: { type: 'string' } }, ['id']), async ({ id }) => ctx.recordStop ? ctx.recordStop(id) : { error: 'not wired' });
  R('record_list', 'The recordings on this Ghost Browser, newest first, with their state — and the free space left for new ones.', obj({}, []), async () => ctx.recordList ? ctx.recordList() : { error: 'not wired' }, { repeatable: true });
  R('gb_walk_stop', 'STOP a walk you started (a wrong goal, a page that will not load). Its session stays; start another walk after.', obj({ jobId: { type: 'string' } }, ['jobId']), async ({ jobId }) => ctx.stopWalk ? ctx.stopWalk(jobId) : { error: 'not wired' });
  R('gb_walk_wait', 'WAIT for a walk to end (checks every 15s up to `seconds`, default 300, max 600) and return its report, proposals and last steps. One call, not a loop.', obj({ jobId: { type: 'string' }, seconds: { type: 'number' } }, ['jobId']), async ({ jobId, seconds }) => {
    const budget = Math.min(600, Math.max(15, Number(seconds) || 300)) * 1000; const t0 = now();
    // 'idle' = the agent finished its loop and wrote its report (the session is kept for proposals): the walk is DONE
    const halted = () => !!(ctx.stopped && ctx.stopped());
    let d = ctx.jobDetail(jobId, 12); while (d && !d.error && d.status === 'running' && now() - t0 < budget && !halted()) { await sleep(5000); d = ctx.jobDetail(jobId, 12); }
    if (halted()) return { ...(d || {}), stopped: true, hint: 'the owner stopped this turn — no more tools' };
    return d && d.status === 'running' ? { ...d, stillRunning: true, hint: 'still browsing — call gb_walk_wait again' } : d;
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
  R('gb_people', 'The PEOPLE the owner talks with on a platform — memory across posts: exchanges, what the owner promised them, what they asked, COMMERCIAL SIGNALS (leads). One name for the full record + the drafter\'s profile; leadsOnly for the leads. Also the draft OUTCOMES (posted as-is / edited / rewritten).', obj({ platform: { type: 'string', description: 'default facebook' }, name: { type: 'string' }, leadsOnly: { type: 'boolean' } }), async ({ platform, name, leadsOnly }) => ctx.people ? ctx.people(platform, name, leadsOnly) : { error: 'not wired' }, { repeatable: true });
  R('gb_platforms', 'The platform registry: where a login exists (signedIn), which profile holds it, what may be done there.', obj({}), async () => ctx.platforms(), { repeatable: true });

  
  // ── security recon & red-team intelligence ──
  const getDiscovered = async (target) => {
    if (!target) return null;
    let origin = target;
    try {
      const u = new URL(target.startsWith('http') ? target : 'https://' + target);
      origin = u.origin;
    } catch (_) {}
    ctx.discoveredEndpoints = ctx.discoveredEndpoints || {};
    if (!ctx.discoveredEndpoints[origin] && ctx.recon && ctx.recon.harvestTargetEndpoints) {
      try {
        ctx.discoveredEndpoints[origin] = await ctx.recon.harvestTargetEndpoints(origin);
      } catch (_) {}
    }
    return ctx.discoveredEndpoints[origin] || null;
  };
  R('gb_audit_second_order', 'MULTI-PHASE SECOND-ORDER STORED INJECTION AUDIT (CWE-79 / CWE-116): injects benign canary tokens into mutation endpoints (Step 1) and crawls downstream profile, export, or administrative views (Step 2) to detect unescaped reflection in secondary sinks.',
    obj({ targetUrl: { type: 'string', description: 'target domain or endpoint URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, mutationEndpoints: { type: 'array', items: { type: 'string' }, description: 'candidate Phase 1 injection endpoints' }, downstreamEndpoints: { type: 'array', items: { type: 'string' }, description: 'candidate Phase 2 downstream sink endpoints' } }),
    async ({ targetUrl, url, target, mutationEndpoints, downstreamEndpoints }) => {
      if (!ctx.recon || !ctx.recon.auditSecondOrderInjection) return { error: 'auditSecondOrderInjection not wired in context' };
      return ctx.recon.auditSecondOrderInjection(targetUrl || url || target, { mutationEndpoints, downstreamEndpoints });
    }, { repeatable: true });

  R('gb_audit_openapi_fuzz', 'AUTONOMOUS OPENAPI / SWAGGER SCHEMA CONTRACT FUZZER (CWE-20 / CWE-754): discovers exposed /api-docs or /swagger.json specifications and fires deterministic edge-case type mutations (integer overflow, negative amounts, null bytes) to catch unhandled 500 server crashes.',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' } }),
    async ({ targetUrl, url, target }) => {
      if (!ctx.recon || !ctx.recon.auditOpenApiContractFuzzing) return { error: 'auditOpenApiContractFuzzing not wired in context' };
      return ctx.recon.auditOpenApiContractFuzzing(targetUrl || url || target);
    }, { repeatable: true });

  R('gb_audit_subdomain_takeover', 'SUBDOMAIN TAKEOVER & DANGLING DNS CLOUD ANALYZER (CWE-284 / CWE-650): resolves DNS CNAME records for apex domains and subdomains, inspecting for dangling cloud pointers (AWS S3, GitHub Pages, Heroku, Vercel) that return unclaimed signature errors.',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, subdomains: { type: 'array', items: { type: 'string' }, description: 'optional list of candidate subdomains to probe' } }),
    async ({ targetUrl, url, target, subdomains }) => {
      if (!ctx.recon || !ctx.recon.auditSubdomainTakeover) return { error: 'auditSubdomainTakeover not wired in context' };
      return ctx.recon.auditSubdomainTakeover(targetUrl || url || target, { subdomains });
    }, { repeatable: true });

  R('gb_audit_jwt_key_confusion', 'JWT KEY CONFUSION & ALGORITHM DOWNGRADE AUDIT (CVE-2015-9235 / CWE-347): tests whether JWT authentication endpoints accept HMAC-SHA256 (HS256) tokens signed with the server public RSA key (asymmetric-to-symmetric key confusion).',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'candidate authenticated endpoints to probe' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditJwtKeyConfusion) return { error: 'auditJwtKeyConfusion not wired in context' };
      return ctx.recon.auditJwtKeyConfusion(targetUrl || url || target, { endpoints });
    }, { repeatable: true });

  R('gb_audit_cloud_metadata', 'CLOUD METADATA & INTERNAL SSRF TRAVERSAL AUDIT (CWE-918): tests whether URL fetchers, webhook endpoints, and proxy APIs enforce strict isolation against AWS IMDSv1/v2 (169.254.169.254), GCP internal metadata, Azure instance metadata, Kubernetes internal API, and loopback decimal/hex bypass encodings.',
    obj({ targetUrl: { type: 'string', description: 'target domain or endpoint URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'candidate endpoints to probe' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditCloudMetadataBoundaries) return { error: 'auditCloudMetadataBoundaries not wired in context' };
      return ctx.recon.auditCloudMetadataBoundaries(targetUrl || url || target, { endpoints });
    }, { repeatable: true });

  R('gb_audit_sqli_timing', 'STATISTICAL TIMING DIFFERENTIAL & NON-DESTRUCTIVE SQLI AUDIT (CWE-89): mathematically proves SQL Injection vulnerabilities without destructive queries or data dumping using calibrated time-delay differentials (2000ms delay) across multiple trials.',
    obj({ targetUrl: { type: 'string', description: 'target domain or endpoint URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'candidate search/query endpoints' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditSqliTimingDifferential) return { error: 'auditSqliTimingDifferential not wired in context' };
      return ctx.recon.auditSqliTimingDifferential(targetUrl || url || target, { endpoints });
    }, { repeatable: true });

  R('gb_audit_mass_assignment', 'MASS ASSIGNMENT & PRIVILEGED ATTRIBUTE ESCALATION AUDIT (CWE-915): evaluates whether state-changing mutation endpoints (POST/PUT/PATCH) accept unauthorized privileged attributes (role: "admin", isAdmin: true, permissions: ["*"], credits: 99999).',
    obj({ targetUrl: { type: 'string', description: 'target domain or endpoint URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'candidate mutation endpoints' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditMassAssignment) return { error: 'auditMassAssignment not wired in context' };
      return ctx.recon.auditMassAssignment(targetUrl || url || target, { endpoints });
    }, { repeatable: true });

  R('gb_audit_oast_callbacks', 'OUT-OF-BAND CANARY (OAST) BLIND CALLBACK AUDIT (CWE-918 / CWE-644): generates ephemeral cryptographic canary tokens (UUID + HMAC) to safely verify blind SSRF and out-of-band host header callbacks without destructive payloads. Polls for DNS/HTTP pingback interactions.',
    obj({ targetUrl: { type: 'string', description: 'target domain or endpoint URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, candidateParams: { type: 'array', items: { type: 'string' }, description: 'candidate parameters (url, webhook, redirect, callback)' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'candidate endpoints to probe' }, oastDomain: { type: 'string', description: 'optional custom OAST domain' } }),
    async ({ targetUrl, url, target, candidateParams, endpoints, oastDomain }) => {
      if (!ctx.recon || !ctx.recon.auditOastCanaryProtocol) return { error: 'auditOastCanaryProtocol not wired in context' };
      return ctx.recon.auditOastCanaryProtocol(targetUrl || url || target, { candidateParams, endpoints, oastDomain });
    }, { repeatable: true });

  R('gb_audit_ast_reachability', 'DEEP INTER-FILE AST SYMBOL RESOLUTION & SERVER ACTION AUDIT: indexes JavaScript/TypeScript project files, identifies Next.js Server Actions (use server) and App Router routes, and traces cross-file import/export symbol call graphs down to dangerous sinks (CWE-1321, CWE-78, CWE-94, CWE-918). Separates PROVEN_LIVE_REACHABLE risks from DORMANT_DEAD_CODE.',
    obj({ projectDir: { type: 'string', description: 'directory path of the project to analyze (defaults to workspace)' } }),
    async ({ projectDir }) => {
      if (!ctx.recon || !ctx.recon.auditAstReachability) return { error: 'auditAstReachability not wired in context' };
      return ctx.recon.auditAstReachability(projectDir || process.cwd());
    }, { repeatable: true });

  R('gb_audit_cve_verification', 'NON-DESTRUCTIVE DETERMINISTIC CVE & REACHABILITY AUDIT: executes the 3-pillar validation protocol for site owners without destructive exploits: (1) Behavioral Differential Probing (header normalization, duplicate Content-Length, HTTP desync patch checks), (2) Static Call-Graph & Dependency Reachability Analysis (distinguishes live reachable sinks from dormant dead-code CVEs in Node.js packages), (3) Harmless Canary Protocol (safe mathematical evaluation ${9413*7} -> 65891 proving SSTI/RCE and isolated prototype pollution CWE-1321). Eliminates false positives and outputs PR-ready remediations.',
    obj({ targetUrl: { type: 'string', description: 'target domain or endpoint URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'optional specific endpoints to probe' }, projectDir: { type: 'string', description: 'optional local directory path for AST reachability analysis' } }),
    async ({ targetUrl, url, target, endpoints, projectDir }) => {
      if (!ctx.recon || !ctx.recon.auditNonDestructiveVerification) return { error: 'auditNonDestructiveVerification not wired in context' };
      return ctx.recon.auditNonDestructiveVerification(targetUrl || url || target, { endpoints, projectDir });
    }, { repeatable: true });

  R('gb_audit_http_smuggling', 'HTTP REQUEST SMUGGLING & PARSER DESYNC AUDIT (CWE-444): non-destructively probes front-end reverse proxies (Cloudflare, Nginx, Traefik) and back-end application servers for HTTP request framing desyncs (CL.TE, TE.CL, TE.TE, RFC 7230 Dual Content-Length) without corrupting shared socket pipelines.',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' } }),
    async ({ targetUrl, url, target }) => {
      if (!ctx.recon || !ctx.recon.auditHttpRequestSmuggling) return { error: 'auditHttpRequestSmuggling not wired in context' };
      return ctx.recon.auditHttpRequestSmuggling(targetUrl || url || target);
    }, { repeatable: true });

  R('gb_audit_polyglot_ssti', 'MATHEMATICAL POLYGLOT SSTI ENGINE FINGERPRINTING (CWE-1336): injects non-destructive mathematical polyglots (${31*37}, {{31*37}}, <%= 31*37 %>, #{31*37}) across discovered input fields to detect whether template engines (Jinja2, Twig, EJS, Pug, Freemarker) evaluate math to 1147.',
    obj({ targetUrl: { type: 'string', description: 'target domain or endpoint URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'candidate mutation or query endpoints to probe' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditPolyglotSsti) return { error: 'auditPolyglotSsti not wired in context' };
      const resolvedTarget = targetUrl || url || target;
      const discovered = await getDiscovered(resolvedTarget);
      return ctx.recon.auditPolyglotSsti(resolvedTarget, { endpoints: endpoints || (discovered ? [...(discovered.mutationEndpoints || []), ...(discovered.queryEndpoints || [])] : null) });
    }, { repeatable: true });

  R('gb_audit_prototype_gadgets', 'PROTOTYPE POLLUTION RCE GADGET CHAIN AUDIT (CWE-1321 / CWE-78): scans backend AST dependencies and recursive merges to prove whether an active prototype pollution vulnerability can reach child_process (shell, env, NODE_OPTIONS) or template compiler execution gadgets.',
    obj({ projectDir: { type: 'string', description: 'optional directory path of the project to analyze (defaults to workspace)' } }),
    async ({ projectDir }) => {
      if (!ctx.recon || !ctx.recon.auditPrototypeGadgets) return { error: 'auditPrototypeGadgets not wired in context' };
      return ctx.recon.auditPrototypeGadgets(projectDir || process.cwd());
    }, { repeatable: true });

  R('gb_audit_graphql_batch', 'GRAPHQL BATCHING & ALIAS AMPLIFICATION AUDIT (CWE-400): sends non-destructive safe aliased multi-call queries (a: __typename, b: __typename) and array batches to test whether GraphQL gateways enforce query complexity and batch limits.',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'candidate GraphQL endpoints to probe' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditGraphQLBatchAmplification) return { error: 'auditGraphQLBatchAmplification not wired in context' };
      const resolvedTarget = targetUrl || url || target;
      const discovered = await getDiscovered(resolvedTarget);
      return ctx.recon.auditGraphQLBatchAmplification(resolvedTarget, { endpoints: endpoints || discovered?.graphqlEndpoints });
    }, { repeatable: true });

  R('gb_audit_cswsh', 'CROSS-SITE WEBSOCKET HIJACKING (CSWSH) AUDIT (CWE-1385): probes WebSocket upgrade endpoints with untrusted Origin headers (https://evil-attacker.com) to verify whether the server enforces Origin validation during the 101 Switching Protocols handshake.',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'candidate WebSocket endpoints to probe' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditCrossSiteWebSocketHijacking) return { error: 'auditCrossSiteWebSocketHijacking not wired in context' };
      const resolvedTarget = targetUrl || url || target;
      const discovered = await getDiscovered(resolvedTarget);
      return ctx.recon.auditCrossSiteWebSocketHijacking(resolvedTarget, { endpoints: endpoints || discovered?.websocketEndpoints });
    }, { repeatable: true });

  R('gb_audit_dependency_confusion', 'DEPENDENCY CONFUSION & INTERNAL NAMESPACE SQUATTING AUDIT (CWE-427): scans package.json and .npmrc for internal dependencies and resolves against public registry.npmjs.org to ensure no private packages are unclaimed publicly.',
    obj({ projectDir: { type: 'string', description: 'optional directory path of the project to analyze (defaults to workspace)' } }),
    async ({ projectDir }) => {
      if (!ctx.recon || !ctx.recon.auditDependencyConfusion) return { error: 'auditDependencyConfusion not wired in context' };
      return ctx.recon.auditDependencyConfusion(projectDir || process.cwd());
    }, { repeatable: true });

  R('gb_audit_web_cache', 'WEB CACHE DECEPTION & CACHE POISONING AUDIT (CWE-524 / CWE-444): probes authenticated endpoints with static pseudo-extensions (.css, .js, .png, ;.css) and unkeyed headers to verify whether CDN caches store private account JSON.',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'candidate authenticated endpoints to probe' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditWebCacheDeception) return { error: 'auditWebCacheDeception not wired in context' };
      const resolvedTarget = targetUrl || url || target;
      const discovered = await getDiscovered(resolvedTarget);
      return ctx.recon.auditWebCacheDeception(resolvedTarget, { endpoints: endpoints || discovered?.authEndpoints });
    }, { repeatable: true });

  R('gb_audit_oauth_pkce', 'OAUTH2 PKCE & PRE-ACCOUNT TAKEOVER AUDIT (CWE-287 / RFC 7636): analyzes OAuth redirect flows (Google, GitHub, SSO) for high-entropy state parameters and SHA-256 PKCE (code_challenge_method=S256) enforcement.',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'candidate OAuth initiate endpoints' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditOAuthPkceAndState) return { error: 'auditOAuthPkceAndState not wired in context' };
      const resolvedTarget = targetUrl || url || target;
      const discovered = await getDiscovered(resolvedTarget);
      return ctx.recon.auditOAuthPkceAndState(resolvedTarget, { endpoints });
    }, { repeatable: true });

  // ── 4 MULTI-LAYER APPSEC PIPELINES ──
  R('gb_pipeline_bola_lifecycle', '3-LAYER AUTHORIZATION & BOLA/IDOR LIFECYCLE PIPELINE (CWE-639 / OWASP API1:2023): executes Layer 1 (Public surface & route extraction, CORS credentials), Layer 2 (Single-tenant session baseline, token entropy & object ID mapping), and Layer 3 (Cross-tenant replay, parameter substitution & WebSocket invalidation check).',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, sessionToken: { type: 'string', description: 'optional session JWT or bearer token' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'optional specific endpoints' } }),
    async ({ targetUrl, url, target, sessionToken, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditBolaLifecyclePipeline) return { error: 'auditBolaLifecyclePipeline not wired in context' };
      const resolvedTarget = targetUrl || url || target;
      return ctx.recon.auditBolaLifecyclePipeline(resolvedTarget, { sessionToken, endpoints });
    }, { repeatable: true });

  R('gb_pipeline_reachability_proof', '3-PILLAR DETERMINISTIC VULNERABILITY PROOF & REACHABILITY PIPELINE (CWE-1336 / CWE-1321 / CWE-444): executes Pillar 1 (Manifest & dependency declaration audit for declared CVEs), Pillar 2 (Inter-file AST call-graph reachability from HTTP route handlers to vulnerable sinks), and Pillar 3 (In-vivo non-destructive behavioral differential via mathematical polyglots and framing desyncs).',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, projectDir: { type: 'string', description: 'optional local directory path for AST reachability analysis' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'optional candidate endpoints' } }),
    async ({ targetUrl, url, target, projectDir, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditReachabilityProofPipeline) return { error: 'auditReachabilityProofPipeline not wired in context' };
      const resolvedTarget = targetUrl || url || target;
      return ctx.recon.auditReachabilityProofPipeline(resolvedTarget, { projectDir, endpoints });
    }, { repeatable: true });

  R('gb_pipeline_blind_detection', '3-LAYER BLIND VULNERABILITY DETECTION PIPELINE (CWE-89 / CWE-918): executes Layer 1 (In-band boundary reflections & database syntax error disclosures), Layer 2 (3-pass statistical timing differentials with standard deviation analysis for blind SQLi), and Layer 3 (Out-of-band OAST ephemeral cryptographic canary callbacks for asynchronous workers).',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'optional candidate query endpoints' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditBlindDetectionPipeline) return { error: 'auditBlindDetectionPipeline not wired in context' };
      const resolvedTarget = targetUrl || url || target;
      return ctx.recon.auditBlindDetectionPipeline(resolvedTarget, { endpoints });
    }, { repeatable: true });

  R('gb_pipeline_second_order', '3-LAYER SECOND-ORDER STORED INJECTION PIPELINE (CWE-79 / CWE-116): executes Layer 1 (Schema mutation injection with tracked boundary canaries into state-altering inputs), Layer 2 (Multi-step downstream route traversal across admin views, exports, and profiles), and Layer 3 (Headless DOM sink taint instrumentation checking innerHTML, eval, and unsafe DOM assignments).',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'optional specific mutation endpoints' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditSecondOrderPipeline) return { error: 'auditSecondOrderPipeline not wired in context' };
      const resolvedTarget = targetUrl || url || target;
      return ctx.recon.auditSecondOrderPipeline(resolvedTarget, { endpoints });
    }, { repeatable: true });

  R('gb_audit_vibe_security', 'AI-GENERATED APP & VIBE-CODER ARCHITECTURE AUDIT: evaluates client-side secrets & API key exposure (Stripe, Supabase service roles, AWS), unauthenticated API mutations (POST/PUT/DELETE on /api/user, /api/checkout), and prototype pollution integrity.',
    obj({ targetUrl: { type: 'string', description: 'target domain or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, apiRoutes: { type: 'array', items: { type: 'string' }, description: 'candidate API routes to test for unauthenticated mutations' } }),
    async ({ targetUrl, url, target, apiRoutes }) => {
      if (!ctx.recon || !ctx.recon.auditVibeSecurity) return { error: 'auditVibeSecurity not wired in context' };
      return ctx.recon.auditVibeSecurity(targetUrl || url || target, { apiRoutes });
    }, { repeatable: true });

  R('gb_audit_concurrency', 'CONCURRENCY, TOCTOU & IDEMPOTENCY AUDIT (CWE-362): fires synchronized parallel requests with idempotency keys to verify state synchronization and prevent duplicate processing in state-changing operations.',
    obj({ targetUrl: { type: 'string', description: 'target endpoint URL' }, url: { type: 'string', description: 'alias for targetUrl' }, concurrency: { type: 'number', description: 'burst count (default 6, max 10)' } }),
    async ({ targetUrl, url, target, concurrency }) => {
      if (!ctx.recon || !ctx.recon.auditConcurrency) return { error: 'auditConcurrency not wired in context' };
      return ctx.recon.auditConcurrency(targetUrl || url || target, { concurrency });
    }, { repeatable: true });

  R('gb_audit_compliance', 'ENTERPRISE COMPLIANCE FRAMEWORK MAPPING: maps security findings directly to SOC 2 Type II (Trust Services Criteria), ISO 27001:2022 (Annex A Controls), and PCI-DSS v4.0 (Requirement 6).',
    obj({ findings: { type: 'array', description: 'array of finding objects to map' } }),
    async ({ findings }) => {
      if (!ctx.recon || !ctx.recon.generateComplianceScorecard) return { error: 'generateComplianceScorecard not wired in context' };
      return ctx.recon.generateComplianceScorecard(findings || []);
    }, { repeatable: true });

  R('gb_audit_graphql_resilience', 'GRAPHQL QUERY COMPLEXITY, DEPTH & CONTRACT RESILIENCE AUDIT: discovers GraphQL endpoints, checks production introspection exposure, tests recursive query depth limits, and verifies query batching resilience against request flooding.',
    obj({ targetUrl: { type: 'string', description: 'target domain or GraphQL endpoint URL' }, url: { type: 'string', description: 'alias for targetUrl' } }),
    async ({ targetUrl, url, target }) => {
      if (!ctx.recon || !ctx.recon.auditGraphqlResilience) return { error: 'auditGraphqlResilience not wired in context' };
      return ctx.recon.auditGraphqlResilience(targetUrl || url || target);
    }, { repeatable: true });

  R('gb_audit_dual_tenant', 'MULTI-TENANT CROSS-SESSION ISOLATION & BOLA AUDIT (OWASP API1:2023 / CWE-639): evaluates resource isolation by testing cross-session object substitution between Tenant A and Tenant B. Detects whether Tenant B can read, mutate, or access private assets belonging to Tenant A.',
    obj({ targetUrl: { type: 'string', description: 'resource endpoint URL (e.g. https://api.site.com/projects/{id})' }, url: { type: 'string', description: 'alias for targetUrl' }, tokenA: { type: 'string', description: 'valid bearer token or session credentials for Tenant A' }, tokenB: { type: 'string', description: 'valid bearer token or session credentials for Tenant B' }, objectIds: { type: 'array', items: { type: 'string' }, description: 'resource IDs to probe' } }),
    async ({ targetUrl, url, target, tokenA, tokenB, objectIds }) => {
      if (!ctx.recon || !ctx.recon.auditDualTenantIsolation) return { error: 'auditDualTenantIsolation not wired in context' };
      return ctx.recon.auditDualTenantIsolation({ targetUrl: targetUrl || url || target, tokenA, tokenB, objectIds });
    }, { repeatable: true });

  R('gb_audit_token_hygiene', 'TOKEN CRYPTOGRAPHIC HYGIENE & CLAIM AUDIT: parses and cryptographically audits JSON Web Tokens (JWTs) or session bearer tokens for algorithm security (detects alg: "none", weak ciphers), expiration (exp claim enforcement), and sensitive PII or secrets leaked in unencrypted claims.',
    obj({ token: { type: 'string', description: 'raw JWT or bearer token string to audit' } }, ['token']),
    async ({ token }) => {
      if (!ctx.recon || !ctx.recon.auditToken) return { error: 'auditToken not wired in context' };
      return ctx.recon.auditToken(token);
    }, { repeatable: true });

  R('gb_audit_throttling', 'RATE-LIMITING & THROTTLING RESILIENCE AUDIT: checks whether target endpoints return RFC 6585 rate-limiting headers (X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After) and enforce progressive request throttling against automated abuse.',
    obj({ targetUrl: { type: 'string', description: 'endpoint URL to test' }, url: { type: 'string', description: 'alias for targetUrl' } }),
    async ({ targetUrl, url, target }) => {
      if (!ctx.recon || !ctx.recon.auditThrottling) return { error: 'auditThrottling not wired in context' };
      return ctx.recon.auditThrottling(targetUrl || url || target);
    }, { repeatable: true });

  R('gb_audit_canary_reflection', 'ENTERPRISE ZERO-FALSE-POSITIVE BENIGN CANARY REFLECTION & DOM TAINT AUDIT: probes target URL query parameters and discovered DOM forms with harmless boundary delimiter tokens (__gbcanary_xxxx\'"><gbtest>) to mathematically prove whether input is reflected unencoded (CWE-79) or safely entity-escaped. Also checks Playwright DOM sink traces (innerHTML, outerHTML, document.write) for active taint. Returns reproducible curl PoC, exact response snippet, and ready-to-merge remediation patch.',
    obj({ targetUrl: { type: 'string', description: 'target domain or endpoint URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, profile: { type: 'string', description: 'browser profile (default "default")' } }),
    async ({ targetUrl, url, target, profile }) => {
      if (!ctx.recon || !ctx.recon.auditCanaryReflections) return { error: 'auditCanaryReflections not wired in context' };
      return ctx.recon.auditCanaryReflections(profile || 'default', targetUrl || url || target);
    }, { repeatable: true });

  R('gb_audit_semantic_surface', 'IN-BROWSER SEMANTIC ROUTE & ROLE SURFACE AUDIT: inspects client-side SPA runtime (Next.js, Remix, Vue Router, Nuxt) and DOM elements to extract application routes, privileged role-gated buttons/forms (Admin, Billing, Delete, Team, API Keys), and internal API endpoints that traditional crawlers miss.',
    obj({ targetUrl: { type: 'string', description: 'target domain or endpoint URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' }, profile: { type: 'string', description: 'browser profile (default "default")' } }),
    async ({ targetUrl, url, target, profile }) => {
      if (!ctx.recon || !ctx.recon.auditSemanticSurface) return { error: 'auditSemanticSurface not wired in context' };
      return ctx.recon.auditSemanticSurface(profile || 'default', targetUrl || url || target);
    }, { repeatable: true });

  R('gb_audit_auth_matrix', 'BUSINESS LOGIC & BROKEN ACCESS CONTROL (BOLA/IDOR) AUDIT (OWASP A01:2021 / CWE-285): tests whether backend API and administrative endpoints enforce server-side authorization or merely rely on UI button hiding. Strips session cookies and tokens to test unauthenticated access to privileged routes. Generates reproducible curl PoC and pull-request ready authorization middleware patches.',
    obj({ targetUrl: { type: 'string', description: 'base target URL' }, url: { type: 'string', description: 'alias for targetUrl' }, endpoints: { type: 'array', items: { type: 'string' }, description: 'list of candidate endpoints or routes to test' } }),
    async ({ targetUrl, url, target, endpoints }) => {
      if (!ctx.recon || !ctx.recon.auditAuthMatrix) return { error: 'auditAuthMatrix not wired in context' };
      return ctx.recon.auditAuthMatrix(targetUrl || url || target, { endpoints });
    }, { repeatable: true });

  R('gb_audit_http_headers', 'ENTERPRISE BURP SUITE-STYLE DIFFERENTIAL HTTP HEADER & VERB AUDIT: probes target endpoints with verb tampering (OPTIONS, HEAD, TRACE, PUT, DELETE, PATCH), Host Header injection / reverse proxy cache poisoning (X-Forwarded-Host), internal IP trust spoofing (X-Forwarded-For: 127.0.0.1), CORS differential origin matrix (null, arbitrary attacker, subdomain reflection with credentials), Cache-Control PII leakage, and modern enterprise defense header compliance (HSTS, CSP, XFO, XCTO, Permissions-Policy, COOP). Returns structured CWE vulnerabilities, proof-of-concept curl commands, and 4-pillar hardening directives.',
    obj({ targetUrl: { type: 'string', description: 'target endpoint or base URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' } }),
    async ({ targetUrl, url, target }) => {
      if (!ctx.recon || !ctx.recon.auditHttpHeaders) return { error: 'auditHttpHeaders not wired in context' };
      return ctx.recon.auditHttpHeaders(targetUrl || url || target);
    }, { repeatable: true });

  R('gb_recon', 'FULL SECURITY RECON & ATTACK SURFACE AUDIT of any website, domain, or URL: evaluates HTTP security headers (CSP, HSTS, XFO, XCTO, Referrer-Policy, Cookies), DNS posture (SPF, DMARC, DKIM, CAA, MX, CNAME takeover risk), perimeter port exposure (80, 443, 22, 25, 3306, 5432, 6379), WAF fingerprinting, overall security score & grade (A-F), and actionable 4-pillar remediations (Traefik, Nginx, Express, DNS). Always call this when asked for "recon", "audit", "security scan", "vulnerabilities", or "check attack surface".',
    obj({ target: { type: 'string', description: 'domain or URL to audit, e.g. "useme.com" or "https://my-app.engineer"' } }, ['target']),
    async ({ target }) => {
      if (!ctx.recon || !ctx.recon.auditTarget) return { error: 'recon engine not wired in context' };
      const raw = await ctx.recon.auditTarget(target);
      if (!raw || typeof raw !== 'object') return raw;
      return {
        target: raw.target,
        url: raw.url,
        timestamp: raw.timestamp,
        score: raw.score,
        grade: raw.grade,
        findingsCount: raw.findingsCount,
        findings: (raw.findings || []).map(f => ({
          key: f.key,
          title: f.title,
          severity: f.severity,
          impact: f.impact,
          remediation: f.remediation
        })),
        headers: raw.headers ? {
          missing: (raw.headers.audit || []).filter(h => !h.present).map(h => h.name),
          present: (raw.headers.audit || []).filter(h => h.present).map(h => h.name)
        } : undefined,
        dns: raw.dns ? {
          spf: raw.dns.spf,
          dmarc: raw.dns.dmarc,
          mx: raw.dns.mx,
          takeoverRisk: raw.dns.takeoverRisk
        } : undefined,
        ports: raw.ports ? {
          open: raw.ports.openPorts,
          suspicious: raw.ports.suspiciousPorts
        } : undefined,
        waf: raw.waf ? raw.waf.detected : false
      };
    }, { repeatable: true });

  R('gb_security_eval', 'CLIENT-SIDE DOM & STORAGE SECURITY AUDIT of the active browser tab: scans localStorage and sessionStorage for leaked auth tokens / JWTs / API keys, audits HTML forms for CSRF tokens and HTTP submissions, checks inline scripts and DOM XSS sinks.',
    obj({ profile: { type: 'string', description: 'browser profile to audit, default "default"' } }),
    async ({ profile }) => {
      if (!ctx.recon || !ctx.recon.auditActivePage) return { error: 'DOM security auditor not wired in context' };
      return ctx.recon.auditActivePage(profile || 'default');
    }, { repeatable: true });

  R('gb_redteam_probe', 'ACTIVE RED TEAM ATTACK SURFACE PROBE: tests target for exposed sensitive files (/.git, /.env, /metrics, /health, /actuator, /swagger.json, /api-docs), tests CORS misconfigurations with rogue origin reflection and credential theft, and tests iframe clickjacking frameability.',
    obj({ target: { type: 'string', description: 'target domain or URL' } }, ['target']),
    async ({ target }) => {
      if (!ctx.recon || !ctx.recon.runRedteamAudit) return { error: 'red team probe engine not wired in context' };
      return ctx.recon.runRedteamAudit(target);
    }, { repeatable: true });

  R('gb_recon_probe', 'BROKEN MULTI-SESSION INVALIDATION AUDIT (CWE-613): verifies whether user password change / credential rotation terminates active concurrent sessions across secondary browsers and mobile devices.',
    obj({ loginUrl: { type: 'string' }, passwordChangeUrl: { type: 'string' }, protectedUrl: { type: 'string' } }, ['loginUrl', 'passwordChangeUrl', 'protectedUrl']),
    async ({ loginUrl, passwordChangeUrl, protectedUrl }) => {
      if (!ctx.recon || !ctx.recon.testHttpSessionInvalidation) return { error: 'session probe engine not wired in context' };
      return ctx.recon.testHttpSessionInvalidation({ loginUrl, passwordChangeUrl, protectedUrl });
    }, { repeatable: true });

  R('gb_page_script', 'EXECUTE CUSTOM IN-BROWSER RECON / SECURITY SCRIPT in the target browser page context: inspects live DOM, extracts endpoints from loaded bundles, reads window globals, or evaluates custom client-side red-team tests.',
    obj({ script: { type: 'string', description: 'JavaScript code to execute in the page' }, profile: { type: 'string', description: 'browser profile, default "default"' } }, ['script']),
    async ({ script, profile }) => {
      if (!ctx.recon || !ctx.recon.executeSecurityScript) return { error: 'browser script evaluator not wired in context' };
      return ctx.recon.executeSecurityScript(profile || 'default', script);
    });

  // ── Hands-on Interactive Browser & Workspace Tools for Adaptive Red-Team Agent ──
  R('gb_browser_navigate', 'DIRECT BROWSER NAVIGATION: navigates the browser to any target URL, loads full client-side SPA, and returns HTTP status, title, forms count, links count, and page text. Use this to steer the browser as your hands.',
    obj({ url: { type: 'string', description: 'URL to navigate to' }, profile: { type: 'string', description: 'browser profile, default "default"' } }, ['url']),
    async ({ url, profile }) => {
      if (!ctx.recon || !ctx.recon.browserNavigate) return { error: 'browserNavigate not wired in context' };
      return ctx.recon.browserNavigate(profile || 'default', url);
    }, { repeatable: true });

  R('gb_browser_click', 'DIRECT BROWSER CLICK: clicks any button, link, tab, or interactive element by CSS selector or text locator (e.g. "button:has-text(\"Login\")", "#submit", "a[href*=\"/admin\"]").',
    obj({ selector: { type: 'string', description: 'CSS selector or Playwright text locator to click' }, profile: { type: 'string', description: 'browser profile, default "default"' } }, ['selector']),
    async ({ selector, profile }) => {
      if (!ctx.recon || !ctx.recon.browserClick) return { error: 'browserClick not wired in context' };
      return ctx.recon.browserClick(profile || 'default', selector);
    }, { repeatable: true });

  R('gb_browser_type', 'DIRECT BROWSER INPUT: fills input fields, search boxes, or form controls with specified text or test values.',
    obj({ selector: { type: 'string', description: 'CSS selector of the input field' }, text: { type: 'string', description: 'text to type into the field' }, profile: { type: 'string', description: 'browser profile, default "default"' } }, ['selector', 'text']),
    async ({ selector, text, profile }) => {
      if (!ctx.recon || !ctx.recon.browserType) return { error: 'browserType not wired in context' };
      return ctx.recon.browserType(profile || 'default', selector, text);
    }, { repeatable: true });

  R('gb_browser_dom', 'QUERY LIVE DOM ELEMENTS: inspects interactive elements, links, forms, input fields, and attributes on the current page.',
    obj({ selector: { type: 'string', description: 'CSS selector (e.g. "a", "form", "input", ".btn"), defaults to all interactive elements' }, profile: { type: 'string', description: 'browser profile, default "default"' } }),
    async ({ selector, profile }) => {
      if (!ctx.recon || !ctx.recon.browserDom) return { error: 'browserDom not wired in context' };
      return ctx.recon.browserDom(profile || 'default', selector);
    }, { repeatable: true });

  R('gb_browser_network', 'INSPECT LIVE NETWORK ACTIVITY: inspects real-time API calls, XHR/fetch requests, backend endpoints, and assets triggered by the page.',
    obj({ profile: { type: 'string', description: 'browser profile, default "default"' } }),
    async ({ profile }) => {
      if (!ctx.recon || !ctx.recon.browserNetwork) return { error: 'browserNetwork not wired in context' };
      return ctx.recon.browserNetwork(profile || 'default');
    }, { repeatable: true });

  R('gb_workspace_exec', 'EXECUTE WORKSPACE COMMAND / SCRIPT: runs commands in the operator workspace shell (e.g. curl, dig, openssl, custom verification scripts) to perform low-level network and protocol checks.',
    obj({ command: { type: 'string', description: 'shell command to execute' }, timeoutMs: { type: 'number', description: 'timeout in milliseconds (default 25000)' } }, ['command']),
    async ({ command, timeoutMs }) => {
      if (!ctx.recon || !ctx.recon.workspaceExec) return { error: 'workspaceExec not wired in context' };
      return ctx.recon.workspaceExec(command, timeoutMs);
    }, { repeatable: true });

  
  // ── 6 advanced security auditor tools ──
  R('gb_auth_register', 'AUTONOMOUS ACCOUNT REGISTRATION FOR AUDITING: automatically finds signup/registration on the target website, generates credentials with Gmail alias (e.g. wesley.biab+audit123@gmail.com), fills form, submits, checks the logged-in Gmail inbox for verification links or OTP codes, and establishes an authenticated session in the chosen profile.',
    obj({ targetUrl: { type: 'string', description: 'target website or base URL' }, url: { type: 'string', description: 'alias for targetUrl' }, profile: { type: 'string', description: 'browser profile to store the session into (e.g. "audit_tenant_a", "audit_tenant_b", "default")' }, username: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' }, useGmail: { type: 'boolean', description: 'whether to use logged-in Gmail alias (default true)' } }),
    async ({ targetUrl, url, target, profile, username, email, password, useGmail }) => {
      if (!ctx.recon || !ctx.recon.authRegister) return { error: 'Account automation not wired in context' };
      return ctx.recon.authRegister(profile || 'default', { targetUrl: targetUrl || url || target, username, email, password, useGmail: useGmail !== false });
    }, { repeatable: true });

  R('gb_auth_verify_email', 'AUTONOMOUS EMAIL VERIFICATION VIA LOGGED-IN GMAIL: checks the owner\'s logged-in Gmail account in the "google" profile for recent verification emails from the target site, extracts the verification link or OTP code, and automatically verifies the target account.',
    obj({ profile: { type: 'string', description: 'target browser profile holding the registration session (default "default")' }, targetUrl: { type: 'string', description: 'target website URL' }, url: { type: 'string', description: 'alias for targetUrl' } }),
    async ({ profile, targetUrl, url }) => {
      if (!ctx.recon || !ctx.recon.authVerifyEmail) return { error: 'Email verification automation not wired in context' };
      return ctx.recon.authVerifyEmail(profile || 'default', { targetUrl: targetUrl || url || target });
    }, { repeatable: true });

  R('gb_auth_login', 'AUTONOMOUS LOGIN FOR AUDITING: automatically finds login on the target website, fills credentials, and establishes an authenticated session in the chosen profile.',
    obj({ targetUrl: { type: 'string', description: 'target website URL' }, url: { type: 'string', description: 'alias for targetUrl' }, username: { type: 'string', description: 'username or email' }, password: { type: 'string', description: 'password' }, profile: { type: 'string', description: 'browser profile (default "default")' } }, ['password']),
    async ({ targetUrl, url, target, username, password, profile }) => {
      if (!ctx.recon || !ctx.recon.authLogin) return { error: 'Account automation not wired in context' };
      return ctx.recon.authLogin(profile || 'default', { targetUrl: targetUrl || url || target, username, password });
    }, { repeatable: true });

  R('gb_audit_bola', 'MULTI-SESSION AUTHORIZATION & BOLA / IDOR AUDIT (CWE-639 / OWASP API1:2023): tests cross-profile or dual-token access against sensitive resource endpoints to verify tenant boundary isolation.',
    obj({ targetUrl: { type: 'string', description: 'target resource URL' }, url: { type: 'string', description: 'alias for targetUrl' }, profileA: { type: 'string', description: 'primary tenant browser profile (e.g. audit_tenant_a)' }, profileB: { type: 'string', description: 'secondary tenant browser profile (e.g. audit_tenant_b)' }, tokenA: { type: 'string', description: 'session/bearer token for Tenant A' }, tokenB: { type: 'string', description: 'session/bearer token for Tenant B' }, objectIds: { type: 'array', items: { type: 'string' }, description: 'resource IDs to probe' } }),
    async ({ targetUrl, url, target, profileA, profileB, tokenA, tokenB, objectIds }) => {
      if (!ctx.recon || !ctx.recon.auditBola) return { error: 'BOLA auditor engine not wired in context' };
      return ctx.recon.auditBola({ targetUrl: targetUrl || url || target, profileA, profileB, tokenA, tokenB, objectIds });
    }, { repeatable: true });

  R('gb_audit_dom_sinks', 'DYNAMIC DOM SINK & TAINT AUDIT: instruments and inspects browser DOM sinks (innerHTML, outerHTML, eval, Function, document.write, navigation sinks, and reflected query parameters) in the active page.',
    obj({ profile: { type: 'string', description: 'browser profile, default "default"' }, targetUrl: { type: 'string', description: 'target domain or URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' } }),
    async ({ profile, targetUrl, url }) => {
      if (!ctx.recon || !ctx.recon.auditDomSinks) return { error: 'DOM sink auditor not wired in context' };
      return ctx.recon.auditDomSinks(profile || 'default', targetUrl || url || target);
    }, { repeatable: true });

  R('gb_audit_postmessage', 'POSTMESSAGE & CROSS-WINDOW BOUNDARY AUDIT: inspects window message event listeners in the active page, checks for missing event.origin validation, and flags wildcard targetOrigin "*".',
    obj({ profile: { type: 'string', description: 'browser profile, default "default"' }, targetUrl: { type: 'string', description: 'target domain or URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' } }),
    async ({ profile, targetUrl, url }) => {
      if (!ctx.recon || !ctx.recon.auditPostMessages) return { error: 'postMessage auditor not wired in context' };
      return ctx.recon.auditPostMessages(profile || 'default', targetUrl || url || target);
    }, { repeatable: true });

  R('gb_audit_api_graphql', 'DYNAMIC API ROUTE HARVESTING & GRAPHQL INTROSPECTION AUDIT: harvests discovered REST endpoints and probes GraphQL endpoints for exposed __schema introspection, discovering queries, mutations, and sensitive fields.',
    obj({ targetUrl: { type: 'string', description: 'target domain or URL' }, url: { type: 'string', description: 'alias for targetUrl' }, profile: { type: 'string', description: 'browser profile, default "default"' } }),
    async ({ targetUrl, url, target, profile }) => {
      if (!ctx.recon || !ctx.recon.auditApiAndGraphql) return { error: 'API/GraphQL auditor not wired in context' };
      return ctx.recon.auditApiAndGraphql(targetUrl || url || target, profile || 'default');
    }, { repeatable: true });

  R('gb_audit_websockets', 'WEBSOCKET & STREAMING PROTOCOL AUDIT: verifies whether active WebSockets use secure wss:// encryption and audits URLs for sensitive tokens exposed in query parameters.',
    obj({ profile: { type: 'string', description: 'browser profile, default "default"' }, targetUrl: { type: 'string', description: 'target domain or URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' } }),
    async ({ profile, targetUrl, url }) => {
      if (!ctx.recon || !ctx.recon.auditWebSockets) return { error: 'WebSocket auditor not wired in context' };
      return ctx.recon.auditWebSockets(profile || 'default', targetUrl || url || target);
    }, { repeatable: true });

  R('gb_audit_storage', 'CLIENT STORAGE HYGIENE & TOKEN EXPOSURE AUDIT: deep inspection of localStorage, sessionStorage, and cookies for exposed JWTs, API tokens, passwords, and missing HttpOnly / Secure flags.',
    obj({ profile: { type: 'string', description: 'browser profile, default "default"' }, targetUrl: { type: 'string', description: 'target domain or URL to audit' }, url: { type: 'string', description: 'alias for targetUrl' } }),
    async ({ profile, targetUrl, url }) => {
      if (!ctx.recon || !ctx.recon.auditStorageHygiene) return { error: 'Storage hygiene auditor not wired in context' };
      return ctx.recon.auditStorageHygiene(profile || 'default', targetUrl || url || target);
    }, { repeatable: true });

  return reg.names().length;
}

module.exports = { registerOperatorTools, flowProblems, sanitizeFlow, isWatcher, summarizeRun };
