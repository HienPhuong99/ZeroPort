// Video wall (P2): live view-only grid of multiple hosts simultaneously. Clicking any tile opens full control.
import { connect, type Remote } from './controller'
import type { HostEntry } from './store'

const root = document.getElementById('wall')!
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function openWall(hosts: HostEntry[], onPick: (h: HostEntry) => void, onClose: () => void) {
  root.hidden = false
  root.innerHTML = `
    <div id="wall-bar">
      <strong>Tường màn hình (${hosts.length} máy)</strong>
      <button id="wall-close" class="danger">Đóng</button>
    </div>
    <div id="wall-grid">
      ${hosts.map((h, i) => `
        <div class="wtile" data-i="${i}">
          <video autoplay playsinline muted disablepictureinpicture></video>
          <div class="wcap"><span class="wname">${esc(h.name)}</span><span class="wstat">Đang kết nối…</span></div>
        </div>`).join('')}
    </div>`

  const remotes: Remote[] = hosts.map((h, i) => {
    const tile = root.querySelector<HTMLElement>(`.wtile[data-i="${i}"]`)!
    const video = tile.querySelector('video')!
    const stat = tile.querySelector('.wstat')!
    const r = connect(h, {
      state(s, detail) {
        stat.textContent = detail || { connecting: 'Đang kết nối…', connected: 'Trực tuyến', offline: 'Ngoại tuyến', rejected: 'Bị từ chối', closed: 'Đã đóng', otp: 'Cần mã 2FA — bấm để mở' }[s]
        if (s === 'connected') r.send({ t: 'quality', kbps: 1200, fps: 15, scale: 2, smooth: true })
      },
      stream(ms) { if (video.srcObject !== ms) video.srcObject = ms; void video.play().catch(() => {}) },
      file() {},
      ctl() {},
    })
    tile.onclick = () => { teardown(); onPick(h) }
    return r
  })

  function teardown() {
    remotes.forEach((r) => r.close())
    root.hidden = true
    root.innerHTML = ''
  }
  root.querySelector<HTMLElement>('#wall-close')!.onclick = () => { teardown(); onClose() }
}
