// Unit tests for src/files.ts: chunked transfer round-trip and overflow protection.
import test from 'node:test'
import assert from 'node:assert/strict'
import { download, makeTransfer, openSink } from '../src/files.ts'

function mockPair() {
  const mk = () => ({ readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0, binaryType: 'arraybuffer', onmessage: null, send: () => {}, addEventListener: () => {} })
  const a = mk(), b = mk()
  a.send = (d) => queueMicrotask(() => b.onmessage?.({ data: d }))
  b.send = (d) => queueMicrotask(() => a.onmessage?.({ data: d }))
  return [a, b]
}

test('makeTransfer sends multi-chunk files intact', async () => {
  const [txCh, rxCh] = mockPair()
  const payload = new Uint8Array(40_000)
  for (let i = 0; i < payload.length; i++) payload[i] = i & 255
  let closedOk = null
  const chunks = []
  const done = new Promise((res) => {
    makeTransfer(rxCh, async () => ({
      write: async (c) => chunks.push(new Uint8Array(c)),
      close: async (ok) => { closedOk = ok; res() },
    }), () => {})
  })
  const tx = makeTransfer(txCh, async () => ({ write: async () => {}, close: async () => {} }), () => {})
  await tx.send('data.bin', payload.length, async (o, n) => payload.slice(o, o + n).buffer)
  await done
  assert.equal(closedOk, true)
  const out = Buffer.concat(chunks)
  assert.deepEqual(out, Buffer.from(payload))
})

test('makeTransfer aborts sink if receiver gets more bytes than header size', async () => {
  const [txCh, rxCh] = mockPair()
  let closedOk = null
  const done = new Promise((res) => {
    makeTransfer(rxCh, async () => ({
      write: async () => {},
      close: async (ok) => { closedOk = ok; res() },
    }), () => {})
  })
  txCh.send(JSON.stringify({ name: 'bad.bin', size: 4 }))
  txCh.send(new Uint8Array(10).buffer)
  await done
  assert.equal(closedOk, false)
})

test('makeTransfer discards a half-received file when the channel closes', async () => {
  const [txCh, rxCh] = mockPair()
  let onClose, closedOk = null
  rxCh.addEventListener = (type, fn) => { if (type === 'close') onClose = fn }
  const done = new Promise((res) => {
    makeTransfer(rxCh, async () => ({ write: async () => {}, close: async (ok) => { closedOk = ok; res() } }), () => {})
  })
  txCh.send(JSON.stringify({ name: 'half.bin', size: 100 }))
  txCh.send(new Uint8Array(10).buffer)
  await new Promise((r) => setTimeout(r, 10))
  onClose()
  await done
  assert.equal(closedOk, false)
})

test('openSink and download stream through zpAndroid when present', async () => {
  const saved = new Map()
  let next = 1
  globalThis.zpAndroid = {
    saveOpen: (name, mime) => { const id = next++; saved.set(id, { name, mime, chunks: [], ok: null }); return id },
    saveWrite: (id, b64) => { saved.get(id).chunks.push(Buffer.from(b64, 'base64')); return true },
    saveClose: (id, ok) => { saved.get(id).ok = ok; return true },
  }
  try {
    const sink = await openSink('photo.png')
    await sink.write(new Uint8Array([1, 2, 3]).buffer)
    await sink.close(true)
    assert.equal(saved.get(1).name, 'photo.png')
    assert.equal(saved.get(1).ok, true)
    assert.deepEqual(Buffer.concat(saved.get(1).chunks), Buffer.from([1, 2, 3]))

    const big = new Uint8Array(70_000)
    big.fill(7)
    await download(new Blob([big], { type: 'video/webm;codecs=vp9,opus' }), 'shot.webm')
    assert.equal(saved.get(2).name, 'shot.webm')
    assert.equal(saved.get(2).mime, 'video/webm') // parameters stripped for MediaStore
    assert.equal(saved.get(2).ok, true)
    assert.deepEqual(Buffer.concat(saved.get(2).chunks), Buffer.from(big))
  } finally {
    delete globalThis.zpAndroid
  }
})
