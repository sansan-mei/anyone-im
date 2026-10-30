import { EXPECTED_USER_HEADER, type Result } from '@anyone-im/contracts'
export class ApiFailure extends Error { constructor(public code: string, message: string, public status: number) { super(message) } }
export const SESSION_CHANGED_TEXT = '会话已变化。为保护未发送内容，已关闭旧会话；请重新确认身份后继续。'
type Request = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, ownerId?: string, binary = false): Promise<T> {
  const headers = new Headers()
  if (!(body instanceof FormData)) headers.set('Content-Type', 'application/json')
  if (ownerId) headers.set(EXPECTED_USER_HEADER, ownerId)
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', signal, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) })
  if (binary && response.ok) return await response.blob() as T
  let result: Result<T>
  try { result = await response.json() } catch { throw new ApiFailure('NETWORK', '服务暂时不可用，请稍后重试', response.status) }
  if ('error' in result) throw new ApiFailure(result.error.code, result.error.message, response.status)
  if (!response.ok) throw new ApiFailure('HTTP_ERROR', '请求未完成，请重试', response.status)
  return result.data
}
// Only session discovery and onboarding are intentionally unbound.
export const publicApi: Request = (path, method, body, signal) => {
  if (!/^\/(session|auth\/(guest|register|login))$/.test(path)) throw new Error('Protected request requires a session context')
  return request(path, method, body, signal)
}
export type SessionApi = Request & { ownerId: string; resource: (path: string, signal?: AbortSignal) => Promise<Blob>; assertCurrent: () => void; isCurrent: () => boolean; invalidate: () => void; dispose: () => void }
export function createSessionApi(ownerId: string, onChanged: () => void): SessionApi {
  let current = true
  const failure = () => new ApiFailure('SESSION_CHANGED', SESSION_CHANGED_TEXT, 409)
  const assertCurrent = () => { if (!current) throw failure() }
  const invalidate = () => { if (current) { current = false; onChanged() } }
  const perform = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent()
    try {
      const data = await operation()
      // A late response must never populate a replacement workspace or finish an old action.
      assertCurrent()
      return data
    } catch(e) {
      if (e instanceof ApiFailure && (e.code === 'SESSION_CHANGED' || e.status === 401)) invalidate()
      throw e
    }
  }
  const bound: Request = (path, method, body, signal) => perform(() => request(path, method, body, signal, ownerId))
  const resource = (path: string, signal?: AbortSignal) => perform(() => request<Blob>(path, 'GET', undefined, signal, ownerId, true))
  return Object.assign(bound, { ownerId, resource, assertCurrent, isCurrent: () => current, invalidate, dispose: () => { current = false } })
}
export const errorText = (e: unknown) => e instanceof Error ? (e instanceof TypeError ? '网络连接中断，请检查网络后重试' : e.message) : '操作未完成，请重试'
