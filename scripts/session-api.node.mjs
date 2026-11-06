import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

function fixture() {
  const source = readFileSync(new URL('../apps/web/src/api.ts', import.meta.url), 'utf8')
  const plain = stripTypeScriptTypes(source.replace('constructor(public code: string, message: string, public status: number) { super(message) }', 'constructor(code, message, status) { super(message); this.code = code; this.status = status }')).replace(/^import .*$/gm, '').replace(/\bexport /g, '')
  let complete, changed = 0
  const calls = []
  const createSessionApi = runInNewContext(plain + '\ncreateSessionApi', {
    Headers, FormData, Response, EXPECTED_USER_HEADER: 'X-Anyone-User-Id',
    fetch: (url, options) => { calls.push({ url, options }); return new Promise(resolve => { complete = resolve }) },
  })
  const api = createSessionApi('alice', () => { changed++ })
  return { api, calls, get changed() { return changed }, resolve: response => complete(response) }
}
const data = () => new Response(JSON.stringify({ data: { ok: true } }), { headers: { 'Content-Type': 'application/json' } })

test('resume listeners observe only live hold/resume boundaries and unsubscribe on teardown', () => {
  const f = fixture(), observed = []
  assert.equal(typeof f.api.onResume, 'function', 'pending resources need a session-owned resume signal')
  const unsubscribe = f.api.onResume(() => observed.push(f.api.isCurrent()))
  f.api.resume()
  assert.deepEqual(observed, [])
  f.api.hold(); f.api.hold(); f.api.resume(); f.api.resume()
  assert.deepEqual(observed, [true])
  unsubscribe(); unsubscribe()
  f.api.hold(); f.api.resume()
  assert.deepEqual(observed, [true])
  f.api.onResume(() => observed.push('disposed'))
  f.api.dispose(); f.api.resume()
  assert.deepEqual(observed, [true])
  const invalidated = fixture()
  invalidated.api.onResume(() => observed.push('invalidated'))
  invalidated.api.hold(); invalidated.api.invalidate(); invalidated.api.resume()
  assert.deepEqual(observed, [true])
})

test('a reversible hold synchronously blocks protected JSON and image requests without destroying identity', async () => {
  const f = fixture()
  assert.equal(typeof f.api.hold, 'function')
  assert.equal(typeof f.api.resume, 'function')
  f.api.hold()
  assert.equal(f.api.isCurrent(), false)
  assert.throws(() => f.api.assertCurrent(), { code: 'SESSION_UNVERIFIED' })
  await assert.rejects(f.api('/rooms'), { code: 'SESSION_UNVERIFIED' })
  await assert.rejects(f.api.resource('/attachments/a'), { code: 'SESSION_UNVERIFIED' })
  assert.equal(f.calls.length, 0)
  assert.equal(f.changed, 0)
  f.api.resume()
  const pending = f.api('/rooms')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].options.headers.get('X-Anyone-User-Id'), 'alice')
  f.resolve(data())
  assert.equal((await pending).ok, true)
  assert.equal(f.api.isCurrent(), true)
})

test('a successful pre-hold response cannot populate the resumed workspace', async () => {
  const f = fixture(), pending = f.api('/rooms')
  const rejected = assert.rejects(pending, { code: 'SESSION_UNVERIFIED' })
  f.api.hold(); f.api.resume(); f.resolve(data())
  await rejected
  assert.equal(f.api.isCurrent(), true)
  assert.equal(f.changed, 0)
})

test('pre-hold image responses and late authentication errors are generation fenced', async () => {
  for (const response of [new Response(new Uint8Array([1, 2])), new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'old request' } }), { status: 401 })]) {
    const f = fixture(), pending = f.api.resource('/attachments/a')
    const rejected = assert.rejects(pending, { code: 'SESSION_UNVERIFIED' })
    f.api.hold(); f.api.resume(); f.resolve(response)
    await rejected
    assert.equal(f.api.isCurrent(), true)
    assert.equal(f.changed, 0)
  }
})

test('an authoritative invalidation still works during a hold and cannot be resumed', () => {
  const f = fixture()
  f.api.hold(); f.api.invalidate(); f.api.resume(); f.api.invalidate()
  assert.equal(f.changed, 1)
  assert.equal(f.api.isCurrent(), false)
  assert.throws(() => f.api.assertCurrent(), { code: 'SESSION_CHANGED' })
})

test('current unauthorized results invalidate normally, while dispose never resumes', async () => {
  const f = fixture(), pending = f.api('/rooms')
  const rejected = assert.rejects(pending, { status: 401 })
  f.resolve(new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }), { status: 401 }))
  await rejected
  assert.equal(f.changed, 1)
  const other = fixture()
  other.api.dispose(); other.api.hold(); other.api.resume()
  assert.equal(other.api.isCurrent(), false)
  assert.equal(other.changed, 0)
})
