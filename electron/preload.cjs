// Bridge between the sandboxed UI and electron/main.js. Its presence (`window.zp`) is how the UI knows it can host.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('zp', {
  platform: process.platform,
  cfgGet: () => ipcRenderer.invoke('cfg:get'),
  cfgSet: (cfg) => ipcRenderer.invoke('cfg:set', cfg),
  hostname: () => ipcRenderer.invoke('hostname'),
  input: (m) => ipcRenderer.send('input', m),
  sessionCount: (n) => ipcRenderer.send('sessions', n),
  displays: () => ipcRenderer.invoke('displays'),
  selectDisplay: (id) => ipcRenderer.invoke('display:select', id),
})
