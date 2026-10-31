import { realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/** Only immutable build assets and known SPA entry paths; never DATA_DIR. */
export async function frontendResponse(request: Request, webDist: string): Promise<Response | null> {
  const path = new URL(request.url).pathname
  let relative: string
  if (path === '/' || /^\/invite\/[A-Za-z0-9_-]+\/?$/.test(path)) relative = 'index.html'
  else if (/^\/assets\/[A-Za-z0-9_./-]+$/.test(path) && !path.split('/').some(p => p.startsWith('.') || p === '..') && !path.endsWith('.map')) relative = path.slice(1)
  else if (['/favicon.ico', '/favicon.svg', '/manifest.webmanifest', '/robots.txt', '/sw.js', '/offline.html', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png'].includes(path)) relative = path.slice(1)
  else return null
  try {
    const root = await realpath(webDist), filename = resolve(root, relative)
    if (!filename.startsWith(root + sep) || await realpath(filename) !== filename || !(await stat(filename)).isFile()) return null
    return new Response(Bun.file(filename), { headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'", 'Cache-Control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' } })
  } catch { return null }
}
