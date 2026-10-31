import type { Message as MessageDTO, RoomSummary, Attachment as AttachmentDTO, SendMessageInput, MessagePage } from '@anyone-im/contracts'
import { PrismaClient, Prisma } from '../generated/client'
import { fail, hashToken, randomToken, userDto } from './security'
import { attachmentExpired, ATTACHMENT_TTL_MS } from './attachment-retention'

type Database = Prisma.TransactionClient
// Never load image bytes for history, summaries, backfill or send acknowledgements.
export const attachmentMetadataSelect = { id: true, roomId: true, filename: true, mimeType: true, size: true, createdAt: true, expiredAt: true } as const
export const messageInclude = { sender: true, attachment: { select: attachmentMetadataSelect } } as const
type StoredMessage = Prisma.MessageGetPayload<{ include: typeof messageInclude }>
export function attachmentDto(a: { id: string; roomId: string; filename: string; mimeType: string; size: number; createdAt: Date; expiredAt: Date | null }, now = Date.now()): AttachmentDTO {
  return { id: a.id, roomId: a.roomId, filename: a.filename, mimeType: a.mimeType, size: a.size, url: `/api/attachments/${a.id}`, expiresAt: new Date(a.createdAt.getTime() + ATTACHMENT_TTL_MS).toISOString(), expired: attachmentExpired(a, new Date(now)) }
}
export function messageDto(m: StoredMessage, now = Date.now()): MessageDTO {
  return { id: m.id, roomId: m.roomId, seq: m.seq, clientMessageId: m.clientMessageId, text: m.deletedAt ? '' : m.text, attachment: !m.deletedAt && m.attachment ? attachmentDto(m.attachment, now) : null, sender: userDto(m.sender), createdAt: m.createdAt.toISOString(), deletedAt: m.deletedAt?.toISOString() ?? null }
}
export class Rooms {
  online = (_roomId: string, _userId?: string): number => 0
  constructor(readonly db: PrismaClient, readonly now = () => Date.now()) {}
  async member(roomId: string, userId: string, tx: Database = this.db, owner = false) {
    const m = await tx.membership.findUnique({ where: { roomId_userId: { roomId, userId } } })
    if (!m?.active || m.banned || (owner && m.role !== 'owner')) return fail(403, 'FORBIDDEN', '无权访问此聊天室')
    return m
  }
  async summary(roomId: string, userId: string): Promise<RoomSummary> {
    const room = await this.db.room.findUnique({ where: { id: roomId }, include: { memberships: { where: { active: true, banned: false } }, messages: { orderBy: { seq: 'desc' }, take: 1, include: messageInclude } } })
    if (!room) return fail(404, 'NOT_FOUND', '聊天室不存在')
    const m = room.memberships.find(m => m.userId === userId)
    if (!m && room.visibility !== 'public') return fail(403, 'FORBIDDEN', '无权访问此聊天室')
    return { id: room.id, name: room.name, description: room.description, visibility: room.visibility as 'private' | 'public', role: m?.role === 'owner' ? 'owner' : 'member', memberCount: room.memberships.length, onlineCount: this.online(roomId), lastSeq: room.lastSeq, lastReadSeq: m?.lastReadSeq ?? 0, lastMessage: m && room.messages[0] ? messageDto(room.messages[0], this.now()) : null, updatedAt: room.updatedAt.toISOString() }
  }
  async create(userId: string, input: { name: string; description: string; visibility: string; passwordHash?: string }) {
    const room = await this.db.room.create({ data: { ...input, memberships: { create: { userId, role: 'owner' } } } })
    return this.summary(room.id, userId)
  }
  async join(roomId: string, userId: string, inviteCode?: string, verifiedPasswordHash?: string) {
    await this.db.$transaction(async tx => {
      const room = await tx.room.findUnique({ where: { id: roomId } })
      // Recheck the exact hash verified outside the write gate. A concurrent
      // password rotation must not authorize entry with the previous password.
      if (!room || (!inviteCode && room.visibility !== 'public' && (!verifiedPasswordHash || room.passwordHash !== verifiedPasswordHash))) return fail(404, 'NOT_FOUND', '聊天室不存在')
      // A write lock serializes joins and room ACL mutations on MySQL.
      await tx.room.update({ where: { id: roomId }, data: { updatedAt: room.updatedAt } })
      if (inviteCode && (await this.invite(inviteCode, tx)).roomId !== roomId) return fail(404, 'NOT_FOUND', '聊天室不存在')
      const previous = await tx.membership.findUnique({ where: { roomId_userId: { roomId, userId } } })
      if (previous?.banned) return fail(403, 'BANNED', '已被移出此聊天室')
      await tx.membership.upsert({ where: { roomId_userId: { roomId, userId } }, create: { roomId, userId }, update: { active: true } })
    })
    return this.summary(roomId, userId)
  }
  async remove(roomId: string, actorId: string, targetId: string, kick: boolean) {
    await this.db.$transaction(async tx => {
      const room = await tx.room.findUnique({ where: { id: roomId } })
      if (!room) return fail(403, 'FORBIDDEN', '无权访问此聊天室')
      await tx.room.update({ where: { id: roomId }, data: { updatedAt: new Date() } })
      await this.member(roomId, actorId, tx, kick)
      const target = await this.member(roomId, targetId, tx)
      if (target.role === 'owner') return fail(400, 'OWNER_CANNOT_LEAVE', '不能移除聊天室所有者')
      await tx.membership.update({ where: { roomId_userId: { roomId, userId: targetId } }, data: { active: false, banned: kick } })
    })
  }
  async page(roomId: string, userId: string, query: { beforeSeq?: string | number; afterSeq?: string | number; limit?: string | number } = {}): Promise<MessagePage> {
    await this.member(roomId, userId)
    const number = (v: string | number | undefined, fallback?: number) => {
      if (v === undefined) return fallback
      if (typeof v === 'string' && !/^\d+$/.test(v)) return fail(400, 'INVALID_INPUT', '分页参数无效')
      const n = Number(v)
      if (!Number.isSafeInteger(n) || n < 0) return fail(400, 'INVALID_INPUT', '分页参数无效')
      return n
    }
    const before = number(query.beforeSeq), after = number(query.afterSeq), limit = number(query.limit, 50)!
    if ((before !== undefined && after !== undefined) || limit < 1 || limit > 100) return fail(400, 'INVALID_INPUT', '分页参数无效')
    const forward = after !== undefined
    const results = await this.db.message.findMany({ where: { roomId, ...(before !== undefined ? { seq: { lt: before } } : after !== undefined ? { seq: { gt: after } } : {}) }, orderBy: { seq: forward ? 'asc' : 'desc' }, take: limit + 1, include: messageInclude })
    const messages = results.slice(0, limit)
    if (!forward) messages.reverse()
    return { messages: messages.map(message => messageDto(message, this.now())), hasMore: results.length > limit }
  }
  async send(roomId: string, userId: string, sessionId: string, input: SendMessageInput) {
    return this.db.$transaction(async tx => {
      const room = await tx.room.findUnique({ where: { id: roomId } })
      if (!room) return fail(403, 'FORBIDDEN', '无权访问此聊天室')
      await tx.room.update({ where: { id: roomId }, data: { updatedAt: room.updatedAt } })
      const session = await tx.session.findUnique({ where: { id: sessionId } })
      if (!session || session.userId !== userId || session.expiresAt <= new Date()) return fail(401, 'UNAUTHENTICATED', '请先登录')
      await this.member(roomId, userId, tx)
      const previous = await tx.message.findUnique({ where: { roomId_userId_clientMessageId: { roomId, userId, clientMessageId: input.clientMessageId } }, include: messageInclude })
      if (previous) {
        if (previous.text !== input.text || previous.attachmentId !== (input.attachmentId ?? null)) return fail(409, 'IDEMPOTENCY_CONFLICT', '消息ID已用于不同内容')
        return { message: messageDto(previous, this.now()), created: false }
      }
      if (input.attachmentId) {
        const attachment = await tx.attachment.findUnique({ where: { id: input.attachmentId }, select: { roomId: true, userId: true, createdAt: true, expiredAt: true, message: { select: { id: true } } } })
        if (!attachment || attachment.roomId !== roomId || attachment.userId !== userId || attachment.message) return fail(403, 'INVALID_ATTACHMENT', '附件不可用')
        if (attachmentExpired(attachment, new Date(this.now()))) return fail(410, 'ATTACHMENT_EXPIRED', '图片已过期')
      }
      const updated = await tx.room.update({ where: { id: roomId }, data: { lastSeq: { increment: 1 }, updatedAt: new Date() } })
      const message = await tx.message.create({ data: { roomId, userId, seq: updated.lastSeq, clientMessageId: input.clientMessageId, text: input.text, attachmentId: input.attachmentId }, include: messageInclude })
      return { message: messageDto(message, this.now()), created: true }
    })
  }
  async read(roomId: string, userId: string, seq: number) {
    await this.db.$transaction(async tx => {
      const m = await this.member(roomId, userId, tx)
      const room = await tx.room.findUniqueOrThrow({ where: { id: roomId } })
      if (seq > room.lastSeq) return fail(400, 'INVALID_INPUT', '读取位置超出消息范围')
      if (seq > m.lastReadSeq) await tx.membership.updateMany({ where: { roomId, userId, lastReadSeq: { lt: seq } }, data: { lastReadSeq: seq } })
    })
  }
  async deleteMessage(messageId: string, userId: string) {
    return this.db.$transaction(async tx => {
      const message = await tx.message.findUnique({ where: { id: messageId } })
      if (!message) return fail(404, 'NOT_FOUND', '消息不存在')
      const m = await this.member(message.roomId, userId, tx)
      if (m.role !== 'owner' && message.userId !== userId) return fail(403, 'FORBIDDEN', '无权删除消息')
      if (!message.deletedAt) await tx.message.update({ where: { id: messageId }, data: { deletedAt: new Date() } })
      return { roomId: message.roomId, messageId: message.id, seq: message.seq }
    })
  }
  async createInvite(roomId: string, userId: string) {
    await this.member(roomId, userId, this.db, true)
    const code = randomToken(), expiresAt = new Date(Date.now() + 86400000)
    await this.db.invite.create({ data: { id: hashToken(code), roomId, expiresAt } })
    return { code, urlPath: `/invite/${code}`, expiresAt: expiresAt.toISOString() }
  }
  async invite(code: string, tx: Database = this.db) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return fail(404, 'NOT_FOUND', '邀请不存在或已失效')
    const invite = await tx.invite.findUnique({ where: { id: hashToken(code) }, include: { room: true } })
    if (!invite || invite.revoked || invite.expiresAt <= new Date()) return fail(404, 'NOT_FOUND', '邀请不存在或已失效')
    return invite
  }
}
