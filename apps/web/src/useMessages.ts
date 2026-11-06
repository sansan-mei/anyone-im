import { useCallback, useEffect, useRef, useState } from 'react'
import type { Attachment, Message, MessagePage, SendMessageInput, User } from '@anyone-im/contracts'
import { DEFAULT_MESSAGE_PAGE_SIZE } from '@anyone-im/contracts'
import { errorText } from './api'
import { useApi } from './SessionContext'
import { HistoryCache, type HistoryEntry } from './history-cache'
export interface Outgoing { roomId: string; userId: string; input: SendMessageInput; attachment?: Attachment; state: 'sending' | 'failed'; error?: string }
export function useMessages(user: User, roomId: string) {
  const api = useApi()
  const cacheRef = useRef<HistoryCache | null>(null)
  if (!cacheRef.current) cacheRef.current = new HistoryCache()
  const history = cacheRef.current, active = useRef(roomId)
  active.current = roomId
  const [, render] = useState(0), [storageError, setStorageError] = useState('')
  const publish = useCallback(() => { if (api.isCurrent()) render(n => n + 1) }, [])
  const requests = useRef(new WeakMap<HistoryEntry, Promise<void>>())
  const [outbox, setOutbox] = useState<Outgoing[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`anyone.outbox.${user.id}`) || '[]')
      return Array.isArray(saved) ? saved.filter((x: Outgoing) => x.userId === user.id && typeof x.roomId === 'string' && typeof x.input?.text === 'string' && /^[0-9a-f-]{36}$/i.test(x.input?.clientMessageId)).map((x: Outgoing) => ({ ...x, state: 'failed', error: '发送未确认，请重试' })) : []
    } catch { return [] }
  })
  const merge = useCallback((id: string, incoming: Message[], entry: HistoryEntry | null = history.peek(id) ?? null) => {
    if (!api.isCurrent()) return
    // Unvisited rooms do not allocate history, initialized flags, or sync cursors.
    if (entry && history.current(entry)) { history.merge(entry, incoming); publish() }
    setOutbox(old => old.filter(o => !incoming.some(m => m.roomId === o.roomId && m.sender.id === o.userId && m.clientMessageId === o.input.clientMessageId)))
  }, [])
  useEffect(() => { try { localStorage.setItem(`anyone.outbox.${user.id}`, JSON.stringify(outbox.map(o => ({ ...o, state: 'failed', error: o.error || '发送未确认，请重试' })))) } catch { setStorageError('本地存储不可用，未发送消息无法跨刷新保留；请勿关闭页面') } }, [outbox, user.id])
  const inFlight = useRef(new Set<string>())
  const retry = useCallback(async (item: Outgoing) => {
    if (item.userId !== api.ownerId || inFlight.current.has(item.input.clientMessageId)) return
    // A delayed POST is not validation of a replacement entry or a cold baseline.
    const cached = history.peek(item.roomId)
    const entry = cached?.initialized ? cached : null
    const pageGeneration = entry?.pageGeneration
    inFlight.current.add(item.input.clientMessageId)
    setOutbox(old => old.map(o => o.input.clientMessageId === item.input.clientMessageId ? { ...o, state: 'sending', error: undefined } : o))
    try { const message = await api<Message>(`/rooms/${encodeURIComponent(item.roomId)}/messages`, 'POST', item.input); merge(item.roomId, [message], entry && entry.pageGeneration === pageGeneration && !entry.recovering ? entry : null) }
    catch(e) { setOutbox(old => old.map(o => o.input.clientMessageId === item.input.clientMessageId ? { ...o, state: 'failed', error: errorText(e) } : o)) }
    finally { inFlight.current.delete(item.input.clientMessageId) }
  }, [merge])
  const send = useCallback((text: string, attachment?: Attachment) => {
    const item: Outgoing = { roomId, userId: user.id, input: { clientMessageId: crypto.randomUUID(), text: text.trim(), ...(attachment ? { attachmentId: attachment.id } : {}) }, ...(attachment ? { attachment } : {}), state: 'sending' }
    setOutbox(old => [...old, item]); void retry(item)
  }, [roomId, user.id, retry])
  const loadInitial = useCallback(async (id: string, force = false) => {
    if (!id || !api.isCurrent() || id !== active.current) return
    if (force) history.drop(id)
    const entry = history.activate(id)
    if (entry.initialized) return
    if (requests.current.has(entry)) return requests.current.get(entry)
    entry.loading = true; entry.error = ''; publish()
    const promise = (async () => {
      try {
        const page = await api<MessagePage>(`/rooms/${encodeURIComponent(id)}/messages?limit=${DEFAULT_MESSAGE_PAGE_SIZE}`, 'GET', undefined, entry.controller.signal)
        if (api.isCurrent()) history.initialize(entry, page)
      } catch(e) { if (api.isCurrent() && history.current(entry)) entry.error = errorText(e) }
      finally { entry.loading = false; requests.current.delete(entry); publish() }
    })()
    requests.current.set(entry, promise)
    return promise
  }, [])
  useEffect(() => { if (roomId) void loadInitial(roomId) }, [roomId, loadInitial])
  const loadPage = useCallback(async (direction: 'older' | 'newer') => {
    const entry = history.peek(active.current)
    if (!entry?.initialized || entry.paging || entry.loading || entry.recovering) return
    const seq = direction === 'older' ? entry.messages[0]?.seq : entry.messages.at(-1)?.seq
    if (!seq) return
    const generation = entry.pageGeneration
    const current = () => api.isCurrent() && history.current(entry) && entry.pageGeneration === generation
    entry.paging = true; entry.error = ''; publish()
    try {
      const page = await api<MessagePage>(`/rooms/${encodeURIComponent(entry.roomId)}/messages?${direction === 'older' ? 'beforeSeq' : 'afterSeq'}=${seq}&limit=${DEFAULT_MESSAGE_PAGE_SIZE}`, 'GET', undefined, entry.controller.signal)
      if (current()) history.page(entry, page, direction)
    } catch(e) { if (current()) entry.error = errorText(e) }
    finally { if (current()) entry.paging = false; publish() }
  }, [])
  const tombstone = useCallback((messageId: string, id?: string) => {
    for (const entry of history.entries.values()) {
      if (id ? entry.roomId === id : entry.messages.some(m => m.id === messageId)) history.tombstone(entry, messageId)
    }
    publish()
    // Bounded tombstone overflow drops the entry, also invalidating every pending page.
    if (active.current && !history.peek(active.current)) void loadInitial(active.current)
  }, [loadInitial])
  const refreshCached = useCallback(async (id: string, expected = history.peek(id)) => {
    if (!expected || !history.current(expected)) return
    if (expected.recovering) throw new Error('历史恢复进行中，请重试同步')
    // Invalidate pages/POST payloads captured before this scan. New pages may only
    // start after it: their server snapshot is then covered by the final delta.
    expected.pageGeneration++; expected.recovering = true; expected.paging = false
    publish()
    try {
      const cached = [...expected.messages]
      const end = cached.at(-1)?.seq ?? 0
      let index = 0
      // Only restart/overflow/legacy fallback scans; skip gaps, and bound work by cached rows.
      while (index < cached.length && history.current(expected) && api.isCurrent()) {
        const cursor = cached[index].seq - 1
        const page = await api<MessagePage>(`/rooms/${encodeURIComponent(id)}/messages?afterSeq=${cursor}&limit=${DEFAULT_MESSAGE_PAGE_SIZE}`, 'GET', undefined, expected.controller.signal)
        if (!api.isCurrent() || !history.current(expected)) return
        history.merge(expected, page.messages.filter(m => m.seq <= end)); publish()
        const next = page.messages.at(-1)?.seq ?? cursor
        if (next <= cursor) throw new Error('历史分页未前进，请重试同步')
        while (index < cached.length && cached[index].seq <= next) index++
      }
    } finally { expected.recovering = false; publish() }
  }, [])
  const purge = useCallback((id: string) => { history.drop(id); publish() }, [])
  const suspendHistory = useCallback(() => { history.suspend(); render(n => n + 1) }, [])
  const allow = useCallback((_id: string) => {}, [])
  const latest = useCallback((id: string) => history.peek(id)?.messages.at(-1)?.seq || 0, [])
  const entry = history.peek(roomId)
  const deleted = new Set<string>()
  for (const item of history.entries.values()) for (const id of item.tombstones) deleted.add(id)
  return {
    messages: entry?.messages || [], loading: !!entry?.loading, error: entry?.error || storageError,
    outbox: outbox.filter(o => o.roomId === roomId), send, retry, merge,
    hasMore: !!entry?.hasOlder, hasNewer: !!entry?.hasNewer, olderLoading: !!entry?.paging,
    loadOlder: () => loadPage('older'), loadNewer: () => loadPage('newer'), loadLatest: () => loadInitial(roomId, true),
    loadInitial, refreshCached, deleted, tombstone, purge, allow, latest,
    history, cacheKey: entry, publish, suspendHistory,
    initialCursor: (id: string) => history.peek(id)?.contiguous || 0,
    setRoomError: (id: string, error: string) => { const entry = history.peek(id); if (api.isCurrent() && entry) { entry.error = error; publish() } }
  }
}
