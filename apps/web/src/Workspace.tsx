import { useCallback, useEffect, useRef, useState } from 'react'
import type { User, RoomSummary } from '@anyone-im/contracts'
import { Hash, LockKeyhole, MessageSquare, Plus, Search, Settings2, Ellipsis, ArrowLeft, Compass } from 'lucide-react'
import { errorText } from './api'
import { useApi } from './SessionContext'
import { Brand } from './App'
import { useMessages } from './useMessages'
import { Chat } from './Chat'
import { Profile } from './Profile'
import { rememberFocus } from './Modal'
import { CreateRoom } from './CreateRoom'
import { RoomDetails } from './RoomDetails'
import { Discover, InviteJoin } from './JoinRooms'
import { useRealtime } from './useRealtime'
import { useMessageNotifications } from './useMessageNotifications'
import type { usePwaInstall } from './PwaSettings'
export function Workspace({ install, user, setUser }: { install: ReturnType<typeof usePwaInstall>; user: User; setUser: (u: User | null) => void }) {
  const api = useApi()
  const [rooms, setRooms] = useState<RoomSummary[]>([]), [active, setActive] = useState(''), [error, setError] = useState('')
  const [roomsLoading, setRoomsLoading] = useState(true)
  const [profileOpen, setProfileOpen] = useState(false), [createOpen, setCreateOpen] = useState(false), [detailsOpen, setDetailsOpen] = useState(false)
  const [discoverOpen, setDiscoverOpen] = useState(false), [search, setSearch] = useState('')
  const [inviteCode, setInviteCode] = useState(() => location.pathname.match(/^\/invite\/([^/]+)\/?$/)?.[1] || '')
  const removedIds = useRef(new Set<string>())
  const onJoined = (r: RoomSummary) => { removedIds.current.delete(r.id); state.allow(r.id); setRooms(old => [...old.filter(x => x.id !== r.id), r]); setActive(r.id) }
  const closeInvite = useCallback(() => { setInviteCode(''); history.replaceState(null, '', '/') }, [])
  const state = useMessages(user, active)
  const notifications = useMessageNotifications(rooms)
  const { baseline } = notifications
  const refresh = useCallback(async (historyBaseline = false, isCurrent: () => boolean = () => true) => { try { const r = await api<{rooms: RoomSummary[]}>('/rooms'); if (!isCurrent()) return false; const joined = r.rooms.filter(x => !removedIds.current.has(x.id)); if (historyBaseline) baseline(joined); setRooms(old => joined.map(x => { const cached = old.find(y => y.id === x.id); return cached ? { ...x, lastReadSeq: Math.max(cached.lastReadSeq, x.lastReadSeq), lastSeq: Math.max(cached.lastSeq, x.lastSeq), lastMessage: cached.lastSeq > x.lastSeq ? cached.lastMessage : x.lastMessage } : x })); setError(''); return true } catch(e) { if (isCurrent()) setError(errorText(e)); return false } }, [api, baseline])
  const realtime = useRealtime({ active, state, refresh,
    onMessage: m => { notifications.notify(m); setRooms(old => old.map(r => r.id === m.roomId && m.seq >= r.lastSeq ? { ...r, lastSeq: m.seq, lastMessage: m, updatedAt: m.createdAt } : r)) },
    onDeleted: e => setRooms(old => old.map(r => r.id === e.roomId && r.lastMessage?.id === e.messageId ? { ...r, lastMessage: null } : r)),
    onPresence: e => setRooms(old => old.map(r => r.id === e.roomId ? { ...r, onlineCount: e.count } : r)),
    onRemoved: e => { removedIds.current.add(e.roomId); setRooms(old => old.filter(r => r.id !== e.roomId)); setActive(id => id === e.roomId ? '' : id); setDetailsOpen(false); setError(e.reason === 'kicked' ? '你已被移出房间' : '你已离开房间') }
  })
  useEffect(() => { api<{ rooms: RoomSummary[] }>('/rooms').then(r => {
    setRooms(r.rooms)
    const requested = new URLSearchParams(location.search).get('room')
    setActive(r.rooms.some(room => room.id === requested) ? requested! : matchMedia('(max-width:700px)').matches ? '' : r.rooms[0]?.id ?? '')
    if (requested) history.replaceState(null, '', location.pathname)
  }).catch(e => setError(errorText(e))).finally(() => setRoomsLoading(false)) }, [user.id])
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const clicked = (event: MessageEvent) => {
      const data = event.data
      if (event.source !== navigator.serviceWorker.controller || event.origin !== location.origin || !api.isCurrent() || data?.type !== 'notification-room' || data.ownerId !== user.id || !rooms.some(room => room.id === data.roomId)) return
      setActive(data.roomId); setDetailsOpen(false); setProfileOpen(false); setCreateOpen(false); setDiscoverOpen(false)
      if (inviteCode) closeInvite()
    }
    navigator.serviceWorker.addEventListener('message', clicked)
    return () => navigator.serviceWorker.removeEventListener('message', clicked)
  }, [api, user.id, rooms, inviteCode, closeInvite])
  useEffect(() => {
    const resize = () => { document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height ?? innerHeight}px`); document.documentElement.style.setProperty('--viewport-top', `${window.visualViewport?.offsetTop ?? 0}px`) }
    resize(); window.visualViewport?.addEventListener('resize', resize); window.visualViewport?.addEventListener('scroll', resize); window.addEventListener('resize', resize)
    return () => { window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize); window.removeEventListener('resize', resize) }
  }, [])
  const room = rooms.find(r => r.id === active)
  return <main data-testid="app-shell" className={`workspace ${active ? 'chat-open' : ''}`}>
    <aside className="sidebar">
      <header className="sidebar-brand"><Brand/><button className="icon" aria-label="新建房间" onClick={e => { rememberFocus(e); setCreateOpen(true) }}><Plus size={21}/></button></header>
      <div className="sidebar-intro"><h1>会话</h1><span className="eyebrow">你的每一处连接</span></div>
      <div className="search"><Search size={17}/><input aria-label="搜索房间" placeholder="搜索房间" value={search} onChange={e => setSearch(e.target.value)}/></div>
      <button className="discover-button" onClick={e => { rememberFocus(e); setDiscoverOpen(true) }}><Compass size={17}/>发现公开房间<ArrowLeft className="discover-arrow" size={14}/></button>
      {error && <div role="alert" className="sidebar-error">{error}<button className="text-button" onClick={() => { setRoomsLoading(true); void refresh().finally(() => setRoomsLoading(false)) }}>重新加载房间</button></div>}
      {roomsLoading && !rooms.length && <p role="status" className="timeline-notice">正在读取房间…</p>}
      <nav data-testid="room-list" className="room-list" aria-label="房间列表">{rooms.filter(r => r.name.toLowerCase().includes(search.toLowerCase())).map(r => <button data-testid={`room-${r.id}`} key={r.id} className={`room-row ${r.id === active ? 'selected' : ''}`} onClick={() => { setActive(r.id); setDetailsOpen(false) }}>
        <span className="room-icon">{r.visibility === 'private' ? <LockKeyhole size={20}/> : <Hash size={22}/>}</span><span className="room-copy"><strong>{r.name}</strong><span>{r.lastMessage?.deletedAt ? '消息已删除' : r.lastMessage?.text ? `${r.lastMessage.sender.id === user.id ? '你' : r.lastMessage.sender.displayName}：${r.lastMessage.text}` : (r.lastMessage?.attachment ? '[图片]' : r.description || '还没有消息')}</span></span>{r.lastSeq > r.lastReadSeq && <span className="unread" aria-label={`${r.lastSeq - r.lastReadSeq} 条未读`}>{r.lastSeq - r.lastReadSeq > 99 ? '99+' : r.lastSeq - r.lastReadSeq}</span>}
      </button>)}{!roomsLoading && !error && !rooms.filter(r => r.name.toLowerCase().includes(search.toLowerCase())).length && <div className="compact-empty"><MessageSquare size={24}/><h3>{search ? '没有匹配的会话' : '还没有加入房间'}</h3><p>{search ? '试试其他关键词。' : '发现公开房间，或创建你的第一个空间。'}</p></div>}</nav>
      <div className={`connection ${realtime.connection}`} role="status"><i/>{realtime.connection === 'connected' ? '实时连接已建立' : realtime.connection === 'connecting' ? '正在连接…' : '连接中断 · 消息将保留'}{realtime.connection === 'offline' && <button onClick={realtime.reconnect}>重连</button>}</div>
      <div className="sidebar-footer"><span className="avatar">{user.displayName.slice(0,1)}</span><span><strong>{user.displayName}</strong><small>{user.isGuest ? '访客' : `@${user.username}`}</small></span><button className="icon" aria-label="个人设置" onClick={e => { rememberFocus(e); setProfileOpen(true) }}><Settings2 size={19}/></button></div>
    </aside>
    <section data-testid="chat-panel" className="conversation" aria-label="会话">{room ? <>
      <header className="chat-header"><button data-testid="mobile-back" className="icon mobile-back" aria-label="返回会话列表" onClick={() => { setActive(''); setDetailsOpen(false) }}><ArrowLeft size={21}/></button><span className="room-icon small">{room.visibility === 'private' ? <LockKeyhole size={19}/> : <Hash size={21}/>}</span><div className="chat-heading"><h2>{room.name}</h2><p>{room.memberCount} 位成员 · {room.visibility === 'private' ? '私密房间' : '公开房间'}</p></div><button data-testid="room-actions" className="icon" aria-label="房间详情" onClick={e => { rememberFocus(e); setDetailsOpen(true) }}><Ellipsis size={22}/></button></header>
      {realtime.connection !== 'connected' && <div className="offline-banner" role="status"><span>{realtime.connection === 'connecting' ? '正在建立实时连接…' : '连接中断，未发送消息会保留在本机'}</span><button onClick={realtime.reconnect}>重连</button></div>}
      <Chat key={room.id} user={user} room={room} state={state} visible={!profileOpen && !detailsOpen && !createOpen && !discoverOpen && !inviteCode} onRead={seq => setRooms(old => old.map(r => r.id === room.id ? { ...r, lastReadSeq: Math.max(r.lastReadSeq, seq) } : r))}/>
    </> : <div className="conversation-empty"><MessageSquare size={30}/><h2>选择一处，开始对话</h2><p>创建房间，或发现一个新的公开空间。</p></div>}</section>
    <Profile install={install} notifications={notifications} user={user} setUser={setUser} open={profileOpen} onOpenChange={setProfileOpen}/>
    <CreateRoom open={createOpen} onOpenChange={setCreateOpen} onCreated={onJoined}/>
    <Discover open={discoverOpen} onOpenChange={setDiscoverOpen} joinedIds={rooms.map(r => r.id)} onJoined={onJoined}/>
    {inviteCode && <InviteJoin code={inviteCode} onClose={closeInvite} onJoined={onJoined}/>}
    {room && <RoomDetails key={room.id} room={room} user={user} open={detailsOpen} onOpenChange={setDetailsOpen} onChanged={refresh} onLeft={() => { removedIds.current.add(room.id); state.purge(room.id); setRooms(old => old.filter(x => x.id !== room.id)); setActive('') }}/>}
  </main>
}
