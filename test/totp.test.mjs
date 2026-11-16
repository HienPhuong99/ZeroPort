// RFC 6238 test vectors (SHA-1 seed "12345678901234567890") and the replay/drift rules of verifyTotp.
import test from 'node:test'
import assert from 'node:assert/strict'
import { base32, unbase32, totp, verifyTotp, stepAt } from '../src/totp.ts'

const seed = new TextEncoder().encode('12345678901234567890')

test('base32 round-trips', () => {
  assert.equal(base32(seed), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.deepEqual(unbase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), seed)
})

test('RFC 6238 vectors (8 digits)', async () => {
  for (const [t, want] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [20000000000, '65353130']]) {
    assert.equal(await totp(seed, Math.floor(t / 30), 8), want)
  }
})

test('verifyTotp: drift window and replay protection', async () => {
  const b32 = base32(seed), now = 1234567890_000, s = stepAt(now)
  const code = await totp(seed, s)
  assert.equal(await verifyTotp(b32, code, -1, now), s)
  assert.equal(await verifyTotp(b32, code, -1, now + 30_000), s) // previous step still accepted
  assert.equal(await verifyTotp(b32, code, -1, now + 90_000), -1) // too old
  assert.equal(await verifyTotp(b32, code, s, now), -1)           // already used
  assert.equal(await verifyTotp(b32, 'abcdef', -1, now), -1)
})
