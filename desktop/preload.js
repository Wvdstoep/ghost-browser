const { contextBridge, ipcRenderer } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

const read = (f) => { try { return fs.readFileSync(path.join(__dirname, 'assets', f), 'utf8') } catch (e) { return '' } }

contextBridge.exposeInMainWorld('GBAPI', {
  gbJs: read('gb.js'),
  gbControlJs: read('gb-control.js'),
  deviceId: ipcRenderer.sendSync('device-id'),
  deviceName: (os.hostname() || 'GB Desktop'),
  llm: (a) => ipcRenderer.invoke('llm', a),
  // Attach a local file to a page file-input by CDP (no native dialog) — for importing media into web apps.
  uploadFile: (webContentsId, selector, files, nth) => ipcRenderer.invoke('gb-upload', { webContentsId, selector, files, nth }),
  // Drag by CDP with drag-interception (never starts a native OS drag loop that hangs the node).
  dragCdp: (webContentsId, o) => ipcRenderer.invoke('gb-drag', Object.assign({ webContentsId }, o)),
  // Downloads the node saved itself (newest first): {file,url,bytes,total,state}.
  downloads: () => ipcRenderer.invoke('gb-downloads'),
  onDownload: (fn) => ipcRenderer.on('gb-download', (_e, rec) => fn(rec)),
  // Window control (maximize for a full driving viewport).
  winCmd: (action) => ipcRenderer.invoke('gb-win', { action }),
})
