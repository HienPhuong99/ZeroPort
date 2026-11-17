// File transfer over one ordered, reliable data channel. The two directions are independent:
// each is a JSON header string {name,size} followed by exactly `size` bytes of binary chunks.
const CHUNK = 16 * 1024 // safe message size in every browser
const HIGH = 8 << 20

export interface Sink { write(chunk: ArrayBuffer): Promise<unknown>; close(ok: boolean): Promise<unknown> }
export type Progress = (dir: 'up' | 'down', name: string, done: number, size: number) => void
export type Reader = (offset: number, length: number) => Promise<ArrayBuffer | Uint8Array>

export function makeTransfer(ch: RTCDataChannel, open: (name: string, size: number) => Promise<Sink>, progress: Progress) {
  ch.binaryType = 'arraybuffer'
  ch.bufferedAmountLowThreshold = HIGH / 2
  let rx: { name: string; size: number; got: number; sink: Sink } | null = null
  // ponytail: chunks queue in memory if the disk is slower than the network; add receiver acks if that ever happens.
  let chain: Promise<unknown> = Promise.resolve()
  ch.onmessage = (e) => {
    chain = chain.then(() => onMsg(e.data)).catch(async (err) => {
      console.error('transfer failed', err)
      await rx?.sink.close(false).catch(() => {})
      rx = null
    })
  }
  // The connection died mid-file: release the handle and delete the partial file.
  ch.addEventListener('close', () => { chain = chain.then(async () => { await rx?.sink.close(false).catch(() => {}); rx = null }) })
  async function onMsg(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      if (rx) await rx.sink.close(false) // the sender started over
      const h = JSON.parse(data), name = String(h.name), size = Number(h.size)
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('bad header')
      rx = { name, size, got: 0, sink: await open(name, size) }
    } else if (rx) {
      if (rx.got + data.byteLength > rx.size) throw new Error('transfer size overflow')
      await rx.sink.write(data)
      rx.got += data.byteLength
    } else return
    progress('down', rx.name, rx.got, rx.size)
    if (rx.got >= rx.size) { const done = rx; rx = null; await done.sink.close(done.got === done.size) }
  }

  let sending: Promise<unknown> = Promise.resolve()
  /** Queues one file; resolves when its last byte has been handed to the channel. */
  const send = (name: string, size: number, read: Reader) =>
    (sending = sending.catch(() => {}).then(async () => {
      ch.send(JSON.stringify({ name, size }))
      for (let o = 0; o < size; o += CHUNK) {
        if (ch.bufferedAmount > HIGH) await new Promise((r) => ch.addEventListener('bufferedamountlow', r, { once: true }))
        if (ch.readyState !== 'open') throw new Error('channel closed')
        ch.send((await read(o, Math.min(CHUNK, size - o))) as ArrayBuffer)
        progress('up', name, Math.min(size, o + CHUNK), size)
      }
      progress('up', name, size, size)
    }))
  return { send }
}

const zp = (globalThis as any).zp
const zpAndroid = () => (globalThis as any).zpAndroid as {
  saveOpen(name: string, mime: string): number
  saveWrite(id: number, b64: string): boolean
  saveClose(id: number, ok: boolean): boolean
} | undefined

function toBase64(u: Uint8Array): string {
  let s = ''
  for (const b of u) s += String.fromCharCode(b)
  return btoa(s)
}

/** Where received files go: straight to disk in desktop/Android apps, otherwise memory then a browser download. */
export async function openSink(name: string): Promise<Sink> {
  if (zp) {
    const id = await zp.fileOpen(name)
    return { write: (c) => zp.fileWrite(id, c), close: (ok) => zp.fileClose(id, ok) }
  }
  const android = zpAndroid()
  if (android) {
    const id = android.saveOpen(name, 'application/octet-stream')
    if (id < 0) throw new Error('android saveOpen failed')
    return {
      write: async (c) => { if (!android.saveWrite(id, toBase64(new Uint8Array(c)))) throw new Error('android saveWrite failed') },
      close: async (ok) => { android.saveClose(id, ok) },
    }
  }
  // ponytail: whole file held in memory in browsers (fine to ~1 GB on desktop, less on phones); the desktop/Android apps stream.
  const parts: ArrayBuffer[] = []
  return {
    write: async (c) => void parts.push(c),
    close: async (ok) => { if (ok) await download(new Blob(parts), name) },
  }
}

export async function download(blob: Blob, name: string) {
  const android = zpAndroid()
  if (android) {
    const id = android.saveOpen(name, blob.type || 'application/octet-stream')
    if (id < 0) throw new Error('android saveOpen failed')
    let ok = false
    try {
      for (let o = 0; o < blob.size; o += 65_536) {
        const chunk = new Uint8Array(await blob.slice(o, o + 65_536).arrayBuffer())
        if (!android.saveWrite(id, toBase64(chunk))) throw new Error('android saveWrite failed')
      }
      ok = true
    } finally {
      android.saveClose(id, ok)
    }
    return
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
}
