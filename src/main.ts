// Home screen: paired hosts (controller role) and, inside the desktop app, this machine's host panel.
import './style.css'
import qrcode from 'qrcode-generator'
import { link } from './signal'
import { deriveKeys, parsePairing } from './proto'
import { listHosts, removeHost, saveHost, type HostEntry } from './store'
import { activeSessions, castInfo, castStop, castTo, findTvs, hostCfg, hostStats, installUpdate, isHost, newPairing, revoke, startHost, totpBegin, totpDisable, totpEnable, updateInfo, updateSettings, type LogEntry } from './host'
import { openSession } from './view'
import { openWall } from './wall'

const app = document.getElementById('app')!
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const when = (t: number) => new Date(t).toLocaleString('vi-VN')
function logLine(e: LogEntry) {
  const end = e.to === undefined ? 'đang kết nối' : e.to ? `${Math.max(1, Math.round((e.to - e.from) / 60_000))} phút` : 'không rõ lúc ngắt'
  return `<div class="sub">${when(e.from)} · <b style="color:var(--text)">${esc(e.dev)}</b> · ${end}</div>`
}
type ThemeMode = 'auto' | 'light' | 'dark'
const THEME_KEY = 'zp_theme'
const lightQuery = matchMedia('(prefers-color-scheme: light)')
let themeMode: ThemeMode = (localStorage.getItem(THEME_KEY) as ThemeMode) || 'auto'
if (!['auto', 'light', 'dark'].includes(themeMode)) themeMode = 'auto'
const effectiveTheme = (): 'light' | 'dark' => (themeMode === 'auto' ? (lightQuery.matches ? 'light' : 'dark') : themeMode)
function applyTheme(fade = false) {
  const effective = effectiveTheme()
  if (fade) {
    document.documentElement.classList.add('theme-fade')
    setTimeout(() => document.documentElement.classList.remove('theme-fade'), 260)
  }
  document.documentElement.dataset.theme = effective
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effective === 'light' ? '#cfdcf2' : '#080d1a')
}
async function toggleTheme(e: MouseEvent, btn: HTMLElement) {
  themeMode = effectiveTheme() === 'dark' ? 'light' : 'dark'
  localStorage.setItem(THEME_KEY, themeMode)
  const commit = () => {
    applyTheme()
    btn.setAttribute('aria-checked', String(effectiveTheme() === 'dark'))
  }
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const startVT = (document as any).startViewTransition?.bind(document)
  if (!startVT || reduce) { applyTheme(!reduce); btn.setAttribute('aria-checked', String(effectiveTheme() === 'dark')); return }
  const r = btn.getBoundingClientRect()
  const x = e.clientX > 0 ? e.clientX : r.left + r.width / 2
  const y = e.clientY > 0 ? e.clientY : r.top + r.height / 2
  const endR = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  const vt = startVT(commit)
  try {
    await vt.ready
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endR}px at ${x}px ${y}px)`] },
      { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
    )
  } catch {}
}
lightQuery.addEventListener('change', () => { if (themeMode === 'auto') applyTheme() })
applyTheme()

let hosts: HostEntry[] = []
let unwatch: (() => void)[] = []

export function toast(msg: string) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg })
  document.body.append(t)
  setTimeout(() => {
    t.classList.add('out')
    setTimeout(() => t.remove(), 220)
  }, 3300)
}

/** In-page replacement for window.prompt, which Electron does not implement. */
function ask(title: string, value = ''): Promise<string | null> {
  const dlg = document.getElementById('dlg') as HTMLDialogElement
  dlg.innerHTML = `<form method="dialog"><strong>${esc(title)}</strong>
    <input type="text" name="v" value="${esc(value)}" style="margin:12px 0" autocomplete="off">
    <div class="row" style="justify-content:flex-end"><button type="button" id="no">Huỷ</button><button class="primary" value="ok">OK</button></div></form>`
  const input = dlg.querySelector('input')!
  dlg.querySelector<HTMLElement>('#no')!.onclick = () => dlg.close('')
  dlg.returnValue = ''
  dlg.showModal()
  input.select()
  return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok' ? input.value.trim() || null : null), { once: true }))
}

async function addPairing(text: string) {
  const p = parsePairing(text)
  if (!p) return toast('Mã ghép cặp không hợp lệ')
  if (isHost && p.hostId === hostCfg().hostId) return toast('Đây là mã của chính máy này')
  await saveHost({ hostId: p.hostId, devId: p.devId, name: 'Máy mới', keys: await deriveKeys(p.secret, p.hostId), added: Date.now(), lan: p.lan })
  toast('Đã thêm máy')
  await render()
}

async function render() {
  hosts = await listHosts()
  unwatch.splice(0).forEach((off) => off())
  const cfg = isHost ? hostCfg() : null
  const busy = isHost ? activeSessions() : []
  const upd = isHost ? updateInfo() : null
  const tv = isHost ? castInfo() : null
  app.innerHTML = `
    <div class="row" style="align-items:center;justify-content:space-between;gap:12px">
      <h1><img src="icon-192.png" alt="">ZeroPort</h1>
      <button type="button" data-act="theme" class="theme-pill" role="switch" aria-checked="${effectiveTheme() === 'dark'}" aria-label="Chuyển chế độ sáng tối" title="Đổi giao diện Sáng / Tối">
        <span class="tp-stars" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="tp-clouds" aria-hidden="true"><i></i><i></i></span>
        <span class="tp-knob" aria-hidden="true"><span class="tp-crater"></span></span>
      </button>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;margin:28px 0 10px">
      <h2 style="margin:0">Máy của tôi</h2>
      ${hosts.length >= 2 ? '<button data-act="wall" class="sm">Tường màn hình</button>' : ''}
    </div>
    ${hosts.map((h) => `
      <div class="card" data-host="${h.hostId}">
        <span class="dot"></span>
        <div class="grow"><div class="name">${esc(h.name)}</div><div class="sub" data-status>Đang kiểm tra…</div></div>
        <button class="primary" data-act="connect">Kết nối</button>
        <button data-act="pop" title="Mở ở cửa sổ/tab mới">⧉</button>
        <button data-act="rename" title="Đổi tên">✎</button>
        <button class="danger" data-act="remove" title="Xoá">✕</button>
      </div>`).join('') || `<div class="empty">Chưa có máy nào. Mở ZeroPort trên máy cần điều khiển, bấm “Ghép thiết bị mới”, rồi quét QR hoặc dán mã vào đây.</div>`}
    <form class="row" id="add">
      <input type="text" name="code" placeholder="Dán mã hoặc link ghép cặp" autocomplete="off" spellcheck="false">
      <button>Thêm</button>
    </form>
    ${cfg ? `
      <h2>Máy này</h2>
      <div class="card">
        <span class="dot on"></span>
        <div class="grow"><div class="name">${esc(cfg.name)}</div>
          <div class="sub">${busy.length ? `Đang được điều khiển bởi ${esc(busy.join(', '))}` : 'Sẵn sàng nhận kết nối'}${tv ? ` · đang chiếu lên ${esc(tv.name)}` : ''}${upd ? ` · bản ${esc(upd.current)}` : ''}</div></div>
        ${upd?.available ? `<button data-act="update" title="Có bản mới trên GitHub">Cập nhật ${esc(upd.latest)}</button>` : ''}
        <button data-act="tv" title="Chiếu màn hình này lên Smart TV (DLNA) trong cùng mạng">${tv ? 'Dừng chiếu TV' : 'Chiếu lên TV'}</button>
        <button data-act="settings" title="Cài đặt">⚙</button>
        <button class="primary" data-act="pair">Ghép thiết bị mới</button>
      </div>
      ${cfg.devices.map((d) => `
        <div class="card" data-dev="${d.devId}">
          <div class="grow"><div class="name">${esc(d.name)}</div>
            <div class="sub">${d.seen ? `Kết nối gần nhất: ${new Date(d.seen).toLocaleString('vi-VN')}` : 'Chưa kết nối lần nào'}</div></div>
          <button class="danger" data-act="revoke">Thu hồi</button>
        </div>`).join('')}
      ${cfg.log?.length ? `<details class="card" style="display:block"><summary>Lịch sử kết nối (${cfg.log.length})</summary>${cfg.log.map(logLine).join('')}</details>` : ''}` : ''}
`
  for (const h of hosts) {
    const l = link(h.hostId)
    l.lan(h.devId, h.lan)
    unwatch.push(l.onPresence((on) => {
      const card = app.querySelector(`[data-host="${h.hostId}"]`)
      card?.querySelector('.dot')?.classList.toggle('on', on)
      const s = card?.querySelector('[data-status]')
      if (s) s.textContent = on ? 'Trực tuyến' : 'Ngoại tuyến'
    }))
  }
}

app.addEventListener('submit', (e) => {
  e.preventDefault()
  const input = (e.target as HTMLFormElement).elements.namedItem('code') as HTMLInputElement
  void addPairing(input.value)
})

app.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
  if (!btn) return
  const act = btn.dataset.act
  const host = hosts.find((h) => h.hostId === btn.closest<HTMLElement>('[data-host]')?.dataset.host)
  const devId = btn.closest<HTMLElement>('[data-dev]')?.dataset.dev
  if (act === 'connect' && host) openSession(host, render)
  else if (act === 'wall' && hosts.length) openWall(hosts, (h) => openSession(h, render), render)
  else if (act === 'pop' && host) window.open(`#c=${host.hostId}`, '_blank')
  else if (act === 'rename' && host) {
    const name = await ask('Tên máy', host.name)
    if (name) { await saveHost({ ...host, name }); await render() }
  } else if (act === 'remove' && host) {
    if (confirm(`Xoá “${host.name}” khỏi danh sách? Muốn kết nối lại phải ghép cặp lại.`)) { await removeHost(host.hostId); await render() }
  } else if (act === 'revoke' && devId) {
    if (confirm('Thu hồi quyền của thiết bị này? Nó sẽ bị ngắt và không kết nối lại được.')) await revoke(devId)
  } else if (act === 'update') {
    const u = updateInfo()
    if (!u?.auto) return toast('Chỉ bản cài Windows tự cập nhật được — tải bản mới ở trang Releases trên GitHub')
    const busy = activeSessions()
    if (!confirm(`Tải và cài ZeroPort ${u.latest}? Ứng dụng sẽ tự thoát rồi mở lại sau khi cài.${busy.length ? `

Đang kết nối: ${busy.join(', ')} — sẽ bị ngắt khoảng 1 phút.` : ''}`)) return
    toast('Đang tải bản cập nhật…')
    await installUpdate().catch((err) => toast(`Cập nhật thất bại: ${err?.message ?? err}`))
  } else if (act === 'tv') {
    if (castInfo()) await castStop().catch((err) => toast(`Không dừng được: ${err?.message ?? err}`))
    else await showTvs()
  } else if (act === 'theme') {
    void toggleTheme(e, btn)
  } else if (act === 'settings') await showSettings()
  else if (act === 'pair') {
    const name = await ask('Tên thiết bị sẽ điều khiển máy này', `Thiết bị ${hostCfg().devices.length + 1}`)
    if (name) showPairing(await newPairing(name))
  }
})

async function showSettings() {
  const zp = (window as any).zp, cfg = hostCfg()
  const dlg = document.getElementById('dlg') as HTMLDialogElement
  dlg.innerHTML = `<form method="dialog"><strong>Cài đặt máy này</strong>
    <label>Tên máy<input type="text" name="name" value="${esc(cfg.name)}" autocomplete="off"></label>
    <label class="check"><input type="checkbox" name="auto" ${(await zp.autostartGet()) ? 'checked' : ''}> Tự chạy khi đăng nhập (ẩn ở khay hệ thống)</label>
    <label class="check"><input type="checkbox" name="lock" ${cfg.lockOnEnd ? 'checked' : ''}> Khoá máy khi người cuối cùng ngắt kết nối</label>
    <div class="row" style="align-items:center;justify-content:space-between;margin:12px 0">
      <span class="sub">Xác thực 2 lớp (TOTP): <b style="color:var(--text)">${cfg.totp ? 'Đang bật' : 'Đang tắt'}</b></span>
      <button type="button" id="totp" class="${cfg.totp ? 'danger' : ''}">${cfg.totp ? 'Tắt 2FA' : 'Bật 2FA…'}</button>
    </div>
    <label>Máy chủ TURN/STUN — JSON, để trống dùng mặc định. Chỉ cần khi mạng không nối trực tiếp được.
      <textarea name="ice" rows="4" spellcheck="false" placeholder='[{"urls":"turn:…","username":"…","credential":"…"}]'>${esc(cfg.iceServers ? JSON.stringify(cfg.iceServers) : '')}</textarea></label>
    <div class="row" style="justify-content:flex-end"><button type="button" id="no">Huỷ</button><button class="primary" value="ok">Lưu</button></div></form>`
  const f = dlg.querySelector('form')!.elements as any
  dlg.querySelector<HTMLElement>('#no')!.onclick = () => dlg.close('')
  dlg.querySelector<HTMLElement>('#totp')!.onclick = async () => {
    if (cfg.totp) {
      if (!confirm('Tắt xác thực 2 lớp khi kết nối tới máy này?')) return
      await totpDisable(); toast('Đã tắt xác thực 2 lớp'); dlg.close('')
    } else {
      dlg.close('')
      showTotp()
    }
  }
  dlg.returnValue = ''
  dlg.showModal()
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return
    try {
      await updateSettings(f.name.value.trim(), f.ice.value, f.lock.checked)
      await zp.autostartSet(f.auto.checked)
      toast('Đã lưu')
    } catch (err: any) { toast(`Không lưu được: ${err?.message ?? err}`) }
  }, { once: true })
}

async function showTvs() {
  const dlg = document.getElementById('dlg') as HTMLDialogElement
  dlg.innerHTML = `<form method="dialog"><strong>Chiếu lên TV</strong><div class="sub" id="tvs" style="margin:12px 0">Đang tìm Smart TV (DLNA) trong mạng…</div>
    <div class="row" style="justify-content:flex-end"><button>Đóng</button></div></form>`
  dlg.showModal()
  const list = await findTvs().catch(() => [])
  const box = dlg.querySelector('#tvs')
  if (!box || !dlg.open) return
  box.innerHTML = list.length
    ? list.map((t) => `<button type="button" class="witem" data-tv="${esc(t.id)}" style="width:100%;margin-bottom:6px">${esc(t.name)}</button>`).join('')
    : 'Không thấy TV nào. TV phải bật, cùng mạng với máy này, và bật chia sẻ/DLNA (Samsung: “Smart View”/“Chia sẻ nội dung”, LG: “Chia sẻ màn hình”/“DLNA”). Windows sẽ hỏi tường lửa lần đầu — chọn Cho phép.'
  box.querySelectorAll<HTMLElement>('[data-tv]').forEach((b) => (b.onclick = async () => {
    b.textContent = 'Đang gửi tới TV…'
    try { await castTo(b.dataset.tv!); toast(`Đang chiếu lên ${castInfo()?.name}`); dlg.close() }
    catch (err: any) { b.textContent = `Lỗi: ${err?.message ?? err}` }
  }))
}

function showTotp() {
  const { secret, uri } = totpBegin()
  const qr = qrcode(0, 'M')
  qr.addData(uri)
  qr.make()
  const dlg = document.getElementById('dlg') as HTMLDialogElement
  dlg.innerHTML = `<form id="tf">
    <strong>Bật xác thực 2 lớp (TOTP)</strong>
    <div class="sub" style="margin-top:6px">Quét QR bằng Google Authenticator / 1Password / Bitwarden, rồi nhập mã 6 số để kích hoạt.</div>
    <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })}</div>
    <code>${esc(secret)}</code>
    <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Mã 6 số" required style="margin-bottom:12px">
    <div class="row" style="justify-content:flex-end"><button type="button" id="no">Huỷ</button><button class="primary">Kích hoạt</button></div></form>`
  dlg.querySelector<HTMLElement>('#no')!.onclick = () => dlg.close()
  dlg.querySelector<HTMLFormElement>('#tf')!.onsubmit = async (e) => {
    e.preventDefault()
    const code = dlg.querySelector<HTMLInputElement>('input')!.value.trim()
    if (await totpEnable(secret, code)) { toast('Đã bật xác thực 2 lớp'); dlg.close() }
    else toast('Mã chưa đúng — kiểm tra lại đồng hồ hoặc nhập mã mới')
  }
  dlg.showModal()
}

function showPairing(p: { code: string; link: string }) {
  const dlg = document.getElementById('dlg') as HTMLDialogElement
  const qr = qrcode(0, 'M')
  qr.addData(p.link)
  qr.make()
  dlg.innerHTML = `
    <strong>Ghép thiết bị mới</strong>
    <div class="sub">Quét bằng điện thoại, hoặc dán mã vào ô “Thêm” trong ZeroPort trên thiết bị kia. Mã này là chìa khoá — đừng gửi qua kênh công khai.</div>
    <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })}</div>
    <code>${esc(p.code)}</code>
    <div class="row" style="justify-content:flex-end"><button id="copy">Sao chép mã</button><button class="primary" id="done">Xong</button></div>`
  dlg.querySelector<HTMLElement>('#copy')!.onclick = () => navigator.clipboard.writeText(p.code).then(() => toast('Đã sao chép'))
  dlg.querySelector<HTMLElement>('#done')!.onclick = () => dlg.close()
  dlg.showModal()
}

async function boot() {
  Object.assign(window, { zpHostStats: hostStats })
  if (isHost) await startHost(() => void render())
  await render()
  app.classList.add('boot-in')
  app.addEventListener('animationend', () => app.classList.remove('boot-in'), { once: true })
  // Pairing links carry the secret in the fragment: consume it, then scrub it from the address bar and history.
  if (location.hash.startsWith('#p=')) {
    const text = location.hash
    history.replaceState(null, '', location.pathname + location.search)
    await addPairing(text)
  } else if (location.hash.startsWith('#c=')) {
    const id = location.hash.slice(3)
    history.replaceState(null, '', location.pathname + location.search)
    const target = hosts.find((h) => h.hostId === id)
    if (target) openSession(target, render)
  }
}
boot().catch((err) => { console.error(err); app.textContent = `Lỗi khởi động: ${err?.message ?? err}` })
