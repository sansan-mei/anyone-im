import { useEffect, useState } from 'react'
import type { Attachment } from '@anyone-im/contracts'
import { ApiFailure } from './api'
import { useApi } from './SessionContext'
import { safeAttachmentUrl } from './useAttachment'

export function AttachedImage({ attachment, onLoad }: { attachment: Attachment; onLoad?: () => void }) {
  const api = useApi()
  const [failed, setFailed] = useState(false), [url, setUrl] = useState(''), [attempt, setAttempt] = useState(0), [expired, setExpired] = useState(false)
  const source = safeAttachmentUrl(attachment)
  const deadline = attachment.expiresAt ? Date.parse(attachment.expiresAt) : NaN
  const elapsed = () => Number.isFinite(deadline) && Date.now() >= deadline
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = '', timer: ReturnType<typeof setTimeout> | undefined
    const release = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = '' } }
    const expire = () => { controller.abort(); release(); setUrl(''); setExpired(true); if (timer !== undefined) clearTimeout(timer) }
    setUrl(''); setFailed(false); setExpired(false)
    // Metadata and the browser deadline both gate the request: never fetch known-expired bytes.
    if (attachment.expired || elapsed()) { setExpired(true); return }
    if (!source) { setFailed(true); return }
    const schedule = () => {
      if (elapsed()) { expire(); return }
      if (Number.isFinite(deadline)) timer = setTimeout(schedule, Math.min(deadline - Date.now(), 2_147_483_647))
    }
    schedule()
    // Keep the expected-user precondition on every byte request, including retries.
    void api.resource(new URL(source, location.origin).pathname.replace(/^\/api/, ''), controller.signal).then(blob => {
      if (controller.signal.aborted) return
      if (elapsed()) { expire(); return }
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(error => {
      if (controller.signal.aborted) return
      if (elapsed() || (error instanceof ApiFailure && (error.code === 'ATTACHMENT_EXPIRED' || error.status === 410))) expire()
      else setFailed(true)
    })
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); release() }
  }, [api, source, deadline, attachment.expired, attempt])
  if (attachment.expired || expired || elapsed()) return <span className="image-expired">图片已过期</span>
  if (!failed && !url) return <span role="status">正在加载图片…</span>
  return failed ? <span className="image-error">图片暂不可用{source && <button className="text-button" onClick={() => setAttempt(n => n + 1)}>重试加载图片</button>}</span> : <a href={url} target="_blank" rel="noreferrer" className="image-link" aria-label={`查看图片 ${attachment.filename}`} onClick={e => { if (elapsed()) { e.preventDefault(); setExpired(true) } }}><img src={url} alt={attachment.filename} onError={() => { if (elapsed()) setExpired(true); else setFailed(true) }} onLoad={onLoad}/></a>
}
