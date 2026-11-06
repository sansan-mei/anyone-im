import { useEffect, useState } from 'react'
import type { Attachment } from '@anyone-im/contracts'
import { ApiFailure, type SessionApi } from './api'
import { useApi } from './SessionContext'
import { safeAttachmentUrl } from './useAttachment'
import { useNearViewport } from './useNearViewport'

type ImageProps = { attachment: Attachment; onLoad?: () => void }
export function AttachedImage(props: ImageProps) {
  const api = useApi()
  const { attachment } = props
  // A replacement must neither display old bytes nor inherit a previous intersection.
  const key = JSON.stringify([api.ownerId, attachment.id, attachment.url, attachment.expiresAt, attachment.expired])
  return <AttachmentImage key={key} {...props} api={api}/>
}

function AttachmentImage({ attachment, onLoad, api }: ImageProps & { api: SessionApi }) {
  const { ref, nearViewport } = useNearViewport<HTMLSpanElement>()
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
    let unsubscribe = () => {}
    const cleanup = () => { unsubscribe(); controller.abort(); if (timer !== undefined) clearTimeout(timer); release() }
    // The deadline runs even offscreen; only the byte request waits for visibility.
    if (!nearViewport) return cleanup
    // Only a rejected pending generation may retry automatically. A loaded blob,
    // ordinary failure or terminal expiry must not refetch on session verification.
    let interrupted = false
    const retryInterrupted = () => {
      if (interrupted && api.isCurrent() && !controller.signal.aborted && !elapsed()) {
        interrupted = false
        setAttempt(n => n + 1)
      }
    }
    unsubscribe = api.onResume(retryInterrupted)
    // Keep the expected-user precondition on every byte request, including retries.
    void api.resource(new URL(source, location.origin).pathname.replace(/^\/api/, ''), controller.signal).then(blob => {
      if (controller.signal.aborted) return
      if (elapsed()) { expire(); return }
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(error => {
      if (controller.signal.aborted) return
      if (elapsed() || (error instanceof ApiFailure && (error.code === 'ATTACHMENT_EXPIRED' || error.status === 410))) expire()
      else if (error instanceof ApiFailure && error.code === 'SESSION_UNVERIFIED') {
        interrupted = true
        // Settlement may occur after resume; do not wait for a signal already sent.
        retryInterrupted()
      } else setFailed(true)
    })
    return cleanup
  }, [api, source, deadline, attachment.expired, attempt, nearViewport])
  if (attachment.expired || expired || elapsed()) return <span className="image-expired">图片已过期</span>
  if (!failed && !url) return <span ref={ref} className="image-link" style={{ minWidth: 48, minHeight: 48 }}><span role="status" style={{ display: 'grid', placeItems: 'center', width: 'min(240px, 40vw)', maxWidth: '100%', minHeight: 48, aspectRatio: '4 / 3', lineHeight: 1.5, whiteSpace: 'normal' }}>{nearViewport ? '正在加载图片…' : '图片将在滚动到附近时加载'}</span></span>
  return failed ? <span className="image-error">图片暂不可用{source && <button className="text-button" onClick={() => setAttempt(n => n + 1)}>重试加载图片</button>}</span> : <a href={url} target="_blank" rel="noreferrer" className="image-link" aria-label={`查看图片 ${attachment.filename}`} onClick={e => { if (elapsed()) { e.preventDefault(); setExpired(true) } }}><img src={url} alt={attachment.filename} onError={() => { if (elapsed()) setExpired(true); else setFailed(true) }} onLoad={onLoad}/></a>
}
