// Cast this screen to a smart TV over DLNA/UPnP (docs/PLAN.md §8): find renderers with SSDP, then tell one to play
// http://<lan-ip>:<port>/tv/<token>.mp4, a live H.264 fMP4 the renderer process records from the screen capture.
// The token is 128 random bits per cast and dies with it; nothing else on the LAN server serves video.
import dgram from 'node:dgram'
import os from 'node:os'
import { randomBytes } from 'node:crypto'

const TIMEOUT = 5000
/** Renderers seen by the last search, by id; a viewer can only pick one of these (never an arbitrary URL). */
let found = new Map()
let cur = null // { id, name, control, token, url, res?, rid }
let rid = 0

const tag = (xml, name) => new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i').exec(xml)?.[1]?.trim() ?? ''
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const get = (url) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })

/** [{ id, name }] of DLNA media renderers that answer within ~3 s. */
export async function find() {
  const locs = await new Promise((resolve) => {
    const out = new Set(), s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    s.on('message', (m) => {
      const loc = /^location:\s*(\S+)/im.exec(m.toString())?.[1]
      if (loc && /^http:\/\//.test(loc)) out.add(loc)
    })
    s.on('error', () => resolve(out))
    s.bind(() => {
      const st = 'urn:schemas-upnp-org:device:MediaRenderer:1'
      const msg = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
      s.send(msg, 1900, '239.255.255.250')
      setTimeout(() => s.send(msg, 1900, '239.255.255.250'), 700) // UDP: say it twice
    })
    setTimeout(() => { s.close(); resolve(out) }, 3000)
  })
  const list = await Promise.all([...locs].map(async (loc) => {
    try {
      const desc = await (await get(loc)).text()
      // The AVTransport service block; its controlURL may be relative to URLBase or to the description's own URL.
      const svc = desc.split(/<service>/i).find((b) => /urn:schemas-upnp-org:service:AVTransport:1/.test(b))
      if (!svc) return null
      const control = new URL(tag(svc, 'controlURL'), tag(desc, 'URLBase') || loc).href
      return { id: loc, name: unxml(tag(desc, 'friendlyName')) || new URL(loc).hostname, control }
    } catch { return null }
  }))
  found = new Map(list.filter(Boolean).map((r) => [r.id, r]))
  return [...found.values()].map(({ id, name }) => ({ id, name }))
}

async function soap(control, action, args) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID>${Object.entries(args).map(([k, v]) => `<${k}>${xml(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`
  const r = await fetch(control, {
    method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"` },
  })
  if (r.ok) return
  const why = /<errorDescription>([^<]*)/.exec(await r.text().catch(() => ''))?.[1]
  throw new Error(`TV từ chối ${action} (${r.status}${why ? ': ' + why : ''})`)
}

/** The local address on the TV's subnet (a TV cannot reach a VPN or virtual adapter address). */
function localFor(tvHost, port) {
  const mine = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal)
  const n = (ip) => ip.split('.').reduce((x, o) => (x << 8) + +o, 0) >>> 0
  const hit = mine.find((a) => ((n(a.address) ^ n(tvHost)) & n(a.netmask)) === 0) ?? mine[0]
  if (!hit) throw new Error('Máy này không có địa chỉ mạng LAN')
  return `${hit.address}:${port}`
}

// DLNA.ORG_FLAGS: streaming transfer mode, no seeking (live).
const DLNA = 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000'

/** Starts casting to renderer `id` (from find()); `port` is the LAN server's. Returns the TV's name. */
export async function start(id, port, recorder) {
  const tv = found.get(id)
  if (!tv) throw new Error('Không thấy TV này nữa — tìm lại')
  await stop()
  const token = randomBytes(16).toString('hex')
  const url = `http://${localFor(new URL(tv.control).hostname, port)}/tv/${token}.mp4`
  const mine = (cur = { ...tv, token, url, recorder })
  // stop() or another start() may run while the TV is answering: the newer call wins, this one backs out.
  const gone = async () => { if (cur === mine) return false; await soap(tv.control, 'Stop', {}).catch(() => {}); return true }
  const meta = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>ZeroPort — ${xml(os.hostname())}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:video/mp4:${DLNA}">${xml(url)}</res></item></DIDL-Lite>`
  try {
    await soap(tv.control, 'SetAVTransportURI', { CurrentURI: url, CurrentURIMetaData: meta })
    if (await gone()) throw new Error('Đã huỷ')
    await soap(tv.control, 'Play', { Speed: 1 })
    if (await gone()) throw new Error('Đã huỷ')
  } catch (e) { if (cur === mine) { endStream(mine); cur = null } throw e }
  return tv.name
}

export async function stop() {
  const c = cur
  cur = null
  if (!c) return
  endStream(c)
  await soap(c.control, 'Stop', {}).catch(() => {}) // the TV may already be off
}

export const casting = () => (cur ? { id: cur.id, name: cur.name } : null)

function endStream(c) {
  if (!c.res) return
  c.recorder.end(c.rid)
  c.res.end()
  c.res = null
}

/** lan.js hands over GET/HEAD /tv/<path>: serve it if it is the live token, else return false (404). */
export function serve(path, req, res) {
  const c = cur
  if (!c || path !== `${c.token}.mp4`) return false
  res.useChunkedEncodingByDefault = false // many TVs choke on chunked; a live stream simply ends when the connection closes
  res.writeHead(200, { 'content-type': 'video/mp4', 'transfermode.dlna.org': 'Streaming', 'contentfeatures.dlna.org': DLNA, 'accept-ranges': 'none', connection: 'close', 'cache-control': 'no-store' })
  if (req.method === 'HEAD') return res.end(), true
  // A TV often probes and then reconnects: each GET gets a fresh recording that starts with its own init segment.
  endStream(c)
  c.res = res
  c.rid = ++rid
  c.recorder.begin(c.rid)
  const gone = () => { if (c.res === res) { c.recorder.end(c.rid); c.res = null } }
  req.on('close', gone)
  res.on('error', gone) // TV vanished mid-write (ECONNRESET/EPIPE): must not reach the main process as uncaught
  return true
}

/** A chunk of recording `id` from the renderer. */
export function data(id, chunk) {
  const c = cur
  if (!c?.res || c.rid !== id || c.res.destroyed || c.res.writableEnded) return
  // ponytail: a TV that stops reading is cut off at 32 MB queued; pause the recorder instead if that bites.
  if (c.res.writableLength > 32 << 20) return endStream(c)
  c.res.write(Buffer.from(chunk))
}
