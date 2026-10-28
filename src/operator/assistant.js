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
  description: 'ANSWER the owner and end this turn. text = the answer in the owner\'s language, plain and complete (markdown is fine: short headings, bullets, bold). details = optional evidence/what you did for a "details" fold. cards = optional actions for the app: {kind:"results", watcherId, title} opens a watcher\'s results; {kind:"approvals", title} opens the approvals; {kind:"url", url, title} opens a page; {kind:"recording", id, title} shows a recording (added by itself for every recording you start); {kind:"choice", title} is an ANSWER OPTION when you ask the owner something — tapping it sends the title back as their next message. status "blocked" only when you could not do what was asked.',
  schema: { type: 'object', properties: { text: { type: 'string' }, details: { type: 'string' }, cards: { type: 'array', items: { type: 'object' } }, status: { type: 'string', enum: ['done', 'blocked'] } }, required: ['text'] },
  map: ({ text, details, cards, status }) => {
    let outCards = Array.isArray(cards) ? cards.slice(0, 8) : [];
    const ans = String(text || '');
    if (outCards.length === 0 && (/Security\s*Audit\s*Report|Executive\s*Scorecard|Hardening\s*Directives/i.test(ans))) {
      const urlMatch = ans.match(/https?:\/\/[a-zA-Z0-9.\-_]+/i);
      const targetUrl = urlMatch ? urlMatch[0] : '';
      outCards = [
        { kind: 'pdf', title: 'Save Report as PDF' },
        ...(targetUrl ? [{ kind: 'recon', title: 'ReconForge Report', url: targetUrl }] : [])
      ];
    }
    return {
      status: status === 'blocked' ? 'blocked' : 'done',
      summary: ans.slice(0, 600),
      report: {
        answer: ans,
        details: details ? String(details) : '',
        cards: outCards
      }
    };
  },
  proseIsReply: true,
};

/** Human labels for the steps the app shows — the tool name is the fallback. */
const STEP_LABELS = {
  gb_guide: 'Reading the guide', gb_memory_read: 'Reading my notes', gb_memory_write: 'Keeping a note',
  gb_logs: 'Reading the log', gb_runs_recent: 'Checking recent runs', gb_jobs: 'Checking jobs', gb_job: 'Reading a job', gb_sessions: 'Checking browser sessions', gb_look: 'Looking at the page', gb_busy: 'Checking the browser',
  gb_watchers: 'Checking watchers', gb_watcher_health: 'Checking watcher health', gb_watcher_feed: 'Reading watcher results', gb_watcher_config: 'Updating watcher settings', gb_watcher_posts: 'Updating watched posts', gb_watcher_run: 'Running the watcher', gb_watcher_wait: 'Waiting for the pass', gb_watcher_toggle: 'Switching the watcher', gb_watcher_probe: 'Reading the thread',
  gb_tools: 'Checking the tool palette', gb_roles: 'Checking roles', gb_role_get: 'Reading a role', gb_role_save: 'Creating a role', gb_role_update: 'Updating a role',
  gb_flows: 'Checking automations', gb_flow_get: 'Reading an automation', gb_flow_save: 'Saving an automation', gb_flow_run: 'Running an automation', gb_flow_wait: 'Waiting for the run', gb_flow_runs: 'Checking runs', gb_flow_run_status: 'Checking the run', gb_platforms: 'Checking platforms',
  gb_recon: 'Auditing security & perimeter', gb_audit_subdomains: 'Enumerating subdomains & CT logs', gb_audit_tech_stack: 'Fingerprinting tech stack & CMS', gb_audit_sensitive_paths: 'Auditing sensitive paths & security.txt', gb_audit_service_banners: 'Grabbing service banners & CVE correlation', gb_capture_proof: 'Capturing automated visual proof', gb_audit_tls_health: 'Auditing TLS/SSL ciphers & protocol health', gb_audit_bola: 'Auditing BOLA / tenant authorization', gb_audit_dom_sinks: 'Instrumenting DOM sinks & taints', gb_audit_postmessage: 'Auditing PostMessage security', gb_audit_api_graphql: 'Harvesting APIs & GraphQL introspection', gb_audit_websockets: 'Auditing WebSocket protocols & tokens', gb_audit_storage: 'Auditing client storage & tokens', gb_security_eval: 'Auditing in-browser DOM & storage', gb_redteam_probe: 'Probing endpoints & CORS', gb_recon_probe: 'Testing multi-session invalidation (CWE-613)', gb_page_script: 'Running in-browser recon script',
  gb_walk: 'Browsing for you', record_start: 'Starting a recording', record_status: 'Checking the recording', record_stop: 'Stopping the recording', record_list: 'Listing recordings', gb_walk_wait: 'Browsing…', gb_walk_stop: 'Stopping the walk', gb_files_recent: 'Checking captured files', gb_file_show: 'Showing the file', gb_people: 'Checking people', save_task_list: 'Planning', update_task: 'Progress', reply: 'Answering',
};
const labelOf = (name) => STEP_LABELS[name] || String(name || '').replace(/^gb_/, '').replace(/_/g, ' ');
/* The exit and the plan bookkeeping are not "steps" the owner needs to see (the task list shows live). */
const HIDDEN_STEPS = new Set(['reply', 'finish', 'save_task_list', 'update_task']);

/** One human line for a tool's result — what the owner sees under a step instead of JSON. */
function briefOf(name, text) {
  const s = String(text || '').trim(); if (!s) return '';
  let v = null; try { v = JSON.parse(s.replace(/… \(\d+ more chars.*$/s, '').replace(/\n… \(.*$/s, '')); } catch { v = null; }
  if (v === null && /^[[{]/.test(s)) {
    // the event keeps only the head of a long result: read the numbers that matter from it
    const num = (k) => { const m = s.match(new RegExp(`"${k}"\\s*:\\s*(\\d+)`)); return m ? Number(m[1]) : null; };
    const err = s.match(/"error"\s*:\s*"([^"]{1,120})/); if (err) return 'did not work: ' + err[1];
    if (name === 'gb_watcher_feed') { const t = num('total'); const u = num('unhandled'); return t != null ? `${t} item${t === 1 ? '' : 's'}${u != null ? ` · ${u} open` : ''}` : ''; }
    if (name === 'gb_watchers') { const c = (s.match(/"active"\s*:\s*true/g) || []).length; return c ? `${c} watcher${c === 1 ? '' : 's'} on` : ''; }
    return '';
  }
  if (v && typeof v === 'object' && v.error) return 'did not work: ' + String(v.error).slice(0, 120);
  const n = (x) => Array.isArray(x) ? x.length : 0;
  try {
    switch (name) {
      case 'gb_watchers': return Array.isArray(v) ? `${v.length} watcher${v.length === 1 ? '' : 's'} · ${v.filter((w) => w.active).length} on` : '';
      case 'gb_watcher_health': return v ? `${v.running ? 'running now' : v.sinceMinutes != null ? `last pass ${v.sinceMinutes} min ago` : 'no pass yet'}${v.lastPass ? ` · ${v.lastPass.messages || 0} messages · ${v.lastPass.waiting || 0} waiting` : ''}` : '';
      case 'gb_watcher_feed': { const items = v && Array.isArray(v.items) ? v.items : null; const total = v && v.counts && v.counts.total != null ? v.counts.total : items ? items.length : null; const waiting = items ? items.filter((i) => /wait/i.test(String(i.state || i.standing || ''))).length : null; return total != null ? `${total} item${total === 1 ? '' : 's'}${waiting != null ? ` · ${waiting} waiting on you` : ''}` : ''; }
      case 'gb_busy': return v && n(v.running) ? `browser busy: ${v.running.join(', ')}` : 'browser free';
      case 'gb_watcher_run': return v && v.status === 'busy' ? 'another pass holds the browser' : v && v.runId ? 'pass started' : '';
      case 'gb_watcher_wait': return v && v.stillRunning ? 'still running' : v && v.lastPass ? `pass done · ${v.lastPass.messages || 0} messages · ${v.lastPass.waiting || 0} waiting` : 'pass done';
      case 'gb_flows': return Array.isArray(v) ? `${v.length} automations` : '';
      case 'gb_roles': return Array.isArray(v) ? `${v.length} roles` : '';
      case 'gb_platforms': return Array.isArray(v) ? `${v.length} platforms` : '';
      case 'gb_runs_recent': return Array.isArray(v) ? `${v.length} recent runs` : '';
      case 'gb_audit_bola': return v && v.vulnerable !== undefined ? (v.vulnerable ? 'VULNERABLE (CWE-639 BOLA): cross-tenant access permitted' : 'SECURE: tenant boundaries strictly enforced') : '';
      case 'gb_audit_dom_sinks': return v ? `${v.sinksFound || 0} DOM sinks · ${v.reflectedParams ? v.reflectedParams.length : 0} reflected params` : '';
      case 'gb_audit_postmessage': return v ? `${v.messageListenerCount || 0} listener(s) · ${v.vulnerable ? 'UNVERIFIED ORIGIN' : 'VERIFIED'}` : '';
      case 'gb_audit_api_graphql': return v ? `${v.harvestedRoutesCount || 0} routes · GraphQL Introspection: ${v.graphqlAudit && v.graphqlAudit.introspectionEnabled ? 'OPEN' : 'SECURE'}` : '';
      case 'gb_audit_websockets': return v ? `${v.socketsCount || 0} WebSockets · ${(v.findings || []).length} issue(s)` : '';
      case 'gb_audit_http_headers': return v && v.grade ? `Grade ${v.grade} (${v.score}/100) · ${v.findingsCount || 0} findings · Verbs: ${Object.keys(v.verbResults || {}).length} tested` : '';
      case 'gb_audit_storage': return v ? `${v.sensitiveTokensFound || 0} sensitive token(s) · ${(v.findings || []).length} issue(s)` : '';
      case 'gb_recon': return v && v.grade ? `Grade ${v.grade} (${v.score}/100) · ${v.findingsCount || 0} findings · WAF: ${(v.waf && v.waf.name) || 'None'}` : '';
      case 'gb_security_eval': return v && v.advisories ? `${v.advisories.length} DOM/storage advisories · ${v.sensitiveStorageFound || 0} sensitive tokens` : '';
      case 'gb_redteam_probe': return v && v.endpoints ? `${(v.endpoints.findings || []).length} exposed files · CORS: ${v.cors?.vulnerableToCredentialTheft ? 'VULNERABLE' : 'SECURE'}` : '';
      case 'gb_recon_probe': return v && v.vulnerable !== undefined ? (v.vulnerable ? 'VULNERABLE (CWE-613): session active after password change' : 'SECURE: session revoked on password change') : '';
      case 'gb_page_script': return v && v.success ? 'script executed in page context' : (v && v.error ? 'script error: ' + v.error : '');

      /*
       * WHAT THE DEVICE IS DOING, IN THE CHAT WHERE THE QUESTION WAS ASKED.
       *
       * The owner asks on the phone and the work runs on the desktop, so this step IS the progress
       * as far as they are concerned. Showing the last line rather than a count: "5 lines" says
       * nothing, "click_xy {x:..}" says the editor is being driven.
       */
      case 'gb_device_log': {
        if (!v) return '';
        if (v.error) return String(v.error).slice(0, 120);
        const ls = Array.isArray(v.lines) ? v.lines : [];
        const last = ls.length ? String(ls[ls.length - 1]).slice(0, 90) : '';
        const where = v.device ? v.device + (v.online ? '' : ' (offline)') : 'the device';
        return last ? where + ' · ' + last : where + ' · nothing reported yet';
      }
      case 'gb_logs': return `${s.split('\n').length} log lines`;
      case 'gb_look': return v ? `${v.title || v.url || 'page'}${n(v.controls) ? ` · ${v.controls.length} controls` : ''}` : '';
      case 'gb_walk': return v && v.jobId ? `browsing in ${v.profile || 'the browser'}` : '';
      case 'gb_walk_wait': if (v?.execution?.mode) return v.execution.mode + ' · ' + (v.execution.verified ? 'verified' : 'not yet verified') + ' · ' + (v.execution.reason || ''); return v ? (v.stillRunning ? 'still browsing' : `${v.status || 'done'}${n(v.proposals) ? ` · ${v.proposals.length} draft${v.proposals.length === 1 ? '' : 's'} for you` : ''}`) : '';
      case 'gb_flow_save': case 'gb_role_save': case 'gb_role_update': case 'gb_watcher_config': case 'gb_watcher_toggle': case 'gb_watcher_posts': return v && v.id ? `saved ${v.id}` : 'saved';
      case 'gb_flow_run': return v && v.runId ? 'run started' : '';
      case 'gb_flow_wait': return v ? `${v.status || 'done'}${v.verified ? ' · verified' : ''}` : '';
      case 'gb_files_recent': return Array.isArray(v) ? `${v.length} file${v.length === 1 ? '' : 's'}${v[0] ? ` · newest ${v[0].name}` : ''}` : '';
      case 'record_start': return v && v.recording ? (v.recording.state === 'queued' ? 'queued — starts when the current recording ends' : `recording started (until ${v.recording.until}${v.recording.until === 'duration' ? ', ' + v.recording.maxMinutes + ' min' : ''})`) : v && v.error ? v.error : '';
      case 'record_status': return v && v.state ? `${v.state} · ${v.seconds || 0}s · ${Math.round((v.bytes || 0) / 1048576)} MB${v.reason ? ' · ' + v.reason : ''}` : '';
      case 'record_stop': return v && v.ok ? 'stopping' : v && v.error ? v.error : '';
      case 'record_list': return v && Array.isArray(v.recordings) ? `${v.recordings.length} recording(s)${v.queue && v.queue.length ? ', ' + v.queue.length + ' in the queue' : ''}, ${v.freeGB} GB free` : '';
      case 'gb_audit_subdomains': return v ? `${v.count || 0} subdomains discovered across CT logs` : '';
      case 'gb_audit_tech_stack': return v && v.technologies ? `Identified ${v.technologies.map((t) => t.name).slice(0, 3).join(', ') || 'stack'}` : '';
      case 'gb_audit_sensitive_paths': return v ? `${(v.findings || []).length} exposed files/paths found` : '';
      case 'gb_audit_service_banners': return v ? `${(v.openPorts || []).length} open ports detected` : '';
      case 'gb_capture_proof': return v ? `Visual proof screenshot captured (${v.title || 'page'})` : '';
      case 'gb_audit_tls_health': return v ? `TLS Grade ${v.grade || 'A'} · Cipher: ${v.cipher || 'strong'}` : '';
      case 'gb_workspace_exec': return v && v.stdout ? String(v.stdout).trim().slice(0, 500) : (v && v.stderr ? 'stderr: ' + String(v.stderr).slice(0, 300) : (v ? 'completed' : ''));
      case 'gb_audit_prototype_gadgets': return v ? `Found ${(v.gadgets || []).length} gadget sinks` : '';
      case 'gb_audit_polyglot_ssti': return v ? (v.reflected ? 'VULNERABLE: SSTI evaluation confirmed' : 'SECURE: No SSTI reflection') : '';
      case 'gb_audit_ast_reachability': return v ? `Analyzed ${v.routesCount || 0} routes for reachability` : '';
      case 'gb_file_show': return v && v.shown ? `showing ${v.name}` : v && v.name ? `${v.name} (${v.kind})` : '';
      case 'gb_memory_write': return 'noted';
      case 'gb_guide': case 'gb_memory_read': return 'read';
    }
  } catch { /* fall through */ }
  return v && typeof v === 'object' ? '' : s.slice(0, 600);
}

/** A turn's wall clock: past this the turn ends as blocked instead of browsing for an hour. */
const TURN_MAX_MS = 40 * 60 * 1000;

/** Every recording a turn started gets a card in the answer, whether or not the model added one. */
function withRecordingCards(cards, steps) {
  const out = cards.slice(); const have = new Set(out.filter((c) => c && c.kind === 'recording').map((c) => String(c.id)));
  for (const s of steps) { if (s.recording && !have.has(String(s.recording))) { have.add(String(s.recording)); out.push({ kind: 'recording', id: String(s.recording), title: 'Recording' }); } }
  return out;
}

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
        .map((c) => ({ id: c.id, title: c.title, agentType: c.agentType || 'browser', updatedAt: c.updatedAt, turns: c.turns.length, running: live.has(c.id) }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch { return []; }
  }
  function create(title, agentType = 'browser') {
    const id = `chat-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return save({ id, title: String(title || 'New chat').slice(0, 80), agentType: String(agentType || 'browser'), createdAt: now(), updatedAt: now(), turns: [] });
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
      const e = ev[i];
      if (e.kind === 'thought' && e.text) {
        const clean = String(e.text).trim().replace(/<\/?think>/g, '');
        // Exclude full final reports from duplicating as a tiny step
        if (clean && clean.length > 5 && !clean.startsWith('# Enterprise Security Audit Report')) {
          out.push({ name: 'thought', label: 'Thinking & Strategy', args: '', text: clean.slice(0, 32000), t: e.t });
        }
        continue;
      }
      if (e.kind === 'tool' && e.name === 'update_task') {
        let note = '';
        try {
          const parsed = typeof e.args === 'object' ? e.args : JSON.parse(e.args || '{}');
          note = parsed.note || '';
        } catch (_) {}
        if (note && note.length > 3) {
          out.push({ name: 'thought', label: 'Reasoning & Audit Progress', args: '', text: String(note).slice(0, 5000), t: e.t });
        }
        continue;
      }
      if (e.kind === 'tool' && e.name === 'save_task_list') {
        let count = 0;
        try {
          const parsed = typeof e.args === 'object' ? e.args : JSON.parse(e.args || '{}');
          count = Array.isArray(parsed.tasks) ? parsed.tasks.length : 0;
        } catch (_) {}
        if (count > 0) {
          out.push({ name: 'thought', label: 'Audit Strategy Plan', args: '', text: `Initialized ${count}-phase systematic verification roadmap.`, t: e.t });
        }
        continue;
      }
      if (e.kind !== 'tool' || HIDDEN_STEPS.has(e.name)) continue;
      const r = ev.slice(i + 1, i + 4).find((x) => x.kind === 'result' && x.name === e.name);
      // the harness keeps the args as clipped JSON TEXT (sometimes an object): both are fine here
      const argText = typeof e.args === 'string' ? e.args : (e.args && typeof e.args === 'object' ? JSON.stringify(e.args) : '');
      out.push({ name: e.name, label: labelOf(e.name), args: String(argText || '').slice(0, 2500), text: r ? briefOf(e.name, r.text) : '', t: e.t, ...(r && r.image ? { image: r.image } : {}), ...(r && r.download ? { download: r.download, fileName: r.fileName || '', fileKind: r.fileKind || '', fileMime: r.fileMime || '' } : {}), ...(r && r.recording ? { recording: r.recording } : {}) });
    }
    return out.slice(-250);
  }

  /** The pictures the tools took, inlined for the app (it has no byte channel of its own): the last few
      only, base64, so a chat view stays small. */
  const MAX_INLINE_IMAGES = 3;
  function inlineImages(turns, liveView) {
    const steps = [...turns.flatMap((t) => t.steps || []), ...((liveView && liveView.steps) || [])].filter((s) => s.image);
    for (const s of steps.slice(-MAX_INLINE_IMAGES)) {
      try {
        const f = path.join(process.env.PROFILE_DIR || '/profiles', 'operator', 'shots', path.basename(String(s.image)));
        const b = fs.readFileSync(f); s.imageData = (f.endsWith('.jpg') ? 'data:image/jpeg;base64,' : f.endsWith('.webp') ? 'data:image/webp;base64,' : 'data:image/png;base64,') + b.toString('base64');
      } catch { /* the picture is gone; the step stays */ }
    }
  }

  function view(id) {
    const c = load(id); if (!c) return null;
    const run = live.get(id);
    const liveView = run ? { jobId: run.id, status: run.stopped && run.stopped() && run.status === 'running' ? 'stopping' : run.status, iterations: run.iterations, tasks: run.tasks, steps: stepsOf(run), startedAt: run.startedAt } : null;
    const turns = c.turns.map((t) => ({ ...t, steps: (t.steps || []).map((s) => ({ ...s })) }));
    inlineImages(turns, liveView);
    return { id: c.id, title: c.title, agentType: c.agentType || 'browser', createdAt: c.createdAt, updatedAt: c.updatedAt, turns, live: liveView };
  }

  /** The turn's end: the answer becomes the assistant's turn in the chat. */
  function land(c0, run) {
    const c = load(c0.id) || c0;
    const rep = run.report || {};
    let text = String(rep.answer || '').trim();
    if (!text) text = String(run.finalLine || '').replace(/^(DONE|BLOCKED):\s*/, '').trim() || (run.status === 'stopped' ? 'Stopped.' : 'I could not finish this one.');
    if (run.status === 'error') text = `Something went wrong on my side: ${run.error || 'unknown error'}. Ask again and I will retry.`;
    c.turns.push({ role: 'assistant', text, t: now(), status: run.status, jobId: run.id, iterations: run.iterations, details: String(rep.details || ''), cards: withRecordingCards(Array.isArray(rep.cards) ? rep.cards : [], stepsOf(run)), steps: stepsOf(run) });
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
    const run = startTurn({ goal: t, orientation: () => historyDigest(c), finishSpec: REPLY_SPEC, meta: { chatId: c.id, agentType: c.agentType || 'browser' }, maxMs: TURN_MAX_MS });
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

module.exports = { makeAssistant, REPLY_SPEC, labelOf, briefOf, CHAT_DIR };
