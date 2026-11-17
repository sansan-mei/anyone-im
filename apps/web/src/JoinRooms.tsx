import { useEffect, useState } from 'react'
import type { InvitePreview, RoomSummary } from '@anyone-im/contracts'
import { Globe2, Hash, ArrowUpRight, Link } from 'lucide-react'
import { errorText } from './api'
import { useApi } from './SessionContext'
import { Modal } from './Modal'
export function Discover({ open, onOpenChange, joinedIds, onJoined, initialRoomId = '' }: { open: boolean; onOpenChange: (v: boolean) => void; joinedIds: string[]; onJoined: (r: RoomSummary) => void; initialRoomId?: string }) {
  const api = useApi()
  const [rooms, setRooms] = useState<RoomSummary[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState('')
  const [code, setCode] = useState(''), [password, setPassword] = useState('')
  const load = async () => { setLoading(true); setError(''); try { setRooms((await api<{rooms: RoomSummary[]}>('/rooms/public')).rooms) } catch(e) { setError(errorText(e)) } finally { setLoading(false) } }
  useEffect(() => { if (open) void load(); else setPassword('') }, [open])
  const submit = async (key: string, path: string, body: Record<string, string>) => {
    if (busy) return
    setBusy(key); setError('')
    try {
      const room = await api<RoomSummary>(path, 'POST', body)
      setPassword(''); setCode(''); onJoined(room); onOpenChange(false)
    } catch(e) { setError(errorText(e)) } finally { setBusy('') }
  }
  const join = (id: string, secret?: string) => submit(id, `/rooms/${encodeURIComponent(id)}/join`, secret === undefined ? {} : { password: secret })
  // Strangers type the code by hand: accept spaces/dashes, keep digits only.
  const joinByCode = () => submit('code', '/rooms/join-by-code', { code, ...(password ? { password } : {}) })
  const legacy = !!initialRoomId
  const passwordValid = legacy ? password.length >= 6 && password.length <= 128 : password.length === 0 || (password.length >= 6 && password.length <= 128)
  const ready = (legacy || /^\d{6}$/.test(code)) && passwordValid
  const available = rooms.filter(r => !joinedIds.includes(r.id))
  return <Modal open={open} onOpenChange={onOpenChange} title="加入房间" description="输入 6 位房间码和密码进入；公开房间也可以直接在下方加入。"><div className="modal-body stack"><form className="stack" onSubmit={e => { e.preventDefault(); if (!ready) return; if (legacy) void join(initialRoomId, password); else void joinByCode() }}><h3>{legacy ? '用链接进入私密房间' : '用房间码进入'}</h3>{legacy ? <label>入房链接 ID<input value={initialRoomId} readOnly autoComplete="off"/></label> : <label>房间码<input className="room-code-input" value={code} required inputMode="numeric" autoComplete="off" placeholder="6 位数字" onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}/></label>}<label>房间密码<input type="password" value={password} required={legacy} minLength={6} maxLength={128} autoComplete="off" placeholder={legacy ? undefined : '公开房间可不填'} onChange={e => setPassword(e.target.value)}/></label><button className="primary" disabled={!!busy || !ready}>{busy === 'code' ? '正在进入…' : '进入房间'}<ArrowUpRight size={14}/></button></form><section aria-label="公开房间"><h3>发现公开房间</h3>{loading ? <p className="timeline-notice" role="status">正在寻找公开房间…</p> : available.length ? available.map(r => <article className="discovery-row" key={r.id}><span className="room-icon"><Hash size={21}/></span><div><h3>{r.name}</h3>{r.description && <p>{r.description}</p>}<small>{r.memberCount} 位成员</small></div><button className="secondary" disabled={!!busy} aria-label={`加入 ${r.name}`} onClick={() => void join(r.id)}>{busy === r.id ? '加入中' : '加入'}<ArrowUpRight size={14}/></button></article>) : <div className="compact-empty"><Globe2 size={28}/><h3>暂时没有新的公开房间</h3><p>你也可以创建一个，邀请大家一起聊。</p></div>}</section>{error && <p className="error" role="alert">{error}<button className="text-button" onClick={load}>重试</button></p>}</div></Modal>
}
export function InviteJoin({ code, onClose, onJoined }: { code: string; onClose: () => void; onJoined: (r: RoomSummary) => void }) {
  const api = useApi()
  const [preview, setPreview] = useState<InvitePreview | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const load = async () => { setLoading(true); setError(''); try { setPreview(await api<InvitePreview>(`/invites/${encodeURIComponent(code)}`)) } catch(e) { setError(errorText(e)) } finally { setLoading(false) } }
  useEffect(() => { void load() }, [code])
  return <Modal open onOpenChange={v => { if (!v) onClose() }} title="你收到了一份邀请" description="确认房间信息后，加入这场对话。"><div className="modal-body stack">{loading ? <p role="status">正在验证邀请…</p> : preview && <><div className="compact-empty"><Link size={30}/><h3>{preview.roomName}</h3><p>有效至 {new Date(preview.expiresAt).toLocaleString('zh-CN')}</p></div><button className="primary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { onJoined(await api<RoomSummary>(`/invites/${encodeURIComponent(code)}`, 'POST', {})); onClose() } catch(e) { setError(errorText(e)) } finally { setBusy(false) } }}>{busy ? '正在加入…' : '加入受邀房间'}<ArrowUpRight size={18}/></button></>}{error && <p className="error" role="alert">{error}<button className="text-button" onClick={load}>重新验证</button></p>}<button className="secondary" onClick={onClose}>暂不加入</button></div></Modal>
}
