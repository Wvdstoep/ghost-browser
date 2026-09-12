// ═══════════════════════ AUTOMATION WORKBENCH — P1 canvas ═══════════════════════
// The Automation tab. A list of saved automations, and an n8n-style editor for one: a trigger and a
// line of steps on a dotted canvas, each step a ROLE run on a PROFILE, connected so one step's output
// feeds the next step's goal ({{…}}). P1 is a LINE — nodes run in array order, edges are the chain
// between them; free-form branching is P2. Talks only to /v1/workflows + /v1/agent/roles + /v1/profiles
// through the shared api(); dashboard.js owns the nav and calls window.Automation.load().
(function () {
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => 'n' + Math.random().toString(36).slice(2, 8);

  const NODE = {
    trigger: { ic: '⏱', cls: 'tg', name: 'Trigger' },
    agent: { ic: '🔎', cls: 'ag', name: 'Agent step' },
    filter: { ic: '▽', cls: 'fl', name: 'Filter a list' },
    branch: { ic: '⑂', cls: 'br', name: 'Branch (if / else)' },
    store: { ic: '⛃', cls: 'st', name: 'Store a value' },
  };
  const OPS = [['exists', 'has a value'], ['contains', 'contains'], ['eq', 'is exactly'], ['gt', 'is greater than'], ['lt', 'is less than']];

  let WORKFLOWS = [], ROLES = [], PROFILES = [], CURRENT = null, SEL = null, RUN = null, POLL = null;
  let LIST_POLL = null, LIST_FILTER = 'all', RUNSIG = '';
  function stopListPoll() { if (LIST_POLL) { clearInterval(LIST_POLL); LIST_POLL = null; } }
  // Which automations are running right now (their latest run is still going). Returns a signature so
  // the list only re-renders when that set actually changes.
  async function markRunning() {
    await Promise.all(WORKFLOWS.map(async (wf) => {
      try {
        const rr = await api('/v1/workflows/' + encodeURIComponent(wf.id) + '/runs');
        const runs = rr.runs || [];
        wf._running = runs.some((x) => x.status === 'running');
        wf._runId = (runs.find((x) => x.status === 'running') || runs[0] || {}).id || null;
      } catch (e) { wf._running = false; }
    }));
    return WORKFLOWS.filter((w) => w._running).map((w) => w.id).sort().join(',');
  }

  async function load() {
    stopPoll(); stopListPoll();
    try {
      const [w, r, p] = await Promise.all([
        api('/v1/workflows').catch(() => ({ workflows: [] })),
        api('/v1/agent/roles').catch(() => ({ roles: [] })),
        api('/v1/profiles').catch(() => ({ profiles: [] })),
      ]);
      WORKFLOWS = w.workflows || [];
      ROLES = r.roles || [];
      PROFILES = (p.profiles || []).map((x) => (typeof x === 'string' ? x : (x.name || x.id || x.profile))).filter(Boolean);
    } catch (e) { /* keep what's there */ }
    CURRENT = null; SEL = null; RUN = null;
    RUNSIG = await markRunning();
    renderList();
    // Keep the Running tab live while the list is on screen, re-rendering only when it changes.
    LIST_POLL = setInterval(async () => {
      if (CURRENT) return;
      const sig = await markRunning();
      if (sig !== RUNSIG) { RUNSIG = sig; renderList(); }
    }, 7000);
  }

  // ── list of automations ─────────────────────────────────────────────────────────────────────────
function renderList() {
     const view = el('dashAutoView'); if (!view) return;
     const running = WORKFLOWS.filter((w) => w._running);
     const shown = LIST_FILTER === 'running' ? running : WORKFLOWS;
     
     view.innerHTML =
       '<div class="auto-header">' +
       '<h1 class="auto-title">Automations<span>Wire roles and profiles into steps that run in a line — collect, then act on it</span></h1>' +
       '<div class="auto-actions">' +
       '<button class="btn ghost" id="autoImport">Import</button>' +
       '<button class="btn primary" id="autoNew">＋ New automation</button>' +
       '</div>' +
       '</div>' +
       
       '<div class="auto-filters">' +
       '<div class="auto-filter-group">' +
       '<button class="auto-filter-tab ' + (LIST_FILTER === 'all' ? 'active' : '') + '" data-f="all">All <span class="count">' + WORKFLOWS.length + '</span></button>' +
       '<button class="auto-filter-tab ' + (LIST_FILTER === 'running' ? 'active' : '') + '" data-f="running">Running <span class="count' + (running.length ? ' live' : '') + '">' + running.length + '</span></button>' +
       '</div>' +
       '</div>' +
       
       '<div class="auto-list">' +
       (shown.length ? shown.map((w) => {
         /*
          * WHAT THE FLOW DOES, counted honestly. This counted agent nodes only, so Herald's reply flow —
          * post it, was it refused, is it on the thread, what happened — read as "1 step" and looked
          * trivial. A step is a node that ACTS or DECIDES; a store just writes the answer down.
          */
         const doing = (w.nodes || []).filter((n) => n.type !== 'trigger' && n.type !== 'store');
         const steps = doing.length;
         /* And what KIND of steps, so a glance says whether it browses, checks or sorts. */
         const kinds = [...new Set(doing.map((n) => (n.type === 'agent' ? 'browses' : n.type === 'verify' ? 'checks the page' : n.type === 'branch' ? 'decides' : n.type)))].join(', ');
         const pill = w._running
           ? '<span class="auto-pill auto-pill--running">● running</span>'
           : '<span class="auto-pill ' + (w.active ? 'auto-pill--active' : 'auto-pill--draft') + '">' + (w.active ? 'active' : 'draft') + '</span>';
         /* Where it came from. An organ ships its flow and starts it itself, so "manual" — which is
            what the trigger says — would read as "nobody has pressed this", which is the opposite. */
         const from = w.owner ? '<span class="auto-pill auto-pill--from">from ' + esc(w.owner) + '</span>' : '';
         const starter = w.owner ? 'started by ' + esc(w.owner) : esc((w.trigger && w.trigger.type) || 'manual');
         // "Results" opens the findings/approvals view (the DATA) — deliberately not "Watch", which
         // elsewhere in the app opens the live browser. Shown whenever a run exists to look at.
         const results = w._runId ? '<button class="btn btn-sm ' + (w._running ? 'btn-primary' : 'btn-ghost') + '" data-results="' + esc(w.id) + '">Results' + (w._running ? ' →' : '') + '</button>' : '';
         
         return '<div class="auto-item' + (w._running ? ' auto-item--running' : '') + '" data-open="' + esc(w.id) + '">' +
           '<div class="auto-item-header">' +
           '<div class="auto-item-title">' + esc(w.name) + '</div>' +
           '<div class="auto-item-meta">' + from + pill + '</div>' +
           '</div>' +
           '<div class="auto-item-body">' +
           '<div class="auto-item-description">' + (w.description || 'No description') + '</div>' +
           '<div class="auto-item-details">' +
           '<span class="auto-detail"><span class="auto-detail-label">Steps:</span> ' + steps + (steps === 1 ? '' : 's') + '</span>' +
           (kinds ? '<span class="auto-detail"><span class="auto-detail-label">Type:</span> ' + kinds + '</span>' : '') +
           '</div>' +
           '</div>' +
           '<div class="auto-item-actions">' +
           results +
           '<button class="btn btn-sm btn-ghost" data-open="' + esc(w.id) + '">Open</button>' +
           '<button class="btn btn-sm btn-ghost" data-export="' + esc(w.id) + '">Export</button>' +
           (w.owner ? '' : '<button class="btn btn-sm btn-ghost btn-danger" data-del="' + esc(w.id) + '">Delete</button>') +
           '</div>' +
           '</div>';
       }).join('') : 
       '<div class="auto-empty">' +
       '<div class="auto-empty-icon">🔧</div>' +
       '<h2 class="auto-empty-title">No automations yet</h2>' +
       '<p class="auto-empty-description">Build one — a trigger, then steps that run your roles and pass their findings along.</p>' +
       '</div>'
       ) +
       '</div>';
     
     // Event listeners
     if (el('autoNew')) el('autoNew').onclick = () => openEditor(null);
     if (el('autoImport')) el('autoImport').onclick = openImport;
     view.querySelectorAll('.auto-filter-tab').forEach((b) => b.onclick = () => { LIST_FILTER = b.dataset.f; renderList(); });
     view.querySelectorAll('[data-results]').forEach((b) => b.onclick = async (e) => {
       e.stopPropagation();
       const wf = WORKFLOWS.find((x) => x.id === b.dataset.results);
       if (!wf || !wf._runId) return;
       try { 
         const run = await api('/v1/workflow-runs/' + encodeURIComponent(wf._runId)); 
         openRunResults(run); 
         if (wf._running) pollResultsModal(wf._runId); 
       } catch (er) {}
     });
     view.querySelectorAll('[data-export]').forEach((b) => b.onclick = (e) => { 
       e.stopPropagation(); 
       exportWorkflow(b.dataset.export); 
     });
     view.querySelectorAll('[data-open]').forEach((b) => b.onclick = (e) => { 
       e.stopPropagation(); 
       openEditor(b.dataset.open); 
     });
     view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async (e) => {
       e.stopPropagation();
       const w = WORKFLOWS.find((x) => x.id === b.dataset.del);
       if (!confirm('Delete "' + (w ? w.name : b.dataset.del) + '"?')) return;
       try { 
         await api('/v1/workflows/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); 
       } catch (err) {}
       load();
     });
   }

  // ── open the editor ─────────────────────────────────────────────────────────────────────────────
  async function openEditor(id) {
    RUN = null; stopPoll(); stopListPoll();
    if (id) {
      try { CURRENT = await api('/v1/workflows/' + encodeURIComponent(id)); }
      catch (e) { alert('Could not open that automation: ' + (e.message || e)); return; }
    } else {
      CURRENT = { name: 'New automation', trigger: { type: 'manual' }, nodes: [{ id: uid(), type: 'trigger', label: 'When I run it', trigger: { type: 'manual' } }], edges: [] };
    }
    CURRENT.edges = CURRENT.edges || [];
    SEL = CURRENT.nodes[0] ? CURRENT.nodes[0].id : null;
    renderEditor();
  }

  // Edges are the consecutive chain of nodes in array order — P1 is a line, so the order IS the graph.
  function renderEditor() {
    const view = el('dashAutoView'); if (!view) return;
    view.innerHTML =
      '<div class="auto-bar">'
      + '<button class="btn ghost sm" id="aBack">←&nbsp;All</button>'
      + '<input id="aName" class="auto-name" value="' + esc(CURRENT.name) + '" placeholder="Name this automation">'
      + '<span class="amsg" id="aMsg"></span>'
      + '<div class="auto-tools">'
      +   '<div class="auto-switches">'
      +     '<label class="asw' + (CURRENT.active ? ' on' : '') + '" title="Arm the schedule so this runs on its own. Off = it only runs when you press Test run.">'
      +       '<input type="checkbox" id="aActive"' + (CURRENT.active ? ' checked' : '') + '><span class="asw-track"><span class="asw-thumb"></span></span><span class="asw-txt">Active</span></label>'
      +     '<label class="asw auto' + (CURRENT.autoApprove ? ' on' : '') + '" title="Off = you approve each reply before it sends. On = replies auto-send, spaced 1–4 min apart.">'
      +       '<input type="checkbox" id="aAuto"' + (CURRENT.autoApprove ? ' checked' : '') + '><span class="asw-track"><span class="asw-thumb"></span></span><span class="asw-txt">Auto-send</span></label>'
      +   '</div>'
      +   '<span class="tool-div"></span>'
      +   '<button class="btn ghost sm" id="aHistory">History</button>'
      +   '<button class="btn ghost sm" id="aRun">Test run</button>'
      +   '<button class="btn primary sm" id="aSave">Save</button>'
      + '</div>'
      + '</div>'
      + '<div class="auto-main">'
      + '<div class="auto-canvas"><div class="auto-flow" id="aFlow"></div></div>'
      + '<div class="auto-cfg" id="aCfg"></div>'
      + '</div>';
    el('aBack').onclick = load;
    el('aName').oninput = () => { CURRENT.name = el('aName').value; };
    el('aSave').onclick = () => save();
    el('aRun').onclick = () => testRun();
    el('aActive').onchange = async (e) => { CURRENT.active = e.target.checked; if (await save()) renderEditor(); else renderEditor(); };
    el('aAuto').onchange = async (e) => {
      if (e.target.checked && !confirm('Auto-send replies?\n\nThe agent will POST each reply without asking you first — one at a time, with a natural 1–4 minute gap between them so it never fires a burst. Its own safety checks still apply: never your own posts, never anyone you have already replied to or reacted on.\n\nTurn this on only once you trust how it replies. You can switch back to approving each one any time.')) { renderEditor(); return; }
      CURRENT.autoApprove = e.target.checked; if (await save()) renderEditor(); else renderEditor();
    };
    el('aHistory').onclick = showHistory;
    renderFlow();
    renderCfg();
  }

  // ── the canvas ───────────────────────────────────────────────────────────────────────────────────
  function statusOf(nodeId) {
    if (!RUN) return '';
    const s = (RUN.steps || []).find((x) => x.node_id === nodeId);
    return s ? s.status : '';
  }
  const NW = 176, NH = 64;   // node box, for port + bounds math
  let CONNECT = null;        // {from, fromPort, d} while dragging a new connection out of an output port

  function nodePos(n, i) {
    if (n && n.pos && (n.pos.x || n.pos.y)) return { x: n.pos.x, y: n.pos.y };
    return { x: 24 + (i < 0 ? 0 : i) * 220, y: 96 };
  }
  const idx = (n) => CURRENT.nodes.indexOf(n);
  const nById = (id) => CURRENT.nodes.find((n) => n.id === id);
  function outPort(n, port) {
    const p = nodePos(n, idx(n));
    if (n.type === 'branch') return { x: p.x + NW, y: p.y + (port === 'false' ? NH * 0.72 : NH * 0.28) };
    return { x: p.x + NW, y: p.y + NH / 2 };
  }
  const inPort = (n) => { const p = nodePos(n, idx(n)); return { x: p.x, y: p.y + NH / 2 }; };
  const bez = (a, b) => { const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5); return 'M ' + a.x + ' ' + a.y + ' C ' + (a.x + dx) + ' ' + a.y + ', ' + (b.x - dx) + ' ' + b.y + ', ' + b.x + ' ' + b.y; };
  function edgeD(e) { const s = nById(e.from), t = nById(e.to); return (s && t) ? bez(outPort(s, e.fromPort), inPort(t)) : ''; }
  function bounds() { let w = 480, h = 320; CURRENT.nodes.forEach((n, i) => { const p = nodePos(n, i); w = Math.max(w, p.x + NW + 120); h = Math.max(h, p.y + NH + 90); }); return { w, h }; }
  function nodeTitle(n) { return n.type === 'agent' ? (roleLabel(n.role) || 'pick a role') : (NODE[n.type] || NODE.agent).name; }
  const shortKey = (k) => String(k || '').split('.').slice(-1)[0];
  function nodeSub(n) {
    if (n.type === 'agent') return (n.record ? '🎥 ' : '') + (n.forEach ? '⟳ each · ' : '') + esc(n.profile || (roleSite(n.role) || '(profile)'));
    if (n.type === 'filter') return 'keep · ' + esc(n.field || 'item') + ' ' + esc(n.op || '');
    if (n.type === 'branch') return 'if ' + esc(shortKey(n.inKey) || '…') + ' ' + esc(n.op || '');
    if (n.type === 'store') return 'sets ' + esc(n.key || 'value');
    const t = n.trigger || {};
    return t.type === 'schedule' ? (t.every === 'hour' ? ('every ' + (t.n || 1) + 'h') : ('daily · ' + (t.at || '08:00'))) : esc(t.type || 'manual');
  }

  function svgMarkup() {
    const b = bounds(); let e = '';
    CURRENT.edges.forEach((edge, i) => {
      const d = edgeD(edge); if (!d) return;
      const s = nById(edge.from);
      const cls = (s && s.type === 'branch') ? (edge.fromPort === 'false' ? ' no' : ' yes') : '';
      e += '<path class="aedge-hit" data-eidx="' + i + '" d="' + d + '"/><path class="aedge' + cls + '" d="' + d + '"/>';
    });
    if (CONNECT && CONNECT.d) e += '<path class="aedge tmp" d="' + CONNECT.d + '"/>';
    return '<svg id="aSvg" width="' + b.w + '" height="' + b.h + '" viewBox="0 0 ' + b.w + ' ' + b.h + '">' + e + '</svg>';
  }

  function renderFlow() {
    const flow = el('aFlow'); if (!flow) return;
    const b = bounds(); flow.style.width = b.w + 'px'; flow.style.height = b.h + 'px';
    const cards = CURRENT.nodes.map((n, i) => {
      const meta = NODE[n.type] || NODE.agent, st = statusOf(n.id), p = nodePos(n, i);
      const outs = n.type === 'branch'
        ? '<span class="aport o yes" data-node="' + n.id + '" data-port="true" title="if true"></span><span class="aport o no" data-node="' + n.id + '" data-port="false" title="if false"></span>'
        : '<span class="aport o" data-node="' + n.id + '"></span>';
      return '<div class="anode ' + meta.cls + (SEL === n.id ? ' sel' : '') + (st ? ' ' + st : '') + '" style="left:' + p.x + 'px; top:' + p.y + 'px" data-node="' + n.id + '">'
        + '<div class="aic">' + meta.ic + '</div>'
        + '<div class="anb"><div class="ant">' + esc(n.label || nodeTitle(n)) + '</div><div class="ans">' + nodeSub(n) + '</div></div>'
        + (n.type !== 'trigger' ? '<span class="aport i" data-in="' + n.id + '"></span>' : '') + outs
        + (st ? '<span class="astat ' + st + '"></span>' : '') + '</div>';
    }).join('');
    const src = nById(SEL) || CURRENT.nodes[CURRENT.nodes.length - 1];
    const sp = src ? nodePos(src, idx(src)) : { x: 24, y: 96 };
    const add = '<button class="aadd" id="aAdd" style="left:' + (sp.x + NW + 22) + 'px; top:' + (sp.y + 15) + 'px" title="Add a step">＋</button>';
    flow.innerHTML = svgMarkup() + cards + add;
    flow.querySelectorAll('.anode').forEach((c) => dragNode(c, nById(c.dataset.node)));
    flow.querySelectorAll('.aport.o').forEach((pt) => startConnect(pt));
    bindEdgeDelete();
    el('aAdd').onclick = addMenu;
  }
  function bindEdgeDelete() { const flow = el('aFlow'); if (flow) flow.querySelectorAll('.aedge-hit').forEach((h) => h.onclick = () => removeEdge(+h.dataset.eidx)); }
  function updateEdges() { const svg = el('aSvg'); if (svg) { svg.outerHTML = svgMarkup(); bindEdgeDelete(); const b = bounds(); const flow = el('aFlow'); if (flow) { flow.style.width = b.w + 'px'; flow.style.height = b.h + 'px'; } } }
  function localXY(ev) { const flow = el('aFlow'); const r = flow.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }

  // Drag a node — Pointer Events, one path for mouse and touch. A tiny move is a tap (select); a real
  // move drags it and the edges follow. touch-action:none (CSS) keeps a touch-drag from scrolling.
  function dragNode(elm, node) {
    if (!node) return;
    elm.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.aport')) return;
      const start = nodePos(node, idx(node));
      const sx = e.clientX, sy = e.clientY; let moved = false;
      try { elm.setPointerCapture(e.pointerId); } catch (err) { /* fine without */ }
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) <= 5) return;
        moved = true; elm.classList.add('drag');
        node.pos = { x: Math.max(0, Math.round(start.x + dx)), y: Math.max(0, Math.round(start.y + dy)) };
        elm.style.left = node.pos.x + 'px'; elm.style.top = node.pos.y + 'px';
        updateEdges();
      };
      const up = () => {
        elm.removeEventListener('pointermove', move); elm.removeEventListener('pointerup', up); elm.removeEventListener('pointercancel', up);
        elm.classList.remove('drag');
        if (!moved) { SEL = node.id; renderFlow(); renderCfg(); } else renderFlow();
      };
      elm.addEventListener('pointermove', move); elm.addEventListener('pointerup', up); elm.addEventListener('pointercancel', up);
    });
  }

  // Drag from an OUTPUT port to an INPUT port to connect two steps — mouse and touch.
  function startConnect(pt) {
    pt.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      const from = pt.dataset.node, fromPort = pt.dataset.port || null, s = nById(from);
      if (!s) return;
      const a = outPort(s, fromPort);
      try { pt.setPointerCapture(e.pointerId); } catch (err) { /* fine without */ }
      const move = (ev) => { CONNECT = { from, fromPort, d: bez(a, localXY(ev)) }; updateEdges(); };
      const up = (ev) => {
        pt.removeEventListener('pointermove', move); pt.removeEventListener('pointerup', up); pt.removeEventListener('pointercancel', up);
        const hit = document.elementFromPoint(ev.clientX, ev.clientY);
        const inp = hit && hit.closest && hit.closest('.aport.i');
        const to = inp && inp.dataset.in;
        CONNECT = null;
        if (to && to !== from) {
          // one connection per branch port: a new one replaces the old on that port
          if (s.type === 'branch') CURRENT.edges = CURRENT.edges.filter((x) => !(x.from === from && (x.fromPort || null) === (fromPort || null)));
          if (!CURRENT.edges.some((x) => x.from === from && x.to === to && (x.fromPort || null) === (fromPort || null))) CURRENT.edges.push(fromPort ? { from, to, fromPort } : { from, to });
        }
        renderFlow();
      };
      pt.addEventListener('pointermove', move); pt.addEventListener('pointerup', up); pt.addEventListener('pointercancel', up);
    });
  }

  function addMenu() {
    // tiny inline menu — agent (the workhorse) or a store step
    const existing = el('aAddMenu'); if (existing) { existing.remove(); return; }
    const btn = el('aAdd');
    const m = document.createElement('div'); m.className = 'aadd-menu'; m.id = 'aAddMenu';
    m.style.left = btn.style.left; m.style.top = (parseInt(btn.style.top) + 40) + 'px';
    m.innerHTML = '<button data-add="agent">🔎 Agent step</button><button data-add="filter">▽ Filter a list</button><button data-add="branch">⑂ Branch (if / else)</button><button data-add="store">⛃ Store a value</button>';
    el('aFlow').appendChild(m);
    m.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => { m.remove(); addNode(b.dataset.add); });
  }
  function addNode(type) {
    const n = { id: uid(), type, label: '' };
    if (type === 'agent') { n.role = null; n.profile = null; n.goal = ''; n.outKey = ''; }
    if (type === 'filter') { n.inKey = ''; n.field = ''; n.op = 'exists'; n.value = ''; n.outKey = ''; }
    if (type === 'branch') { n.inKey = ''; n.op = 'exists'; n.value = ''; }
    if (type === 'store') { n.key = ''; n.value = ''; }
    // Drop it to the right of the selected node, and wire it after that step for convenience (unless
    // that step is a branch — you pick which port). Everything is re-wirable by dragging port to port.
    const src = CURRENT.nodes.find((x) => x.id === SEL) || CURRENT.nodes[CURRENT.nodes.length - 1];
    const sp = src ? nodePos(src, CURRENT.nodes.indexOf(src)) : { x: 24, y: 96 };
    n.pos = { x: sp.x + 220, y: sp.y };
    CURRENT.nodes.push(n);
    if (src && src.id !== n.id && src.type !== 'branch' && !CURRENT.edges.some((e) => e.from === src.id && e.to === n.id)) CURRENT.edges.push({ from: src.id, to: n.id });
    SEL = n.id; renderFlow(); renderCfg();
  }
  function removeNode(id) {
    CURRENT.nodes = CURRENT.nodes.filter((n) => n.id !== id);
    CURRENT.edges = CURRENT.edges.filter((e) => e.from !== id && e.to !== id);   // drop its connections too
    if (SEL === id) SEL = CURRENT.nodes.length ? CURRENT.nodes[CURRENT.nodes.length - 1].id : null;
    renderFlow(); renderCfg();
  }
  function removeEdge(i) { CURRENT.edges.splice(i, 1); renderFlow(); }

  const roleLabel = (name) => { const r = ROLES.find((x) => x.name === name); return r ? r.label : ''; };
  const roleSite = (name) => { const r = ROLES.find((x) => x.name === name); return r ? r.site : null; };

  // ── the config drawer ────────────────────────────────────────────────────────────────────────────
  function renderCfg() {
    const cfg = el('aCfg'); if (!cfg) return;
    if (RUN && !SELisNode()) { cfg.innerHTML = runPanel(); wireRun(); return; }
    const n = CURRENT.nodes.find((x) => x.id === SEL);
    if (!n) { cfg.innerHTML = '<div class="chint">Pick a step to set it up, or press ＋ to add one.</div>' + (RUN ? runPanel() : ''); wireRun(); return; }
    const meta = NODE[n.type] || NODE.agent;
    let body = '';
    if (n.type === 'trigger') {
      const tg = n.trigger || { type: 'manual' };
      const every = tg.every || 'day', at = tg.at || '08:00', nn = tg.n || 6;
      body = '<div class="cf"><label>Starts when</label>'
        + '<select id="cTrig"><option value="manual"' + (tg.type === 'manual' ? ' selected' : '') + '>I run it (Test run)</option>'
        + '<option value="schedule"' + (tg.type === 'schedule' ? ' selected' : '') + '>On a schedule</option>'
        + '<option value="reply" disabled>On a reply — soon</option></select></div>'
        + (tg.type === 'schedule'
          ? '<div class="cf"><label>Schedule</label><div class="sched-row">'
            + '<select id="cEvery"><option value="minute"' + (every === 'minute' ? ' selected' : '') + '>every N minutes</option><option value="hour"' + (every === 'hour' ? ' selected' : '') + '>every N hours</option><option value="day"' + (every === 'day' ? ' selected' : '') + '>every day at</option></select>'
            + '<input id="cAt" type="time" value="' + esc(at) + '"' + (every === 'day' ? '' : ' style="display:none"') + '>'
            + '<input id="cN" type="number" min="1" max="240" value="' + esc(nn) + '"' + (every === 'hour' || every === 'minute' ? '' : ' style="display:none"') + '></div>'
            + '<span class="chint2">runs only while the automation is Active (top-right). Server time.</span></div>'
          : '')
        + '<p class="chelp">The start of the flow. A schedule fires it unattended — switch the automation <b>Active</b> to arm it.</p>';
    } else if (n.type === 'agent') {
      body = '<div class="cf"><label>Role</label>' + roleSelect(n.role) + '</div>'
        + '<div class="cf"><label>Profile</label>' + profileSelect(n.profile, n.role) + '</div>'
        + '<div class="cf"><label>Run once for each item in <span class="chint2">— optional, makes it loop</span></label>' + listSelect('cEach', n.forEach, n)
        + (n.forEach ? '<span class="chint2">use {{item}} (or {{item.field}}) in the goal</span>' : '') + '</div>'
        + '<div class="cf"><label>Goal <span class="chint2">— what this step should do</span></label>'
        + '<textarea id="cGoal" rows="5" placeholder="Read Reddit for people describing…">' + esc(n.goal || '') + '</textarea>' + inserter(n) + '</div>'
        + '<div class="cf"><label>Save its output as</label><input id="cOut" value="' + esc(n.outKey || '') + '" placeholder="' + esc(defaultOut(n)) + '"><span class="chint2">a later step can use {{' + esc(n.outKey || defaultOut(n)) + '}}</span></div>'
        + '<div class="cf"><label class="ccheck"><input type="checkbox" id="cRec"' + (n.record ? ' checked' : '') + '> 🎥 Record this step</label><span class="chint2">films the whole step and saves an MP4 to the Files tab — starts and stops automatically</span></div>';
    } else if (n.type === 'filter') {
      body = '<div class="cf"><label>List to filter</label>' + listSelect('cIn', n.inKey, n) + '</div>'
        + '<div class="cf"><label>Keep items where</label>'
        + '<div class="filt-row"><input id="cField" value="' + esc(n.field || '') + '" placeholder="field, e.g. budget">'
        + '<select id="cOp">' + OPS.map(([v, l]) => '<option value="' + v + '"' + (n.op === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>'
        + '<input id="cFVal" value="' + esc(n.value || '') + '" placeholder="value"></div>'
        + '<span class="chint2">leave the field blank to test the item itself</span></div>'
        + '<div class="cf"><label>Save the kept list as</label><input id="cOut" value="' + esc(n.outKey || '') + '" placeholder="' + esc(defaultOut(n)) + '"></div>';
    } else if (n.type === 'branch') {
      body = '<div class="cf"><label>If this</label>' + listSelect('cIn', n.inKey, n) + '</div>'
        + '<div class="cf"><label>&nbsp;</label><div class="filt-row" style="grid-template-columns:auto 1fr">'
        + '<select id="cOp">' + OPS.map(([v, l]) => '<option value="' + v + '"' + (n.op === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>'
        + '<input id="cFVal" value="' + esc(n.value || '') + '" placeholder="value"></div></div>'
        + '<p class="chelp">Steps wired to the <b style="color:#10b981">true</b> port run when this holds; steps on the <b style="color:var(--bad)">false</b> port run when it does not. Drag from a port to a step to connect.</p>';
    } else if (n.type === 'store') {
      body = '<div class="cf"><label>Name</label><input id="cKey" value="' + esc(n.key || '') + '" placeholder="topic"></div>'
        + '<div class="cf"><label>Value</label><textarea id="cVal" rows="3" placeholder="slow invoicing">' + esc(n.value || '') + '</textarea>' + inserter(n) + '</div>'
        + '<p class="chelp">Stashes a value later steps can drop into a goal with {{name}}.</p>';
    }
    const canRemove = n.type !== 'trigger';
    cfg.innerHTML =
      '<div class="chd"><div class="cic ' + meta.cls + '">' + meta.ic + '</div><div><b>' + esc(n.label || meta.name) + '</b><span>' + meta.name + '</span></div></div>'
      + '<div class="cf"><label>Label <span class="chint2">— shown on the node</span></label><input id="cLabel" value="' + esc(n.label || '') + '"></div>'
      + body
      + '<div class="cf-row">'
      + (canRemove ? '<button class="btn ghost sm danger" id="cDel">Remove step</button>' : '')
      + '</div>';
    wireCfg(n);
    if (RUN) cfg.insertAdjacentHTML('beforeend', runPanel()), wireRun();
  }
  const SELisNode = () => !!CURRENT.nodes.find((x) => x.id === SEL);
  const defaultOut = (n) => (n.outKey || (n.label ? slugish(n.label) : (roleSite(n.role) || 'step')));
  const slugish = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

  function roleSelect(sel) {
    const groups = {};
    for (const r of ROLES) (groups[r.group || 'Other'] = groups[r.group || 'Other'] || []).push(r);
    let opts = '<option value="">— pick a role —</option>';
    for (const g of Object.keys(groups)) {
      opts += '<optgroup label="' + esc(g) + '">' + groups[g].map((r) => '<option value="' + esc(r.name) + '"' + (sel === r.name ? ' selected' : '') + '>' + esc(r.label) + '</option>').join('') + '</optgroup>';
    }
    return '<select id="cRole">' + opts + '</select>';
  }
  function profileSelect(sel, role) {
    const hint = roleSite(role);
    let opts = '<option value="">auto (from the role\'s platform)</option>';
    for (const p of PROFILES) opts += '<option value="' + esc(p) + '"' + (sel === p ? ' selected' : '') + '>' + esc(p) + (hint && p.toLowerCase().indexOf(hint) >= 0 ? ' · matches' : '') + '</option>';
    return '<select id="cProfile">' + opts + '</select>';
  }
  // buttons that insert {{upstream}} references into the focused goal/value field
  function inserter(node) {
    const i = CURRENT.nodes.findIndex((x) => x.id === node.id);
    const ups = CURRENT.nodes.slice(0, i).filter((x) => x.type === 'agent' || x.type === 'store' || x.type === 'filter');
    const chips = [];
    if (node.forEach) chips.push('{{item}}');
    for (const u of ups) chips.push('{{' + (u.type === 'store' ? u.key : (u.outKey || slugish(u.label) || u.id)) + '}}');
    if (!chips.length) return '';
    return '<div class="inserter"><span>insert:</span>' + chips.map((c) => '<button type="button" class="ins" data-ins="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div>';
  }
  // The list-valued outputs a step can filter or loop over — an agent step's harvested arrays, and any
  // filter's kept list. Offered as a dropdown so the seam is pickable, not typed from memory.
  function upstreamLists(node) {
    const i = CURRENT.nodes.findIndex((x) => x.id === node.id);
    const out = [];
    for (const u of CURRENT.nodes.slice(0, i)) {
      const key = u.outKey || slugish(u.label) || u.id, name = u.label || key;
      if (u.type === 'agent') {
        if (u.forEach) out.push({ path: key + '.items', label: name + ' → results' });
        for (const f of ['leads', 'gigs', 'keywords', 'searchQueries', 'reach', 'opportunities']) out.push({ path: key + '.' + f, label: name + ' → ' + f });
      } else if (u.type === 'filter') out.push({ path: key, label: name + ' (kept list)' });
    }
    return out;
  }
  function listSelect(id, val, node) {
    const lists = upstreamLists(node), seen = new Set();
    let opts = '<option value="">' + (id === 'cEach' ? 'no — run once' : '— pick a list —') + '</option>';
    for (const l of lists) { opts += '<option value="' + esc(l.path) + '"' + (val === l.path ? ' selected' : '') + '>' + esc(l.label) + '</option>'; seen.add(l.path); }
    if (val && !seen.has(val)) opts += '<option value="' + esc(val) + '" selected>' + esc(val) + ' (custom)</option>';
    return '<select id="' + id + '">' + opts + '</select>';
  }

  function wireCfg(n) {
    const bind = (id, prop, sub) => { const e = el(id); if (e) e.oninput = () => { if (sub) n[sub][prop] = e.value; else n[prop] = e.value; if (prop === 'label' || prop === 'role' || prop === 'profile' || prop === 'key') renderFlow(); }; };
    el('cLabel') && (el('cLabel').oninput = () => { n.label = el('cLabel').value; renderFlow(); });
    if (n.type === 'trigger') {
      const sync = () => { CURRENT.trigger = n.trigger; };
      const t = el('cTrig');
      if (t) t.onchange = () => { n.trigger = t.value === 'schedule' ? { type: 'schedule', every: (n.trigger && n.trigger.every) || 'day', at: (n.trigger && n.trigger.at) || '08:00', n: (n.trigger && n.trigger.n) || 6 } : { type: t.value }; sync(); renderCfg(); renderFlow(); };
      const ev = el('cEvery'); if (ev) ev.onchange = () => { n.trigger.every = ev.value; sync(); renderCfg(); };
      const at = el('cAt'); if (at) at.oninput = () => { n.trigger.at = at.value; sync(); renderFlow(); };
      const nn = el('cN'); if (nn) nn.oninput = () => { n.trigger.n = Math.max(1, Number(nn.value) || 1); sync(); renderFlow(); };
    }
    if (n.type === 'agent') {
      const rs = el('cRole'); if (rs) rs.onchange = () => { n.role = rs.value || null; if (!n.label) n.label = roleLabel(n.role) || ''; renderCfg(); renderFlow(); };
      const ps = el('cProfile'); if (ps) ps.onchange = () => { n.profile = ps.value || null; renderFlow(); };
      const ea = el('cEach'); if (ea) ea.onchange = () => { n.forEach = ea.value || null; renderCfg(); renderFlow(); };
      const g = el('cGoal'); if (g) g.oninput = () => { n.goal = g.value; };
      const o = el('cOut'); if (o) o.oninput = () => { n.outKey = o.value; };
      const rec = el('cRec'); if (rec) rec.onchange = () => { n.record = rec.checked; renderFlow(); };
    }
    if (n.type === 'filter') {
      const inp = el('cIn'); if (inp) inp.onchange = () => { n.inKey = inp.value; renderFlow(); };
      const fld = el('cField'); if (fld) fld.oninput = () => { n.field = fld.value; renderFlow(); };
      const op = el('cOp'); if (op) op.onchange = () => { n.op = op.value; renderFlow(); };
      const fv = el('cFVal'); if (fv) fv.oninput = () => { n.value = fv.value; };
      const o = el('cOut'); if (o) o.oninput = () => { n.outKey = o.value; };
    }
    if (n.type === 'branch') {
      const inp = el('cIn'); if (inp) inp.onchange = () => { n.inKey = inp.value; renderFlow(); };
      const op = el('cOp'); if (op) op.onchange = () => { n.op = op.value; renderFlow(); };
      const fv = el('cFVal'); if (fv) fv.oninput = () => { n.value = fv.value; };
    }
    if (n.type === 'store') { bind('cKey', 'key'); const v = el('cVal'); if (v) v.oninput = () => { n.value = v.value; }; }
    // insert buttons drop into the last-focused textarea
    el('aCfg').querySelectorAll('[data-ins]').forEach((b) => b.onclick = () => {
      const target = n.type === 'store' ? el('cVal') : el('cGoal');
      if (!target) return;
      const s = target.selectionStart || target.value.length;
      target.value = target.value.slice(0, s) + b.dataset.ins + target.value.slice(s);
      target.dispatchEvent(new Event('input')); target.focus();
    });
    el('cDel') && (el('cDel').onclick = () => removeNode(n.id));
  }

  // ── save + run ───────────────────────────────────────────────────────────────────────────────────
  function msg(t, cls) { const m = el('aMsg'); if (m) { m.textContent = t; m.className = 'amsg ' + (cls || ''); } }
  async function save() {
    try {
      const saved = await api(CURRENT.id ? '/v1/workflows/' + encodeURIComponent(CURRENT.id) : '/v1/workflows',
        { method: CURRENT.id ? 'PUT' : 'POST', body: JSON.stringify(CURRENT) });
      CURRENT.id = saved.id; msg('Saved', 'ok');
      return true;
    } catch (e) { msg(e.message || 'Could not save', 'warn'); return false; }
  }
  async function testRun() {
    if (!(await save())) return;
    RUN = { status: 'running', steps: [] };
    msg('Running…', ''); renderFlow(); renderCfg();
    try {
      const r = await api('/v1/workflows/' + encodeURIComponent(CURRENT.id) + '/run', { method: 'POST' });
      pollRun(r.runId);
    } catch (e) { msg(e.message || 'Could not start the run', 'warn'); RUN = null; renderFlow(); }
  }
  function pollRun(runId) {
    stopPoll();
    POLL = setInterval(async () => {
      let r; try { r = await api('/v1/workflow-runs/' + encodeURIComponent(runId)); } catch (e) { return; }
      RUN = r; renderFlow();
      const cfg = el('aCfg'); if (cfg && !SELisNode()) { cfg.innerHTML = runPanel(); wireRun(); }
      else { const rp = cfg && cfg.querySelector('.runpanel'); if (rp) rp.outerHTML = runPanel(); wireRun(); }
      const rm = el('runModal'); if (rm && rm.classList.contains('on')) { RUNVIEW = r; renderRunResults(); }
      if (r.status === 'done' || r.status === 'error') { stopPoll(); msg(r.status === 'done' ? 'Run finished' : 'Run stopped', r.status === 'done' ? 'ok' : 'warn'); }
    }, 2500);
  }
  function stopPoll() { if (POLL) { clearInterval(POLL); POLL = null; } }

  function runPanel() {
    if (!RUN) return '';
    const steps = (RUN.steps || []).map((s) => {
      const out = s.output ? shortOut(s.output) : (s.error ? esc(s.error) : (s.status === 'running' ? 'working…' : ''));
      return '<div class="rstep ' + s.status + '"><span class="rdot"></span><div><div class="rlab">' + esc(s.label || s.node_id) + '</div>'
        + (out ? '<div class="rout">' + out + '</div>' : '') + '</div></div>';
    }).join('');
    return '<div class="runpanel"><div class="rphd">Run · <b class="' + RUN.status + '">' + esc(RUN.status) + '</b></div>' + (steps || '<div class="rout">starting…</div>') + '</div>';
  }
  function shortOut(o) {
    if (o && typeof o === 'object') {
      const bits = [];
      for (const k of ['leads', 'gigs', 'reach', 'keywords', 'searchQueries', 'opportunities']) if (Array.isArray(o[k]) && o[k].length) bits.push(o[k].length + ' ' + k);
      for (const k of Object.keys(o)) if (k !== '__jobId' && !Array.isArray(o[k]) && typeof o[k] !== 'object') bits.push(k + ': ' + String(o[k]).slice(0, 40));
      return esc(bits.join(' · ') || 'done');
    }
    return esc(String(o).slice(0, 80));
  }
  function wireRun() { /* run panel is read-only in P1 */ }

  // ── run history / inspector ──────────────────────────────────────────────────────────────────
  function fmtTime(iso) { if (!iso) return ''; try { return new Date(iso).toLocaleString(); } catch (e) { return iso; } }
  async function showHistory() {
    if (!CURRENT.id) { msg('Save it first to keep a history', 'warn'); return; }
    let runs = [];
    try { runs = (await api('/v1/workflows/' + encodeURIComponent(CURRENT.id) + '/runs')).runs || []; } catch (e) {}
    const cfg = el('aCfg'); if (!cfg) return;
    cfg.innerHTML = '<div class="chd"><div class="cic" style="background:var(--muted)">🕘</div><div><b>Run history</b><span>' + runs.length + ' run' + (runs.length === 1 ? '' : 's') + '</span></div></div>'
      + (runs.length
        ? runs.map((r) => '<button class="hrun ' + r.status + '" data-runid="' + esc(r.id) + '"><span class="rdot"></span><div><div class="rlab">' + esc(fmtTime(r.started_at)) + '</div><div class="rout">' + ((r.steps || []).length) + ' steps · ' + esc(r.status) + '</div></div></button>').join('')
        : '<div class="chint">No runs yet — press Test run.</div>')
      + '<button class="btn ghost sm" id="hClose" style="margin-top:12px">Back to setup</button>';
    cfg.querySelectorAll('[data-runid]').forEach((b) => b.onclick = async () => { try { RUN = await api('/v1/workflow-runs/' + encodeURIComponent(b.dataset.runid)); SEL = null; renderFlow(); renderCfg(); openRunResults(RUN); } catch (e) {} });
    el('hClose') && (el('hClose').onclick = () => { RUN = null; SEL = CURRENT.nodes[0] ? CURRENT.nodes[0].id : null; renderFlow(); renderCfg(); });
  }

  // ── import / export a whole automation ───────────────────────────────────────────────────────
  function pkModal() {
    let m = el('wfPackModal');
    if (m) return m;
    m = document.createElement('div'); m.className = 'mkt-modal'; m.id = 'wfPackModal';
    m.innerHTML = '<div class="mcard"><div class="mhd"><div><div class="t"></div><div class="s"></div></div><button class="x" data-x="1">✕</button></div><div class="mbody"></div><div class="mfoot"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-x]')) m.classList.remove('on'); });
    return m;
  }
  function openImport() {
    const m = pkModal();
    m.querySelector('.t').textContent = 'Import an automation';
    m.querySelector('.s').textContent = 'Paste a workflow pack, or load a .json file.';
    m.querySelector('.mbody').innerHTML = '<input type="file" id="wfFile" accept="application/json,.json" class="pkfile"><textarea id="wfText" rows="12" class="pktext" placeholder=\'{ "kind": "ghost-workflow", ... }\'></textarea><div class="rerr" id="wfErr"></div>';
    m.querySelector('.mfoot').innerHTML = '<button class="btn" data-x="1">Cancel</button><button class="btn primary" id="wfGo">Import</button>';
    m.classList.add('on');
    el('wfFile').onchange = (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { el('wfText').value = rd.result; }; rd.readAsText(f); };
    el('wfGo').onclick = async () => {
      let pack; try { pack = JSON.parse(el('wfText').value); } catch (e) { el('wfErr').textContent = 'That is not valid JSON.'; return; }
      try { await api('/v1/workflows/import', { method: 'POST', body: JSON.stringify(pack) }); m.classList.remove('on'); load(); }
      catch (e) { el('wfErr').textContent = e.message || 'Could not import.'; }
    };
  }
  async function exportWorkflow(id) {
    let pack; try { pack = await api('/v1/workflows/' + encodeURIComponent(id) + '/export'); } catch (e) { alert('Could not export: ' + (e.message || e)); return; }
    const json = JSON.stringify(pack, null, 2);
    const m = pkModal();
    m.querySelector('.t').textContent = 'Export "' + (pack.name || 'automation') + '"';
    m.querySelector('.s').textContent = 'A shareable pack. Copy it, or download the file.';
    m.querySelector('.mbody').innerHTML = '<textarea rows="14" class="pktext" id="wfOut" readonly>' + esc(json) + '</textarea>';
    m.querySelector('.mfoot').innerHTML = '<button class="btn" data-x="1">Close</button><button class="btn ghost" id="wfDl">⭳ Download</button><button class="btn primary" id="wfCopy">Copy</button>';
    m.classList.add('on');
    el('wfCopy').onclick = async () => { try { await navigator.clipboard.writeText(json); el('wfCopy').textContent = 'Copied'; setTimeout(() => el('wfCopy').textContent = 'Copy', 1400); } catch (e) { el('wfOut').select(); } };
    el('wfDl').onclick = () => { try { const u = URL.createObjectURL(new Blob([json], { type: 'application/json' })); const a = document.createElement('a'); a.href = u; a.download = (String(pack.name || 'automation').replace(/[^a-z0-9_-]+/gi, '-')) + '.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000); } catch (e) {} };
  }

  // ── high-end run results — a wide, filterable view of everything a run found ────────────────────
  // Every role emits a DIFFERENT record shape (a scout saves leads, a gig-scout saves gigs with a
  // budget, a research role saves findings). Records are freeform `{ at, ...whatever the tool saved }`,
  // so nothing here assumes a field: each card reads whatever's present and lays it out by ROLE —
  // a title, a body, a link, and the rest as labelled chips. New role → new fields → still renders.
  let RUNVIEW = null, LEADFILTER = '', APPROVALS = [], RMPOLL = null;
  const KEY_LABELS = { groupName: 'group', groupUrl: 'group', postUrl: 'post', profileUrl: 'profile', postedAt: 'posted', postText: 'post', profile: 'profile' };
  const humanKey = (k) => KEY_LABELS[k] || k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\bUrl\b/i, '').trim().toLowerCase();
  function stopResultsPoll() { if (RMPOLL) { clearInterval(RMPOLL); RMPOLL = null; } }
  function pollResultsModal(runId) {
    stopResultsPoll();
    RMPOLL = setInterval(async () => {
      const rm = el('runModal'); if (!rm || !rm.classList.contains('on')) { stopResultsPoll(); return; }
      try { const r = await api('/v1/workflow-runs/' + encodeURIComponent(runId)); RUNVIEW = r; await loadApprovals(); renderRunResults(); if (r.status === 'done' || r.status === 'error') stopResultsPoll(); } catch (e) {}
    }, 4000);
  }
  // The crafted replies waiting for a yes live on the reply jobs' proposals, not in the run record.
  // Surface only the ones that belong to THE RUN BEING VIEWED — each workflow-step job is tagged with
  // its runId, so a Messenger reply parked by the reply-watcher never shows under the channel-setup
  // run's results (the bug that put someone's private DM in the wrong flow). Fallback for older jobs
  // with no runId: match the pending job's goal against this run's step goals.
  async function loadApprovals() {
    APPROVALS = [];
    try {
      const runId = RUNVIEW && (RUNVIEW.id || RUNVIEW.run_id);
      const stepGoals = new Set((RUNVIEW && RUNVIEW.steps || []).map((s) => (s.goal || '').slice(0, 200)).filter(Boolean));
      const jr = await api('/v1/agent/jobs');
      const mine = (jr.jobs || []).filter((j) => (j.pending || 0) > 0 && (
        (j.runId && runId && j.runId === runId) ||
        (!j.runId && j.goal && stepGoals.has(String(j.goal).slice(0, 200)))
      ));
      for (const jj of mine) {
        try { const jd = await api('/v1/agent/jobs/' + encodeURIComponent(jj.id)); const job = jd.job || jd;
          for (const p of (job.proposals || [])) if (p.state === 'pending')
            APPROVALS.push({ jobId: job.id, pid: p.pid, kind: p.kind, text: p.text || '', why: p.why || '', goal: job.goal || '' });
        } catch (e) {}
      }
    } catch (e) {}
  }
  async function decideApproval(jobId, pid, approve, edit) {
    const body = { approve }; if (edit != null) body.edit = edit;
    try { await api('/v1/agent/jobs/' + encodeURIComponent(jobId) + '/proposals/' + encodeURIComponent(pid), { method: 'POST', body: JSON.stringify(body) }); } catch (e) {}
    await loadApprovals(); renderRunResults();
  }
  // After firing a one-off action (a Messenger opener), poll approvals for a few minutes so its drafted
  // message surfaces in the queue at the top of this same view — no need to hunt in the session chat.
  function startApprovalWatch() {
    stopResultsPoll();
    let ticks = 0;
    RMPOLL = setInterval(async () => {
      const rm = el('runModal'); if (!rm || !rm.classList.contains('on') || ticks++ > 45) { stopResultsPoll(); return; }
      try { await loadApprovals(); renderRunResults(); } catch (e) {}
    }, 4000);
  }
  // Named record collections a step can emit (see makeRunAgent.pruneOut), each with a human label.
  const RECORD_SETS = [
    { key: 'leads', label: 'Leads', open: 'Open the post →' },
    { key: 'gigs', label: 'Gigs', open: 'Open the brief →' },
    { key: 'reach', label: 'Reach', open: 'Open →' },
    { key: 'opportunities', label: 'Opportunities', open: 'Open →' },
  ];
  const STRING_SETS = [ { key: 'keywords', label: 'Keywords' }, { key: 'searchQueries', label: 'Searches' } ];
  // Which field plays which role on a card — first one present wins. Order = priority. These cover
  // the shapes roles emit today and degrade gracefully for ones they don't: a title, a short reason,
  // a verbatim quote, a way to make contact, and links. Anything left over still shows as a chip.
  const TITLE_KEYS   = ['name', 'who', 'handle', 'title', 'subject', 'company', 'author', 'from', 'client', 'term', 'query', 'q'];
  const BODY_KEYS    = ['why', 'summary', 'what', 'reason', 'assessment', 'note', 'fit', 'description', 'desc'];
  const QUOTE_KEYS   = ['quote', 'postText', 'text', 'message', 'brief', 'snippet', 'excerpt', 'post', 'body'];
  const CONTACT_KEYS = ['email', 'phone', 'website', 'contact'];
  const LINK_KEYS    = ['url', 'link', 'permalink', 'postUrl', 'profileUrl', 'groupUrl', 'href', 'profile'];
  const HIDE_KEYS    = ['__jobId', 'id', '_id'];
  const fmtVal = (v) => Array.isArray(v) ? v.join(', ') : (v && typeof v === 'object') ? JSON.stringify(v) : String(v);
  const pick = (rec, keys, used) => { for (const k of keys) if (!used.has(k) && rec[k] != null && rec[k] !== '') return { k, v: rec[k] }; return null; };
  function contactHref(k, v) {
    const s = String(v).trim();
    if (k === 'email' || (k === 'contact' && /@/.test(s))) return 'mailto:' + s;
    if (k === 'phone') { const d = s.replace(/[^\d+]/g, ''); return d ? 'tel:' + d : null; }
    if (/^https?:\/\//i.test(s)) return s;
    if (k === 'website') return 'http://' + s.replace(/^\/*/, '');
    return null;
  }

  function runResultsModal() {
    let m = el('runModal'); if (m) return m;
    m = document.createElement('div'); m.className = 'run-modal'; m.id = 'runModal';
    m.innerHTML = '<div class="rrcard"><div class="rrhd"><div><div class="rrt"></div><div class="rrs"></div></div><button class="x" data-x="1">✕</button></div><div class="rrbody"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-x]')) { m.classList.remove('on'); stopResultsPoll(); } });
    return m;
  }
  // Adaptive card: reads whatever fields a record carries and places each by the role it plays —
  // title, short reason, a verbatim quote block, a contact row, meta chips, and links. Nothing is
  // hidden: any leftover scalar becomes a chip (long ones truncated), so an unfamiliar shape from a
  // new role still renders completely rather than losing fields.
  function recordCard(rec, openLabel) {
    if (rec == null) return '';
    if (typeof rec !== 'object') return '<div class="lcard"><div class="lwhy">' + esc(fmtVal(rec)) + '</div></div>';
    const used = new Set(HIDE_KEYS);
    const t = pick(rec, TITLE_KEYS, used); if (t) used.add(t.k);
    const b = pick(rec, BODY_KEYS, used); if (b) used.add(b.k);
    const q = pick(rec, QUOTE_KEYS, used); if (q) used.add(q.k);
    for (const k of QUOTE_KEYS) used.add(k);   // the other verbatim fields duplicate the quote — don't chip them too
    const link = pick(rec, LINK_KEYS, used); if (link) used.add(link.k);
    const when = rec.at ? fmtTime(rec.at) : ''; used.add('at');
    const contacts = [];
    for (const k of CONTACT_KEYS) { if (used.has(k)) continue; const v = rec[k]; if (v == null || v === '') continue; used.add(k);
      const href = contactHref(k, v);
      contacts.push(href ? '<a class="lc-contact" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(String(v)) + '</a>'
                         : '<span class="lc-contact">' + esc(String(v)) + '</span>'); }
    const links = [];
    for (const k of LINK_KEYS) { if (used.has(k)) continue; const v = rec[k]; if (!v) continue; used.add(k);
      links.push('<a class="llink alt" href="' + esc(String(v)) + '" target="_blank" rel="noopener">' + esc(k.replace(/Url$/, '')) + ' →</a>'); }
    const chips = [];
    for (const k of Object.keys(rec)) { if (used.has(k)) continue; const v = rec[k]; if (v == null || v === '') continue;
      if (typeof v === 'object') continue; let s = fmtVal(v); if (s.length > 52) s = s.slice(0, 50) + '…';
      chips.push('<span class="lchip"><em>' + esc(humanKey(k)) + '</em> ' + esc(s) + '</span>'); }
    const title = t ? fmtVal(t.v) : (b || q ? '' : 'Record');
    // A Messenger contact record gets a "Message" action — pick it, guide the AI, it opens the chat.
    const isMsg = String(rec.platform || '').toLowerCase() === 'messenger' || /\/messages\//.test(String(rec.postUrl || rec.url || ''));
    const msgBtn = isMsg ? '<button class="btn primary sm" data-msgstart="1" data-name="' + esc(String(rec.name || rec.who || 'this contact')) + '" data-thread="' + esc(String(rec.postUrl || rec.url || '')) + '">💬 Message</button>' : '';
    return '<div class="lcard">'
      + '<div class="lhd">' + (title ? '<div class="lname">' + esc(title) + '</div>' : '<span></span>') + (when ? '<div class="lwhen">' + esc(when) + '</div>' : '') + '</div>'
      + (b ? '<div class="lwhy">' + esc(fmtVal(b.v)) + '</div>' : '')
      + (q ? '<blockquote class="lquote">' + esc(fmtVal(q.v)) + '</blockquote>' : '')
      + (chips.length ? '<div class="lchips">' + chips.join('') + '</div>' : '')
      + (contacts.length ? '<div class="lcontacts">' + contacts.join('') + '</div>' : '')
      + ((link || links.length || msgBtn) ? '<div class="llinks">' + msgBtn + (link ? '<a class="llink" href="' + esc(fmtVal(link.v)) + '" target="_blank" rel="noopener">' + esc(openLabel || 'Open →') + '</a>' : '') + links.join('') + '</div>' : '')
      + '</div>';
  }
  // Walk the run's steps and group every emitted collection into labelled sections.
  function runSections(run) {
    const recs = [], strs = [], counts = [];
    for (const s of (run && run.steps || [])) {
      const o = s.output, who = s.label || s.node_id || 'step';
      if (!o || typeof o !== 'object') continue;
      for (const def of RECORD_SETS) if (Array.isArray(o[def.key]) && o[def.key].length) recs.push({ def, who, items: o[def.key] });
      for (const def of STRING_SETS) if (Array.isArray(o[def.key]) && o[def.key].length) strs.push({ def, who, items: o[def.key] });
      if (typeof o.count === 'number') counts.push({ who, n: o.count });
    }
    return { recs, strs, counts };
  }
  async function openRunResults(run) { RUNVIEW = run; LEADFILTER = ''; APPROVALS = []; runResultsModal(); el('runModal').classList.add('on'); renderRunResults(); await loadApprovals(); renderRunResults(); }
  function renderRunResults() {
    const run = RUNVIEW, m = el('runModal'); if (!run || !m || !m.classList.contains('on')) return;
    m.querySelector('.rrt').textContent = run.name || 'Run';
    m.querySelector('.rrs').textContent = 'Run · ' + (run.status || '') + (run.started_at ? ' · ' + fmtTime(run.started_at) : '');
    const { recs, strs, counts } = runSections(run);
    const total = recs.reduce((n, s) => n + s.items.length, 0);
    const stepChips = (run.steps || []).map((s) => '<span class="schip ' + (s.status || '') + '"><span class="rdot"></span>' + esc(s.label || s.node_id) + '</span>').join('<span class="sarr">→</span>');
    const f = LEADFILTER.toLowerCase();
    // summary line — pluralise per collection, name what each acting step did
    const summ = [];
    for (const s of recs) summ.push('<b>' + s.items.length + '</b> ' + esc(s.def.label.toLowerCase()));
    for (const c of counts) summ.push('<b>' + c.n + '</b> processed by ' + esc(c.who));
    // record sections (filterable)
    let sectionsHtml = '';
    for (const s of recs) {
      const items = f ? s.items.filter((r) => JSON.stringify(r).toLowerCase().indexOf(f) >= 0) : s.items;
      sectionsHtml += '<div class="rsec"><div class="rsech">' + esc(s.def.label) + ' <span class="rcount">' + s.items.length + '</span>'
        + '<span class="rfrom">from ' + esc(s.who) + '</span></div>'
        + '<div class="lgrid">' + (items.length ? items.map((r) => recordCard(r, s.def.open)).join('') : '<div class="lempty">None match "' + esc(LEADFILTER) + '".</div>') + '</div></div>';
    }
    for (const s of strs) {
      sectionsHtml += '<div class="rsec"><div class="rsech">' + esc(s.def.label) + ' <span class="rcount">' + s.items.length + '</span><span class="rfrom">from ' + esc(s.who) + '</span></div>'
        + '<div class="tagset">' + s.items.map((x) => '<span class="tagx">' + esc(fmtVal(x)) + '</span>').join('') + '</div></div>';
    }
    if (!recs.length && !strs.length) sectionsHtml = '<div class="lempty">' + (run.status === 'running' ? 'Still collecting — results will appear here as each step produces them.' : 'This run produced no saved records.') + '</div>';
    // the crafted replies waiting for a yes — the action item, so it sits at the very top
    let apprHtml = '';
    if (APPROVALS.length) {
      apprHtml = '<div class="apprsec"><div class="apprh"><span class="apprdot"></span>' + APPROVALS.length + ' reply' + (APPROVALS.length === 1 ? '' : 's') + ' waiting for your approval — nothing is sent until you say yes</div>'
        + APPROVALS.map((a, i) => '<div class="appr">'
            + (a.goal ? '<div class="appr-ctx">In reply to: ' + esc(a.goal.replace(/\s+/g, ' ').replace(/^[^:]*:\s*/, '').slice(0, 180)) + '</div>' : '')
            + '<div class="appr-reply">' + esc(a.text || '(empty draft)') + '</div>'
            + (a.why ? '<div class="appr-why">Why: ' + esc(a.why) + '</div>' : '')
            + '<div class="appr-acts"><button class="btn primary sm" data-appr="' + i + '" data-ok="1">✓ Approve &amp; send</button>'
            + '<button class="btn ghost sm" data-appr="' + i + '" data-ok="0">Skip</button></div></div>').join('')
        + '</div>';
    } else if (run.status === 'running') {
      apprHtml = '<div class="apprsec idle"><div class="apprh"><span class="apprdot wait"></span>Drafting the next reply… it will appear here for your approval</div></div>';
    }
    m.querySelector('.rrbody').innerHTML =
      '<div class="sflow">' + stepChips + '</div>'
      + apprHtml
      + '<div class="rrsum">' + (summ.length ? summ.join(' · ') : (run.status === 'running' ? 'Still collecting…' : 'No records')) + '</div>'
      + (total > 4 ? '<input class="rrfilter" id="rrFilter" placeholder="Filter results by any word…" value="' + esc(LEADFILTER) + '">' : '')
      + sectionsHtml;
    m.querySelectorAll('[data-appr]').forEach((b) => b.onclick = () => { const a = APPROVALS[+b.dataset.appr]; if (a) { b.closest('.appr').style.opacity = '.5'; decideApproval(a.jobId, a.pid, b.dataset.ok === '1'); } });
    m.querySelectorAll('[data-msgstart]').forEach((b) => b.onclick = async () => {
      const name = b.dataset.name || 'this contact';
      const guidance = prompt('What should the AI say to ' + name + '?\n\nDescribe the conversation to start — in your own words:');
      if (!guidance || !guidance.trim()) return;
      b.disabled = true; b.textContent = 'Starting…';
      try {
        await api('/v1/agent/message-contact', { method: 'POST', body: JSON.stringify({ name, threadUrl: b.dataset.thread || '', guidance: guidance.trim() }) });
        b.textContent = '✓ Drafting — approve above';
        startApprovalWatch();   // the opener parks at the gate; poll so it appears in the queue up top
      } catch (e) { b.disabled = false; b.textContent = '💬 Message'; alert('Could not start it: ' + (e.message || e)); }
    });
    const fi = el('rrFilter'); if (fi) fi.oninput = () => { LEADFILTER = fi.value; renderRunResults(); const g = el('rrFilter'); if (g) { g.focus(); const p = g.value.length; try { g.setSelectionRange(p, p); } catch (e) {} } };
  }

  window.Automation = { load };
})();
