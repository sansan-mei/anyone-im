/* Static offline shell only. Bump this version when shell/icon contents change.
 * Updates wait for old clients to close: no forced reload or draft loss. */
const CACHE = 'anyone-shell-v2'
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const data = event.notification.data || {}
    let roomId = '', ownerId = ''
    if (typeof data.ownerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.ownerId) && typeof data.roomId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.roomId)) {
      try {
        const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin', headers: { 'X-Anyone-User-Id': data.ownerId } })
        const session = response.ok ? await response.json() : null
        if (session?.data?.user?.id === data.ownerId) { roomId = data.roomId; ownerId = data.ownerId }
      } catch { /* Offline: focus generic app without trusting the previous identity. */ }
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const app = windows.find(client => { const url = new URL(client.url); return url.origin === self.location.origin && (url.pathname === '/' || /^\/invite\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) })
    if (app) {
      if (roomId) app.postMessage({ type: 'notification-room', roomId, ownerId })
      await app.focus()
    } else {
      const url = new URL('/', self.location.origin)
      if (roomId) url.searchParams.set('room', roomId)
      await self.clients.openWindow(url.href)
    }
  })())
})
const SHELL = ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png']
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)))
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('anyone-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  // No API/socket/attachment/auth/chat response ever enters CacheStorage.
  if (SHELL.includes(url.pathname) && !url.search) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(event.request)))
  } else if (event.request.mode === 'navigate' && (url.pathname === '/' || /^\/invite\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))) {
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then(cache => cache.match('/offline.html'))))
  }
})
