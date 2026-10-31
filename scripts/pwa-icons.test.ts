import { expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'

const publicDir = new URL('../apps/web/public/', import.meta.url)

// Decode non-interlaced RGB/RGBA PNGs without introducing a CI image dependency.
function pngPixels(bytes: Buffer) {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  expect(bytes[24]).toBe(8)
  expect([2, 6]).toContain(bytes[25])
  expect(bytes[28]).toBe(0)
  const channels = bytes[25] === 6 ? 4 : 3
  const chunks: Buffer[] = []
  for (let i = 8; i < bytes.length;) {
    const length = bytes.readUInt32BE(i)
    if (bytes.toString('ascii', i + 4, i + 8) === 'IDAT') chunks.push(bytes.subarray(i + 8, i + 8 + length))
    i += length + 12
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    expect(filter).toBeLessThanOrEqual(4)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0
      const b = y ? pixels[(y - 1) * stride + x]! : 0
      const c = y && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const predictor = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + predictor) & 255
    }
  }
  return { width, height, channels, pixels }
}

test('install and favicon PNGs are opaque ivory IM monogram seals with mask-safe artwork', async () => {
  for (const [path, size] of [['icons/icon-192.png', 192], ['icons/icon-512.png', 512], ['icons/maskable-512.png', 512], ['icons/apple-touch-icon.png', 180], ['icons/favicon-32.png', 32], ['icons/favicon-16.png', 16]] as const) {
    const { width, height, channels, pixels } = pngPixels(Buffer.from(await Bun.file(new URL(path, publicDir)).arrayBuffer()))
    expect([width, height]).toEqual([size, size])
    let inkCoverage = 0
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * channels
      const rgb = [...pixels.subarray(offset, offset + 3)]
      if (channels === 4) expect(pixels[offset + 3]).toBe(255)
      if ((x === 0 || x === size - 1) && (y === 0 || y === size - 1)) expect(rgb).toEqual([248, 250, 249])
      // Coverage (rather than a hard darkness threshold) includes antialiasing
      // on the subpixel ring at 16px without requiring a different icon design.
      inkCoverage += Math.max(0, Math.min(1, (248 - rgb[0]!) / (248 - 32)))
      if (path.includes('maskable') && Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > size * 0.4) expect(rgb).toEqual([248, 250, 249])
    }
    expect(inkCoverage / (size * size)).toBeGreaterThan(0.1)
    // Landmarks distinguish the centered IM lettering and seal from a pictogram.
    if (size >= 180) {
      for (const [x, y] of [[256, 72], [170, 186], [170, 250], [170, 325], [243, 200], [357, 200], [300, 260]]) {
        const offset = (Math.floor(y! * size / 512) * size + Math.floor(x! * size / 512)) * channels
        expect(pixels[offset]).toBeLessThan(80)
      }
      for (const [x, y] of [[215, 256], [300, 180]]) {
        const offset = (Math.floor(y! * size / 512) * size + Math.floor(x! * size / 512)) * channels
        expect([...pixels.subarray(offset, offset + 3)]).toEqual([248, 250, 249])
      }
    }
  }
})

test('HTML exposes dedicated Apple and explicit SVG/PNG/ICO favicons without changing app identity', async () => {
  const html = await Bun.file(new URL('../apps/web/index.html', import.meta.url)).text()
  for (const tag of [
    '<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png"/>',
    '<link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg"/>',
    '<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png"/>',
    '<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png"/>',
    '<link rel="icon" type="image/x-icon" href="/favicon.ico"/>'
  ]) expect(html).toContain(tag)
  expect(html).toContain('<meta name="theme-color" content="#11796f"/>')
  const manifest = await Bun.file(new URL('manifest.webmanifest', publicDir)).json()
  expect(manifest).toMatchObject({ id: '/', name: 'Anyone IM', short_name: 'Anyone', start_url: '/', scope: '/', display: 'standalone', theme_color: '#11796f', background_color: '#f5faf9' })
  expect(manifest.icons).toEqual([
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ])
})

test('legacy favicon contains real 16, 32 and 48 pixel ICO frames', async () => {
  const file = Bun.file(new URL('favicon.ico', publicDir))
  expect(await file.exists()).toBe(true)
  const ico = Buffer.from(await file.arrayBuffer())
  expect(ico.readUInt16LE(2)).toBe(1)
  expect(ico.readUInt16LE(4)).toBe(3)
  expect([0, 1, 2].map(index => [ico[6 + index * 16], ico[7 + index * 16]])).toEqual([[16, 16], [32, 32], [48, 48]])
})
