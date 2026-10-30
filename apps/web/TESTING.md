# Anyone IM frontend handoff

All implementation lives in `apps/web`. Package/protocol identifiers remain `@relay-im/*`; visible branding is Anyone / Anyone IM.

## Verification

With Bun 1.4.4 on PATH, run from `apps/web`:

```sh
bun x playwright install chromium
# Optional: set PLAYWRIGHT_BROWSERS_PATH to your browser-cache directory.
bun x playwright test --config playwright.ui.config.ts --reporter=line
bun run typecheck
bun run build
```

Last handoff run: **18 UI tests passed**, TypeScript passed, production Vite build passed. Build output is `dist/`, consumed by the parent's production server. Dev is loopback-only `127.0.0.1:4101`, proxying same-origin `/api` and `/socket.io` to `127.0.0.1:4100`.

UI behavior was implemented through observed failing Playwright tests followed by passing tests. HTTP and Engine.IO/Socket.IO fixtures are explicitly confined to `tests/ui.spec.ts`; they do not verify the real server. The parent owns real-server E2E and deployment verification. Tests cover auth, profile/theme/logout, room create/discovery/invite/leave, owner controls and nested focus return, send failure/persistence/idempotent retry, IME/XSS, typed realtime reconciliation/reconnect/deletion/removal, history pagination/scroll, per-room unread, image upload/paste, offline/error/empty states, dark theme, 320px navigation and reduced visual viewport geometry.

Screenshots (fixture-driven visual evidence, not production conversations):

- `test-results/mobile-rooms-320.png`
- `test-results/desktop-image-chat.png`
- `test-results/desktop-dark.png`
- `test-results/mobile-chat-dark-320.png`
- `test-results/mobile-details-dark-320.png`
- `test-results/mobile-keyboard-dialog-320.png`

## Integration hooks

`guest-name`, `guest-submit`, `app-shell`, `room-list`, `chat-panel`, `message-list`, `message-input`, `send-message`, `room-${room.id}`, `mobile-back`, `room-actions` are stable `data-testid` hooks. Controls also have semantic Chinese labels. No socket or cookie is exposed globally.

## State and limitations

- Sending uses canonical HTTP POST; receiving, presence, room updates and catch-up use typed Socket.IO events. Acknowledged messages use server sender/timestamp/sequence only.
- Failed/unconfirmed outbox entries survive refresh in `relay.outbox.<server-user-id>` with their original client UUID, and require explicit retry. This stores message content and attachment metadata locally, not credentials. If browser storage is unavailable the UI explicitly warns that persistence cannot be guaranteed.
- Theme is local preference; authentication remains server-owned HttpOnly cookies. No passwords/tokens/session cookies are read or stored by the frontend.
- Unsaved text drafts and not-yet-uploaded image files do not survive a refresh or a room switch. Failed **sent** outbox entries do survive refresh. Guest logout may make that guest identity unrecoverable; the UI warns about it.
- Virtual-keyboard layout was checked with reduced VisualViewport geometry in Chromium, not on a physical iOS/Android device. Safari/WebKit device testing remains with integration QA.
- Older history uses viewport anchoring; newly loaded images have no dimensions in the contract, so delayed intrinsic image sizing can still shift history layout. Real media stress testing remains appropriate.
- No production services, Docker, root files, dependencies, lockfiles or package namespaces were changed by this frontend task.

## Reusable testing notes

For isolated realtime UI tests, route `/socket.io/` WebSockets before navigation, send the Engine.IO open packet, respond to the Socket.IO `40` connection packet, and acknowledge typed subscription packets with `43<ack-id>[{data:...}]`. Count completed Socket.IO handshakes rather than WebSocket constructions because React StrictMode can close an initial connection. Keep fixtures out of application source. Scope duplicate-message assertions to canonical messages or prefix sidebar previews with their actual sender, since a legitimate sidebar preview is not a second message.
