import { describe, expect, test } from 'bun:test'
import { io } from 'socket.io-client'
import { agent, database, fixture, guests, useIsolatedDatabase } from './support'

useIsolatedDatabase()

const HOUR = 3600000, DAY = 24 * HOUR
const start = Date.UTC(2026, 10, 17, 8)
const say = (client: ReturnType<typeof agent>, roomId: string, text: string) => client.request(`/api/rooms/${roomId}/messages`, { clientMessageId: crypto.randomUUID(), text })

describe('short rooms', () => {
  test('close exactly twelve hours after creation even while active', async () => {
    let now = start
    const app = await fixture({ rateLimits: { JOIN: 100 }, roomLifecycle: { now: () => now, sweep: false } })
    const [owner, bob] = await guests(app.url, 'Owner', 'Bob')
    const room = (await owner!.request('/api/rooms', { name: 'Temp', password: 'secret 123', lifetime: 'short' })).body.data
    await bob!.request('/api/rooms/join-by-code', { code: room.code, password: 'secret 123' })
    now += 11 * HOUR
    expect((await say(bob!, room.id, 'still open')).status).toBe(200)
    // Activity never extends a short room.
    expect((await owner!.request('/api/rooms')).body.data.rooms.find((r: any) => r.id === room.id).expiresAt).toBe(new Date(start + 12 * HOUR).toISOString())
    now = start + 12 * HOUR - 1
    expect((await owner!.request(`/api/rooms/${room.id}/messages`)).status).toBe(200)
    now++
    // Closed rooms are unusable before the sweep physically erases them.
    const closed = await owner!.request(`/api/rooms/${room.id}/messages`)
    expect(closed.status).toBe(404)
    expect(closed.body.error.code).toBe('ROOM_CLOSED')
    expect((await say(bob!, room.id, 'too late')).status).toBe(404)
    expect((await owner!.request('/api/rooms')).body.data.rooms.map((r: any) => r.id)).not.toContain(room.id)
    const [carol] = await guests(app.url, 'Carol')
    const late = await carol!.request('/api/rooms/join-by-code', { code: room.code, password: 'secret 123' })
    expect(late.status).toBe(404)
    expect(late.body.error.message).toBe('房间码或密码错误')
  })
})

describe('room sweep', () => {
  test('erases closed rooms with their history, frees the code and keeps the rest', async () => {
    let now = start
    const app = await fixture({ roomLifecycle: { now: () => now, sweep: false } })
    const db = await database(app.databaseUrl)
    const [owner] = await guests(app.url, 'Owner')
    const short = (await owner!.request('/api/rooms', { name: 'Short', password: 'secret 123', lifetime: 'short' })).body.data
    const idle = (await owner!.request('/api/rooms', { name: 'Idle', password: 'secret 123' })).body.data
    const busy = (await owner!.request('/api/rooms', { name: 'Busy', password: 'secret 123' })).body.data
    await say(owner!, short.id, 'temporary')
    const form = new FormData()
    form.append('file', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'a.png', { type: 'image/png' }))
    const { EXPECTED_USER_HEADER } = await import('@anyone-im/contracts')
    expect((await fetch(`${app.url}/api/rooms/${short.id}/attachments`, { method: 'POST', headers: { cookie: owner!.cookie, [EXPECTED_USER_HEADER]: owner!.userId }, body: form })).status).toBe(200)
    await (await owner!.request(`/api/rooms/${short.id}/invites`, {}))
    now += 6 * DAY
    expect((await say(owner!, busy.id, 'keeps the long room alive')).status).toBe(200)
    expect((await owner!.request('/api/rooms')).body.data.rooms.find((r: any) => r.id === busy.id).expiresAt).toBe(new Date(now + 7 * DAY).toISOString())
    now = start + 7 * DAY
    expect(await app.closeExpiredRooms()).toBe(2)
    expect(await db.room.findUnique({ where: { id: short.id } })).toBeNull()
    expect(await db.room.findUnique({ where: { id: idle.id } })).toBeNull()
    for (const table of [db.message, db.attachment, db.invite, db.membership] as any[]) expect(await table.count({ where: { roomId: { in: [short.id, idle.id] } } })).toBe(0)
    expect(await db.room.findUnique({ where: { id: busy.id } })).not.toBeNull()
    expect(await db.room.findUnique({ where: { id: 'lobby' } })).not.toBeNull()
    expect(await app.closeExpiredRooms()).toBe(0)
    // A released code can be issued again to a brand-new, empty room.
    const reused = await db.room.create({ data: { name: 'Reused', code: short.code } })
    expect(await db.message.count({ where: { roomId: reused.id } })).toBe(0)
  })
  test('the lobby never closes and legacy rooms receive a code', async () => {
    let now = start
    const app = await fixture({ roomLifecycle: { now: () => now, sweep: false } })
    const db = await database(app.databaseUrl)
    const [owner] = await guests(app.url, 'Owner')
    const legacy = await db.room.create({ data: { name: 'Legacy', activeAt: new Date(now), memberships: { create: { userId: owner!.userId, role: 'owner' } } } })
    expect(legacy.code).toBeNull()
    await app.closeExpiredRooms()
    const coded = await db.room.findUniqueOrThrow({ where: { id: legacy.id } })
    expect(coded.code).toMatch(/^\d{6}$/)
    expect((await db.room.findUniqueOrThrow({ where: { id: 'lobby' } })).code).toMatch(/^\d{6}$/)
    now += 365 * DAY
    await app.closeExpiredRooms()
    expect(await db.room.findUnique({ where: { id: 'lobby' } })).not.toBeNull()
    expect(await db.room.findUnique({ where: { id: legacy.id } })).toBeNull()
    expect((await owner!.request('/api/rooms/lobby/messages')).status).toBe(200)
  })
  test('members connected over Socket.IO are told the room closed', async () => {
    let now = start
    const app = await fixture({ roomLifecycle: { now: () => now, sweep: false } })
    const [owner] = await guests(app.url, 'Owner')
    const room = (await owner!.request('/api/rooms', { name: 'Live', password: 'secret 123', lifetime: 'short' })).body.data
    const socket = io(app.url, { extraHeaders: { cookie: owner!.cookie }, transports: ['websocket'], reconnection: false })
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject) })
      const subscribed = await socket.timeout(2000).emitWithAck('room:subscribe', { roomId: room.id })
      expect(subscribed.data).toBeDefined()
      const removed = new Promise<any>(resolve => socket.on('room:removed', resolve))
      now += 12 * HOUR
      expect(await app.closeExpiredRooms()).toBe(1)
      expect(await removed).toEqual({ roomId: room.id, reason: 'closed' })
    } finally { socket.disconnect() }
  })
})

describe('owner destroy', () => {
  test('only the owner can destroy a room immediately', async () => {
    const app = await fixture({ rateLimits: { JOIN: 100 } })
    const db = await database(app.databaseUrl)
    const [owner, bob] = await guests(app.url, 'Owner', 'Bob')
    const room = (await owner!.request('/api/rooms', { name: 'Burn', password: 'secret 123', lifetime: 'short' })).body.data
    await bob!.request('/api/rooms/join-by-code', { code: room.code, password: 'secret 123' })
    await say(bob!, room.id, 'burn after reading')
    expect((await bob!.request(`/api/rooms/${room.id}`, undefined, 'DELETE')).status).toBe(403)
    expect((await owner!.request('/api/rooms/lobby', undefined, 'DELETE')).status).toBe(403)
    expect((await owner!.request(`/api/rooms/${room.id}`, undefined, 'DELETE')).status).toBe(200)
    expect(await db.room.findUnique({ where: { id: room.id } })).toBeNull()
    expect(await db.message.count({ where: { roomId: room.id } })).toBe(0)
    expect((await bob!.request(`/api/rooms/${room.id}/messages`)).status).toBe(403)
  })
})
