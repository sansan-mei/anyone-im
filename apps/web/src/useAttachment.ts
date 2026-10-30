import { useEffect, useRef, useState } from 'react'
import type { Attachment } from '@anyone-im/contracts'
import { errorText } from './api'
import { useApi } from './SessionContext'
export function safeAttachmentUrl(attachment: Attachment) {
  try { const url = new URL(attachment.url, location.origin); return url.origin === location.origin && url.pathname.startsWith('/api/attachments/') ? attachment.url : null } catch { return null }
}
export function useAttachment(roomId: string) {
  const api = useApi()
  const [attachment, setAttachment] = useState<Attachment | undefined>(), [file, setFile] = useState<File | null>(null), [uploading, setUploading] = useState(false), [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [roomId])
  const upload = async (selected: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(selected.type)) { setError('请选择 PNG、JPEG 或 WebP 图片'); return }
    if (selected.size > 5 * 1024 * 1024) { setError('图片不能超过 5 MiB'); return }
    controller.current?.abort(); const request = new AbortController(); controller.current = request
    setFile(selected); setAttachment(undefined); setUploading(true); setError('')
    const form = new FormData(); form.set('file', selected)
    try { const result = await api<Attachment>(`/rooms/${encodeURIComponent(roomId)}/attachments`, 'POST', form, request.signal); if (!request.signal.aborted) setAttachment(result) }
    catch(e) { if (!request.signal.aborted) setError(errorText(e)) }
    finally { if (!request.signal.aborted) setUploading(false) }
  }
  const clear = () => { controller.current?.abort(); setFile(null); setAttachment(undefined); setUploading(false); setError('') }
  return { attachment, file, uploading, error, upload, clear }
}
