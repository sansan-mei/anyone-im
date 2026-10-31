import { useEffect, useState } from 'react'
import type { InvitePreview, RoomSummary } from '@anyone-im/contracts'
import { Globe2, Hash, ArrowUpRight, Link } from 'lucide-react'
import { errorText } from './api'
import { useApi } from './SessionContext'
import { Modal } from './Modal'
export function Discover({ open, onOpenChange, joinedIds, onJoined, initialRoomId = '' }: { open: boolean; onOpenChange: (v: boolean) => void; joinedIds: string[]; onJoined: (r: RoomSummary) => void; initialRoomId?: string }) {
  const api = useApi()
  const [rooms, setRooms] = useState<RoomSummary[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState('')
  const [roomId, setRoomId] = useState(initialRoomId), [password, setPassword] = useState('')
  const load = async () => { setLoading(true); setError(''); try { setRooms((await api<{rooms: RoomSummary[]}>('/rooms/public')).rooms) } catch(e) { setError(errorText(e)) } finally { setLoading(false) } }
  useEffect(() => { if (open) void load(); else setPassword('') }, [open])
  useEffect(() => { if (open) setRoomId(initialRoomId) }, [open, initialRoomId])
  const join = async (id: string, secret?: string) => {
    if (busy) return
    setBusy(id); setError('')
    try {
      const room = await api<RoomSummary>(`/rooms/${encodeURIComponent(id)}/join`, 'POST', secret === undefined ? {} : { password: secret })
      setPassword(''); onJoined(room); onOpenChange(false)
    } catch(e) { setError(errorText(e)) } finally { setBusy('') }
  }
  const available = rooms.filter(r => !joinedIds.includes(r.id))
  return <Modal open={open} onOpenChange={onOpenChange} title="发现公开房间" description="发现公开话题，或用房间 ID 和密码加入私密房间。"><div className="modal-body stack"><form className="stack" onSubmit={e => { e.preventDefault(); if (roomId.trim() && password.length >= 6 && password.length <= 128) void join(roomId.trim(), password) }}><h3>密码加入私密房间</h3><label>私密房间 ID<input value={roomId} required maxLength={128} autoComplete="off" onChange={e => setRoomId(e.target.value)}/></label><label>房间密码<input type="password" value={password} required minLength={6} maxLength={128} autoComplete="off" onChange={e => setPassword(e.target.value)}/></label><button className="primary" disabled={!!busy || !roomId.trim() || password.length < 6 || password.length > 128}>密码加入私密房间<ArrowUpRight size={14}/></button></form><section aria-label="公开房间">{loading ? <p className="timeline-notice" role="status">正在寻找公开房间…</p> : available.length ? available.map(r => <article className="discovery-row" key={r.id}><span className="room-icon"><Hash size={21}/></span><div><h3>{r.name}</h3>{r.description && <p>{r.description}</p>}<small>{r.memberCount} 位成员</small></div><button className="secondary" disabled={!!busy} aria-label={`加入 ${r.name}`} onClick={() => void join(r.id)}>{busy === r.id ? '加入中' : '加入'}<ArrowUpRight size={14}/></button></article>) : <div className="compact-empty"><Globe2 size={28}/><h3>暂时没有新的公开房间</h3><p>你也可以创建一个，邀请大家一起聊。</p></div>}</section>{error && <p className="error" role="alert">{error}<button className="text-button" onClick={load}>重试</button></p>}</div></Modal>
}
export function InviteJoin({ code, onClose, onJoined }: { code: string; onClose: () => void; onJoined: (r: RoomSummary) => void }) {
  const api = useApi()
  const [preview, setPreview] = useState<InvitePreview | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const load = async () => { setLoading(true); setError(''); try { setPreview(await api<InvitePreview>(`/invites/${encodeURIComponent(code)}`)) } catch(e) { setError(errorText(e)) } finally { setLoading(false) } }
  useEffect(() => { void load() }, [code])
  return <Modal open onOpenChange={v => { if (!v) onClose() }} title="你收到了一份邀请" description="确认房间信息后，加入这场对话。"><div className="modal-body stack">{loading ? <p role="status">正在验证邀请…</p> : preview && <><div className="compact-empty"><Link size={30}/><h3>{preview.roomName}</h3><p>有效至 {new Date(preview.expiresAt).toLocaleString('zh-CN')}</p></div><button className="primary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { onJoined(await api<RoomSummary>(`/invites/${encodeURIComponent(code)}`, 'POST', {})); onClose() } catch(e) { setError(errorText(e)) } finally { setBusy(false) } }}>{busy ? '正在加入…' : '加入受邀房间'}<ArrowUpRight size={18}/></button></>}{error && <p className="error" role="alert">{error}<button className="text-button" onClick={load}>重新验证</button></p>}<button className="secondary" onClick={onClose}>暂不加入</button></div></Modal>
}
