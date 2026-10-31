import { useEffect, useState } from 'react'
import type { RoomSummary } from '@anyone-im/contracts'
import { LockKeyhole, Globe2, ArrowUpRight } from 'lucide-react'
import { errorText } from './api'
import { useApi } from './SessionContext'
import { Modal } from './Modal'
export function CreateRoom({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (r: RoomSummary) => void }) {
  const api = useApi()
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [visibility, setVisibility] = useState<'private' | 'public'>('private'), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { if (!open) setPassword('') }, [open])
  const validPassword = password.length >= 6 && password.length <= 128
  return <Modal open={open} onOpenChange={onOpenChange} title="新建房间" description="给共同的话题，一个专属的空间。"><form className="modal-body stack" onSubmit={async e => {
    e.preventDefault()
    if (busy || !name.trim() || (visibility === 'private' && !validPassword)) return
    setBusy(true); setError('')
    try {
      const room = await api<RoomSummary>('/rooms', 'POST', { name: name.trim(), description: description.trim(), visibility, ...(visibility === 'private' ? { password } : {}) })
      setPassword(''); onCreated(room); onOpenChange(false); setName(''); setDescription('')
    } catch(e) { setError(errorText(e)) } finally { setBusy(false) }
  }}><label>房间名称<input value={name} required maxLength={64} placeholder="例如：周末计划" onChange={e => setName(e.target.value)}/></label><label>房间介绍<textarea value={description} rows={3} maxLength={240} placeholder="这个房间用来聊什么？（选填）" onChange={e => setDescription(e.target.value)}/></label><fieldset className="visibility"><legend>谁可以加入</legend><label className={visibility === 'private' ? 'chosen' : ''}><input type="radio" name="visibility" value="private" checked={visibility === 'private'} onChange={() => setVisibility('private')}/><LockKeyhole size={19}/><span><strong>私密房间</strong><small>凭房间 ID 或链接和密码加入，邀请链接为可选方式</small></span></label><label className={visibility === 'public' ? 'chosen' : ''}><input type="radio" name="visibility" value="public" checked={visibility === 'public'} onChange={() => { setVisibility('public'); setPassword('') }}/><Globe2 size={19}/><span><strong>公开房间</strong><small>可以被发现，任何人都能申请加入</small></span></label></fieldset>{visibility === 'private' && <><label>房间密码<input type="password" autoComplete="new-password" value={password} required minLength={6} maxLength={128} aria-describedby="create-room-password-hint" onChange={e => setPassword(e.target.value)}/></label><p id="create-room-password-hint" className="form-note">6–128 个字符。请单独告知成员，密码不会包含在分享链接中。</p></>}{error && <p role="alert" className="error">{error}</p>}<button className="primary" disabled={busy || !name.trim() || (visibility === 'private' && !validPassword)}>{busy ? '正在创建…' : '创建房间'}<ArrowUpRight size={17}/></button></form></Modal>
}
