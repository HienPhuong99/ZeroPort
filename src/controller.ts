// Controller side of one remote session: signaling handshake, WebRTC, auth. UI lives in view.ts.
import { link } from './signal'
import { authMac, authVerify, b64, fingerprint, open, rand, seal, unb64, type Ctl, type Envelope, type Input, type SigType } from './proto'
import type { HostEntry } from './store'

export type ConnState = 'connecting' | 'connected' | 'offline' | 'rejected' | 'closed'

export interface Remote {
  send(m: Ctl | Input): void
  /** Lossy channel for pointer moves: newest wins, never queues behind a retransmit. */
  move(m: Input): void
  pc(): RTCPeerConnection | null
  close(): void
}

interface Events {
  state(s: ConnState, detail?: string): void
  stream(s: MediaStream): void
  ctl(m: Ctl): void
}

export function connect(host: HostEntry, on: Events): Remote {
  const sig = link(host.hostId)
  let pc: RTCPeerConnection | null = null
  let ctl: RTCDataChannel | null = null, mv: RTCDataChannel | null = null
  let sid = '', closed = false, authed = false, tries = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let pendingIce: RTCIceCandidateInit[] = []
  let nonce: { nh: Uint8Array; nc: Uint8Array } | null = null

  const send = async (t: SigType, body: object) => sig.send(await seal(host.keys.sig, host.hostId, host.devId, 'h', t, { sid, ...body }))

  function dial() {
    if (closed) return
    teardown()
    sid = b64(rand(16))
    authed = false
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

  const offMsg = sig.onMsg((env) => void onSignal(env).catch(console.error))

  async function onSignal(env: Envelope) {
    if (env?.v !== 1 || env.to !== 'c' || env.d !== host.devId) return
    const body = await open(host.keys.sig, host.hostId, env)
    if (!body || body.sid !== sid) return
    if (env.t === 'offer' && !pc) await answer(body.sdp, body.ice)
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
      if (channel.label !== 'ctl') return
      ctl = channel
      channel.onmessage = (e) => void onCtl(JSON.parse(e.data)).catch(console.error)
    }
    p.onconnectionstatechange = () => {
      if (p !== pc || closed) return
      if (p.connectionState === 'failed' || p.connectionState === 'closed') dial()
    }
    await p.setRemoteDescription({ type: 'offer', sdp })
    preferCodecs(p)
    await p.setLocalDescription(await p.createAnswer())
    await send('answer', { sdp: p.localDescription!.sdp })
    for (const c of pendingIce.splice(0)) await p.addIceCandidate(c).catch(() => {})
  }

  async function onCtl(m: Ctl) {
    if (!pc || !ctl) return
    const fpH = () => fingerprint(pc!.remoteDescription!.sdp), fpC = () => fingerprint(pc!.localDescription!.sdp)
    if (m.t === 'chal' && !authed) {
      const nh = unb64(String(m.nh)), nc = rand(32)
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
      on.state('connected')
    } else if (authed) on.ctl(m)
  }

  function close() {
    if (closed) return
    closed = true
    if (sid) void send('bye', {})
    offMsg()
    teardown()
    on.state('closed')
  }

  dial()
  return {
    send: (m) => { if (authed && ctl?.readyState === 'open') ctl.send(JSON.stringify(m)) },
    move: (m) => { if (authed && mv?.readyState === 'open') mv.send(JSON.stringify(m)) },
    pc: () => pc,
    close,
  }
}

/** The sender uses the first codec in our answer. H.264 first: hardware decode on every phone. */
function preferCodecs(pc: RTCPeerConnection) {
  const tx = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')
  const caps = RTCRtpReceiver.getCapabilities?.('video')?.codecs
  if (!tx?.setCodecPreferences || !caps) return
  const rank = (c: { mimeType: string }) => ['video/h264', 'video/av1', 'video/vp9', 'video/vp8'].indexOf(c.mimeType.toLowerCase()) >>> 0
  try { tx.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b))) } catch { /* keep browser default */ }
}
