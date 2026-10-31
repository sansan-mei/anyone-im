import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { io, type Socket } from 'socket.io-client'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { EXPECTED_USER_HEADER, MAX_ATTACHMENT_BYTES } from '@anyone-im/contracts'

async function stalledBody(url: string, path: string, cookie: string, expectedUserId: string, contentType: string, bytes: Uint8Array) {
  let pending!: ReturnType<typeof httpRequest>
  const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
    pending = httpRequest(`${url}${path}`, { method: 'POST', headers: { cookie, [EXPECTED_USER_HEADER]: expectedUserId, 'content-type': contentType, 'content-length': bytes.length } }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }))
    })
    pending.on('error', reject)
  })
  // Explicitly retain the promise even if the test exits early.
  void response.catch(() => {})
  pending!.write(bytes.slice(0, 1))
  const request = pending!
  cleanups.push(async () => { request.destroy() })
  await Bun.sleep(50)
  return { response, finish: () => request.end(bytes.slice(1)), write: (chunk: Uint8Array) => request.write(chunk), destroy: () => request.destroy() }
}

async function promptly<T>(operation: Promise<T>, milliseconds = 400): Promise<T | 'blocked'> {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([operation, new Promise<'blocked'>(resolve => { timer = setTimeout(() => resolve('blocked'), milliseconds) })]) }
  finally { clearTimeout(timer!) }
}

async function multipart() {
  const form = new FormData()
  form.append('file', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'image.png', { type: 'image/png' }))
  const request = new Request('http://localhost', { method: 'POST', body: form })
  return { contentType: request.headers.get('content-type')!, bytes: new Uint8Array(await request.arrayBuffer()) }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function factory() {
  const file = Bun.file(join(import.meta.dir, '../src/app.ts'))
  expect(await file.exists()).toBe(true)
  return import('../src/app')
}

async function fixture(options: import('../src/app').ApplicationOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'anyone-db-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const databaseUrl = `file:${dir}/test.sqlite`
  const proc = Bun.spawn(['bun', 'scripts/database.ts', 'push'], { cwd: join(import.meta.dir, '..'), env: { ...process.env, DB_PROVIDER: 'sqlite', DATABASE_URL: databaseUrl }, stdout: 'pipe', stderr: 'pipe' })
  const status = await proc.exited
  if (status !== 0) throw new Error(await new Response(proc.stderr).text())
  const { createApplication } = await factory()
  const app = await createApplication({ port: 0, host: '127.0.0.1', dataDir: dir, databaseUrl, ...options })
  cleanups.push(() => app.close())
  return { ...app, dir, databaseUrl }
}
function agent(url: string) {
  let cookie = ''
  let userId = ''
  return {
    get cookie() { return cookie },
    get userId() { return userId },
    async request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(`${url}${path}`, { method, headers: { ...(cookie ? { cookie, [EXPECTED_USER_HEADER]: userId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]!
      const text = await response.text()
      let bodyResult: any
      try { bodyResult = JSON.parse(text) } catch { bodyResult = text }
      if (response.ok && (path === '/api/session' || /^\/api\/auth\/(guest|register|login)$/.test(path))) userId = bodyResult.data.user?.id ?? ''
      return { status: response.status, body: bodyResult, headers: response.headers }
    }
  }
}

describe('persistent authentication', () => {
  test('server owns guest identity, hashes opaque sessions and reuses authenticated guest', async () => {
    const app = await fixture()
    const client = agent(app.url)
    expect((await client.request('/readyz')).status).toBe(200)
    expect((await client.request('/api/session')).body).toEqual({ data: { user: null } })
    const first = await client.request('/api/auth/guest', { displayName: 'Alice' })
    expect(first.status).toBe(200)
    expect(first.headers.get('set-cookie')).toContain('HttpOnly')
    expect(first.headers.get('set-cookie')).toContain('SameSite=Lax')
    expect(first.body.data.user).toMatchObject({ displayName: 'Alice', isGuest: true, username: null })
    const second = await client.request('/api/auth/guest', { displayName: 'Changed' })
    expect(second.body.data.user.id).toBe(first.body.data.user.id)
    expect((await client.request('/api/session')).body.data.user.id).toBe(first.body.data.user.id)
    expect((await client.request('/api/auth/guest', { displayName: 'Eve', userId: 'forged' })).status).toBe(400)
    const { PrismaClient } = await import('../generated/client')
    const db = new PrismaClient({ datasources: { db: { url: app.databaseUrl } } })
    const session = await db.session.findFirst()
    expect(session!.id).not.toBe(client.cookie.split('=')[1])
    expect(session!.id).toMatch(/^[a-f0-9]{64}$/)
    await db.$disconnect()
    await client.request('/api/auth/logout', {})
    expect((await client.request('/api/session')).body.data.user).toBeNull()
  })
  test('registration persists Argon2id password, login rotates session, invalid credentials stay opaque', async () => {
    const app = await fixture()
    const client = agent(app.url)
    const registered = await client.request('/api/auth/register', { username: 'alice', password: 'correct horse battery', displayName: 'Alice' })
    expect(registered.status).toBe(200)
    const oldCookie = client.cookie
    expect((await client.request('/api/auth/register', { username: 'alice', password: 'correct horse battery', displayName: 'Duplicate' })).status).toBe(409)
    const { PrismaClient } = await import('../generated/client')
    const db = new PrismaClient({ datasources: { db: { url: app.databaseUrl } } })
    expect((await db.user.findUnique({ where: { username: 'alice' } }))!.passwordHash).toStartWith('$argon2id$')
    await db.$disconnect()
    expect((await client.request('/api/auth/login', { username: 'alice', password: 'incorrect' })).status).toBe(401)
    expect((await client.request('/api/auth/login', { username: 'alice', password: 'correct horse battery' })).status).toBe(200)
    expect(client.cookie).not.toBe(oldCookie)
    const stale = await fetch(`${app.url}/api/session`, { headers: { cookie: oldCookie } }).then(r => r.json())
    expect(stale.data.user).toBeNull()
    expect((await client.request('/api/me', { displayName: 'New Alice' }, 'PATCH')).body.data.displayName).toBe('New Alice')
  })
})

describe('captured identity preconditions', () => {
  test('a stale browser socket cannot authenticate as the replacement cookie user', async () => {
    const app = await fixture()
    const alice = agent(app.url), bob = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Alice' })
    await bob.request('/api/auth/guest', { displayName: 'Bob' })
    const socket = io(app.url, { extraHeaders: { cookie: bob.cookie }, query: { expectedUserId: alice.userId }, transports: ['websocket'], reconnection: false, timeout: 2000 })
    cleanups.push(async () => { socket.disconnect() })
    let timer: ReturnType<typeof setTimeout>
    try {
      const outcome = await new Promise<string>(resolve => {
        socket.once('connect', () => resolve('connected'))
        socket.once('connect_error', error => resolve(error.message))
        timer = setTimeout(() => resolve('timeout'), 2500)
      })
      expect(outcome).toBe('SESSION_CHANGED')
    } finally { clearTimeout(timer!) }
  })
  test('every authenticated mutation requires the captured cookie user, including logout and uploads', async () => {
    const app = await fixture({ rateLimits: { JOIN: 100 } })
    const alice = agent(app.url), bob = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Alice' })
    await bob.request('/api/auth/guest', { displayName: 'Bob' })
    const routes: Array<[string, string, unknown]> = [
      ['/api/me', 'PATCH', { displayName: 'Must not change' }],
      ['/api/rooms', 'POST', { name: 'Must not create' }],
      ['/api/rooms/lobby/join', 'POST', {}],
      ['/api/rooms/lobby/leave', 'POST', {}],
      ['/api/rooms/lobby/messages', 'POST', { clientMessageId: crypto.randomUUID(), text: 'Must not send' }],
      ['/api/rooms/lobby/read', 'PATCH', { seq: 0 }],
      ['/api/messages/nonexistent', 'DELETE', {}],
      ['/api/rooms/lobby/invites', 'POST', {}],
      ['/api/rooms/lobby/invites', 'DELETE', {}],
      ['/api/invites/nonexistent', 'POST', {}],
      ['/api/rooms/lobby/members/nonexistent', 'DELETE', {}],
      ['/api/rooms/lobby/attachments', 'POST', null],
      ['/api/auth/logout', 'POST', {}]
    ]
    for (const [path, method, body] of routes) {
      for (const expectedUserId of [undefined, alice.userId]) {
        const form = new FormData(); form.append('file', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'image.png', { type: 'image/png' }))
        const response = await fetch(`${app.url}${path}`, {
          method,
          headers: { cookie: bob.cookie, ...(expectedUserId ? { [EXPECTED_USER_HEADER]: expectedUserId } : {}), ...(body === null ? {} : { 'content-type': 'application/json' }) },
          body: body === null ? form : JSON.stringify(body)
        })
        expect(response.status, `${method} ${path}`).toBe(expectedUserId ? 409 : 428)
        expect((await response.json()).error.code).toBe(expectedUserId ? 'SESSION_CHANGED' : 'PRECONDITION_REQUIRED')
      }
    }
    expect((await bob.request('/api/session')).body.data.user.displayName).toBe('Bob')
    expect((await bob.request('/api/rooms/lobby/messages')).body.data.messages).toEqual([])
    const valid = await bob.request('/api/me', { displayName: 'Current Bob' }, 'PATCH')
    expect(valid.status).toBe(200)
    expect(valid.body.data.id).toBe(bob.userId)
    expect((await bob.request('/api/auth/logout', {})).status).toBe(200)
  })
  test('authenticated GETs compare an optional header, bootstrap is exempt and a header never authenticates', async () => {
    const app = await fixture()
    const alice = agent(app.url), bob = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Alice' })
    await bob.request('/api/auth/guest', { displayName: 'Bob' })
    for (const path of ['/api/rooms', '/api/rooms/public', '/api/rooms/lobby/messages', '/api/rooms/lobby/members', '/api/attachments/nonexistent']) {
      const mismatch = await fetch(`${app.url}${path}`, { headers: { cookie: bob.cookie, [EXPECTED_USER_HEADER]: alice.userId } })
      expect(mismatch.status).toBe(409)
      expect((await mismatch.json()).error.code).toBe('SESSION_CHANGED')
    }
    expect((await fetch(`${app.url}/api/rooms`, { headers: { cookie: bob.cookie } })).status).toBe(200)
    expect((await fetch(`${app.url}/api/session`, { headers: { cookie: bob.cookie, [EXPECTED_USER_HEADER]: alice.userId } })).status).toBe(200)
    expect((await fetch(`${app.url}/api/rooms`, { headers: { [EXPECTED_USER_HEADER]: alice.userId } })).status).toBe(401)
  })
})

describe('password-first private rooms', () => {
  test('new default-private rooms require an explicit bounded password, without an automatic invite', async () => {
    const app = await fixture()
    const owner = agent(app.url)
    await owner.request('/api/auth/guest', { displayName: 'Owner' })
    for (const password of [undefined, '', 'short', 'x'.repeat(129)]) {
      expect((await owner.request('/api/rooms', { name: 'Private', ...(password === undefined ? {} : { password }) })).status).toBe(400)
    }
    const created = await owner.request('/api/rooms', { name: 'Private', password: 'private secret' })
    expect(created.status).toBe(200)
    expect(created.body.data.visibility).toBe('private')
    expect(JSON.stringify(created.body)).not.toContain('private secret')
    expect(JSON.stringify(created.body)).not.toContain('passwordHash')
    const { PrismaClient } = await import('../generated/client')
    const db = new PrismaClient({ datasources: { db: { url: app.databaseUrl } } })
    try {
      const stored = await db.room.findUniqueOrThrow({ where: { id: created.body.data.id } })
      const hash = (stored as any).passwordHash
      expect(hash).toStartWith('$argon2id$')
      expect(await Bun.password.verify('private secret', hash)).toBe(true)
      expect(await db.invite.count({ where: { roomId: stored.id } })).toBe(0)
    } finally { await db.$disconnect() }
    expect((await owner.request('/api/rooms', { name: 'Public', visibility: 'public' })).status).toBe(200)
  })
})

describe('room access control', () => {
  test('private membership, invite revocation and durable kicks prevent rejoin and metadata leakage', async () => {
    const app = await fixture()
    const owner = agent(app.url), bob = agent(app.url), outsider = agent(app.url)
    const a = (await owner.request('/api/auth/guest', { displayName: 'Owner' })).body.data.user
    const b = (await bob.request('/api/auth/guest', { displayName: 'Bob' })).body.data.user
    await outsider.request('/api/auth/guest', { displayName: 'Outsider' })
    const room = await owner.request('/api/rooms', { name: 'Secret', visibility: 'private', description: 'Hidden' })
    expect(room.status).toBe(200)
    const id = room.body.data.id
    expect(room.body.data).toMatchObject({ name: 'Secret', role: 'owner', memberCount: 1, lastSeq: 0, lastReadSeq: 0, lastMessage: null })
    expect((await outsider.request('/api/rooms')).body.data.rooms.map((r: any) => r.id)).not.toContain(id)
    expect((await outsider.request('/api/rooms/public')).body.data.rooms.map((r: any) => r.id)).not.toContain(id)
    expect((await bob.request(`/api/rooms/${id}/join`, {})).status).toBe(404)
    expect((await bob.request(`/api/rooms/${id}/messages`)).status).toBe(403)
    expect((await bob.request(`/api/rooms/${id}/members`)).status).toBe(403)
    expect((await bob.request(`/api/rooms/${id}/invites`, {})).status).toBe(403)
    const invite = (await owner.request(`/api/rooms/${id}/invites`, {})).body.data
    expect(invite.urlPath).toBe(`/invite/${invite.code}`)
    expect((await outsider.request(`/api/invites/${invite.code}`)).body.data.roomName).toBe('Secret')
    expect((await bob.request(`/api/invites/${invite.code}`, {})).status).toBe(200)
    expect((await owner.request(`/api/rooms/${id}/members`)).body.data.members.length).toBe(2)
    expect((await owner.request(`/api/rooms/${id}/members/${a.id}`, undefined, 'DELETE')).status).toBe(400)
    expect((await owner.request(`/api/rooms/${id}/members/${b.id}`, undefined, 'DELETE')).status).toBe(200)
    expect((await bob.request(`/api/invites/${invite.code}`, {})).status).toBe(403)
    expect((await bob.request(`/api/rooms/${id}/messages`)).status).toBe(403)
    expect((await owner.request(`/api/rooms/${id}/invites`, undefined, 'DELETE')).body.data.revoked).toBe(1)
    expect((await outsider.request(`/api/invites/${invite.code}`, {})).status).toBe(404)
    expect((await owner.request(`/api/rooms/${id}/leave`, {})).status).toBe(400)
  })
  test('public kicks are durable and banned rooms are not advertised as joinable', async () => {
    const app = await fixture()
    const alice = agent(app.url), bob = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'A' })
    const b = (await bob.request('/api/auth/guest', { displayName: 'B' })).body.data.user
    const room = (await alice.request('/api/rooms', { name: 'Public bans', visibility: 'public' })).body.data
    await bob.request(`/api/rooms/${room.id}/join`, {})
    await alice.request(`/api/rooms/${room.id}/members/${b.id}`, undefined, 'DELETE')
    expect((await bob.request(`/api/rooms/${room.id}/join`, {})).status).toBe(403)
    expect((await bob.request('/api/rooms/public')).body.data.rooms.map((r: any) => r.id)).not.toContain(room.id)
  })
  test('public rooms join and leave without exposing histories before membership', async () => {
    const app = await fixture()
    const alice = agent(app.url), bob = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'A' })
    await bob.request('/api/auth/guest', { displayName: 'B' })
    const room = (await alice.request('/api/rooms', { name: 'Open', visibility: 'public' })).body.data
    const preview = (await bob.request('/api/rooms/public')).body.data.rooms.find((r: any) => r.id === room.id)
    expect(preview).toMatchObject({ lastMessage: null, lastReadSeq: 0 })
    expect((await bob.request(`/api/rooms/${room.id}/join`, {})).status).toBe(200)
    expect((await bob.request(`/api/rooms/${room.id}/leave`, {})).status).toBe(200)
    expect((await bob.request(`/api/rooms/${room.id}/members`)).status).toBe(403)
    expect((await bob.request(`/api/rooms/${room.id}/join`, {})).status).toBe(200)
  })
})

describe('durable messages', () => {
  test('transactional ordering, immutable client-id dedupe, pagination, monotonic cursors and tombstones', async () => {
    const app = await fixture()
    const alice = agent(app.url), bob = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Alice' })
    await bob.request('/api/auth/guest', { displayName: 'Bob' })
    const room = (await alice.request('/api/rooms', { name: 'Messages', visibility: 'public' })).body.data
    await bob.request(`/api/rooms/${room.id}/join`, {})
    const path = `/api/rooms/${room.id}/messages`
    const input = { clientMessageId: crypto.randomUUID(), text: 'one' }
    const sent = await alice.request(path, input)
    expect(sent.status).toBe(200)
    expect(sent.body.data).toMatchObject({ seq: 1, text: 'one', roomId: room.id, attachment: null, deletedAt: null })
    const duplicate = await alice.request(path, input)
    expect(duplicate.body.data.id).toBe(sent.body.data.id)
    expect((await alice.request(path, { ...input, text: 'substitution' })).status).toBe(409)
    const concurrent = await Promise.all(Array.from({ length: 5 }, (_, i) => alice.request(path, { clientMessageId: crypto.randomUUID(), text: `msg${i}` })))
    expect(concurrent.map(r => r.body.data.seq).sort()).toEqual([2, 3, 4, 5, 6])
    expect((await alice.request(`${path}?limit=2`)).body.data).toMatchObject({ hasMore: true, messages: [{ seq: 5 }, { seq: 6 }] })
    expect((await alice.request(`${path}?beforeSeq=5&limit=2`)).body.data.messages.map((m: any) => m.seq)).toEqual([3, 4])
    expect((await alice.request(`${path}?afterSeq=2&limit=2`)).body.data.messages.map((m: any) => m.seq)).toEqual([3, 4])
    expect((await alice.request(`${path}?beforeSeq=5&afterSeq=2`)).status).toBe(400)
    expect((await alice.request(`${path}?limit=101`)).status).toBe(400)
    expect((await bob.request(path, { clientMessageId: crypto.randomUUID(), text: 'spoof', sender: { id: 'evil' } })).status).toBe(400)
    expect((await bob.request(`/api/rooms/${room.id}/read`, { seq: 99 }, 'PATCH')).status).toBe(400)
    await bob.request(`/api/rooms/${room.id}/read`, { seq: 5 }, 'PATCH')
    await bob.request(`/api/rooms/${room.id}/read`, { seq: 2 }, 'PATCH')
    expect((await bob.request('/api/rooms')).body.data.rooms.find((r: any) => r.id === room.id).lastReadSeq).toBe(5)
    expect((await bob.request(`/api/messages/${sent.body.data.id}`, undefined, 'DELETE')).status).toBe(403)
    expect((await alice.request(`/api/messages/${sent.body.data.id}`, undefined, 'DELETE')).status).toBe(200)
    expect((await alice.request(`${path}?afterSeq=0&limit=1`)).body.data.messages[0]).toMatchObject({ seq: 1, text: '', attachment: null })
    expect((await alice.request(`${path}?afterSeq=0&limit=1`)).body.data.messages[0].deletedAt).toBeString()
    const { PrismaClient } = await import('../generated/client')
    const db = new PrismaClient({ datasources: { db: { url: app.databaseUrl } } })
    await db.$executeRawUnsafe('CREATE TRIGGER fail_message BEFORE INSERT ON Message BEGIN SELECT RAISE(ABORT, \'disk failure\'); END;')
    const failure = await alice.request(path, { clientMessageId: crypto.randomUUID(), text: 'not persisted' })
    expect(failure.status).toBe(500)
    expect(failure.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } })
    expect((await db.room.findUnique({ where: { id: room.id } }))!.lastSeq).toBe(6)
    expect(await db.message.count({ where: { roomId: room.id } })).toBe(6)
    await db.$disconnect()
  })
})

async function connect(url: string, cookie: string, origin = url, transports = ['websocket']) {
  const socket = io(url, { transports, extraHeaders: { cookie, origin }, reconnection: false, forceNew: true, timeout: 2000 })
  cleanups.push(async () => { socket.disconnect() })
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })
  return socket
}
const ack = (socket: Socket, event: string, value: unknown): Promise<any> => socket.timeout(2000).emitWithAck(event, value)
async function until(check: () => Promise<boolean> | boolean) {
  const end = Date.now() + 2500
  while (!await check()) { if (Date.now() > end) throw new Error('Condition timed out'); await Bun.sleep(15) }
}

describe('real Socket.IO transport', () => {
  test('two authenticated clients get durable messages once, backfill, unique presence, kick and logout cleanup', async () => {
    const app = await fixture()
    const alice = agent(app.url), bob = agent(app.url), eve = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Alice' })
    const b = (await bob.request('/api/auth/guest', { displayName: 'Bob' })).body.data.user
    await eve.request('/api/auth/guest', { displayName: 'Eve' })
    const room = (await alice.request('/api/rooms', { name: 'Realtime', visibility: 'private' })).body.data
    const invite = (await alice.request(`/api/rooms/${room.id}/invites`, {})).body.data
    await bob.request(`/api/invites/${invite.code}`, {})
    const aSocket = await connect(app.url, alice.cookie)
    const bSocket = await connect(app.url, bob.cookie, app.url, ['polling', 'websocket'])
    const bTab = await connect(app.url, bob.cookie)
    const eSocket = await connect(app.url, eve.cookie)
    expect((await ack(eSocket, 'room:subscribe', { roomId: room.id })).error.code).toBe('FORBIDDEN')
    await ack(aSocket, 'room:subscribe', { roomId: room.id, afterSeq: 0 })
    await ack(bSocket, 'room:subscribe', { roomId: room.id })
    await until(async () => (await alice.request('/api/rooms')).body.data.rooms.find((r: any) => r.id === room.id).onlineCount === 2)
    const received: any[] = [], leaked: any[] = []
    bSocket.on('message:new', m => received.push(m)); eSocket.on('message:new', m => leaked.push(m))
    const input = { roomId: room.id, clientMessageId: crypto.randomUUID(), text: 'durable socket' }
    const sent = await ack(aSocket, 'message:send', input)
    expect(sent.data.seq).toBe(1)
    await until(() => received.length === 1)
    const { PrismaClient } = await import('../generated/client')
    const db = new PrismaClient({ datasources: { db: { url: app.databaseUrl } } })
    expect(await db.message.count({ where: { id: sent.data.id } })).toBe(1)
    expect((await ack(aSocket, 'message:send', input)).data.id).toBe(sent.data.id)
    expect((await ack(aSocket, 'message:send', { ...input, text: 'changed' })).error.code).toBe('IDEMPOTENCY_CONFLICT')
    expect((await ack(eSocket, 'message:send', { ...input, clientMessageId: crypto.randomUUID() })).error.code).toBe('FORBIDDEN')
    expect((await ack(aSocket, 'message:send', { ...input, senderId: b.id })).error.code).toBe('INVALID_INPUT')
    expect((await ack(bSocket, 'room:subscribe', { roomId: room.id, afterSeq: 0 })).data.messages[0].id).toBe(sent.data.id)
    await db.$executeRawUnsafe('CREATE TRIGGER fail_message BEFORE INSERT ON Message BEGIN SELECT RAISE(ABORT, \'disk failure\'); END;')
    expect((await ack(aSocket, 'message:send', { ...input, clientMessageId: crypto.randomUUID(), text: 'must fail' })).error.code).toBe('INTERNAL_ERROR')
    await db.$executeRawUnsafe('DROP TRIGGER fail_message')
    await Bun.sleep(60)
    expect(received.length).toBe(1)
    expect(leaked.length).toBe(0)
    const removed = new Promise<any>(resolve => bSocket.once('room:removed', resolve))
    await alice.request(`/api/rooms/${room.id}/members/${b.id}`, undefined, 'DELETE')
    expect((await removed).roomId).toBe(room.id)
    expect((await ack(bSocket, 'message:send', { ...input, clientMessageId: crypto.randomUUID() })).error.code).toBe('FORBIDDEN')
    expect((await ack(bTab, 'room:subscribe', { roomId: room.id })).error.code).toBe('FORBIDDEN')
    expect((await bob.request(`/api/invites/${invite.code}`, {})).status).toBe(403)
    await ack(aSocket, 'message:send', { ...input, clientMessageId: crypto.randomUUID(), text: 'after kick' })
    await Bun.sleep(60)
    expect(received.length).toBe(1)
    const disconnected = new Promise<void>(resolve => aSocket.once('disconnect', () => resolve()))
    const old = alice.cookie
    await alice.request('/api/auth/logout', {})
    await disconnected
    await expect(connect(app.url, old)).rejects.toThrow()
    await expect(connect(app.url, '')).rejects.toThrow()
    await db.$disconnect()
  }, 30000)
})

describe('HTTP and transport security', () => {
  test('configured per-user send limits are shared across HTTP and Socket.IO', async () => {
    const app = await fixture({ rateLimits: { SEND: 2 } })
    const client = agent(app.url)
    await client.request('/api/auth/guest', { displayName: 'Limited' })
    const socket = await connect(app.url, client.cookie)
    const send = () => ({ clientMessageId: crypto.randomUUID(), text: 'limited' })
    expect((await client.request('/api/rooms/lobby/messages', send())).status).toBe(200)
    expect((await ack(socket, 'message:send', { ...send(), roomId: 'lobby' })).data.seq).toBe(2)
    expect((await client.request('/api/rooms/lobby/messages', send())).status).toBe(429)
    expect((await ack(socket, 'message:send', { ...send(), roomId: 'lobby' })).error.code).toBe('RATE_LIMITED')
  })
  test('cross-origin mutations and handshakes, oversized JSON and unknown authority fields are rejected', async () => {
    const app = await fixture({ rateLimits: { AUTH: 10 } })
    const cross = await fetch(`${app.url}/api/auth/guest`, { method: 'POST', headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Evil' }) })
    expect(cross.status).toBe(403)
    expect((await cross.json()).error.code).toBe('ORIGIN_REJECTED')
    const alice = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Alice' })
    await expect(connect(app.url, alice.cookie, 'https://evil.invalid')).rejects.toThrow()
    const large = await alice.request('/api/auth/guest', { displayName: 'a'.repeat(20000) })
    expect(large.status).toBe(413)
    expect((await alice.request('/api/rooms/lobby/join', { userId: 'spoof' })).status).toBe(400)
    const malformed = await fetch(`${app.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid' })
    expect(malformed.status).toBe(400)
    for (let i = 0; i < 10; i++) await alice.request('/api/auth/login', { username: 'nobody', password: 'wrong' })
    expect((await alice.request('/api/auth/login', { username: 'nobody', password: 'wrong' })).status).toBe(429)
  })
})

describe('streamed body isolation', () => {
  for (const kind of ['multipart', 'JSON'] as const) {
    test(`${kind} input enforces the configured total body deadline`, async () => {
      const app = await fixture({ bodyReadTimeoutMs: 180 })
      const client = agent(app.url)
      const user = (await client.request('/api/auth/guest', { displayName: 'Slow' })).body.data.user
      const body = kind === 'multipart' ? await multipart() : { contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify({ clientMessageId: crypto.randomUUID(), text: 'must not commit' })) }
      const path = kind === 'multipart' ? '/api/rooms/lobby/attachments' : '/api/rooms/lobby/messages'
      const pending = await stalledBody(app.url, path, client.cookie, user.id, body.contentType, body.bytes)
      try {
        const result = await promptly(pending.response, 600)
        expect(result).not.toBe('blocked')
        if (result !== 'blocked') {
          expect(result.status).toBe(408)
          expect(result.body.error.code).toBe('REQUEST_TIMEOUT')
        }
      } finally { pending.finish(); await pending.response }
    })
  }
  for (const kind of ['multipart', 'JSON'] as const) {
    test(`stalled ${kind} does not block other users HTTP/socket sends or logout`, async () => {
      const app = await fixture()
      const slow = agent(app.url), sender = agent(app.url), leaving = agent(app.url)
      const user = (await slow.request('/api/auth/guest', { displayName: 'Slow' })).body.data.user
      await sender.request('/api/auth/guest', { displayName: 'Sender' })
      await leaving.request('/api/auth/guest', { displayName: 'Leaving' })
      const socket = await connect(app.url, sender.cookie)
      const body = kind === 'multipart' ? await multipart() : { contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify({ clientMessageId: crypto.randomUUID(), text: 'delayed JSON' })) }
      const path = kind === 'multipart' ? '/api/rooms/lobby/attachments' : '/api/rooms/lobby/messages'
      const upload = await stalledBody(app.url, path, slow.cookie, user.id, body.contentType, body.bytes)
      try {
        const results = await promptly(Promise.all([
          sender.request('/api/rooms/lobby/messages', { clientMessageId: crypto.randomUUID(), text: 'HTTP while uploading' }),
          ack(socket, 'message:send', { roomId: 'lobby', clientMessageId: crypto.randomUUID(), text: 'socket while uploading' }),
          leaving.request('/api/auth/logout', {})
        ]))
        expect(results).not.toBe('blocked')
        if (results !== 'blocked') {
          expect(results[0].status).toBe(200)
          expect(results[1].data.seq).toBeGreaterThan(0)
          expect(results[2].status).toBe(200)
        }
      } finally { upload.finish(); await upload.response }
    })
  }
  for (const kind of ['multipart', 'JSON'] as const) {
    for (const revoke of ['kick', 'logout'] as const) {
      test(`${revoke} during an outside-gate ${kind} body read denies commit`, async () => {
        const app = await fixture()
        const owner = agent(app.url), client = agent(app.url)
        await owner.request('/api/auth/guest', { displayName: 'Owner' })
        await client.request('/api/auth/guest', { displayName: 'Slow' })
        const room = (await owner.request('/api/rooms', { name: 'Revocation', visibility: 'public' })).body.data
        await client.request(`/api/rooms/${room.id}/join`, {})
        const body = kind === 'multipart' ? await multipart() : { contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify({ clientMessageId: crypto.randomUUID(), text: 'must not commit' })) }
        const path = `/api/rooms/${room.id}/${kind === 'multipart' ? 'attachments' : 'messages'}`
        const pending = await stalledBody(app.url, path, client.cookie, client.userId, body.contentType, body.bytes)
        try {
          const revoked = await promptly(revoke === 'kick'
            ? owner.request(`/api/rooms/${room.id}/members/${client.userId}`, undefined, 'DELETE')
            : client.request('/api/auth/logout', {}))
          expect(revoked).not.toBe('blocked')
          if (revoked !== 'blocked') expect(revoked.status).toBe(200)
        } finally { pending.finish() }
        const result = await pending.response
        expect(result.status).toBe(revoke === 'kick' ? 403 : 401)
        const { PrismaClient } = await import('../generated/client')
        const db = new PrismaClient({ datasources: { db: { url: app.databaseUrl } } })
        try {
          expect(await db.attachment.count()).toBe(0)
          expect(await db.message.count()).toBe(0)
          expect(await readdir(join(app.dir, 'uploads')).catch(() => [])).toEqual([])
        } finally { await db.$disconnect() }
      })
    }
  }
})

describe('database-only attachment persistence', () => {
  test('an authorized image survives replacement of the application filesystem', async () => {
    const app = await fixture()
    const alice = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Attachment persistence' })
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    const form = new FormData()
    form.append('file', new File([png], 'persist.png', { type: 'image/png' }))
    const upload = await fetch(`${app.url}/api/rooms/lobby/attachments`, { method: 'POST', headers: { cookie: alice.cookie, [EXPECTED_USER_HEADER]: alice.userId }, body: form })
    expect(upload.status).toBe(200)
    const attachment = (await upload.json()).data
    await alice.request('/api/rooms/lobby/messages', { clientMessageId: crypto.randomUUID(), text: '', attachmentId: attachment.id })
    await app.close()
    const { createApplication } = await factory()
    const replacement = await createApplication({ port: 0, host: '127.0.0.1', databaseUrl: app.databaseUrl, dataDir: join(app.dir, 'empty-replacement-filesystem') })
    cleanups.push(() => replacement.close())
    const image = await fetch(`${replacement.url}${attachment.url}`, { headers: { cookie: alice.cookie } })
    expect(image.status).toBe(200)
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png)
  })
})

describe('attachment storage boundaries', () => {
  test('history, summaries, send and denied downloads never select blob bytes', async () => {
    const app = await fixture()
    const alice = agent(app.url), bob = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Alice' })
    await bob.request('/api/auth/guest', { displayName: 'Bob' })
    const room = (await alice.request('/api/rooms', { name: 'Blob projections', visibility: 'private' })).body.data
    const { PrismaClient } = await import('../generated/client')
    const { Rooms } = await import('../src/rooms')
    const { Attachments } = await import('../src/attachments')
    const db = new PrismaClient({ datasources: { db: { url: app.databaseUrl } }, log: [{ emit: 'event', level: 'query' }] })
    const selects: string[] = []
    db.$on('query', event => { if (/^SELECT\b/i.test(event.query)) selects.push(event.query) })
    const noBlobReads = () => {
      expect(selects.length).toBeGreaterThan(0)
      expect(selects.filter(query => /["`]bytes["`]/i.test(query))).toEqual([])
      selects.length = 0
    }
    const rooms = new Rooms(db), attachments = new Attachments(rooms)
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    try {
      const session = await db.session.findFirstOrThrow({ where: { userId: alice.userId } })
      const attachment = await attachments.commit({ data: png, filename: 'projection.png', mimeType: 'image/png' }, room.id, alice.userId)
      expect(Object.keys(attachment).sort()).toEqual(['filename', 'id', 'mimeType', 'roomId', 'size', 'url'])
      noBlobReads()
      await expect(attachments.download(attachment.id, bob.userId)).rejects.toMatchObject({ status: 403 })
      noBlobReads()
      await db.membership.create({ data: { roomId: room.id, userId: bob.userId } })
      await expect(attachments.download(attachment.id, bob.userId)).rejects.toMatchObject({ status: 403 })
      noBlobReads()
      const input = { clientMessageId: crypto.randomUUID(), text: '', attachmentId: attachment.id }
      const sent = await rooms.send(room.id, alice.userId, session.id, input)
      expect(sent.message.attachment).toEqual(attachment)
      expect((await rooms.send(room.id, alice.userId, session.id, input)).created).toBe(false)
      noBlobReads()
      const more = Array.from({ length: 99 }, () => ({ id: crypto.randomUUID(), roomId: room.id, userId: alice.userId, filename: 'history.png', mimeType: 'image/png', size: png.length, bytes: png }))
      await db.attachment.createMany({ data: more })
      await db.message.createMany({ data: more.map((image, index) => ({ roomId: room.id, userId: alice.userId, clientMessageId: crypto.randomUUID(), seq: index + 2, text: '', attachmentId: image.id })) })
      await db.room.update({ where: { id: room.id }, data: { lastSeq: 100 } })
      const history = await rooms.page(room.id, alice.userId, { limit: 100 })
      const backfill = await rooms.page(room.id, alice.userId, { afterSeq: 0, limit: 100 })
      expect(history.messages).toHaveLength(100)
      expect(backfill.messages).toEqual(history.messages)
      expect((await rooms.summary(room.id, alice.userId)).lastMessage?.attachment?.id).toBe(more.at(-1)!.id)
      for (const message of history.messages) expect(Object.keys(message.attachment!).sort()).toEqual(['filename', 'id', 'mimeType', 'roomId', 'size', 'url'])
      noBlobReads()
      const downloaded = await attachments.download(attachment.id, bob.userId)
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(png)
      expect(selects.filter(query => /["`]bytes["`]/i.test(query))).toHaveLength(1)
      selects.length = 0
      await rooms.deleteMessage(sent.message.id, alice.userId)
      await expect(attachments.download(attachment.id, alice.userId)).rejects.toMatchObject({ status: 404 })
      noBlobReads()
    } finally { await db.$disconnect() }
  }, 30000)

  test('failed blob insertion leaves no attachment metadata or upload files', async () => {
    const app = await fixture()
    const alice = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Atomic upload' })
    const { PrismaClient } = await import('../generated/client')
    const db = new PrismaClient({ datasources: { db: { url: app.databaseUrl } } })
    try {
      await db.$executeRawUnsafe(`CREATE TRIGGER reject_attachment BEFORE INSERT ON Attachment BEGIN SELECT RAISE(ABORT, 'forced blob failure'); END`)
      const form = new FormData()
      form.set('file', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'atomic.png', { type: 'image/png' }))
      const response = await fetch(`${app.url}/api/rooms/lobby/attachments`, { method: 'POST', headers: { cookie: alice.cookie, [EXPECTED_USER_HEADER]: alice.userId }, body: form })
      expect(response.status).toBe(500)
      expect(await db.attachment.count()).toBe(0)
      expect(await readdir(join(app.dir, 'uploads')).catch(() => [])).toEqual([])
    } finally { await db.$disconnect() }
  })
})

describe('authorized attachments', () => {
  test('multipart magic and size limits, room/uploader ACL, no public static uploads and deleted attachment denial', async () => {
    const app = await fixture()
    const alice = agent(app.url), bob = agent(app.url), eve = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Alice' })
    await bob.request('/api/auth/guest', { displayName: 'Bob' })
    await eve.request('/api/auth/guest', { displayName: 'Eve' })
    const room = (await alice.request('/api/rooms', { name: 'Photos', visibility: 'private' })).body.data
    const invite = (await alice.request(`/api/rooms/${room.id}/invites`, {})).body.data
    await bob.request(`/api/invites/${invite.code}`, {})
    const upload = async (cookie: string, bytes: Uint8Array, type = 'image/png', name = 'photo.png') => {
      const form = new FormData(); form.append('file', new File([new Uint8Array(bytes)], name, { type }))
      const response = await fetch(`${app.url}/api/rooms/${room.id}/attachments`, { method: 'POST', headers: { cookie, [EXPECTED_USER_HEADER]: [alice, bob, eve].find(client => client.cookie === cookie)!.userId }, body: form })
      return { status: response.status, body: await response.json() }
    }
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64'))
    expect((await upload(eve.cookie, png)).status).toBe(403)
    expect((await upload(alice.cookie, new TextEncoder().encode('<svg><script>alert(1)</script></svg>'))).status).toBe(415)
    expect((await upload(alice.cookie, png, 'text/html')).status).toBe(415)
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024)
    const maximum = new Uint8Array(MAX_ATTACHMENT_BYTES)
    maximum.set(png)
    const atLimit = await upload(alice.cookie, maximum)
    expect(atLimit.status).toBe(200)
    expect(atLimit.body.data.size).toBe(MAX_ATTACHMENT_BYTES)
    const maximumDownload = await fetch(`${app.url}${atLimit.body.data.url}`, { headers: { cookie: alice.cookie } })
    expect(maximumDownload.status).toBe(200)
    expect(maximumDownload.headers.get('content-length')).toBe(String(MAX_ATTACHMENT_BYTES))
    expect(new Uint8Array(await maximumDownload.arrayBuffer())).toEqual(maximum)
    const oversized = new Uint8Array(MAX_ATTACHMENT_BYTES + 1)
    oversized.set(png)
    const rejected = await upload(alice.cookie, oversized)
    expect(rejected.status).toBe(413)
    expect(rejected.body.error.message).toContain('10MiB')
    const uploaded = await upload(alice.cookie, png)
    expect(uploaded.status).toBe(200)
    const attachment = uploaded.body.data
    expect(attachment.url).toBe(`/api/attachments/${attachment.id}`)
    expect((await fetch(`${app.url}${attachment.url}`)).status).toBe(401)
    expect((await fetch(`${app.url}${attachment.url}`, { headers: { cookie: eve.cookie } })).status).toBe(403)
    expect((await bob.request(`/api/rooms/${room.id}/messages`, { clientMessageId: crypto.randomUUID(), text: '', attachmentId: attachment.id })).status).toBe(403)
    const other = (await alice.request('/api/rooms', { name: 'Other' })).body.data
    expect((await alice.request(`/api/rooms/${other.id}/messages`, { clientMessageId: crypto.randomUUID(), text: '', attachmentId: attachment.id })).status).toBe(403)
    const message = (await alice.request(`/api/rooms/${room.id}/messages`, { clientMessageId: crypto.randomUUID(), text: '', attachmentId: attachment.id })).body.data
    expect(message.attachment.id).toBe(attachment.id)
    const bytes = await fetch(`${app.url}${attachment.url}`, { headers: { cookie: bob.cookie } })
    expect(bytes.status).toBe(200)
    expect(bytes.headers.get('content-type')).toBe('image/png')
    expect(bytes.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(png)
    expect((await fetch(`${app.url}/uploads/${attachment.id}`)).status).toBe(404)
    await alice.request(`/api/messages/${message.id}`, undefined, 'DELETE')
    expect((await fetch(`${app.url}${attachment.url}`, { headers: { cookie: alice.cookie } })).status).toBe(404)
    for (const [data, type] of [[new Uint8Array([255, 216, 255, 224, 0]), 'image/jpeg'], [new TextEncoder().encode('RIFF1234WEBPVP8 '), 'image/webp']] as const) expect((await upload(alice.cookie, data, type)).status).toBe(200)
  }, 30000)
})

describe('production frontend and entrypoint', () => {
  test('serves built assets and invite deep links without exposing data, source files or symlink targets', async () => {
    const webDist = await mkdtemp(join(tmpdir(), 'anyone-web-'))
    cleanups.push(() => rm(webDist, { recursive: true, force: true }))
    await Bun.write(join(webDist, 'index.html'), '<!doctype html><title>Anyone built</title>')
    await Bun.write(join(webDist, 'assets/main.js'), 'console.log("built")')
    await Bun.write(join(webDist, '.env'), 'SECRET=hidden')
    const app = await fixture({ webDist })
    const root = await fetch(app.url)
    expect(root.status).toBe(200)
    expect(await root.text()).toContain('Anyone built')
    expect(await fetch(`${app.url}/invite/somecode`).then(r => r.text())).toContain('Anyone built')
    expect(await fetch(`${app.url}/assets/main.js`).then(r => r.text())).toContain('built')
    expect((await fetch(`${app.url}/.env`)).status).toBe(404)
    expect((await fetch(`${app.url}/uploads/secret`)).status).toBe(404)
    expect((await fetch(`${app.url}/api/missing`)).status).toBe(404)
    const { symlink } = await import('node:fs/promises')
    await symlink(join(webDist, '.env'), join(webDist, 'assets/private.js'))
    expect((await fetch(`${app.url}/assets/private.js`)).status).toBe(404)
    const index = Bun.file(join(import.meta.dir, '../src/index.ts'))
    expect(await index.exists()).toBe(true)
    const entrypoint = await import('../src/index')
    expect(entrypoint.createApplication).toBeFunction()
  })
})

describe('restart and presence lifecycle', () => {
  test('reopening the same database preserves sessions, memberships, messages and read positions', async () => {
    const app = await fixture()
    const alice = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Persistent' })
    const input = { clientMessageId: crypto.randomUUID(), text: 'survives restart' }
    const message = await alice.request('/api/rooms/lobby/messages', input)
    await alice.request('/api/rooms/lobby/read', { seq: message.body.data.seq }, 'PATCH')
    await app.close()
    const { createApplication } = await factory()
    const reopened = await createApplication({ port: 0, host: '127.0.0.1', databaseUrl: app.databaseUrl, dataDir: app.dir })
    cleanups.push(() => reopened.close())
    const get = (path: string) => fetch(`${reopened.url}${path}`, { headers: { cookie: alice.cookie } }).then(r => r.json())
    expect((await get('/api/session')).data.user.displayName).toBe('Persistent')
    const lobby = (await get('/api/rooms')).data.rooms.find((r: any) => r.id === 'lobby')
    expect(lobby.lastReadSeq).toBe(1)
    expect(lobby.lastMessage.text).toBe('survives restart')
    const duplicate = await fetch(`${reopened.url}/api/rooms/lobby/messages`, { method: 'POST', headers: { cookie: alice.cookie, [EXPECTED_USER_HEADER]: alice.userId, 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(r => r.json())
    expect(duplicate.data.id).toBe(message.body.data.id)
  })
  test('disconnecting tabs, leaving and logout maintain unique-user presence and subscriptions', async () => {
    const app = await fixture()
    const alice = agent(app.url), bob = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Alice' }); await bob.request('/api/auth/guest', { displayName: 'Bob' })
    const a = await connect(app.url, alice.cookie), b = await connect(app.url, bob.cookie), tab = await connect(app.url, bob.cookie)
    const count = async () => (await alice.request('/api/rooms')).body.data.rooms.find((r: any) => r.id === 'lobby').onlineCount
    await until(async () => await count() === 2)
    tab.disconnect()
    await ack(b, 'room:subscribe', { roomId: 'lobby' })
    expect(await count()).toBe(2)
    await bob.request('/api/rooms/lobby/leave', {})
    await until(async () => await count() === 1)
    expect((await ack(b, 'room:subscribe', { roomId: 'lobby' })).error.code).toBe('FORBIDDEN')
    await bob.request('/api/rooms/lobby/join', {})
    await until(async () => await count() === 2)
    await bob.request('/api/auth/logout', {})
    await until(async () => !b.connected && await count() === 1)
    a.disconnect()
    await until(async () => await count() === 0)
  }, 30000)
  test('externally revoked sessions cannot receive subsequent messages', async () => {
    const app = await fixture()
    const alice = agent(app.url), bob = agent(app.url)
    await alice.request('/api/auth/guest', { displayName: 'Alice' }); const user = (await bob.request('/api/auth/guest', { displayName: 'Bob' })).body.data.user
    const b = await connect(app.url, bob.cookie)
    await ack(b, 'room:subscribe', { roomId: 'lobby' })
    const received: any[] = []; b.on('message:new', m => received.push(m))
    const { PrismaClient } = await import('../generated/client')
    const db = new PrismaClient({ datasources: { db: { url: app.databaseUrl } } })
    await db.session.deleteMany({ where: { userId: user.id } })
    await alice.request('/api/rooms/lobby/messages', { clientMessageId: crypto.randomUUID(), text: 'private after revoke' })
    await until(() => !b.connected)
    expect(received.length).toBe(0)
    await db.$disconnect()
  })
})

describe('commit acknowledgement order', () => {
  test('sender receives a durable ack before its broadcast event', async () => {
    const app = await fixture()
    const client = agent(app.url)
    await client.request('/api/auth/guest', { displayName: 'Sender' })
    const socket = await connect(app.url, client.cookie)
    await ack(socket, 'room:subscribe', { roomId: 'lobby' })
    const events: string[] = []
    socket.on('message:new', () => events.push('broadcast'))
    const result = await new Promise<any>(resolve => socket.emit('message:send', { roomId: 'lobby', clientMessageId: crypto.randomUUID(), text: 'commit before ack' }, (value: any) => { events.push('ack'); resolve(value) }))
    expect(result.data.seq).toBe(1)
    await until(() => events.length === 2)
    expect(events).toEqual(['ack', 'broadcast'])
  })
})

describe('application lifecycle', () => {
  test('built entry uses configured env without embedding this checkout path', async () => {
    const app = await fixture()
    await app.close()
    const cwd = join(import.meta.dir, '..')
    const build = Bun.spawn(['bun', 'run', 'build'], { cwd, stdout: 'pipe', stderr: 'pipe' })
    expect(await build.exited).toBe(0)
    const artifact = await Bun.file(join(cwd, 'dist/index.js')).text()
    expect(artifact.includes(join(cwd, 'generated/client'))).toBe(false)
    const child = Bun.spawn(['bun', 'dist/index.js'], { cwd, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATABASE_URL: app.databaseUrl, DATA_DIR: app.dir, DB_PROVIDER: 'sqlite', NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://anyone.example' }, stdout: 'pipe', stderr: 'pipe' })
    cleanups.push(async () => { child.kill('SIGTERM'); await child.exited })
    const reader = child.stdout.getReader()
    const first = await reader.read()
    reader.releaseLock()
    const output = new TextDecoder().decode(first.value)
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    expect(url).toBeString()
    expect((await fetch(`${url}/readyz`)).status).toBe(200)
    const guest = await fetch(`${url}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Built process' }) })
    expect(guest.status).toBe(200)
    expect(guest.headers.get('set-cookie')).toContain('; Secure')
    child.kill('SIGTERM')
    expect(await child.exited).toBe(0)
  }, 30000)
  test('readiness refuses a reachable database without initialized schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anyone-uninitialized-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const { createApplication } = await factory()
    const app = await createApplication({ port: 0, host: '127.0.0.1', dataDir: dir, databaseUrl: `file:${dir}/empty.sqlite` })
    cleanups.push(() => app.close())
    expect((await fetch(`${app.url}/healthz`)).status).toBe(200)
    const ready = await fetch(`${app.url}/readyz`)
    expect(ready.status).toBe(503)
    expect((await ready.json()).error.code).toBe('NOT_READY')
  })
  test('factory starts a real isolated loopback listener with health and clean shutdown', async () => {
    const app = await fixture()
    expect((await fetch(`${app.url}/healthz`).then(r => r.json()))).toEqual({ data: { status: 'ok', version: 1 } })
    expect(new URL(app.url).hostname).toBe('127.0.0.1')
    await app.close()
    await expect(fetch(`${app.url}/healthz`)).rejects.toThrow()
  })
})
