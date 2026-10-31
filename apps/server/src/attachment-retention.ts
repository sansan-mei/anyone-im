import type { PrismaClient } from '../generated/client'

export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const ATTACHMENT_CLEANUP_BATCH = 100
export function attachmentExpired(attachment: { createdAt: Date; expiredAt: Date | null }, now = new Date()) {
  return attachment.expiredAt !== null || attachment.createdAt.getTime() + ATTACHMENT_TTL_MS <= now.getTime()
}

type Gate = <T>(fn: () => Promise<T>) => Promise<T>
/** Erase binary resources, retaining only a small tombstone for stable chat IDs. */
export function createAttachmentRetention(db: Pick<PrismaClient, 'attachment'>, gate: Gate, now = () => new Date(), intervalMs = 60000) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid retention interval')
  let stopped = false
  let active: Promise<number> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const run = (): Promise<number> => {
    if (stopped) return Promise.resolve(0)
    if (active) return active
    active = gate(async () => {
      const current = now()
      const cutoff = new Date(current.getTime() - ATTACHMENT_TTL_MS)
      const ids = await db.attachment.findMany({
        where: { expiredAt: null, createdAt: { lte: cutoff } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: ATTACHMENT_CLEANUP_BATCH,
        select: { id: true }
      })
      if (!ids.length) return 0
      const result = await db.attachment.updateMany({
        where: { id: { in: ids.map(row => row.id) }, expiredAt: null, createdAt: { lte: cutoff } },
        data: { bytes: new Uint8Array(0), expiredAt: current }
      })
      return result.count
    }).finally(() => { active = undefined })
    return active
  }
  const tick = () => { void run().catch(() => { console.warn('Attachment retention sweep failed; retrying on next interval') }) }
  return {
    run,
    start() {
      if (stopped || timer) return
      tick()
      timer = setInterval(tick, intervalMs)
      timer.unref?.()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
      await active?.catch(() => {})
    }
  }
}
