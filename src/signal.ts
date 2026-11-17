// Signaling: Supabase Realtime (one shared channel per host id) and, on the same network, the host's own LAN server
// (electron/lan.js) so two devices can meet with no Internet. Messages are sealed envelopes (proto.ts) on both paths;
// the publishable key is public by design and nothing here is trusted.
import { createClient } from '@supabase/supabase-js'
import type { Envelope } from './proto'

export const supa = createClient('https://reeurnccjlaqalgdsnzw.supabase.co', 'sb_publishable_0UBIWzlFlan-seCdzjGbuA_RQktJBck', {
  auth: { persistSession: false, autoRefreshToken: false },
})

export interface Link {
  send(env: Envelope): void
  onMsg(fn: (env: Envelope) => void): () => void
  /** Host presence as seen on this channel or on its LAN server. */
  online: boolean
  onPresence(fn: (online: boolean) => void): () => void
  /** Controller: also talk to the host's LAN server at these "ip:port" addresses (as device `devId`). */
  lan(devId: string, addrs?: string[]): void
}

const links = new Map<string, Link>()
const zp = (globalThis as any).zp
/** An https page (the GitHub Pages controller) may not call http:// — except inside the Android app, which allows it. */
const lanAllowed = location.protocol !== 'https:' || !!(globalThis as any).Capacitor?.isNativePlatform?.()

/** `announce` is set only by the host itself: it publishes presence so controllers see it online. */
export function link(hostId: string, announce?: { name: string }): Link {
  let l = links.get(hostId)
  if (l) return l
  const msgFns = new Set<(e: Envelope) => void>(), presFns = new Set<(o: boolean) => void>()
  const ch = supa.channel(`zp-${hostId}`, { config: { broadcast: { self: false }, presence: { key: 'host' } } })
  let supaOn = false, lanKey = ''
  const sources: EventSource[] = []
  // The same envelope can arrive on both paths; its random IV identifies it.
  const seen = new Set<string>()
  const deliver = (env: Envelope) => {
    if (!env || typeof env.iv !== 'string' || seen.has(env.iv)) return
    seen.add(env.iv)
    if (seen.size > 500) seen.delete(seen.values().next().value!)
    msgFns.forEach((fn) => fn(env))
  }
  const presence = () => {
    const on = supaOn || sources.some((s) => s.readyState === EventSource.OPEN)
    if (on === l!.online) return
    l!.online = on
    presFns.forEach((fn) => fn(on))
  }
  l = {
    online: false,
    send(env) {
      void ch.send({ type: 'broadcast', event: 'm', payload: env })
      if (announce) zp?.lanSend(env)
      for (const s of sources) {
        if (s.readyState !== EventSource.OPEN) continue
        void fetch(s.url.replace(/\?.*/, ''), { method: 'POST', body: JSON.stringify(env), headers: { 'content-type': 'text/plain' } }).catch(() => {})
      }
    },
    onMsg: (fn) => (msgFns.add(fn), () => msgFns.delete(fn)),
    onPresence: (fn) => (presFns.add(fn), fn(l!.online), () => presFns.delete(fn)),
    lan(devId, addrs = []) {
      const key = lanAllowed ? addrs.slice(0, 8).join() : ''
      if (key === lanKey) return
      lanKey = key
      sources.splice(0).forEach((s) => s.close())
      for (const a of key ? key.split(',') : []) {
        const s = new EventSource(`http://${a}/m?d=${encodeURIComponent(devId)}`)
        s.onopen = s.onerror = presence
        s.onmessage = (e) => { try { deliver(JSON.parse(e.data)) } catch {} }
        sources.push(s)
      }
      presence()
    },
  }
  ch.on('broadcast', { event: 'm' }, ({ payload }) => deliver(payload as Envelope))
  ch.on('presence', { event: 'sync' }, () => { supaOn = !!ch.presenceState().host?.length; presence() })
  ch.subscribe((status) => { if (status === 'SUBSCRIBED' && announce) void ch.track(announce) })
  if (announce) zp?.onLan(deliver)
  links.set(hostId, l)
  return l
}

