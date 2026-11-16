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
  onLocked: (fn) => ipcRenderer.on('locked', (_e, locked) => fn(locked)),
  clipRead: () => ipcRenderer.invoke('clip:read'),
  clipWrite: (text) => ipcRenderer.send('clip:write', text),
  fileOpen: (name) => ipcRenderer.invoke('file:open', name),
  fileWrite: (id, chunk) => ipcRenderer.invoke('file:write', id, chunk),
  fileClose: (id, ok) => ipcRenderer.invoke('file:close', id, ok),
  filePick: () => ipcRenderer.invoke('file:pick'),
  fileRead: (id, offset, length) => ipcRenderer.invoke('file:read', id, offset, length),
  fileDone: (id) => ipcRenderer.invoke('file:done', id),
  autostartGet: () => ipcRenderer.invoke('autostart:get'),
  autostartSet: (on) => ipcRenderer.invoke('autostart:set', on),
})
