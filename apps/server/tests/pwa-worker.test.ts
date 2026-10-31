import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

async function worker(sessionUser = 'owner', urls = ['https://im.test/']) {
  const handlers: Record<string, (event: any) => void> = {}
  const opened: string[] = [], posted: unknown[] = [], focused: string[] = [], requests: {url: string; options: RequestInit}[] = []
  const self = {
    location: { origin: 'https://im.test' },
    addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler },
    clients: {
      matchAll: async () => urls.map(url => ({ url, postMessage: (data: unknown) => posted.push(data), focus: async () => { focused.push(url) } })),
      openWindow: async (url: string) => { opened.push(url) }, claim: async () => {}
    }
  }
  runInNewContext(await readFile(new URL('../../web/public/sw.js', import.meta.url), 'utf8'), {
    self, URL, fetch: async (url: string, options: RequestInit) => { requests.push({url, options}); return { ok: true, json: async () => ({ data: { user: { id: sessionUser } } }) } }
  })
  return { handlers, opened, posted, focused, requests }
}

test('notification click validates current cookie identity then focuses same-origin app and selects only a room id', async () => {
  const w = await worker()
  expect(w.handlers.notificationclick).toBeFunction()
  let pending: Promise<unknown> | undefined, closed = false
  w.handlers.notificationclick({ notification: { data: { ownerId: 'owner', roomId: 'room_1', url: 'https://evil.test' }, close: () => { closed = true } }, waitUntil: (p: Promise<unknown>) => { pending = p } })
  await pending
  expect(closed).toBe(true)
  expect(w.requests[0]).toMatchObject({ url: '/api/session', options: { cache: 'no-store', credentials: 'same-origin', headers: { 'X-Anyone-User-Id': 'owner' } } })
  expect(w.opened).toEqual([])
  expect(w.focused).toEqual(['https://im.test/'])
  expect(w.posted).toEqual([{ type: 'notification-room', roomId: 'room_1', ownerId: 'owner' }])
})

test('stale-account or malicious click cannot open external URLs or select previous users rooms', async () => {
  for (const [session, roomId] of [['replacement', 'private-room'], ['owner', '//evil.test']]) {
    const w = await worker(session, ['https://evil.test/', 'https://im.test/api/attachments/private'])
    expect(w.handlers.notificationclick).toBeFunction()
    let pending: Promise<unknown> | undefined
    w.handlers.notificationclick({ notification: { data: { ownerId: 'owner', roomId, url: 'https://evil.test' }, close() {} }, waitUntil: (p: Promise<unknown>) => { pending = p } })
    await pending
    expect(w.posted).toEqual([])
    expect(w.focused).toEqual([])
    expect(w.opened).toEqual(['https://im.test/'])
  }
})
