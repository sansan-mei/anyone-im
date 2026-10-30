import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionData, User } from '@anyone-im/contracts'
import { ArrowUpRight } from 'lucide-react'
import { publicApi as api, createSessionApi, errorText, SESSION_CHANGED_TEXT, type SessionApi } from './api'
import { SessionContext } from './SessionContext'
import { Workspace } from './Workspace'
export function Brand() { return <span className="brand"><span className="brand-mark" aria-hidden="true"><i/><i/></span>Anyone<span className="brand-dot">/</span></span> }
export default function App() {
  const [user, setUser] = useState<User | null>(null), [booting, setBooting] = useState(true), [error, setError] = useState('')
  const [name, setName] = useState(''), [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'guest' | 'login' | 'register'>('guest'), [username, setUsername] = useState(''), [password, setPassword] = useState('')
  const [stale, setStale] = useState(false)
  const epoch = useRef(0), sessionRef = useRef<SessionApi | null>(null), channel = useRef<BroadcastChannel | null>(null)
  const invalidate = useCallback(() => { epoch.current++; sessionRef.current?.dispose(); setUser(null); setPassword(''); setBusy(false); setStale(true) }, [])
  const announce = () => {
    channel.current?.postMessage('changed')
    try { localStorage.setItem('anyone.account-change', crypto.randomUUID()) } catch { /* BroadcastChannel remains available when storage is blocked. */ }
  }
  useEffect(() => {
    const changed = () => invalidate()
    const storage = (event: StorageEvent) => { if (event.key === 'anyone.account-change') changed() }
    if (typeof BroadcastChannel !== 'undefined') { channel.current = new BroadcastChannel('anyone.account-change'); channel.current.onmessage = event => { if (event.data === 'changed') changed() } }
    window.addEventListener('storage', storage)
    return () => { window.removeEventListener('storage', storage); channel.current?.close(); channel.current = null }
  }, [invalidate])
  const sessionApi = useMemo(() => user ? createSessionApi(user.id, invalidate) : null, [user?.id, invalidate])
  sessionRef.current = sessionApi
  useEffect(() => () => sessionApi?.dispose(), [sessionApi])
  useEffect(() => {
    if (!sessionApi) return
    const revalidate = () => {
      void api<SessionData>('/session').then(s => { if (s.user?.id !== sessionApi.ownerId) sessionApi.invalidate() }).catch(() => sessionApi.invalidate())
    }
    const visible = () => { if (document.visibilityState === 'visible') revalidate() }
    window.addEventListener('focus', revalidate); document.addEventListener('visibilitychange', visible)
    return () => { window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', visible) }
  }, [sessionApi])
  const confirmSession = async () => {
    const attempt = ++epoch.current
    setBusy(true); setError('')
    try { const s = await api<SessionData>('/session'); if (attempt === epoch.current) { setUser(s.user); setStale(false) } } catch(e) { if (attempt === epoch.current) setError(errorText(e)) } finally { if (attempt === epoch.current) setBusy(false) }
  }
  useEffect(() => {
    const attempt = epoch.current
    api<SessionData>('/session').then(s => { if (attempt === epoch.current) setUser(s.user) }).catch(e => { if (attempt === epoch.current) setError(errorText(e)) }).finally(() => setBooting(false))
    try { document.documentElement.dataset.theme = localStorage.getItem('anyone.theme') || 'system' } catch { /* optional preferences */ }
  }, [])
  if (booting) return <div className="boot"><Brand/><p role="status">正在连接你的会话…</p></div>
  if (stale) return <main className="boot"><Brand/><p role="alert">{SESSION_CHANGED_TEXT}</p>{error && <p role="alert">{error}</p>}<button className="primary" disabled={busy} onClick={() => void confirmSession()}>重新确认身份</button></main>
  if (user && sessionApi) return <SessionContext.Provider value={sessionApi}><Workspace key={user.id} user={user} setUser={u => { if (u?.id !== user.id) { epoch.current++; sessionApi.dispose(); announce() } setUser(u); if (!u) { setMode('guest'); setPassword('') } }}/></SessionContext.Provider>
  return <main className="auth-page">
    <header><Brand/><span className="eyebrow">在这里，保持联系</span></header>
    <section className="auth-panel">
      <div className="eyebrow">你好，欢迎来到 ANYONE IM</div>
      <h1>聊到一起。<br/><span>{mode === 'guest' ? '从你的名字开始。' : mode === 'login' ? '回到熟悉的对话。' : '为对话留个位置。'}</span></h1>
      <p className="muted">一个轻盈、专注的聊天空间。<br/>先打个招呼，再让对话自然发生。</p>
      <div className="auth-tabs">
        {(['guest', 'login', 'register'] as const).map(m => <button key={m} aria-pressed={mode === m} onClick={() => { setMode(m); setError(''); setPassword('') }}>{m === 'guest' ? '访客进入' : m === 'login' ? '账号登录' : '创建账号'}</button>)}
      </div>
      <form className="stack" onSubmit={async e => {
        e.preventDefault(); const attempt = ++epoch.current; setBusy(true); setError('')
        try {
          const s = await api<SessionData>(`/auth/${mode}`, 'POST', mode === 'guest' ? { displayName: name.trim() } : { username: username.trim(), password, ...(mode === 'register' ? { displayName: name.trim() } : {}) })
          announce()
          if (attempt === epoch.current) { setPassword(''); setUser(s.user) }
        } catch(e) { if (attempt === epoch.current) setError(errorText(e)) } finally { if (attempt === epoch.current) setBusy(false) }
      }}>
        {mode !== 'login' && <label>你的称呼<input data-testid="guest-name" autoFocus autoComplete="nickname" value={name} onChange={e => setName(e.target.value)} maxLength={32} required placeholder="大家该怎么称呼你？"/></label>}
        {mode !== 'guest' && <>
          <label>用户名<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]+" placeholder="3–32 位字母、数字或下划线"/></label>
          <label>密码<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={mode === 'register' ? 12 : 1} maxLength={128} placeholder={mode === 'register' ? '至少 12 个字符' : '输入你的密码'}/></label>
        </>}
        {error && <p role="alert" className="error">{error}</p>}
        <button data-testid={mode === 'guest' ? 'guest-submit' : undefined} className="primary" disabled={busy || (mode !== 'login' && !name.trim()) || (mode !== 'guest' && (!username.trim() || !password))}>{busy ? '正在进入…' : mode === 'guest' ? '以访客身份进入' : mode === 'login' ? '登录' : '注册并进入'}<ArrowUpRight size={18}/></button>
        <p className="form-note">{mode === 'guest' ? '无需邮箱。访客身份保存在此浏览器的安全会话中。' : '登录凭据不会存入本地存储。'}</p>
      </form>
    </section>
    <footer>少一点纷扰，多一点对话。<span>ANYONE IM / 与彼此相连</span></footer>
  </main>
}
