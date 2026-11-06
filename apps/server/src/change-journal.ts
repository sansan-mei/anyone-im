import { randomUUID } from 'node:crypto'
import type { ChangeCursor, MessageDeletion, MessageChanges } from '@anyone-im/contracts'

// One application process owns the write gate and this journal. Not a durable log.
export class ChangeJournal {
  private revision = 0
  private entries: (MessageDeletion & { revision: number })[] = []
  readonly capacity: number
  readonly generation: string
  constructor(capacity = 2048, generation: string = randomUUID()) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid journal capacity')
    this.capacity = capacity
    this.generation = generation
  }
  cursor(): ChangeCursor { return { generation: this.generation, revision: this.revision } }
  record(deletion: MessageDeletion) {
    this.entries.push({ ...deletion, revision: ++this.revision })
    if (this.entries.length > this.capacity) this.entries.shift()
  }
  changes(roomId: string, cursor: ChangeCursor): MessageChanges {
    const floor = this.entries[0] ? this.entries[0].revision - 1 : this.revision
    if (cursor.generation !== this.generation || !Number.isSafeInteger(cursor.revision) || cursor.revision < floor || cursor.revision > this.revision) return { resetRequired: true, deletions: [] }
    return { resetRequired: false, deletions: this.entries.filter(entry => entry.revision > cursor.revision && entry.roomId === roomId).map(({ revision: _revision, ...entry }) => entry) }
  }
}
