import type { ChangeCursor, Message, MessagePage } from '@anyone-im/contracts'

export const MAX_CACHED_ROOMS = 8
export const MAX_CACHED_MESSAGES = 300

interface HistoryTransport {
  subscribe: (cursor: ChangeCursor | undefined, afterSeq: number) => Promise<MessagePage>
  forward: (afterSeq: number) => Promise<MessagePage>
  refresh: () => Promise<void>
  current: () => boolean
  changed: () => void
}
// Only subscribe acknowledgements advance deletion cursors; later HTTP page metadata never does.
export async function synchronizeHistory(cache: HistoryCache, entry: HistoryEntry, transport: HistoryTransport) {
  const current = () => transport.current() && cache.current(entry)
  if (!current() || !entry.initialized) return
  let cursor = entry.contiguous
  let page = await transport.subscribe(entry.changeCursor, cursor)
  if (!current()) return
  for (let attempts = 0; page.changes?.resetRequired || !page.changes; attempts++) {
    if (attempts >= 3) throw new Error('历史变更过多，请重试同步')
    // Establish a journal point BEFORE scanning: a final delta catches mid-scan deletions.
    const baseline = page.changeCursor
    await transport.refresh()
    if (!current()) return
    if (!baseline) break // Legacy server: bounded full refresh on each subscribe.
    page = await transport.subscribe(baseline, cursor)
    if (!current()) return
  }
  for (const deletion of page.changes?.deletions ?? []) {
    if (deletion.roomId === entry.roomId) cache.tombstone(entry, deletion.messageId)
  }
  transport.changed() // Also publish bounded tombstone overflow invalidation.
  const acknowledged = page.changeCursor
  while (current()) {
    cache.merge(entry, page.messages)
    transport.changed()
    const next = page.messages.at(-1)?.seq ?? cursor
    if (!page.hasMore) {
      cache.confirm(entry, acknowledged, Math.max(cursor, next))
      transport.changed()
      return
    }
    if (next <= cursor) throw new Error('历史分页未前进，请重试同步')
    cursor = next
    page = await transport.forward(cursor)
  }
}
export interface HistoryEntry {
  roomId: string
  messages: Message[]
  initialized: boolean
  contiguous: number
  newestSeen: number
  changeCursor?: ChangeCursor
  hasOlder: boolean
  hasNewer: boolean
  loading: boolean
  paging: boolean
  pageGeneration: number
  recovering: boolean
  error: string
  tombstones: Set<string>
  controller: AbortController
}

// A bounded bidirectional window, not an ever-growing transcript.
export class HistoryCache {
  readonly entries = new Map<string, HistoryEntry>()
  private active = ''
  readonly maxRooms: number
  readonly maxMessages: number
  constructor(maxRooms = MAX_CACHED_ROOMS, maxMessages = MAX_CACHED_MESSAGES) {
    if (!Number.isSafeInteger(maxRooms) || maxRooms < 1 || !Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new Error('Invalid history bounds')
    this.maxRooms = maxRooms; this.maxMessages = maxMessages
  }
  peek(roomId: string) { return this.entries.get(roomId) }
  current(entry: HistoryEntry) { return this.peek(entry.roomId) === entry }
  activate(roomId: string): HistoryEntry {
    this.active = roomId
    let entry = this.entries.get(roomId)
    if (!entry) entry = { roomId, messages: [], initialized: false, contiguous: 0, newestSeen: 0, hasOlder: false, hasNewer: false, loading: false, paging: false, pageGeneration: 0, recovering: false, error: '', tombstones: new Set(), controller: new AbortController() }
    this.entries.delete(roomId); this.entries.set(roomId, entry)
    while (this.entries.size > this.maxRooms) {
      const oldest = [...this.entries.keys()].find(id => id !== this.active)!
      this.drop(oldest)
    }
    return entry
  }
  drop(roomId: string) { this.peek(roomId)?.controller.abort(); this.entries.delete(roomId) }
  suspend() {
    // Preserve history/cursors but invalidate pre-hold request identities and pending work.
    for (const [id, entry] of this.entries) {
      entry.controller.abort()
      this.entries.set(id, { ...entry, controller: new AbortController(), loading: false, paging: false, recovering: false })
    }
  }
  confirm(entry: HistoryEntry, cursor: ChangeCursor | undefined, contiguous: number) {
    if (!this.current(entry)) return
    entry.changeCursor = cursor
    entry.contiguous = Math.max(entry.contiguous, contiguous)
  }
  tombstone(entry: HistoryEntry, messageId: string) {
    if (!this.current(entry)) return
    entry.tombstones.add(messageId)
    if (entry.tombstones.size > this.maxMessages * 2) { this.drop(entry.roomId); return }
    entry.messages = entry.messages.map(message => message.id === messageId ? { ...message, text: '', attachment: null, deletedAt: message.deletedAt || new Date().toISOString() } : message)
  }
  initialize(entry: HistoryEntry, page: MessagePage) {
    if (!this.current(entry) || entry.initialized) return
    // Speculative live/POST rows were not validated at this deletion cursor.
    // Keep tombstones, but recover newer events from the page's contiguous end.
    entry.messages = []
    entry.hasOlder = page.hasMore
    entry.hasNewer = false
    this.merge(entry, page.messages)
    entry.contiguous = page.messages.at(-1)?.seq ?? 0
    entry.changeCursor = page.changeCursor
    entry.initialized = true
  }
  merge(entry: HistoryEntry, incoming: Message[], direction: 'older' | 'newer' | 'live' = 'live') {
    if (!this.current(entry)) return
    const bySeq = new Map(entry.messages.map(message => [message.seq, message]))
    const end = entry.messages.at(-1)?.seq ?? 0
    for (let message of incoming) {
      if (message.roomId !== entry.roomId) continue
      entry.newestSeen = Math.max(entry.newestSeen, message.seq)
      if (direction === 'live' && entry.hasNewer && message.seq > end) continue
      const old = bySeq.get(message.seq)
      if (old?.deletedAt && !message.deletedAt) message = old
      if (entry.tombstones.has(message.id)) message = { ...message, text: '', attachment: null, deletedAt: message.deletedAt || new Date().toISOString() }
      bySeq.set(message.seq, message)
    }
    const messages = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    if (messages.length > this.maxMessages) {
      if (direction === 'older') { entry.hasNewer = true; entry.messages = messages.slice(0, this.maxMessages) }
      else { entry.hasOlder = true; entry.messages = messages.slice(-this.maxMessages) }
    } else entry.messages = messages
  }
  page(entry: HistoryEntry, page: MessagePage, direction: 'older' | 'newer') {
    if (!this.current(entry)) return
    this.merge(entry, page.messages, direction)
    if (direction === 'older') entry.hasOlder = page.hasMore
    else entry.hasNewer = page.hasMore || entry.newestSeen > (entry.messages.at(-1)?.seq ?? 0)
    // HTTP paging is not a deletion-log acknowledgement or contiguous sync baseline.
  }
}
