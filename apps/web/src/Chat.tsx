import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, MessageSquare, RotateCcw, ImagePlus, ImageIcon, X, Trash2 } from 'lucide-react'
import type { Attachment, Message, RoomSummary, User } from '@anyone-im/contracts'
import type { useMessages } from './useMessages'
import { errorText } from './api'
import { useApi } from './SessionContext'
import { Modal, rememberFocus } from './Modal'
import { safeAttachmentUrl, useAttachment } from './useAttachment'
export type MessageState = ReturnType<typeof useMessages>
const positions = new Map<string, { top: number; bottom: boolean }>()
function AttachedImage({ attachment, onLoad }: { attachment: Attachment; onLoad?: () => void }) {
  const api = useApi()
  const [failed, setFailed] = useState(false), [url, setUrl] = useState(''), [attempt, setAttempt] = useState(0)
  const source = safeAttachmentUrl(attachment)
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = ''
    setUrl(''); setFailed(false)
    if (!source) { setFailed(true); return }
    // Native img/a requests cannot carry the expected-user precondition. Fetch a bound blob instead.
    void api.resource(new URL(source, location.origin).pathname.replace(/^\/api/, ''), controller.signal).then(blob => {
      if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [api, source, attempt])
  if (!failed && !url) return <span role="status">正在加载图片…</span>
  return failed ? <span className="image-error">图片暂不可用{source && <button className="text-button" onClick={() => setAttempt(n => n + 1)}>重试加载图片</button>}</span> : <a href={url} target="_blank" rel="noreferrer" className="image-link" aria-label={`查看图片 ${attachment.filename}`}><img src={url} alt={attachment.filename} onError={() => setFailed(true)} onLoad={onLoad}/></a>
}
export function Chat({ user, room, state, visible = true, onRead }: { user: User; room: RoomSummary; state: MessageState; visible?: boolean; onRead: (seq: number) => void }) {
  const api = useApi()
  const [draft, setDraft] = useState(''), [atBottom, setAtBottom] = useState(true), [readError, setReadError] = useState('')
  const upload = useAttachment(room.id), fileInput = useRef<HTMLInputElement>(null)
  const [deleting, setDeleting] = useState<Message | null>(null), [deleteBusy, setDeleteBusy] = useState(false), [deleteError, setDeleteError] = useState('')
  const list = useRef<HTMLDivElement>(null), textarea = useRef<HTMLTextAreaElement>(null), stick = useRef(true), initial = useRef(true)
  const anchor = useRef<{ id?: string; offset: number; top: number; height: number } | null>(null)
  const key = `${user.id}:${room.id}`, lastRead = useRef(room.lastReadSeq), reading = useRef(0), onReadRef = useRef(onRead)
  onReadRef.current = onRead; lastRead.current = Math.max(lastRead.current, room.lastReadSeq)
  const [foreground, setForeground] = useState(document.visibilityState === 'visible')
  useEffect(() => { const change = () => setForeground(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change) }, [])
  const measure = () => {
    const el = list.current; if (!el) return
    const bottom = el.scrollHeight - el.clientHeight - el.scrollTop < 48
    stick.current = bottom; setAtBottom(bottom); positions.set(key, { top: el.scrollTop, bottom })
  }
  const jump = () => { const el = list.current; if (!el) return; el.scrollTop = el.scrollHeight; stick.current = true; setAtBottom(true); setReadError(''); measure() }
  useLayoutEffect(() => {
    const el = list.current; if (!el || state.loading) return
    if (initial.current && state.messages.length) {
      initial.current = false; const position = positions.get(key)
      stick.current = position?.bottom ?? true
      el.scrollTop = position && !position.bottom ? position.top : el.scrollHeight
      measure(); return
    }
    if (anchor.current) {
      if (state.olderLoading) return
      const saved = anchor.current
      const item = saved.id ? el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(saved.id)}"]`) : null
      if (item) el.scrollTop += item.getBoundingClientRect().top - saved.offset
      else el.scrollTop = saved.top + el.scrollHeight - saved.height
      anchor.current = null; measure(); return
    }
    if (stick.current) { el.scrollTop = el.scrollHeight; measure() }
  }, [state.messages, state.outbox.length, state.loading, state.olderLoading, state.hasMore, key])
  useEffect(() => () => { const el = list.current; if (el) positions.set(key, { top: el.scrollTop, bottom: stick.current }) }, [key])
  const latestSeq = state.messages.at(-1)?.seq || 0
  useEffect(() => {
    if (!visible || !foreground || !atBottom || state.loading || !latestSeq || latestSeq <= lastRead.current || latestSeq <= reading.current) return
    reading.current = latestSeq
    void api(`/rooms/${encodeURIComponent(room.id)}/read`, 'PATCH', { seq: latestSeq }).then(() => { lastRead.current = Math.max(lastRead.current, latestSeq); onReadRef.current(latestSeq); setReadError('') }).catch(e => setReadError(errorText(e))).finally(() => { reading.current = 0 })
  }, [latestSeq, atBottom, foreground, visible, state.loading, room.id])
  const older = () => {
    const el = list.current; if (!el) return
    stick.current = false; setAtBottom(false)
    const item = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > el.getBoundingClientRect().top)
    anchor.current = { id: item?.dataset.messageId, offset: item?.getBoundingClientRect().top || 0, top: el.scrollTop, height: el.scrollHeight }
    void state.loadOlder()
  }
  const imageLoaded = () => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight }
  const send = () => { if ((!draft.trim() && !upload.attachment) || upload.uploading) return; state.send(draft, upload.attachment); setDraft(''); upload.clear(); if (textarea.current) textarea.current.style.height = ''; /* Do not steal the viewport from a history reader. */ }
  return <>
    <div className="timeline" ref={list} onScroll={measure} data-testid="message-list" role="log" aria-label="消息记录" aria-live="polite" aria-relevant="additions">
      {state.hasMore && <div className="history-control"><button className="text-button" disabled={state.olderLoading} onClick={older}>{state.olderLoading ? '正在加载…' : '加载更早消息'}</button></div>}
      {state.loading && <p className="timeline-notice" role="status">正在加载消息…</p>}
      {state.error && <p role="alert" className="error">{state.error}<button className="text-button" onClick={() => state.loadInitial(room.id, true)}>重新加载消息</button></p>}
      {!state.loading && !state.error && !state.messages.length && !state.outbox.length && <div className="conversation-empty"><MessageSquare size={28}/><h3>从第一句开始</h3><p>这里还很安静。发一条消息，开启对话吧。</p><span className="room-tag">{room.name}</span></div>}
      {state.messages.map((m,i) => <Fragment key={m.id}>
        {(!i || new Date(state.messages[i-1].createdAt).toDateString() !== new Date(m.createdAt).toDateString()) && <div className="date-divider"><span>{new Date(m.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', year: 'numeric' })}</span></div>}
        <article data-message-id={m.id} className={`message ${m.sender.id === user.id ? 'own' : ''}`}>
          <span className="avatar" aria-hidden="true">{m.sender.displayName.slice(0,1)}</span><div className="message-content"><div className="message-meta"><strong>{m.sender.displayName}</strong><time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>{!m.deletedAt && !state.deleted.has(m.id) && (m.sender.id === user.id || room.role === 'owner') && <button className="message-delete icon" aria-label="删除消息" onClick={e => { rememberFocus(e); setDeleteError(''); setDeleting(m) }}><Trash2 size={13}/></button>}</div><div className="bubble">{m.deletedAt || state.deleted.has(m.id) ? <span className="tombstone">消息已删除</span> : <>{m.attachment && <AttachedImage attachment={m.attachment} onLoad={imageLoaded}/ >}{m.text && <div className="message-text">{m.text}</div>}</>}</div></div>
        </article>
      </Fragment>)}
      {state.outbox.map(o => <article key={o.input.clientMessageId} className="message own pending"><div className="message-content"><div className="message-meta"><span>待发送</span></div><div className="bubble">{o.attachment && <AttachedImage attachment={o.attachment} onLoad={imageLoaded}/ >}{o.input.text && <div className="message-text">{o.input.text}</div>}</div><div className={`send-status ${o.state === 'failed' ? 'failed' : ''}`}>{o.state === 'sending' ? <span role="status">发送中…</span> : <><span>{o.error || '发送失败'}</span><button aria-label="重试发送" onClick={() => state.retry(o)}><RotateCcw size={13}/>重试</button></>}</div></div></article>)}
    </div>
    {!atBottom && <button className="jump-latest" aria-label="回到最新消息" onClick={jump}><ArrowDown size={15}/>回到最新</button>}
    {readError && <p className="read-error">已读位置尚未同步：{readError}</p>}
    {upload.file && <div className="attachment-preview">{upload.attachment ? <AttachedImage attachment={upload.attachment}/> : <ImageIcon size={24}/>}<div><strong>{upload.file.name}</strong><span role="status">{upload.uploading ? '正在上传图片…' : upload.attachment ? '图片已就绪' : '图片上传失败'}</span></div>{!upload.uploading && !upload.attachment && <button className="text-button" onClick={() => upload.file && upload.upload(upload.file)}>重试上传</button>}<button className="icon" aria-label="移除待发送图片" onClick={upload.clear}><X size={17}/></button></div>}
    {upload.error && <p role="alert" className="upload-error">{upload.error}</p>}
    <div id="composer-hint" className="composer-note">Enter 发送 · Shift + Enter 换行</div>
    <form className="composer" onSubmit={e => { e.preventDefault(); send() }}>
      <input className="sr-only" type="file" aria-label="选择图片" accept="image/png,image/jpeg,image/webp" ref={fileInput} onChange={e => { const file = e.target.files?.[0]; if (file) void upload.upload(file); e.target.value = '' }}/>
      <button type="button" className="icon attach-button" aria-label="添加图片" title="PNG、JPEG、WebP，最大 10 MiB" disabled={upload.uploading} onClick={() => fileInput.current?.click()}><ImagePlus size={20}/></button>
      <textarea ref={textarea} data-testid="message-input" aria-label="输入消息" aria-describedby="composer-hint" rows={1} maxLength={4000} value={draft} onPaste={e => { const file = [...e.clipboardData.files].find(f => f.type.startsWith('image/')); if (file) { e.preventDefault(); void upload.upload(file) } }} onChange={e => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px` }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); send() } }} placeholder={`发送消息到 ${room.name}`}/>
      <button data-testid="send-message" className="send" aria-label="发送消息" disabled={upload.uploading || (!draft.trim() && !upload.attachment)}><ArrowUp size={21}/></button>
    </form>

    <Modal open={!!deleting} onOpenChange={v => { if (!v && !deleteBusy) setDeleting(null) }} title="删除这条消息？" description="删除后所有成员都将看到消息已删除的提示，此操作无法撤销。"><div className="modal-body stack">{deleteError && <p role="alert" className="error">{deleteError}</p>}<button className="danger" disabled={deleteBusy} onClick={async () => { if (!deleting) return; setDeleteBusy(true); try { await api(`/messages/${encodeURIComponent(deleting.id)}`, 'DELETE'); state.tombstone(deleting.id); setDeleting(null) } catch(e) { setDeleteError(errorText(e)) } finally { setDeleteBusy(false) } }}>确认删除</button><button className="secondary" disabled={deleteBusy} onClick={() => setDeleting(null)}>取消</button></div></Modal>
  </>
}
