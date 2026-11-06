# Attachment image loading

## Behavior

`AttachedImage` now observes a real placeholder **before** calling `api.resource`.
Adding `loading="lazy"` to the final `<img>` would not have fixed this: the original
implementation fetched the entire blob in an effect before the image existed.

- The observer uses a `200px 0px` viewport root margin. Ancestor scroll clipping
  still applies; within the chat timeline an image may need to reach that scroll
  container's visible area before loading.
- The first intersection latches loading on and disconnects the observer.
  Scrolling away does not unload, abort or refetch an already-started image.
- Browsers without `IntersectionObserver` load normally.
- The pending root keeps `.image-link` and a minimum 48×48 box; its child reserves
  a responsive, nominal 4:3 box. Actual image dimensions are not in the attachment
  DTO, so this cannot guarantee zero layout shift for every image. The loaded
  `<a class="image-link"><img … /></a>` layout is unchanged. Existing 48×48 upload
  preview CSS still applies, as does the image `onLoad` callback used by Chat's
  scroll-to-bottom handling. Outbox images use the same loading path.
- A new attachment identity, URL, expiry metadata or authenticated owner gets a
  fresh inner component: no old blob or old visibility latch crosses that boundary.

## Expiry, retries and authorization

Known-expired metadata and an elapsed `expiresAt` prevent the byte request entirely.
The deadline timer starts even when an image is offscreen and has never loaded.
After loading, it remains active offscreen: expiry aborts work, revokes the object
URL, removes the image and its preview link, and leaves the expired placeholder.
Responses arriving after abort or expiry cannot create a new object URL. Server
`ATTACHMENT_EXPIRED` errors and HTTP 410 are terminal and do not offer retry.

Transient transport and decode failures still offer an explicit retry. Retrying
clears the old error/blob, shows the loading state, and uses a fresh abort signal.
An already-near-viewport pending request interrupted by the session generation
fence (`SESSION_UNVERIFIED`) waits for same-owner resume and retries automatically
with fresh authorization. Pending work subscribes to `api.onResume`; rejection
before resume marks it eligible, while rejection after resume checks
`api.isCurrent()` immediately so it cannot miss that
signal. The subscription is removed with effect cleanup/unmount. Resume never
refetches valid loaded blobs, ordinary network failures, unseen images or terminal
expiry, and never accepts bytes returned by the old generation. Visibility remains
the existing first-intersection latch, not continuous scroll visibility.
Every original request, retry and real remount goes through `api.resource`, retaining
its expected-user header and same-origin credentials. There is deliberately no
shared in-memory blob cache: such a cache could bypass the server's ACL/deletion/
expiry checks on remount. This also means concurrent independent mounts may each
issue a request; authenticated HTTP revalidation is a separate server concern.
Unmounting aborts work, clears the timer and disconnects the observer.

## Thumbnail evaluation: not implemented

The current API returns the original attachment representation. The DTO has no
thumbnail URL or image dimensions; the server stores one byte payload and has no
image decoding/resizing dependency. Its PNG/JPEG/WebP signature checks are not a
resizer. CSS sizing, `object-fit`, or creating a canvas/`createImageBitmap` after
downloading the original **does not reduce original network bytes**. Lazy loading
avoids requests for unseen attachments; it does not reduce the size of images
that are actually viewed.

A genuine future option without a DB migration is a separately authenticated,
size-bounded derived-image endpoint (for example a fixed thumbnail variant of an
attachment ID). It would need an approved decoding/resizing implementation, CPU/
pixel/memory and concurrency bounds, defined orientation/animation behavior,
variant-specific ETags and private revalidation, and bounded derivative storage
or eviction. It must check identity, room membership, publication ownership,
message deletion and expiry **before** returning either cached derivatives or 304;
derivatives must not outlive originals. No suitable existing codec path was found,
so no endpoint, derivative cache, DB field, migration or native dependency was
added. A future pure-JS/WASM codec could avoid native installation, but would still
be a new dependency requiring performance/security evaluation and approval.
Client-side upload downscaling is another zero-native approach, but replacing the
original loses fidelity and is not an independently retrievable thumbnail; it also
cannot optimize historical images. It is not included here.

## Verification

### Executed locally

A lightweight JSDOM seam mounts the **real React component**, observer hook,
`SessionContext`, `createSessionApi`, `api.resource` transport and URL validator.
Only the network, observer, clock and blob URL browser boundaries are controlled.
The contract constants are read from real source; unrelated Zod schemas are not
loaded. This is not a copy of the loading algorithm.

Two actual TDD tracer bullets were observed:

1. Before implementation, an offscreen mount failed with `1 !== 0` byte requests.
   After observer gating it passed.
2. Replacing an already-loaded attachment while offscreen failed with `2 !== 1`
   requests because it inherited visibility. Keyed identity isolation made it pass.

The reviewed pending-image resume bug was reproduced before its repair: an old
successful response rejected before resume left **1 request instead of 2**, and a
response settling after resume left **0 fresh blobs instead of 1**. Subscription
coverage also failed with **0 listeners instead of 1**. The repaired suite passed
**21/21** checks, including both interruption settlement orderings, fresh bytes and
expected-user headers, non-refetch of loaded/error/unseen/expired states and
unsubscribe on unmount, alongside no-observer fallback,
metadata/deadline expiry, offscreen expiry, aborted late responses, transport and
decode retries, terminal server expiry, box/style contracts, the Chat load callback,
unsafe URLs, legacy metadata, authenticated owner changes and cleanup.

A separate strict scoped TypeScript check passed for the component and helper,
including the real API/session/upload-helper transitive sources. Its contract type
boundary is extracted from current source rather than loading unrelated schemas.
The Playwright files passed TypeScript syntax transpilation only. This is not a
full application or Playwright semantic typecheck.

Local checks ran serially through the production-host guard (256 MiB available
memory minimum, 128 MiB Node heap and 60-second limit). One low-memory pause was
respected; a later guarded retry passed. Commands from the repository root:

```sh
IMAGE_TEST_TOOLS=/root/.hermes/cache/scratch/anyone-image-loading-tools \
  python /root/.hermes/cache/scratch/anyone-im-light-verify.py \
  node --test apps/web/tests/attached-image.node.mjs

IMAGE_TEST_TOOLS=/root/.hermes/cache/scratch/anyone-image-loading-tools \
  python /root/.hermes/cache/scratch/anyone-im-light-verify.py \
  node apps/web/tests/attached-image.typecheck.mjs
```

`IMAGE_TEST_TOOLS` points to pre-provisioned isolated test tools (`typescript`,
`react`, `react-dom`, `jsdom`, and React type declarations). It can be omitted when
those tools are already available from normal module resolution. JSDOM is a
verification-only prerequisite; repository package manifests were not changed.
Do not install tools or bypass the guard on a constrained production host.

### CI/dev browser checks: not executed locally

`apps/web/tests/attached-image.spec.ts` loads a Vite fixture that imports and mounts
the real source component rather than the full application. The tests cover a
controlled observer with authenticated retry/offscreen expiry, a real observer in
a nested scroll container, nonzero placeholder geometry, 48×48 upload-preview
geometry, remount requests and known-expired metadata. The test-only fixture is
not imported by the production entry point.

Run in a prepared CI/dev environment with the existing Playwright/browser/Bun
prerequisites, **not on the production host**. From `apps/web`:

```sh
bunx playwright test --config playwright.ui.config.ts tests/attached-image.spec.ts
```

No browser, full build, DB operations, commit or push was performed. Browser layout,
real scroll-intersection behavior and full-app integration remain CI checks;
JSDOM verifies DOM/lifecycle behavior and style declarations, not browser geometry.
Existing `private-room-retention.spec.ts` was left unchanged.
