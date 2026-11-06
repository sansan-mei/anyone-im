import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, MessagePage, Result, ServerToClientEvents } from '@anyone-im/contracts'
import type { MessageState } from './Chat'
import { DEFAULT_MESSAGE_PAGE_SIZE } from '@anyone-im/contracts'
import { errorText } from './api'
import { useApi } from './SessionContext'
import { synchronizeHistory } from './history-cache'
export function useRealtime({ active, state, refresh, onMessage, onDeleted, onPresence, onRemoved, paused = false }: {
  active: string; state: MessageState; refresh: (historyBaseline?: boolean, isCurrent?: () => boolean) => Promise<boolean>;
  onMessage: ServerToClientEvents['message:new']; onDeleted: ServerToClientEvents['message:deleted']; onPresence: ServerToClientEvents['presence:update']; onRemoved: ServerToClientEvents['room:removed']
  paused?: boolean
}) {
  const api = useApi()
  const latest = useRef({ active, state, refresh, onMessage, onDeleted, onPresence, onRemoved, paused })
  latest.current = { active, state, refresh, onMessage, onDeleted, onPresence, onRemoved, paused }
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null)
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>('connecting'), [epoch, setEpoch] = useState(0)

  useEffect(() => {
    if (paused) { latest.current.state.suspendHistory(); setConnection('offline'); return }
    setConnection('connecting')
    let ready = false, generation = 0
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ query: { expectedUserId: api.ownerId }, transports: ['websocket', 'polling'], withCredentials: true, tryAllTransports: true, reconnectionDelay: 800, reconnectionDelayMax: 8000 })
    socketRef.current = socket
    socket.on('connect', () => {
      if (socketRef.current !== socket || latest.current.paused) return
      ready = false; const attempt = ++generation
      const isCurrent = () => socketRef.current === socket && attempt === generation && socket.connected && !latest.current.paused && api.isCurrent()
      void latest.current.refresh(true, isCurrent).then(ok => {
        if (!isCurrent()) return
        if (!ok) { socket.disconnect(); setConnection('offline'); return }
        ready = true; setConnection('connected'); setEpoch(e => e + 1)
      })
    })
    socket.on('disconnect', () => { ready = false; generation++; if (socketRef.current === socket) setConnection('offline') })
    socket.on('connect_error', error => { if (socketRef.current !== socket || latest.current.paused) return; setConnection('offline'); if (error.message === 'SESSION_CHANGED') api.invalidate() })
    socket.on('message:new', message => {
      if (!ready || latest.current.paused || !api.isCurrent()) return
      latest.current.state.merge(message.roomId, [message])

      latest.current.onMessage(message)
    })
    socket.on('message:deleted', event => { if (!ready || latest.current.paused || !api.isCurrent()) return; latest.current.state.tombstone(event.messageId, event.roomId); latest.current.onDeleted(event) })
    socket.on('presence:update', event => { if (ready && !latest.current.paused && api.isCurrent()) latest.current.onPresence(event) })
    socket.on('room:updated', () => { if (!ready || latest.current.paused || !api.isCurrent()) return; void latest.current.refresh() })
    socket.on('room:removed', event => { if (!ready || latest.current.paused || !api.isCurrent()) return; latest.current.state.purge(event.roomId); latest.current.onRemoved(event) })
    const online = () => { setConnection('connecting'); socket.connect() }
    const offline = () => { setConnection('offline'); socket.disconnect() }
    window.addEventListener('online', online); window.addEventListener('offline', offline)
    return () => { ready = false; generation++; window.removeEventListener('online', online); window.removeEventListener('offline', offline); socketRef.current = null; socket.disconnect() }
  }, [paused])
  useEffect(() => {
    if (paused || !active || connection !== 'connected') return
    let cancelled = false
    const socket = socketRef.current
    void (async () => {
      await latest.current.state.loadInitial(active)
      if (cancelled || !socket?.connected) return
      const state = latest.current.state, entry = state.history.peek(active)
      if (!entry) return
      await synchronizeHistory(state.history, entry, {
        current: () => !cancelled && !latest.current.paused && socket.connected && api.isCurrent(),
        changed: state.publish,
        refresh: () => state.refreshCached(active, entry),
        forward: cursor => api<MessagePage>(`/rooms/${encodeURIComponent(active)}/messages?afterSeq=${cursor}&limit=${DEFAULT_MESSAGE_PAGE_SIZE}`, 'GET', undefined, entry.controller.signal),
        subscribe: (changeCursor, afterSeq) => new Promise<MessagePage>((resolve, reject) => {
          socket.timeout(10000).emit('room:subscribe', { roomId: active, afterSeq, ...(changeCursor ? { changeCursor } : {}) }, (error: Error | null, result: Result<MessagePage>) => {
            if (error) reject(error)
            else if ('error' in result) reject(new Error(result.error.message))
            else resolve(result.data)
          })
        })
      })
    })().catch(e => { if (!cancelled) latest.current.state.setRoomError(active, `同步未完成：${errorText(e)}`) })
    return () => { cancelled = true }
  }, [active, connection, epoch, state.cacheKey, paused])
  return { connection, reconnect: () => { if (!paused) { setConnection('connecting'); socketRef.current?.connect() } } }
}
