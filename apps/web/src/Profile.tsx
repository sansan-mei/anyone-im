import { useState } from 'react'
import type { User } from '@anyone-im/contracts'
import { LogOut } from 'lucide-react'
import { errorText } from './api'
import { useApi } from './SessionContext'
import { Modal } from './Modal'
import { PwaSettings, type usePwaInstall } from './PwaSettings'
import type { MessageNotifications } from './useMessageNotifications'
export function Profile({ install, notifications, user, setUser, open, onOpenChange }: { install: ReturnType<typeof usePwaInstall>; notifications: MessageNotifications; user: User; setUser: (u: User | null) => void; open: boolean; onOpenChange: (v: boolean) => void }) {
  const api = useApi()
  const [name, setName] = useState(user.displayName), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false)
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('anyone.theme') || 'system' } catch { return 'system' } })
  return <Modal open={open} onOpenChange={onOpenChange} title="个人设置" description="以你喜欢的样子，参与每一次对话。"><div className="modal-body"><div className="profile-summary"><span className="avatar large">{user.displayName.slice(0,1)}</span><div><strong>{user.displayName}</strong><p>{user.isGuest ? '访客身份 · 此浏览器会话' : `@${user.username}`}</p></div></div><form className="stack" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { setUser(await api<User>('/me', 'PATCH', { displayName: name.trim() })); setSaved(true) } catch(e) { setError(errorText(e)) } finally { setBusy(false) } }}><label>显示名称<input value={name} maxLength={32} required onChange={e => { setName(e.target.value); setSaved(false) }}/></label><button className="secondary" disabled={busy || !name.trim()}>保存名称</button>{saved && <p role="status" className="success">名称已保存</p>}</form><div className="setting-section"><label>外观<select value={theme} onChange={e => { const value = e.target.value; setTheme(value); document.documentElement.dataset.theme = value; try { localStorage.setItem('anyone.theme', value) } catch { setError('无法保存外观偏好') } }}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><p className="form-note">只在本地保存外观偏好。登录凭据始终由安全 Cookie 管理。</p></div><PwaSettings install={install} notifications={notifications}/>{error && <p role="alert" className="error">{error}</p>}<button className="danger full" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await api('/auth/logout', 'POST', {}); setUser(null) } catch(e) { setError(errorText(e)) } finally { setBusy(false) } }}><LogOut size={16}/>退出登录</button><p className="form-note">退出不会删除已发送的消息。未确认的发件箱仅保存在本机，重新登录同一身份后可重试。访客退出后可能无法找回原身份。</p></div></Modal>
}
