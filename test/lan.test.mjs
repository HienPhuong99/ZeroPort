// LAN signaling server (electron/lan.js): envelopes in, SSE out per device, and a stranger on the LAN can't crash it.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import * as lan from '../electron/lan.js'

const raw = (port, text) => new Promise((res) => {
  const c = net.connect(port, '127.0.0.1', () => c.write(text))
  let out = ''
  c.on('data', (d) => (out += d)).on('close', () => res(out)).on('error', () => res(out))
  setTimeout(() => c.destroy(), 1000)
})

/** Opens an SSE stream and collects its `data:` lines. */
function sse(port, d) {
  const got = [], ac = new AbortController()
  const done = fetch(`http://127.0.0.1:${port}/m?d=${d}`, { signal: ac.signal }).then(async (r) => {
    got.status = r.status
    for await (const chunk of r.body) for (const l of Buffer.from(chunk).toString().split('\n')) if (l.startsWith('data: ')) got.push(JSON.parse(l.slice(6)))
  }).catch(() => {}).finally(() => (got.closed = true))
  return Object.assign(got, { close: () => ac.abort(), done })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('envelopes, per-device SSE, malformed requests, per-address limit', async () => {
  const seen = []
  const port = await lan.start((env) => seen.push(env), () => false)
  try {
    assert.match(await raw(port, 'GET // HTTP/1.1\r\nHost: a\r\n\r\n'), /^HTTP\/1\.1 400/) // used to throw in the main process
    assert.match(await raw(port, 'GET /tv/x.mp4 HTTP/1.1\r\nHost: a\r\n\r\n'), /^HTTP\/1\.1 404/)
    const pre = await fetch(`http://127.0.0.1:${port}/m`, { method: 'OPTIONS', headers: { 'access-control-request-private-network': 'true' } })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true')

    const env = { v: 1, to: 'h', d: 'AAAAAAAAAAA', t: 'hello', iv: 'i', ct: 'c' }
    await fetch(`http://127.0.0.1:${port}/m`, { method: 'POST', body: JSON.stringify(env) })
    await fetch(`http://127.0.0.1:${port}/m`, { method: 'POST', body: '{not json' })
    await fetch(`http://127.0.0.1:${port}/m`, { method: 'POST', body: JSON.stringify({ ...env, to: 'c' }) })
    await sleep(100)
    assert.deepEqual(seen, [env])

    const a = sse(port, 'AAAAAAAAAAA'), b = sse(port, 'BBBBBBBBBBB')
    await sleep(200)
    lan.send({ v: 1, to: 'c', d: 'AAAAAAAAAAA', t: 'offer', iv: '1', ct: 'x' })
    await sleep(200)
    assert.deepEqual(a.map((e) => e.iv), ['1'])
    assert.equal(b.length, 0)

    // same address: the 5th stream pushes out the oldest (a) instead of being refused
    const more = [1, 2, 3].map(() => sse(port, 'CCCCCCCCCCC'))
    await sleep(300)
    assert.ok(a.closed, 'oldest stream of this address was not dropped')
    assert.ok(!b.closed)
    for (const s of [b, ...more]) s.close()
    assert.match(await raw(port, 'GET /m?d=bad HTTP/1.1\r\nHost: a\r\n\r\n'), /^HTTP\/1\.1 400/)
    assert.ok(lan.addrs().every((x) => x.endsWith(`:${port}`)))
  } finally { lan.stop() }
})
