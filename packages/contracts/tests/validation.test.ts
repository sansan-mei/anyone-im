import { describe, expect, test } from 'bun:test'
import * as contracts from '../src/index'

// Runtime validators must reject forged identity fields, oversized input and empty sends.
describe('shared input boundary', () => {
  test('validates a room name and rejects unknown authority fields', () => {
    const schema = (contracts as Record<string, any>).createRoomSchema
    expect(schema).toBeDefined()
    expect(schema.safeParse({ name: '设计讨论', description: '', visibility: 'private', password: 'fixture-secret' }).success).toBe(true)
    expect(schema.safeParse({ name: '', description: '', visibility: 'private' }).success).toBe(false)
    expect(schema.safeParse({ name: 'x', description: '', visibility: 'private', ownerId: 'forged' }).success).toBe(false)
  })
  test('accepts text or an attachment and rejects forged senders and empty messages', () => {
    const schema = (contracts as Record<string, any>).sendMessageSchema
    expect(schema).toBeDefined()
    const id = crypto.randomUUID()
    expect(schema.safeParse({ clientMessageId: id, text: 'hello' }).success).toBe(true)
    expect(schema.safeParse({ clientMessageId: id, text: '', attachmentId: crypto.randomUUID() }).success).toBe(true)
    expect(schema.safeParse({ clientMessageId: id, text: '   ' }).success).toBe(false)
    expect(schema.safeParse({ clientMessageId: id, text: 'a'.repeat(4001) }).success).toBe(false)
    expect(schema.safeParse({ clientMessageId: id, text: 'hello', sender: 'forged' }).success).toBe(false)
  })
  test('validates account input and bounded display names', () => {
    const guest = (contracts as Record<string, any>).guestSchema
    const register = (contracts as Record<string, any>).registerSchema
    expect(guest).toBeDefined()
    expect(register).toBeDefined()
    expect(guest.safeParse({ displayName: '小未' }).success).toBe(true)
    expect(guest.safeParse({ displayName: 'x'.repeat(33) }).success).toBe(false)
    expect(register.safeParse({ username: 'tester', password: 'correct-horse-9!', displayName: '测试' }).success).toBe(true)
    expect(register.safeParse({ username: 'tester', password: 'short', displayName: '测试' }).success).toBe(false)
  })
})
