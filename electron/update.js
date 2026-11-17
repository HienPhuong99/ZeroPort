// Self-update from this repo's GitHub Releases (Windows NSIS build only). The URL is fixed here, never taken from a
// viewer: an authenticated viewer can only say "update now", not "run this file".
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import os from 'node:os'

const API = 'https://api.github.com/repos/HienPhuong99/ZeroPort/releases/latest'

/** True when version `a` is newer than `b` ("0.2.10" > "0.2.9"). */
export function newer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}

let cache = null, cachedAt = 0
/** { latest, exe? } from GitHub, cached for an hour (the API allows 60 unauthenticated calls an hour). */
export async function latest(force = false) {
  if (!force && cache && Date.now() - cachedAt < 3600_000) return cache
  const r = await fetch(API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ZeroPort' } })
  if (!r.ok) throw new Error(`GitHub trả về ${r.status}`)
  const j = await r.json()
  const exe = j.assets?.find((a) => /^ZeroPort\.Setup\.[\d.]+\.exe$/.test(a.name))
  cache = { latest: String(j.tag_name).replace(/^v/, ''), exe: exe && { url: exe.browser_download_url, sha256: String(exe.digest ?? '').replace(/^sha256:/, '') } }
  cachedAt = Date.now()
  return cache
}

export async function check(current, packaged) {
  const l = await latest()
  return { current, latest: l.latest, available: newer(l.latest, current), auto: process.platform === 'win32' && packaged && !!l.exe }
}

/** Downloads the installer, checks GitHub's SHA-256, starts it silently and returns; the caller quits the app. */
export async function install(current) {
  const l = await latest(true)
  if (!newer(l.latest, current)) throw new Error('Đang là bản mới nhất')
  if (!l.exe || !/^[0-9a-f]{64}$/.test(l.exe.sha256)) throw new Error('Bản phát hành không có tệp cài Windows kèm SHA-256')
  const r = await fetch(l.exe.url, { headers: { 'user-agent': 'ZeroPort' } })
  if (!r.ok) throw new Error(`Tải thất bại: ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (createHash('sha256').update(buf).digest('hex') !== l.exe.sha256) throw new Error('SHA-256 không khớp — huỷ cập nhật')
  const file = join(os.tmpdir(), `ZeroPort-update-${l.latest}.exe`)
  await writeFile(file, buf)
  // NSIS (electron-builder): /S = silent, --updated = give the running app a moment to exit before killing it.
  // Its own --force-run restart (ExecShellAsUser) did nothing when tried here, so a detached cmd waits for the
  // installer and starts the app again, hidden in the tray like an autostart. (A detached PowerShell, having no
  // console, silently ran nothing.) Windows paths cannot contain `"`, so quoting them is enough.
  const line = `/d /s /c "start "" /wait "${file}" /S --updated & start "" "${process.execPath}" --hidden"`
  spawn(process.env.ComSpec || 'cmd.exe', [line], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
  return l.latest
}
