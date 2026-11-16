// Electron main process: window + tray, screen-capture source selection, input injection, encrypted config.
// The renderer (src/) does all networking and WebRTC; this process only does what a web page cannot.
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, session, desktopCapturer, screen, safeStorage, powerSaveBlocker, powerMonitor, clipboard, dialog } from 'electron'
import { readFile, writeFile, rename, mkdir, open, unlink, stat } from 'node:fs/promises'
import { join, dirname, basename, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { inject } from './input.js'

const dir = dirname(fileURLToPath(import.meta.url))
const dev = process.argv.includes('--dev')
const hidden = process.argv.includes('--hidden')
// A second profile lets two instances run side by side on one machine (testing host + controller).
const profile = process.argv.find((a) => a.startsWith('--profile='))?.slice(10)
if (profile) app.setPath('userData', join(app.getPath('userData'), `profile-${profile}`))

let win, tray, quitting = false, selected = '', rect = null, awake = -1

if (!app.requestSingleInstanceLock()) app.quit()
else app.whenReady().then(start)

app.on('second-instance', () => { win?.show(); win?.focus() })
app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => {}) // keep serving from the tray

function start() {
  selected = String(screen.getPrimaryDisplay().id)
  win = new BrowserWindow({
    width: 1120, height: 740, show: !hidden, backgroundColor: '#0b0f17', autoHideMenuBar: true,
    icon: join(dir, 'icon.png'),
    // The host keeps capturing and signaling while the window is hidden.
    webPreferences: { preload: join(dir, 'preload.cjs'), backgroundThrottling: false },
  })
  if (dev) win.loadURL('http://localhost:5173')
  else win.loadFile(join(dir, '../dist/index.html'))
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide() } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault()) // local UI only, never remote content

  tray = new Tray(nativeImage.createFromPath(join(dir, 'icon.png')).resize({ width: 16, height: 16 }))
  tray.setToolTip('ZeroPort')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở ZeroPort', click: () => win.show() },
    { type: 'separator' },
    { label: 'Thoát', click: () => app.quit() },
  ]))
  tray.on('click', () => win.show())

  const ses = session.defaultSession
  const allowed = new Set(['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock'])
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(wc === win.webContents && allowed.has(perm)))
  // getDisplayMedia() in the renderer lands here: hand over the selected screen, no picker.
  ses.setDisplayMediaRequestHandler(async (req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      const video = sources.find((s) => s.display_id === selected) ?? sources[0]
      cb(req.audioRequested ? { video, audio: 'loopback' } : { video })
    } catch (err) {
      console.error('capture failed', err)
      try { cb({}) } catch {} // denies the request
    }
  })

  powerSaveBlocker.start('prevent-app-suspension') // a sleeping host is an unreachable host
  screen.on('display-metrics-changed', () => { rect = null })
  screen.on('display-removed', () => { rect = null })
  // The lock screen lives on a desktop this process cannot capture or control; tell viewers why the picture froze.
  powerMonitor.on('lock-screen', () => win.webContents.send('locked', true))
  powerMonitor.on('unlock-screen', () => win.webContents.send('locked', false))
}

// Bounds of the shared display in the units the OS input APIs want (see electron/input.js).
function shareRect() {
  if (rect) return rect
  const all = screen.getAllDisplays()
  const d = all.find((x) => String(x.id) === selected) ?? screen.getPrimaryDisplay()
  return (rect = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds)
}

const mine = (e) => e.sender === win?.webContents

ipcMain.on('input', (e, m) => {
  if (!mine(e)) return
  try { inject(m, shareRect()) } catch (err) { console.error('inject failed', err) }
})

ipcMain.on('sessions', (e, n) => {
  if (!mine(e)) return
  tray?.setToolTip(n ? `ZeroPort — đang được điều khiển (${n})` : 'ZeroPort')
  // Capture returns black frames once the display sleeps, so keep it on while someone is connected.
  if (n && awake < 0) awake = powerSaveBlocker.start('prevent-display-sleep')
  if (!n && awake >= 0) { powerSaveBlocker.stop(awake); awake = -1 }
})

ipcMain.handle('hostname', () => os.hostname())

ipcMain.handle('displays', () => ({
  display: selected,
  displays: screen.getAllDisplays().map((d, i) => ({
    id: String(d.id), label: d.label || `Màn hình ${i + 1}`,
    w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor),
  })),
}))

ipcMain.handle('display:select', (e, id) => {
  if (mine(e) && screen.getAllDisplays().some((d) => String(d.id) === id)) { selected = id; rect = null }
})

// Host identity and pairing secrets, encrypted at rest with the OS keystore (DPAPI / Keychain).
const cfgFile = () => join(app.getPath('userData'), 'host.bin')
// The sync safeStorage API is deprecated (removed in Electron 46); the async one resolves to { result }.
const enc = async (s) => (safeStorage.encryptStringAsync ? safeStorage.encryptStringAsync(s) : safeStorage.encryptString(s))
const dec = async (b) => (safeStorage.decryptStringAsync ? (await safeStorage.decryptStringAsync(b)).result : safeStorage.decryptString(b))

ipcMain.handle('cfg:get', async (e) => {
  if (!mine(e)) return null
  let buf
  try { buf = await readFile(cfgFile()) } catch (err) { if (err.code === 'ENOENT') return null; throw err }
  // A file that exists but cannot be read must fail loudly: returning null would mint a new identity and drop every pairing.
  return JSON.parse(await dec(buf))
})

ipcMain.handle('cfg:set', async (e, cfg) => {
  if (!mine(e)) return
  const tmp = cfgFile() + '.tmp'
  await writeFile(tmp, await enc(JSON.stringify(cfg)))
  await rename(tmp, cfgFile()) // atomic: a crash mid-write cannot corrupt the pairings
})

// ---- clipboard --------------------------------------------------------------------------------
ipcMain.handle('clip:read', (e) => (mine(e) ? clipboard.readText() : ''))
ipcMain.on('clip:write', (e, text) => { if (mine(e)) clipboard.writeText(String(text)) })

// ---- file transfer ----------------------------------------------------------------------------
// Incoming files land in Downloads/ZeroPort. Outgoing files are only ones picked in the native dialog on this screen.
const incoming = new Map(), outgoing = new Map()
let nextId = 0

ipcMain.handle('file:open', async (e, name) => {
  if (!mine(e)) return
  const dirOut = join(app.getPath('downloads'), 'ZeroPort')
  await mkdir(dirOut, { recursive: true })
  const { name: stem, ext } = parse(basename(String(name).replace(/[<>:"|?*\x00-\x1f]/g, '_')) || 'file')
  for (let i = 0; ; i++) { // never overwrite: "a.txt", "a (1).txt", ...
    const path = join(dirOut, `${stem}${i ? ` (${i})` : ''}${ext}`)
    try { incoming.set(++nextId, { fh: await open(path, 'wx'), path }); return nextId } catch (err) { if (err.code !== 'EEXIST') throw err }
  }
})
ipcMain.handle('file:write', async (e, id, chunk) => { if (mine(e)) await incoming.get(id).fh.write(Buffer.from(chunk)) })
ipcMain.handle('file:close', async (e, id, ok) => {
  const f = incoming.get(id)
  if (!mine(e) || !f) return
  incoming.delete(id)
  await f.fh.close()
  if (!ok) await unlink(f.path).catch(() => {}) // half a file is worse than none
  return f.path
})
ipcMain.handle('file:pick', async (e) => {
  if (!mine(e)) return []
  const { filePaths } = await dialog.showOpenDialog({ title: 'ZeroPort — chọn tệp để gửi', properties: ['openFile', 'multiSelections'] })
  return Promise.all(filePaths.map(async (path) => {
    const id = ++nextId
    outgoing.set(id, await open(path, 'r'))
    return { id, name: basename(path), size: (await stat(path)).size }
  }))
})
ipcMain.handle('file:read', async (e, id, offset, length) => {
  if (!mine(e)) return
  const buf = Buffer.alloc(length)
  const { bytesRead } = await outgoing.get(id).read(buf, 0, length, offset)
  return buf.subarray(0, bytesRead)
})
ipcMain.handle('file:done', async (e, id) => { if (mine(e)) { await outgoing.get(id)?.close(); outgoing.delete(id) } })

// ---- settings ---------------------------------------------------------------------------------
// Only meaningful for the installed app: in development this would register electron.exe itself.
ipcMain.handle('autostart:get', () => app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin)
ipcMain.handle('autostart:set', (e, on) => { if (mine(e) && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }) })
