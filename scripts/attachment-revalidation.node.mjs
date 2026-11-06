// Lightweight real-source tests: no Bun, generated Prisma client, DB or server.
// Run with Node >= 24: node --test scripts/attachment-revalidation.node.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = path => readFileSync(new URL(`../apps/server/src/${path}`, import.meta.url), 'utf8')
function plain(text) {
  // Parameter properties need transformation; everything else is type erasure.
  return stripTypeScriptTypes(text.replace('constructor(readonly rooms: Rooms) {}', 'constructor(rooms) { this.rooms = rooms }'), { mode: 'strip', disableExperimentalWarning: true })
    .replace(/^import .*$/gm, '').replace(/\bexport /g, '')
}
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }) }
const Attachments = runInNewContext(`${plain(source('attachment-retention.ts'))}\n${plain(source('attachments.ts'))}\nAttachments`, {
  Response, Headers, Uint8Array, Date, Buffer, createHash, fail,
  // Projection from the real schema-facing source, not a duplicate download algorithm.
  attachmentMetadataSelect: runInNewContext(`(${source('rooms.ts').match(/export const attachmentMetadataSelect = (.*) as const/)[1]})`)
})
function fixture() {
  const state = {
    now: Date.parse('2026-11-01T00:00:00Z'), metadataReads: 0, binaryReads: 0, aclChecks: 0, denied: false,
    bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    metadata: { id: 'image-1', roomId: 'room-1', userId: 'alice', filename: 'fixture.png', mimeType: 'image/png', size: 8, createdAt: new Date('2026-11-01T00:00:00Z'), expiredAt: null, message: { deletedAt: null } }
  }
  const rooms = {
    now: () => state.now,
    member: async (room, user) => { assert.equal(room, 'room-1'); assert.ok(user); state.aclChecks++; if (state.denied) fail(403, 'FORBIDDEN') },
    db: { attachment: { findUnique: async query => {
      assert.equal(query.where.id, 'image-1')
      if (query.select.bytes) { state.binaryReads++; return { bytes: state.bytes } }
      state.metadataReads++
      return state.metadata
    } } }
  }
  return { state, attachments: new Attachments(rooms) }
}
function privateHeaders(response, etag) {
  assert.equal(response.headers.get('cache-control'), 'private, no-cache')
  assert.deepEqual(response.headers.get('vary')?.toLowerCase().split(/\s*,\s*/).sort(), ['cookie', 'x-anyone-user-id'])
  assert.equal(response.headers.get('etag'), etag)
}

test('authorized revalidation returns a bodyless 304 without a binary SELECT', async () => {
  const { state, attachments } = fixture()
  const first = await attachments.download('image-1', 'alice')
  const etag = first.headers.get('etag')
  assert.match(etag ?? '', /^"[a-f0-9]{64}"$/)
  privateHeaders(first, etag)
  assert.equal(first.status, 200)
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), state.bytes)
  assert.equal(first.headers.get('content-length'), '8')
  assert.equal(first.headers.get('content-type'), 'image/png')
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff')
  assert.match(first.headers.get('content-security-policy'), /sandbox/)
  assert.match(first.headers.get('content-disposition'), /inline/)
  state.binaryReads = 0
  const second = await attachments.download('image-1', 'alice', etag)
  assert.equal(second.status, 304)
  assert.equal(second.body, null)
  assert.equal((await second.arrayBuffer()).byteLength, 0)
  assert.equal(second.headers.get('content-length'), null)
  privateHeaders(second, etag)
  assert.equal(state.binaryReads, 0)
  assert.equal(state.metadataReads, 2)
  assert.equal(state.aclChecks, 2)
})

test('If-None-Match uses weak comparison, lists and wildcard for an authorized GET', async () => {
  const { state, attachments } = fixture()
  const etag = (await attachments.download('image-1', 'alice')).headers.get('etag')
  for (const validator of [`W/${etag}`, `"other", W/${etag}, "last"`, `"comma,inside", ${etag}`, ` \t${etag}\t `, '*', ' \t*\t ', `, , W/${etag},,`]) {
    state.binaryReads = 0
    const result = await attachments.download('image-1', 'alice', validator)
    assert.equal(result.status, 304, validator)
    assert.equal(result.body, null)
    assert.equal(state.binaryReads, 0, validator)
  }
  for (const validator of ['"other"', 'W/"other", "last"', '', 'unquoted', `w/${etag}`, `${etag}junk`, `"unterminated, ${etag}`, `*, ${etag}`]) {
    state.binaryReads = 0
    const result = await attachments.download('image-1', 'alice', validator)
    assert.equal(result.status, 200, validator)
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), state.bytes)
    assert.equal(state.binaryReads, 1, validator)
  }
})

test('the real attachment route forwards validators only after cookie and expected-user authentication', async () => {
  const { state, attachments } = fixture()
  const etag = (await attachments.download('image-1', 'alice')).headers.get('etag')
  const appSource = source('app.ts')
  const authSource = appSource.slice(appSource.indexOf('  async function auth('), appSource.indexOf('  const cookie ='))
  const routeSource = appSource.slice(appSource.indexOf("  app.get('/api/attachments/:id'"), appSource.indexOf('  const realtime ='))
  assert.ok(authSource && routeSource)
  let handler
  let gateCalls = 0
  runInNewContext(`${plain(authSource)}\n${plain(routeSource)}`, {
    app: { get: (path, callback) => { assert.equal(path, '/api/attachments/:id'); handler = callback } },
    gate: async fn => { gateCalls++; return fn() }, attachments, fail,
    EXPECTED_USER_HEADER: 'X-Anyone-User-Id', sessionHash: cookie => cookie,
    session: async cookie => cookie === 'anyone_session=valid' ? { userId: 'alice' } : null
  })
  const request = (cookie, expectedUser = 'alice', validator = etag) => handler({ req: {
    raw: new Request('http://fixture/api/attachments/image-1', { headers: { ...(cookie ? { cookie } : {}), 'X-Anyone-User-Id': expectedUser, 'If-None-Match': validator } }),
    param: name => { assert.equal(name, 'id'); return 'image-1' },
    header: name => new Headers({ 'If-None-Match': validator }).get(name)
  } })
  state.binaryReads = 0
  const result = await request('anyone_session=valid')
  assert.equal(result.status, 304)
  assert.equal(state.binaryReads, 0)
  const metadataBefore = state.metadataReads
  await assert.rejects(request(null), { status: 401 })
  await assert.rejects(request('anyone_session=invalid'), { status: 401 })
  await assert.rejects(request('anyone_session=valid', 'bob'), { status: 409 })
  assert.equal(state.metadataReads, metadataBefore)
  assert.equal(gateCalls, 4)
})

test('validators remain stable and opaque but are partitioned by identity and representation version', async () => {
  const { state, attachments } = fixture()
  const first = (await attachments.download('image-1', 'alice')).headers.get('etag')
  assert.equal((await attachments.download('image-1', 'alice')).headers.get('etag'), first)
  const otherUser = await attachments.download('image-1', 'bob', first)
  assert.equal(otherUser.status, 200)
  assert.notEqual(otherUser.headers.get('etag'), first)
  assert.doesNotMatch(first, /alice|image-1|room-1/)
  state.metadata.createdAt = new Date(state.metadata.createdAt.getTime() + 1)
  const version = await attachments.download('image-1', 'alice', first)
  assert.equal(version.status, 200)
  assert.notEqual(version.headers.get('etag'), first)
  state.metadata.filename = 'renamed.png'
  assert.notEqual((await attachments.download('image-1', 'alice')).headers.get('etag'), version.headers.get('etag'))
})

for (const [name, change, status] of [
  ['missing attachment', s => { s.metadata = null }, 404],
  ['denied room membership', s => { s.denied = true }, 403],
  ['deleted message', s => { s.metadata.message.deletedAt = new Date(s.now) }, 404],
  ['unpublished attachment of another user', s => { s.metadata.message = null; s.metadata.userId = 'bob' }, 403],
  ['seven-day boundary', s => { s.now += 7 * 86400000 }, 410],
  ['purged attachment', s => { s.metadata.expiredAt = new Date(s.now) }, 410]
]) {
  test(`a cached validator cannot bypass ${name}`, async () => {
    const { state, attachments } = fixture()
    const etag = (await attachments.download('image-1', 'alice')).headers.get('etag')
    change(state)
    state.binaryReads = 0
    for (const validator of [etag, '*']) await assert.rejects(attachments.download('image-1', 'alice', validator), { status })
    assert.equal(state.binaryReads, 0)
  })
}

test('the uploader may revalidate an unpublished image but expiry still wins', async () => {
  const { state, attachments } = fixture()
  state.metadata.message = null
  const etag = (await attachments.download('image-1', 'alice')).headers.get('etag')
  state.now += 7 * 86400000 - 1
  state.binaryReads = 0
  assert.equal((await attachments.download('image-1', 'alice', etag)).status, 304)
  state.now++
  await assert.rejects(attachments.download('image-1', 'alice', etag), { status: 410 })
  assert.equal(state.binaryReads, 0)
})
