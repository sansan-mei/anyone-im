import { expect, test } from 'bun:test'
import { ChangeJournal } from '../src/change-journal'
import { Rooms } from '../src/rooms'

test('bounded journal rejects restart and overflow cursors rather than returning incomplete changes', () => {
  const journal = new ChangeJournal(2, 'one'), start = journal.cursor()
  for (let seq = 1; seq <= 3; seq++) journal.record({ roomId: 'r', messageId: `m${seq}`, seq })
  expect(journal.changes('r', start)).toEqual({ resetRequired: true, deletions: [] })
  expect(journal.changes('r', { generation: 'one', revision: 1 }).deletions.map(m => m.seq)).toEqual([2, 3])
  expect(new ChangeJournal(2, 'two').changes('r', journal.cursor()).resetRequired).toBe(true)
})

test('history pages include a baseline while preserving legacy before/after pagination', async () => {
  const queries: any[] = []
  const db = { membership: { findUnique: async () => ({ active: true, banned: false }) }, message: { findMany: async (query: unknown) => { queries.push(query); return [] } } } as unknown as ConstructorParameters<typeof Rooms>[0]
  const rooms = new Rooms(db)
  const initial = await rooms.page('r', 'u')
  expect(initial).toMatchObject({ messages: [], hasMore: false, changeCursor: { revision: 0 } })
  rooms.changes.record({ roomId: 'r', messageId: 'm', seq: 1 })
  const older = await rooms.page('r', 'u', { beforeSeq: 12, limit: 15 })
  const newer = await rooms.page('r', 'u', { afterSeq: 12, limit: 15 })
  expect(older.changeCursor?.revision).toBe(1)
  expect(newer.changeCursor?.generation).toBe(initial.changeCursor?.generation)
  expect(queries[1]).toMatchObject({ where: { seq: { lt: 12 } }, orderBy: { seq: 'desc' }, take: 16 })
  expect(queries[2]).toMatchObject({ where: { seq: { gt: 12 } }, orderBy: { seq: 'asc' }, take: 16 })
})
