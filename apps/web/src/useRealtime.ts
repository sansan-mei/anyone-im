import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, MessagePage, Result, ServerToClientEvents } from '@anyone-im/contracts'
import type { MessageState } from './Chat'
import { DEFAULT_MESSAGE_PAGE_SIZE } from '@anyone-im/contracts'
import { errorText } from './api'
import { useApi } from './SessionContext'
export function useRealtime({ active, state, refresh, onMessage, onDeleted, onPresence, onRemoved }: {
  active: string; state: MessageState; refresh: (historyBaseline?: boolean, isCurrent?: () => boolean) => Promise<boolean>;
  onMessage: ServerToClientEvents['message:new']; onDeleted: ServerToClientEvents['message:deleted']; onPresence: ServerToClientEvents['presence:update']; onRemoved: ServerToClientEvents['room:removed']
}) {
  const api = useApi()
  const latest = useRef({ active, state, refresh, onMessage, onDeleted, onPresence, onRemoved })
  latest.current = { active, state, refresh, onMessage, onDeleted, onPresence, onRemoved }
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null)
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>('connecting'), [epoch, setEpoch] = useState(0)
  // Only confirmed contiguous positions are used for reconnect, never the highest racing live event.
  const cursors = useRef<Record<string, number>>({})
  useEffect(() => {
    let ready = false, generation = 0
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ query: { expectedUserId: api.ownerId }, transports: ['websocket', 'polling'], withCredentials: true, tryAllTransports: true, reconnectionDelay: 800, reconnectionDelayMax: 8000 })
    socketRef.current = socket
    socket.on('connect', () => {
      ready = false; const attempt = ++generation
      const isCurrent = () => attempt === generation && socket.connected && api.isCurrent()
      void latest.current.refresh(true, isCurrent).then(ok => {
        if (!isCurrent()) return
        if (!ok) { socket.disconnect(); setConnection('offline'); return }
        ready = true; setConnection('connected'); setEpoch(e => e + 1)
      })
    })
    socket.on('disconnect', () => { ready = false; generation++; setConnection('offline') })
    socket.on('connect_error', error => { setConnection('offline'); if (error.message === 'SESSION_CHANGED') api.invalidate() })
    socket.on('message:new', message => {
      if (!ready || !api.isCurrent()) return
      latest.current.state.merge(message.roomId, [message])
      const cursor = cursors.current[message.roomId]
      if (cursor !== undefined && message.seq === cursor + 1) cursors.current[message.roomId] = message.seq
      latest.current.onMessage(message)
    })
    socket.on('message:deleted', event => { if (!ready || !api.isCurrent()) return; latest.current.state.tombstone(event.messageId); latest.current.onDeleted(event) })
    socket.on('presence:update', event => { if (ready && api.isCurrent()) latest.current.onPresence(event) })
    socket.on('room:updated', () => { if (!ready || !api.isCurrent()) return; void latest.current.refresh() })
    socket.on('room:removed', event => { if (!ready || !api.isCurrent()) return; latest.current.state.purge(event.roomId); delete cursors.current[event.roomId]; latest.current.onRemoved(event) })
    const online = () => { setConnection('connecting'); socket.connect() }
    const offline = () => { setConnection('offline'); socket.disconnect() }
    window.addEventListener('online', online); window.addEventListener('offline', offline)
    return () => { ready = false; generation++; window.removeEventListener('online', online); window.removeEventListener('offline', offline); socket.disconnect(); socketRef.current = null }
  }, [])
  useEffect(() => {
    if (!active || connection !== 'connected') return
    let cancelled = false
    const socket = socketRef.current
    void (async () => {
      await latest.current.state.loadInitial(active)
      if (cursors.current[active] !== undefined) await latest.current.state.refreshCached(active)
      if (cancelled || !socket?.connected) return
      let cursor = cursors.current[active] ?? latest.current.state.initialCursor(active)
      const result = await new Promise<Result<MessagePage>>((resolve, reject) => {
        socket.timeout(10000).emit('room:subscribe', { roomId: active, afterSeq: cursor }, (error: Error | null, data: Result<MessagePage>) => error ? reject(error) : resolve(data))
      })
      if ('error' in result) throw new Error(result.error.message)
      let page = result.data
      while (!cancelled && api.isCurrent()) {
        latest.current.state.merge(active, page.messages)
        const next = page.messages.at(-1)?.seq ?? cursor
        if (!page.hasMore || next <= cursor) { cursors.current[active] = Math.max(cursors.current[active] ?? 0, next); break }
        cursor = next
        page = await api<MessagePage>(`/rooms/${encodeURIComponent(active)}/messages?afterSeq=${cursor}&limit=${DEFAULT_MESSAGE_PAGE_SIZE}`)
      }
    })().catch(e => { if (!cancelled) latest.current.state.setRoomError(active, `同步未完成：${errorText(e)}`) })
    return () => { cancelled = true }
  }, [active, connection, epoch])
  return { connection, reconnect: () => { setConnection('connecting'); socketRef.current?.connect() } }
}
