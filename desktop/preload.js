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
})
