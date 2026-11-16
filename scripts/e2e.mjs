// End-to-end check on one machine: starts two app instances (host + controller), pairs them through the UI,
// connects through real signaling, then verifies video arrives and a pointer move reaches the OS cursor.
// Run: npm run build && node scripts/e2e.mjs      (moves the real mouse briefly; Windows only for the cursor check)
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import electron from 'electron'
import koffi from 'koffi'
import { createHash } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []
const launch = (profile, port, ...extra) => {
  // ZP_BIN=release/win-unpacked/ZeroPort.exe tests the packaged app instead of the source tree.
  const bin = process.env.ZP_BIN
  const p = spawn(bin ?? electron, [...(bin ? [] : ['.']), `--profile=${profile}`, `--remote-debugging-port=${port}`, ...extra], { stdio: 'inherit' })
  procs.push(p)
  return attach(port)
}

async function attach(port) {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {}
    if (!target) await sleep(500)
  }
  assert.ok(target, `no page on port ${port}`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id) }
  const run = async (expression) => {
    const m = await new Promise((res) => { pending.set(++id, res); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } })) })
    if (m.result.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'eval failed')
    return m.result.result.value
  }
  run.until = async (expression, what, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) { const v = await run(expression); if (v) return v }
    throw new Error(`timed out waiting for ${what}`)
  }
  return run
}

try {
  const host = await launch('e2e-host', 9223)
  // Hidden: a visible controller window showing this same screen would catch the injected cursor and feed it back.
  const ctl = await launch('e2e-ctl', 9224, '--hidden')

  // pair through the host UI
  await host.until(`!!document.querySelector('[data-act=pair]')`, 'host UI')
  await host(`document.querySelector('[data-act=pair]').click()`)
  await host.until(`!!document.querySelector('#dlg input')`, 'name dialog')
  await host(`document.querySelector('#dlg input').value = 'e2e ' + Date.now(); document.querySelector('#dlg button.primary').click()`)
  const code = await host.until(`document.querySelector('#dlg code')?.textContent`, 'pairing code')
  await host(`document.querySelector('#dlg #done').click()`)
  console.log('paired, code length', code.length)

  // add on the controller and connect
  await ctl.until(`!!document.querySelector('#add')`, 'controller UI')
  await ctl(`document.querySelector('#add input').value = ${JSON.stringify(code)}; document.querySelector('#add').requestSubmit()`)
  await ctl.until(`!!document.querySelector('[data-act=connect]')`, 'host card')
  await ctl.until(`document.querySelector('[data-host] .dot.on') !== null`, 'host shown online')
  await ctl(`document.querySelector('[data-act=connect]').click()`)
  await ctl.until(`document.querySelector('#veil')?.hidden === true`, 'authenticated session')
  await sleep(5000)
  console.log('host stats', JSON.stringify(await host(`zpHostStats()`)))
  console.log('ctl stats', await ctl(`(async () => { const v = document.querySelector('video'); const tracks = v.srcObject?.getTracks().map(t => t.kind + ':' + t.readyState + (t.muted ? ':muted' : '')); return JSON.stringify({ tracks, ready: v.readyState, paused: v.paused, w: v.videoWidth }) })()`))
  const size = await ctl.until(`(() => { const v = document.querySelector('video'); return v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : '' })()`, 'video frames')
  console.log('video', size)

  // the picture must not be black
  const luma = await ctl(`(() => { const v = document.querySelector('video'), c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36); const d = g.getImageData(0, 0, 64, 36).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i+1] + d[i+2]; return s / (d.length / 4 * 3) })()`)
  console.log('mean luma', luma.toFixed(1))
  assert.ok(luma > 2, 'video is black')

  // a pointer move on the controller must move the OS cursor to the same relative spot
  if (process.platform === 'win32') {
    const user32 = koffi.load('user32.dll')
    const POINT = koffi.struct('POINT', { x: 'long', y: 'long' })
    const getPos = user32.func('GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))])
    const setPos = user32.func('SetCursorPos', 'bool', ['int', 'int'])
    const metric = user32.func('GetSystemMetrics', 'int', ['int'])
    const before = {}; getPos(before)
    const [fx, fy] = [0.31, 0.62]
    let gx = 0, gy = 0
    for (let i = 0; i < 4; i++) { // retried: someone may be using the real mouse at the same time
      await ctl(`(() => { const r = document.querySelector('video').getBoundingClientRect();
        document.querySelector('#stage').dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', bubbles: true, clientX: r.left + r.width * ${fx}, clientY: r.top + r.height * ${fy} })) })()`)
      await sleep(200)
      const got = {}; getPos(got)
      gx = got.x / (metric(0) - 1); gy = got.y / (metric(1) - 1) // primary display, same (possibly DPI-virtualised) units
      console.log('cursor before', before.x, before.y, 'after', got.x, got.y, 'fraction', gx.toFixed(3), gy.toFixed(3))
      if (Math.abs(gx - fx) < 0.01 && Math.abs(gy - fy) < 0.01) break
    }
    setPos(before.x, before.y)
    assert.ok(Math.abs(gx - fx) < 0.01 && Math.abs(gy - fy) < 0.01, 'cursor did not follow')
  }

  // upload a 3 MB file through the UI's file input; it must arrive byte-identical in Downloads/ZeroPort
  const name = `zp-e2e-${Date.now()}.bin`
  const sent = await ctl(`(async () => { const b = new Uint8Array(3 * 1024 * 1024 + 123); for (let i = 0; i < b.length; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536));
    const dt = new DataTransfer(); dt.items.add(new File([b], ${JSON.stringify(name)})); const p = document.querySelector('#pick'); p.files = dt.files; p.dispatchEvent(new Event('change'));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('') })()`)
  await ctl.until(`document.querySelector('#note')?.textContent.includes('đã tới máy chủ')`, 'upload to be acknowledged')
  const saved = join(homedir(), 'Downloads', 'ZeroPort', name)
  const got = createHash('sha256').update(await readFile(saved)).digest('hex')
  await unlink(saved)
  assert.equal(got, sent, 'uploaded file differs')
  console.log('file upload ok, sha256', got.slice(0, 16))

  await ctl(`document.querySelector('[data-a=stats]').click()`)
  console.log('stats:', (await ctl.until(`document.querySelector('#stats').textContent`, 'stats', 8000)).replace('\n', ' | '))
  console.log('host panel:', await host(`document.querySelector('#app').innerText.split('\\n').filter(l => l.includes('điều khiển bởi')).join()`))

  await ctl(`document.querySelector('[data-a=close]').click()`)
  await host.until(`!document.querySelector('#app').innerText.includes('điều khiển bởi')`, 'host to see the session end', 20_000)
  console.log('E2E OK')
} finally {
  for (const p of procs) p.kill()
}
