import { expect, test } from 'bun:test'

// Load the optional new hook without treating an absent feature as a loader error.
const modulePath = new URL('../src/attachment-retention.ts', import.meta.url)
const feature = await Bun.file(modulePath).exists() ? await import('../src/attachment-retention') : null

test('image retention has an exact seven-day boundary and rejects cleared resources', () => {
  expect(feature?.attachmentExpired).toBeFunction()
  const now = new Date('2026-10-31T00:00:00Z')
  const createdAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  expect(feature!.attachmentExpired({ createdAt, expiredAt: null }, now)).toBe(true)
  expect(feature!.attachmentExpired({ createdAt: new Date(createdAt.getTime() + 1), expiredAt: null }, now)).toBe(false)
  expect(feature!.attachmentExpired({ createdAt: now, expiredAt: now }, now)).toBe(true)
})

test('cleanup coalesces concurrent calls, selects bounded metadata and drains before stopping', async () => {
  expect(feature?.createAttachmentRetention).toBeFunction()
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const finds: unknown[] = [], updates: any[] = []
  const attachment = {
    findMany: async (query: unknown) => { finds.push(query); await pending; return [{ id: 'expired-id' }] },
    updateMany: async (query: unknown) => { updates.push(query); return { count: 1 } }
  }
  const hook = feature!.createAttachmentRetention({ attachment } as any, async fn => fn(), () => new Date('2026-10-31T00:00:00Z'))
  const first = hook.run(), second = hook.run()
  await Promise.resolve()
  expect(finds).toHaveLength(1)
  expect(finds[0]).toMatchObject({ take: 100, select: { id: true }, where: { expiredAt: null } })
  const stopped = hook.stop()
  finish()
  expect(await first).toBe(1)
  expect(await second).toBe(1)
  await stopped
  expect(updates).toHaveLength(1)
  expect(updates[0].data.bytes.byteLength).toBe(0)
  expect(updates[0].data.expiredAt).toBeInstanceOf(Date)
  expect(await hook.run()).toBe(0)
})
