# Cache and reconnect optimization

## Visible changes

- Images can reuse the browser's private HTTP cache after online ETag/304 authorization. A 304 skips both the original image transfer and the database binary SELECT; it is not an offline or zero-request cache.
- Focus/visibility/network recovery preserves the current page's memory-only conversation and drafts while identity is uncertain. Sensitive UI and protected operations remain locked until the same identity is verified; a confirmed account change still destroys the old workspace.
- Images request their original bytes only near the visible viewport. Already-started images are not discarded simply because they scroll out of view.
- Startup/connection room-list work coalesces while pending. Valid deletion-change cursors avoid scanning the cached transcript on every room switch/reconnect. Restart/overflow falls back to authoritative reconciliation.
- History uses an 8-room LRU and a 300-message bidirectional window. Older/newer/latest controls preserve access to trimmed history. Article layout/paint containment and bounded DOM size reduce long-list work; this is not DOM virtualization.

## Boundaries

There are no database migrations, new tables, environment variables, Redis dependencies or Service Worker private-data caches. The existing seven-table schema and seven-day attachment retention remain unchanged. The bounded deletion journal assumes the existing single-process writer/gate architecture. Browser-private cache storage may persist downloaded image bytes; the server cannot remotely erase existing downloads or decoded images.

Thumbnails are not included: the server has no resizing codec or existing thumbnail representation. CSS downscaling after an original download would not save transfer bytes. A real thumbnail endpoint needs a separately evaluated codec, resource limits, authorization and variant-cache policy.

Details: [image HTTP revalidation](attachment-revalidation.md), [session locks](cache-session.md), [viewport loading and thumbnail evaluation](image-loading.md), [history windows and change cursors](history-cache.md).

## Verification gates

The normal `Verify Anyone IM` workflow retains its complete SQLite/UI and MySQL integration gates, adds Node 24 real-source synchronization regressions, and exercises the new browser specs. Browser HTTP caching tests must not use Playwright routing interception, which disables that cache. Source-level and JSDOM tests are not substitutes for successful real-browser/database CI.

On a constrained production host, do not install dependencies or run builds/browser suites. Use only the established guarded lightweight checks; perform full validation and image builds on GitHub-hosted runners.

## Release and rollback

1. Require successful independent review and full CI for the exact implementation commit.
2. Merge the reviewed PR and require full CI for the resulting default-branch commit.
3. Manually dispatch the existing Docker publication workflow on that commit. Require its platform check, packaged-resource check, new-image MySQL smoke test and registry push to succeed.
4. Pull the immutable `1596944197/anyone-im:sha-<exact-commit>` image; verify its source revision and linux/amd64 platform before replacement. Preserve the old local image under a rollback tag.
5. Replace **only** `anyone-im` with Compose `up -d --no-deps --pull never`, after selecting that exact image locally. Do not run project-wide down, remove-orphans, database migration/reset or sibling-service restarts.
6. Read back the running image revision, local/public HTTPS readiness, static assets and unchanged sibling container IDs. Distinguish these production checks from authenticated image/reconnect acceptance performed in CI.
7. If readiness or exact-image verification fails, select the saved old image and replace only the same app container. Keep the shared MySQL database and all other services unchanged. Record exact deployed SHA, run URLs, image/container IDs and rollback tag privately on the host.
