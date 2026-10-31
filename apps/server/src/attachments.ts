import { basename } from 'node:path'
import { MAX_ATTACHMENT_BYTES } from '@anyone-im/contracts'
import { Rooms, attachmentDto, attachmentMetadataSelect } from './rooms'
import { fail, readLimited } from './security'
import { attachmentExpired } from './attachment-retention'

export class Attachments {
  constructor(readonly rooms: Rooms) {}
  async prepare(request: Request, timeoutMs?: number) {
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data;')) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用multipart文件上传')
    const bytes = await readLimited(request, MAX_ATTACHMENT_BYTES + 65536, timeoutMs)
    let form: FormData
    try { form = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type')! }, body: bytes }).formData() }
    catch { return fail(400, 'INVALID_INPUT', '上传格式无效') }
    const file = form.get('file')
    if (!(file instanceof File) || [...form.keys()].length !== 1) return fail(400, 'INVALID_INPUT', '请选择一个文件')
    if (file.size > MAX_ATTACHMENT_BYTES) return fail(413, 'PAYLOAD_TOO_LARGE', '图片不可超过10MiB')
    const data = new Uint8Array(await file.arrayBuffer())
    let mimeType = ''
    if (data.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => data[i] === n)) mimeType = 'image/png'
    else if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) mimeType = 'image/jpeg'
    else if (data.length >= 12 && new TextDecoder().decode(data.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(data.slice(8, 12)) === 'WEBP') mimeType = 'image/webp'
    // Bun formData() infers File.type from filename, so inspect the actual
    // multipart part header rather than trusting the parsed File.type.
    const headerEnd = Buffer.from(bytes).indexOf('\r\n\r\n')
    if (headerEnd < 0 || headerEnd > 16384) return fail(400, 'INVALID_INPUT', '上传格式无效')
    const partHeaders = new TextDecoder().decode(bytes.slice(0, headerEnd))
    const contentTypes = [...partHeaders.matchAll(/^content-type:\s*([^\r\n]+)/gim)]
    const declaredType = contentTypes.length === 1 ? contentTypes[0]![1]!.split(';')[0]!.trim().toLowerCase() : ''
    if (!mimeType || mimeType !== declaredType) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '仅支持有效PNG、JPEG、WebP图片')
    const filename = basename(file.name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'image'
    return { data, filename, mimeType }
  }
  async commit(prepared: Awaited<ReturnType<Attachments['prepare']>>, roomId: string, userId: string) {
    await this.rooms.member(roomId, userId)
    const { data, filename, mimeType } = prepared
    const attachment = await this.rooms.db.attachment.create({
      data: { roomId, userId, filename, mimeType, size: data.length, bytes: data },
      select: attachmentMetadataSelect
    })
    return attachmentDto(attachment)
  }
  async download(id: string, userId: string) {
    // Check metadata/ACL before materializing a potentially 10 MiB blob.
    // The caller holds the commit/ACL gate across both reads.
    const attachment = await this.rooms.db.attachment.findUnique({ where: { id }, select: { ...attachmentMetadataSelect, userId: true, message: { select: { deletedAt: true } } } })
    if (!attachment) return fail(404, 'NOT_FOUND', '附件不存在')
    await this.rooms.member(attachment.roomId, userId)
    if (attachment.message?.deletedAt) return fail(404, 'NOT_FOUND', '附件不可用')
    if (!attachment.message && attachment.userId !== userId) return fail(403, 'FORBIDDEN', '附件尚未发布')
    if (attachmentExpired(attachment)) return fail(410, 'ATTACHMENT_EXPIRED', '图片已过期')
    const content = await this.rooms.db.attachment.findUnique({ where: { id }, select: { bytes: true } })
    if (!content) return fail(404, 'NOT_FOUND', '附件不存在')
    return new Response(new Uint8Array(content.bytes), { headers: { 'Content-Type': attachment.mimeType, 'Content-Length': String(attachment.size), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}` } })
  }
}
