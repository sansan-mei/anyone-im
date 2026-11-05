import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionData, User } from '@anyone-im/contracts'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { ArrowUpRight, ArrowRight, Hash, Sparkles, CheckCheck, MessageCircle } from 'lucide-react'
import { publicApi as api, createSessionApi, errorText, SESSION_CHANGED_TEXT, type SessionApi } from './api'
import { SessionContext } from './SessionContext'
import { Workspace } from './Workspace'
import { usePwaInstall } from './PwaSettings'
export function Brand() { return <span className="brand"><span className="brand-mark" aria-hidden="true"><i/><i/></span>Anyone<span className="brand-dot">/</span></span> }
export default function App() {
  const install = usePwaInstall()
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
  if (user && sessionApi) return <SessionContext.Provider value={sessionApi}><Workspace install={install} key={user.id} user={user} setUser={u => { if (u?.id !== user.id) { epoch.current++; sessionApi.dispose(); announce() } setUser(u); if (!u) { setMode('guest'); setPassword('') } }}/></SessionContext.Provider>
  return <main className="auth-page">
    <header><Brand/><span className="eyebrow">在这里，保持联系</span></header>
    <div className="auth-layout">
    <aside className="auth-story" aria-label="Anyone 聊天空间介绍">
      <span className="story-label"><span/> 为每一次相遇，留一点空间</span>
      <h2>好的对话，<br/>让彼此<span>更近一点。</span></h2>
      <p>分享灵感，交换日常。<br/>和聊得来的人，在这里相聚。</p>
      <div className="preview-window" aria-hidden="true">
        <div className="preview-header"><span className="preview-hash"><Hash size={18}/></span><strong>灵感交换站<small>一个想法，一场新对话</small></strong><span className="preview-live">一起在线</span></div>
        <div className="preview-date">今天 · 此刻</div>
        <div className="preview-message"><span className="preview-avatar">林</span><div><small>小林 <span>14:28</span></small><p>分享一个刚刚冒出来的想法 ✨</p></div></div>
        <div className="preview-message preview-own"><div><small>你 <span>14:29</span></small><p>我在，展开聊聊！</p><span className="preview-receipt"><CheckCheck size={13}/> 已送达</span></div></div>
        <div className="preview-typing"><i/><i/><i/><span>新的灵感正在发生</span></div>
        <div className="preview-composer">每一句，都有回应。<span><ArrowRight size={16}/></span></div>
      </div>
      <div className="story-footer"><MessageCircle size={15}/> 轻松加入 <span>·</span> 即时连接 <span>·</span> 自然交流</div>
    </aside>
    <section className="auth-panel">
      <div className="welcome-label"><Sparkles size={14}/> 你的下一场对话，从这里开始</div>
      <h1>聊到一起。<br/><span>{mode === 'guest' ? '从你的名字开始。' : mode === 'login' ? '回到熟悉的对话。' : '为对话留个位置。'}</span></h1>
      <p className="muted">一个轻盈、专注的聊天空间。<br/>先打个招呼，再让对话自然发生。</p>
      <LayoutGroup id="auth-mode"><div className="auth-tabs">
        {(['guest', 'login', 'register'] as const).map(m => <button key={m} aria-pressed={mode === m} onClick={() => { setMode(m); setError(''); setPassword('') }}>{mode === m && <motion.span className="tab-indicator" layoutId="auth-tab" transition={{ type: 'spring', stiffness: 420, damping: 34 }}/>}<span>{m === 'guest' ? '访客进入' : m === 'login' ? '账号登录' : '创建账号'}</span></button>)}
      </div></LayoutGroup>
      <AnimatePresence initial={false} mode="wait"><motion.form key={mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: .14 }} className="stack" onSubmit={async e => {
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
      </motion.form></AnimatePresence>
    </section></div>
    <footer>少一点纷扰，多一点对话。<span>ANYONE IM / 与彼此相连</span></footer>
  </main>
}
