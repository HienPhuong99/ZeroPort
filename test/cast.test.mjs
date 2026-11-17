// DLNA cast (electron/cast.js) against a fake renderer: discovery, SOAP calls, token-guarded stream, stop.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import * as cast from '../electron/cast.js'
import { fakeTv } from '../scripts/fake-tv.mjs'

test('find, cast, serve only the live token, stop', async () => {
  const tv = await fakeTv({ readMs: 1500 })
  // stand-in for electron/lan.js: GET /tv/<path> goes to cast.serve
  const srv = http.createServer((req, res) => {
    if (!req.url.startsWith('/tv/') || !cast.serve(req.url.slice(4), req, res)) res.writeHead(404).end()
  })
  await new Promise((r) => srv.listen(0, r))
  const port = srv.address().port
  // stand-in for the renderer's MediaRecorder: a fake init segment, then a chunk every 100 ms
  const rec = { begun: [], ended: [], timer: null,
    begin(id) { this.begun.push(id); cast.data(id, Buffer.from('\0\0\0\x18ftypisom')); this.timer = setInterval(() => cast.data(id, Buffer.alloc(1000, 7)), 100) },
    end(id) { this.ended.push(id); clearInterval(this.timer) } }
  try {
    const list = await cast.find()
    const me = list.find((t) => t.id === tv.loc)
    assert.ok(me, `fake TV not discovered (got ${JSON.stringify(list)})`)
    assert.equal(me.name, tv.name)
    await assert.rejects(cast.start('http://evil.example/desc.xml', port, rec), /Không thấy TV/) // ids only from find()

    assert.equal(await cast.start(me.id, port, rec), tv.name)
    assert.deepEqual(tv.actions, ['SetAVTransportURI', 'Play'])
    assert.match(tv.uri(), new RegExp(`^http://[\\d.]+:${port}/tv/[0-9a-f]{32}\\.mp4$`))
    const got = await tv.stream
    assert.equal(got.status, 200)
    assert.equal(got.headers['content-type'], 'video/mp4')
    assert.equal(got.headers['transfer-encoding'], undefined, 'chunked encoding confuses TVs')
    assert.equal(got.bytes.subarray(4, 8).toString(), 'ftyp')
    assert.ok(got.bytes.length > 5000, `only ${got.bytes.length} bytes streamed`)

    const wrong = await fetch(`http://127.0.0.1:${port}/tv/${'0'.repeat(32)}.mp4`)
    assert.equal(wrong.status, 404)
    await cast.stop()
    assert.equal(tv.actions.at(-1), 'Stop')
    assert.equal(cast.casting(), null)
    const dead = await fetch(tv.uri().replace(/\/\/[\d.]+:/, '//127.0.0.1:'))
    assert.equal(dead.status, 404, 'stream still served after stop')
    assert.deepEqual(rec.begun, [1])
    assert.deepEqual(rec.ended, [1])

    // stop() while start() is still talking to the TV: start backs out and the TV ends up stopped, not playing
    const racing = cast.start(me.id, port, rec)
    await new Promise((r) => setImmediate(r)) // start() is now waiting on the TV
    await cast.stop()
    await assert.rejects(racing, /Đã huỷ/)
    assert.equal(cast.casting(), null)
    assert.equal(tv.actions.at(-1), 'Stop')
  } finally {
    clearInterval(rec.timer)
    tv.close()
    srv.close()
  }
})
