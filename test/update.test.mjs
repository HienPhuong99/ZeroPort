import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newer, install, check } from '../electron/update.js'

test('newer compares numerically', () => {
  assert.equal(newer('0.2.10', '0.2.9'), true)
  assert.equal(newer('0.3.0', '0.2.99'), true)
  assert.equal(newer('0.2.3', '0.2.3'), false)
  assert.equal(newer('0.2.2', '0.2.3'), false)
  assert.equal(newer('1.0', '0.9.9'), true)
})

const release = (digest) => ({
  tag_name: 'v9.9.9',
  assets: [{ name: 'ZeroPort.Setup.9.9.9.exe', browser_download_url: 'https://example.invalid/setup.exe', digest }],
})
function fakeFetch(digest, body = 'not the real installer') {
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(url)
    return url.includes('api.github.com')
      ? { ok: true, json: async () => release(digest) }
      : { ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer }
  }
  return urls
}

test('check reports a newer release', async () => {
  fakeFetch('sha256:' + '0'.repeat(64))
  const c = await check('0.2.3', true)
  assert.equal(c.latest, '9.9.9')
  assert.equal(c.available, true)
})

test('install refuses a download whose SHA-256 does not match', async () => {
  const urls = fakeFetch('sha256:' + '0'.repeat(64))
  await assert.rejects(install('0.2.3'), /SHA-256 không khớp/)
  assert.equal(urls.length, 2) // release info + download, nothing run
})

test('install refuses a release without a digest', async () => {
  fakeFetch(undefined)
  await assert.rejects(install('0.2.3'), /SHA-256/)
})

test('install refuses when already up to date', async () => {
  fakeFetch('sha256:' + '0'.repeat(64))
  await assert.rejects(install('9.9.9'), /mới nhất/)
})
