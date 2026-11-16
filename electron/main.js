// Electron main process: window + tray, screen-capture source selection, input injection, encrypted config.
// The renderer (src/) does all networking and WebRTC; this process only does what a web page cannot.
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, session, desktopCapturer, screen, safeStorage, powerSaveBlocker } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
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
