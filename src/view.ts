// Session screen: remote video plus everything that turns local mouse / touch / keyboard into Input messages.
import { connect, type ConnState, type Remote } from './controller'
import { saveHost, type HostEntry } from './store'
import type { Ctl } from './proto'

const root = document.getElementById('session')!
const coarse = matchMedia('(pointer: coarse)').matches

const QUALITY: Record<string, object> = {
  'Cân bằng': { kbps: 8000, fps: 60 },
  'Nét nhất': { kbps: 25000, fps: 60 },
  'Mượt': { kbps: 8000, fps: 60, smooth: true },
  'Tiết kiệm': { kbps: 1200, fps: 24, scale: 1.5, smooth: true },
}
const KEYS: [string, string[]][] = [
  ['Esc', ['Escape']], ['Tab', ['Tab']], ['Del', ['Delete']], ['Win', ['MetaLeft']],
  ['←', ['ArrowLeft']], ['↑', ['ArrowUp']], ['↓', ['ArrowDown']], ['→', ['ArrowRight']],
  ['Home', ['Home']], ['End', ['End']], ['PgUp', ['PageUp']], ['PgDn', ['PageDown']],
  ['Alt+Tab', ['AltLeft', 'Tab']], ['Alt+F4', ['AltLeft', 'F4']], ['Win+D', ['MetaLeft', 'KeyD']], ['Task Mgr', ['ControlLeft', 'ShiftLeft', 'Escape']],
  ...Array.from({ length: 12 }, (_, i): [string, string[]] => [`F${i + 1}`, [`F${i + 1}`]]),
]
const MODS: [string, string][] = [['Ctrl', 'ControlLeft'], ['Alt', 'AltLeft'], ['Shift', 'ShiftLeft']]

export function openSession(host: HostEntry, onClose: () => void) {
  root.hidden = false
  root.innerHTML = `
    <div id="stage"><video autoplay playsinline muted disablepictureinpicture></video></div>
    <div id="veil"><div><strong>${host.name}</strong><div id="veil-msg">Đang kết nối…</div></div></div>
    <div id="bar">
      <button id="grip" title="Thu gọn">☰</button>
      <button data-a="menu">Phím</button>
      ${coarse ? '<button data-a="kb">⌨</button><button data-a="touch">Trackpad</button>' : ''}
      <button data-a="screen" hidden>Màn hình</button>
      <button data-a="quality">Chất lượng</button>
      <button data-a="sound">🔇</button>
      <button data-a="full">⛶</button>
      <button data-a="stats">ⓘ</button>
      <button data-a="close" class="danger">Ngắt</button>
    </div>
    <div id="menu" hidden></div>
    <div id="stats" hidden></div>
    <textarea id="kb" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"></textarea>`
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!
  const stage = $('#stage'), video = $<HTMLVideoElement>('video'), veil = $('#veil'), veilMsg = $('#veil-msg')
  const bar = $('#bar'), menu = $('#menu'), stats = $('#stats'), kb = $<HTMLTextAreaElement>('#kb')
  const ac = new AbortController(), sig = { signal: ac.signal }
  let displays: { id: string; label: string }[] = [], display = ''
  let trackpad = coarse

  const remote: Remote = connect(host, {
    state(s: ConnState, detail) {
      veil.hidden = s === 'connected'
      veilMsg.textContent = detail ?? { connecting: 'Đang kết nối…', offline: 'Máy chủ không phản hồi — đang thử lại…', connected: '', rejected: 'Bị từ chối', closed: '' }[s]
    },
    stream(s) { if (video.srcObject !== s) video.srcObject = s; void video.play().catch(() => {}) },
    ctl(m: Ctl) {
      if (m.t !== 'state') return
      if (m.displays) { displays = m.displays; display = m.display; $('[data-a=screen]').hidden = displays.length < 2 }
      if (m.name && host.name === 'Máy mới') void saveHost({ ...host, name: (host.name = m.name) })
    },
  })

  // ---- layout: video fitted to the stage, then zoom/pan (touch) ----------------------------------
  let zoom = 1, panX = 0, panY = 0
  const cur = { x: 0.5, y: 0.5 } // remote cursor, 0..1 — trackpad mode moves this instead of pointing directly
  function layout() {
    const sw = stage.clientWidth, sh = stage.clientHeight, vw = video.videoWidth || 16, vh = video.videoHeight || 9
    const k = Math.min(sw / vw, sh / vh), w = vw * k, h = vh * k
    zoom = Math.min(6, Math.max(1, zoom))
    // Keep the picture covering the stage: centred when smaller, clamped to the edges when zoomed in.
    const fit = (pan: number, size: number, box: number) => (size * zoom <= box ? (box - size * zoom) / 2 : Math.min(0, Math.max(box - size * zoom, pan)))
    panX = fit(panX, w, sw); panY = fit(panY, h, sh)
    Object.assign(video.style, { width: `${w}px`, height: `${h}px`, transform: `translate(${panX}px,${panY}px) scale(${zoom})` })
  }
  const norm = (e: { clientX: number; clientY: number }) => {
    const r = video.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  function follow() { // when zoomed in, scroll the picture so the remote cursor stays in view
    if (zoom === 1) return
    const r = video.getBoundingClientRect(), cx = r.left + cur.x * r.width, cy = r.top + cur.y * r.height, m = 40
    if (cx < m) panX += m - cx; else if (cx > stage.clientWidth - m) panX -= cx - (stage.clientWidth - m)
    if (cy < m) panY += m - cy; else if (cy > stage.clientHeight - m) panY -= cy - (stage.clientHeight - m)
    layout()
  }
  video.addEventListener('resize', layout, sig)
  addEventListener('resize', layout, sig)
  layout()

  const moveTo = (x: number, y: number) => {
    cur.x = Math.min(1, Math.max(0, x)); cur.y = Math.min(1, Math.max(0, y))
    remote.move({ t: 'mm', x: cur.x, y: cur.y })
  }
  const click = (b: 0 | 1 | 2) => { remote.send({ t: 'mb', b, d: 1 }); remote.send({ t: 'mb', b, d: 0 }) }

  // ---- mouse / pen: direct ------------------------------------------------------------------------
  stage.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') { const p = norm(e); moveTo(p.x, p.y) } }, sig)
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return touchDown(e)
    stage.setPointerCapture(e.pointerId)
    const p = norm(e)
    remote.send({ t: 'mm', x: p.x, y: p.y }) // reliable channel, so the click cannot outrun the move
    if (e.button <= 2) remote.send({ t: 'mb', b: e.button as 0 | 1 | 2, d: 1 })
  }, sig)
  stage.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') return touchUp(e)
    if (e.button <= 2) remote.send({ t: 'mb', b: e.button as 0 | 1 | 2, d: 0 })
  }, sig)
  stage.addEventListener('pointercancel', (e) => { if (e.pointerType === 'touch') touchUp(e, true) }, sig)
  stage.addEventListener('contextmenu', (e) => e.preventDefault(), sig)
  stage.addEventListener('wheel', (e) => {
    e.preventDefault()
    const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1
    remote.send({ t: 'mw', dx: e.deltaX * k, dy: e.deltaY * k })
  }, { ...sig, passive: false })

  // ---- touch: trackpad (default) or direct, pinch-zoom, two-finger scroll --------------------------
  const pts = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>()
  let moved = false, dragging = false, lastTap = 0, longPress = 0, maxFingers = 0
  let two: { dist: number; cx: number; cy: number; mode: '' | 'pinch' | 'scroll' } | null = null
  const twoInfo = () => {
    const [a, b] = [...pts.values()]
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
  }
  function touchDown(e: PointerEvent) {
    stage.setPointerCapture(e.pointerId)
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp })
    maxFingers = Math.max(maxFingers, pts.size)
    clearTimeout(longPress)
    if (pts.size === 1) {
      moved = false
      if (!trackpad) { const p = norm(e); moveTo(p.x, p.y) }
      if (e.timeStamp - lastTap < 300) { dragging = true; remote.send({ t: 'mb', b: 0, d: 1 }) } // tap-then-hold = drag
      else longPress = window.setTimeout(() => { if (!moved && pts.size === 1) { click(2); navigator.vibrate?.(15); moved = true } }, 550)
    } else if (pts.size === 2) two = { ...twoInfo(), mode: '' }
  }
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.x, dy = e.clientY - p.y
    p.x = e.clientX; p.y = e.clientY
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > 8) { moved = true; clearTimeout(longPress) }
    if (pts.size === 1 && moved) {
      if (trackpad) {
        const r = video.getBoundingClientRect(), speed = 1.4 * Math.sqrt(zoom) // finer control when zoomed in
        moveTo(cur.x + (dx * speed) / r.width, cur.y + (dy * speed) / r.height)
        follow()
      } else { const n = norm(e); moveTo(n.x, n.y) }
    } else if (pts.size === 2 && two) {
      const now = twoInfo()
      if (!two.mode) {
        if (Math.abs(now.dist - two.dist) > 24) two.mode = 'pinch'
        else if (Math.hypot(now.cx - two.cx, now.cy - two.cy) > 10) two.mode = 'scroll'
      }
      if (two.mode === 'pinch') {
        const z = Math.min(6, Math.max(1, zoom * (now.dist / two.dist)))
        // keep the point under the fingers fixed while scaling
        panX = now.cx - ((two.cx - panX) / zoom) * z; panY = now.cy - ((two.cy - panY) / zoom) * z
        zoom = z; layout()
      } else if (two.mode === 'scroll') remote.send({ t: 'mw', dx: (two.cx - now.cx) * 2.5, dy: (two.cy - now.cy) * 2.5 })
      if (two.mode) Object.assign(two, now)
    }
  }, sig)
  function touchUp(e: PointerEvent, cancelled = false) {
    const p = pts.get(e.pointerId)
    if (!p) return
    pts.delete(e.pointerId)
    clearTimeout(longPress)
    if (pts.size) return
    const quick = e.timeStamp - p.t0 < 300 && !moved && !cancelled && !two?.mode
    if (dragging) { dragging = false; remote.send({ t: 'mb', b: 0, d: 0 }); if (quick) click(0) } // second tap of a double-tap
    else if (quick && maxFingers === 1) { click(0); lastTap = e.timeStamp }
    else if (quick && maxFingers === 2) click(2)
    else if (quick && maxFingers === 3) focusKb()
    two = null; maxFingers = 0
  }

  // ---- keyboard -----------------------------------------------------------------------------------
  const held = new Set<string>(), sticky = new Set<string>()
  const key = (c: string, d: 0 | 1) => { d ? held.add(c) : held.delete(c); remote.send({ t: 'k', c, d }) }
  const combo = (codes: string[]) => { codes.forEach((c) => key(c, 1)); [...codes].reverse().forEach((c) => key(c, 0)) }
  const releaseAll = () => { for (const c of [...held]) key(c, 0); sticky.clear(); paintMods() }
  function onKey(e: KeyboardEvent, d: 0 | 1) {
    // 229 / isComposing = soft keyboard or IME: that text arrives through the textarea below instead.
    if (e.isComposing || e.keyCode === 229 || !e.code || (e.target as HTMLElement).closest?.('dialog')) return
    e.preventDefault()
    key(e.code, d)
    if (!d && sticky.size && !MODS.some(([, c]) => c === e.code)) releaseAll()
  }
  addEventListener('keydown', (e) => onKey(e, 1), sig)
  addEventListener('keyup', (e) => onKey(e, 0), sig)
  addEventListener('blur', releaseAll, sig)

  // Soft keyboards do not send usable key events, so diff a hidden field's value (the noVNC trick):
  // works with autocorrect, swipe typing and Vietnamese Telex, which rewrite earlier characters.
  const PAD = '_'.repeat(60)
  let last = (kb.value = PAD)
  const focusKb = () => { kb.focus(); kb.setSelectionRange(kb.value.length, kb.value.length) }
  kb.addEventListener('input', () => {
    const v = kb.value
    let i = 0
    while (i < last.length && i < v.length && last[i] === v[i]) i++
    const bs = last.length - i, s = v.slice(i)
    if (sticky.size && s.length === 1 && /[a-z0-9]/i.test(s)) { // Ctrl/Alt + letter must be a real key, not text
      combo([/\d/.test(s) ? `Digit${s}` : `Key${s.toUpperCase()}`]); releaseAll()
    } else if (bs || s) remote.send({ t: 'tx', s, bs })
    last = v
    if (v.length > 200 || v.length < 20) last = kb.value = PAD
  }, sig)

  // ---- toolbar ------------------------------------------------------------------------------------
  const paintMods = () => menu.querySelectorAll<HTMLElement>('[data-mod]').forEach((b) => b.classList.toggle('on', sticky.has(b.dataset.mod!)))
  function showMenu(kind: string) {
    if (!menu.hidden && menu.dataset.kind === kind) { menu.hidden = true; return }
    menu.dataset.kind = kind
    menu.hidden = false
    if (kind === 'menu') {
      menu.innerHTML = `<div class="wide">Giữ phím bổ trợ cho phím kế tiếp</div>` +
        MODS.map(([l, c]) => `<button data-mod="${c}">${l}</button>`).join('') + '<span></span>' +
        KEYS.map(([l], i) => `<button data-key="${i}">${l}</button>`).join('')
      paintMods()
    } else if (kind === 'quality') menu.innerHTML = Object.keys(QUALITY).map((q) => `<button data-q="${q}">${q}</button>`).join('')
    else if (kind === 'screen') menu.innerHTML = displays.map((d) => `<button data-d="${d.id}" class="${d.id === display ? 'on' : ''}">${d.label}</button>`).join('')
  }
  // pointerdown + preventDefault keeps focus (and the soft keyboard) where it is
  menu.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const b = (e.target as HTMLElement).closest<HTMLElement>('button')
    if (!b) return
    if (b.dataset.mod) {
      const c = b.dataset.mod
      if (sticky.delete(c)) key(c, 0); else { sticky.add(c); key(c, 1) }
      paintMods()
    } else if (b.dataset.key) { combo(KEYS[+b.dataset.key][1]); if (sticky.size) releaseAll() }
    else if (b.dataset.q) { remote.send({ t: 'quality', ...QUALITY[b.dataset.q] }); menu.hidden = true }
    else if (b.dataset.d) { remote.send({ t: 'display', id: b.dataset.d }); menu.hidden = true }
  }, sig)
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const b = (e.target as HTMLElement).closest<HTMLElement>('button')
    if (!b) return
    const a = b.dataset.a
    if (b.id === 'grip') { bar.classList.toggle('min'); menu.hidden = true }
    else if (a === 'menu' || a === 'quality' || a === 'screen') showMenu(a)
    else if (a === 'kb') document.activeElement === kb ? kb.blur() : focusKb()
    else if (a === 'touch') { trackpad = !trackpad; b.textContent = trackpad ? 'Trackpad' : 'Chạm' }
    else if (a === 'sound') { video.muted = !video.muted; b.textContent = video.muted ? '🔇' : '🔊' }
    else if (a === 'stats') stats.hidden = !stats.hidden
    else if (a === 'full') void toggleFull()
    else if (a === 'close') close()
  }, sig)
  async function toggleFull() {
    if (document.fullscreenElement) return document.exitFullscreen()
    await document.documentElement.requestFullscreen?.().catch(() => {})
    // Chromium only: lets Alt+Tab, Win, Esc reach the remote machine while fullscreen.
    await (navigator as any).keyboard?.lock?.().catch(() => {})
  }
  stage.classList.toggle('local-cursor', coarse)

  // ---- stats --------------------------------------------------------------------------------------
  let prev = { bytes: 0, t: 0 }
  const tick = setInterval(async () => {
    const pc = remote.pc()
    if (stats.hidden || !pc) return
    let line = ''
    const report = await pc.getStats()
    report.forEach((r: any) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        const kbps = prev.t ? ((r.bytesReceived - prev.bytes) * 8) / (r.timestamp - prev.t) : 0
        prev = { bytes: r.bytesReceived, t: r.timestamp }
        const codec = report.get(r.codecId)?.mimeType?.split('/')[1] ?? '?'
        line = `${r.frameWidth}x${r.frameHeight} ${Math.round(r.framesPerSecond ?? 0)}fps ${codec} ${Math.round(kbps)}kbps` + line
      } else if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
        const relay = report.get(r.localCandidateId)?.candidateType === 'relay' || report.get(r.remoteCandidateId)?.candidateType === 'relay'
        line += `\n${Math.round((r.currentRoundTripTime ?? 0) * 1000)}ms ${relay ? 'qua relay' : 'trực tiếp'}`
      }
    })
    stats.textContent = line
  }, 1000)

  function close() {
    releaseAll()
    clearInterval(tick)
    ac.abort()
    remote.close()
    if (document.fullscreenElement) void document.exitFullscreen()
    root.hidden = true
    root.innerHTML = ''
    onClose()
  }
}
