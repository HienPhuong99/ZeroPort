// Unit tests for src/tunnel.ts: binary framing (OPEN / DATA / CLOSE) and multi-chunk splitting.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTunnel } from '../src/tunnel.ts'

test('makeTunnel frames OPEN, DATA (>16KB split) and CLOSE accurately', () => {
  const mk = () => ({ readyState: 'open', binaryType: 'arraybuffer', onmessage: null, send: () => {} })
  const a = mk(), b = mk()
  a.send = (d) => b.onmessage?.({ data: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) })
  b.send = (d) => a.onmessage?.({ data: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) })

  const events = []
  const rx = makeTunnel(b, {
    onOpen: (id, port) => events.push(['open', id, port]),
    onData: (id, bytes) => events.push(['data', id, bytes.length]),
    onClose: (id) => events.push(['close', id]),
  })
  const tx = makeTunnel(a, { onData: () => {}, onClose: () => {} })

  tx.open(42, 2222)
  tx.data(42, new Uint8Array(20_000))
  tx.close(42)
  rx.close(99) // verify rx channel exists

  assert.deepEqual(events, [
    ['open', 42, 2222],
    ['data', 42, 16384],
    ['data', 42, 3616],
    ['close', 42],
  ])
})
