import { expect, test } from 'bun:test'
import { frontendResponse } from '../src/frontend'

const publicDir = new URL('../../web/public/', import.meta.url).pathname

test('production allowlist serves every public install/favicon asset with correct MIME and revalidation', async () => {
  for (const [path, mime] of [
    ['/icons/apple-touch-icon.png', 'image/png'], ['/icons/favicon-32.png', 'image/png'], ['/icons/favicon-16.png', 'image/png'],
    ['/icons/icon-192.png', 'image/png'], ['/icons/icon-512.png', 'image/png'], ['/icons/maskable-512.png', 'image/png'],
    ['/favicon.svg', 'image/svg+xml'], ['/favicon.ico', 'image/x-icon'], ['/manifest.webmanifest', 'application/manifest+json']
  ]) {
    const response = await frontendResponse(new Request(`https://im.test${path}`), publicDir)
    expect(response, path).not.toBeNull()
    expect(response!.status).toBe(200)
    expect(response!.headers.get('content-type')).toContain(mime!)
    expect(response!.headers.get('cache-control')).toBe('no-cache')
    expect(response!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response!.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(Buffer.from(await Bun.file(`${publicDir}${path}`).arrayBuffer()))
  }
})

test('new icon routes do not create a wildcard static surface', async () => {
  for (const path of ['/icons/private.png', '/icons/../.env', '/icons/icon-512.png.map', '/scripts/generate-icons.py', '/api/session', '/uploads/private']) {
    expect(await frontendResponse(new Request(`https://im.test${path}`), publicDir)).toBeNull()
  }
})
