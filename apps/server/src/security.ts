import { createHash, randomBytes } from 'node:crypto'
import type { User } from '@anyone-im/contracts'

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
export const fail = (status: number, code: string, message: string): never => { throw new ApiFailure(status, code, message) }
export function parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) return fail(400, 'INVALID_INPUT', '请求参数无效')
  return result.data
}
export const randomToken = () => randomBytes(32).toString('base64url')
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex')
export const userDto = (u: { id: string; displayName: string; username: string | null; isGuest: boolean }): User => ({ id: u.id, displayName: u.displayName, username: u.username, isGuest: u.isGuest })
export function sessionHash(cookie: string | null): string | null {
  const token = cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('anyone_session='))?.slice('anyone_session='.length)
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashToken(token) : null
}
export const DEFAULT_BODY_READ_TIMEOUT_MS = 30000
export async function readLimited(request: Request, limit: number, timeoutMs = DEFAULT_BODY_READ_TIMEOUT_MS): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length')
  if (declared && Number(declared) > limit) {
    await request.body?.cancel()
    return fail(413, 'PAYLOAD_TOO_LARGE', '请求内容过大')
  }
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0, timedOut = false
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      // Cancel the actual input, not just the promise waiting on it.
      void reader.cancel().catch(() => {})
      reject(new ApiFailure(408, 'REQUEST_TIMEOUT', '请求内容读取超时'))
    }, timeoutMs)
  })
  try {
    await Promise.race([deadline, (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (timedOut) return fail(408, 'REQUEST_TIMEOUT', '请求内容读取超时')
        if (done) break
        total += value.byteLength
        if (total > limit) { await reader.cancel(); return fail(413, 'PAYLOAD_TOO_LARGE', '请求内容过大') }
        chunks.push(value)
      }
    })()])
  } finally { clearTimeout(timer!); reader.releaseLock() }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}
export type RateLimitKind = 'AUTH' | 'SEND' | 'JOIN' | 'UPLOAD' | 'SOCKET' | 'HTTP'
export function createRateLimiter(overrides: Partial<Record<RateLimitKind, number>> = {}) {
  const entries = new Map<string, { count: number; expires: number }>()
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000)
  if (!Number.isSafeInteger(windowMs) || windowMs < 100 || windowMs > 3600000) throw new Error('Invalid RATE_LIMIT_WINDOW_MS')
  const defaults: Record<string, number> = { AUTH: 10, SEND: 60, JOIN: 30, UPLOAD: 10, SOCKET: 30, HTTP: 300 }
  const limits = Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
    const limit = Number(overrides[key as RateLimitKind] ?? process.env[`RATE_LIMIT_${key}_MAX`] ?? value)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new Error(`Invalid RATE_LIMIT_${key}_MAX`)
    return [key, limit]
  }))
  return (kind: string, identity: string) => {
    const now = Date.now(), key = `${kind}:${identity}`
    if (entries.size >= 10000) {
      for (const [k, v] of entries) if (v.expires <= now) entries.delete(k)
      if (entries.size >= 10000 && !entries.has(key)) return fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试')
    }
    let entry = entries.get(key)
    if (!entry || entry.expires <= now) { entry = { count: 0, expires: now + windowMs }; entries.set(key, entry) }
    entry.count++
    if (entry.count > limits[kind]!) return fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试')
  }
}
export function errorBody(error: unknown) {
  return { error: error instanceof ApiFailure ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } }
}
/** Serialize in-process mutations (SQLite writes and subscription/ACL changes). */
export function createGate() {
  let tail: Promise<unknown> = Promise.resolve()
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn)
    tail = result.catch(() => {})
    return result
  }
}
