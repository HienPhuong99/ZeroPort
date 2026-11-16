// Host-side helpers for M4 features: power commands, system info, privacy mode, remote shell, Wake-on-LAN.
// Everything here is reachable only after the controller authenticated (see src/host.ts), i.e. by someone who
// could already type into this machine. It adds convenience, not privilege.
import { BrowserWindow, screen } from 'electron'
import { spawn, execFile } from 'node:child_process'
import { createSocket } from 'node:dgram'
import net from 'node:net'
import os from 'node:os'
import koffi from 'koffi'

const win32 = process.platform === 'win32', mac = process.platform === 'darwin'
let user32
const u32 = () => (user32 ??= koffi.load('user32.dll'))
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => (err ? rej(err) : res(out))))
const osa = (s) => run('osascript', ['-e', `tell application "System Events" to ${s}`])

// ---- power ------------------------------------------------------------------------------------
const POWER = {
  // pmset only locks if "require password after sleep" is on (the macOS default).
  lock: () => (win32 ? u32().func('bool LockWorkStation()')() : mac ? run('pmset', ['displaysleepnow']) : undefined),
  logoff: () => (win32 ? run('shutdown', ['/l']) : mac ? osa('log out') : undefined),
  restart: () => (win32 ? run('shutdown', ['/r', '/t', '3']) : mac ? osa('restart') : undefined),
  shutdown: () => (win32 ? run('shutdown', ['/s', '/t', '3']) : mac ? osa('shut down') : undefined),
}
export async function power(cmd) {
  if (!Object.hasOwn(POWER, cmd)) throw new Error('unknown command')
  await POWER[cmd]()
}

// ---- system info ------------------------------------------------------------------------------
async function processes() {
  if (win32) {
    // "name","pid","session","#","12,345 K"
    const out = await run('tasklist', ['/fo', 'csv', '/nh'])
    return out.split(/\r?\n/).filter(Boolean).map((l) => {
      const f = l.slice(1, -1).split('","')
      return { name: f[0], pid: +f[1], mb: Math.round(parseInt(f[4].replace(/\D/g, ''), 10) / 1024) }
    })
  }
  const out = await run('ps', ['-axo', 'pid=,rss=,comm='])
  return out.split('\n').filter(Boolean).map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)
    return m ? { pid: +m[1], mb: Math.round(+m[2] / 1024), name: m[3].split('/').pop() } : null
  }).filter(Boolean)
}

export async function sysInfo() {
  const cpus = os.cpus()
  const procs = (await processes().catch(() => [])).filter((p) => p.pid > 4).sort((a, b) => b.mb - a.mb).slice(0, 60)
  return {
    host: os.hostname(), user: os.userInfo().username, os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${cpus[0]?.model.trim() ?? '?'} × ${cpus.length}`, load: os.loadavg()[0],
    memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(), uptime: os.uptime(), procs,
  }
}

export function kill(pid) {
  pid = Number(pid)
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) throw new Error('bad pid')
  process.kill(pid)
}

// ---- privacy mode -----------------------------------------------------------------------------
// A black, click-through window on every display, excluded from capture (WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+,
// NSWindowSharingNone on macOS), so people at the machine see black while the viewer still sees the desktop.
// BlockInput additionally freezes the local mouse/keyboard, but Windows only allows it from an elevated process;
// injected input from this thread still goes through. Ctrl+Alt+Del always releases it.
let veils = [], blocked = false
const VEIL = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<body style="margin:0;background:#000;color:#555;font:20px system-ui;display:grid;place-items:center;height:100vh;cursor:none">Máy đang được điều khiển từ xa</body>')

export function privacy(on) {
  for (const w of veils.splice(0)) if (!w.isDestroyed()) w.destroy()
  if (blocked) { u32().func('bool BlockInput(bool)')(false); blocked = false }
  if (!on) return { privacy: false, blocked: false }
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      ...d.bounds, frame: false, show: false, focusable: false, skipTaskbar: true, resizable: false, movable: false,
      backgroundColor: '#000000', hasShadow: false, enableLargerThanScreen: true, webPreferences: { javascript: false },
    })
    w.setContentProtection(true)
    w.setIgnoreMouseEvents(true)
    w.setAlwaysOnTop(true, 'screen-saver')
    if (mac) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    void w.loadURL(VEIL)
    w.showInactive()
    w.setBounds(d.bounds)
    veils.push(w)
  }
  if (win32) blocked = !!u32().func('bool BlockInput(bool)')(true)
  return { privacy: true, blocked }
}

// ---- remote shell -----------------------------------------------------------------------------
// Plain pipes, no pseudo-terminal: line-based commands work, full-screen programs (vim, top) do not.
const shells = new Map()
export function termOpen(id, emit) {
  termClose(id)
  const p = win32
    ? spawn('cmd.exe', ['/Q', '/K', 'chcp 65001 >nul'], { windowsHide: true, cwd: os.homedir() })
    : spawn(process.env.SHELL || '/bin/zsh', ['-i'], { cwd: os.homedir(), env: { ...process.env, TERM: 'dumb' } })
  const out = (b) => emit('data', b.toString('utf8'))
  p.stdout.on('data', out)
  p.stderr.on('data', out)
  p.on('error', (e) => emit('data', `\n[${e.message}]\n`))
  p.on('exit', (code) => { if (shells.get(id) === p) shells.delete(id); emit('exit', code) })
  shells.set(id, p)
}
export function termWrite(id, s) { shells.get(id)?.stdin.write(String(s)) }
export function termClose(id) {
  const p = shells.get(id)
  if (!p) return
  shells.delete(id)
  if (win32) execFile('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }, () => {})
  else p.kill('SIGKILL')
}
export const termCloseAll = () => [...shells.keys()].forEach(termClose)

// ---- Wake-on-LAN ------------------------------------------------------------------------------
const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i

/** MAC addresses of this machine's real network adapters, reported to controllers so they can wake it later. */
export function macs() {
  const seen = new Set()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && a.mac && a.mac !== '00:00:00:00:00:00') seen.add(a.mac.toLowerCase())
  }
  return [...seen].slice(0, 8)
}

function broadcasts() {
  const out = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4') continue
      const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number)
      out.add(ip.map((b, i) => (b | (~m[i] & 255)) & 255).join('.'))
    }
  }
  return [...out]
}

/** Sends magic packets for `list` to every local broadcast address, ports 9 and 7. Returns how many MACs were valid. */
export async function wake(list) {
  const valid = (Array.isArray(list) ? list : []).map(String).filter((m) => MAC_RE.test(m)).slice(0, 16)
  if (!valid.length) return 0
  const sock = createSocket('udp4')
  await new Promise((res, rej) => sock.bind(0, () => res()).once('error', rej))
  sock.setBroadcast(true)
  try {
    for (const m of valid) {
      const hw = Buffer.from(m.replace(/[:-]/g, ''), 'hex')
      const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(hw)])
      for (const addr of broadcasts()) for (const port of [9, 7]) {
        await new Promise((res) => sock.send(pkt, port, addr, () => res()))
      }
    }
  } finally { sock.close() }
  return valid.length
}

// ---- annotation overlay (P2) ------------------------------------------------------------------
let annoWin = null, annoReady = null
const ANNO_COLORS = new Set(['#ef4444', '#3b82f6', '#22c55e', '#facc15'])
const ANNO_HTML = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><body style="margin:0;overflow:hidden;background:transparent"><canvas id="c" style="width:100vw;height:100vh;display:block"></canvas><script>
const c=document.getElementById('c'),g=c.getContext('2d');
function fit(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;g.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0)}
fit();addEventListener('resize',fit);
window.draw=(pts,col)=>{if(pts.length<2)return;g.strokeStyle=col;g.lineWidth=4;g.lineCap='round';g.lineJoin='round';g.beginPath();g.moveTo(pts[0][0]*innerWidth,pts[0][1]*innerHeight);for(let i=1;i<pts.length;i++)g.lineTo(pts[i][0]*innerWidth,pts[i][1]*innerHeight);g.stroke()};
window.clr=()=>g.clearRect(0,0,innerWidth,innerHeight);
</script></body>`)

export async function annotate(msg, bounds) {
  if (msg?.close) { if (annoWin && !annoWin.isDestroyed()) annoWin.destroy(); annoWin = annoReady = null; return }
  if (msg?.clear) { if (annoWin && !annoWin.isDestroyed()) await annoWin.webContents.executeJavaScript('window.clr?.()').catch(() => {}); return }
  const pts = Array.isArray(msg?.pts) ? msg.pts.slice(0, 128).filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]) : []
  if (pts.length < 2) return
  const color = ANNO_COLORS.has(msg.color) ? msg.color : '#ef4444'
  if (!annoWin || annoWin.isDestroyed()) {
    annoWin = new BrowserWindow({
      ...bounds, frame: false, transparent: true, show: false, focusable: false, skipTaskbar: true,
      resizable: false, movable: false, hasShadow: false, enableLargerThanScreen: true,
      webPreferences: { contextIsolation: true, sandbox: true },
    })
    annoWin.setContentProtection(true)
    annoWin.setIgnoreMouseEvents(true)
    annoWin.setAlwaysOnTop(true, 'screen-saver')
    if (mac) annoWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    annoReady = annoWin.loadURL(ANNO_HTML).then(() => { if (annoWin && !annoWin.isDestroyed()) { annoWin.showInactive(); annoWin.setBounds(bounds) } })
  }
  await annoReady
  if (annoWin && !annoWin.isDestroyed()) await annoWin.webContents.executeJavaScript(`window.draw(${JSON.stringify(pts)},${JSON.stringify(color)})`).catch(() => {})
}

// ---- TCP port forwarding (P2, strictly loopback 127.0.0.1) ------------------------------------
const tcpServers = new Map() // `${sid}:${localPort}` -> { server, sid, localPort, remotePort }
const tcpHostConns = new Map() // `${sid}:${id}` -> net.Socket
const tcpCtlConns = new Map() // `${sid}:${id}` -> net.Socket
let nextTcpId = 1

const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535

export function tcpHostOpen(sid, id, port, emit) {
  if (!validPort(port) || tcpHostConns.size >= 64) return emit('close', id)
  const key = `${sid}:${id}`
  const sock = net.createConnection({ host: '127.0.0.1', port })
  tcpHostConns.set(key, sock)
  sock.on('data', (buf) => emit('data', id, buf))
  sock.on('error', () => {})
  sock.on('close', () => { if (tcpHostConns.delete(key)) emit('close', id) })
}
export const tcpHostSend = (sid, id, buf) => { tcpHostConns.get(`${sid}:${id}`)?.write(Buffer.from(buf)) }
export const tcpHostDrop = (sid, id) => { const k = `${sid}:${id}`; tcpHostConns.get(k)?.destroy(); tcpHostConns.delete(k) }

export async function tcpListen(sid, localPort, remotePort, emit) {
  if (!validPort(localPort) || !validPort(remotePort)) throw new Error('Cổng không hợp lệ (1–65535)')
  const skey = `${sid}:${localPort}`
  if (tcpServers.has(skey)) throw new Error(`Cổng ${localPort} đã được chuyển tiếp`)
  if (tcpServers.size >= 10) throw new Error('Tối đa 10 cổng chuyển tiếp')
  const server = net.createServer((sock) => {
    if (tcpCtlConns.size >= 64) return sock.destroy()
    const id = nextTcpId++ >>> 0, ckey = `${sid}:${id}`
    tcpCtlConns.set(ckey, sock)
    emit('open', id, remotePort)
    sock.on('data', (buf) => emit('data', id, buf))
    sock.on('error', () => {})
    sock.on('close', () => { if (tcpCtlConns.delete(ckey)) emit('close', id) })
  })
  await new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(localPort, '127.0.0.1', () => { server.removeListener('error', rej); res() })
  })
  tcpServers.set(skey, { server, sid, localPort, remotePort })
  return { localPort, remotePort }
}
export function tcpUnlisten(sid, localPort) {
  const k = `${sid}:${localPort}`, entry = tcpServers.get(k)
  if (entry) { tcpServers.delete(k); entry.server.close() }
}
export const tcpCtlSend = (sid, id, buf) => { tcpCtlConns.get(`${sid}:${id}`)?.write(Buffer.from(buf)) }
export const tcpCtlDrop = (sid, id) => { const k = `${sid}:${id}`; tcpCtlConns.get(k)?.destroy(); tcpCtlConns.delete(k) }

export function tcpCloseAll(sid) {
  for (const [k, v] of tcpServers) if (!sid || v.sid === sid) { v.server.close(); tcpServers.delete(k) }
  for (const [k, s] of tcpHostConns) if (!sid || k.startsWith(`${sid}:`)) { s.destroy(); tcpHostConns.delete(k) }
  for (const [k, s] of tcpCtlConns) if (!sid || k.startsWith(`${sid}:`)) { s.destroy(); tcpCtlConns.delete(k) }
}

