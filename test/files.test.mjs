// Unit tests for src/files.ts: chunked transfer round-trip and overflow protection.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTransfer } from '../src/files.ts'

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
