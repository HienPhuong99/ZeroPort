// Controller side: hosts this device is paired with. Keys are non-extractable CryptoKeys in IndexedDB.
import type { Keys } from './proto'

/**
 * `macs`: the host's network adapters as it last reported them, for Wake-on-LAN through another host.
 * `lan`: its LAN signaling addresses ("ip:port"), so it can be reached with no Internet.
 */
export interface HostEntry { hostId: string; devId: string; name: string; keys: Keys; added: number; macs?: string[]; lan?: string[]; /** AV1 instead of H.264 (historic name). */ prefer444?: boolean }

const db = new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('zeroport', 1)
  r.onupgradeneeded = () => r.result.createObjectStore('hosts', { keyPath: 'hostId' })
  r.onsuccess = () => res(r.result)
  r.onerror = () => rej(r.error)
})

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const req = fn((await db).transaction('hosts', mode).objectStore('hosts'))
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
}

export const listHosts = () => tx<HostEntry[]>('readonly', (s) => s.getAll())
export const saveHost = (h: HostEntry) => tx('readwrite', (s) => s.put(h))
export const removeHost = (hostId: string) => tx('readwrite', (s) => s.delete(hostId))
