const { contextBridge, ipcRenderer } = require('electron')

// The control loop (gb-control.js) runs in the page's main world and calls window.GBHost.* to reach the
// host renderer; results are posted back with window.__gbResult (which gb-control.js defines itself).
contextBridge.exposeInMainWorld('GBHost', {
  result: (tag, data) => ipcRenderer.sendToHost('result', String(tag), String(data)),
  ctl: (tag, data) => ipcRenderer.sendToHost('ctl', String(tag), String(data)),
  onCommand: (id, p, body) => ipcRenderer.sendToHost('cmd', String(id), String(p), String(body)),
})
