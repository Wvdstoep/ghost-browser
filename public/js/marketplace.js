// ═══════════════════════ ROLES MARKETPLACE — the creation engine + catalogue ═══════════════════════
// A self-contained view (one IIFE, no new globals but window.Marketplace) that lets a person BROWSE
// every role the agent can run (built-in, their own, imported from a pack), CREATE one through an
// easy form — with an AI that drafts it from a plain description — and IMPORT / EXPORT packs. It talks
// only to the /v1/agent/roles and /v1/agent/tools endpoints through the shared api() helper, and it
// reuses the dashboard's card / pill / modal language so it looks like one console. dashboard.js owns
// the nav swap and calls window.Marketplace.load() when the Roles tab is shown.
(function () {
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Platform look, mirrored from the dashboard so a role's badge matches its account card.
  const PLAT = {
    facebook: { name: 'Facebook', mark: 'f', brand: '#1877f2' },
    google: { name: 'Google', mark: 'G', brand: '#c9433b' },
    linkedin: { name: 'LinkedIn', mark: 'in', brand: '#0a66c2' },
    reddit: { name: 'Reddit', mark: 'R', brand: '#ff4500' },
    youtube: { name: 'YouTube', mark: '▶', brand: '#ff0000' },
    x: { name: 'X', mark: '𝕏', brand: '#0f1419' },
    producthunt: { name: 'Product Hunt', mark: 'P', brand: '#da552f' },
    instagram: { name: 'Instagram', mark: '◈', brand: '#e1306c' },
  };
  const PLATFORM_ORDER = ['facebook', 'google', 'linkedin', 'reddit', 'youtube', 'x', 'producthunt', 'instagram'];
  // A sensible starting toolset for a fresh role — getting around, plus the account tools.
  const BASICS = ['look', 'read', 'open', 'click', 'type', 'scroll', 'back', 'note', 'finish', 'list_profiles', 'use_profile'];

  let ROLES = [], TOOLS = [], TOOLGROUPS = [], FILTER = 'all', SEARCH = '';
  let SELECTED = new Set();        // tools ticked in the open builder
  let EDIT_ID = null;              // the id being edited (null = creating)

  // Which bucket a role belongs to, from its source tag ('builtin' | 'user' | 'pack:<name>').
  const kindOf = (r) => (r.source === 'builtin' ? 'builtin' : (r.source && r.source.indexOf('pack:') === 0 ? 'pack' : 'yours'));
  const KIND_LABEL = { builtin: 'Built-in', yours: 'Yours', pack: 'Pack' };

  // ── load everything the view needs, then draw ──────────────────────────────────────────────────
  async function load() {
    try {
      const [r, t] = await Promise.all([
        api('/v1/agent/roles').catch(() => ({ roles: [] })),
        api('/v1/agent/tools').catch(() => ({ tools: [] })),
      ]);
      ROLES = r.roles || [];
      TOOLS = t.tools || [];
      const g = {};
      for (const tool of TOOLS) (g[tool.group] = g[tool.group] || []).push(tool);
      TOOLGROUPS = Object.entries(g).map(([group, tools]) => ({ group, tools }));
    } catch (e) { /* keep whatever is there */ }
    render();
  }

  // ── the catalogue ──────────────────────────────────────────────────────────────────────────────
  function badge(site) {
    const p = site && PLAT[site];
    if (p) return '<span class="rbadge" style="--b:' + p.brand + '">' + esc(p.mark) + '</span>';
    return '<span class="rbadge cross">✦</span>';   // crosses sites / no single platform
  }
  const toolCount = (r) => (r.tools == null ? 'every tool' : (r.tools.length + (r.tools.length === 1 ? ' tool' : ' tools')));
  const canAct = (r) => (r.tools == null || (Array.isArray(r.tools) && r.tools.indexOf('act') >= 0));

  function match(r) {
    const k = kindOf(r);
    if (FILTER === 'yours' && k !== 'yours') return false;
    if (FILTER === 'builtin' && k !== 'builtin') return false;
    if (FILTER === 'packs' && k !== 'pack') return false;
    if (SEARCH) {
      const hay = (r.label + ' ' + (r.description || '') + ' ' + (r.site || '') + ' ' + (r.group || '')).toLowerCase();
      if (hay.indexOf(SEARCH.toLowerCase()) < 0) return false;
    }
    return true;
  }

  function card(r) {
    const k = kindOf(r);
    const site = r.site ? (PLAT[r.site] ? PLAT[r.site].name : r.site) : 'Crosses sites';
    const acts = k === 'builtin'
      ? '<button class="btn ghost sm" data-clone="' + esc(r.name) + '">Clone</button>'
      : '<button class="btn ghost sm" data-edit="' + esc(r.name) + '">Edit</button>'
        + '<button class="btn ghost sm" data-export="' + esc(r.name) + '">Export</button>'
        + '<button class="btn ghost sm danger" data-del="' + esc(r.name) + '">Delete</button>';
    return '<div class="rcard">'
      + '<div class="rhd">' + badge(r.site)
      + '<div class="rttl"><div class="rname">' + esc(r.label) + '</div><div class="rsite">' + esc(site) + '</div></div>'
      + '<span class="rtag ' + k + '">' + KIND_LABEL[k] + (k === 'pack' ? ' · ' + esc(r.source.slice(5)) : '') + '</span></div>'
      + '<div class="rdesc">' + esc(r.description || '—') + '</div>'
      + '<div class="rmeta"><span>🧰 ' + toolCount(r) + '</span>' + (canAct(r) ? '<span class="act">⚠ can act</span>' : '') + '</div>'
      + '<div class="racts">' + acts + '</div></div>';
  }

  function render() {
    const view = el('dashRolesView'); if (!view) return;
    const counts = {
      all: ROLES.length,
      yours: ROLES.filter((r) => kindOf(r) === 'yours').length,
      builtin: ROLES.filter((r) => kindOf(r) === 'builtin').length,
      packs: ROLES.filter((r) => kindOf(r) === 'pack').length,
    };
    const TAB = { all: 'All', yours: 'Yours', builtin: 'Built-in', packs: 'Packs' };
    const rows = ROLES.filter(match);
    const grid = rows.length
      ? rows.map(card).join('')
      : '<div class="rempty">' + (FILTER === 'yours'
        ? 'You haven\'t created any roles yet. Start from a built-in with <b>Clone</b>, or press <b>Create role</b>.'
        : 'Nothing here yet.') + '</div>';

    view.innerHTML =
      '<div class="mkt-top">'
      + '<div class="mkt-actions">'
      + '<button class="btn ghost" id="mktImport">⭳ Import pack</button>'
      + '<button class="btn ghost" id="mktExportAll">⭱ Export mine</button>'
      + '<button class="btn primary" id="mktNew">＋ Create role</button>'
      + '</div>'
      + '<div class="mkt-bar">'
      + '<input id="mktSearch" class="mkt-search" placeholder="Search roles…" value="' + esc(SEARCH) + '">'
      + '<div class="mkt-tabs">' + Object.keys(TAB).map((f) =>
        '<button class="mtab ' + (FILTER === f ? 'on' : '') + '" data-filter="' + f + '">' + TAB[f] + ' <span class="cnt">' + counts[f] + '</span></button>').join('') + '</div>'
      + '</div>'
      + '<div class="mkt-grid">' + grid + '</div>';

    wire();
  }

  function wire() {
    const view = el('dashRolesView');
    el('mktNew') && (el('mktNew').onclick = () => openBuilder(null));
    el('mktImport') && (el('mktImport').onclick = () => openPack('import'));
    el('mktExportAll') && (el('mktExportAll').onclick = () => exportRoles(ROLES.filter((r) => kindOf(r) !== 'builtin').map((r) => r.name), 'My roles'));
    const s = el('mktSearch');
    if (s) s.oninput = () => { SEARCH = s.value; const g = view.querySelector('.mkt-grid'); if (g) g.innerHTML = renderGridOnly(); bindCards(); };
    view.querySelectorAll('.mtab').forEach((b) => b.onclick = () => { FILTER = b.dataset.filter; render(); });
    bindCards();
  }
  // Re-render just the grid on a keystroke, so the search box keeps focus.
  function renderGridOnly() {
    const rows = ROLES.filter(match);
    return rows.length ? rows.map(card).join('')
      : '<div class="rempty">Nothing matches "' + esc(SEARCH) + '".</div>';
  }
  function bindCards() {
    const view = el('dashRolesView'); if (!view) return;
    view.querySelectorAll('[data-clone]').forEach((b) => b.onclick = () => openBuilder(b.dataset.clone, 'clone'));
    view.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openBuilder(b.dataset.edit, 'edit'));
    view.querySelectorAll('[data-export]').forEach((b) => b.onclick = () => exportRoles([b.dataset.export], b.dataset.export));
    view.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => del(b.dataset.del));
  }

  async function del(name) {
    const r = ROLES.find((x) => x.name === name);
    if (!confirm('Delete the role "' + (r ? r.label : name) + '"? This cannot be undone.')) return;
    try { await api('/v1/agent/roles/' + encodeURIComponent(name), { method: 'DELETE' }); } catch (e) { alert('Could not delete: ' + (e.message || e)); }
    load();
  }

  // ── the builder ──────────────────────────────────────────────────────────────────────────────
  function platformOptions(site) {
    const opts = ['<option value="">Crosses sites / no single platform</option>'];
    for (const id of PLATFORM_ORDER) opts.push('<option value="' + id + '"' + (site === id ? ' selected' : '') + '>' + PLAT[id].name + '</option>');
    return opts.join('');
  }
  function toolGroupsHtml() {
    return TOOLGROUPS.map((g) =>
      '<div class="tgroup"><div class="tgh">' + esc(g.group) + '</div><div class="tchips">'
      + g.tools.map((t) =>
        '<button type="button" class="tchip ' + (SELECTED.has(t.name) ? 'on ' : '') + (t.gated ? 'gated' : '') + '" data-tool="' + esc(t.name) + '" title="' + esc(t.description) + '">'
        + esc(t.name) + (t.gated ? ' ⚠' : '') + '</button>').join('')
      + '</div></div>').join('');
  }

  // role is a NAME (to fetch full) or null (new). mode: 'edit' keeps the id, 'clone' starts fresh.
  async function openBuilder(name, mode) {
    let role = { label: '', site: '', description: '', tools: BASICS.slice(), prompt: '' };
    EDIT_ID = null;
    if (name) {
      try { role = await api('/v1/agent/roles/' + encodeURIComponent(name)); } catch (e) { alert('Could not open that role: ' + (e.message || e)); return; }
      if (mode === 'edit') EDIT_ID = role.name;
      if (mode === 'clone') role.label = (role.label || '') + ' (my copy)';
    }
    SELECTED = new Set(role.tools == null ? [] : role.tools);
    const everyTool = role.tools == null;

    const m = el('roleModal');
    m.querySelector('.t').textContent = EDIT_ID ? 'Edit role' : (mode === 'clone' ? 'Clone role' : 'Create a role');
    m.querySelector('.s').textContent = 'A specialist your agent can run. The act gate is unchanged — a role decides what it reaches for, never whether it may act unasked.';
    m.querySelector('.mbody').innerHTML =
      '<div class="rform">'
      + '<div class="aisug"><div class="aisug-h">✨ Draft with AI</div>'
      + '<p>Describe what this role should do — AI fills the form below. You review everything before saving.</p>'
      + '<div class="airow"><textarea id="aiDesc" rows="2" placeholder="e.g. Read Reddit for people complaining about slow invoicing and save them as leads — never post or reply."></textarea>'
      + '<button type="button" class="btn primary" id="aiGo">Generate</button></div>'
      + '<div class="aimsg" id="aiMsg"></div></div>'
      + '<div class="rfield"><label>Name</label><input id="fLabel" value="' + esc(role.label) + '" placeholder="e.g. Reddit · Complaint scout"></div>'
      + '<div class="rfield"><label>Platform</label><select id="fSite">' + platformOptions(role.site || '') + '</select></div>'
      + '<div class="rfield"><label>What it can do <span class="hint">— the tools it may reach for</span></label>'
      + '<label class="allrow"><input type="checkbox" id="fAll"' + (everyTool ? ' checked' : '') + '> Give it every tool <span class="hint">(advanced)</span></label>'
      + '<div class="toolgroups' + (everyTool ? ' dim' : '') + '" id="fTools">' + toolGroupsHtml() + '</div>'
      + '<div class="tcount" id="fCount"></div></div>'
      + '<div class="rfield"><label>Playbook <span class="hint">— tell it plainly what its job is, and what it must NOT do</span></label>'
      + '<textarea id="fPrompt" rows="8" placeholder="Your job is to… Address it as \'you\'. Say what it must NOT do just as clearly.">' + esc(role.prompt) + '</textarea></div>'
      + '<div class="rfield"><label>Short description <span class="hint">— optional, one line for the card</span></label>'
      + '<input id="fDesc" value="' + esc(role.description) + '" placeholder="Reads Reddit for people who need what you sell."></div>'
      + '<div class="rerr" id="fErr"></div>'
      + '</div>';
    m.querySelector('.mfoot').innerHTML =
      '<button class="btn" data-mclose="1">Cancel</button>'
      + '<button class="btn primary" id="fSave">' + (EDIT_ID ? 'Save changes' : 'Create role') + '</button>';

    wireBuilder();
    updateCount();
    m.classList.add('on');
  }

  function wireBuilder() {
    const m = el('roleModal');
    m.querySelectorAll('.tchip').forEach((c) => c.onclick = () => {
      if (el('fAll').checked) return;
      const t = c.dataset.tool;
      if (SELECTED.has(t)) { SELECTED.delete(t); c.classList.remove('on'); }
      else { SELECTED.add(t); c.classList.add('on'); }
      updateCount();
    });
    el('fAll').onchange = () => {
      el('fTools').classList.toggle('dim', el('fAll').checked);
      updateCount();
    };
    el('aiGo').onclick = aiSuggest;
    el('fSave').onclick = save;
    m.querySelectorAll('[data-mclose]').forEach((b) => b.onclick = closeBuilder);
  }
  function updateCount() {
    const c = el('fCount'); if (!c) return;
    c.textContent = el('fAll').checked ? 'Every tool — the agent may reach for anything.' : (SELECTED.size + ' selected');
  }
  function closeBuilder() { el('roleModal').classList.remove('on'); }

  async function aiSuggest() {
    const desc = (el('aiDesc').value || '').trim();
    const msg = el('aiMsg');
    if (desc.length < 8) { msg.textContent = 'Describe it in a sentence or two first.'; msg.className = 'aimsg warn'; return; }
    msg.textContent = 'Thinking…'; msg.className = 'aimsg';
    const go = el('aiGo'); go.disabled = true;
    try {
      const d = await api('/v1/agent/roles/suggest', { method: 'POST', body: JSON.stringify({ description: desc }) });
      if (d.label) el('fLabel').value = d.label;
      if (d.description) el('fDesc').value = d.description;
      if (d.prompt) el('fPrompt').value = d.prompt;
      el('fSite').value = d.site || '';
      // The suggestion names tools — untick "every tool", select exactly those.
      el('fAll').checked = false; el('fTools').classList.remove('dim');
      SELECTED = new Set(Array.isArray(d.tools) ? d.tools : []);
      el('roleModal').querySelectorAll('.tchip').forEach((c) => c.classList.toggle('on', SELECTED.has(c.dataset.tool)));
      updateCount();
      msg.textContent = 'Drafted — review it and adjust anything before saving.'; msg.className = 'aimsg ok';
    } catch (e) {
      msg.textContent = e.message || 'The AI model could not be reached — check it under Settings.'; msg.className = 'aimsg warn';
    } finally { go.disabled = false; }
  }

  async function save() {
    const err = el('fErr'); err.textContent = '';
    const body = {
      label: el('fLabel').value.trim(),
      site: el('fSite').value || null,
      description: el('fDesc').value.trim(),
      tools: el('fAll').checked ? null : Array.from(SELECTED),
      prompt: el('fPrompt').value.trim(),
    };
    const path = EDIT_ID ? '/v1/agent/roles/' + encodeURIComponent(EDIT_ID) : '/v1/agent/roles';
    try {
      await api(path, { method: EDIT_ID ? 'PUT' : 'POST', body: JSON.stringify(body) });
      closeBuilder();
      load();
    } catch (e) { err.textContent = e.message || 'Could not save this role.'; }
  }

  // ── packs: import one, export a set ──────────────────────────────────────────────────────────────
  function openPack(mode, payload) {
    const m = el('packModal');
    if (mode === 'import') {
      m.querySelector('.t').textContent = 'Import a roles pack';
      m.querySelector('.s').textContent = 'Paste a pack below, or load a .json file. It installs whole, or not at all.';
      m.querySelector('.mbody').innerHTML =
        '<input type="file" id="pkFile" accept="application/json,.json" class="pkfile">'
        + '<textarea id="pkText" rows="12" class="pktext" placeholder=\'{ "kind": "ghost-roles-pack", "name": "...", "roles": [ ... ] }\'></textarea>'
        + '<div class="rerr" id="pkErr"></div>';
      m.querySelector('.mfoot').innerHTML = '<button class="btn" data-pclose="1">Cancel</button><button class="btn primary" id="pkGo">Install pack</button>';
      m.classList.add('on');
      el('pkFile').onchange = (e) => {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        const rd = new FileReader(); rd.onload = () => { el('pkText').value = rd.result; }; rd.readAsText(f);
      };
      el('pkGo').onclick = installPack;
    } else {
      m.querySelector('.t').textContent = 'Export ' + (payload.count === 1 ? 'a role' : payload.count + ' roles');
      m.querySelector('.s').textContent = 'A shareable pack. Copy it, or download the file, and import it anywhere.';
      m.querySelector('.mbody').innerHTML =
        '<textarea id="pkText" rows="14" class="pktext" readonly>' + esc(payload.json) + '</textarea>';
      m.querySelector('.mfoot').innerHTML =
        '<button class="btn" data-pclose="1">Close</button>'
        + '<button class="btn ghost" id="pkDl">⭳ Download</button>'
        + '<button class="btn primary" id="pkCopy">Copy</button>';
      m.classList.add('on');
      el('pkCopy').onclick = async () => {
        try { await navigator.clipboard.writeText(payload.json); el('pkCopy').textContent = 'Copied'; setTimeout(() => el('pkCopy').textContent = 'Copy', 1400); }
        catch (e) { el('pkText').select(); }
      };
      el('pkDl').onclick = () => download((payload.name || 'roles') + '.json', payload.json);
    }
    m.querySelectorAll('[data-pclose]').forEach((b) => b.onclick = () => m.classList.remove('on'));
  }

  async function installPack() {
    const err = el('pkErr'); err.textContent = '';
    let pack;
    try { pack = JSON.parse(el('pkText').value); } catch (e) { err.textContent = 'That is not valid JSON.'; return; }
    try {
      const r = await api('/v1/agent/roles/import', { method: 'POST', body: JSON.stringify(pack) });
      el('packModal').classList.remove('on');
      load();
      alert('Installed ' + ((r.installed || []).length) + ' role(s).');
    } catch (e) { err.textContent = e.message || 'Could not install this pack.'; }
  }

  async function exportRoles(ids, name) {
    if (!ids.length) { alert('Nothing to export — create or clone a role first.'); return; }
    try {
      const pack = await api('/v1/agent/roles/export?ids=' + encodeURIComponent(ids.join(',')) + '&name=' + encodeURIComponent(name || 'My roles'));
      openPack('export', { json: JSON.stringify(pack, null, 2), count: (pack.roles || []).length, name: (name || 'roles').replace(/[^a-z0-9_-]+/gi, '-') });
    } catch (e) { alert('Could not export: ' + (e.message || e)); }
  }

  function download(fname, text) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { /* the Copy button is the reliable fallback */ }
  }

  // ── the two modals, injected once so index.html stays about structure ──────────────────────────
  function ensureModals() {
    if (el('roleModal')) return;
    const mk = (id) => {
      const d = document.createElement('div');
      d.className = 'mkt-modal'; d.id = id;
      d.innerHTML = '<div class="mcard"><div class="mhd"><div><div class="t"></div><div class="s"></div></div>'
        + '<button class="x" data-xclose="1">✕</button></div><div class="mbody"></div><div class="mfoot"></div></div>';
      document.body.appendChild(d);
      d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-xclose]')) d.classList.remove('on'); });
      return d;
    };
    mk('roleModal'); mk('packModal');
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      ['roleModal', 'packModal'].forEach((id) => el(id) && el(id).classList.remove('on'));
    });
  }

  ensureModals();
  window.Marketplace = { load };
})();
