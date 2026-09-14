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
// Wait until the page has real content (not a lazy-load skeleton), or maxMs elapses.
async function waitSettle(wv, maxMs) {
  const end = Date.now() + (maxMs || 6000)
  while (Date.now() < end) { const r = await ex(wv, gbJs + '\nwindow.__gb.ready()'); if (r === true || r === 'true') { await sleep(200); return } await sleep(300) }
}

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
  LS.set('clusterAuto', '1') // remember we want to be a node, so the next launch reconnects on its own
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
function disconnect() { logSinkOn = false; LS.set('clusterAuto', '0'); if (controlWv) { try { controlWv.remove() } catch (e) {} } controlWv = null; setStatus('Cluster: off'); $('cl-connect').textContent = 'Connect to cluster' }
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
    if (path === '/v1/navigate') { const u = await nav(wv, body.url || ''); await waitSettle(wv, 6000); out = JSON.stringify({ url: u }) }
    else if (path === '/v1/analyze') { await waitSettle(wv, 4000); out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.mark())')) || '[]' }
    else if (path === '/v1/info') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.info())')) || '{}'
    else if (path === '/v1/content') { await waitSettle(wv, 4000); out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.text())')) || '""' }
    else if (path === '/v1/posts') { await waitSettle(wv, 5000); out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.posts())')) || '[]' }
    else if (path === '/v1/perceive') { await waitSettle(wv, 6000); out = '{"info":' + ((await ex(wv, gbJs + '\nJSON.stringify(window.__gb.info())')) || '{}') + ',"elements":' + ((await ex(wv, gbJs + '\nJSON.stringify(window.__gb.mark())')) || '[]') + ',"posts":' + ((await ex(wv, gbJs + '\nJSON.stringify(window.__gb.posts())')) || '[]') + '}' }
    else if (path === '/v1/click_text') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.clickText(' + JSON.stringify(body.text || '') + ',' + (body.nth || 0) + '))')) || '{}'
    else if (path === '/v1/click') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.click(' + (body.index != null ? body.index : -1) + '))')) || '{}'
    else if (path === '/v1/type') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.type(' + (body.index != null ? body.index : -1) + ',' + JSON.stringify(body.text || '') + '))')) || '{}'
    else if (path === '/v1/scroll') out = (await ex(wv, gbJs + '\nJSON.stringify(window.__gb.scroll(' + (body.dy != null ? body.dy : 600) + '))')) || '{}'
    else if (path === '/v1/screenshot') { try { const img = await wv.capturePage(); out = JSON.stringify({ png_base64: img.toDataURL().split(',')[1] }) } catch (e) { out = JSON.stringify({ error: String(e) }) } }
    else if (path === '/v1/fetch') out = await deviceFetch(wv, body)
    else if (path === '/v1/eval') {
      // Embed the code as an expression (NOT eval()) so a page CSP (Facebook) can't block it.
      const code = body.code || 'null'
      out = (await ex(wv, '(async()=>{try{var __r=await (' + code + ');return typeof __r==="string"?__r:JSON.stringify(__r)}catch(e){return JSON.stringify({__evalError:String(e)})}})()')) || 'null'
    }
    else if (path === '/v1/upload_file') {
      // Import a LOCAL file (on this device) into a page's file input — no native dialog. For CapCut etc.
      const files = body.paths || (body.path ? [body.path] : [])
      out = JSON.stringify(await G.uploadFile(wv.getWebContentsId(), body.selector || 'input[type=file]', files, body.nth || 0))
    }
    else if (path === '/v1/drag') {
      // Real OS-level drag INTO the guest — synthetic events don't move a canvas/timeline (CapCut). Coords
      // are guest-viewport pixels. sendInputEvent delivers genuine mouse events the app can't tell from a human.
      const steps = Math.max(2, body.steps || 24), fx = body.fromX | 0, fy = body.fromY | 0, tx = body.toX | 0, ty = body.toY | 0
      wv.sendInputEvent({ type: 'mouseMove', x: fx, y: fy })
      wv.sendInputEvent({ type: 'mouseDown', x: fx, y: fy, button: 'left', clickCount: 1 })
      for (let i = 1; i <= steps; i++) { wv.sendInputEvent({ type: 'mouseMove', x: Math.round(fx + (tx - fx) * i / steps), y: Math.round(fy + (ty - fy) * i / steps), button: 'left' }); await sleep(16) }
      await sleep(90)
      wv.sendInputEvent({ type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 })
      out = JSON.stringify({ ok: true, from: [fx, fy], to: [tx, ty] })
    }
    else if (path === '/v1/click_xy') {
      const x = body.x | 0, y = body.y | 0, cc = body.clickCount || 1
      wv.sendInputEvent({ type: 'mouseMove', x, y })
      wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: cc })
      wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: cc })
      out = JSON.stringify({ ok: true, x, y })
    }
    else if (path === '/v1/host') {
      // Host-app control so the cluster can fix the driving surface itself (close the settings sheet that
      // squeezes the webview, force a full viewport) without anyone touching the laptop.
      if (body.action === 'hideSheet') { try { hideSheet() } catch (e) {} out = JSON.stringify({ ok: true, sheet: 'hidden' }) }
      else if (body.action === 'maximize') { out = JSON.stringify(await G.winCmd('maximize')) }
      else out = JSON.stringify({ error: 'unknown host action' })
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
  profiles.forEach((p) => { const b = document.createElement('button'); b.className = 'chip' + (p === currentProfile ? ' on' : ''); b.textContent = p; b.onclick = () => { currentProfile = p; LS.set('profile', p); renderChips(); renderRoleSelect(); newTab(HOME) }; c.appendChild(b) })
}
// ---------- roles per profile (like the platform GB) ----------
function rolesArr() { try { return JSON.parse(LS.get('rolesCache', '{}')).roles || [] } catch (e) { return [] } }
function profileRoles() { try { return JSON.parse(LS.get('profileRoles', '{}')) } catch (e) { return {} } }
function roleForProfile(p) { return profileRoles()[p] || '' }
function setRoleForProfile(p, name) { const m = profileRoles(); if (!name) delete m[p]; else m[p] = name; LS.set('profileRoles', JSON.stringify(m)) }
function roleDescription(name) { const r = rolesArr().find((x) => x.name === name); return r ? (r.description || '') : '' }
function renderRoleSelect() {
  const sel = $('pf-role'); if (!sel) return
  const cur = roleForProfile(currentProfile)
  sel.innerHTML = '<option value="">(none)</option>' + rolesArr().map((r) => '<option value="' + r.name + '"' + (r.name === cur ? ' selected' : '') + '>' + r.name + '</option>').join('')
  $('pf-rolenote').textContent = cur ? (roleDescription(cur) || ('Role: ' + cur)) : 'The agent adopts this role’s behaviour when it works on this profile — like the platform’s agent roles.'
}
async function loadRoles() {
  $('pf-rolenote').textContent = 'loading roles…'
  const r = await api('GET', '/v1/agent/roles', null)
  try { const d = JSON.parse(r.body); LS.set('rolesCache', JSON.stringify({ roles: d.roles || [] })); renderRoleSelect(); log('↓ agent roles (' + (d.roles || []).length + ')') }
  catch (e) { $('pf-rolenote').textContent = 'sign in on the Cluster tab first'; log('! roles: ' + (r.body || '').slice(0, 80)) }
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
  currentProfile = prof; LS.set('profile', prof); renderRoleSelect()
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

// ---------- conversational agent (JSON tool protocol, model-agnostic) ----------
function agCfg() { return { endpoint: ($('ag-endpoint').value || '').trim(), key: $('ag-key').value || '', model: ($('ag-model').value || '').trim() || 'qwen2.5' } }
async function apiJson(method, path, body) { const r = await api(method, path, body); try { return JSON.parse(r.body) } catch (e) { return { _status: r.status, _raw: (r.body || '').slice(0, 1500) } } }
function activeWv() { return ensureWv(tabs[active]) }

// The agent's tools = everything the operator can do: drive the browser + the whole GB API.
const TOOLS = {
  browser_read: { desc: 'Read the active browser tab: {url,title,elements:[{i,tag,text,label,href}],text}. Waits for content to load. Use before click/type.', run: async () => {
    const wv = activeWv(); await waitSettle(wv, 5000)
    const info = JSON.parse((await ex(wv, gbJs + '\nJSON.stringify(window.__gb.info())')) || '{}')
    const marks = JSON.parse((await ex(wv, gbJs + '\nJSON.stringify(window.__gb.mark())')) || '[]')
    const text = (JSON.parse((await ex(wv, gbJs + '\nJSON.stringify(window.__gb.text())')) || '""') || '').slice(0, 1500)
    return { url: info.url, title: info.title, elements: marks.slice(0, 60).map((o) => { const e = { i: o.i, tag: o.tag, text: o.text, x: o.x, y: o.y, w: o.w, h: o.h }; if (o.type) e.type = o.type; if (o.label && o.label !== o.text) e.label = o.label; if (o.role) e.role = o.role; if (o.href) e.href = o.href; return e }), text }
  } },
  browser_navigate: { desc: 'Open a URL in the active tab (waits for load). args:{url}', run: async (a) => { const wv = activeWv(); await nav(wv, absUrl(a.url || '')); await waitSettle(wv, 6000); return { url: wv.getURL() } } },
  browser_click: { desc: 'Click element i from browser_read. args:{index}', run: async (a) => ({ ok: await ex(activeWv(), gbJs + '\nJSON.stringify(window.__gb.click(' + (a.index != null ? a.index : -1) + '))') }) },
  browser_click_text: { desc: 'Click the element whose text/label contains the string — use on sites without links (Facebook rows/buttons). args:{text,nth}', run: async (a) => ({ ok: await ex(activeWv(), gbJs + '\nJSON.stringify(window.__gb.clickText(' + JSON.stringify(a.text || '') + ',' + (a.nth || 0) + '))') }) },
  browser_posts: { desc: 'Read the post-like text blocks of a feed (Facebook groups etc.) — use this to READ a social feed (feed text is not in page-text). No args.', run: async () => { const wv = activeWv(); await waitSettle(wv, 5000); const r = await ex(wv, gbJs + '\nJSON.stringify(window.__gb.posts())'); try { return JSON.parse(r) } catch (e) { return { raw: r } } } },
  browser_type: { desc: 'Type into element i. args:{index,text}', run: async (a) => ({ ok: await ex(activeWv(), gbJs + '\nJSON.stringify(window.__gb.type(' + (a.index != null ? a.index : -1) + ',' + JSON.stringify(a.text || '') + '))') }) },
  browser_scroll: { desc: 'Scroll the page. args:{dy}', run: async (a) => ({ ok: await ex(activeWv(), gbJs + '\nwindow.__gb.scroll(' + (a.dy != null ? a.dy : 600) + ')') }) },
  // ---- primitives for heavy web apps (CapCut editor etc.) ----
  upload_file: { desc: 'Import a LOCAL file on this device into a page file-input WITHOUT a dialog (e.g. add media in CapCut). args:{path, selector?, nth?}. After importing, CLICK the item in the media list to add it to the timeline — no drag needed.', run: async (a) => await G.uploadFile(activeWv().getWebContentsId(), a.selector || 'input[type=file]', a.paths || (a.path ? [a.path] : []), a.nth || 0) },
  click_xy: { desc: 'Click at exact pixel x,y from browser_read (each element has x,y,w,h). Use for canvas/timeline spots that have no clickable index — e.g. click a precise position on the timeline ruler to move the playhead. args:{x,y,clickCount?}', run: async (a) => { const wv = activeWv(); const x = a.x | 0, y = a.y | 0, cc = a.clickCount || 1; wv.sendInputEvent({ type: 'mouseMove', x, y }); wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: cc }); wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: cc }); return { ok: true, x, y } } },
  drag_xy: { desc: 'Drag with real mouse events from (fromX,fromY) to (toX,toY). Use ONLY when a click/field cannot do it — reordering or trimming a timeline clip. Prefer clicking to add and precise click/number-field for timing. args:{fromX,fromY,toX,toY,steps?}', run: async (a) => { const wv = activeWv(); const s = Math.max(2, a.steps || 24), fx = a.fromX | 0, fy = a.fromY | 0, tx = a.toX | 0, ty = a.toY | 0; wv.sendInputEvent({ type: 'mouseMove', x: fx, y: fy }); wv.sendInputEvent({ type: 'mouseDown', x: fx, y: fy, button: 'left', clickCount: 1 }); for (let i = 1; i <= s; i++) { wv.sendInputEvent({ type: 'mouseMove', x: Math.round(fx + (tx - fx) * i / s), y: Math.round(fy + (ty - fy) * i / s), button: 'left' }); await sleep(16) } await sleep(90); wv.sendInputEvent({ type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 }); return { ok: true } } },
  open_tab: { desc: 'Open a new browser tab. args:{url}', run: async (a) => { newTab(absUrl(a.url || HOME)); return { ok: true } } },
  fetch_url: { desc: 'Authenticated same-origin fetch from the active tab. args:{url,method,body,headers}', run: async (a) => {
    const out = await deviceFetch(activeWv(), a); try { return JSON.parse(out) } catch (e) { return { raw: (out || '').slice(0, 1500) } }
  } },
  list_workflows: { desc: 'List automations with run counts + verified flags.', run: async () => {
    const d = await apiJson('GET', '/v1/workflows', null)
    return (d.workflows || []).map((w) => ({ id: w.id, name: w.name, steps: (w.nodes || []).length, runs: w.runs, verifiedEver: w.verifiedEver, lastRunStatus: w.lastRunStatus }))
  } },
  create_workflow: { desc: 'Create an automation. args:{name, steps:[goal strings], role?}. Builds trigger->agent steps.', run: async (a) => {
    const steps = Array.isArray(a.steps) ? a.steps : String(a.steps || '').split('\n').map((s) => s.trim()).filter(Boolean)
    if (!a.name || steps.length === 0) return { error: 'need name + steps[]' }
    const nodes = [{ id: 'trigger', type: 'trigger', label: 'Manual' }], edges = []; let prev = 'trigger'
    steps.forEach((g, i) => { const nid = 'n' + i; const n = { id: nid, type: 'agent', label: 'Step ' + (i + 1), goal: g }; if (a.role) n.role = a.role; nodes.push(n); edges.push({ from: prev, to: nid }); prev = nid })
    return await apiJson('POST', '/v1/workflows', JSON.stringify({ name: a.name, trigger: { type: 'manual' }, nodes, edges }))
  } },
  run_workflow: { desc: 'Run an automation and wait for its outcome. args:{id}', run: async (a) => {
    const started = await apiJson('POST', '/v1/workflows/' + a.id + '/run', '{}')
    const runId = started.runId; if (!runId) return started
    for (let i = 0; i < 24; i++) { await sleep(2500); const run = await apiJson('GET', '/v1/workflow-runs/' + runId, null); if (run && run.status && run.status !== 'running') return { runId, status: run.status, outcome: runOutcomeText(run) } }
    return { runId, status: 'running', note: 'still running; check get_run later' }
  } },
  get_run: { desc: 'Get a run’s status/outcome. args:{runId}', run: async (a) => { const run = await apiJson('GET', '/v1/workflow-runs/' + a.runId, null); return { status: run.status, outcome: runOutcomeText(run) } } },
  workflow_runs: { desc: 'Recent runs of an automation. args:{id}', run: async (a) => { const d = await apiJson('GET', '/v1/workflows/' + a.id + '/runs', null); return (d.runs || []).slice(0, 6).map((r) => ({ started: r.started_at, status: r.status, outcome: runOutcomeText(r) })) } },
  list_profiles: { desc: 'List browser profiles (identities).', run: async () => { const d = await apiJson('GET', '/v1/profiles', null); return d.profiles || d } },
  list_platforms: { desc: 'List the platform registry / your platforms.', run: async () => { const d = await apiJson('GET', '/v1/profiles/presets', null); return (d.presets || []).map((p) => ({ key: p.key, label: p.label, site: p.site, loggedIn: p.exists })) } },
  list_roles: { desc: 'List agent roles usable in automation steps.', run: async () => { const d = await apiJson('GET', '/v1/agent/roles', null); return (d.roles || []).map((r) => r.name) } },
  list_devices: { desc: 'List connected device nodes (phone/laptop) in the cluster.', run: async () => { const d = await apiJson('GET', '/v1/device/list', null); return (d.devices || []).map((x) => ({ id: x.deviceId, name: x.name, online: x.online })) } },
  device_command: { desc: 'Drive another node. args:{deviceId, path:/v1/navigate|/v1/info|/v1/analyze|/v1/fetch|..., body}', run: async (a) => await apiJson('POST', '/v1/device/' + a.deviceId + '/command', JSON.stringify({ path: a.path || '/v1/info', body: a.body || {} })) },
}
function agentSystemPrompt() {
  const tools = Object.keys(TOOLS).map((n) => '- ' + n + ': ' + TOOLS[n].desc).join('\n')
  return 'You are the Ghost Browser agent — a helpful assistant that can hold a normal conversation AND take real actions ' +
    'by calling tools (drive a real browser, and list/create/run automations, inspect profiles/platforms, and command other ' +
    'device nodes). Each turn reply with EXACTLY ONE compact JSON object and nothing else:\n' +
    '  {"reply":"text to the user"}   — to talk, answer, or report what you did\n' +
    '  {"tool":"<name>","args":{...}} — to take an action; you then get {"tool_result":...} and continue\n' +
    'Chain tools as needed (e.g. list_workflows then run_workflow). When the task is done or you need the user, use reply. ' +
    'Be concise and concrete. Never invent tool results. Available tools:\n' + tools
}

// chat state
let chats = []; let chat = null; let agentBusy = false
function loadChats() { try { chats = JSON.parse(LS.get('agentChats', '[]')) || [] } catch (e) { chats = [] } }
function saveChats() { LS.set('agentChats', JSON.stringify(chats.slice(0, 50))) }
function newChat() { chat = { id: 'c' + Date.now(), title: 'New chat', messages: [], updated: Date.now() }; chats.unshift(chat); renderChatList(); renderChat(); $('ag-inp').focus() }
function loadChat(id) { const c = chats.find((x) => x.id === id); if (!c) return; chat = c; renderChatList(); renderChat() }
function deleteChat(id) { chats = chats.filter((x) => x.id !== id); saveChats(); if (chat && chat.id === id) { chat = chats[0] || null; if (!chat) newChat() } renderChatList(); renderChat() }
function pushMsg(role, content, name) { if (!chat) newChat(); chat.messages.push({ role, content, name }); if (role === 'user' && (chat.title === 'New chat' || !chat.title)) { chat.title = content.slice(0, 42); renderChatList() } chat.updated = Date.now(); saveChats() }
function renderChatList() {
  const l = $('ag-chatlist'); l.innerHTML = ''
  chats.forEach((c) => {
    const row = document.createElement('div'); row.className = 'chatrow' + (chat && c.id === chat.id ? ' on' : '')
    const t = document.createElement('div'); t.className = 'ct'; t.textContent = c.title || 'New chat'; row.appendChild(t)
    const x = document.createElement('div'); x.className = 'cx'; x.textContent = '×'; x.onclick = (e) => { e.stopPropagation(); deleteChat(c.id) }; row.appendChild(x)
    row.onclick = () => loadChat(c.id)
    l.appendChild(row)
  })
}
function renderChat() {
  const m = $('ag-msgs'); m.innerHTML = ''
  $('ag-title').textContent = (chat && chat.title) || 'New chat'
  if (!chat || !chat.messages.length) {
    const e = document.createElement('div'); e.id = 'ag-empty'
    e.innerHTML = '<h2>What can I do for you?</h2><p>I can browse for you, and build & run automations, inspect your platforms, or drive your other devices — just ask.</p><div class="suggestions"></div>'
    m.appendChild(e)
    const sg = e.querySelector('.suggestions')
    ;['List my automations', 'Open example.com and read it', 'What devices are connected?', 'Make an automation that opens example.com and verifies it, then run it'].forEach((s) => {
      const b = document.createElement('button'); b.className = 'sugg'; b.textContent = s; b.onclick = () => { $('ag-inp').value = s; sendAgent() }; sg.appendChild(b)
    })
    return
  }
  chat.messages.forEach((msg) => {
    if (msg.role === 'user') addBubble('user', msg.content)
    else if (msg.role === 'assistant') addBubble('bot', msg.content)
    else if (msg.role === 'tool') addToolChip(msg.name || 'tool', null, msg.content)
  })
  m.scrollTop = m.scrollHeight
}
function addBubble(kind, text) {
  const m = $('ag-msgs'); const row = document.createElement('div'); row.className = 'mrow ' + kind
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text; row.appendChild(b); m.appendChild(row); m.scrollTop = m.scrollHeight; return b
}
function addToolChip(name, args, result) {
  const m = $('ag-msgs'); const wrap = document.createElement('div'); wrap.className = 'toolchip'
  const inner = document.createElement('div'); inner.className = 'inner'
  inner.innerHTML = '<span class="k">⚙ ' + name + '</span><span class="d"></span>'
  const pre = document.createElement('pre'); pre.hidden = true
  inner.querySelector('.d').textContent = args ? JSON.stringify(args) : ''
  if (result != null) pre.textContent = result
  inner.onclick = () => { pre.hidden = !pre.hidden }
  wrap.appendChild(inner); wrap.appendChild(pre); m.appendChild(wrap); m.scrollTop = m.scrollHeight
  return { setResult: (r) => { pre.textContent = r } }
}
function thinking(on) {
  let t = $('ag-thinking')
  if (on) { if (!t) { t = document.createElement('div'); t.id = 'ag-thinking'; t.className = 'thinking'; t.textContent = 'Thinking…'; $('ag-msgs').appendChild(t); $('ag-msgs').scrollTop = $('ag-msgs').scrollHeight } }
  else if (t) t.remove()
}
async function sendAgent() {
  if (agentBusy) return
  const inp = $('ag-inp'); const text = inp.value.trim(); if (!text) return
  const cfg = agCfg(); LS.set('ag-endpoint', cfg.endpoint); LS.set('ag-model', cfg.model); LS.set('ag-key', cfg.key)
  if (!cfg.endpoint) { $('ag-set').click(); addBubble('bot', 'Set your model endpoint first (⚙) — e.g. http://localhost:11434/v1 for local Ollama.'); return }
  inp.value = ''; inp.style.height = 'auto'
  pushMsg('user', text); if ($('ag-empty')) renderChat(); else addBubble('user', text)
  agentBusy = true; $('ag-sendbtn').disabled = true
  try {
    const rn = roleForProfile(currentProfile)
    const sysContent = rn ? ('ROLE: you are acting as "' + rn + '" — ' + roleDescription(rn) + ' Stay within this role\'s remit.\n\n' + agentSystemPrompt()) : agentSystemPrompt()
    if (rn) log('▶ agent role: ' + rn + ' (profile ' + currentProfile + ')')
    const convo = [{ role: 'system', content: sysContent }]
    chat.messages.forEach((msg) => {
      if (msg.role === 'user') convo.push({ role: 'user', content: msg.content })
      else if (msg.role === 'assistant') convo.push({ role: 'assistant', content: msg.content })
      else if (msg.role === 'tool') convo.push({ role: 'user', content: 'TOOL RESULT (' + (msg.name || '') + '): ' + msg.content })
    })
    let toolCalls = 0
    while (toolCalls < 12) {
      thinking(true)
      const resp = await G.llm({ endpoint: cfg.endpoint, key: cfg.key, model: cfg.model, messages: convo, temperature: 0.3 })
      thinking(false)
      if (!resp.ok) { addBubble('bot', '⚠ model error: ' + resp.error); pushMsg('assistant', '⚠ model error: ' + resp.error); break }
      const obj = extractJson(resp.text)
      if (!obj || (obj.reply == null && !obj.tool)) { const t = (resp.text || '').trim() || '(no reply)'; addBubble('bot', t); pushMsg('assistant', t); break }
      if (obj.reply != null) { addBubble('bot', String(obj.reply)); pushMsg('assistant', String(obj.reply)); convo.push({ role: 'assistant', content: resp.text }); break }
      // tool call
      const name = obj.tool, args = obj.args || {}
      convo.push({ role: 'assistant', content: JSON.stringify({ tool: name, args }) })
      const chip = addToolChip(name, args, null)
      let result
      try { result = TOOLS[name] ? await TOOLS[name].run(args) : { error: 'unknown tool: ' + name } }
      catch (e) { result = { error: String(e && e.message || e) } }
      const rs = (typeof result === 'string' ? result : JSON.stringify(result))
      const trimmed = rs.length > 4000 ? rs.slice(0, 4000) + '…' : rs
      chip.setResult(trimmed); pushMsg('tool', trimmed, name)
      convo.push({ role: 'user', content: 'TOOL RESULT (' + name + '): ' + trimmed })
      toolCalls++
    }
    if (toolCalls >= 12) { addBubble('bot', '(stopped — too many steps in one turn; ask me to continue)'); pushMsg('assistant', '(stopped — too many steps)') }
  } finally { agentBusy = false; $('ag-sendbtn').disabled = false; saveChats() }
}
function openAgent() { $('agent').classList.remove('hidden'); if (!chat) { if (chats.length) loadChat(chats[0].id); else newChat() } $('ag-inp').focus() }
function closeAgent() { $('agent').classList.add('hidden') }

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
  // agent (full-screen conversational chat)
  $('ag-endpoint').value = LS.get('ag-endpoint', ''); $('ag-model').value = LS.get('ag-model', ''); $('ag-key').value = LS.get('ag-key', '')
  loadChats()
  $('agentbtn').onclick = openAgent
  $('ag-close').onclick = closeAgent
  $('ag-newchat').onclick = newChat
  $('ag-set').onclick = (e) => { e.stopPropagation(); $('ag-setbox').classList.toggle('hidden') }
  $('ag-sendbtn').onclick = sendAgent
  $('ag-inp').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgent() } })
  $('ag-inp').addEventListener('input', () => { const el = $('ag-inp'); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px' })
  // profiles
  $('pf-load').onclick = loadPlatforms
  $('pf-add').onclick = addProfile
  $('pf-loadroles').onclick = loadRoles
  $('pf-role').onchange = () => { setRoleForProfile(currentProfile, $('pf-role').value); renderRoleSelect() }
  renderRoleSelect()
  // flows
  $('fl-load').onclick = loadFlows
  $('fl-create').onclick = createFlow
  // cluster
  $('cl-url').value = clusterUrl
  $('cl-connect').onclick = connect
  $('cl-signin').onclick = () => { clusterUrl = $('cl-url').value.trim() || clusterUrl; LS.set('clusterUrl', clusterUrl); const platform = clusterUrl.includes('://ghost-browser.') ? clusterUrl.replace('://ghost-browser.', '://') : 'https://my-app.engineer'; go(platform); log('→ log in, open Ghost Browser from Tools, then Fetch') }
  $('cl-fetch').onclick = () => { loadPlatforms(); loadFlows() }
  // Device Hub: the SAME page the cluster and phone show. Opened in a tab on the cluster origin, so it
  // rides this laptop's signed-in cluster cookie (same persist:<profile> partition as the API webview).
  $('cl-hub').onclick = () => { clusterUrl = $('cl-url').value.trim() || clusterUrl; LS.set('clusterUrl', clusterUrl); newTab(clusterUrl.replace(/\/$/, '') + '/hub'); hideSheet() }
  $('cl-tailscale').onclick = () => go('https://tailscale.com/download/windows')
  // cached lists
  try { const pc = LS.get('platformsCache', ''); if (pc) renderPlatforms(JSON.parse(pc).presets || []) } catch (e) {}
  try { const fc = LS.get('flowsCache', ''); if (fc) renderFlows(JSON.parse(fc).workflows || []) } catch (e) {}
}

restoreTabs(); renderChips(); wire(); activateTab(active); updateCount()
log('Ghost Browser Desktop ready · device ' + (G.deviceName || '') + ' · ' + G.deviceId.slice(0, 8))
// A node reconnects on its own after a restart/reinstall — no one has to click Connect. Auto-connect
// unless the user explicitly Disconnected (clusterAuto==='0'); a drivable node's whole job is to be online.
if (LS.get('clusterAuto', '') !== '0') { setTimeout(() => { if (!controlWv) { log('↻ auto-connecting to the cluster…'); connect() } }, 1800) }
