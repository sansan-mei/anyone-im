import { useCallback, useEffect, useRef, useState } from 'react'
import type { Attachment, Message, MessagePage, SendMessageInput, User } from '@anyone-im/contracts'
import { DEFAULT_MESSAGE_PAGE_SIZE } from '@anyone-im/contracts'
import { errorText } from './api'
import { useApi } from './SessionContext'
export interface Outgoing { roomId: string; userId: string; input: SendMessageInput; attachment?: Attachment; state: 'sending' | 'failed'; error?: string }
export function useMessages(user: User, roomId: string) {
  const api = useApi()
  const messagesRef = useRef<Record<string, Message[]>>({})
  const initialCursors = useRef<Record<string, number>>({})
  const [messages, setMessages] = useState<Record<string, Message[]>>({})
  const [loadingIds, setLoadingIds] = useState<Record<string, boolean>>({}), [olderLoading, setOlderLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({}), [storageError, setStorageError] = useState('')
  const [hasOlder, setHasOlder] = useState<Record<string, boolean>>({})
  const [deleted, setDeleted] = useState<Set<string>>(new Set())
  const removed = useRef(new Set<string>()), initialized = useRef(new Set<string>()), requests = useRef(new Map<string, Promise<void>>())
  const [outbox, setOutbox] = useState<Outgoing[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`anyone.outbox.${user.id}`) || '[]')
      return Array.isArray(saved) ? saved.filter((x: Outgoing) => x.userId === user.id && typeof x.roomId === 'string' && typeof x.input?.text === 'string' && /^[0-9a-f-]{36}$/i.test(x.input?.clientMessageId)).map((x: Outgoing) => ({ ...x, state: 'failed', error: '发送未确认，请重试' })) : []
    } catch { return [] }
  })
  const merge = useCallback((id: string, incoming: Message[]) => {
    if (!api.isCurrent() || removed.current.has(id)) return
    const bySeq = new Map((messagesRef.current[id] || []).map(m => [m.seq, m]))
    incoming.filter(m => m.roomId === id).forEach(m => { const old = bySeq.get(m.seq); bySeq.set(m.seq, old?.deletedAt && !m.deletedAt ? old : m) })
    messagesRef.current = { ...messagesRef.current, [id]: [...bySeq.values()].sort((a,b) => a.seq - b.seq) }
    setMessages(messagesRef.current)
    setOutbox(old => old.filter(o => !incoming.some(m => m.roomId === o.roomId && m.sender.id === o.userId && m.clientMessageId === o.input.clientMessageId)))
  }, [])
  useEffect(() => { try { localStorage.setItem(`anyone.outbox.${user.id}`, JSON.stringify(outbox.map(o => ({ ...o, state: 'failed', error: o.error || '发送未确认，请重试' })))) } catch { setStorageError('本地存储不可用，未发送消息无法跨刷新保留；请勿关闭页面') } }, [outbox, user.id])
  const inFlight = useRef(new Set<string>())
  const retry = useCallback(async (item: Outgoing) => {
    if (item.userId !== api.ownerId || inFlight.current.has(item.input.clientMessageId)) return
    inFlight.current.add(item.input.clientMessageId)
    setOutbox(old => old.map(o => o.input.clientMessageId === item.input.clientMessageId ? { ...o, state: 'sending', error: undefined } : o))
    try { const message = await api<Message>(`/rooms/${encodeURIComponent(item.roomId)}/messages`, 'POST', item.input); merge(item.roomId, [message]) }
    catch(e) { setOutbox(old => old.map(o => o.input.clientMessageId === item.input.clientMessageId ? { ...o, state: 'failed', error: errorText(e) } : o)) }
    finally { inFlight.current.delete(item.input.clientMessageId) }
  }, [merge])
  const send = useCallback((text: string, attachment?: Attachment) => {
    const item: Outgoing = { roomId, userId: user.id, input: { clientMessageId: crypto.randomUUID(), text: text.trim(), ...(attachment ? { attachmentId: attachment.id } : {}) }, ...(attachment ? { attachment } : {}), state: 'sending' }
    setOutbox(old => [...old, item]); void retry(item)
  }, [roomId, user.id, retry])
  const loadInitial = useCallback(async (id: string, force = false) => {
    if (!id || (initialized.current.has(id) && !force)) return
    if (requests.current.has(id)) return requests.current.get(id)
    setLoadingIds(old => ({ ...old, [id]: true })); setErrors(old => ({...old, [id]: ''}))
    const promise = (async () => {
      try { const page = await api<MessagePage>(`/rooms/${encodeURIComponent(id)}/messages?limit=${DEFAULT_MESSAGE_PAGE_SIZE}`); initialCursors.current[id] = page.messages.at(-1)?.seq || 0; merge(id, page.messages); setHasOlder(old => ({ ...old, [id]: page.hasMore })); initialized.current.add(id) }
      catch(e) { setErrors(old => ({ ...old, [id]: errorText(e) })) }
      finally { setLoadingIds(old => ({...old, [id]: false})); requests.current.delete(id) }
    })()
    requests.current.set(id, promise); return promise
  }, [merge])
  useEffect(() => { if (roomId) void loadInitial(roomId) }, [roomId, loadInitial])
  const loadOlder = useCallback(async () => {
    if (olderLoading || !roomId) return
    const before = messagesRef.current[roomId]?.[0]?.seq
    if (!before) return
    setOlderLoading(true); setErrors(old => ({...old, [roomId]: ''}))
    try { const page = await api<MessagePage>(`/rooms/${encodeURIComponent(roomId)}/messages?beforeSeq=${before}&limit=${DEFAULT_MESSAGE_PAGE_SIZE}`); merge(roomId, page.messages); setHasOlder(old => ({...old, [roomId]: page.hasMore})) }
    catch(e) { setErrors(old => ({...old, [roomId]: errorText(e)})) }
    finally { setOlderLoading(false) }
  }, [roomId, olderLoading, merge])
  const tombstone = useCallback((id: string) => setDeleted(old => new Set([...old, id])), [])
  const refreshCached = useCallback(async (id: string) => {
    const cached = messagesRef.current[id]
    if (!cached?.length) return
    const end = cached.at(-1)!.seq
    let cursor = cached[0].seq - 1
    // Deletions retain old sequence numbers, so afterSeq backfill alone cannot discover missed tombstones.
    while (cursor < end && !removed.current.has(id)) {
      const page = await api<MessagePage>(`/rooms/${encodeURIComponent(id)}/messages?afterSeq=${cursor}&limit=${DEFAULT_MESSAGE_PAGE_SIZE}`)
      merge(id, page.messages)
      const next = page.messages.at(-1)?.seq || cursor
      if (!page.hasMore || next <= cursor) break
      cursor = next
    }
  }, [merge])
  const purge = useCallback((id: string) => { removed.current.add(id); const next = { ...messagesRef.current }; delete next[id]; messagesRef.current = next; setMessages(next); initialized.current.delete(id) }, [])
  const allow = useCallback((id: string) => { removed.current.delete(id) }, [])
  const latest = useCallback((id: string) => messagesRef.current[id]?.at(-1)?.seq || 0, [])
  return { messages: messages[roomId] || [], loading: !!loadingIds[roomId], error: errors[roomId] || storageError, outbox: outbox.filter(o => o.roomId === roomId), send, retry, merge, hasMore: !!hasOlder[roomId], olderLoading, loadOlder, loadInitial, refreshCached, deleted, tombstone, purge, allow, latest, initialCursor: (id: string) => initialCursors.current[id] || 0, setRoomError: (id: string, error: string) => setErrors(old => ({ ...old, [id]: error })) }
}
