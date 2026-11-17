// Protocol unit tests: pairing parse, HKDF key derivation, AES-GCM envelope AAD checks, HMAC auth.
import test from 'node:test'
import assert from 'node:assert/strict'
import { authMac, authVerify, b64, deriveKeys, open, pairingCode, parsePairing, rand, seal } from '../src/proto.ts'

test('pairingCode round-trips through parsePairing', () => {
  const p = { hostId: b64(rand(16)), devId: b64(rand(8)), secret: b64(rand(32)) }
  const code = pairingCode(p)
  assert.deepEqual(parsePairing(`https://example.com/#p=${code}`), p)
  assert.equal(parsePairing('not-a-code'), null)
  // LAN addresses ride along after '@'; junk entries are dropped, the code itself still parses
  const lan = { ...p, lan: ['192.168.0.28:47800', '10.0.0.5:51234'] }
  assert.deepEqual(parsePairing(pairingCode(lan)), lan)
  assert.deepEqual(parsePairing(`${pairingCode(p)}@1.2.3:4,192.168.1.2:47800`)?.lan, ['192.168.1.2:47800'])
})

test('seal/open enforces AAD (direction, type, host, device)', async () => {
  const hostId = b64(rand(16)), devId = b64(rand(8)), secret = b64(rand(32))
  const keys = await deriveKeys(secret, hostId)
  const env = await seal(keys.sig, hostId, devId, 'h', 'hello', { sid: 's1', ts: 123 })
  assert.deepEqual(await open(keys.sig, hostId, env), { sid: 's1', ts: 123 })
  assert.equal(await open(keys.sig, hostId, { ...env, to: 'c' }), null)
  assert.equal(await open(keys.sig, hostId, { ...env, t: 'offer' }), null)
  assert.equal(await open(keys.sig, b64(rand(16)), env), null)
})

test('authMac / authVerify binds nonces, fingerprints and sid', async () => {
  const hostId = b64(rand(16)), secret = b64(rand(32)), sid = b64(rand(16))
  const { auth } = await deriveKeys(secret, hostId)
  const nh = rand(32), nc = rand(32), fpH = rand(32), fpC = rand(32)
  const mac = await authMac(auth, 'c2h', nh, nc, fpH, fpC, sid)
  assert.equal(await authVerify(auth, mac, 'c2h', nh, nc, fpH, fpC, sid), true)
  assert.equal(await authVerify(auth, mac, 'h2c', nh, nc, fpH, fpC, sid), false)
  assert.equal(await authVerify(auth, mac, 'c2h', nh, nc, fpC, fpH, sid), false)
})
