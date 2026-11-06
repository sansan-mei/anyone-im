import { expect, test } from 'bun:test'
import { changeCursorSchema, roomSubscribeSchema, type MessagePage } from '../src/index'

test('subscription accepts legacy input and a bounded optional change cursor', () => {
  expect(roomSubscribeSchema.safeParse({ roomId: 'room', afterSeq: 0 }).success).toBe(true)
  expect(roomSubscribeSchema.safeParse({ roomId: 'room', afterSeq: 12, changeCursor: { generation: 'process-generation', revision: 0 } }).success).toBe(true)
  const legacy: MessagePage = { messages: [], hasMore: false }
  expect(legacy.changeCursor).toBeUndefined()
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) expect(changeCursorSchema.safeParse({ generation: 'a', revision }).success).toBe(false)
  for (const generation of ['', 'x'.repeat(65)]) expect(changeCursorSchema.safeParse({ generation, revision: 0 }).success).toBe(false)
  expect(changeCursorSchema.safeParse({ generation: 'a', revision: 0, userId: 'forged' }).success).toBe(false)
  expect(roomSubscribeSchema.safeParse({ roomId: 'room', changeCursor: { generation: 'a', revision: 0 }, userId: 'forged' }).success).toBe(false)
})
