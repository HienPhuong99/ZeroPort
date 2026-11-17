// Framed TCP-over-DataChannel multiplexor (P2, controller Electron ↔ host).
// Wire format: [type:1][connId:u32be][payload...]. Types: 1=OPEN(u16be port), 2=DATA, 3=CLOSE.
export const T_OPEN = 1, T_DATA = 2, T_CLOSE = 3
const CHUNK = 16 * 1024
// A data channel throws (and the bytes are gone) once ~16 MB is queued, which would silently corrupt a TCP stream.
const HIGH = 4 << 20

export interface TunnelHandlers {
  onOpen?(id: number, port: number): void
  onData(id: number, bytes: Uint8Array): void
  onClose(id: number): void
}

export function frame(type: number, id: number, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(5 + (payload?.byteLength ?? 0))
  const dv = new DataView(out.buffer)
  dv.setUint8(0, type)
  dv.setUint32(1, id)
  if (payload?.byteLength) out.set(payload, 5)
  return out
}

export function makeTunnel(ch: RTCDataChannel, h: TunnelHandlers) {
  ch.binaryType = 'arraybuffer'
  ch.bufferedAmountLowThreshold = HIGH / 2
  ch.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 5) return
    const dv = new DataView(e.data)
    const type = dv.getUint8(0), id = dv.getUint32(1)
    if (type === T_OPEN && e.data.byteLength >= 7) h.onOpen?.(id, dv.getUint16(5))
    else if (type === T_DATA) h.onData(id, new Uint8Array(e.data, 5))
    else if (type === T_CLOSE) h.onClose(id)
  }
  const drained = () => new Promise<void>((res) => {
    const done = () => { ch.removeEventListener('bufferedamountlow', done); ch.removeEventListener('close', done); res() }
    ch.addEventListener('bufferedamountlow', done)
    ch.addEventListener('close', done)
  })
  // One queue for all connections: frames keep their order (a CLOSE can never overtake the last DATA) and each
  // call resolves only once its bytes are in the channel with room to spare — callers use that as the signal
  // to read more from the socket (see tcpAck in electron/system.js).
  let q: Promise<unknown> = Promise.resolve()
  const put = (...frames: Uint8Array<ArrayBuffer>[]) => (q = q.then(async () => {
    for (const f of frames) {
      if (ch.bufferedAmount > HIGH) await drained()
      if (ch.readyState === 'open') ch.send(f)
    }
  }).catch(() => {}))
  return {
    open(id: number, port: number) {
      const p = new Uint8Array(2)
      new DataView(p.buffer).setUint16(0, port)
      return put(frame(T_OPEN, id, p))
    },
    data(id: number, bytes: Uint8Array) {
      const frames = []
      for (let o = 0; o < bytes.byteLength; o += CHUNK) frames.push(frame(T_DATA, id, bytes.subarray(o, o + CHUNK)))
      return put(...frames)
    },
    close: (id: number) => put(frame(T_CLOSE, id)),
  }
}
