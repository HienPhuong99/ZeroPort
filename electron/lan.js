// LAN signaling: lets a controller on the same network reach this host with no Internet (docs/PLAN.md §8).
// It only relays sealed envelopes, exactly like Supabase does, so it is just as untrusted and needs no auth of its own.
//   POST /m           one envelope (JSON, sent as text/plain so the browser skips the CORS preflight)
//   GET  /m?d=<devId> server-sent events: envelopes for that device
//   GET  /tv/<token>  screen stream for a TV (electron/cast.js); anything else is 404
import http from 'node:http'
import os from 'node:os'

export const PORT = 47800
const MAX_BODY = 64 << 10, MAX_SUBS = 32
const subs = new Set() // { d, res }
let server = null, port = 0

/** `onEnvelope(env)` for each POSTed envelope; `onTv(token, req, res)` returns false if the token is not live. */
export function start(onEnvelope, onTv) {
  server = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    const url = new URL(req.url, 'http://x')
    if (req.method === 'POST' && url.pathname === '/m') return post(req, res, onEnvelope)
    if (req.method === 'GET' && url.pathname === '/m') return subscribe(url.searchParams.get('d') ?? '', req, res)
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/tv/') && onTv(url.pathname.slice(4), req, res)) return
    res.writeHead(404).end()
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 0 // SSE and TV streams stay open
  // 47800 when free, so a controller's saved address stays valid across restarts; any port otherwise (second instance).
  return new Promise((resolve) => {
    server.once('error', () => server.listen(0, () => resolve((port = server.address().port))))
    server.listen(PORT, () => resolve((port = PORT)))
  }).then((p) => { server.on('error', (e) => console.warn('lan', e)); return p })
}

function post(req, res, onEnvelope) {
  const chunks = []
  let n = 0
  req.on('data', (c) => { n += c.length; if (n > MAX_BODY) req.destroy(); else chunks.push(c) })
  req.on('end', () => {
    res.writeHead(204).end()
    try {
      const env = JSON.parse(Buffer.concat(chunks).toString())
      // Shape only; host.ts opens (and authenticates) every envelope before trusting any of it.
      if (env?.v === 1 && env.to === 'h' && ['d', 't', 'iv', 'ct'].every((k) => typeof env[k] === 'string')) onEnvelope(env)
    } catch {}
  })
}

function subscribe(d, req, res) {
  if (!/^[\w-]{11}$/.test(d)) return res.writeHead(400).end()
  // A stranger on the LAN can only hold slots open: drop the oldest rather than lock out the owner.
  if (subs.size >= MAX_SUBS) { const old = subs.values().next().value; subs.delete(old); old.res.end() }
  const sub = { d, res }
  subs.add(sub)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  res.write(': zp\n\n')
  const keep = setInterval(() => res.write(': k\n\n'), 25_000)
  req.on('close', () => { clearInterval(keep); subs.delete(sub) })
}

/** Envelope from this host to one controller (env.d), on every open subscription of that device. */
export function send(env) {
  const line = `data: ${JSON.stringify(env)}\n\n`
  for (const s of subs) if (s.d === env.d) s.res.write(line)
}

/** "ip:port" for each IPv4 LAN address of this machine. */
export function addrs() {
  if (!port) return []
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => `${a.address}:${port}`)
}

export function stop() { server?.close(); for (const s of subs) s.res.end(); subs.clear() }
