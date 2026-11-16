// Injects mouse/keyboard events into the OS. Message shapes: see `Input` in src/proto.ts.
// `rect` = bounds of the display being shared: physical pixels on Windows, points on macOS.
import koffi from 'koffi'
import { SCAN, MACVK, MACMOD } from './keymap.js'

let impl
export function inject(msg, rect) {
  impl ??= process.platform === 'win32' ? win() : process.platform === 'darwin' ? mac() : () => {}
  impl(msg, rect)
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0))

function win() {
  const user32 = koffi.load('user32.dll')
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'long', dy: 'long', mouseData: 'int32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  })
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  })
  // INPUT is { DWORD type; union {...} } = 40 bytes on x64/arm64; one struct per union arm keeps koffi simple.
  const INPUT_M = koffi.struct('INPUT_M', { type: 'uint32', mi: MOUSEINPUT })
  const INPUT_K = koffi.struct('INPUT_K', { type: 'uint32', ki: KEYBDINPUT, pad: 'uint64' })
  const SIZE = koffi.sizeof(INPUT_M)
  if (SIZE !== 40 || koffi.sizeof(INPUT_K) !== 40) throw new Error('INPUT layout mismatch')
  const sendM = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT_M), 'int'])
  const sendK = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT_K), 'int'])
  const metric = user32.func('GetSystemMetrics', 'int', ['int'])

  const mouse = (dwFlags, dx = 0, dy = 0, mouseData = 0) =>
    sendM(1, [{ type: 0, mi: { dx, dy, mouseData, dwFlags, time: 0, dwExtraInfo: 0 } }], SIZE)
  const key = (wScan, dwFlags, wVk = 0) => ({ type: 1, ki: { wVk, wScan, dwFlags, time: 0, dwExtraInfo: 0 }, pad: 0 })
  const keys = (list) => list.length && sendK(list.length, list, SIZE)
  const scan = (code, up) => {
    const sc = SCAN[code]
    return sc ? [key(sc & 0xff, 0x8 | (sc > 0xff ? 0x1 : 0) | (up ? 0x2 : 0))] : []
  }
  const BTN = [[0x2, 0x4], [0x20, 0x40], [0x8, 0x10]] // left, middle, right → [down, up]

  return (m, rect) => {
    switch (m.t) {
      case 'mm': {
        // MOUSEEVENTF_ABSOLUTE | VIRTUALDESK: 0..65535 across the whole virtual desktop.
        const vx = metric(76), vy = metric(77), vw = metric(78), vh = metric(79)
        const px = rect.x + clamp01(m.x) * (rect.width - 1), py = rect.y + clamp01(m.y) * (rect.height - 1)
        mouse(0x1 | 0x8000 | 0x4000, Math.round(((px - vx) * 65535) / (vw - 1)), Math.round(((py - vy) * 65535) / (vh - 1)))
        break
      }
      case 'mr': mouse(0x1, Math.round(m.dx), Math.round(m.dy)); break
      case 'mb': if (BTN[m.b]) mouse(BTN[m.b][m.d ? 0 : 1]); break
      case 'mw':
        if (m.dy) mouse(0x800, 0, 0, Math.round(-m.dy * 1.2)) // ~100px per notch in browsers, 120 per notch here
        if (m.dx) mouse(0x1000, 0, 0, Math.round(m.dx * 1.2))
        break
      case 'k': keys(scan(m.c, !m.d)); break
      case 'tx': {
        const list = []
        for (let i = 0; i < (m.bs | 0); i++) list.push(...scan('Backspace', false), ...scan('Backspace', true))
        for (const ch of String(m.s ?? '')) {
          if (ch === '\n') { list.push(...scan('Enter', false), ...scan('Enter', true)); continue }
          for (let i = 0; i < ch.length; i++) {
            const cu = ch.charCodeAt(i) // KEYEVENTF_UNICODE takes UTF-16 units; surrogate pairs go as two events
            list.push(key(cu, 0x4), key(cu, 0x4 | 0x2))
          }
        }
        keys(list)
        break
      }
    }
  }
}

// Untested on real hardware (no Mac available when written) — needs Accessibility permission.
function mac() {
  const cg = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  koffi.struct('CGPoint', { x: 'double', y: 'double' })
  const mouseEv = cg.func('void* CGEventCreateMouseEvent(void* src, uint32 type, CGPoint pos, uint32 button)')
  const keyEv = cg.func('void* CGEventCreateKeyboardEvent(void* src, uint16 vk, bool down)')
  const scrollEv = cg.func('void* CGEventCreateScrollWheelEvent(void* src, uint32 units, uint32 count, ...)')
  const setUni = cg.func('void CGEventKeyboardSetUnicodeString(void* ev, ulong len, const uint16* str)')
  const setFlags = cg.func('void CGEventSetFlags(void* ev, uint64 flags)')
  const setInt = cg.func('void CGEventSetIntegerValueField(void* ev, uint32 field, int64 value)')
  const postEv = cg.func('void CGEventPost(uint32 tap, void* ev)')
  const release = cf.func('void CFRelease(void* cf)')
  const post = (ev) => { if (ev) { postEv(0, ev); release(ev) } } // 0 = kCGHIDEventTap

  let pos = { x: 0, y: 0 }, flags = 0, held = -1, last = { t: 0, b: -1, n: 0 }
  // [down, up, dragged] event types per button index (left, middle, right); CGMouseButton: left 0, right 1, center 2
  const EV = [[1, 2, 6], [25, 26, 27], [3, 4, 7]], CGBTN = [0, 2, 1]
  const mouse = (type, btn, clicks) => {
    const ev = mouseEv(null, type, pos, btn)
    setFlags(ev, flags)
    if (clicks) setInt(ev, 1, clicks) // kCGMouseEventClickState
    post(ev)
  }
  const key = (vk, down) => { const ev = keyEv(null, vk, down); setFlags(ev, flags); post(ev) }
  const tap = (vk) => { key(vk, true); key(vk, false) }

  return (m, rect) => {
    switch (m.t) {
      case 'mm':
        pos = { x: rect.x + clamp01(m.x) * (rect.width - 1), y: rect.y + clamp01(m.y) * (rect.height - 1) }
        mouse(held < 0 ? 5 : EV[held][2], held < 0 ? 0 : CGBTN[held])
        break
      case 'mr':
        pos = { x: pos.x + m.dx, y: pos.y + m.dy }
        mouse(held < 0 ? 5 : EV[held][2], held < 0 ? 0 : CGBTN[held])
        break
      case 'mb': {
        if (!EV[m.b]) break
        if (m.d) {
          const now = Date.now()
          last = { t: now, b: m.b, n: last.b === m.b && now - last.t < 400 ? last.n + 1 : 1 }
          held = m.b
        } else if (held === m.b) held = -1
        mouse(EV[m.b][m.d ? 0 : 1], CGBTN[m.b], last.n)
        break
      }
      case 'mw': post(scrollEv(null, 0, 2, 'int32', Math.round(-m.dy), 'int32', Math.round(-m.dx))); break
      case 'k': {
        const vk = MACVK[m.c]
        if (vk === undefined) break
        if (MACMOD[m.c]) flags = m.d ? flags | MACMOD[m.c] : flags & ~MACMOD[m.c]
        key(vk, !!m.d)
        break
      }
      case 'tx': {
        for (let i = 0; i < (m.bs | 0); i++) tap(MACVK.Backspace)
        for (const ch of String(m.s ?? '')) {
          if (ch === '\n') { tap(MACVK.Enter); continue }
          const units = Uint16Array.from(ch, (_, i) => ch.charCodeAt(i))
          for (const down of [true, false]) { const ev = keyEv(null, 0, down); setUni(ev, units.length, units); post(ev) }
        }
        break
      }
    }
  }
}
