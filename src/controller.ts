// Controller side of one remote session: signaling handshake, WebRTC, auth. UI lives in view.ts.
import { link } from './signal'
import { authMac, authVerify, b64, fingerprint, open, rand, seal, unb64, type Ctl, type Envelope, type Input, type SigType } from './proto'
import type { HostEntry } from './store'

export type ConnState = 'connecting' | 'connected' | 'offline' | 'rejected' | 'closed' | 'otp'

export interface Remote {
  send(m: Ctl | Input): void
  /** Lossy channel for pointer moves: newest wins, never queues behind a retransmit. */
  move(m: Input): void
  /** Answers the host's TOTP prompt (state 'otp'). */
  otp(code: string): void
  pc(): RTCPeerConnection | null
  close(): void
}

interface Events {
  state(s: ConnState, detail?: string): void
  stream(s: MediaStream): void
  ctl(m: Ctl): void
  /** The file-transfer channel of a new connection (see files.ts). */
  file(ch: RTCDataChannel): void
  /** Optional TCP tunnel channel (only used when the controller runs in Electron). */
  tcp?(ch: RTCDataChannel): void
}

export function connect(host: HostEntry, on: Events): Remote {
  const sig = link(host.hostId)
  sig.lan(host.devId, host.lan)
  let pc: RTCPeerConnection | null = null
  let ctl: RTCDataChannel | null = null, mv: RTCDataChannel | null = null
  let sid = '', closed = false, authed = false, tries = 0, otpWait = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let pendingIce: RTCIceCandidateInit[] = []
  let nonce: { nh: Uint8Array; nc: Uint8Array } | null = null
  let dialedAt = 0

  const send = async (t: SigType, body: object) => sig.send(await seal(host.keys.sig, host.hostId, host.devId, 'h', t, { sid, ...body }))

  function dial() {
    if (closed) return
    teardown()
    sid = b64(rand(16))
    authed = false
    otpWait = false
    dialedAt = Date.now()
    on.state('connecting')
    void send('hello', { ts: Date.now() })
    // No offer (host offline / asleep / signaling down) or no connection: try again with backoff.
    retry = setTimeout(() => { on.state('offline'); dial() }, Math.min(4000 + tries++ * 2000, 15_000))
  }

  function teardown() {
    clearTimeout(retry)
    pc?.close()
    pc = ctl = mv = null
    pendingIce = []
    nonce = null
  }

  // Phones suspend WebRTC in the background and networks change: on return, reconnect at once instead of waiting for a timeout.
  const wake = () => {
    if (closed || document.visibilityState !== 'visible' || Date.now() - dialedAt < 5000) return
    if (!authed || pc?.connectionState !== 'connected') { tries = 0; dial() }
  }
  document.addEventListener('visibilitychange', wake)
  addEventListener('online', wake)

  const offMsg = sig.onMsg((env) => void onSignal(env).catch(console.error))

  async function onSignal(env: Envelope) {
    if (env?.v !== 1 || env.to !== 'c' || env.d !== host.devId) return
    const body = await open(host.keys.sig, host.hostId, env)
    if (!body || body.sid !== sid) return
    if (env.t === 'offer' && !pc && typeof body.sdp === 'string' && Array.isArray(body.ice)) await answer(body.sdp, body.ice)
    else if (env.t === 'ice') pc?.remoteDescription ? await pc.addIceCandidate(body.c).catch(() => {}) : pendingIce.push(body.c)
  }

  async function answer(sdp: string, iceServers: RTCIceServer[]) {
    const p = (pc = new RTCPeerConnection({ iceServers }))
    p.onicecandidate = (e) => { if (e.candidate) void send('ice', { c: e.candidate.toJSON() }) }
    const media = new MediaStream() // the host's tracks arrive without a stream id: collect video + audio into one
    p.ontrack = (e) => {
      if ('jitterBufferTarget' in e.receiver) (e.receiver as any).jitterBufferTarget = 0 // lowest latency the browser allows
      media.addTrack(e.track)
      on.stream(media)
    }
    p.ondatachannel = ({ channel }) => {
      if (channel.label === 'mv') mv = channel
      if (channel.label === 'file') on.file(channel)
      if (channel.label === 'tcp') on.tcp?.(channel)
      if (channel.label !== 'ctl') return
      ctl = channel
      channel.onmessage = (e) => void Promise.resolve().then(() => onCtl(JSON.parse(e.data))).catch(console.error)
    }
    p.onconnectionstatechange = () => {
      if (p !== pc || closed) return
      if (p.connectionState === 'failed' || p.connectionState === 'closed') dial()
    }
    await p.setRemoteDescription({ type: 'offer', sdp })
    preferCodecs(p, !!host.prefer444)
    await p.setLocalDescription(await p.createAnswer())
    await send('answer', { sdp: p.localDescription!.sdp })
    for (const c of pendingIce.splice(0)) await p.addIceCandidate(c).catch(() => {})
  }

  async function onCtl(m: Ctl) {
    if (!pc || !ctl) return
    const fpH = () => fingerprint(pc!.remoteDescription!.sdp), fpC = () => fingerprint(pc!.localDescription!.sdp)
    if (m.t === 'chal' && !authed) {
      const nh = unb64(String(m.nh)), nc = rand(32)
      if (nh.length !== 32) return close()
      nonce = { nh, nc }
      ctl.send(JSON.stringify({ t: 'auth', nc: b64(nc), mac: await authMac(host.keys.auth, 'c2h', nh, nc, fpH(), fpC(), sid) }))
    } else if (m.t === 'ok' && !authed) {
      const n = nonce
      if (!n || !(await authVerify(host.keys.auth, String(m.mac), 'h2c', n.nc, n.nh, fpH(), fpC(), sid))) {
        close()
        return on.state('rejected', 'Máy chủ không chứng minh được danh tính — có thể bị nghe lén. Đã ngắt.')
      }
      authed = true
      tries = 0
      clearTimeout(retry)
      otpWait = !!m.otp
      on.state(otpWait ? 'otp' : 'connected')
    } else if (m.t === 'otp' && otpWait) {
      if (m.ok) { otpWait = false; on.state('connected') }
      else on.state('otp', m.msg ? String(m.msg) : 'Sai mã, thử lại')
    } else if (authed && !otpWait) on.ctl(m)
  }

  function close() {
    if (closed) return
    closed = true
    if (sid) void send('bye', {})
    offMsg()
    document.removeEventListener('visibilitychange', wake)
    removeEventListener('online', wake)
    teardown()
    on.state('closed')
  }

  dial()
  return {
    send: (m) => { if (authed && !otpWait && ctl?.readyState === 'open') ctl.send(JSON.stringify(m)) },
    move: (m) => { if (authed && !otpWait && mv?.readyState === 'open') mv.send(JSON.stringify(m)) },
    otp: (code) => { if (otpWait && ctl?.readyState === 'open') ctl.send(JSON.stringify({ t: 'otp', code })) },
    pc: () => pc,
    close,
  }
}

/**
 * The sender uses the first codec in our answer. Default H.264 (hardware encode and decode); `prefer444` asks for AV1.
 * Measured on Electron 45: the sender offers only AV1 profile 0 and VP9 profiles 0/2, i.e. 4:2:0 — real 4:4:4 is
 * decodable but not encodable, so this mode is sold as "AV1", not "4:4:4". The full-chroma profiles stay ranked
 * first so a future build that can encode them is picked up without a code change.
 */
function preferCodecs(pc: RTCPeerConnection, prefer444: boolean) {
  const tx = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')
  const caps = RTCRtpReceiver.getCapabilities?.('video')?.codecs
  if (!tx?.setCodecPreferences || !caps) return
  const order = prefer444 ? ['video/av1', 'video/vp9', 'video/h264', 'video/vp8'] : ['video/h264', 'video/av1', 'video/vp9', 'video/vp8']
  const rank = (c: { mimeType: string; sdpFmtpLine?: string }) => {
    const mime = c.mimeType.toLowerCase(), fmtp = c.sdpFmtpLine ?? ''
    // Only these profiles carry full chroma: AV1 High (profile=1), VP9 profile 1 (8-bit) and 3 (10-bit).
    if (prefer444 && ((mime === 'video/av1' && /(^|;)profile=1/.test(fmtp)) || (mime === 'video/vp9' && /profile-id=[13]/.test(fmtp)))) return -1
    return order.indexOf(mime) >>> 0
  }
  try { tx.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b))) } catch { /* keep browser default */ }
}
