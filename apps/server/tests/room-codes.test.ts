import { describe, expect, test } from 'bun:test'
import { fixture, guests, useIsolatedDatabase } from './support'

useIsolatedDatabase()

const HOUR = 3600000, DAY = 24 * HOUR

describe('six-digit room codes', () => {
  test('every new room gets a distinct six-digit code and a lifetime', async () => {
    let now = Date.UTC(2026, 10, 17, 8)
    const app = await fixture({ roomLifecycle: { now: () => now } })
    const [owner] = await guests(app.url, 'Owner')
    const long = await owner!.request('/api/rooms', { name: 'Default', password: 'secret 123' })
    const short = await owner!.request('/api/rooms', { name: 'Temp', password: 'secret 123', lifetime: 'short' })
    expect(long.status).toBe(200)
    expect(short.status).toBe(200)
    expect(long.body.data.code).toMatch(/^\d{6}$/)
    expect(short.body.data.code).toMatch(/^\d{6}$/)
    expect(short.body.data.code).not.toBe(long.body.data.code)
    // API default stays long so older clients keep their rooms.
    expect(long.body.data).toMatchObject({ lifetime: 'long', expiresAt: new Date(now + 7 * DAY).toISOString() })
    expect(short.body.data).toMatchObject({ lifetime: 'short', expiresAt: new Date(now + 12 * HOUR).toISOString() })
    expect((await owner!.request('/api/rooms', { name: 'Bad', password: 'secret 123', lifetime: 'forever' })).status).toBe(400)
  })
  test('a code collision retries instead of failing or sharing a code', async () => {
    const issued = ['111111', '111111', '111111', '222222']
    const app = await fixture({ roomLifecycle: { codes: () => issued.shift() ?? '999999', sweep: false } })
    const [owner] = await guests(app.url, 'Owner')
    const first = await owner!.request('/api/rooms', { name: 'First', visibility: 'public' })
    const second = await owner!.request('/api/rooms', { name: 'Second', visibility: 'public' })
    expect([first.body.data.code, second.body.data.code]).toEqual(['111111', '222222'])
  })
})

describe('joining by code and password', () => {
  test('code and password are checked together with one opaque error', async () => {
    const app = await fixture({ rateLimits: { JOIN: 100 } })
    const [owner, bob, carol] = await guests(app.url, 'Owner', 'Bob', 'Carol')
    const room = (await owner!.request('/api/rooms', { name: 'Hand-off', password: 'secret 123', lifetime: 'short' })).body.data
    const other = (await owner!.request('/api/rooms', { name: 'Other', password: 'other 456' })).body.data
    const wrong = await bob!.request('/api/rooms/join-by-code', { code: room.code, password: 'wrong 999' })
    const missing = await bob!.request('/api/rooms/join-by-code', { code: room.code })
    const crossed = await bob!.request('/api/rooms/join-by-code', { code: room.code, password: 'other 456' })
    const unknownCode = room.code === '000000' ? '000001' : '000000'
    const unknown = await bob!.request('/api/rooms/join-by-code', { code: unknownCode, password: 'secret 123' })
    expect(wrong.status).toBe(404)
    expect(wrong.body).toEqual({ error: { code: 'NOT_FOUND', message: '房间码或密码错误' } })
    for (const response of [missing, crossed, unknown]) expect(response.body).toEqual(wrong.body)
    for (const code of ['12345', '1234567', 'abcdef', ' 12345']) expect((await bob!.request('/api/rooms/join-by-code', { code, password: 'secret 123' })).status).toBe(400)
    expect((await bob!.request('/api/rooms')).body.data.rooms.map((r: any) => r.id)).not.toContain(room.id)
    const joined = await bob!.request('/api/rooms/join-by-code', { code: room.code, password: 'secret 123' })
    expect(joined.status).toBe(200)
    expect(joined.body.data).toMatchObject({ id: room.id, code: room.code, role: 'member', lifetime: 'short' })
    expect((await carol!.request('/api/rooms/join-by-code', { code: other.code, password: 'other 456' })).body.data.id).toBe(other.id)
    const open = (await owner!.request('/api/rooms', { name: 'Open', visibility: 'public' })).body.data
    expect((await carol!.request('/api/rooms/join-by-code', { code: open.code })).status).toBe(200)
    await owner!.request(`/api/rooms/${room.id}/members/${bob!.userId}`, undefined, 'DELETE')
    expect((await bob!.request('/api/rooms/join-by-code', { code: room.code, password: 'secret 123' })).status).toBe(403)
  })
  test('five wrong passwords lock that client out of that code for fifteen minutes', async () => {
    let now = Date.UTC(2026, 10, 17, 8)
    const app = await fixture({ rateLimits: { JOIN: 100 }, roomLifecycle: { now: () => now } })
    const [owner, bob, carol] = await guests(app.url, 'Owner', 'Bob', 'Carol')
    const room = (await owner!.request('/api/rooms', { name: 'Locked', password: 'secret 123', lifetime: 'short' })).body.data
    const other = (await owner!.request('/api/rooms', { name: 'Elsewhere', password: 'secret 123', lifetime: 'short' })).body.data
    const attempt = (client = bob!, password = 'wrong 999', code = room.code) => client.request('/api/rooms/join-by-code', { code, password })
    for (let i = 0; i < 4; i++) expect((await attempt()).status).toBe(404)
    // A success clears the streak; the lock needs five consecutive failures.
    expect((await attempt(bob!, 'secret 123')).status).toBe(200)
    for (let i = 0; i < 4; i++) expect((await attempt()).status).toBe(404)
    expect((await attempt(bob!, 'secret 123', other.code)).status).toBe(200)
    expect((await attempt()).status).toBe(404)
    const locked = await attempt(bob!, 'secret 123')
    expect(locked.status).toBe(429)
    expect(locked.body.error).toEqual({ code: 'TOO_MANY_ATTEMPTS', message: '尝试次数过多，请 15 分钟后再试' })
    expect((await attempt(carol!, 'secret 123')).status).toBe(200)
    now += 15 * 60000 - 1
    expect((await attempt(bob!, 'secret 123')).status).toBe(429)
    now += 1
    expect((await attempt(bob!, 'secret 123')).status).toBe(200)
  })
  test('failures across many clients lock the code itself', async () => {
    let now = Date.UTC(2026, 10, 17, 8)
    const app = await fixture({ rateLimits: { JOIN: 100, AUTH: 100 }, roomLifecycle: { now: () => now, codeLockout: { perCode: 6 } } })
    const [owner, ...attackers] = await guests(app.url, 'Owner', 'A', 'B', 'C', 'D')
    const room = (await owner!.request('/api/rooms', { name: 'Target', password: 'secret 123', lifetime: 'short' })).body.data
    for (const client of attackers) for (let i = 0; i < 2; i++) await client.request('/api/rooms/join-by-code', { code: room.code, password: `guess ${i}` })
    const [late] = await guests(app.url, 'Late')
    expect((await late!.request('/api/rooms/join-by-code', { code: room.code, password: 'secret 123' })).status).toBe(429)
    now += 15 * 60000
    expect((await late!.request('/api/rooms/join-by-code', { code: room.code, password: 'secret 123' })).status).toBe(200)
  })
})
