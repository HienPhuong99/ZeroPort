// Host-side helpers for M4 features: power commands, system info, privacy mode, remote shell, Wake-on-LAN.
// Everything here is reachable only after the controller authenticated (see src/host.ts), i.e. by someone who
// could already type into this machine. It adds convenience, not privilege.
import { BrowserWindow, screen } from 'electron'
import { spawn, execFile } from 'node:child_process'
import { createSocket } from 'node:dgram'
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
