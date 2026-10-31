import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { RateLimitKind } from './security'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { guestSchema, loginSchema, registerSchema, updateProfileSchema, createRoomSchema, joinRoomSchema, updateRoomPasswordSchema, sendMessageSchema, readSchema, EXPECTED_USER_HEADER, MAX_ATTACHMENT_BYTES } from '@anyone-im/contracts'
import { Rooms } from './rooms'
import { Attachments } from './attachments'
import { createAttachmentRetention } from './attachment-retention'
import { createRealtime } from './realtime'
import { frontendResponse } from './frontend'
import type { WebSocketData } from '@socket.io/bun-engine'
import { PrismaClient } from '../generated/client'
import { ApiFailure, createGate, errorBody, fail, parse, randomToken, sessionHash, hashToken, userDto, readLimited, createRateLimiter, DEFAULT_BODY_READ_TIMEOUT_MS } from './security'

export interface ApplicationOptions {
  port?: number
  host?: string
  dataDir?: string
  databaseUrl?: string
  databaseProvider?: 'sqlite' | 'mysql'
  webDist?: string
  origin?: string
  production?: boolean
  rateLimits?: Partial<Record<RateLimitKind, number>>
  bodyReadTimeoutMs?: number
  attachmentCleanup?: boolean
  attachmentCleanupIntervalMs?: number
}
export async function createApplication(options: ApplicationOptions = {}) {
  const bodyReadTimeoutMs = options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS
  if (!Number.isSafeInteger(bodyReadTimeoutMs) || bodyReadTimeoutMs < 1 || bodyReadTimeoutMs > 300000) throw new Error('Invalid bodyReadTimeoutMs')
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? resolve(import.meta.dir, '../../../.data'))
  const provider = options.databaseProvider ?? process.env.DB_PROVIDER ?? 'sqlite'
  if (provider !== 'sqlite' && provider !== 'mysql') throw new Error('Invalid DB_PROVIDER')
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? (provider === 'sqlite' ? `file:${dataDir}/anyone.sqlite` : '')
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  if (provider === 'sqlite') await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  const gate = createGate()
  // Alias the runtime environment: Bun's bundler folds direct
  // process.env.NODE_ENV references at build time, which must not decide cookies.
  const runtimeEnv = process.env
  const production = options.production ?? runtimeEnv.NODE_ENV === 'production'
  let listenerOrigin = options.origin ?? process.env.PUBLIC_ORIGIN
  if (production && !listenerOrigin) throw new Error('PUBLIC_ORIGIN is required in production')
  if (listenerOrigin && new URL(listenerOrigin).origin !== listenerOrigin) throw new Error('PUBLIC_ORIGIN must be an exact origin without trailing slash')
  const checkOrigin = (request: Request) => request.headers.get('sec-fetch-site') !== 'cross-site' && (!request.headers.get('origin') || request.headers.get('origin') === listenerOrigin)
  const rateLimit = createRateLimiter(options.rateLimits)
  const preparedJson = new WeakMap<Request, unknown>()
  const dummyPasswordHash = await Bun.password.hash(randomToken(), { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 })
  // Reject excess work rather than queue unbounded memory-hard password tasks.
  let passwordTasks = 0
  const passwordWork = async <T>(run: () => Promise<T>) => {
    if (passwordTasks >= 2) return fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试')
    passwordTasks++
    try { return await run() } finally { passwordTasks-- }
  }
  let cleanupRealtime: (() => void) | undefined
  let retention: ReturnType<typeof createAttachmentRetention> | undefined
  try {
  await db.$connect()
  retention = createAttachmentRetention(db, gate, undefined, options.attachmentCleanupIntervalMs)
  const app = new Hono<{ Bindings: Bun.Server<WebSocketData> }>()
  app.onError((error, c) => c.json(errorBody(error), (error instanceof ApiFailure ? error.status : 500) as ContentfulStatusCode))
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404))
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cache-Control', 'no-store')
    await next()
  })
  app.use('/api/*', async (c, next) => {
    const ip = c.env.requestIP(c.req.raw)?.address ?? 'unknown'
    rateLimit('HTTP', ip)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (!checkOrigin(c.req.raw)) return fail(403, 'ORIGIN_REJECTED', '请求来源无效')
      if (/^\/api\/auth\/(guest|register|login)$/.test(c.req.path)) rateLimit('AUTH', ip)
      else if (/\/(join|invites|password)$/.test(c.req.path) || c.req.path.startsWith('/api/invites/')) rateLimit('JOIN', sessionHash(c.req.header('cookie') ?? null) ?? ip)
      if (!/\/attachments$/.test(c.req.path)) {
        const bytes = await readLimited(c.req.raw, 16384, bodyReadTimeoutMs)
        let value: unknown = {}
        if (bytes.length) {
          if (!c.req.header('content-type')?.startsWith('application/json')) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用JSON格式')
          try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { return fail(400, 'INVALID_INPUT', 'JSON无效') }
        }
        const shaped = /\/auth\/(guest|register|login)$|\/me$|^\/api\/rooms$|\/rooms\/[^/]+\/(messages|read|join|password)$/.test(c.req.path)
        if (!shaped && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length)) return fail(400, 'INVALID_INPUT', '请求参数无效')
        preparedJson.set(c.req.raw, value)
      }
    }
    await next()
  })
  async function json(c: { req: { raw: Request } }) { return preparedJson.get(c.req.raw) }
  async function session(hash: string | null) {
    if (!hash) return null
    const s = await db.session.findUnique({ where: { id: hash }, include: { user: true } })
    return s && s.expiresAt > new Date() ? s : null
  }
  async function auth(request: Request) {
    const current = await session(sessionHash(request.headers.get('cookie'))) ?? fail(401, 'UNAUTHENTICATED', '请先登录')
    const expectedUserId = request.headers.get(EXPECTED_USER_HEADER)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && expectedUserId === null) return fail(428, 'PRECONDITION_REQUIRED', '请提供当前用户身份')
    if (expectedUserId !== null && expectedUserId !== current.userId) return fail(409, 'SESSION_CHANGED', '登录身份已更改，请刷新后重试')
    return current
  }
  const cookie = (token: string, clear = false) => `anyone_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 2592000}${production ? '; Secure' : ''}`
  async function establish(userId: string, oldHash: string | null) {
    const token = randomToken()
    await db.$transaction(async tx => {
      if (oldHash) await tx.session.deleteMany({ where: { id: oldHash } })
      await tx.session.create({ data: { id: hashToken(token), userId, expiresAt: new Date(Date.now() + 2592000000) } })
      const lobby = await tx.room.upsert({ where: { id: 'lobby' }, create: { id: 'lobby', name: '大厅', description: '公共聊天室', visibility: 'public' }, update: {} })
      await tx.membership.upsert({ where: { roomId_userId: { roomId: lobby.id, userId } }, create: { roomId: lobby.id, userId }, update: {} })
    })
    if (oldHash) realtime.disconnectSession(oldHash)
    return token
  }
  app.get('/healthz', c => c.json({ data: { status: 'ok', version: 1 } }))
  app.get('/readyz', async c => {
    try {
      await db.$transaction([
        db.user.findFirst({ select: { id: true } }), db.session.findFirst({ select: { id: true } }),
        db.room.findFirst({ select: { id: true } }), db.membership.findFirst({ select: { roomId: true } }),
        db.message.findFirst({ select: { id: true } }), db.invite.findFirst({ select: { id: true } }), db.attachment.findFirst({ select: { id: true } })
      ])
      return c.json({ data: { status: 'ok', version: 1 } })
    } catch { return fail(503, 'NOT_READY', '数据库尚未就绪') }
  })
  app.get('/api/session', async c => {
    const current = await session(sessionHash(c.req.header('cookie') ?? null))
    return c.json({ data: { user: current ? userDto(current.user) : null } })
  })
  app.post('/api/auth/guest', async c => {
    const input = parse(guestSchema, await json(c))
    return gate(async () => {
      const oldHash = sessionHash(c.req.header('cookie') ?? null)
      const existing = await session(oldHash)
      if (existing) return c.json({ data: { user: userDto(existing.user) } })
      const user = await db.user.create({ data: { displayName: input.displayName } })
      const token = await establish(user.id, oldHash)
      c.header('Set-Cookie', cookie(token))
      return c.json({ data: { user: userDto(user) } })
    })
  })
  app.post('/api/auth/register', async c => {
    const input = parse(registerSchema, await json(c))
    const passwordHash = await Bun.password.hash(input.password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 })
    return gate(async () => {
      if (await db.user.findUnique({ where: { username: input.username } })) return fail(409, 'USERNAME_TAKEN', '用户名已存在')
      const user = await db.user.create({ data: { username: input.username, displayName: input.displayName, isGuest: false, passwordHash } })
      const token = await establish(user.id, sessionHash(c.req.header('cookie') ?? null))
      c.header('Set-Cookie', cookie(token))
      return c.json({ data: { user: userDto(user) } })
    })
  })
  app.post('/api/auth/login', async c => {
    const input = parse(loginSchema, await json(c))
    const user = await db.user.findUnique({ where: { username: input.username } })
    const valid = await Bun.password.verify(input.password, user?.passwordHash ?? dummyPasswordHash)
    if (!user?.passwordHash || !valid) return fail(401, 'INVALID_CREDENTIALS', '用户名或密码错误')
    return gate(async () => {
      const token = await establish(user.id, sessionHash(c.req.header('cookie') ?? null))
      c.header('Set-Cookie', cookie(token))
      return c.json({ data: { user: userDto(user) } })
    })
  })
  app.post('/api/auth/logout', async c => gate(async () => {
    const s = await auth(c.req.raw)
    await db.session.deleteMany({ where: { id: s.id } })
    realtime.disconnectSession(s.id)
    c.header('Set-Cookie', cookie('', true))
    return c.json({ data: null })
  }))
  app.patch('/api/me', async c => {
    const input = parse(updateProfileSchema, await json(c))
    return gate(async () => {
      const s = await auth(c.req.raw)
      const user = await db.user.update({ where: { id: s.userId }, data: input })
      return c.json({ data: userDto(user) })
    })
  })
  const rooms = new Rooms(db)
  const attachments = new Attachments(rooms)
  app.post('/api/rooms/:id/attachments', async c => {
    await gate(async () => {
      const s = await auth(c.req.raw)
      rateLimit('UPLOAD', s.userId)
      await rooms.member(c.req.param('id'), s.userId)
    })
    // Network input must never hold the application-wide commit/ACL gate.
    const prepared = await attachments.prepare(c.req.raw, bodyReadTimeoutMs)
    return gate(async () => {
      const s = await auth(c.req.raw)
      return c.json({ data: await attachments.commit(prepared, c.req.param('id'), s.userId) })
    })
  })
  app.get('/api/attachments/:id', async c => gate(async () => {
    const s = await auth(c.req.raw)
    return attachments.download(c.req.param('id'), s.userId)
  }))
  const realtime = createRealtime(rooms, session, gate, checkOrigin, rateLimit)
  cleanupRealtime = realtime.close
  app.all('/socket.io/', c => realtime.engine.handleRequest(c.req.raw, c.env))
  app.get('/api/rooms', async c => gate(async () => {
    const s = await auth(c.req.raw)
    const memberships = await db.membership.findMany({ where: { userId: s.userId, active: true, banned: false }, include: { room: true }, orderBy: { room: { updatedAt: 'desc' } } })
    return c.json({ data: { rooms: await Promise.all(memberships.map(m => rooms.summary(m.roomId, s.userId))) } })
  }))
  app.get('/api/rooms/public', async c => gate(async () => {
    const s = await auth(c.req.raw)
    const publicRooms = await db.room.findMany({ where: { visibility: 'public', memberships: { none: { userId: s.userId, banned: true } } }, orderBy: { updatedAt: 'desc' }, take: 100 })
    return c.json({ data: { rooms: await Promise.all(publicRooms.map(r => rooms.summary(r.id, s.userId))) } })
  }))
  app.post('/api/rooms', async c => {
    await gate(async () => { const s = await auth(c.req.raw); rateLimit('JOIN', s.id) })
    const { password, ...input } = parse(createRoomSchema, await json(c))
    const passwordHash = input.visibility === 'private' ? await passwordWork(() => Bun.password.hash(password!, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 })) : undefined
    return gate(async () => {
      const s = await auth(c.req.raw)
      const room = await rooms.create(s.userId, { ...input, passwordHash })
      await realtime.joinUser(room.id, s.userId)
      return c.json({ data: room })
    })
  })
  app.post('/api/rooms/:id/join', async c => {
    const input = parse(joinRoomSchema, await json(c))
    const snapshot = await gate(async () => {
      const s = await auth(c.req.raw)
      const room = await db.room.findUnique({ where: { id: c.req.param('id') }, select: { visibility: true, passwordHash: true } })
      return { userId: s.userId, room }
    })
    let verifiedHash: string | undefined
    if (snapshot.room?.visibility !== 'public') {
      const valid = await passwordWork(() => Bun.password.verify(input.password ?? '', snapshot.room?.passwordHash ?? dummyPasswordHash))
      if (!snapshot.room?.passwordHash || !valid) return fail(404, 'NOT_FOUND', '聊天室不存在')
      verifiedHash = snapshot.room.passwordHash
    }
    return gate(async () => {
      const s = await auth(c.req.raw)
      if (s.userId !== snapshot.userId) return fail(409, 'SESSION_CHANGED', '登录身份已更改，请刷新后重试')
      const room = await rooms.join(c.req.param('id'), s.userId, undefined, verifiedHash)
      await realtime.joinUser(room.id, s.userId)
      return c.json({ data: room })
    })
  })
  app.patch('/api/rooms/:id/password', async c => {
    const input = parse(updateRoomPasswordSchema, await json(c))
    const checkOwner = async () => {
      const s = await auth(c.req.raw)
      await rooms.member(c.req.param('id'), s.userId, db, true)
      const room = await db.room.findUnique({ where: { id: c.req.param('id') }, select: { visibility: true } })
      if (room?.visibility !== 'private') return fail(400, 'INVALID_INPUT', '仅私密房间可以设置密码')
      return s.userId
    }
    const owner = await gate(checkOwner)
    const passwordHash = await passwordWork(() => Bun.password.hash(input.password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 }))
    return gate(async () => {
      if (await checkOwner() !== owner) return fail(409, 'SESSION_CHANGED', '登录身份已更改，请刷新后重试')
      await db.room.update({ where: { id: c.req.param('id') }, data: { passwordHash } })
      return c.json({ data: null })
    })
  })
  app.post('/api/rooms/:id/leave', async c => gate(async () => {
    const s = await auth(c.req.raw)
    await rooms.remove(c.req.param('id'), s.userId, s.userId, false)
    await realtime.removeUser(c.req.param('id'), s.userId, 'left')
    return c.json({ data: null })
  }))
  app.get('/api/rooms/:id/messages', async c => gate(async () => {
    const s = await auth(c.req.raw)
    return c.json({ data: await rooms.page(c.req.param('id'), s.userId, c.req.query()) })
  }))
  app.post('/api/rooms/:id/messages', async c => {
    const input = parse(sendMessageSchema, await json(c))
    return gate(async () => {
      const s = await auth(c.req.raw)
      rateLimit('SEND', s.userId)
      const result = await rooms.send(c.req.param('id'), s.userId, s.id, input)
      if (result.created) { await realtime.publish(result.message.roomId, 'message:new', result.message); await realtime.publish(result.message.roomId, 'room:updated', { roomId: result.message.roomId }) }
      return c.json({ data: result.message })
    })
  })
  app.patch('/api/rooms/:id/read', async c => {
    const input = parse(readSchema, await json(c))
    return gate(async () => {
      const s = await auth(c.req.raw)
      await rooms.read(c.req.param('id'), s.userId, input.seq)
      return c.json({ data: null })
    })
  })
  app.delete('/api/messages/:messageId', async c => gate(async () => {
    const s = await auth(c.req.raw)
    const deletion = await rooms.deleteMessage(c.req.param('messageId'), s.userId)
    await realtime.publish(deletion.roomId, 'message:deleted', deletion)
    await realtime.publish(deletion.roomId, 'room:updated', { roomId: deletion.roomId })
    return c.json({ data: null })
  }))
  app.get('/api/rooms/:id/members', async c => gate(async () => {
    const s = await auth(c.req.raw), roomId = c.req.param('id')
    await rooms.member(roomId, s.userId)
    const memberships = await db.membership.findMany({ where: { roomId, active: true, banned: false }, include: { user: true } })
    return c.json({ data: { members: memberships.map(m => ({ user: userDto(m.user), role: m.role, online: rooms.online(roomId, m.userId) > 0 })) } })
  }))
  app.post('/api/rooms/:id/invites', async c => gate(async () => {
    const s = await auth(c.req.raw)
    return c.json({ data: await rooms.createInvite(c.req.param('id'), s.userId) })
  }))
  app.delete('/api/rooms/:id/invites', async c => gate(async () => {
    const s = await auth(c.req.raw), roomId = c.req.param('id')
    await rooms.member(roomId, s.userId, db, true)
    const result = await db.invite.updateMany({ where: { roomId, revoked: false, expiresAt: { gt: new Date() } }, data: { revoked: true } })
    return c.json({ data: { revoked: result.count } })
  }))
  app.get('/api/invites/:code', async c => {
    const invite = await rooms.invite(c.req.param('code'))
    return c.json({ data: { roomId: invite.roomId, roomName: invite.room.name, expiresAt: invite.expiresAt.toISOString() } })
  })
  app.post('/api/invites/:code', async c => gate(async () => {
    const s = await auth(c.req.raw)
    const invite = await rooms.invite(c.req.param('code'))
    const room = await rooms.join(invite.roomId, s.userId, c.req.param('code'))
    await realtime.joinUser(room.id, s.userId)
    return c.json({ data: room })
  }))
  app.delete('/api/rooms/:id/members/:userId', async c => gate(async () => {
    const s = await auth(c.req.raw)
    await rooms.remove(c.req.param('id'), s.userId, c.req.param('userId'), true)
    await realtime.removeUser(c.req.param('id'), c.req.param('userId'), 'kicked')
    return c.json({ data: null })
  }))
  const webDist = resolve(options.webDist ?? process.env.WEB_DIST ?? resolve(import.meta.dir, '../../web/dist'))
  app.get('*', async c => await frontendResponse(c.req.raw, webDist) ?? c.notFound())
  const server = Bun.serve({ ...realtime.engine.handler(), hostname: options.host ?? process.env.HOST ?? '127.0.0.1', port: options.port ?? Number(process.env.PORT ?? 4100), maxRequestBodySize: MAX_ATTACHMENT_BYTES + 65536, fetch: (request, server) => app.fetch(request, server) })
  listenerOrigin ??= `http://${server.hostname}:${server.port}`
  if (options.attachmentCleanup !== false) retention.start()
  let closePromise: Promise<void> | undefined
  const close = () => closePromise ??= (async () => { realtime.close(); await retention?.stop(); await server.stop(true); await gate(async () => {}); await db.$disconnect() })()
  return { url: `http://${server.hostname}:${server.port}`, server, close, cleanupExpiredAttachments: retention.run }
  } catch (error) { cleanupRealtime?.(); await retention?.stop(); await db.$disconnect(); throw error }
}
