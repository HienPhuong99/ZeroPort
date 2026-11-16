// Framed TCP-over-DataChannel multiplexor (P2, controller Electron ↔ host).
// Wire format: [type:1][connId:u32be][payload...]. Types: 1=OPEN(u16be port), 2=DATA, 3=CLOSE.
export const T_OPEN = 1, T_DATA = 2, T_CLOSE = 3
const CHUNK = 16 * 1024

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
  ch.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 5) return
    const dv = new DataView(e.data)
    const type = dv.getUint8(0), id = dv.getUint32(1)
    if (type === T_OPEN && e.data.byteLength >= 7) h.onOpen?.(id, dv.getUint16(5))
    else if (type === T_DATA) h.onData(id, new Uint8Array(e.data, 5))
    else if (type === T_CLOSE) h.onClose(id)
  }
  const sendRaw = (buf: Uint8Array<ArrayBuffer>) => { if (ch.readyState === 'open') ch.send(buf) }
  return {
    open(id: number, port: number) {
      const p = new Uint8Array(2)
      new DataView(p.buffer).setUint16(0, port)
      sendRaw(frame(T_OPEN, id, p))
    },
    data(id: number, bytes: Uint8Array) {
      for (let o = 0; o < bytes.byteLength; o += CHUNK) sendRaw(frame(T_DATA, id, bytes.subarray(o, o + CHUNK)))
    },
    close(id: number) { sendRaw(frame(T_CLOSE, id)) },
  }
}
