# Session preservation and room-list request coalescing

## Identity states

`App` keeps the same `Workspace` and `SessionApi` instance while checking the cookie-authoritative `/session` identity after focus, visible-tab and online events.

- **Checking:** synchronously `hold()` the protected API, hide/inert/aria-hide the mounted workspace, suspend realtime and read acknowledgement, and show only generic identity-check text. The request has a 15-second abort deadline.
- **Uncertain:** transport errors, timeouts and non-authoritative server failures (including 5xx) retain the mounted workspace and its in-memory drafts/history/outbox. They do not claim an account change. Protected operations remain held; an explicit retry, focus, visible-tab or online event retries verification.
- **Verified:** only a successful `/session` response for the same owner resumes the same API/context and reveals the workspace. No unverified cached identity is treated as an authenticated offline session.
- **Changed/absent:** a successful null/different identity, 401, `SESSION_CHANGED`, or the existing BroadcastChannel/storage account-change signal invalidates the old session. Replacement identities require the existing explicit confirmation flow.

A revalidator is bound to the exact API object and App identity epoch. Cleanup disposes it. Old success/failure cannot unlock, invalidate or publish into a replacement session. Overlapping checks share their pending promise; the slot is released **before** completion callbacks, so a completion-time focus starts fresh work rather than joining a settled check.

The `SessionApi` integration contract is reversible `hold()/resume()` with `isCurrent()` false while held, request/resource/assert gates, and an operation-generation fence rejecting pre-hold results even if they settle after resume. `invalidate()` must still invalidate a held identity. `publicApi` remains restricted to the existing session/onboarding allowlist. `useRealtime` consumes `paused`, disconnects while held, and performs recovery on resume without dropping `useMessages` caches.

## Sensitive UI and portals

The workspace remains mounted beneath a hidden, `display:none`, inert and `aria-hidden` wrapper. Workspace-owned modal open props are gated by `!paused`, including RoomDetails' **nested action confirmation** (`open && !!confirm`); closing only the outer dialog is insufficient to release a nested focus scope. Chat receives `visible=false` so read effects stop. The lock also hides `.modal`/`.modal-overlay` body portals during exit animations. Chat's own delete dialog must use its visibility gate to release a portal focus trap while locked (implemented by its owning change).

This is a display/operation lock, not memory encryption or durable offline storage. Already-authorized data remains in this page's memory while identity is uncertain. Reloading/closing the page still loses memory-only drafts/history; nothing is added to IndexedDB/localStorage. External tabs already opened to an image cannot be retroactively erased by this UI.

## Room-list single-flight

`createRoomRequest` holds only the pending HTTP promise, not settled room data or a TTL cache. Workspace's initial load and realtime connection refresh use the same loader. Its scope is one session and pause/resume generation. Success and failure both release the pending slot; the next independent refresh goes to the server.

Only HTTP work is shared. Each refresh caller still checks its own `isCurrent()` and `api.isCurrent()` before publication. A valid connection caller establishes the notification history baseline even if its request was started by initial load or another caller. An obsolete connection caller cannot publish, clear errors, or establish that baseline. Ordinary room-update refreshes do not become history baselines. Existing monotonic read/message-summary merging remains in place.

Workspace marks startup initialized only after a current successful room response. A pause cleans up the old initialization callback; resume retries unfinished initialization through the new generation's pending room flight, shared with realtime refresh. This retries initial desktop selection, consumes a joined-room deeplink, or opens the unjoined-room/password dialog as appropriate. Once initialized, resume does **not** rerun initial selection/deeplink handling or remount the selected room's draft subtree.

`SessionApi.onResume(listener)` returns an unsubscribe function and emits only after a live held session resumes. Invalidation/disposal clear listeners. It grants no permission to use old results: operation-generation fencing is unchanged. Pending image consumers use the signal only after `SESSION_UNVERIFIED`, with an immediate `isCurrent()` check for rejection arriving after the resume signal; loaded blobs and terminal expiry are not refetched (see `image-loading.md`).

## Lightweight verification and TDD evidence

On the constrained production host, run only through the shared lock/memory guard:

```sh
python /root/.hermes/cache/scratch/anyone-im-light-verify.py node --disable-warning=ExperimentalWarning --test scripts/session-cache.node.mjs
```

The guard enforces a shared lock, at least 256 MiB available memory, a 128 MiB Node heap and a 60-second timeout. Busy/low-memory results must be deferred, not bypassed. CI can run `node --disable-warning=ExperimentalWarning --test scripts/session-cache.node.mjs` under Node 26.

Observed tracer-bullet RED→GREEN evidence:

1. Revalidator: `protected operations must stop synchronously` failed (`false !== true`), then passed with reversible hold/shared retry.
2. Pending room helper: duplicate loader calls failed (`2 !== 1`), then passed with shared pending work and release on success/failure.
3. Actual App focus effect: failed (`undefined` instead of `checking`), then passed with preserved user/context and uncertain lock after transport failure.
4. Actual Workspace startup/refresh source callbacks: failed (`3 !== 1` requests), then passed while retaining independent generation and notification-baseline decisions.
5. Actual App bounded revalidation: missing AbortSignal assertion failed, then passed with the 15-second signal.

Additional regression coverage verifies 5xx recovery on visible/online events, authoritative logout/mismatch/401, cross-tab changes with late success, disposed/obsolete checks and completion-time revalidation. Reviewed lifecycle repairs were tested first against the unfixed source:

- Nested confirmation: actual RoomDetails JSDOM render retained **1 dialog instead of 0** after `open=false`; gating nested open passed, including preserved confirmation state on resume.
- Interrupted startup: the actual Workspace hook seam left `active=''` instead of `room1` in desktop/default, joined deeplink and unjoined deeplink cases. Resume initialization passed all three and a two-room already-initialized selection-preservation regression, while sharing the resumed pending HTTP flight.
- Resume signal: `onResume` was `undefined`; the API suite now verifies live-boundary delivery, unsubscribe and invalidation/disposal, alongside all prior operation-generation fence tests.

Guarded results: **14/14 session-cache**, **6/6 session-api**, **1/1 session-portal**. The portal suite is `apps/web/tests/session-portal.node.mjs` and needs the same pre-provisioned `IMAGE_TEST_TOOLS` dependency directory as the image suite. It substitutes the Modal animation/focus primitive, so it proves nested open-state closure, not real browser focus restoration. `apps/web/tests/session-lock.spec.ts` adds the real nested-confirmation retry focus/click, deferred initial `/rooms` selection/deeplink, and pending-image settlement-before/after-resume regressions for CI; these were **not run locally**.

Tests import the real TypeScript helpers via Node's `stripTypeScriptTypes`. A small hook seam executes the actual pre-render App source and actual Workspace refresh/startup callbacks, not copied implementations. It substitutes React hooks, transport and browser events. It does **not** prove React concurrent scheduling, real DOM/CSS/accessibility trees, portal focus restoration, browser abort timing, Socket.IO handshakes, authenticated HTTP behavior, or production cache retention. Full typecheck/build/browser suites and deployment verification belong to CI/Actions and the parent deployment workflow; no dependency installs, full builds, browser or database probes were run here.
