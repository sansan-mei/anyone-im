import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message, RoomSummary, SessionData } from '@anyone-im/contracts'
import { useApi } from './SessionContext'

// Generic lock-screen text deliberately excludes room names, senders, attachments and message text.
export function useMessageNotifications(rooms: RoomSummary[]) {
  const api = useApi()
  const supported = typeof Notification !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext
  const [enabled, setEnabled] = useState(false), [status, setStatus] = useState('')
  const live = useRef(false), epoch = useRef(0)
  const history = useRef(new Map<string, number>()), processed = useRef(new Map<string, number>())
  const known = new Set(rooms.map(r => r.id))
  for (const key of history.current.keys()) if (!known.has(key)) { history.current.delete(key); processed.current.delete(key) }
  // Summary refreshes can overtake live frames. Only a newly discovered room is history here.
  for (const room of rooms) if (!history.current.has(room.id)) history.current.set(room.id, room.lastSeq)
  const baseline = useCallback((snapshot: RoomSummary[]) => {
    // Called by the connection handshake before realtime delivery is enabled, not room:updated.
    for (const room of snapshot) history.current.set(room.id, Math.max(history.current.get(room.id) ?? 0, room.lastSeq))
  }, [])
  const close = async () => {
    const registration = await navigator.serviceWorker.getRegistration('/')
    for (const notification of await registration?.getNotifications() ?? []) if (notification.data?.ownerId === api.ownerId) notification.close()
  }
  useEffect(() => () => {
    live.current = false; epoch.current++
    if (supported) void close().catch(() => {})
  }, [api])
  const toggle = async () => {
    if (live.current) { live.current = false; epoch.current++; setEnabled(false); setStatus('消息通知已关闭。'); await close().catch(() => {}); return }
    if (!supported) { setStatus('此浏览器暂不支持系统通知。iOS 需要先添加到主屏幕，再从桌面打开。'); return }
    const attempt = ++epoch.current
    try {
      // The only permission request in the application: directly inside an explicit button action.
      const permission = await Notification.requestPermission()
      if (!api.isCurrent() || attempt !== epoch.current) return
      if (permission !== 'granted') { setStatus(permission === 'denied' ? '通知被浏览器阻止，请在网站设置中允许后重试。' : '未开启通知，你可以稍后重试。'); return }
      const registration = await navigator.serviceWorker.getRegistration('/')
      if (!registration?.active) { setStatus('通知服务尚未就绪，请稍后重试。'); return }
      if (!api.isCurrent() || attempt !== epoch.current) return
      live.current = true; setEnabled(true); setStatus('消息通知已开启；仅当前页面和当前账户有效。')
    } catch { setStatus('无法开启系统通知，请检查浏览器和系统通知设置。') }
  }
  const notify = (message: Message) => {
    const previous = history.current.get(message.roomId)
    if (previous === undefined || message.seq <= Math.max(previous, processed.current.get(message.roomId) ?? 0)) return
    processed.current.set(message.roomId, message.seq)
    if (!live.current || !api.isCurrent() || !supported || Notification.permission !== 'granted' || message.sender.id === api.ownerId || message.deletedAt || (document.visibilityState === 'visible' && document.hasFocus())) return
    const attempt = epoch.current
    const current = () => live.current && api.isCurrent() && attempt === epoch.current && history.current.has(message.roomId) && Notification.permission === 'granted' && (document.visibilityState !== 'visible' || !document.hasFocus())
    void (async () => {
      // Recheck the cookie-authoritative identity even in a sleeping/stale tab.
      const session = await api<SessionData>('/session')
      if (session.user?.id !== api.ownerId) { api.invalidate(); return }
      const registration = await navigator.serviceWorker.getRegistration('/')
      if (!registration?.active || !current()) return
      const tag = `anyone:${api.ownerId}:${message.id}`
      const show = async () => {
        if ((await registration.getNotifications({ tag })).length || !current()) return
        await registration.showNotification('Anyone IM', { body: '收到一条新消息，打开应用查看。', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag, data: { roomId: message.roomId, ownerId: api.ownerId } })
        // Logout/disable while the browser was displaying the notification must also clean it up.
        if (!current()) for (const n of await registration.getNotifications({ tag })) n.close()
      }
      if (navigator.locks) await navigator.locks.request(`anyone-notifications:${api.ownerId}`, show)
      else await show()
    })().catch(() => { /* Offline/session failure is fail-closed; never request permission automatically. */ })
  }
  return { supported, enabled, status, toggle, notify, baseline }
}
export type MessageNotifications = ReturnType<typeof useMessageNotifications>
