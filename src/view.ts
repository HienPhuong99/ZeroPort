// Session screen: remote video plus everything that turns local mouse / touch / keyboard into Input messages.
import { connect, type ConnState, type Remote } from './controller'
import { download, makeTransfer, openSink } from './files'
import { makeTunnel } from './tunnel'
import { listHosts, saveHost, type HostEntry } from './store'
import { CLIP_MAX, cleanAddrs, type Ctl } from './proto'
import { link } from './signal'
import { I } from './icons'

const root = document.getElementById('session')!
const coarse = matchMedia('(pointer: coarse)').matches
/** No pointer at all: a TV driven by its remote (D-pad), where the toolbar must be reachable by focus. */
const remoteOnly = matchMedia('(pointer: none)').matches
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const zp = (window as any).zp
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const QUALITY: Record<string, object> = {
  'Cân bằng': { kbps: 8000, fps: 60 },
  'Nét nhất': { kbps: 25000, fps: 60 },
  'Mượt': { kbps: 8000, fps: 60, smooth: true },
  'Tiết kiệm': { kbps: 1200, fps: 24, scale: 1.5, smooth: true },
  'AV1 (chữ nét)': { kbps: 30000, fps: 60 },
}
// AV1 keeps small text sharper than H.264 at the same bitrate, at the price of software encoding on the host.
// The flag is still called prefer444: the mode was first labelled 4:4:4, which this Chromium cannot encode (see controller.ts).
const QAV1 = 'AV1 (chữ nét)'
const KEYS: [string, string[]][] = [
  ['Esc', ['Escape']], ['Tab', ['Tab']], ['Del', ['Delete']], ['Win', ['MetaLeft']],
  ['←', ['ArrowLeft']], ['↑', ['ArrowUp']], ['↓', ['ArrowDown']], ['→', ['ArrowRight']],
  ['Home', ['Home']], ['End', ['End']], ['PgUp', ['PageUp']], ['PgDn', ['PageDown']],
  ['Alt+Tab', ['AltLeft', 'Tab']], ['Alt+F4', ['AltLeft', 'F4']], ['Win+D', ['MetaLeft', 'KeyD']], ['Task Mgr', ['ControlLeft', 'ShiftLeft', 'Escape']],
  ...Array.from({ length: 12 }, (_, i): [string, string[]] => [`F${i + 1}`, [`F${i + 1}`]]),
]
const MODS: [string, string][] = [['Ctrl', 'ControlLeft'], ['Alt', 'AltLeft'], ['Shift', 'ShiftLeft']]
const MORE: [string, string][] = [
  ['send', 'Gửi tệp lên máy chủ'], ['pull', 'Lấy tệp từ máy chủ'],
  ['clipUp', 'Gửi clipboard → máy chủ'], ['clipDown', 'Lấy clipboard ← máy chủ'],
  ['shot', 'Chụp ảnh màn hình'], ['rec', 'Ghi hình phiên'],
  ['privacy', 'Chế độ riêng tư'], ['power', 'Khoá / nguồn…'],
  ['info', 'Thông tin hệ thống'], ['term', 'Terminal'],
  ...(coarse ? [] : [['game', 'Chuột game (khoá con trỏ)'] as [string, string]]), ['wol', 'Đánh thức máy khác'], ['tv', 'Chiếu lên TV'],
  ['anno', 'Bảng vẽ chú thích'], ...(zp ? [['tcp', 'Chuyển tiếp cổng TCP'] as [string, string]] : []),
]
const POWER: [string, string, string][] = [
  ['lock', 'Khoá máy', ''],
  ['logoff', 'Đăng xuất', 'Đăng xuất khỏi máy chủ? Mọi ứng dụng đang mở sẽ bị đóng, và ZeroPort chỉ chạy lại sau khi có người đăng nhập.'],
  ['restart', 'Khởi động lại', 'Khởi động lại máy chủ? ZeroPort chỉ kết nối lại được sau khi Windows/macOS đăng nhập xong (cần auto-logon nếu không có ai ở máy).'],
  ['shutdown', 'Tắt máy', 'Tắt máy chủ? Sau đó chỉ bật lại được bằng tay hoặc Wake-on-LAN.'],
]
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

export function openSession(host: HostEntry, onClose: () => void, qName = host.prefer444 ? QAV1 : '') {
  root.hidden = false
  root.innerHTML = `
    <div id="stage"><video autoplay playsinline muted disablepictureinpicture></video><canvas id="anno" hidden></canvas></div>
    <div id="anno-bar" hidden>
      <button data-c="#ef4444" class="sw on" style="--c:#ef4444" aria-label="Bút đỏ"></button>
      <button data-c="#3b82f6" class="sw" style="--c:#3b82f6" aria-label="Bút xanh dương"></button>
      <button data-c="#22c55e" class="sw" style="--c:#22c55e" aria-label="Bút xanh lá"></button>
      <button data-c="#facc15" class="sw" style="--c:#facc15" aria-label="Bút vàng"></button>
      <button id="anno-clr">Xoá</button>
      <button id="anno-exit" class="danger">Thoát vẽ</button>
    </div>
    <div id="veil"><div><strong></strong><div id="veil-msg"></div></div></div>
    <div id="bar">
      <button id="grip" class="icon" title="Thu gọn" aria-label="Thu gọn">${I.menu}</button>
      <button data-a="menu">Phím</button>
      ${coarse ? '<button data-a="kb" class="icon" title="Bàn phím" aria-label="Bàn phím">${I.keyboard}</button><button data-a="touch">Trackpad</button>' : ''}
      <button data-a="screen" hidden>Màn hình</button>
      <button data-a="quality">Chất lượng</button>
      <button data-a="more">Thêm</button>
      <button data-a="sound" class="icon" title="Âm thanh" aria-label="Âm thanh">${I.muted}</button>
      <button data-a="full" class="icon" title="Toàn màn hình" aria-label="Toàn màn hình">${I.full}</button>
      <button data-a="stats" class="icon" title="Thông số kết nối" aria-label="Thông số kết nối">${I.info}</button>
      <button data-a="close" class="danger">Ngắt</button>
    </div>
    <div id="menu" hidden></div>
    <div id="stats" hidden></div>
    <div id="note" hidden></div>
    <input type="file" id="pick" multiple hidden>
    <dialog id="panel"></dialog>
    <dialog id="otpdlg"><form><strong>Mã xác thực 2 lớp</strong>
      <div class="sub" id="otpmsg">Mở ứng dụng xác thực (Google Authenticator, …) và nhập mã 6 số của ZeroPort.</div>
      <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required style="margin:12px 0">
      <div class="row" style="justify-content:flex-end"><button type="button" id="otpno">Huỷ</button><button class="primary">Xác nhận</button></div></form></dialog>
    <textarea id="kb" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"></textarea>`
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!
  const stage = $('#stage'), video = $<HTMLVideoElement>('video'), anno = $<HTMLCanvasElement>('#anno'), annoBar = $('#anno-bar'), veil = $('#veil'), veilMsg = $('#veil-msg')
  const bar = $('#bar'), menu = $('#menu'), stats = $('#stats'), note = $('#note'), kb = $<HTMLTextAreaElement>('#kb'), pick = $<HTMLInputElement>('#pick')
  const panel = $<HTMLDialogElement>('#panel'), otpDlg = $<HTMLDialogElement>('#otpdlg')
  veil.querySelector('strong')!.textContent = host.name
  const ac = new AbortController(), sig = { signal: ac.signal }
  let displays: { id: string; label: string }[] = [], display = ''
  let trackpad = coarse
  let conn: ConnState = 'connecting', connDetail = '', hostLocked = false
  let files: ReturnType<typeof makeTransfer> | null = null
  let clipLast = '', clipRemote = ''
  let privacyOn = false, platform = ''
  let update: { current: string; latest: string; available: boolean; auto: boolean } | null = null
  const tcpSid = crypto.randomUUID(), tunnels = new Map<number, number>()
  let tunnel: ReturnType<typeof makeTunnel> | null = null
  const offTcp = zp?.onTcpCtl((sid: string, kind: string, id: number, data: unknown) => {
    if (sid !== tcpSid || !tunnel) return
    if (kind === 'open') tunnel.open(id, data as number)
    else if (kind === 'data') void tunnel.data(id, data as Uint8Array).then(() => zp.tcpAck(tcpSid, id))
    else if (kind === 'close') tunnel.close(id)
  })

  let noteTimer = 0
  function say(text: string, ms = 4000) {
    note.textContent = text
    note.hidden = false
    clearTimeout(noteTimer)
    if (ms) noteTimer = window.setTimeout(() => (note.hidden = true), ms)
  }
  function paintVeil() {
    const lockedNow = conn === 'connected' && hostLocked
    veil.hidden = conn === 'connected' && !hostLocked
    veil.dataset.spin = (conn === 'connecting' || conn === 'offline') ? '1' : ''
    veilMsg.textContent = lockedNow
      ? 'Máy chủ đang ở màn hình khoá. Bản này chưa điều khiển được màn hình khoá — cần mở khoá tại máy.'
      : connDetail && conn !== 'otp' ? connDetail : { connecting: 'Đang kết nối…', offline: 'Máy chủ không phản hồi — đang thử lại…', connected: '', rejected: 'Bị từ chối', closed: '', otp: 'Chờ mã xác thực 2 lớp…' }[conn]
    if (conn === 'otp') {
      $('#otpmsg').textContent = connDetail || 'Mở ứng dụng xác thực (Google Authenticator, …) và nhập mã 6 số của ZeroPort.'
      const input = otpDlg.querySelector('input')!
      input.value = ''
      if (!otpDlg.open) otpDlg.show()
      input.focus()
    } else if (otpDlg.open) otpDlg.close()
  }
  otpDlg.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault()
    const input = otpDlg.querySelector('input')!
    remote.otp(input.value.trim())
    $('#otpmsg').textContent = 'Đang kiểm tra…'
  }, sig)
  $('#otpno').addEventListener('click', () => close(), sig)

  const remote: Remote = connect(host, {
    state(s, detail) {
      conn = s; connDetail = detail ?? ''; paintVeil()
      // Every (re)connection is a new session on the host and starts at its default quality.
      if (s === 'connected' && qName) remote.send({ t: 'quality', ...QUALITY[qName] })
    },
    stream(s) { if (video.srcObject !== s) video.srcObject = s; void video.play().catch(() => {}) },
    file(ch) {
      files = makeTransfer(ch, (name) => openSink(name), (dir, name, done, size) => {
        const pct = size ? Math.floor((done / size) * 100) : 100
        say(`${dir === 'up' ? '↑' : '↓'} ${name} ${pct}%${done >= size && dir === 'down' ? ' — đã lưu' : ''}`, done >= size ? 4000 : 0)
      })
    },
    tcp(ch) {
      if (!zp) return
      zp.tcpCloseAll(tcpSid, true) // connections of the previous link are gone on the host; listeners stay
      tunnel = makeTunnel(ch, {
        onData: (id, bytes) => zp.tcpCtlSend(tcpSid, id, bytes),
        onClose: (id) => zp.tcpCtlDrop(tcpSid, id),
      })
    },
    ctl(m: Ctl) {
      if (m.t === 'state') {
        if (m.displays) {
          if (display && m.display !== display) annoCtx.clearRect(0, 0, anno.width, anno.height) // strokes belonged to the other screen
          displays = m.displays; display = m.display; $('[data-a=screen]').hidden = displays.length < 2
        }
        if (typeof m.locked === 'boolean') { hostLocked = m.locked; paintVeil() }
        if (typeof m.platform === 'string') platform = m.platform
        if (typeof m.privacy === 'boolean' && m.privacy !== privacyOn) {
          privacyOn = m.privacy
          say(!privacyOn ? 'Đã tắt chế độ riêng tư'
            : m.blocked ? 'Chế độ riêng tư: màn hình máy chủ đen, chuột/phím tại chỗ bị chặn'
            : `Chế độ riêng tư: màn hình máy chủ đen${platform === 'win32' ? '. Chuột/phím tại chỗ vẫn dùng được — muốn chặn phải chạy ZeroPort bằng quyền admin' : ''}`, 7000)
        }
        if (Array.isArray(m.macs) && m.macs.join() !== (host.macs ?? []).join()) void saveHost({ ...host, macs: (host.macs = m.macs.map(String)) })
        const lan = cleanAddrs(m.lan)
        if (lan.length && lan.join() !== (host.lan ?? []).join()) { void saveHost({ ...host, lan: (host.lan = lan) }); link(host.hostId).lan(host.devId, lan) }
        if (m.name && host.name === 'Máy mới') void saveHost({ ...host, name: (host.name = m.name) })
        if (m.update?.available && m.update.latest !== update?.latest) {
          update = m.update
          say(`Máy chủ đang chạy ${update!.current}, đã có bản ${update!.latest} — xem menu “Thêm”`, 6000)
        }
      } else if (m.t === 'clip') {
        clipLast = clipRemote = String(m.s)
        navigator.clipboard?.writeText(clipRemote).catch(() => {}) // needs focus (and a tap on iOS): "Lấy clipboard" is the manual path
      } else if (m.t === 'xfer' && m.dir === 'up' && m.done >= m.size) say(`✓ ${m.name} đã tới máy chủ (Downloads/ZeroPort)`)
      else if (m.t === 'note') say(String(m.s), typeof m.ms === 'number' ? Math.min(30_000, Math.max(1000, m.ms)) : 4000)
      else if (m.t === 'sysinfo') showInfo(m)
      else if (m.t === 'term') termOut(m)
      else if (m.t === 'tvs') tvs(m)
    },
  })
  paintVeil()

  // ---- layout: video fitted to the stage, then zoom/pan (touch) ----------------------------------
  let zoom = 1, panX = 0, panY = 0, stageW = 0, stageH = 0, baseW = 0, baseH = 0
  const cur = { x: 0.5, y: 0.5 } // remote cursor, 0..1 — trackpad mode moves this instead of pointing directly
  // Separate transform updates from sizing so pinch-zoom and trackpad follow stay strictly compositor-only.
  function place() {
    zoom = Math.min(6, Math.max(1, zoom))
    const fit = (pan: number, size: number, box: number) => (size * zoom <= box ? (box - size * zoom) / 2 : Math.min(0, Math.max(box - size * zoom, pan)))
    panX = fit(panX, baseW, stageW); panY = fit(panY, baseH, stageH)
    const xf = `translate3d(${panX}px,${panY}px,0) scale(${zoom})`
    video.style.transform = xf
    anno.style.transform = xf
  }
  function layout() {
    stageW = stage.clientWidth; stageH = stage.clientHeight
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9
    const k = Math.min(stageW / vw, stageH / vh)
    baseW = vw * k; baseH = vh * k
    Object.assign(video.style, { width: `${baseW}px`, height: `${baseH}px` })
    Object.assign(anno.style, { width: `${baseW}px`, height: `${baseH}px` })
    if (anno.width !== Math.round(baseW * devicePixelRatio) || anno.height !== Math.round(baseH * devicePixelRatio)) {
      anno.width = Math.max(1, Math.round(baseW * devicePixelRatio))
      anno.height = Math.max(1, Math.round(baseH * devicePixelRatio))
    }
    place()
  }
  const norm = (e: { clientX: number; clientY: number }) => {
    const r = video.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  function follow() { // when zoomed in, scroll the picture so the remote cursor stays in view
    if (zoom === 1) return
    const cx = panX + cur.x * baseW * zoom, cy = panY + cur.y * baseH * zoom, m = 40
    if (cx < m) panX += m - cx; else if (cx > stageW - m) panX -= cx - (stageW - m)
    if (cy < m) panY += m - cy; else if (cy > stageH - m) panY -= cy - (stageH - m)
    place()
  }
  video.addEventListener('resize', layout, sig)
  addEventListener('resize', layout, sig)
  layout()

  const moveTo = (x: number, y: number) => {
    cur.x = Math.min(1, Math.max(0, x)); cur.y = Math.min(1, Math.max(0, y))
    remote.move({ t: 'mm', x: cur.x, y: cur.y })
  }
  const click = (b: 0 | 1 | 2) => { remote.send({ t: 'mb', b, d: 1 }); remote.send({ t: 'mb', b, d: 0 }) }

  // ---- mouse / pen: direct, or relative while the pointer is locked (game mouse) -------------------
  let game = false, acc = { x: 0, y: 0 }, accFrame = 0
  const flushRel = () => {
    accFrame = 0
    const dx = Math.trunc(acc.x), dy = Math.trunc(acc.y)
    acc.x -= dx; acc.y -= dy
    if (dx || dy) remote.send({ t: 'mr', dx, dy }) // reliable: a lost delta would drift the aim
  }
  document.addEventListener('pointerlockchange', () => {
    const on = document.pointerLockElement === stage
    if (on !== game) say((game = on) ? 'Chuột game: bật — Esc để thoát' : 'Chuột game: tắt')
  }, sig)
  function toggleGame() {
    if (document.pointerLockElement) return document.exitPointerLock()
    // Raw (unaccelerated) deltas where supported; the host OS applies its own pointer speed.
    const p = (stage.requestPointerLock as any)({ unadjustedMovement: true })
    p?.catch?.(() => stage.requestPointerLock())
  }
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return
    if (game) {
      acc.x += e.movementX; acc.y += e.movementY
      accFrame ||= requestAnimationFrame(flushRel)
      return
    }
    const p = norm(e); moveTo(p.x, p.y)
  }, sig)
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return touchDown(e)
    if (!game) stage.setPointerCapture(e.pointerId) // throws while the pointer is locked, which would swallow the click
    if (!game) { const p = norm(e); remote.send({ t: 'mm', x: p.x, y: p.y }) } // reliable channel, so the click cannot outrun the move
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
        zoom = z; place()
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

  // ---- clipboard ----------------------------------------------------------------------------------
  // Automatic where the browser allows it (desktop app, Chrome); iOS only reads/writes inside a tap, hence the menu items.
  async function pushClip(loud = false) {
    try {
      const t = await navigator.clipboard.readText()
      if (t.length > CLIP_MAX) return say('Clipboard quá lớn để đồng bộ')
      if (t && t !== clipLast) { clipLast = t; remote.send({ t: 'clip', s: t }) }
      if (loud) say('Đã gửi clipboard tới máy chủ')
    } catch { if (loud) say('Trình duyệt không cho đọc clipboard') }
  }
  addEventListener('focus', () => void pushClip(), sig)

  // ---- keyboard -----------------------------------------------------------------------------------
  const held = new Set<string>(), sticky = new Set<string>()
  const key = (c: string, d: 0 | 1) => { d ? held.add(c) : held.delete(c); remote.send({ t: 'k', c, d }) }
  const combo = (codes: string[]) => { codes.forEach((c) => key(c, 1)); [...codes].reverse().forEach((c) => key(c, 0)) }
  const releaseAll = () => { for (const c of [...held]) key(c, 0); sticky.clear(); paintMods() }
  let gate: Promise<unknown> = Promise.resolve() // keeps key order when a paste first has to sync the clipboard
  function onKey(e: KeyboardEvent, d: 0 | 1) {
    // 229 / isComposing = soft keyboard or IME: that text arrives through the textarea below instead.
    if (e.isComposing || e.keyCode === 229 || !e.code || panel.open || otpDlg.open || (e.target as HTMLElement).closest?.('dialog')) return
    if (remoteOnly) {
      // TV remote: D-pad/OK move around the toolbar and menus; the Menu key jumps there from the picture.
      if ((e.target as HTMLElement).closest?.('#bar, #menu')) return
      if (e.code === 'ContextMenu') { e.preventDefault(); if (d) bar.querySelector<HTMLElement>('button:not([hidden])')?.focus(); return }
    }
    e.preventDefault()
    const paste = d && e.code === 'KeyV' && (e.ctrlKey || e.metaKey) && !e.repeat
    const code = e.code
    gate = gate.then(() => (paste ? pushClip() : undefined)).then(() => {
      key(code, d)
      if (!d && sticky.size && !MODS.some(([, c]) => c === code)) releaseAll()
    })
  }
  addEventListener('keydown', (e) => onKey(e, 1), sig)
  addEventListener('keyup', (e) => onKey(e, 0), sig)
  addEventListener('blur', () => void (gate = gate.then(releaseAll)), sig)

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

  // ---- files, screenshot, recording ----------------------------------------------------------------
  function upload(list: FileList | null | undefined) {
    if (!files) return say('Chưa kết nối xong')
    for (const f of list ?? []) void files.send(f.name, f.size, (o, n) => f.slice(o, o + n).arrayBuffer()).catch(() => say(`Gửi ${f.name} thất bại`))
  }
  pick.addEventListener('change', () => { upload(pick.files); pick.value = '' }, sig)
  stage.addEventListener('dragover', (e) => e.preventDefault(), sig)
  stage.addEventListener('drop', (e) => { e.preventDefault(); upload(e.dataTransfer?.files) }, sig)

  function screenshot() {
    const c = Object.assign(document.createElement('canvas'), { width: video.videoWidth, height: video.videoHeight })
    c.getContext('2d')!.drawImage(video, 0, 0)
    c.toBlob((b) => { if (b) void download(b, `zeroport-${stamp()}.png`).then(() => { if ((window as any).zpAndroid) say('Đã lưu ảnh vào Downloads/ZeroPort') }, () => say('Lưu ảnh thất bại')) })
  }
  let rec: MediaRecorder | null = null
  function toggleRec() {
    if (rec) { rec.stop(); rec = null; return }
    const parts: Blob[] = []
    // ponytail: recording is buffered in memory until stopped; write to disk in chunks if hours-long recordings matter.
    const r = (rec = new MediaRecorder(video.srcObject as MediaStream))
    r.ondataavailable = (e) => parts.push(e.data)
    r.onstop = () => void download(new Blob(parts, { type: r.mimeType }), `zeroport-${stamp()}.${r.mimeType.includes('mp4') ? 'mp4' : 'webm'}`).then(() => say('Đã lưu bản ghi'), () => say('Lưu bản ghi thất bại'))
    r.start(1000)
    say('● Đang ghi hình — vào Thêm → Dừng ghi để lưu')
  }

  // ---- M4 panels: power, sysinfo, terminal, Wake-on-LAN -------------------------------------------
  let termActive = false
  panel.addEventListener('close', () => {
    // The close event is queued: one from the previous panel (system info…) can land after the panel was reopened as
    // the terminal, and must not kill the shell that just started.
    if (panel.open) return
    if (termActive) { termActive = false; remote.send({ t: 'term', close: true }) }
  }, sig)

  function showPower() {
    panel.innerHTML = `<strong>Khoá / nguồn máy chủ</strong><div class="plist">
      ${POWER.map(([cmd, label]) => `<button data-p="${cmd}" class="${cmd === 'shutdown' || cmd === 'restart' ? 'danger' : ''}">${label}</button>`).join('')}
    </div><div class="row" style="justify-content:flex-end;margin-top:12px"><button id="pclose">Đóng</button></div>`
    panel.querySelector('#pclose')!.addEventListener('click', () => panel.close())
    panel.querySelectorAll<HTMLElement>('[data-p]').forEach((b) => {
      b.onclick = () => {
        const [, , ask] = POWER.find(([c]) => c === b.dataset.p)!
        if (ask && !confirm(ask)) return
        remote.send({ t: 'power', cmd: b.dataset.p })
        panel.close()
      }
    })
    panel.showModal()
  }

  const fmtBytes = (b: number) => `${(b / (1024 ** 3)).toFixed(1)} GB`
  const fmtUp = (s: number) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
    return `${d ? `${d}d ` : ''}${h}h ${m}m`
  }
  function showInfo(m: Ctl) {
    const procs = (m.procs as { pid: number; name: string; mb: number }[] | undefined) ?? []
    panel.innerHTML = `<strong>Thông tin hệ thống — ${esc(m.host)}</strong>
      <div class="sysgrid">
        <span>Người dùng</span><span>${esc(m.user)}</span>
        <span>Hệ điều hành</span><span>${esc(m.os)}</span>
        <span>CPU</span><span>${esc(m.cpu)}</span>
        <span>RAM</span><span>${fmtBytes(m.memUsed)} / ${fmtBytes(m.memTotal)}</span>
        <span>Thời gian bật</span><span>${fmtUp(m.uptime)}</span>
      </div>
      <div class="proclist"><table><thead><tr><th>Tiến trình</th><th>PID</th><th>RAM</th><th></th></tr></thead><tbody>
        ${procs.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.pid)}</td><td>${esc(p.mb)} MB</td><td><button data-kill="${esc(p.pid)}" class="danger sm">Dừng</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button id="iref">Làm mới</button><button class="primary" id="iclose">Đóng</button>
      </div>`
    panel.querySelector('#iref')!.addEventListener('click', () => remote.send({ t: 'sysinfo' }))
    panel.querySelector('#iclose')!.addEventListener('click', () => panel.close())
    panel.querySelectorAll<HTMLElement>('[data-kill]').forEach((b) => {
      b.onclick = () => { if (confirm(`Kết thúc tiến trình PID ${b.dataset.kill}?`)) remote.send({ t: 'kill', pid: +b.dataset.kill! }) }
    })
    if (!panel.open) panel.showModal()
  }

  function openTerm() {
    termActive = true
    panel.innerHTML = `<strong>Terminal — ${esc(host.name)}</strong>
      <pre id="term-out"></pre>
      <form id="term-in" class="row">
        <input type="text" name="cmd" placeholder="Nhập lệnh rồi Enter…" autocomplete="off" spellcheck="false">
        <button class="primary">Gửi</button><button type="button" id="trestart" title="Dừng lệnh đang chạy và mở lại shell">Mở lại</button><button type="button" id="tclose">Đóng</button>
      </form>`
    const inp = panel.querySelector<HTMLInputElement>('input')!
    panel.querySelector('#tclose')!.addEventListener('click', () => panel.close())
    panel.querySelector('#trestart')!.addEventListener('click', () => {
      const pre = panel.querySelector<HTMLElement>('#term-out')
      if (pre) pre.textContent += '\n[Đang mở lại shell…]\n'
      remote.send({ t: 'term', open: true })
      inp.focus()
    })
    panel.querySelector('#term-in')!.addEventListener('submit', (e) => {
      e.preventDefault()
      const s = inp.value
      inp.value = ''
      remote.send({ t: 'term', s: s + (platform === 'win32' ? '\r\n' : '\n') })
    })
    panel.showModal()
    inp.focus()
    remote.send({ t: 'term', open: true })
  }
  function termOut(m: Ctl) {
    const pre = panel.querySelector<HTMLElement>('#term-out')
    if (!pre) return
    if (m.s) pre.textContent = (pre.textContent + String(m.s)).slice(-100_000)
    if ('exit' in m) pre.textContent += `\n[Tiến trình đã thoát: ${m.exit}]\n`
    pre.scrollTop = pre.scrollHeight
  }

  async function showWol() {
    const others = (await listHosts()).filter((h) => h.hostId !== host.hostId && h.macs?.length)
    panel.innerHTML = `<strong>Đánh thức máy khác (Wake-on-LAN)</strong>
      <div class="sub" style="margin:6px 0 12px">Nhờ <b>${esc(host.name)}</b> gửi gói đánh thức vào mạng LAN của nó.</div>
      ${others.map((h) => `<button data-w="${esc(h.macs!.join(','))}" class="witem"><span>${esc(h.name)}</span><span class="sub">${esc(h.macs![0])}</span></button>`).join('')
        || '<div class="sub" style="margin-bottom:10px">Chưa có máy nào khác lưu địa chỉ MAC (hãy kết nối tới máy đó ít nhất 1 lần).</div>'}
      <form id="wform" class="row" style="margin-top:10px">
        <input type="text" name="mac" placeholder="Hoặc nhập MAC: aa:bb:cc:dd:ee:ff" autocomplete="off" spellcheck="false">
        <button class="primary">Đánh thức</button>
      </form>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button id="wclose">Đóng</button></div>`
    panel.querySelector('#wclose')!.addEventListener('click', () => panel.close())
    panel.querySelectorAll<HTMLElement>('[data-w]').forEach((b) => {
      b.onclick = () => { remote.send({ t: 'wol', macs: b.dataset.w!.split(',') }); panel.close() }
    })
    panel.querySelector('#wform')!.addEventListener('submit', (e) => {
      e.preventDefault()
      const mac = panel.querySelector<HTMLInputElement>('input')!.value.trim()
      if (!mac) return
      remote.send({ t: 'wol', macs: [mac] })
      panel.close()
    })
    panel.showModal()
  }

  // ---- M7: cast the host's screen to a TV on its network (electron/cast.js) ----------------------
  let tvName: string | null = null
  function showTvs() {
    panel.innerHTML = `<strong>Chiếu màn hình máy chủ lên TV</strong>
      <div class="sub" style="margin:6px 0 12px">Smart TV (DLNA) cùng mạng với <b>${esc(host.name)}</b>. Xem trên TV, điều khiển bằng thiết bị này.</div>
      <div id="tvlist" class="sub">Đang tìm TV…</div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">${tvName ? '<button id="tvstop" class="danger">Dừng chiếu</button>' : ''}<button id="tvclose">Đóng</button></div>`
    panel.querySelector('#tvclose')!.addEventListener('click', () => panel.close())
    panel.querySelector('#tvstop')?.addEventListener('click', () => { remote.send({ t: 'tv', stop: 1 }); panel.close() })
    remote.send({ t: 'tv' })
    panel.showModal()
  }
  function tvs(m: Ctl) {
    const now = typeof m.tv?.name === 'string' ? m.tv.name : null
    if (now !== tvName) { tvName = now; say(now ? `Máy chủ đang chiếu lên ${now}` : 'Đã dừng chiếu lên TV') }
    const box = panel.open && panel.querySelector('#tvlist')
    if (!box || !Array.isArray(m.list)) return
    box.innerHTML = m.list.length
      ? m.list.map((t: any) => `<button data-tv="${esc(t.id)}" class="witem"><span>${esc(t.name)}</span>${t.id === m.tv?.id ? '<span class="sub">đang chiếu</span>' : ''}</button>`).join('')
      : 'Không thấy TV nào. TV phải bật, cùng mạng với máy chủ và bật chia sẻ/DLNA; lần đầu, trên máy chủ phải cho phép ZeroPort qua tường lửa.'
    box.querySelectorAll<HTMLElement>('[data-tv]').forEach((b) => {
      b.onclick = () => { remote.send({ t: 'tv', id: b.dataset.tv }); say('Đang gửi tới TV…'); panel.close() }
    })
  }

  // ---- P2: annotation overlay & Electron TCP port forwarding -------------------------------------
  let annoColor = '#ef4444', annoPts: [number, number][] = [], annoDown = false
  const annoCtx = anno.getContext('2d')!
  function setAnno(on: boolean) {
    anno.hidden = annoBar.hidden = !on
    stage.classList.toggle('annotating', on)
    if (!on) { annoCtx.clearRect(0, 0, anno.width, anno.height); remote.send({ t: 'anno', close: true }) }
    else layout()
  }
  const drawLocal = (pts: [number, number][], col: string) => {
    if (pts.length < 2) return
    annoCtx.strokeStyle = col; annoCtx.lineWidth = 4 * devicePixelRatio; annoCtx.lineCap = 'round'; annoCtx.lineJoin = 'round'
    annoCtx.beginPath(); annoCtx.moveTo(pts[0][0] * anno.width, pts[0][1] * anno.height)
    for (let i = 1; i < pts.length; i++) annoCtx.lineTo(pts[i][0] * anno.width, pts[i][1] * anno.height)
    annoCtx.stroke()
  }
  anno.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); anno.setPointerCapture(e.pointerId); annoDown = true
    const p = norm(e); annoPts = [[Math.min(1, Math.max(0, p.x)), Math.min(1, Math.max(0, p.y))]]
  }, sig)
  anno.addEventListener('pointermove', (e) => {
    if (!annoDown) return
    e.stopPropagation()
    const p = norm(e), pt: [number, number] = [Math.min(1, Math.max(0, p.x)), Math.min(1, Math.max(0, p.y))]
    const prev = annoPts[annoPts.length - 1]
    drawLocal([prev, pt], annoColor)
    annoPts.push(pt)
    if (annoPts.length >= 16) { remote.send({ t: 'anno', pts: annoPts, color: annoColor }); annoPts = [pt] }
  }, sig)
  const endStroke = () => {
    if (!annoDown) return
    annoDown = false
    if (annoPts.length >= 2) remote.send({ t: 'anno', pts: annoPts, color: annoColor })
    annoPts = []
  }
  anno.addEventListener('pointerup', endStroke, sig)
  anno.addEventListener('pointercancel', endStroke, sig)
  annoBar.addEventListener('pointerdown', (e) => e.preventDefault(), sig)
  annoBar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button')
    if (!b) return
    if (b.dataset.c) {
      annoColor = b.dataset.c
      annoBar.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x === b))
    } else if (b.id === 'anno-clr') { annoCtx.clearRect(0, 0, anno.width, anno.height); remote.send({ t: 'anno', clear: true }) }
    else if (b.id === 'anno-exit') setAnno(false)
  }, sig)

  function showTcp() {
    const paint = () => {
      const list = [...tunnels.entries()]
      panel.innerHTML = `<strong>Chuyển tiếp cổng TCP (chỉ loopback 127.0.0.1)</strong>
        <div class="sub" style="margin:6px 0 12px">Mở cổng trên máy này trỏ tới 127.0.0.1 trên máy chủ (ví dụ SSH 2222 → 22).</div>
        ${list.map(([lp, rp]) => `<div class="witem"><span>127.0.0.1:${lp} → máy chủ :${rp}</span><button data-un="${lp}" class="danger sm">Dừng</button></div>`).join('')
          || '<div class="sub" style="margin-bottom:10px">Chưa có đường hầm nào.</div>'}
        <form id="tcpf" class="row" style="margin-top:10px">
          <input type="text" name="lp" inputmode="numeric" placeholder="Cổng máy này (vd 2222)" required>
          <input type="text" name="rp" inputmode="numeric" placeholder="Cổng máy chủ (vd 22)" required>
          <button class="primary">Mở</button>
        </form>
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" id="tclose">Đóng</button></div>`
      panel.querySelector('#tclose')!.addEventListener('click', () => panel.close())
      panel.querySelectorAll<HTMLElement>('[data-un]').forEach((b) => {
        b.onclick = () => { const lp = +b.dataset.un!; zp.tcpUnlisten(tcpSid, lp); tunnels.delete(lp); paint() }
      })
      panel.querySelector('#tcpf')!.addEventListener('submit', async (e) => {
        e.preventDefault()
        const f = (e.target as HTMLFormElement).elements as any
        const lp = parseInt(f.lp.value, 10), rp = parseInt(f.rp.value, 10)
        try { await zp.tcpListen(tcpSid, lp, rp); tunnels.set(lp, rp); paint() }
        catch (err: any) { say(`Lỗi mở cổng: ${err?.message ?? err}`) }
      })
    }
    paint()
    panel.showModal()
  }

  // ---- toolbar ------------------------------------------------------------------------------------
  const paintMods = () => menu.querySelectorAll<HTMLElement>('[data-mod]').forEach((b) => b.classList.toggle('on', sticky.has(b.dataset.mod!)))
  let menuFrom: HTMLElement | null = null
  function hideMenu() {
    menu.hidden = true
    if (remoteOnly) menuFrom?.focus() // back to the toolbar button that opened it
  }
  function showMenu(kind: string) {
    if (!menu.hidden && menu.dataset.kind === kind) return hideMenu()
    const switching = !menu.hidden
    menuFrom = document.activeElement as HTMLElement | null
    menu.dataset.kind = kind
    menu.hidden = false
    if (switching && !reducedMotion()) {
      menu.animate([{ opacity: 0.72, transform: 'translateX(-50%) scale(0.985)' }, { opacity: 1, transform: 'translateX(-50%) scale(1)' }], { duration: 150, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
    }
    if (remoteOnly) queueMicrotask(() => menu.querySelector<HTMLElement>('button')?.focus())
    if (kind === 'menu') {
      menu.innerHTML = `<div class="wide">Giữ phím bổ trợ cho phím kế tiếp</div>` +
        MODS.map(([l, c]) => `<button data-mod="${c}">${l}</button>`).join('') + '<span></span>' +
        KEYS.map(([l], i) => `<button data-key="${i}">${l}</button>`).join('')
      paintMods()
    } else if (kind === 'quality') menu.innerHTML = Object.keys(QUALITY).map((q) => {
      return `<button data-q="${q}"${q === (qName || 'Cân bằng') ? ' class="on"' : ''}>${q}</button>`
    }).join('')
    else if (kind === 'screen') menu.innerHTML = displays.map((d) => `<button data-d="${esc(d.id)}" class="${d.id === display ? 'on' : ''}">${esc(d.label)}</button>`).join('')
    else if (kind === 'more') menu.innerHTML = MORE.map(([a, l]) => {
      const label = a === 'rec' && rec ? 'Dừng ghi' : a === 'privacy' && privacyOn ? 'Tắt chế độ riêng tư' : a === 'game' && game ? 'Tắt chuột game' : l
      return `<button data-m="${a}" class="span2">${label}</button>`
    }).join('') + (update?.available ? `<button data-m="update" class="span2">Cập nhật máy chủ ${esc(update.current)} → ${esc(update.latest)}</button>` : '')
  }
  // preventDefault on pointerdown keeps focus (and the soft keyboard) where it is; the action runs on click,
  // which — unlike a touch pointerdown — counts as a user gesture for clipboard, file picker and fullscreen.
  for (const el of [bar, menu]) el.addEventListener('pointerdown', (e) => e.preventDefault(), sig)
  menu.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button')
    if (!b) return
    if (b.dataset.mod) {
      const c = b.dataset.mod
      if (sticky.delete(c)) key(c, 0); else { sticky.add(c); key(c, 1) }
      paintMods()
      return
    }
    if (b.dataset.key) { combo(KEYS[+b.dataset.key][1]); if (sticky.size) releaseAll(); return }
    hideMenu()
    if (b.dataset.q) {
      const wantAv1 = (qName = b.dataset.q) === QAV1
      remote.send({ t: 'quality', ...QUALITY[qName] })
      // The codec is fixed when the connection is negotiated, so switching AV1 on or off means reconnecting.
      if (!!host.prefer444 !== wantAv1) {
        void saveHost({ ...host, prefer444: (host.prefer444 = wantAv1) }).then(() => { close(); openSession(host, onClose, qName) })
      }
    }
    else if (b.dataset.d) remote.send({ t: 'display', id: b.dataset.d })
    else if (b.dataset.m === 'send') pick.click()
    else if (b.dataset.m === 'pull') { remote.send({ t: 'pull' }); say('Hộp chọn tệp đang mở trên máy chủ — chọn tệp ở đó') }
    else if (b.dataset.m === 'clipUp') void pushClip(true)
    else if (b.dataset.m === 'clipDown') navigator.clipboard.writeText(clipRemote).then(() => say(clipRemote ? 'Đã chép clipboard của máy chủ' : 'Máy chủ chưa chép gì'), () => say('Trình duyệt không cho ghi clipboard'))
    else if (b.dataset.m === 'shot') screenshot()
    else if (b.dataset.m === 'rec') toggleRec()
    else if (b.dataset.m === 'privacy') remote.send({ t: 'privacy', on: !privacyOn })
    else if (b.dataset.m === 'power') showPower()
    else if (b.dataset.m === 'info') { remote.send({ t: 'sysinfo' }); say('Đang lấy thông tin…', 2000) }
    else if (b.dataset.m === 'term') openTerm()
    else if (b.dataset.m === 'game') toggleGame()
    else if (b.dataset.m === 'wol') void showWol()
    else if (b.dataset.m === 'tv') showTvs()
    else if (b.dataset.m === 'anno') setAnno(!!anno.hidden)
    else if (b.dataset.m === 'tcp') showTcp()
    else if (b.dataset.m === 'update' && update) {
      if (!update.auto) say('Máy chủ này không tự cập nhật được (chỉ bản cài Windows) — tải bản mới ở trang Releases trên GitHub', 8000)
      else if (confirm(`Cập nhật ZeroPort trên máy chủ lên ${update.latest}? Máy chủ tự tải, cài và chạy lại — phiên sẽ ngắt khoảng 1 phút.`)) remote.send({ t: 'update' })
    }
  }, sig)
  bar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button')
    if (!b) return
    const a = b.dataset.a
    if (b.id === 'grip') {
      bar.classList.toggle('min')
      menu.hidden = true
      if (!reducedMotion()) bar.animate([{ transform: 'translateX(-50%) scale(0.97)' }, { transform: 'translateX(-50%) scale(1)' }], { duration: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
    }
    else if (a === 'menu' || a === 'quality' || a === 'screen' || a === 'more') showMenu(a)
    else if (a === 'kb') document.activeElement === kb ? kb.blur() : focusKb()
    else if (a === 'touch') { trackpad = !trackpad; b.textContent = trackpad ? 'Trackpad' : 'Chạm' }
    else if (a === 'sound') { video.muted = !video.muted; b.innerHTML = video.muted ? I.muted : I.sound }
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

  // Back (browser, phone, TV remote): close what is open, on a TV go to the toolbar, and only then leave the session.
  history.pushState({ zp: 'session' }, '')
  addEventListener('popstate', () => {
    if (!menu.hidden) hideMenu()
    else if (panel.open) panel.close()
    else if (remoteOnly && !bar.contains(document.activeElement)) bar.querySelector<HTMLElement>('button:not([hidden])')?.focus()
    else return close()
    history.pushState({ zp: 'session' }, '')
  }, sig)

  function close() {
    releaseAll()
    rec?.stop()
    if (!anno.hidden) remote.send({ t: 'anno', close: true })
    offTcp?.()
    zp?.tcpCloseAll(tcpSid)
    if (accFrame) cancelAnimationFrame(accFrame)
    if (document.pointerLockElement) document.exitPointerLock()
    if (panel.open) panel.close()
    if (otpDlg.open) otpDlg.close()
    clearInterval(tick)
    ac.abort()
    remote.close()
    // Closed by a button: neutralise the entry Back would have used. (history.back() here would land on the next
    // session's entry when reopening at once — codec switch — and close that one.)
    if (history.state?.zp === 'session') history.replaceState(null, '')
    if (document.fullscreenElement) void document.exitFullscreen()
    root.hidden = true
    root.innerHTML = ''
    onClose()
  }
}
