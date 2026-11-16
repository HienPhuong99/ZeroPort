// Signaling over Supabase Realtime. One shared channel per host id; messages are sealed envelopes (proto.ts).
// The publishable key is public by design — nothing here is trusted.
import { createClient } from '@supabase/supabase-js'
import type { Envelope } from './proto'

export const supa = createClient('https://reeurnccjlaqalgdsnzw.supabase.co', 'sb_publishable_0UBIWzlFlan-seCdzjGbuA_RQktJBck', {
  auth: { persistSession: false, autoRefreshToken: false },
})

export interface Link {
  send(env: Envelope): void
  onMsg(fn: (env: Envelope) => void): () => void
  /** Host presence as seen on this channel. */
  online: boolean
  onPresence(fn: (online: boolean) => void): () => void
}

const links = new Map<string, Link>()

/** `announce` is set only by the host itself: it publishes presence so controllers see it online. */
export function link(hostId: string, announce?: { name: string }): Link {
  let l = links.get(hostId)
  if (l) return l
  const msgFns = new Set<(e: Envelope) => void>(), presFns = new Set<(o: boolean) => void>()
  const ch = supa.channel(`zp-${hostId}`, { config: { broadcast: { self: false }, presence: { key: 'host' } } })
  l = {
    online: false,
    send: (env) => void ch.send({ type: 'broadcast', event: 'm', payload: env }),
    onMsg: (fn) => (msgFns.add(fn), () => msgFns.delete(fn)),
    onPresence: (fn) => (presFns.add(fn), fn(l!.online), () => presFns.delete(fn)),
  }
  ch.on('broadcast', { event: 'm' }, ({ payload }) => msgFns.forEach((fn) => fn(payload as Envelope)))
  ch.on('presence', { event: 'sync' }, () => {
    l!.online = !!ch.presenceState().host?.length
    presFns.forEach((fn) => fn(l!.online))
  })
  ch.subscribe((status) => { if (status === 'SUBSCRIBED' && announce) void ch.track(announce) })
  links.set(hostId, l)
  return l
}
