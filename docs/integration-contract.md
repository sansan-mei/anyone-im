# Relay IM v1 integration contract (frozen for parallel implementation)

Root owns this document and packages/contracts. API responses use `{data:T}` or HTTP error `{error:{code,message}}`. Shared interfaces in `@relay-im/contracts` are canonical. All date fields are ISO strings. IDs opaque strings; client message IDs UUID. Session cookie `relay_session` is opaque, HttpOnly, SameSite=Lax, Secure in production; never put it in URLs/localStorage.

## Deployment / storage

- Production listener PORT=4100, configurable, HOST=127.0.0.1 locally /0.0.0.0 in container. Frontend dev 4101; parent integration test listener 4190, dev Vite proxy `/api` and `/socket.io` to 4100.
- Production: Prisma 6.19.3 + MySQL with independent schema/account. Development/test: SQLite through an equivalent Prisma schema. Select DB_PROVIDER=sqlite (default local) or mysql, DATABASE_URL. Parent CI verifies actual MySQL; NEVER connect to existing host MySQL/Redis. Two Prisma schemas/generators are acceptable; generated client must have a predictable runtime import. Expose scripts db:generate, db:push, typecheck, build, dev, test. Parent owns root lockfile and installation coordination.
- Data and uploads in configurable DATA_DIR (default `.data`); tests always isolated scratch directories. Production image must generate the mysql client; MySQL initialization documented and explicit, no destructive automatic reset.
- Application factory `createApplication(options)` (or similarly documented export) supports loopback port0 and clean shutdown for parent real E2E; entry index.ts starts actual runtime and serves built apps/web/dist. No production service startup as module import side effect.

## Authenticated request precondition

All authenticated mutation routes (including logout, uploads and read cursors) require `X-Anyone-User-Id` captured from the action owner's authenticated UI context. A missing header returns HTTP `428`; a mismatch with the user resolved from the current opaque cookie returns HTTP `409`, `SESSION_CHANGED`. The header is never an authority credential: server cookie/session/membership checks remain mandatory. If this header is supplied on authenticated reads it is also compared, preventing stale-tab cache mixing. Session bootstrap and guest/register/login are excluded. Frontend must never rebind an old pending action to a newly observed user, and must invalidate stale workspaces across tabs/on focus. Browser Socket.IO handshakes similarly send the captured `expectedUserId` query field; a supplied mismatch is rejected with `SESSION_CHANGED`, not authenticated as the replacement cookie user.

## HTTP routes

- GET /healthz -> `{data:{status:'ok',version:1}}`; GET /readyz -> DB check result.
- GET /api/session -> SessionData (user null if unauthenticated, not401).
- POST /api/auth/guest {displayName} -> SessionData; create/reuse server-owned guest identity, auto-member public lobby.
- POST /api/auth/register {username,password,displayName} -> SessionData.
- POST /api/auth/login {username,password} -> SessionData.
- POST /api/auth/logout {} -> `{data:null}`; invalidate session, disconnect sockets tied to that session.
- PATCH /api/me {displayName} -> `{data:User}`.
- GET /api/rooms -> `{data:{rooms:RoomSummary[]}}` member rooms only, with unread positions and last message.
- GET /api/rooms/public -> `{data:{rooms:RoomSummary[]}}` joinable public rooms, no private-room leakage. For non-member public previews role may be member and lastReadSeq0; no message/history content exposed until joined.
- POST /api/rooms CreateRoomInput -> `{data:RoomSummary}` owner membership.
- POST /api/rooms/:id/join {} -> `{data:RoomSummary}` public rooms only. Private uses invite.
- POST /api/rooms/:id/leave {} -> `{data:null}`; nonowner only, revoke membership and all user's socket room subscriptions.
- GET /api/rooms/:id/messages?beforeSeq=N&afterSeq=N&limit=N -> MessagePage, messages ascending, limit default50 max100, exclusive cursors, reject both cursors together.
- POST /api/rooms/:id/messages SendMessageInput -> `{data:Message}`; persist transactionally before ack/broadcast, unique(room,user,clientMessageId), stable per-room increasing seq; same clientMessageId cannot be used to substitute different payload/attachment.
- PATCH /api/rooms/:id/read {seq} -> `{data:null}`, monotonic bounded by room.lastSeq.
- GET /api/rooms/:id/members -> `{data:{members:Member[]}}` current members only.
- POST /api/rooms/:id/invites {} -> `{data:Invite}` owner only, strong random bearer invite expires24h, store hash only, urlPath `/invite/<code>`.
- DELETE /api/rooms/:id/invites -> `{data:{revoked:number}}` owner only, revoke all.
- GET /api/invites/:code -> `{data:InvitePreview}` valid preview, no messages.
- POST /api/invites/:code {} -> `{data:RoomSummary}` authenticated session, join; refuse banned/kicked members.
- DELETE /api/rooms/:id/members/:userId -> `{data:null}` owner only, never kick owner; durable removal/ban so stale invite cannot rejoin.
- DELETE /api/messages/:messageId -> `{data:null}` sender or roomowner only; tombstone preserving seq, broadcast deletion.
- POST /api/rooms/:id/attachments multipart file -> `{data:Attachment}`; members only, PNG/JPEG/WebP, <=5MiB, verify magic bytes, disallow SVG/HTML, random disk key, no direct public upload path.
- GET /api/attachments/:id -> authorized byte response, room ACL, Content-Type and nosniff. Uploaded attachment may only be used by uploader in the same room. UI uses returned .url. Server retains attachment access policy for deleted messages (deny if no longer accessible).

## Socket.IO

Same origin `/socket.io/`, credentials/session cookie. Official @socket.io/bun-engine with Hono. Validate Origin at handshake and all mutating HTTP; rate limit auth/join/send/upload; strict Zod validation rejects client authority fields. Server derives user, timestamps, role. Max event payload bounded. No client name/sender spoofing.

Use typed ClientToServerEvents/ServerToClientEvents from contracts:
- message:send({roomId,...SendMessageInput}, ack Result<Message>) -> same domain operation as HTTP, no false ack/broadcast on DB error.
- room:subscribe({roomId,afterSeq?}, ack Result<MessagePage>) -> verify membership, subscribe and backfill (client paginates if hasMore). All authorized memberships may be joined at connect to receive unread sidebar updates.
- message:new Message; message:deleted {roomId,messageId,seq}; presence:update {roomId,count}; room:updated {roomId}; room:removed {roomId,reason}.
- Presence is unique user count, not tab count. Disconnect/leave/kick/logout clean up; kicked sessions cannot keep receiving data or send after revocation. Online events never include session tokens.
- Frontend re-fetches rooms and resubscribes/backfills after every reconnect; merge by id/seq, no blind append. HTTP initial reads + Socket events may race, must reconcile. Stable client message ID retained for retries. Read position updated only while conversation visible and at bottom. Persist pending messages safely or document refresh limitations; never silently discard failed sends.

## Frontend UX

Original Google/Material 3-inspired Operate surface, no Google logos/brand clone, no hero/cards/mock metrics. Name Anyone / Chinese UI. Blue/white surface system with purposeful blue accent, light/dark follows system with setting. Desktop two columns (rooms ~290px + conversation), details Radix dialog/sheet. Mobile separate list/conversation, sticky safe-area top/composer,44px hit targets, accessible dialog/focus/escape, IME Enter does not send during composition. Keep chat usable with virtual keyboard. No forced autoscroll while browsing history. Real empty/loading/error/offline/send-failed states.

Guest onboarding by displayName, optional username/password register/login. Room create/join public and invite URL flow, members/invite/kick/revoke controls forowner, leave nonowner, message delete, attachment picker/paste upload, send/retry, loadolder, unread badges, connected status. No fake seeded conversation/users. Public lobby seed has only real system metadata, not fabricated chat history. Parent provides real E2E and CI. Old-site SSO and historical import are explicitly deferred; no production DB access or old code changes.
