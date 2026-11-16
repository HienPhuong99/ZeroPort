// Draws the app icon procedurally and writes the PNG sizes the app, PWA and installers need.
// Run: node scripts/icons.mjs   (outputs are committed; rerun only when the design changes)
import { deflateSync, crc32 } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const lerp = (a, b, t) => a + (b - a) * t
function pixel(x, y) { // x,y in 0..1 → [r,g,b,a]
  const r = 0.22, cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r)
  if (Math.hypot(x - cx, y - cy) > r) return [0, 0, 0, 0]
  const bar = x > 0.27 && x < 0.73 && ((y > 0.25 && y < 0.37) || (y > 0.63 && y < 0.75))
  const diag = y >= 0.37 && y <= 0.63 && Math.abs((x - 0.27) * 0.26 + (y - 0.63) * 0.46) / Math.hypot(0.26, 0.46) < 0.062
  if (bar || diag) return [255, 255, 255, 255]
  const t = (x + y) / 2
  return [lerp(37, 124, t), lerp(99, 58, t), lerp(235, 237, t), 255]
}
function png(n, ss = 4) {
  const raw = Buffer.alloc((n * 4 + 1) * n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const acc = [0, 0, 0, 0]
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const p = pixel((x + (i + 0.5) / ss) / n, (y + (j + 0.5) / ss) / n)
      acc[0] += p[0] * p[3]; acc[1] += p[1] * p[3]; acc[2] += p[2] * p[3]; acc[3] += p[3]
    }
    const o = y * (n * 4 + 1) + 1 + x * 4, a = acc[3] || 1
    raw[o] = acc[0] / a; raw[o + 1] = acc[1] / a; raw[o + 2] = acc[2] / a; raw[o + 3] = acc[3] / (ss * ss)
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
for (const [file, n] of [['public/icon-180.png', 180], ['public/icon-192.png', 192], ['public/icon-512.png', 512], ['electron/icon.png', 256], ['build/icon.png', 1024]])
  writeFileSync(file, png(n))
