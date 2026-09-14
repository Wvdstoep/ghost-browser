'use strict'
const G = window.GBAPI
if (!G) { document.body.innerHTML = '<div style="color:#EAF0E6;font-family:system-ui;padding:40px">Ghost Browser Desktop failed to initialise (preload bridge missing). Please report this.</div>' }
const gbJs = (G && G.gbJs) || '', gbControlJs = (G && G.gbControlJs) || ''
const HOME = new URL('home.html', location.href).href
const $ = (id) => document.getElementById(id)
const webarea = $('webarea'), hidden = $('hidden')

const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v } catch (e) { return d } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch (e) {} },
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function hostOf(u) { if (!u || u === HOME || u.startsWith('file:')) return 'Home'; try { return new URL(u).host } catch (e) { return u } }
function normU(u) { try { const x = new URL(u); return (x.host.replace(/^www\.|^m\./, '')) + x.pathname.replace(/\/$/, '') } catch (e) { return (u || '').toLowerCase() } }
function extractJson(s) { if (!s) return null; const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) return null; try { return JSON.parse(s.slice(a, b + 1)) } catch (e) { return null } }

let clusterUrl = LS.get('clusterUrl', 'https://ghost-browser.mavicpro-fan.my-app.engineer')
let profiles = (() => { try { return JSON.parse(LS.get('profiles', '["default"]')) } catch (e) { return ['default'] } })()
let currentProfile = LS.get('profile', 'default')

// ---------- log ----------
let logSinkOn = false
function log(s) {
  const el = $('log'); el.textContent += s + '\n'
  if (el.textContent.length > 16000) el.textContent = el.textContent.slice(-16000)
  el.scrollTop = el.scrollHeight
  if (logSinkOn && controlWv) { try { controlWv.executeJavaScript('if(window.__gbLog)window.__gbLog(' + JSON.stringify(s) + ')', false) } catch (e) {} }
}

// ---------- tabs ----------
let tabs = [], active = -1
function saveTabs() { LS.set('tabs', JSON.stringify(tabs.map((t) => ({ url: t.url, title: t.title, profile: t.profile })))); LS.set('activeTab', String(active)) }
function restoreTabs() {
  try { JSON.parse(LS.get('tabs', '[]')).forEach((t) => tabs.push({ url: t.url || HOME, title: t.title || 'New tab', profile: t.profile || 'default', wv: null })) } catch (e) {}
  if (!tabs.length) tabs.push({ url: HOME, title: 'New tab', profile: currentProfile, wv: null })
  active = Math.min(parseInt(LS.get('activeTab', '0')) || 0, tabs.length - 1)
}
function mkWebview(profile, url) {
  const wv = document.createElement('webview')
  wv.setAttribute('partition', 'persist:' + profile)
  wv.setAttribute('allowpopups', '')
  if (url) wv.setAttribute('src', url)
  return wv
}
function isActive(t) { return active >= 0 && tabs[active] === t }
function absUrl(u) { if (!u) return HOME; if (/^https?:\/\//.test(u) || u.startsWith('file:')) return u; return 'https://' + u }
function ensureWv(t) {
  if (t.wv) return t.wv
  t.url = absUrl(t.url || HOME)
  const wv = mkWebview(t.profile, t.url)
  wv.classList.add('hidden')
  wv.addEventListener('did-stop-loading', () => { t.url = wv.getURL(); if (isActive(t)) setUrlBar(t.url); saveTabs() })
  wv.addEventListener('page-title-updated', (e) => { t.title = e.title; if (!$('switch').classList.contains('hidden')) renderSwitch() })
  wv.addEventListener('did-navigate', () => { if (isActive(t)) setUrlBar(wv.getURL()) })
  webarea.appendChild(wv)
  t.wv = wv
  return wv
}
function setUrlBar(u) { $('url').value = (!u || u === HOME || u.startsWith('file:')) ? '' : u }
function updateCount() { $('tabcount').textContent = tabs.length > 99 ? '99' : String(tabs.length) }
function activateTab(i) {
  if (i < 0 || i >= tabs.length) return
  const t = tabs[i]; ensureWv(t)
  tabs.forEach((x, j) => { if (x.wv) x.wv.classList.toggle('hidden', j !== i) })
  active = i
  if (t.profile !== currentProfile) { currentProfile = t.profile; LS.set('profile', currentProfile); renderChips() }
  setUrlBar(t.url); updateCount(); saveTabs()
}
function newTab(url) { url = url || HOME; tabs.push({ url, title: url === HOME ? 'New tab' : url, profile: currentProfile, wv: null }); activateTab(tabs.length - 1); hideSheet() }
function closeTab(i) {
  if (i < 0 || i >= tabs.length) return
  if (tabs[i].wv) { try { tabs[i].wv.remove() } catch (e) {} }
  tabs.splice(i, 1)
  if (!tabs.length) { newTab(HOME); return }
  if (i < active) active--
  if (active >= tabs.length) active = tabs.length - 1
  activateTab(active)
  if (!$('switch').classList.contains('hidden')) renderSwitch()
  updateCount()
}
function nav(wv, url) {
  return new Promise((res) => {
    let done = false
    const fin = () => { if (done) return; done = true; wv.removeEventListener('did-stop-loading', fin); res(wv.getURL()) }
    wv.addEventListener('did-stop-loading', fin)
    try { wv.loadURL(url) } catch (e) { wv.src = url }
    setTimeout(fin, 25000)
  })
}
function go(raw) {
  let u = (raw || '').trim(); if (!u) return
  if (!/^https?:\/\//.test(u) && !u.startsWith('file:')) u = (u.includes('.') && !u.includes(' ')) ? 'https://' + u : 'https://www.google.com/search?q=' + encodeURIComponent(u)
  const t = tabs[active]; ensureWv(t); t.wv.loadURL(u); setUrlBar(u); hideSheet()
}
async function ex(wv, code) { try { return await wv.executeJavaScript(code, false) } catch (e) { return null } }

// ---------- tab switcher ----------
function openSwitch() { renderSwitch(); $('switch').classList.remove('hidden') }
function hideSwitch() { $('switch').classList.add('hidden') }
function renderSwitch() {
  const l = $('switchlist'); l.innerHTML = ''
  tabs.forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'swrow'
    row.innerHTML = '<div class="col"><div class="t"></div><div class="s"></div></div>'
    const tt = row.querySelector('.t'); tt.textContent = t.title || 'New tab'; if (i === active) tt.classList.add('on')
    row.querySelector('.s').textContent = hostOf(t.url) + (t.profile !== 'default' ? '  ·  ' + t.profile : '')
    const x = document.createElement('button'); x.className = 'ic'
    x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
    x.onclick = (e) => { e.stopPropagation(); closeTab(i) }
    row.appendChild(x)
    row.onclick = () => { activateTab(i); hideSwitch() }
    l.appendChild(row)
  })
}

// ---------- cluster control channel ----------
let controlWv = null
function connect() {
  if (controlWv) { disconnect(); return }
  clusterUrl = $('cl-url').value.trim() || clusterUrl; LS.set('clusterUrl', clusterUrl)
  setStatus('Cluster: connecting…'); log('→ connecting (control channel on the GB origin)…')
  const wv = mkWebview(currentProfile, clusterUrl)
  wv.addEventListener('did-stop-loading', () => {
    const u = wv.getURL() || ''
    if (u.includes('ghost-browser')) {
      const js = gbControlJs.replace('__DEVICE_ID__', G.deviceId).replace('__DEVICE_NAME__', String(G.deviceName || 'GB Desktop').replace(/["\\]/g, ''))
      wv.executeJavaScript(js, false)
    }
  })
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'ctl') onCtl(e.args[0], e.args[1])
    else if (e.channel === 'cmd') runCommand(e.args[0], e.args[1], e.args[2])
  })
  hidden.appendChild(wv); controlWv = wv; logSinkOn = true
}
function disconnect() { logSinkOn = false; if (controlWv) { try { controlWv.remove() } catch (e) {} } controlWv = null; setStatus('Cluster: off'); $('cl-connect').textContent = 'Connect to cluster' }
function onCtl(tag, data) {
  if (tag === 'registered') { setStatus('Cluster: ON — registered as ' + (G.deviceName || 'GB Desktop') + '\nwaiting for commands'); $('cl-connect').textContent = 'Disconnect'; log('● registered with the cluster — waiting for commands') }
  else if (tag === 'regfail') log('! register failed: ' + data)
  else if (tag === 'pollerr') log('… poll: ' + data)
}
function setStatus(s) { $('status').textContent = s }

async function runCommand(id, path, bodyStr) {
  const t = tabs[active]; const wv = ensureWv(t)
  let body = {}; try { body = JSON.parse(bodyStr || '{}') } catch (e) {}
  let out = '{}'
  try {
    if (path === '/v1/navigate') { const u = await nav(wv, body.url || ''); out = JSON.stringify({ url: u }) }
    else if (path === '/v1/analyze') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.mark())')) || '[]'
    else if (path === '/v1/info') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.info())')) || '{}'
    else if (path === '/v1/content') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.text())')) || '""'
    else if (path === '/v1/click') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.click(' + (body.index != null ? body.index : -1) + '))')) || '{}'
    else if (path === '/v1/type') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.type(' + (body.index != null ? body.index : -1) + ',' + JSON.stringify(body.text || '') + '))')) || '{}'
    else if (path === '/v1/scroll') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.scroll(' + (body.dy != null ? body.dy : 600) + '))')) || '{}'
    else if (path === '/v1/screenshot') { try { const img = await wv.capturePage(); out = JSON.stringify({ png_base64: img.toDataURL().split(',')[1] }) } catch (e) { out = JSON.stringify({ error: String(e) }) } }
    else if (path === '/v1/fetch') out = await deviceFetch(wv, body)
    else if (path === '/v1/eval') {
      const code = body.code || 'null'
      out = (await ex(wv, '(async()=>{try{var __r=await eval(' + JSON.stringify(code) + ');return typeof __r==="string"?__r:JSON.stringify(__r)}catch(e){return JSON.stringify({__evalError:String(e)})}})()')) || 'null'
    }
    else out = JSON.stringify({ error: 'unknown path' })
  } catch (e) { out = JSON.stringify({ error: String(e) }) }
  log('↺ ran ' + path)
  if (controlWv) { try { controlWv.executeJavaScript('window.__gbResult(' + JSON.stringify(id) + ',200,' + JSON.stringify(out) + ')', false) } catch (e) {} }
}
async function deviceFetch(wv, body) {
  const url = body.url || ''; if (!url) return JSON.stringify({ error: 'no url' })
  const method = (body.method || 'GET').toUpperCase()
  const headers = Object.assign({ 'Content-Type': body.contentType || 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body.headers || {})
  const opts = { method, credentials: 'include', headers }
  if (body.body !== undefined && method !== 'GET' && method !== 'HEAD') opts.body = (typeof body.body === 'string') ? body.body : JSON.stringify(body.body)
  const off = body.offset || 0, max = body.maxLen || 900000
  const code = '(async()=>{try{const r=await fetch(' + JSON.stringify(url) + ',' + JSON.stringify(opts) + ');const t=await r.text();return JSON.stringify({status:r.status,body:String(t).slice(' + off + ',' + (off + max) + ')})}catch(e){return JSON.stringify({status:0,body:String(e)})}})()'
  return (await ex(wv, code)) || JSON.stringify({ error: 'fetch failed' })
}

// ---------- API channel (platforms / flows) ----------
let apiWv = null, apiReady = null
function ensureApi() {
  if (apiWv) return apiReady
  clusterUrl = $('cl-url').value.trim() || clusterUrl
  const wv = mkWebview(currentProfile, clusterUrl)
  apiReady = new Promise((res) => { wv.addEventListener('did-stop-loading', function h() { wv.removeEventListener('did-stop-loading', h); res() }) })
  hidden.appendChild(wv); apiWv = wv; return apiReady
}
async function api(method, path, bodyStr) {
  ensureApi(); await apiReady
  const opts = { method, credentials: 'include', headers: { 'Content-Type': 'application/json' } }
  if (bodyStr) opts.body = bodyStr
  const code = '(async()=>{try{const r=await fetch(' + JSON.stringify(path) + ',' + JSON.stringify(opts) + ');return JSON.stringify({status:r.status,body:await r.text()})}catch(e){return JSON.stringify({status:0,body:String(e)})}})()'
  const res = await ex(apiWv, code)
  try { return JSON.parse(res) } catch (e) { return { status: 0, body: '' } }
}

// ---------- profiles ----------
function renderChips() {
  const c = $('pf-chips'); c.innerHTML = ''
  profiles.forEach((p) => { const b = document.createElement('button'); b.className = 'chip' + (p === currentProfile ? ' on' : ''); b.textContent = p; b.onclick = () => { currentProfile = p; LS.set('profile', p); renderChips(); newTab(HOME) }; c.appendChild(b) })
}
function addProfile() {
  const n = $('pf-new').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''); if (!n) return
  if (!profiles.includes(n)) { profiles.push(n); LS.set('profiles', JSON.stringify(profiles)) }
  $('pf-new').value = ''; currentProfile = n; LS.set('profile', n); renderChips(); newTab(HOME)
}
async function loadPlatforms() {
  $('pf-hint').textContent = 'loading…'
  const r = await api('GET', '/v1/profiles/presets', null)
  try { const arr = JSON.parse(r.body).presets || []; LS.set('platformsCache', r.body); renderPlatforms(arr); log('↓ your platforms (' + arr.length + ')') }
  catch (e) { $('pf-hint').textContent = 'sign in on the Cluster tab first'; log('! platforms: ' + (r.body || '').slice(0, 80)) }
}
function renderPlatforms(arr) {
  const c = $('pf-cards'); c.innerHTML = ''
  if (!arr.length) { $('pf-hint').textContent = 'no platforms yet'; return }
  $('pf-hint').textContent = arr.length + ' platforms — click to open & sign in'
  arr.forEach((p) => {
    const key = p.key || ''; if (!key || !p.site) return
    const prof = 'p_' + key.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const row = document.createElement('div'); row.className = 'card'
    row.innerHTML = '<div class="col"><div class="t"></div><div class="s"></div></div>'
    row.querySelector('.t').textContent = p.label || key
    row.querySelector('.s').textContent = hostOf(p.site) + (profiles.includes(prof) ? '  ·  profile ready' : '  ·  not opened yet')
    const b = document.createElement('button'); b.className = 'btn out'; b.textContent = 'Open & sign in'; b.onclick = () => openPlatform(prof, p.site)
    row.appendChild(b)
    c.appendChild(row)
  })
}
function openPlatform(prof, site) {
  if (!profiles.includes(prof)) { profiles.push(prof); LS.set('profiles', JSON.stringify(profiles)); renderChips() }
  currentProfile = prof; LS.set('profile', prof)
  const host = hostOf(site)
  const idx = tabs.findIndex((t) => t.profile === prof && hostOf(t.url) === host)
  if (idx >= 0) activateTab(idx); else newTab(site)
  hideSheet(); log('→ opened "' + prof + '" — sign in once here; the session stays in this profile')
}

// ---------- flows ----------
let rolesLoaded = false
async function ensureRoles() {
  if (rolesLoaded) return
  const r = await api('GET', '/v1/agent/roles', null)
  try {
    const arr = JSON.parse(r.body).roles || []
    const sel = $('fl-role')
    arr.forEach((role) => { const o = document.createElement('option'); o.value = role.name; o.textContent = role.name; sel.appendChild(o) })
    rolesLoaded = true
  } catch (e) { /* role picker stays on "default" — not fatal */ }
}
async function loadFlows() {
  $('fl-hint').textContent = 'loading…'
  ensureRoles()
  const r = await api('GET', '/v1/workflows', null)
  try { const arr = JSON.parse(r.body).workflows || []; LS.set('flowsCache', r.body); renderFlows(arr); log('↓ automations (' + arr.length + ')') }
  catch (e) { $('fl-hint').textContent = 'sign in on the Cluster tab first'; log('! flows: ' + (r.body || '').slice(0, 80)) }
}
function renderFlows(arr) {
  const c = $('fl-cards'); c.innerHTML = ''
  if (!arr.length) { $('fl-hint').textContent = 'no automations yet — build one below'; return }
  $('fl-hint').textContent = arr.length + ' automations — Run to fire one'
  arr.forEach((w) => {
    if (!w.id) return
    const steps = (w.nodes && w.nodes.length) || 0
    const proof = w.verifiedEver ? (w.lastVerified ? ' · ✓ verified' : ' · was verified, last run didn\'t confirm') : ''
    const row = document.createElement('div'); row.className = 'card'
    row.innerHTML = '<div class="col"><div class="t"></div><div class="s"></div></div>'
    row.querySelector('.t').textContent = w.name || w.id
    row.querySelector('.s').textContent = steps + ' steps · ' + (w.runs ? w.runs + ' runs, last ' + (w.lastRunStatus || '?') : 'never run') + proof
    const hist = document.createElement('button'); hist.className = 'btn out'; hist.textContent = 'History'; hist.onclick = () => showHistory(w.id, w.name || w.id)
    const b = document.createElement('button'); b.className = 'btn out'; b.textContent = 'Run'; b.onclick = () => runFlow(w.id, w.name || w.id)
    row.appendChild(hist); row.appendChild(b)
    c.appendChild(row)
  })
}
async function showHistory(id, name) {
  const r = await api('GET', '/v1/workflows/' + id + '/runs', null)
  try {
    const runs = JSON.parse(r.body).runs || []
    if (!runs.length) { log('· "' + name + '" has no runs yet'); return }
    log('· "' + name + '" — last ' + Math.min(runs.length, 5) + ' run(s):')
    runs.slice(0, 5).forEach((run) => log('   ' + (run.started_at || '').replace('T', ' ').slice(0, 16) + '  ' + (run.status || '?') + '  ' + runOutcomeText(run)))
  } catch (e) { log('! history: ' + (r.body || '').slice(0, 100)) }
}
function runOutcomeText(run) {
  const steps = Array.isArray(run.steps) ? run.steps : []
  if (steps.some((s) => s && s.status === 'error')) return '· a step errored'
  const verifies = steps.filter((s) => s && s.type === 'verify')
  if (verifies.length) return verifies.every((s) => s.output && s.output.found) ? '· verified ✓' : '· could not confirm'
  return ''
}
/** Fire the run, then POLL its status so "Run" closes the loop instead of firing blind — the same
 *  outcome semantics (done/error, verified/unconfirmed) the console itself uses. */
async function runFlow(id, name) {
  log('▶ running "' + name + '"…')
  const r = await api('POST', '/v1/workflows/' + id + '/run', '{}')
  let runId = null
  try { const o = JSON.parse(r.body); runId = o.runId; log('● run ' + runId + ' — ' + (o.status || 'running')) } catch (e) { log('! run: ' + (r.body || '').slice(0, 120)); return }
  if (!runId) return
  for (let i = 0; i < 40; i++) {
    await sleep(2500)
    const rr = await api('GET', '/v1/workflow-runs/' + runId, null)
    let run; try { run = JSON.parse(rr.body) } catch (e) { continue }
    if (!run || run.error) continue
    if (run.status && run.status !== 'running') {
      const outcome = runOutcomeText(run)
      log((run.status === 'error' ? '✗' : '✓') + ' "' + name + '" ' + run.status + (outcome ? ' ' + outcome : ''))
      loadFlows()
      return
    }
  }
  log('· "' + name + '" still running — check History later')
}
async function createFlow() {
  const name = $('fl-name').value.trim()
  const role = $('fl-role').value
  const steps = $('fl-steps').value.split('\n').map((s) => s.trim()).filter(Boolean)
  if (name.length < 3) { log('! give the automation a name (3+ chars)'); return }
  if (!steps.length) { log('! add at least one step (one goal per line)'); return }
  const nodes = [{ id: 'trigger', type: 'trigger', label: 'Manual' }], edges = []
  let prev = 'trigger'
  steps.forEach((g, i) => { const nid = 'n' + i; const node = { id: nid, type: 'agent', label: 'Step ' + (i + 1), goal: g }; if (role) node.role = role; nodes.push(node); edges.push({ from: prev, to: nid }); prev = nid })
  log('↑ creating "' + name + '" (' + steps.length + ' steps)…')
  const r = await api('POST', '/v1/workflows', JSON.stringify({ name, trigger: { type: 'manual' }, nodes, edges }))
  try { const o = JSON.parse(r.body); if (o.error) log('! create: ' + o.error); else { log('✓ created: ' + (o.name || o.id)); $('fl-name').value = ''; $('fl-steps').value = ''; loadFlows() } }
  catch (e) { log('! create: ' + (r.body || '').slice(0, 120)) }
}

// ---------- agent (Ollama / OpenAI-compatible) ----------
let agentStop = false, agentRunning = false
async function runAgent() {
  if (agentRunning) return
  const endpoint = $('ag-endpoint').value.trim(), key = $('ag-key').value, model = $('ag-model').value.trim() || 'qwen2.5', goal = $('ag-task').value.trim()
  LS.set('ag-endpoint', endpoint); LS.set('ag-model', model)
  if (!endpoint) { log('! set an Ollama endpoint (e.g. http://localhost:11434/v1)'); return }
  if (!goal) { log('! enter a task first'); return }
  agentStop = false; agentRunning = true; log('▶ goal: ' + goal)
  const sys = 'You are GB, an autonomous agent operating a real web browser. Each turn you get the current page and a numbered list of its interactive elements. Reply with EXACTLY ONE action as compact JSON and NOTHING else. Valid actions: {"action":"click","index":N,"reason":".."} | {"action":"type","index":N,"text":"..","reason":".."} | {"action":"navigate","url":"https://..","reason":".."} | {"action":"scroll","dy":600,"reason":".."} | {"action":"done","reason":".."}. If the current URL/TITLE already satisfies the GOAL, reply done. Never navigate to a page you are already on. A navigate url must be ONE plain https URL.'
  const wv = ensureWv(tabs[active]); const visited = {}; let garbage = 0
  for (let step = 1; step <= 20 && !agentStop; step++) {
    await sleep(900)
    const infoO = JSON.parse((await ex(wv, gbJs + '\nJSON.stringify(window.__gb.info())')) || '{}')
    const marks = JSON.parse((await ex(wv, gbJs + '\nJSON.stringify(window.__gb.mark())')) || '[]')
    const text = (JSON.parse((await ex(wv, gbJs + '\nJSON.stringify(window.__gb.text())')) || '""') || '').slice(0, 1200)
    let els = ''; marks.slice(0, 60).forEach((o) => { els += o.i + ': ' + o.tag + (o.type ? '[' + o.type + ']' : '') + (o.text ? ' "' + o.text + '"' : '') + '\n' })
    const user = 'GOAL: ' + goal + '\nURL: ' + (infoO.url || '') + '\nTITLE: ' + (infoO.title || '') + '\nPAGE TEXT:\n' + text + '\n\nELEMENTS:\n' + els + '\nReply with ONE JSON action.'
    log('· step ' + step + ' — thinking…')
    const resp = await G.llm({ endpoint, key, model, system: sys, user })
    if (!resp.ok) { log('! llm: ' + resp.error); break }
    const act = extractJson(resp.text)
    if (!act) { log('! parse: ' + (resp.text || '').slice(0, 100)); if (++garbage >= 3) { log('■ stopped — unusable output'); break } continue }
    const a = act.action, reason = act.reason || ''
    if (a === 'done') { log('✓ done — ' + reason); break }
    else if (a === 'navigate') {
      const u = (act.url || '').trim()
      if (!/^https?:\/\//.test(u) || /[ +"]|document\.|encodeURI/.test(u)) { log('! ignored malformed url'); if (++garbage >= 3) break; continue }
      const n = normU(u)
      if (n === normU(infoO.url || '')) { const c = (visited[n] || 0) + 1; visited[n] = c; log('· already there'); if (c >= 3) { log('■ stopped — stuck'); break } continue }
      const c = (visited[n] || 0) + 1; visited[n] = c; if (c >= 3) { log('■ stopped — revisiting loop'); break }
      garbage = 0; log('→ navigate ' + u + ' (' + reason + ')'); await nav(wv, u)
    }
    else if (a === 'click') { garbage = 0; log('→ click ' + act.index + ' (' + reason + ')'); await ex(wv, gbJs + '\nwindow.__gb.click(' + (act.index != null ? act.index : -1) + ')') }
    else if (a === 'type') { garbage = 0; log('→ type ' + act.index + ' (' + reason + ')'); await ex(wv, gbJs + '\nwindow.__gb.type(' + (act.index != null ? act.index : -1) + ',' + JSON.stringify(act.text || '') + ')') }
    else if (a === 'scroll') { garbage = 0; log('→ scroll ' + (act.dy || 600)); await ex(wv, gbJs + '\nwindow.__gb.scroll(' + (act.dy != null ? act.dy : 600) + ')') }
    else log('! unknown action: ' + a)
  }
  agentRunning = false; log('— agent finished —')
}

// ---------- sheet / menu ----------
function toggleSheet() { $('sheet').classList.toggle('hidden') }
function hideSheet() { $('sheet').classList.add('hidden') }
function selectPane(p) {
  document.querySelectorAll('.tb').forEach((b) => b.classList.toggle('on', b.dataset.p === p))
  document.querySelectorAll('.pane').forEach((el) => el.classList.toggle('on', el.id === 'pane-' + p))
}

// ---------- wire ----------
function wire() {
  $('home').onclick = () => go(HOME)
  $('back').onclick = () => { const wv = tabs[active] && tabs[active].wv; if (wv && wv.canGoBack()) wv.goBack() }
  $('newtab').onclick = () => newTab(HOME)
  $('tabcount').onclick = () => openSwitch()
  $('menubtn').onclick = (e) => { e.stopPropagation(); $('menu').classList.toggle('hidden') }
  document.body.addEventListener('click', () => $('menu').classList.add('hidden'))
  $('menu').addEventListener('click', (e) => {
    const a = e.target.dataset && e.target.dataset.a; if (!a) return
    $('menu').classList.add('hidden')
    if (a === 'tools') toggleSheet()
    else if (a === 'newtab') newTab(HOME)
    else if (a === 'reload') { const wv = tabs[active] && tabs[active].wv; if (wv) wv.reload() }
    else if (a === 'close') closeTab(active)
  })
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') go($('url').value) })
  $('sw-new').onclick = () => { newTab(HOME); hideSwitch() }
  $('sw-close').onclick = () => hideSwitch()
  document.querySelectorAll('.tb').forEach((b) => { b.onclick = () => selectPane(b.dataset.p) })
  // agent
  $('ag-endpoint').value = LS.get('ag-endpoint', ''); $('ag-model').value = LS.get('ag-model', '')
  $('ag-run').onclick = runAgent
  $('ag-stop').onclick = () => { agentStop = true; log('… stopping') }
  // profiles
  $('pf-load').onclick = loadPlatforms
  $('pf-add').onclick = addProfile
  // flows
  $('fl-load').onclick = loadFlows
  $('fl-create').onclick = createFlow
  // cluster
  $('cl-url').value = clusterUrl
  $('cl-connect').onclick = connect
  $('cl-signin').onclick = () => { clusterUrl = $('cl-url').value.trim() || clusterUrl; LS.set('clusterUrl', clusterUrl); const platform = clusterUrl.includes('://ghost-browser.') ? clusterUrl.replace('://ghost-browser.', '://') : 'https://my-app.engineer'; go(platform); log('→ log in, open Ghost Browser from Tools, then Fetch') }
  $('cl-fetch').onclick = () => { loadPlatforms(); loadFlows() }
  $('cl-tailscale').onclick = () => go('https://tailscale.com/download/windows')
  // cached lists
  try { const pc = LS.get('platformsCache', ''); if (pc) renderPlatforms(JSON.parse(pc).presets || []) } catch (e) {}
  try { const fc = LS.get('flowsCache', ''); if (fc) renderFlows(JSON.parse(fc).workflows || []) } catch (e) {}
}

restoreTabs(); renderChips(); wire(); activateTab(active); updateCount()
log('Ghost Browser Desktop ready · device ' + (G.deviceName || '') + ' · ' + G.deviceId.slice(0, 8))
