// TOTP (RFC 6238, SHA-1, 6 digits, 30 s): the optional second factor checked by the host after device auth.
// Kept free of TS-only syntax beyond type annotations so `node --test` can load it directly.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32(u: Uint8Array): string {
  let bits = 0, v = 0, out = ''
  for (const b of u) {
    v = (v << 8) | b; bits += 8
    while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits) out += B32[(v << (5 - bits)) & 31]
  return out
}

export function unbase32(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '')
  const out: number[] = []
  let bits = 0, v = 0
  for (const c of clean) {
    const i = B32.indexOf(c)
    if (i < 0) throw new Error('bad base32')
    v = (v << 5) | i; bits += 5
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Uint8Array.from(out)
}

export const STEP = 30
export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP)

export async function totp(secret: Uint8Array, step: number, digits = 6): Promise<string> {
  const msg = new Uint8Array(8)
  new DataView(msg.buffer).setBigUint64(0, BigInt(step))
  const key = await crypto.subtle.importKey('raw', secret as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))
  const o = h[h.length - 1] & 15
  const n = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits
  return String(n).padStart(digits, '0')
}

/**
 * Returns the matching time step (±1 for clock drift), or -1. Steps at or before `after` are refused,
 * so a code seen over someone's shoulder cannot be replayed.
 */
export async function verifyTotp(secretB32: string, code: string, after = -1, now = Date.now()): Promise<number> {
  if (!/^\d{6}$/.test(code)) return -1
  const secret = unbase32(secretB32), t = stepAt(now)
  for (const s of [t, t - 1, t + 1]) if (s > after && (await totp(secret, s)) === code) return s
  return -1
}

export const otpauthUri = (secretB32: string, label: string) =>
  `otpauth://totp/${encodeURIComponent(`ZeroPort:${label}`)}?secret=${secretB32}&issuer=ZeroPort&algorithm=SHA1&digits=6&period=${STEP}`
