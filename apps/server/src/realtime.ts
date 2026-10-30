import { Server as Engine } from '@socket.io/bun-engine'
import { Server, type Socket } from 'socket.io'
import { socketSendMessageSchema } from '@relay-im/contracts'
import type { ClientToServerEvents, ServerToClientEvents, Result } from '@relay-im/contracts'
import { Rooms } from './rooms'
import { ApiFailure, errorBody, fail, parse, sessionHash } from './security'

type Session = { id: string; userId: string; expiresAt: Date }
type SocketData = { sessionId: string; userId: string; rooms: Set<string> }
type LiveSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<never, never>, SocketData>
type Gate = <T>(fn: () => Promise<T>) => Promise<T>
export function createRealtime(rooms: Rooms, session: (hash: string | null) => Promise<Session | null>, gate: Gate, checkOrigin: (request: Request) => boolean, rateLimit: (kind: string, identity: string) => void) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<never, never>, SocketData>({ maxHttpBufferSize: 32768 })
  const engine = new Engine({ path: '/socket.io/', maxHttpBufferSize: 32768, allowRequest: async (request, server) => { rateLimit('SOCKET', server.requestIP(request)?.address ?? 'unknown'); if (!checkOrigin(request)) throw new Error('Origin rejected'); if (!await session(sessionHash(request.headers.get('cookie')))) throw new Error('Authentication required') } })
  io.bind(engine)
  const sockets = new Map<string, LiveSocket>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  function count(roomId: string, userId?: string) {
    const users = new Set<string>()
    for (const s of sockets.values()) if (s.data.rooms.has(roomId) && (!userId || s.data.userId === userId)) users.add(s.data.userId)
    return users.size
  }
  rooms.online = count
  async function alive(s: LiveSocket, roomId?: string) {
    const current = await session(s.data.sessionId)
    if (!current) { s.disconnect(true); return false }
    if (roomId) {
      try { await rooms.member(roomId, s.data.userId) } catch (error) { if (!(error instanceof ApiFailure)) throw error; s.data.rooms.delete(roomId); await s.leave(`room:${roomId}`); return false }
    }
    return s.connected
  }
  async function publish<E extends keyof ServerToClientEvents>(roomId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>) {
    for (const s of [...sockets.values()]) if (s.data.rooms.has(roomId) && await alive(s, roomId)) {
      // Socket.IO's generic conditional event arguments do not reduce for E.
      ;(s.emit as (...args: unknown[]) => boolean)(event, ...args)
    }
  }
  const presence = async (roomId: string) => publish(roomId, 'presence:update', { roomId, count: count(roomId) })
  async function add(s: LiveSocket, roomId: string) {
    if (!s.connected || s.data.rooms.has(roomId)) return
    await s.join(`room:${roomId}`)
    s.data.rooms.add(roomId)
    await presence(roomId)
  }
  async function joinUser(roomId: string, userId: string) {
    for (const s of sockets.values()) if (s.data.userId === userId && await alive(s, roomId)) await add(s, roomId)
    await publish(roomId, 'room:updated', { roomId })
  }
  async function removeUser(roomId: string, userId: string, reason: string) {
    for (const s of sockets.values()) if (s.data.userId === userId && s.data.rooms.has(roomId)) {
      s.data.rooms.delete(roomId)
      await s.leave(`room:${roomId}`)
      s.emit('room:removed', { roomId, reason })
    }
    await presence(roomId)
    await publish(roomId, 'room:updated', { roomId })
  }
  function disconnectSession(hash: string) { for (const s of sockets.values()) if (s.data.sessionId === hash) s.disconnect(true) }
  io.use((socket, next) => {
    void session(sessionHash(socket.handshake.headers.cookie ?? null)).then(s => {
      if (!s) return next(new Error('UNAUTHENTICATED'))
      const expectedUserId = socket.handshake.query.expectedUserId
      if (expectedUserId !== undefined && (typeof expectedUserId !== 'string' || expectedUserId !== s.userId)) return next(new Error('SESSION_CHANGED'))
      socket.data = { sessionId: s.id, userId: s.userId, rooms: new Set() }
      next()
    }, () => next(new Error('INTERNAL_ERROR')))
  })
  io.on('connection', socket => {
    sockets.set(socket.id, socket)
    // Admission happens before the async transaction queue, not after it.
    socket.use((packet, next) => {
      try {
        if (packet[0] === 'message:send') rateLimit('SEND', socket.data.userId)
        else if (packet[0] === 'room:subscribe') rateLimit('JOIN', socket.data.userId)
        next()
      } catch (error) {
        const acknowledge = packet[packet.length - 1]
        if (typeof acknowledge === 'function') acknowledge(errorBody(error))
      }
    })
    const respond = async <T>(ack: ((result: Result<T>) => void) | undefined, fn: () => Promise<T>, afterAck?: (data: T) => Promise<void>) => {
      if (typeof ack !== 'function') return
      let acknowledged = false
      try {
        await gate(async () => {
          if (!await alive(socket)) return fail(401, 'UNAUTHENTICATED', '请先登录')
          const data = await fn()
          ack({ data })
          acknowledged = true
          // A committed write is acknowledged before notification. A failed
          // notification is recovered by durable backfill, never a second ack.
          if (afterAck) await afterAck(data)
        })
      } catch (error) { if (!acknowledged) ack(errorBody(error)) }
    }
    socket.on('message:send', (input, ack) => {
      let committed: Awaited<ReturnType<Rooms['send']>> | undefined
      void respond(ack, async () => {
        const { roomId, ...messageInput } = parse(socketSendMessageSchema, input)
        committed = await rooms.send(roomId, socket.data.userId, socket.data.sessionId, messageInput)
        return committed.message
      }, async message => {
        if (committed?.created) { await publish(message.roomId, 'message:new', message); await publish(message.roomId, 'room:updated', { roomId: message.roomId }) }
      })
    })
    socket.on('room:subscribe', (input, ack) => { void respond(ack, async () => {
      if (!input || typeof input !== 'object' || Object.keys(input).some(k => k !== 'roomId' && k !== 'afterSeq') || typeof input.roomId !== 'string' || input.roomId.length < 1 || input.roomId.length > 64 || (input.afterSeq !== undefined && (!Number.isSafeInteger(input.afterSeq) || input.afterSeq < 0))) return fail(400, 'INVALID_INPUT', '订阅参数无效')
      const page = await rooms.page(input.roomId, socket.data.userId, { afterSeq: input.afterSeq })
      await add(socket, input.roomId)
      return page
    }) })
    socket.on('disconnect', () => {
      clearTimeout(timers.get(socket.id)); timers.delete(socket.id)
      const roomIds = [...socket.data.rooms]
      socket.data.rooms.clear(); sockets.delete(socket.id)
      void gate(async () => { for (const roomId of roomIds) await presence(roomId) }).catch(() => {})
    })
    void gate(async () => {
      const current = await session(socket.data.sessionId)
      if (!current || !socket.connected) return socket.disconnect(true)
      const delay = Math.max(0, Math.min(2147483647, current.expiresAt.getTime() - Date.now()))
      timers.set(socket.id, setTimeout(() => socket.disconnect(true), delay))
      const memberships = await rooms.db.membership.findMany({ where: { userId: socket.data.userId, active: true, banned: false } })
      for (const m of memberships) await add(socket, m.roomId)
    }).catch(() => socket.disconnect(true))
  })
  return { engine, io, publish, joinUser, removeUser, disconnectSession, close() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); io.disconnectSockets(true); engine.close() } }
}
