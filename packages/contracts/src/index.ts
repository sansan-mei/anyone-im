import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const
export const displayNameSchema = z.string().trim().min(1).max(32)
const usernameSchema = z.string().trim().toLowerCase().min(3).max(32).regex(/^[a-z0-9_]+$/)
export const guestSchema = z.object({ displayName: displayNameSchema }).strict()
export const registerSchema = z.object({ username: usernameSchema, password: z.string().min(12).max(128), displayName: displayNameSchema }).strict()
export const loginSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(128) }).strict()
export const updateProfileSchema = z.object({ displayName: displayNameSchema }).strict()
export const roomPasswordSchema = z.string().min(6).max(128)
export const joinRoomSchema = z.object({ password: z.string().max(128).optional() }).strict()
export const updateRoomPasswordSchema = z.object({ password: roomPasswordSchema }).strict()
export const createRoomSchema = z.object({ name: z.string().trim().min(1).max(64), description: z.string().trim().max(240).default(''), visibility: z.enum(['public', 'private']).default('private'), password: roomPasswordSchema.optional() }).strict().refine(v => v.visibility === 'public' || v.password !== undefined, { message: '私密房间需要 6–128 位密码' })
const messageFields = { clientMessageId: z.uuid(), text: z.string().trim().max(4000).default(''), attachmentId: z.uuid().optional() }
export const sendMessageSchema = z.object(messageFields).strict().refine((v) => !!v.text || !!v.attachmentId, { message: '消息不能为空' })
export const socketSendMessageSchema = z.object({ ...messageFields, roomId: z.string().min(1).max(64) }).strict().refine((v) => !!v.text || !!v.attachmentId, { message: '消息不能为空' })
export const readSchema = z.object({ seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()
export const DEFAULT_PORT = 4100
export const DEFAULT_MESSAGE_PAGE_SIZE = 15
export const MAX_MESSAGE_PAGE_SIZE = 20
export const SESSION_COOKIE = 'anyone_session'
export const EXPECTED_USER_HEADER = 'X-Anyone-User-Id'
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export type ApiError = { code: string; message: string }
export type Result<T> = { data: T } | { error: ApiError }
export interface User { id: string; displayName: string; username: string | null; isGuest: boolean }
export interface SessionData { user: User | null }
export interface Attachment { id: string; roomId: string; filename: string; mimeType: string; size: number; url: string; expiresAt?: string; expired?: boolean }
export interface Message {
  id: string
  roomId: string
  seq: number
  clientMessageId: string
  sender: User
  text: string
  attachment: Attachment | null
  createdAt: string
  deletedAt: string | null
}
export type RoomRole = 'owner' | 'member'
export interface RoomSummary {
  id: string
  name: string
  description: string
  visibility: 'public' | 'private'
  role: RoomRole
  memberCount: number
  onlineCount: number
  lastSeq: number
  lastReadSeq: number
  lastMessage: Message | null
  updatedAt: string
}
export interface Member { user: User; role: RoomRole; online: boolean }
export interface MessagePage { messages: Message[]; hasMore: boolean }
export interface Invite { code: string; urlPath: string; expiresAt: string }
export interface InvitePreview { roomId: string; roomName: string; expiresAt: string }
export interface SendMessageInput { clientMessageId: string; text: string; attachmentId?: string }
export interface CreateRoomInput { name: string; description: string; visibility: 'public' | 'private'; password?: string }
export interface ServerToClientEvents {
  'message:new': (message: Message) => void
  'message:deleted': (event: { roomId: string; messageId: string; seq: number }) => void
  'presence:update': (event: { roomId: string; count: number }) => void
  'room:updated': (event: { roomId: string }) => void
  'room:removed': (event: { roomId: string; reason: string }) => void
}
export interface ClientToServerEvents {
  'message:send': (input: SendMessageInput & { roomId: string }, ack: (result: Result<Message>) => void) => void
  'room:subscribe': (input: { roomId: string; afterSeq?: number }, ack: (result: Result<MessagePage>) => void) => void
}
