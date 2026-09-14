const { app, BrowserWindow, ipcMain } = require('electron')
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
}

ipcMain.on('device-id', (e) => { e.returnValue = deviceId() })

// Ollama / OpenAI-compatible chat, run in the main process so the on-device agent avoids browser CORS.
ipcMain.handle('llm', async (_e, a) => {
  try {
    const url = String(a.endpoint || '').replace(/\/$/, '') + '/chat/completions'
    const headers = { 'Content-Type': 'application/json' }
    if (a.key) headers['Authorization'] = 'Bearer ' + a.key
    const r = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model: a.model, messages: [{ role: 'system', content: a.system }, { role: 'user', content: a.user }], temperature: 0.2, stream: false }),
    })
    const j = await r.json().catch(() => null)
    return { ok: r.ok, text: (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '', error: r.ok ? null : ('HTTP ' + r.status) }
  } catch (e) { return { ok: false, text: '', error: String(e && e.message || e) } }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
