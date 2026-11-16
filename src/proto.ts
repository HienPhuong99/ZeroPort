// Shared by host and controller: encodings, pairing codes, signaling envelope, auth MAC.
// Security model: docs/PLAN.md §2. The signaling service is untrusted; everything it carries is sealed.

export const te = new TextEncoder()
export const td = new TextDecoder()
export const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))

export function b64(u: Uint8Array): string {
  let s = ''
  for (const b of u) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const unb64 = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export function cat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}

// ---- pairing ----------------------------------------------------------------------------------

export interface Keys { sig: CryptoKey; auth: CryptoKey }
export interface Pairing { hostId: string; devId: string; secret: string }

export const CONTROLLER_URL = 'https://hienphuong99.github.io/ZeroPort/'
export const pairingCode = (p: Pairing) => `v1.${p.hostId}.${p.devId}.${p.secret}`
export const pairingLink = (p: Pairing) => `${CONTROLLER_URL}#p=${pairingCode(p)}`

/** Accepts a bare code or any URL/text containing one. */
export function parsePairing(text: string): Pairing | null {
  const m = /v1\.([\w-]{22})\.([\w-]{11})\.([\w-]{43})/.exec(text)
  return m ? { hostId: m[1], devId: m[2], secret: m[3] } : null
}

export async function deriveKeys(secret: string, hostId: string): Promise<Keys> {
  const base = await crypto.subtle.importKey('raw', unb64(secret), 'HKDF', false, ['deriveKey'])
  const hk = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: unb64(hostId), info: te.encode(info) })
  return {
    sig: await crypto.subtle.deriveKey(hk('zeroport/v1/sig'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    auth: await crypto.subtle.deriveKey(hk('zeroport/v1/auth'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']),
  }
}

// ---- signaling envelope -----------------------------------------------------------------------

export type SigType = 'hello' | 'offer' | 'answer' | 'ice' | 'bye'
export interface Envelope { v: 1; to: 'h' | 'c'; d: string; t: SigType; iv: string; ct: string }

const aad = (hostId: string, e: Pick<Envelope, 'to' | 't' | 'd'>) => te.encode(`zp1|${e.to}|${e.t}|${hostId}|${e.d}`)

export async function seal(k: CryptoKey, hostId: string, devId: string, to: 'h' | 'c', t: SigType, body: unknown): Promise<Envelope> {
  const iv = rand(12)
  const head = { to, t, d: devId }
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(hostId, head) }, k, te.encode(JSON.stringify(body)))
  return { v: 1, ...head, iv: b64(iv), ct: b64(new Uint8Array(ct)) }
}

/** Returns null for anything forged, malformed or sealed for a different host/device/direction/type. */
export async function open(k: CryptoKey, hostId: string, e: Envelope): Promise<any | null> {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv), additionalData: aad(hostId, e) }, k, unb64(e.ct))
    return JSON.parse(td.decode(pt))
  } catch {
    return null
  }
}

// ---- in-channel auth, bound to both DTLS certificates -----------------------------------------

export function fingerprint(sdp: string): Uint8Array {
  const m = /^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)\s*$/m.exec(sdp)
  if (!m) throw new Error('no sha-256 fingerprint in SDP')
  return Uint8Array.from(m[1].split(':'), (h) => parseInt(h, 16))
}

const macInput = (dir: 'c2h' | 'h2c', first: Uint8Array, second: Uint8Array, fpH: Uint8Array, fpC: Uint8Array, sid: string) =>
  cat(te.encode(`zp1|${dir}`), first, second, fpH, fpC, unb64(sid))

export async function authMac(k: CryptoKey, ...a: Parameters<typeof macInput>): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', k, macInput(...a))))
}
export async function authVerify(k: CryptoKey, mac: string, ...a: Parameters<typeof macInput>): Promise<boolean> {
  try { return await crypto.subtle.verify('HMAC', k, unb64(mac), macInput(...a)) } catch { return false }
}

// ---- data-channel messages --------------------------------------------------------------------

/** Input events, controller → host. Coordinates are 0..1 within the shared display. */
export type Input =
  | { t: 'mm'; x: number; y: number }          // absolute move
  | { t: 'mr'; dx: number; dy: number }        // relative move (game mouse)
  | { t: 'mb'; b: 0 | 1 | 2; d: 0 | 1 }        // button: left, middle, right
  | { t: 'mw'; dx: number; dy: number }        // wheel, CSS pixels
  | { t: 'k'; c: string; d: 0 | 1 }            // physical key by KeyboardEvent.code
  | { t: 'tx'; s: string; bs?: number }        // Unicode text, preceded by `bs` backspaces

/** Clipboard text larger than this is not synced (one data-channel message must stay well under 256 KB). */
export const CLIP_MAX = 60_000

export const INPUT_TYPES = new Set(['mm', 'mr', 'mb', 'mw', 'k', 'tx'])
export type Ctl = { t: string; [k: string]: any }

export const STUN: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }]
