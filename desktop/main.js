const { app, BrowserWindow, ipcMain, webContents } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

/** Stable per-install device id (the cluster targets a device by this token). */
function deviceId() {
  const p = path.join(app.getPath('userData'), 'device-id.txt')
  try { return fs.readFileSync(p, 'utf8').trim() } catch (e) {}
  const id = crypto.randomBytes(12).toString('hex')
  try { fs.writeFileSync(p, id) } catch (e) {}
  return id
}

let win
function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 880, backgroundColor: '#0A0D0B', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, contextIsolation: true, nodeIntegration: false, spellcheck: false,
      sandbox: false, // the preload reads bundled gb.js via fs — a sandboxed preload cannot require('fs')
    },
  })
  win.setMenuBarVisibility(false)
  // Every <webview> gets the control-preload so the same-origin control loop can bridge to the host.
  win.webContents.on('will-attach-webview', (_e, wp) => {
    wp.preload = path.join(__dirname, 'control-preload.js')
    wp.contextIsolation = true
    wp.nodeIntegration = false
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // Start maximized so a driven webview gets a full, real viewport (complex web apps like CapCut's
  // editor are unusable in a small window). A short window silently squeezes the render size.
  win.once('ready-to-show', () => { try { win.maximize() } catch (e) {} })
  win.maximize()
}

ipcMain.on('device-id', (e) => { e.returnValue = deviceId() })

// Window control from the cluster (e.g. force a full viewport before driving a heavy app).
ipcMain.handle('gb-win', (_e, a) => {
  try {
    if (!win) return { ok: false, error: 'no window' }
    if (a.action === 'maximize') win.maximize()
    else if (a.action === 'unmaximize') win.unmaximize()
    else if (a.action === 'fullscreen') win.setFullScreen(true)
    return { ok: true, action: a.action }
  } catch (e) { return { ok: false, error: String(e && e.message || e) } }
})

// Attach a LOCAL file to a page's <input type=file> WITHOUT the native OS dialog, via the Chrome
// DevTools Protocol (DOM.setFileInputFiles). This is what lets the cluster import media into a web
// app (CapCut, etc.) — the file lives on this device, so a real path just works. CDP fires the
// input's change event, so the app sees the file exactly as if a human had picked it.
ipcMain.handle('gb-upload', async (_e, a) => {
  const files = (a.files || []).filter(Boolean)
  for (const f of files) { if (!fs.existsSync(f)) return { ok: false, error: 'file not found: ' + f } }
  const wc = webContents.fromId(a.webContentsId)
  if (!wc) return { ok: false, error: 'no webContents ' + a.webContentsId }
  const dbg = wc.debugger
  let attached = false
  try {
    try { dbg.attach('1.3'); attached = true } catch (e) { /* already attached by devtools/us */ }
    await dbg.sendCommand('DOM.enable')
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true })
    const sel = a.selector || 'input[type=file]'
    const q = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: sel })
    const ids = q.nodeIds || []
    const target = ids[a.nth || 0]
    if (!target) return { ok: false, error: 'no file input matched ' + sel, matched: ids.length }
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: target, files })
    return { ok: true, files, matched: ids.length }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  } finally {
    if (attached) { try { dbg.detach() } catch (e) {} }
  }
})

// Ollama / OpenAI-compatible chat, run in the main process so the on-device agent avoids browser CORS.
ipcMain.handle('llm', async (_e, a) => {
  try {
    const url = String(a.endpoint || '').replace(/\/$/, '') + '/chat/completions'
    const headers = { 'Content-Type': 'application/json' }
    if (a.key) headers['Authorization'] = 'Bearer ' + a.key
    // Accept a full conversation (messages[]) or the legacy single system+user turn.
    const messages = Array.isArray(a.messages) && a.messages.length
      ? a.messages
      : [{ role: 'system', content: a.system || '' }, { role: 'user', content: a.user || '' }]
    const r = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model: a.model, messages, temperature: (a.temperature != null ? a.temperature : 0.2), stream: false }),
    })
    const j = await r.json().catch(() => null)
    return { ok: r.ok, text: (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '', error: r.ok ? null : ('HTTP ' + r.status + (j && j.error ? ': ' + (j.error.message || j.error) : '')) }
  } catch (e) { return { ok: false, text: '', error: String(e && e.message || e) } }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
