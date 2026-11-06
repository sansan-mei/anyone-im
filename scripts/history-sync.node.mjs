// Offline real-source regression tests. Node 26; no database/build/browser.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
function load(path, name, globals = {}) {
  const text = stripTypeScriptTypes(source(path), { mode: 'strip', disableExperimentalWarning: true }).replace(/^import .*$/gm, '').replace(/\bexport /g, '')
  return runInNewContext(`${text}\n${name}`, { randomUUID, AbortController, ...globals })
}
function hookHarness(api) {
  let slots = [], index = 0, effects = [], dirty = false, room = 'room', value
  const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i])
  const react = {
    useRef: initial => { const i = index++; return slots[i] ??= { current: initial } },
    useState: initial => { const i = index++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], next => { const result = typeof next === 'function' ? next(slots[i]) : next; if (result !== slots[i]) { slots[i] = result; dirty = true } }] },
    useCallback: (fn, deps) => { const i = index++; if (!equal(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn },
    useEffect: (fn, deps) => { const i = index++; if (!equal(slots[i]?.deps, deps)) { const previous = slots[i]; slots[i] = { deps }; effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn() }) } }
  }
  const useMessages = load('apps/web/src/useMessages.ts', 'useMessages', { ...react, useApi: () => api, HistoryCache: history(), DEFAULT_MESSAGE_PAGE_SIZE: 15, localStorage: { getItem: () => null, setItem: () => {} }, crypto: { randomUUID }, errorText: e => e.message })
  const render = () => { index = 0; dirty = false; value = useMessages({ id: 'u' }, room); const pending = effects; effects = []; pending.forEach(fn => fn()); return value }
  return { render, get value() { return value }, async flush() { for (let i = 0; i < 15; i++) { await new Promise(resolve => setImmediate(resolve)); if (dirty) render() } }, async room(id) { room = id; render(); await this.flush() } }
}

test('real message hook uses bounded cache and starts an evicted room from a fresh baseline', async () => {
  let reads = 0
  const api = Object.assign(async path => { reads++; const room = path.split('/')[2]; return { messages: [message(50, room)], hasMore: true, changeCursor: { generation: 'a', revision: reads } } }, { ownerId: 'u', isCurrent: () => true })
  const h = hookHarness(api); h.render(); await h.flush()
  assert.equal(h.value.history.peek('room').contiguous, 50)
  for (let i = 0; i < 10; i++) await h.room(`r${i}`)
  assert.equal(h.value.history.entries.size, 8)
  assert.equal(h.value.history.peek('room'), undefined)
  await h.room('room')
  assert.equal(reads, 12)
  assert.equal(h.value.history.peek('room').changeCursor.revision, 12)
})

test('real realtime hook subscribes with the authoritative cache cursor instead of scanning a valid cache', async () => {
  const Cache = history(), cache = new Cache(), entry = cache.activate('room')
  cache.initialize(entry, { messages: [message(5)], hasMore: false, changeCursor: { generation: 'a', revision: 2 } })
  let slots = [], index = 0, effects = [], dirty = false, scans = 0, subscribed, paused = false, disconnects = 0, connections = 0, invalidations = 0
  const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i])
  const events = {}, socket = {
    connected: true, on: (event, fn) => { events[event] = fn }, timeout() { return this },
    emit: (event, input, ack) => { subscribed = input; ack(null, { data: { messages: [], hasMore: false, changeCursor: { generation: 'a', revision: 3 }, changes: { resetRequired: false, deletions: [] } } }) },
    connect() {}, disconnect() { disconnects++ }
  }
  const state = { history: cache, cacheKey: entry, publish: () => {}, suspendHistory: () => cache.suspend(), loadInitial: async () => {}, refreshCached: async () => { scans++ }, initialCursor: () => 5, merge: (id, incoming) => cache.merge(entry, incoming), setRoomError: (id, error) => { throw new Error(error) } }
  const api = Object.assign(async () => { throw new Error('unexpected HTTP') }, { isCurrent: () => true, ownerId: 'u', invalidate: () => { invalidations++ } })
  const useRealtime = load('apps/web/src/useRealtime.ts', 'useRealtime', {
    useRef: initial => { const i = index++; return slots[i] ??= { current: initial } },
    useState: initial => { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; dirty = true }] },
    useEffect: (fn, deps) => { const i = index++; if (!equal(slots[i]?.deps, deps)) { const previous = slots[i]; slots[i] = { deps }; effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn() }) } },
    io: () => { connections++; return socket }, useApi: () => api, synchronizeHistory: synchronizer(), DEFAULT_MESSAGE_PAGE_SIZE: 15, errorText: e => e.message,
    window: { addEventListener() {}, removeEventListener() {} }
  })
  const render = () => { index = 0; dirty = false; useRealtime({ active: 'room', state, paused, refresh: async () => true }); const pending = effects; effects = []; pending.forEach(fn => fn()) }
  render(); events.connect()
  for (let i = 0; i < 10; i++) { await new Promise(resolve => setImmediate(resolve)); if (dirty) render() }
  assert.equal(subscribed.changeCursor.revision, 2)
  assert.equal(subscribed.afterSeq, 5)
  assert.equal(scans, 0)
  assert.equal(entry.changeCursor.revision, 3)
  paused = true; render()
  assert.equal(disconnects, 1)
  assert.equal(cache.peek('room').messages, entry.messages)
  assert.notEqual(cache.peek('room'), entry)
  events.connect_error(new Error('SESSION_CHANGED'))
  assert.equal(invalidations, 0)
  paused = false; render()
  assert.equal(connections, 2)
})

const journal = () => load('apps/server/src/change-journal.ts', 'ChangeJournal')
const history = () => load('apps/web/src/history-cache.ts', 'HistoryCache')
const synchronizer = () => load('apps/web/src/history-cache.ts', 'synchronizeHistory')
const message = (seq, roomId = 'room') => ({ id: `${roomId}-${seq}`, roomId, seq, text: `text-${seq}`, attachment: { id: 'image' }, deletedAt: null, sender: { id: 'u' }, clientMessageId: `${seq}` })

test('session hold rejects stale history work without poisoning the preserved cache with an error', async () => {
  let reject, current = true
  const api = Object.assign(() => new Promise((resolve, fail) => { reject = fail }), { ownerId: 'u', isCurrent: () => current })
  const h = hookHarness(api); h.render()
  current = false; reject(new Error('held operation'))
  await h.flush()
  current = true; h.render()
  assert.equal(h.value.error, '')
  assert.equal(h.value.history.peek('room').initialized, false)
})

test('resume starts fresh initial work instead of joining a pre-hold request', async () => {
  let finish, reads = 0, current = true
  const api = Object.assign(() => { reads++; return reads === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ messages: [message(20)], hasMore: true, changeCursor: { generation: 'a', revision: 2 } }) }, { ownerId: 'u', isCurrent: () => current })
  const h = hookHarness(api); h.render()
  current = false; h.value.suspendHistory()
  current = true
  await h.value.loadInitial('room'); await h.flush()
  assert.equal(reads, 2)
  assert.equal(h.value.history.peek('room').contiguous, 20)
  finish({ messages: [message(10)], hasMore: true, changeCursor: { generation: 'a', revision: 1 } })
  await h.flush()
  assert.equal(h.value.history.peek('room').contiguous, 20)
  assert.equal(h.value.history.peek('room').changeCursor.revision, 2)
})

test('bounded windows page older then newer without losing fetched older rows or paging flags', () => {
  const Cache = history(), cache = new Cache(2, 4), entry = cache.activate('room')
  cache.initialize(entry, { messages: [7, 8, 9, 10].map(n => message(n)), hasMore: true, changeCursor: { generation: 'a', revision: 2 } })
  cache.page(entry, { messages: [5, 6].map(n => message(n)), hasMore: true }, 'older')
  assert.equal(entry.messages.map(m => m.seq).join(), '5,6,7,8')
  assert.equal(entry.hasOlder, true)
  assert.equal(entry.hasNewer, true)
  cache.merge(entry, [message(11)]) // a live event must not steal a backscroll window
  assert.equal(entry.messages.map(m => m.seq).join(), '5,6,7,8')
  cache.page(entry, { messages: [9, 10].map(n => message(n)), hasMore: true }, 'newer')
  assert.equal(entry.messages.map(m => m.seq).join(), '7,8,9,10')
  assert.equal(entry.hasOlder, true)
  assert.equal(entry.hasNewer, true)
  assert.equal(entry.contiguous, 10) // not advanced by a racing live event
})


test('a racing live message cannot hide behind a stale final newer-page hasMore=false', () => {
  const Cache = history(), cache = new Cache(2, 3), entry = cache.activate('room')
  cache.initialize(entry, { messages: [7, 8, 9].map(n => message(n)), hasMore: true })
  cache.page(entry, { messages: [5, 6].map(n => message(n)), hasMore: true }, 'older')
  cache.merge(entry, [message(10)])
  cache.page(entry, { messages: [8, 9].map(n => message(n)), hasMore: false }, 'newer')
  assert.equal(entry.hasNewer, true)
  cache.page(entry, { messages: [message(10)], hasMore: false }, 'newer')
  assert.equal(entry.hasNewer, false)
  assert.equal(entry.messages.at(-1).seq, 10)
})

test('LRU eviction forgets initialized and contiguous cursors; late HTTP cannot revive the entry', () => {
  const Cache = history(), cache = new Cache(2, 4), first = cache.activate('a')
  cache.initialize(first, { messages: [message(40, 'a')], hasMore: true, changeCursor: { generation: 'a', revision: 10 } })
  cache.activate('b'); cache.activate('c')
  const fresh = cache.activate('a')
  assert.notEqual(fresh, first)
  assert.equal(first.controller.signal.aborted, true)
  assert.equal(fresh.initialized, false)
  assert.equal(fresh.contiguous, 0)
  assert.equal(fresh.changeCursor, undefined)
  cache.initialize(first, { messages: [message(99, 'a')], hasMore: false })
  assert.equal(fresh.messages.length, 0)
  assert.equal(cache.entries.size, 2)
})

test('stale initial and older HTTP responses never overwrite acknowledged sync baselines', () => {
  const Cache = history(), cache = new Cache(), entry = cache.activate('room')
  cache.initialize(entry, { messages: [message(15)], hasMore: true, changeCursor: { generation: 'a', revision: 1 } })
  cache.confirm(entry, { generation: 'a', revision: 4 }, 20)
  cache.initialize(entry, { messages: [message(15)], hasMore: true, changeCursor: { generation: 'a', revision: 1 } })
  cache.page(entry, { messages: [message(14)], hasMore: true, changeCursor: { generation: 'a', revision: 2 } }, 'older')
  assert.equal(entry.changeCursor.revision, 4)
  assert.equal(entry.contiguous, 20)
})

test('late pages cannot resurrect deleted content, and tombstone metadata is bounded', () => {
  const Cache = history(), cache = new Cache(2, 3), entry = cache.activate('room')
  cache.initialize(entry, { messages: [message(9)], hasMore: true })
  cache.tombstone(entry, 'room-8') // HTTP response was captured before this event
  cache.page(entry, { messages: [message(8)], hasMore: true }, 'older')
  assert.equal(entry.messages[0].text, '')
  assert.equal(entry.messages[0].attachment, null)
  assert.ok(entry.messages[0].deletedAt)
  for (let seq = 1; seq <= 10; seq++) cache.tombstone(entry, `room-${seq}`)
  assert.equal(cache.current(entry), false) // overflow invalidates all pending responses, never forgets silently
  assert.equal(cache.activate('room').initialized, false)
})

test('valid cursor reconnect applies missed old deletions without scanning cached history', async () => {
  const Cache = history(), cache = new Cache(), entry = cache.activate('room'), sync = synchronizer()
  cache.initialize(entry, { messages: [message(1), message(2)], hasMore: false, changeCursor: { generation: 'a', revision: 0 } })
  let scans = 0, after
  await sync(cache, entry, {
    subscribe: async (cursor, seq) => { after = seq; assert.equal(cursor.revision, 0); return { messages: [message(3)], hasMore: false, changeCursor: { generation: 'a', revision: 1 }, changes: { resetRequired: false, deletions: [{ roomId: 'room', messageId: 'room-1', seq: 1 }] } } },
    forward: async () => { throw new Error('unexpected backfill') },
    refresh: async () => { scans++ }, current: () => true, changed: () => {}
  })
  assert.equal(scans, 0)
  assert.equal(after, 2)
  assert.equal(entry.messages[0].text, '')
  assert.equal(entry.contiguous, 3)
  assert.equal(entry.changeCursor.revision, 1)
})

test('restart fallback fences its scan with another journal delta, including deletion during scan', async () => {
  const Cache = history(), cache = new Cache(), entry = cache.activate('room'), sync = synchronizer(), Journal = journal(), log = new Journal(2, 'new')
  cache.initialize(entry, { messages: [message(1), message(2)], hasMore: false, changeCursor: { generation: 'old', revision: 10 } })
  let scans = 0, subscriptions = 0
  await sync(cache, entry, {
    subscribe: async cursor => { subscriptions++; return { messages: [], hasMore: false, changeCursor: log.cursor(), changes: cursor ? log.changes('room', cursor) : undefined } },
    forward: async () => { throw new Error('unexpected backfill') },
    refresh: async () => { scans++; log.record({ roomId: 'room', messageId: 'room-1', seq: 1 }); cache.merge(entry, [message(1), message(2)]) },
    current: () => true, changed: () => {}
  })
  assert.equal(scans, 1)
  assert.equal(subscriptions, 2)
  assert.equal(entry.messages[0].text, '')
  assert.equal(entry.changeCursor.generation, 'new')
  assert.equal(entry.changeCursor.revision, 1)
})

test('overflow fallback refreshes every cached deletion instead of accepting the retained tail', async () => {
  const Cache = history(), cache = new Cache(), entry = cache.activate('room'), sync = synchronizer(), Journal = journal(), log = new Journal(2, 'a')
  cache.initialize(entry, { messages: [1, 2, 3].map(n => message(n)), hasMore: false, changeCursor: log.cursor() })
  for (let seq = 1; seq <= 3; seq++) log.record({ roomId: 'room', messageId: `room-${seq}`, seq })
  let scans = 0
  await sync(cache, entry, {
    subscribe: async cursor => ({ messages: [], hasMore: false, changeCursor: log.cursor(), changes: log.changes('room', cursor) }),
    forward: async () => { throw new Error('unexpected backfill') },
    refresh: async () => { scans++; cache.merge(entry, [1, 2, 3].map(n => ({ ...message(n), text: '', attachment: null, deletedAt: '2026-11-01T00:00:00Z' }))) },
    current: () => true, changed: () => {}
  })
  assert.equal(scans, 1)
  assert.equal(entry.messages.filter(m => m.deletedAt && !m.text && !m.attachment).length, 3)
  assert.equal(entry.changeCursor.revision, 3)
})

test('interrupted sync and racing live events never acknowledge unseen sequence gaps', async () => {
  const Cache = history(), cache = new Cache(), entry = cache.activate('room'), sync = synchronizer()
  cache.merge(entry, [message(10)])
  cache.initialize(entry, { messages: [message(5)], hasMore: true, changeCursor: { generation: 'a', revision: 0 } })
  assert.equal(entry.contiguous, 5)
  let current = true
  await sync(cache, entry, {
    subscribe: async () => ({ messages: [message(6)], hasMore: true, changeCursor: { generation: 'a', revision: 2 }, changes: { resetRequired: false, deletions: [] } }),
    forward: async seq => { assert.equal(seq, 6); current = false; return { messages: [message(7)], hasMore: false } },
    refresh: async () => { throw new Error('unexpected scan') }, current: () => current, changed: () => {}
  })
  assert.equal(entry.contiguous, 5)
  assert.equal(entry.changeCursor.revision, 0)
})

test('oversized replay evicts safely and publishes invalidation instead of leaving stale UI', async () => {
  const Cache = history(), cache = new Cache(2, 2), entry = cache.activate('room'), sync = synchronizer()
  cache.initialize(entry, { messages: [message(1)], hasMore: false, changeCursor: { generation: 'a', revision: 0 } })
  let publications = 0
  await sync(cache, entry, {
    subscribe: async () => ({ messages: [], hasMore: false, changeCursor: { generation: 'a', revision: 8 }, changes: { resetRequired: false, deletions: Array.from({ length: 8 }, (_, i) => ({ roomId: 'room', messageId: `room-${i}`, seq: i })) } }),
    forward: async () => { throw new Error('unexpected HTTP') }, refresh: async () => {}, current: () => true, changed: () => { publications++ }
  })
  assert.equal(cache.current(entry), false)
  assert.ok(publications > 0)
})

test('timeline containment and scroll-position storage are explicitly bounded', () => {
  const chat = source('apps/web/src/Chat.tsx')
  const prefix = stripTypeScriptTypes(chat.split('export function Chat')[0], { mode: 'strip' }).replace(/^import .*$/gm, '').replace(/\bexport /g, '')
  const { rememberPosition, positions } = runInNewContext(`${prefix}\n({ rememberPosition, positions })`, { MAX_CACHED_ROOMS: 8 })
  for (let i = 0; i < 20; i++) rememberPosition(`room-${i}`, { top: i, bottom: false })
  assert.equal(positions.size, 8)
  assert.equal(positions.has('room-0'), false)
  assert.match(chat, /contentVisibility: 'auto'/)
  assert.match(chat, /containIntrinsicSize: 'auto 120px'/)
  assert.match(chat, /state\.loadNewer/)
  assert.match(chat, /open=\{visible && !!deleting\}/)
})

test('overflow and restart force authoritative fallback, not partial tombstones', () => {
  const Journal = journal(), log = new Journal(2, 'a'), before = log.cursor()
  for (let seq = 1; seq <= 3; seq++) log.record({ roomId: 'room', messageId: `m${seq}`, seq })
  assert.equal(log.changes('room', before).resetRequired, true)
  assert.equal(log.changes('room', { generation: 'a', revision: 1 }).deletions.length, 2)
  assert.equal(new Journal(2, 'b').changes('room', log.cursor()).resetRequired, true)
  assert.equal(log.changes('room', { generation: 'a', revision: 4 }).resetRequired, true)
  assert.equal(log.changes('room', { generation: 'a', revision: 1.5 }).resetRequired, true)
})

function roomsClass() {
  const text = source('apps/server/src/rooms.ts').replace('constructor(readonly db: PrismaClient, readonly now = () => Date.now()) {}', 'constructor(db, now = () => Date.now()) { this.db = db; this.now = now }')
  const plain = stripTypeScriptTypes(text, { mode: 'strip' }).replace(/^import .*$/gm, '').replace(/\bexport /g, '')
  return runInNewContext(`${plain}\nRooms`, { ChangeJournal: journal(), Date, DEFAULT_MESSAGE_PAGE_SIZE: 15, MAX_MESSAGE_PAGE_SIZE: 20, fail: (status, code) => { throw new Error(`${status}:${code}`) } })
}
test('Rooms journals only after transaction commit; rollback emits no revision', async () => {
  const Rooms = roomsClass()
  let commit, reject, transactionDone = false
  const db = {
    membership: { findUnique: async () => ({ active: true, role: 'owner' }) },
    message: { findUnique: async () => ({ id: 'm', roomId: 'room', seq: 1, userId: 'u', deletedAt: null }), update: async () => {} },
    $transaction: async fn => { const result = await fn(db); await new Promise((resolve, fail) => { commit = resolve; reject = fail }); transactionDone = true; return result }
  }
  const rooms = new Rooms(db), before = rooms.changes.cursor()
  const pending = rooms.deleteMessage('m', 'u')
  while (!commit) await new Promise(resolve => setImmediate(resolve))
  assert.equal(rooms.changes.cursor().revision, before.revision)
  commit(); await pending
  assert.equal(transactionDone, true)
  assert.equal(rooms.changes.changes('room', before).deletions.length, 1)
  commit = undefined
  const rollback = rooms.deleteMessage('m', 'u')
  while (!commit) await new Promise(resolve => setImmediate(resolve))
  reject(new Error('rollback'))
  await assert.rejects(rollback, /rollback/)
  assert.equal(rooms.changes.cursor().revision, before.revision + 1)
})

test('monotonic deletion cursor discovers two deletes in the same millisecond', () => {
  const Journal = journal(), log = new Journal(4, 'server-a')
  const before = log.cursor()
  log.record({ roomId: 'room', messageId: 'old', seq: 1 })
  const middle = log.cursor()
  log.record({ roomId: 'room', messageId: 'new', seq: 2 })
  assert.equal(log.changes('room', before).deletions.length, 2)
  assert.equal(log.changes('room', middle).deletions[0].messageId, 'new')
  assert.equal(log.cursor().revision, 2)
  assert.equal(log.changes('other', before).deletions.length, 0)
})

test('late POST acknowledgements clear the outbox without reviving an evicted room', async () => {
  let finish
  const api = Object.assign(async (path, method) => {
    if (method === 'POST') return new Promise(resolve => { finish = resolve })
    return { messages: [message(200)], hasMore: true, changeCursor: { generation: 'a', revision: 1 } }
  }, { ownerId: 'u', isCurrent: () => true })
  const h = hookHarness(api); h.render(); await h.flush()
  h.value.send('pending'); await h.flush()
  const pending = h.value.outbox[0]
  for (let i = 0; i < 8; i++) await h.room(`r${i}`)
  await h.room('room')
  const replacement = h.value.history.peek('room')
  finish({ ...message(101), clientMessageId: pending.input.clientMessageId })
  await h.flush()
  assert.equal(h.value.outbox.length, 0, 'transport acknowledgement still removes the persisted outbox item')
  assert.equal(replacement.messages.map(m => m.seq).join(), '200', 'a pre-eviction POST must not inject content behind the replacement deletion cursor')
  assert.equal(replacement.changeCursor.revision, 1)
})

test('POST acknowledgements before initialization do not establish unvalidated history', async () => {
  let initial, posted
  const api = Object.assign((path, method) => new Promise(resolve => { if (method === 'POST') posted = resolve; else initial = resolve }), { ownerId: 'u', isCurrent: () => true })
  const h = hookHarness(api); h.render(); h.value.send('pending'); await h.flush()
  const pending = h.value.outbox[0]
  posted({ ...message(5), clientMessageId: pending.input.clientMessageId }); await h.flush()
  assert.equal(h.value.outbox.length, 0)
  assert.equal(h.value.history.peek('room').messages.length, 0)
  initial({ messages: [message(20)], hasMore: true, changeCursor: { generation: 'a', revision: 1 } }); await h.flush()
  assert.equal(h.value.history.peek('room').messages.map(m => m.seq).join(), '20')
})

for (const settleDuringScan of [true, false]) test(`fallback fences stale older-page publication ${settleDuringScan ? 'during' : 'after'} recovery`, async () => {
  let older, scan, pageReads = 0, subscriptions = 0
  const cached = Array.from({ length: 15 }, (_, i) => message(i + 10))
  const api = Object.assign(async path => {
    if (path.includes('beforeSeq')) { pageReads++; return new Promise(resolve => { older = resolve }) }
    if (path.includes('afterSeq')) return new Promise(resolve => { scan = resolve })
    return { messages: cached, hasMore: true, changeCursor: { generation: 'a', revision: 0 } }
  }, { ownerId: 'u', isCurrent: () => true })
  const h = hookHarness(api); h.render(); await h.flush()
  const entry = h.value.history.peek('room')
  const pendingOlder = h.value.loadOlder()
  const sync = synchronizer()(h.value.history, entry, {
    subscribe: async () => ({ messages: [], hasMore: false, changeCursor: { generation: 'a', revision: 3000 }, changes: { resetRequired: ++subscriptions === 1, deletions: [] } }),
    forward: async () => { throw new Error('unexpected forward') }, refresh: () => h.value.refreshCached('room', entry), current: () => true, changed: () => {}
  })
  await h.flush()
  assert.equal(typeof scan, 'function', 'fallback is paused inside the real hook scan')
  // A row captured before deletion must not enter a window whose captured scan starts at 10.
  if (settleDuringScan) { older({ messages: [message(9)], hasMore: true }); await pendingOlder }
  const duringRecovery = h.value.loadOlder()
  assert.equal(pageReads, 1, 'manual pages cannot start inside a fallback scan')
  await duringRecovery
  scan({ messages: cached, hasMore: false }); await sync
  if (!settleDuringScan) { older({ messages: [message(9)], hasMore: true }); await pendingOlder }
  assert.equal(entry.messages.some(m => m.seq === 9 && !m.deletedAt), false, 'pre-baseline deleted content must never survive scan acknowledgement')
  assert.equal(entry.changeCursor.revision, 3000)
  assert.equal(entry.paging, false)
  const freshPage = h.value.loadOlder()
  assert.equal(pageReads, 2, 'paging resumes after recovery')
  older({ messages: [{ ...message(9), text: '', attachment: null, deletedAt: 'deleted' }], hasMore: false }); await freshPage
  assert.equal(entry.messages[0].deletedAt, 'deleted')
})

test('initial baseline discards speculative old content and recovers newer live rows contiguously', async () => {
  let initial
  const api = Object.assign(() => new Promise(resolve => { initial = resolve }), { ownerId: 'u', isCurrent: () => true })
  const h = hookHarness(api); h.render()
  h.value.merge('room', [message(5), message(23)])
  h.value.tombstone('room-6', 'room')
  // The initial page was captured after a missed deletion of 5, before live 23.
  initial({ messages: Array.from({ length: 15 }, (_, i) => message(i + 6)), hasMore: true, changeCursor: { generation: 'a', revision: 1 } })
  await h.flush()
  const entry = h.value.history.peek('room')
  assert.equal(entry.messages.map(m => m.seq).join(), Array.from({ length: 15 }, (_, i) => i + 6).join(), 'only authoritative initial rows may inherit the page deletion cursor')
  assert.equal(entry.messages[0].text, '', 'applicable live tombstones survive initialization')
  assert.equal(entry.messages[0].attachment, null)
  assert.equal(entry.contiguous, 20)
  let forwards = 0
  await synchronizer()(h.value.history, entry, {
    subscribe: async (cursor, afterSeq) => {
      assert.equal(cursor.revision, 1); assert.equal(afterSeq, 20)
      // Another newer event must not advance the contiguous backfill position.
      h.value.merge('room', [message(24)])
      return { messages: [message(21), message(22)], hasMore: true, changeCursor: { generation: 'a', revision: 2 }, changes: { resetRequired: false, deletions: [] } }
    },
    forward: async afterSeq => { forwards++; assert.equal(afterSeq, 22); return { messages: [message(23), message(24)], hasMore: false } },
    refresh: async () => { throw new Error('unexpected full refresh') }, current: () => true, changed: () => {}
  })
  assert.equal(forwards, 1)
  assert.equal(entry.messages.filter(m => m.seq >= 21).map(m => m.seq).join(), '21,22,23,24')
  assert.equal(entry.messages.some(m => m.seq === 5), false)
  assert.equal(entry.contiguous, 24)
  assert.equal(entry.changeCursor.revision, 2)
})

test('fallback publication generation also fences pending POST acknowledgements', async () => {
  let posted
  const api = Object.assign(async (path, method) => {
    if (method === 'POST') return new Promise(resolve => { posted = resolve })
    return { messages: [message(20)], hasMore: true, changeCursor: { generation: 'a', revision: 0 } }
  }, { ownerId: 'u', isCurrent: () => true })
  const h = hookHarness(api); h.render(); await h.flush()
  h.value.send('pending'); await h.flush()
  const pending = h.value.outbox[0], entry = h.value.history.peek('room')
  await h.value.refreshCached('room', entry)
  posted({ ...message(9), clientMessageId: pending.input.clientMessageId }); await h.flush()
  assert.equal(entry.messages.map(m => m.seq).join(), '20')
  assert.equal(h.value.outbox.length, 0)
})

test('stale pre-reset page errors and cleanup cannot clear a fresh paging operation', async () => {
  const pages = []
  const api = Object.assign(async path => {
    if (path.includes('beforeSeq')) return new Promise((resolve, reject) => { pages.push({ resolve, reject }) })
    return { messages: [message(20)], hasMore: true, changeCursor: { generation: 'a', revision: 0 } }
  }, { ownerId: 'u', isCurrent: () => true })
  const h = hookHarness(api); h.render(); await h.flush()
  const entry = h.value.history.peek('room'), oldPage = h.value.loadOlder()
  await h.value.refreshCached('room', entry)
  const newPage = h.value.loadOlder()
  assert.equal(entry.paging, true)
  pages[0].reject(new Error('obsolete page error')); await oldPage
  assert.equal(entry.paging, true)
  assert.equal(entry.error, '')
  pages[1].resolve({ messages: [message(19)], hasMore: false }); await newPage
  assert.equal(entry.paging, false)
  assert.equal(entry.messages[0].seq, 19)
})

test('failed fallback releases its page fence without acknowledging an incomplete scan', async () => {
  let scan, reads = 0
  const api = Object.assign(async path => {
    if (path.includes('afterSeq')) return new Promise((resolve, reject) => { scan = { resolve, reject } })
    reads++; return { messages: [message(20)], hasMore: true, changeCursor: { generation: 'a', revision: 0 } }
  }, { ownerId: 'u', isCurrent: () => true })
  const h = hookHarness(api); h.render(); await h.flush()
  const entry = h.value.history.peek('room')
  const transport = {
    subscribe: async () => ({ messages: [], hasMore: false, changeCursor: { generation: 'a', revision: 3000 }, changes: { resetRequired: true, deletions: [] } }),
    forward: async () => { throw new Error('unexpected forward') }, refresh: () => h.value.refreshCached('room', entry), current: () => true, changed: () => {}
  }
  const pending = synchronizer()(h.value.history, entry, transport)
  await h.flush()
  await assert.rejects(h.value.refreshCached('room', entry), /历史恢复进行中/)
  scan.reject(new Error('scan unavailable'))
  await assert.rejects(pending, /scan unavailable/)
  assert.equal(entry.changeCursor.revision, 0)
  assert.equal(entry.contiguous, 20)
  assert.equal(entry.recovering, false)
  await h.value.loadOlder()
  assert.equal(reads, 2, 'paging is not stuck after a rejected scan')
})
