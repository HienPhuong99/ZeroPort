// Host engine. Runs only inside the Electron app (needs the `zp` preload bridge).
// Flow and threat model: docs/PLAN.md §2.
import { link, supa, type Link } from './signal'
import { makeTransfer, openSink } from './files'
import { makeTunnel } from './tunnel'
import { base32, otpauthUri, verifyTotp } from './totp'
import {
  authMac, authVerify, b64, CLIP_MAX, deriveKeys, fingerprint, INPUT_TYPES, open, pairingCode, pairingLink, rand, seal, STUN, unb64,
  type Ctl, type Envelope, type Input, type Keys, type SigType,
} from './proto'

export interface Device { devId: string; name: string; secret: string; added: number; seen?: number }
export interface HostCfg {
  hostId: string; name: string; devices: Device[]; iceServers?: RTCIceServer[]
  /** Second factor: base32 secret and the last accepted time step (replay guard). */
  totp?: { secret: string; last: number }
  /** Lock the workstation when the last viewer leaves. */
  lockOnEnd?: boolean
}

interface Session {
  sid: string; dev: Device; keys: Keys; pc: RTCPeerConnection; ctl: RTCDataChannel
  nh: Uint8Array; authed: boolean; held: Set<string>; timer?: ReturnType<typeof setTimeout>
  video: RTCRtpSender; audio: RTCRtpSender; files?: ReturnType<typeof makeTransfer>
  /** Device key verified, waiting for the TOTP code. */
  otp?: { tries: number }
  term?: boolean
  tcpCh?: RTCDataChannel
  tunnel?: ReturnType<typeof makeTunnel>
}

const zp = (window as any).zp
export const isHost = !!zp

let cfg: HostCfg
let sig: Link
let capture: MediaStream | null = null
let locked = false
let privacy = { privacy: false, blocked: false }
const keyCache = new Map<string, Keys>()
const sessions = new Map<string, Session>()
const seenSids = new Map<string, number>()
/** Devices that passed TOTP recently: a phone reconnecting after a trip to the background is not asked again. */
const otpGrace = new Map<string, number>()
const OTP_GRACE_MS = 10 * 60_000
let otpFails: number[] = []
let onChange = () => {}

export const hostCfg = () => cfg
const authed = () => [...sessions.values()].filter((s) => s.authed)
export const activeSessions = () => authed().map((s) => s.dev.name)
const tell = (s: Session, m: Ctl) => { if (s.ctl.readyState === 'open') s.ctl.send(JSON.stringify(m)) }
const tellAll = (m: Ctl) => authed().forEach((s) => tell(s, m))

/** Sender-side numbers for troubleshooting (and scripts/e2e.mjs). */
export async function hostStats() {
  const out: object[] = []
  for (const s of sessions.values()) {
    const row: Record<string, unknown> = { dev: s.dev.name, authed: s.authed, conn: s.pc.connectionState, track: s.video.track?.readyState ?? 'none' }
    ;(await s.pc.getStats()).forEach((r: any) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') Object.assign(row, { sent: r.framesSent, encoded: r.framesEncoded, enc: r.encoderImplementation, limit: r.qualityLimitationReason, w: r.frameWidth, h: r.frameHeight, bytes: r.bytesSent })
    })
    out.push(row)
  }
  return out
}

export async function startHost(changed: () => void) {
  onChange = changed
  cfg = (await zp.cfgGet()) ?? { hostId: b64(rand(16)), name: await zp.hostname(), devices: [] }
  await zp.cfgSet(cfg)
  sig = link(cfg.hostId, { name: cfg.name })
  sig.onMsg((env) => void onSignal(env).catch(console.error))
  zp.onLocked((v: boolean) => { locked = v; tellAll({ t: 'state', locked }) })
  zp.onTerm((sid: string, kind: string, data: unknown) => {
    const s = sessions.get(sid)
    if (!s?.authed) return
    if (kind === 'exit') { s.term = false; return tell(s, { t: 'term', exit: data }) }
    // One data-channel message must stay well under 256 KB.
    const text = String(data)
    for (let i = 0; i < text.length; i += 16_000) tell(s, { t: 'term', s: text.slice(i, i + 16_000) })
  })
  zp.onTcpHost((sid: string, kind: string, id: number, data: unknown) => {
    const s = sessions.get(sid)
    if (!s?.authed || !s.tunnel) return
    if (kind === 'data') s.tunnel.data(id, data as Uint8Array)
    else if (kind === 'close') s.tunnel.close(id)
  })
  // Free Supabase projects pause after a week without database traffic; Realtime alone may not count.
  const ping = () => void supa.rpc('ping')
  ping()
  setInterval(ping, 6 * 3600_000)
}

async function save() { await zp.cfgSet(cfg); onChange() }

/** Creates a slot for a new controller and returns what to show (QR/link/code). */
export async function newPairing(name: string) {
  const p = { hostId: cfg.hostId, devId: b64(rand(8)), secret: b64(rand(32)) }
  cfg.devices.push({ devId: p.devId, name, secret: p.secret, added: Date.now() })
  await save()
  return { code: pairingCode(p), link: pairingLink(p) }
}

export async function revoke(devId: string) {
  cfg.devices = cfg.devices.filter((d) => d.devId !== devId)
  keyCache.delete(devId)
  otpGrace.delete(devId)
  for (const s of sessions.values()) if (s.dev.devId === devId) end(s)
  await save()
}

/** `ice` is a JSON array of RTCIceServer (TURN credentials live only here, never in the public controller). */
export async function updateSettings(name: string, ice: string, lockOnEnd: boolean) {
  const servers = ice.trim() ? JSON.parse(ice) : undefined
  if (servers && !(Array.isArray(servers) && servers.every((x) => x && x.urls))) throw new Error('ICE servers phải là mảng JSON các { urls, username?, credential? }')
  cfg.name = name || cfg.name
  cfg.iceServers = servers
  cfg.lockOnEnd = lockOnEnd
  await save()
}

/** New TOTP secret for the setup dialog; nothing is stored until `totpEnable` sees a valid code from the app. */
export function totpBegin() {
  const secret = base32(rand(20))
  return { secret, uri: otpauthUri(secret, cfg.name) }
}
export async function totpEnable(secret: string, code: string) {
  const step = await verifyTotp(secret, code.replace(/\s/g, ''))
  if (step < 0) return false
  cfg.totp = { secret, last: step }
  otpGrace.clear()
  await save()
  return true
}
export async function totpDisable() { cfg.totp = undefined; await save() }

// ---- signaling --------------------------------------------------------------------------------

async function onSignal(env: Envelope) {
  if (env?.v !== 1 || env.to !== 'h' || typeof env.d !== 'string') return
  const dev = cfg.devices.find((d) => d.devId === env.d)
  if (!dev) return
  let keys = keyCache.get(dev.devId)
  if (!keys) keyCache.set(dev.devId, (keys = await deriveKeys(dev.secret, cfg.hostId)))
  const body = await open(keys.sig, cfg.hostId, env)
  if (!body || typeof body.sid !== 'string') return // forged or not for us: drop silently

  if (env.t === 'hello') {
    const now = Date.now()
    if (typeof body.ts !== 'number' || !Number.isFinite(body.ts) || Math.abs(now - body.ts) > 300_000 || seenSids.has(body.sid)) return // stale or replayed
    for (const [k, ts] of seenSids) if (now - ts > 310_000) seenSids.delete(k)
    if (seenSids.size >= 2000) seenSids.delete(seenSids.keys().next().value!)
    seenSids.set(body.sid, now)
    for (const s of sessions.values()) if (s.dev.devId === dev.devId && !s.authed) end(s) // one pending handshake per device
    if (sessions.size >= 16) return
    await startSession(dev, keys, body.sid)
    return
  }
  const s = sessions.get(body.sid)
  if (!s || s.dev.devId !== dev.devId) return
  if (env.t === 'answer') await s.pc.setRemoteDescription({ type: 'answer', sdp: body.sdp })
  else if (env.t === 'ice') await s.pc.addIceCandidate(body.c).catch(() => {})
  else if (env.t === 'bye') end(s)
}

async function startSession(dev: Device, keys: Keys, sid: string) {
  const iceServers = cfg.iceServers?.length ? cfg.iceServers : STUN
  const pc = new RTCPeerConnection({ iceServers })
  const send = async (t: SigType, body: object) => sig.send(await seal(keys.sig, cfg.hostId, dev.devId, 'c', t, { sid, ...body }))
  const ctl = pc.createDataChannel('ctl')
  const mv = pc.createDataChannel('mv', { ordered: false, maxRetransmits: 0 })
  const file = pc.createDataChannel('file')
  const tcpCh = pc.createDataChannel('tcp')
  // Media lines are negotiated up front with no track; tracks are attached only after auth succeeds.
  const video = pc.addTransceiver('video', { direction: 'sendonly' }).sender
  const audio = pc.addTransceiver('audio', { direction: 'sendonly' }).sender
  const s: Session = { sid, dev, keys, pc, ctl, nh: rand(32), authed: false, held: new Set(), video, audio, tcpCh }
  sessions.set(sid, s)

  pc.onicecandidate = (e) => { if (e.candidate) void send('ice', { c: e.candidate.toJSON() }) }
  pc.onconnectionstatechange = () => {
    clearTimeout(s.timer)
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') end(s)
    else if (pc.connectionState === 'disconnected') s.timer = setTimeout(() => end(s), 15_000)
  }
  ctl.onopen = () => {
    ctl.send(JSON.stringify({ t: 'chal', nh: b64(s.nh) }))
    setTimeout(() => { if (!s.authed && !s.otp) end(s) }, 10_000)
  }
  ctl.onmessage = (e) => void Promise.resolve().then(() => onCtl(s, file, JSON.parse(e.data))).catch((err) => { console.error(err); end(s) })
  mv.onmessage = (e) => { if (s.authed) try { input(s, JSON.parse(e.data)) } catch {} }
  setTimeout(() => { if (pc.connectionState !== 'connected') end(s) }, 30_000)

  await pc.setLocalDescription(await pc.createOffer())
  await send('offer', { sdp: pc.localDescription!.sdp, ice: iceServers })
}

function end(s: Session) {
  if (!sessions.delete(s.sid)) return
  clearTimeout(s.timer)
  for (const h of s.held) { // never leave a key or button stuck down on the host
    if (h.startsWith('b')) zp.input({ t: 'mb', b: +h.slice(1), d: 0 })
    else zp.input({ t: 'k', c: h, d: 0 })
  }
  if (s.term) zp.termClose(s.sid)
  if (s.tunnel) zp.tcpCloseAll(s.sid)
  if (s.authed && cfg.totp) otpGrace.set(s.dev.devId, Date.now() + OTP_GRACE_MS)
  s.pc.close()
  if (!sessions.size && capture) { capture.getTracks().forEach((t) => t.stop()); capture = null }
  if (s.authed && !authed().length) {
    // Nobody is watching any more: never leave the screen blacked out or the local keyboard frozen.
    if (privacy.privacy) void zp.privacy(false).then((p: typeof privacy) => (privacy = p))
    void zp.annotate({ close: true })
    if (cfg.lockOnEnd) void zp.power('lock').catch(console.warn)
  }
  syncSessions()
}

function syncSessions() {
  const n = authed().length
  zp.sessionCount(n)
  void watchClipboard(n > 0)
  onChange()
}

// ---- data channel -----------------------------------------------------------------------------

async function onCtl(s: Session, file: RTCDataChannel, m: Ctl) {
  if (!s.authed) {
    if (s.otp) return void (m.t === 'otp' && (await checkOtp(s, file, String(m.code ?? ''))))
    if (m.t !== 'auth') return
    const fpH = fingerprint(s.pc.localDescription!.sdp), fpC = fingerprint(s.pc.remoteDescription!.sdp)
    const nc = unb64(String(m.nc)) // throws on garbage → caller ends the session
    if (nc.length !== 32 || !(await authVerify(s.keys.auth, String(m.mac), 'c2h', s.nh, nc, fpH, fpC, s.sid))) return end(s)
    const needOtp = !!cfg.totp && !((otpGrace.get(s.dev.devId) ?? 0) > Date.now())
    tell(s, { t: 'ok', mac: await authMac(s.keys.auth, 'h2c', nc, s.nh, fpH, fpC, s.sid), ...(needOtp ? { otp: 1 } : {}) })
    if (!needOtp) return admit(s, file)
    s.otp = { tries: 0 }
    setTimeout(() => { if (!s.authed) end(s) }, 180_000)
    return
  }
  if (INPUT_TYPES.has(m.t)) return input(s, m as Input)
  if (Object.hasOwn(handlers, m.t)) await handlers[m.t](s, m)
}

async function checkOtp(s: Session, file: RTCDataChannel, code: string) {
  const now = Date.now()
  otpFails = otpFails.filter((t) => now - t < 15 * 60_000)
  // Global brake: 10 wrong codes in 15 minutes (any device) and every attempt is refused until they age out.
  if (otpFails.length >= 10) return tell(s, { t: 'otp', bad: 1, msg: 'Sai quá nhiều lần — thử lại sau 15 phút' })
  let step = await verifyTotp(cfg.totp!.secret, code, cfg.totp!.last)
  if (!s.otp || !sessions.has(s.sid)) return // ended, or another message already passed while we were checking
  if (step <= cfg.totp!.last) step = -1 // a parallel session used this code meanwhile
  if (step < 0) {
    otpFails.push(now)
    if (++s.otp!.tries >= 5) return end(s)
    return tell(s, { t: 'otp', bad: 1 })
  }
  cfg.totp!.last = step
  s.otp = undefined
  tell(s, { t: 'otp', ok: 1 })
  await admit(s, file)
}

/** Fully authenticated: from here on what the controller sends reaches the machine (files, input, clipboard). */
async function admit(s: Session, file: RTCDataChannel) {
  s.authed = true
  s.dev.seen = Date.now()
  s.files = makeTransfer(file, openSink, (dir, name, done, size) => {
    if (done >= size || done % (1 << 20) < 16 * 1024) tell(s, { t: 'xfer', dir: dir === 'up' ? 'down' : 'up', name, done, size })
  })
  if (s.tcpCh) s.tunnel = makeTunnel(s.tcpCh, {
    onOpen: (id, port) => zp.tcpHostOpen(s.sid, id, port),
    onData: (id, bytes) => zp.tcpHostSend(s.sid, id, bytes),
    onClose: (id) => zp.tcpHostDrop(s.sid, id),
  })
  await attachMedia(s)
  tell(s, { t: 'state', name: cfg.name, platform: zp.platform, locked, ...privacy, macs: await zp.macs(), ...(await zp.displays()) })
  syncSessions()
  void save()
}

function input(s: Session, m: Input) {
  if (!INPUT_TYPES.has(m.t)) return
  if (m.t === 'k') m.d ? s.held.add(m.c) : s.held.delete(m.c)
  if (m.t === 'mb') m.d ? s.held.add('b' + m.b) : s.held.delete('b' + m.b)
  zp.input(m)
}

const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined)

/** Post-auth control messages other than input. */
const handlers: Record<string, (s: Session, m: Ctl) => unknown> = {
  async display(_s, m) {
    await zp.selectDisplay(String(m.id))
    await recapture()
    tellAll({ t: 'state', ...(await zp.displays()) })
  },
  quality: (s, m) => tune(s.video, { kbps: num(m.kbps, 200, 50_000), fps: num(m.fps, 5, 120), scale: num(m.scale, 1, 4), smooth: !!m.smooth }),
  clip(_s, m) {
    clipLast = String(m.s ?? '').slice(0, CLIP_MAX)
    zp.clipWrite(clipLast)
  },
  /** The viewer asks for files: a native picker opens on this screen, which the viewer operates remotely. */
  async pull(s) {
    for (const f of await zp.filePick()) {
      await s.files!.send(f.name, f.size, (o, n) => zp.fileRead(f.id, o, n)).finally(() => zp.fileDone(f.id))
    }
  },
  /** lock | logoff | restart | shutdown — the controller asks for confirmation before sending. */
  async power(s, m) {
    try { await zp.power(String(m.cmd)); tell(s, { t: 'note', s: 'Đã gửi lệnh' }) } catch (e: any) { tell(s, { t: 'note', s: `Lệnh thất bại: ${e?.message ?? e}` }) }
  },
  async sysinfo(s) { tell(s, { t: 'sysinfo', ...(await zp.sysInfo()) }) },
  async kill(s, m) {
    try { await zp.kill(m.pid) } catch (e: any) { tell(s, { t: 'note', s: `Không kết thúc được: ${e?.message ?? e}` }) }
    tell(s, { t: 'sysinfo', ...(await zp.sysInfo()) })
  },
  async privacy(_s, m) {
    privacy = await zp.privacy(!!m.on)
    tellAll({ t: 'state', ...privacy })
  },
  async term(s, m) {
    if (m.open) { await zp.termOpen(s.sid); s.term = true }
    else if (m.close) { zp.termClose(s.sid); s.term = false }
    else if (s.term && typeof m.s === 'string') zp.termWrite(s.sid, m.s.slice(0, 64_000))
  },
  async wol(s, m) {
    const n = await zp.wake(m.macs)
    tell(s, { t: 'note', s: n ? `Đã gửi gói đánh thức (${n} địa chỉ MAC) vào mạng LAN của ${cfg.name}` : 'Không có địa chỉ MAC hợp lệ' })
  },
  anno: (_s, m) => void zp.annotate(m),
}

// ---- clipboard --------------------------------------------------------------------------------

let clipLast = ''
let clipTimer: ReturnType<typeof setInterval> | undefined
async function watchClipboard(on: boolean) {
  if (!on) { clearInterval(clipTimer); clipTimer = undefined; return }
  if (clipTimer) return
  // Electron has no clipboard-change event; a 1 s poll is cheap and only runs while someone is connected.
  clipTimer = setInterval(async () => {
    const t: string = await zp.clipRead()
    if (!t || t === clipLast || t.length > CLIP_MAX) return
    clipLast = t
    tellAll({ t: 'clip', s: t })
  }, 1000)
  clipLast = await zp.clipRead() // whatever is already there stays private until it changes
}

// ---- capture ----------------------------------------------------------------------------------

async function grab() {
  // Electron's display-media handler (electron/main.js) picks the screen; no picker is shown.
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 60 } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  }).catch(() => navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60 } } })) // no system audio available
}

async function attachMedia(s: Session) {
  capture ??= await grab()
  const [vt] = capture.getVideoTracks(), [at] = capture.getAudioTracks()
  vt.contentHint = 'detail'
  await s.video.replaceTrack(vt)
  if (at && at.readyState === 'live') await s.audio.replaceTrack(at)
  await tune(s.video, {})
}

async function recapture() {
  const old = capture
  capture = await grab()
  for (const s of authed()) await attachMedia(s)
  old?.getTracks().forEach((t) => t.stop())
}

/** Bitrate/fps/sharpness of one viewer's stream. `smooth` favours frame rate over resolution. */
async function tune(sender: RTCRtpSender, q: { kbps?: number; fps?: number; scale?: number; smooth?: boolean }) {
  const p = sender.getParameters()
  if (!p.encodings?.length) return
  p.degradationPreference = q.smooth ? 'maintain-framerate' : 'maintain-resolution'
  Object.assign(p.encodings[0], {
    maxBitrate: (q.kbps ?? 8000) * 1000,
    maxFramerate: q.fps ?? 60,
    scaleResolutionDownBy: q.scale ?? 1,
    priority: 'high',
    networkPriority: 'high',
  })
  if (sender.track) sender.track.contentHint = q.smooth ? 'motion' : 'detail'
  await sender.setParameters(p).catch(console.warn)
}
