# History synchronization and bounded client windows

## Wire compatibility / no migration

The existing seven-table schema is unchanged. `GET /api/rooms/:id/messages`
keeps `beforeSeq`, `afterSeq`, `limit`, ascending response order and `hasMore`.
It optionally returns:

```ts
changeCursor: { generation: string; revision: number }
```

`room:subscribe` accepts the same optional `changeCursor`. Its normal
`MessagePage` acknowledgement additionally includes, **only when a cursor was
supplied**:

```ts
changes: { resetRequired: boolean; deletions: { roomId: string; messageId: string; seq: number }[] }
```

Old clients need not send or read these fields. New clients receiving legacy
pages without cursors use a bounded cached-window refresh. No new HTTP endpoint
or `app.ts` wiring is required.

## Server invariants

`Rooms` owns a single global journal of at most **2,048 deletion records**, not
a per-room map. Each application instance has a random generation and an
integer revision. Two deletions in one millisecond have different revisions;
wall-clock timestamps are never sync positions. Deletion is recorded **after
awaiting transaction commit**, before the surrounding application gate is
released. Rollback emits no journal record.

The existing application gate surrounds both HTTP pages/deletes and realtime
subscribe handlers. Page rows, the returned cursor, deletion replay and socket
subscription therefore describe one authoritative server point. A generation
mismatch (restart), expired journal position (global overflow), or impossible
revision returns `resetRequired: true` and **no partial deletion list**. Quiet
rooms may also need fallback when other rooms exhaust the global journal.

This is an optimization for the existing **single-process writer / gate**
architecture, not a durable distributed change feed. Multiple independent
writers sharing the database would require shared invalidation or a durable
change log. Restart intentionally forgets the optimization, not database
history. Attachment retention is not journaled: existing attachment expiry
metadata/deadlines still control image expiry.

## Client synchronization

A cache entry owns both its confirmed contiguous message sequence and its
acknowledged deletion cursor. A live message's highest sequence does **not**
replace the contiguous baseline. Unvisited rooms receiving live traffic do not
allocate history entries. Initial page metadata sets a baseline once; stale
initial/older HTTP responses cannot overwrite later sync acknowledgements.
Initialization replaces speculative pre-initialization rows with the authoritative
page alone, retaining applicable tombstones. A speculative highest live sequence
never becomes the contiguous baseline: subscribe/backfill starts at the page end
and recovers newer events (including intervening gaps), rather than trusting or
replaying speculative payloads behind the deletion cursor.

Send/retry captures the initialized entry identity and its page-publication
generation before POST. An acknowledgement can publish history only into that
same current entry/generation, outside a fallback scan. It cannot inject old
content into an evicted/revisited room or an uninitialized baseline. Matching
outbox acknowledgement/removal remains independent of history publication.

On switch/reconnect:

1. Load a cold room's newest 15-message page, or reuse its cache entry.
2. Subscribe with that entry's contiguous `afterSeq` and deletion cursor.
3. Apply missed tombstones and page forward for genuinely missed messages.
   Valid deletion cursors do **not** scan previously cached history.
4. Only acknowledge the subscribe cursor after successful contiguous backfill.
   Do not acknowledge later HTTP page cursors; they could skip old deletions.

Restart/overflow fallback captures a fresh subscribe cursor **before** scanning
the cached window, then subscribes again from that point. The final replay
catches deletions occurring during the scan. If the journal repeatedly expires
during recovery, three retries produce a visible sync error rather than
claiming consistency. The old baseline remains retryable. HTTP scans skip
sequence gaps and perform work bounded by the captured cached rows, not the
entire database transcript.

Before capturing cached rows, a fallback scan increments the entry's separate
page-publication generation and blocks new manual older/newer pages. Responses,
errors and cleanup from pre-scan pages are ignored, including responses settling
after recovery; a stale cleanup cannot clear a newer request's paging flag.
Pre-scan POST payloads are invalidated by the same generation. Thus no retained
pre-baseline row can be added behind the captured scan's oldest edge and silently
inherit its later deletion acknowledgement. Paging resumes after the scan, on
both success and failure; newly started server snapshots are at or after the
pre-scan baseline and are covered by the existing final deletion replay. Overlapping
scans fail visibly rather than sharing a scan captured before a newer baseline.
Failure never acknowledges an incomplete scan. Session hold clears the recovery
flag on the replacement identity so resume is not stuck behind abandoned work.

Live tombstones blank text and attachment metadata immediately, and are retained
in bounded per-entry sets so an already-in-flight HTTP page cannot resurrect
content. More than 600 distinct tombstone IDs invalidates that room entry and
cold-loads the active room; late responses to the evicted identity are ignored.
Large deletion replay can use this same safe cold reset. Cursor and initialized
state are never retained separately after eviction.

Session identity checks use the parent's optional `paused` integration:
realtime disconnects while paused and reconnects/reconciles on resume. Pending
history requests are aborted and their entry identities replaced without
discarding messages, paging flags or confirmed cursors. Resume therefore never
joins a pre-hold initial request, and stale socket errors cannot invalidate the
preserved session. Chat's delete portal follows its existing `visible` gate.

## Memory, paging and rendering

- At most **8 cached rooms**, LRU by room activation, including the active room.
- At most **300 messages per room window**; cached errors, loading flags,
  tombstones and cursors share that entry's lifetime.
- Eviction aborts that entry's HTTP requests and invalidates pending responses.
- Scroll restoration holds at most **8 positions**, including across accounts.
- Outbox persistence is intentionally separate; pending user-authored messages
  are not discarded by a transcript cache limit.

Loading older messages keeps the newly requested older rows, trimming the
opposite (newer) edge when necessary. The UI then exposes **加载更新消息** and
**回到最新消息**; users can page either direction or explicitly reset to the
newest page. New live traffic does not steal a backscroll window. `hasOlder`
continues to describe the actual oldest edge, including when newer paging
trims older rows. A separately tracked newest-observed sequence prevents a
racing stale `hasMore: false` response from hiding newer traffic.

Messages use `content-visibility: auto` and `contain-intrinsic-size: auto 120px`
for layout/paint containment, **not true DOM virtualization**. The cache window
bounds article count. Existing image sizing, anchor restoration and explicit
history controls remain; browser layout coverage belongs in Playwright/CI.

## Tests

Lightweight real-source tests (no DB, generated client, dependencies, build or
browser needed):

```sh
python /root/.hermes/cache/scratch/anyone-im-light-verify.py node --test scripts/history-sync.node.mjs
```

The guard is required on this constrained host; busy/low-memory results mean
defer, not bypass. CI can run `node --test scripts/*.node.mjs` with Node 24+.
The Node suite tests real helpers, real hooks with a minimal deterministic
scheduler, and `Rooms` with an isolated transaction boundary. It covers commit
vs rollback, same-tick deletion ordering, restart/overflow fallback, mid-scan
deletions, interrupted sync, stale HTTP responses, LRU/cursor invalidation,
bidirectional windows and racing live updates. Hook scheduling is not a proof
of concurrent React scheduling or browser layout.

Observed TDD failures included absent journal/cache/synchronizer APIs, an
unpublished overflow invalidation, a racing final newer page hiding live
traffic, ignored pause integration, and pre-hold work contaminating a resumed
cache. The original guarded Node suite contained 18 tests.

Independent review additionally reproduced three deleted-content resurrection
races. Real-source deterministic RED runs showed a pending POST inserting seq
101 into a replacement room ending at 200, a pre-reset older page retaining
deleted seq 9 outside a fallback scan of 10–24 (and allowing pages to start
during recovery), and initialization retaining speculative seq 5 alongside an
authoritative 6–20 page. Each of these three race reproductions was added and
observed failing before its corresponding fix. After the fixes, the guarded Node suite passed
**26 tests, 0 failures**: the original 18 plus eight regressions covering these
three races, cold POST acknowledgement, stale error/cleanup ownership, POST
publication across fallback, scan failure/re-entry and contiguous newer-event
recovery. Full semantic type checking, build, DB and browser/React concurrency
verification remain CI responsibilities; this local run did not install dependencies
or call production services.

Additional contract/server Bun tests, a browser mocked 345-message window/LRU
scenario, and a real-server no-rescan reconnect/deletion scenario are included
for the full Actions pipeline. No production requests or schema changes are
needed to exercise these tests.
