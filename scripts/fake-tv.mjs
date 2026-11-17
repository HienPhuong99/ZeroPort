// A minimal DLNA media renderer for tests (test/cast.test.mjs, scripts/e2e.mjs): answers SSDP searches, accepts
// SetAVTransportURI / Play / Stop, and on Play reads the stream it was given for `readMs`, like a TV would.
import dgram from 'node:dgram'
import http from 'node:http'

export async function fakeTv({ name = 'ZeroPort Test TV', readMs = 4000 } = {}) {
  const actions = []
  let uri = '', onStream
  const stream = new Promise((r) => (onStream = r))
  const server = http.createServer((req, res) => {
    if (req.url === '/desc.xml') {
      res.writeHead(200, { 'content-type': 'text/xml' })
      return res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>
        <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>${name}</friendlyName>
        <serviceList><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/rc</controlURL></service>
        <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/ctl</controlURL></service></serviceList>
        </device></root>`)
    }
    let body = ''
    req.on('data', (c) => (body += c)).on('end', () => {
      const action = /#(\w+)"?$/.exec(req.headers.soapaction ?? '')?.[1] ?? '?'
      actions.push(action)
      if (action === 'SetAVTransportURI') uri = /<CurrentURI>([^<]*)</.exec(body)[1].replace(/&#38;|&amp;/g, '&')
      if (action === 'Play') void read(uri).then(onStream, onStream)
      res.writeHead(200, { 'content-type': 'text/xml' }).end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body/></s:Envelope>')
    })
  })
  await new Promise((r) => server.listen(0, r))
  const loc = `http://127.0.0.1:${server.address().port}/desc.xml`

  async function read(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(readMs + 5000) })
    const parts = [], reader = r.body.getReader(), end = Date.now() + readMs
    while (Date.now() < end) {
      const { value, done } = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({}), end - Date.now()))])
      if (done) break
      if (value) parts.push(value)
    }
    void reader.cancel().catch(() => {})
    return { status: r.status, headers: Object.fromEntries(r.headers), bytes: Buffer.concat(parts) }
  }

  // SSDP: Windows' own SSDP service also holds 1900, so share the port.
  const ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise((r) => ssdp.bind(1900, r))
  ssdp.addMembership('239.255.255.250')
  ssdp.on('message', (m, from) => {
    if (!/^M-SEARCH/.test(m.toString()) || !/MediaRenderer|ssdp:all/.test(m.toString())) return
    ssdp.send(`HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=60\r\nLOCATION: ${loc}\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:zp-fake-tv\r\n\r\n`, from.port, from.address)
  })

  return { loc, name, actions, stream, uri: () => uri, close: () => { server.close(); ssdp.close() } }
}
