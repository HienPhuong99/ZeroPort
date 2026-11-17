// Moves the real cursor by a pixel and back, and taps Shift. Windows only.
import test from 'node:test'
import assert from 'node:assert/strict'
import koffi from 'koffi'
import { inject } from '../electron/input.js'

test('SendInput moves the cursor to the requested pixel', { skip: process.platform !== 'win32' }, () => {
  const user32 = koffi.load('user32.dll')
  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' })
  const getPos = user32.func('GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))])
  const metric = user32.func('GetSystemMetrics', 'int', ['int'])
  const rect = { x: metric(76), y: metric(77), width: metric(78), height: metric(79) }
  const at = () => { const p = {}; getPos(p); return p }
  const go = (p) => inject({ t: 'mm', x: (p.x - rect.x) / (rect.width - 1), y: (p.y - rect.y) / (rect.height - 1) }, rect)

  // Retried: someone may be moving the real mouse while this runs.
  let ok = false, seen = ''
  for (let i = 0; i < 5 && !ok; i++) {
    const start = at()
    const target = { x: start.x > rect.x + 50 ? start.x - 37 : start.x + 37, y: start.y }
    go(target)
    const got = at()
    go(start)
    ok = Math.abs(got.x - target.x) <= 1 && Math.abs(got.y - target.y) <= 1 && Math.abs(at().x - start.x) <= 1
    seen = `wanted ${JSON.stringify(target)} got ${JSON.stringify(got)}`
  }
  assert.ok(ok, seen)

  inject({ t: 'k', c: 'ShiftLeft', d: 1 }, rect)
  inject({ t: 'k', c: 'ShiftLeft', d: 0 }, rect)
  inject({ t: 'k', c: 'NoSuchKey', d: 1 }, rect) // unknown codes are ignored
})
