# anyone-im backend

Internal workspace name remains `@relay-im/server`; public protocol and cookie names remain frozen by `docs/integration-contract.md`.

## Parent integration / startup

From the repository root (Bun must be on PATH):

```sh
export DB_PROVIDER=sqlite
export DATA_DIR=/absolute/path/to/isolated-data
export DATABASE_URL="file:${DATA_DIR}/relay.sqlite"
export HOST=127.0.0.1 PORT=4190
export PUBLIC_ORIGIN=http://127.0.0.1:4190
export NODE_ENV=test
# Optional for many real browser accounts within one test minute:
export RATE_LIMIT_AUTH_MAX=100
bun run --filter @relay-im/server db:generate
bun run --filter @relay-im/server db:push
bun run apps/server/src/index.ts
```

`db:push` uses Prisma `db push --skip-generate`, without `--force-reset` or `--accept-data-loss`. It refuses destructive changes that need explicit operator action. No automatic schema mutation or process startup occurs on module import. `index.ts` starts only when `import.meta.main` is true; SIGTERM/SIGINT closes sockets, listener and Prisma before exit.

Scripts available within `apps/server` or via the workspace filter:

- `db:generate`: choose `prisma/${DB_PROVIDER}.prisma`, generate Prisma 6 client into **`apps/server/generated/client`**.
- `db:push`: push the selected schema; generate separately first.
- `dev`: Bun watch of `src/index.ts`.
- `start`: run `src/index.ts` with Bun.
- `typecheck`: TypeScript project check.
- `build`: bundle application into `dist/index.js`, leaving packages and the generated Prisma client external. Keep `generated/client` (including its native engine) alongside `dist`, and keep installed workspace dependencies. The bundle does not embed the build checkout's absolute Prisma path.
- `test`: isolated SQLite integration tests; generate the **sqlite** client before this suite. Tests do not connect to a configured external MySQL URL.

`database.ts` invokes the pinned local `node_modules/prisma/build/index.js` using `process.execPath` (Bun), not a Node shebang or unpinned `bunx` download. Prisma generate/push were exercised after the root `deepmerge-ts` security override.

### Production MySQL

Provision a **new independent database and restricted account**, outside this application's startup. Never point these commands at an existing site's schema. Supply its URL through secrets:

```sh
export DB_PROVIDER=mysql
export DATABASE_URL='mysql://NEW_ACCOUNT:URL_ENCODED_PASSWORD@NEW_DB_SERVICE:3306/NEW_DATABASE'
export DATA_DIR=/data
export HOST=0.0.0.0 PORT=4100
export NODE_ENV=production
export PUBLIC_ORIGIN=https://YOUR_IM_SUBDOMAIN
bun run --filter @relay-im/server db:generate
bun run --filter @relay-im/server db:push
bun run apps/server/src/index.ts
# Alternatively, after build: bun apps/server/dist/index.js
```

Both schemas share model names/relations/indexes and the exact same generated import path. MySQL uses appropriate text/filename column lengths. **Regenerate when switching provider**, and use separate workspaces/artifacts for concurrent providers. Native engine generation must happen on the target-compatible build platform. No MySQL daemon, Redis, Docker runtime or production database was accessed by backend development/tests; actual MySQL integration is the parent CI job's responsibility. The MySQL schema was validated without connecting to a database.

## Programmatic factory

```ts
import { createApplication } from './apps/server/src/app'

const application = await createApplication({
  host: '127.0.0.1',
  port: 0,
  databaseProvider: 'sqlite',
  databaseUrl: 'file:/absolute/scratch/test.sqlite',
  dataDir: '/absolute/scratch/data',
  webDist: '/absolute/path/to/apps/web/dist', // optional
  // origin: 'https://im.example.com',        // optional locally
  // production: true,
  // rateLimits: { AUTH: 100 },              // explicit per-factory overrides
  // bodyReadTimeoutMs: 30000,               // total input-read deadline, 1–300000 ms
})
console.log(application.url) // actual allocated loopback address
await application.close()  // idempotent; returns the same in-flight close promise
```

Factory options override corresponding environment variables. The factory connects to an existing database but does not push schema. It cleans resources if listener startup fails. `/healthz` is liveness; `/readyz` checks every required table and returns `503 {error:{code:'NOT_READY',message:...}}` if the schema/database is unavailable. Both successful health endpoints return `{data:{status:'ok',version:1}}`.

Environment:

| Variable | Default / behavior |
| --- | --- |
| `DB_PROVIDER` | `sqlite`; `mysql` requires explicit `DATABASE_URL` |
| `DATABASE_URL` | SQLite defaults to absolute `${DATA_DIR}/relay.sqlite`; use absolute `file:` URLs for reproducible paths |
| `DATA_DIR` | repository `.data`; uploads are private files under `uploads/` |
| `HOST`, `PORT` | `127.0.0.1`, `4100`; `port:0` supported in factory and environment |
| `PUBLIC_ORIGIN` | required in production; exact origin, no trailing slash; otherwise actual listener origin |
| `NODE_ENV` | runtime `production` enables Secure cookies; there is no test-mode security bypass |
| `WEB_DIST` | `apps/web/dist`, resolved independently of process cwd |
| `RATE_LIMIT_WINDOW_MS` | `60000`, range 100–3600000 |
| `RATE_LIMIT_AUTH_MAX` | `10` per direct peer IP / window |
| `RATE_LIMIT_SEND_MAX` | `60` per user / window, shared HTTP + Socket.IO |
| `RATE_LIMIT_JOIN_MAX` | `30` per session (HTTP join/invite) or user (socket subscribe) / window |
| `RATE_LIMIT_UPLOAD_MAX` | `10` per user / window |
| `RATE_LIMIT_SOCKET_MAX` | `30` handshake attempts per direct peer IP / window |
| `RATE_LIMIT_HTTP_MAX` | `300` API requests per direct peer IP / window |

Limits are positive integers, capped at 100000. `rateLimits` factory overrides use uppercase keys (`AUTH`, `SEND`, `JOIN`, `UPLOAD`, `SOCKET`, `HTTP`). Arbitrary forwarding headers are deliberately not trusted: behind a reverse proxy, IP limits apply to the proxy peer, so size limits/account controls at the edge remain important.

## Security and persistence behavior

- All frozen HTTP routes and typed Socket.IO events are implemented. Socket.IO uses official `@socket.io/bun-engine` with Hono and supports polling/websocket upgrade.
- Guest IDs are created by the server. An authenticated guest request reuses the existing identity; profile changes use `PATCH /api/me`. Username/password sessions rotate the current opaque token, invalidate its previous DB record, and disconnect its sockets.
- Tokens are 256-bit random values; only SHA-256 digests are stored. Cookie is HttpOnly, SameSite=Lax, Path=/, max-age 30 days, and Secure in production. Expired DB sessions are rejected. Argon2id password hashes use Bun's salted implementation (19 MiB memory, two iterations); unknown-user login still performs an Argon2 verification.
- Mutation Origin and Fetch-Metadata checks use the configured exact public origin. Native clients without Origin are supported; cross-origin browser requests are not allowed. Authentication is required at engine handshake, Socket.IO middleware, each event and each HTTP operation. Before broadcasts, recipient sessions and memberships are revalidated.
- Authenticated HTTP mutations, **including logout and uploads**, require `X-Anyone-User-Id` captured from the initiating UI/session: missing returns `428 PRECONDITION_REQUIRED`, mismatch with the database-authenticated cookie user returns `409 SESSION_CHANGED`. The header is a precondition, never authentication or authority. Authenticated GETs compare it when present but allow omission (including native image reads). `GET /api/session` bootstrap and guest/register/login are exempt; public invite previews remain public. Native API helpers must send the captured ID on mutations, not derive it afresh from a potentially changed shared cookie. Socket identity remains bound to its authenticated session.
- Strict contract validators reject client authority fields. JSON bodies are bounded at 16 KiB and socket events at 32 KiB. Empty-body operations accept only `{}` (or an omitted body), never identity/role fields. Public previews do not include nonmember message content.
- All client-controlled JSON/multipart body reads happen **outside** the application-wide mutation/ACL gate. The total read deadline defaults to **30000 ms**, is not reset by incoming bytes, and cancels the underlying reader with `408 REQUEST_TIMEOUT`; `bodyReadTimeoutMs` is an explicit factory-only override (integer 1–300000 ms), not a test-mode bypass. JSON routes authenticate under the gate after bounded input preparation; uploads check authentication/membership before input and recheck both under the gate immediately before file/metadata commit. A logout/kick during input cannot commit a pending send/upload. Multipart MIME/size checks still precede disk writes, and file fsync still precedes metadata creation.
- Private access requires active membership. Invites have 256-bit bearer codes, hashed storage and 24-hour expiry. Owner-only revoke/kick and nonowner leave remove all affected socket room subscriptions. Kicks persist a ban, including against stale invites and public rejoin.
- Message insert, room sequence increment, membership/session validation and client-ID dedupe happen transactionally. Uniqueness is `(room,user,clientMessageId)` and `(room,seq)`. Duplicate retries return the original message without a second notification; payload substitution conflicts. Failed inserts roll back sequence increments and never success-ack or broadcast. Socket sends ack after commit **before** emitting their broadcast. Message history/backfill is durable; deletion is a tombstone preserving sequence and idempotency checks.
- Read positions advance monotonically and cannot exceed `lastSeq`. Exclusive forward/backward pagination returns ascending messages, default 50/max 100, rejecting simultaneous cursors.
- Presence counts unique users, not tabs. Disconnect, logout, leave and kick remove subscriptions/presence. All active memberships subscribe on connection; reconnect clients must still backfill to reconcile missed events.
- Uploads accept exactly one multipart `file`, at most 5 MiB, with PNG/JPEG/WebP signature **and declared multipart MIME** checks. Bun's multipart parser infers `File.type` from filenames, so the code separately verifies the original part header. SVG/HTML and MIME mismatches are rejected. Random 0600 disk keys are never public URLs; successful file writes are fsynced before creating metadata, and DB failure unlinks the file.
- Attachment reads require current room membership. Unpublished uploads are readable only by their uploader; publishing requires the same uploader and room. One attachment cannot be reused by a second message. Deleted-message attachments are denied even to the sender. Responses carry exact image Content-Type, nosniff and private no-store policy. Static serving cannot expose uploads, dotfiles, source maps or symlink targets.

## Verified coverage and operational limits

The integration suite exercises real HTTP, multiple real Socket.IO clients (including polling), SQLite persistence/restart, hashed sessions/Argon2, room ACLs, invite revoke/kick, immutable dedupe, concurrent sends, read cursors, history, deletion, unique-user presence/disconnect/logout, revoked DB sessions, upload magic/MIME/size/ACL rejection, built frontend serving, and a separately started built server with production Secure cookies. Streamed HTTP regression cases hold JSON/multipart bodies open while unrelated HTTP/socket sends/logout proceed, enforce input deadlines, and revoke a session/membership during input before verifying no file/metadata/message commit. A direct stream test verifies progress cannot extend the total deadline and confirms actual reader cancellation/unlocking. Captured-ID tests cover missing/mismatched preconditions on every protected mutation, optional GET checks, bootstrap exemptions, and valid identity. Real SQLite triggers reject inserts to verify rollback and absence of false acks/broadcasts. Each implementation slice was driven by observed RED then GREEN runs; later regression checks cover cross-cutting behavior.

V1 deliberately runs **one application process**: presence, subscriptions and rate-limit counters are in memory; in-process mutation serialization prioritizes correctness over throughput. Multi-instance fanout/presence and distributed rate limiting require a separate adapter/control plane before horizontal scaling. There is no Redis dependency. MySQL's sequence increment is transactional, but full distributed revocation/fanout is not claimed.

Uploads are signature-checked, not decoded/transcoded or malware-scanned. Multipart buffering is bounded to 5 MiB + 64 KiB; Bun adds a 6 MiB transport ceiling. Long-term retention/garbage collection of unreferenced uploads, expired sessions/invites, and deleted-message files is an operator follow-up; access is already denied by ACL/tombstone rules. There is no fake chat history. Broadcasts are not a transactional outbox: process failure between commit and notification is recovered by authoritative HTTP/Socket backfill. End-to-end browser UX and actual MySQL execution remain parent-owned verification.
