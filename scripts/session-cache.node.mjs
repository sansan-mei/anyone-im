import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

async function source(name) {
  const text = await readFile(new URL(`../apps/web/src/${name}.ts`, import.meta.url), 'utf8')
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString('base64')}`)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function appHarness() {
  const text = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8')
  const start = text.indexOf('export default function App()')
  const end = text.indexOf('  if (booting)', start)
  const code = stripTypeScriptTypes(text.slice(start, end).replace('export default ', '') + '\nreturn { user, stale, verification: typeof verification === "undefined" ? undefined : verification }; }')
  const { createSessionRevalidator } = await source('sessionRevalidation')
  const slots = [], effects = [], cleanups = []
  let index = 0, nextCheck = () => Promise.resolve({ user: { id: 'alice' } })
  const useState = initial => { const n = index++; if (!(n in slots)) slots[n] = typeof initial === 'function' ? initial() : initial; return [slots[n], value => { slots[n] = typeof value === 'function' ? value(slots[n]) : value }] }
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, n) => Object.is(v, b[n]))
  const useMemo = (make, deps) => { const n = index++; if (!equal(slots[n]?.deps, deps)) slots[n] = { deps, value: make() }; return slots[n].value }
  const useRef = value => useMemo(() => ({ current: value }), [])
  const useEffect = (effect, deps) => { const n = index++; if (!equal(slots[n], deps)) { slots[n] = deps; effects.push(() => { cleanups[n]?.(); cleanups[n] = effect() }) } }
  const window = new EventTarget(), document = new EventTarget()
  document.visibilityState = 'visible'; document.documentElement = { dataset: {} }
  const sessions = [], requests = []
  const createSessionApi = (ownerId, changed) => {
    const bound = { ownerId, held: false, disposed: false, hold() { this.held = true }, resume() { this.held = false }, dispose() { this.disposed = true }, invalidate() { this.dispose(); changed() }, isCurrent() { return !this.held && !this.disposed } }
    sessions.push(bound); return bound
  }
  const fn = new Function('useState', 'useMemo', 'useRef', 'useEffect', 'useCallback', 'api', 'createSessionApi', 'createSessionRevalidator', 'usePwaInstall', 'window', 'document', 'localStorage', 'BroadcastChannel', 'errorText', `${code}; return App`)
  const App = fn(useState, useMemo, useRef, useEffect, (value, deps) => useMemo(() => value, deps), (...args) => { requests.push(args); return nextCheck() }, createSessionApi, createSessionRevalidator, () => ({}), window, document, { getItem() { return null } }, undefined, String)
  const render = () => { index = 0; const state = App(); while (effects.length) effects.shift()(); return state }
  const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); return render() }
  render(); await flush(); await flush()
  return { render, flush, window, document, sessions, requests, check: fn => { nextCheck = fn }, dispose: () => cleanups.forEach(fn => fn?.()) }
}

test('actual App focus transport failure preserves user and exposes a locked uncertain state', async () => {
  const app = await appHarness(), gate = deferred()
  app.check(() => gate.promise)
  app.window.dispatchEvent(new Event('focus'))
  let state = app.render()
  assert.equal(state.verification, 'checking')
  assert.equal(app.sessions.at(-1).held, true)
  gate.reject(new TypeError('offline'))
  state = await app.flush()
  assert.equal(state.user.id, 'alice')
  assert.equal(state.stale, false, 'network failure is not an account-change claim')
  assert.equal(state.verification, 'uncertain')
  app.dispose()
})

test('actual App bounds revalidation with an abort signal so a hung network can become retryable', async () => {
  const app = await appHarness()
  app.window.dispatchEvent(new Event('focus'))
  await app.flush()
  assert.ok(app.requests.at(-1)[3] instanceof AbortSignal)
  assert.equal(app.requests.at(-1)[3].aborted, false)
  app.dispose()
})

test('actual App retries on visibility/online, unlocks only same identity, and rejects authoritative logout', async () => {
  const app = await appHarness()
  app.check(() => Promise.reject({ status: 503 }))
  app.window.dispatchEvent(new Event('focus'))
  assert.equal((await app.flush()).verification, 'uncertain')
  app.check(() => Promise.resolve({ user: { id: 'alice' } }))
  app.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal((await app.flush()).verification, 'verified')
  assert.equal(app.sessions.length, 1, 'verification must not replace the context or caches')
  app.check(() => Promise.resolve({ user: null }))
  app.window.dispatchEvent(new Event('online'))
  const state = await app.flush()
  assert.equal(state.user, null)
  assert.equal(state.stale, true)
  app.dispose()
})

test('actual App ignores late success after cross-tab account change', async () => {
  const app = await appHarness(), gate = deferred()
  app.check(() => gate.promise)
  app.window.dispatchEvent(new Event('focus'))
  await Promise.resolve()
  const event = new Event('storage'); event.key = 'anyone.account-change'
  app.window.dispatchEvent(event)
  assert.equal(app.render().stale, true)
  gate.resolve({ user: { id: 'alice' } })
  const state = await app.flush()
  assert.equal(state.user, null)
  assert.equal(state.stale, true)
  assert.equal(app.sessions[0].held, true, 'old verification must not resume a disposed session')
  app.dispose()
})

test('completion-time focus starts a fresh verification rather than joining completed work', async () => {
  const { createSessionRevalidator } = await source('sessionRevalidation')
  const retry = deferred()
  let checks = 0, verifier, followup, holds = 0
  verifier = createSessionRevalidator({ ownerId: 'alice', isCurrent: () => true,
    check: () => ++checks === 1 ? Promise.resolve({ user: { id: 'alice' } }) : retry.promise,
    hold: () => { holds++ }, resume() {}, invalidate() {},
    onState: state => { if (state === 'verified') followup = verifier.revalidate() },
  })
  await verifier.revalidate()
  await Promise.resolve()
  assert.equal(checks, 2)
  assert.equal(holds, 2)
  verifier.dispose()
  retry.resolve({ user: { id: 'alice' } })
  await followup
})

test('authoritative mismatch and 401 invalidate; 5xx errors preserve the hold', async () => {
  const { createSessionRevalidator } = await source('sessionRevalidation')
  for (const [result, rejected, expected] of [[{ user: null }, false, 1], [{ user: { id: 'bob' } }, false, 1], [{ status: 401 }, true, 1], [{ code: 'SESSION_CHANGED' }, true, 1], [{ status: 500 }, true, 0], [{ status: 503, code: 'NETWORK' }, true, 0]]) {
    let invalidations = 0, resumed = 0
    const verifier = createSessionRevalidator({ ownerId: 'alice', isCurrent: () => true,
      check: () => rejected ? Promise.reject(result) : Promise.resolve(result), hold() {},
      resume: () => { resumed++ }, invalidate: () => { invalidations++ }, onState() {},
    })
    await verifier.revalidate()
    assert.equal(invalidations, expected)
    assert.equal(resumed, 0)
    verifier.dispose()
  }
})

test('obsolete or disposed verification cannot publish, invalidate, or resume', async () => {
  const { createSessionRevalidator } = await source('sessionRevalidation')
  for (const dispose of [false, true]) {
    const gate = deferred(), effects = []
    let current = true
    const verifier = createSessionRevalidator({ ownerId: 'alice', check: () => gate.promise,
      isCurrent: () => current, hold() {}, resume: () => effects.push('resume'),
      invalidate: () => effects.push('invalidate'), onState: state => effects.push(state),
    })
    const pending = verifier.revalidate()
    if (dispose) verifier.dispose(); else current = false
    gate.resolve({ user: { id: 'alice' } })
    await pending
    assert.deepEqual(effects, ['checking'])
  }
})

test('actual Workspace startup/connect coalesce without sharing caller-generation or notification baseline decisions', async () => {
  const text = await readFile(new URL('../apps/web/src/Workspace.tsx', import.meta.url), 'utf8')
  const start = text.indexOf('export function Workspace('), end = text.indexOf('  const realtime = useRealtime', start)
  const initialStart = text.indexOf('  useEffect(() => {\n    let current = true', end)
  const initialEnd = text.indexOf('  useEffect(() => {', initialStart + 10)
  const code = stripTypeScriptTypes(text.slice(start, end).replace('export ', '') + text.slice(initialStart, initialEnd) + '\nreturn { refresh }; }')
  const { createRoomRequest } = await source('roomRequests')
  const gate = deferred(), baselines = [], values = [], writes = []
  let calls = 0, n = 0, cleanup
  const api = () => { calls++; return gate.promise }; api.isCurrent = () => true
  const useState = initial => { const i = n++; values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], v => { values[i] = typeof v === 'function' ? v(values[i]) : v; writes.push(i) }] }
  const location = { pathname: '/', search: '', href: 'https://example.invalid/' }
  const fn = new Function('useApi', 'useState', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'useMessages', 'useMessageNotifications', 'createRoomRequest', 'location', 'history', 'matchMedia', 'errorText', `${code}; return Workspace`)
  const Workspace = fn(() => api, useState, value => ({ current: value }), make => make(), value => value, effect => { cleanup = effect() }, () => ({}), () => ({ baseline: rooms => baselines.push(rooms) }), createRoomRequest, location, { replaceState() {} }, () => ({ matches: false }), String)
  const workspace = Workspace({ user: { id: 'alice' }, paused: false })
  const stale = workspace.refresh(true, () => false), live = workspace.refresh(true, () => true)
  assert.equal(calls, 1, 'startup and both connection callers share HTTP work')
  const room = { id: 'room1', lastSeq: 5, lastReadSeq: 1, lastMessage: null }
  gate.resolve({ rooms: [room] })
  assert.equal(await stale, false)
  assert.equal(await live, true)
  assert.deepEqual(baselines, [[room]], 'only the valid connection caller establishes history')
  assert.deepEqual(values[0], [room])
  assert.equal(writes.filter(i => i === 0).length, 2, 'startup and live caller publish; obsolete generation does not')
  cleanup()
})

async function workspaceHarness(search = '') {
  const text = await readFile(new URL('../apps/web/src/Workspace.tsx', import.meta.url), 'utf8')
  const start = text.indexOf('export function Workspace('), end = text.indexOf('  const realtime = useRealtime', start)
  const initialStart = text.indexOf('  useEffect(() => {\n    let current = true', end)
  const initialEnd = text.indexOf('  useEffect(() => {', initialStart + 10)
  const code = stripTypeScriptTypes(text.slice(start, end).replace('export ', '') + text.slice(initialStart, initialEnd) + '\nreturn { refresh, rooms, active, joinRoomId, discoverOpen, roomsLoading, setActive }; }')
  const { createRoomRequest } = await source('roomRequests')
  const slots = [], effects = [], cleanups = [], gates = [], baselines = []
  let index = 0, current = true, paused = false
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, n) => Object.is(v, b[n]))
  const useState = initial => { const n = index++; if (!(n in slots)) slots[n] = typeof initial === 'function' ? initial() : initial; return [slots[n], value => { slots[n] = typeof value === 'function' ? value(slots[n]) : value }] }
  const useMemo = (make, deps) => { const n = index++; if (!equal(slots[n]?.deps, deps)) slots[n] = { deps, value: make() }; return slots[n].value }
  const useRef = value => useMemo(() => ({ current: value }), [])
  const useEffect = (effect, deps) => { const n = index++; if (!equal(slots[n], deps)) { slots[n] = deps; effects.push(() => { cleanups[n]?.(); cleanups[n] = effect() }) } }
  const api = () => { const gate = deferred(); gates.push(gate); return gate.promise }; api.isCurrent = () => current
  const location = { pathname: '/', search, href: `https://example.invalid/${search}` }, replacements = []
  const baseline = rooms => baselines.push(rooms)
  const fn = new Function('useApi', 'useState', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'useMessages', 'useMessageNotifications', 'createRoomRequest', 'location', 'history', 'matchMedia', 'errorText', `${code}; return Workspace`)
  const Workspace = fn(() => api, useState, useRef, useMemo, (fn, deps) => useMemo(() => fn, deps), useEffect, () => ({}), () => ({ baseline }), createRoomRequest, location, { replaceState: (...args) => replacements.push(args) }, () => ({ matches: false }), String)
  const render = () => { index = 0; const state = Workspace({ user: { id: 'alice' }, paused }); while (effects.length) effects.shift()(); return state }
  const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); return render() }
  render()
  return { gates, baselines, replacements, render, flush, pause: () => { paused = true; current = false; return render() }, resume: () => { paused = false; current = true; return render() }, dispose: () => cleanups.forEach(fn => fn?.()) }
}

for (const requested of ['', 'room1', 'private-room']) test(`interrupted Workspace startup resumes selection/deeplink initialization: ${requested || 'desktop default'}`, async () => {
  const app = await workspaceHarness(requested ? `?room=${requested}` : '')
  try {
    assert.equal(app.gates.length, 1)
    app.pause()
    app.gates[0].reject(new Error('SESSION_UNVERIFIED'))
    await app.flush()
    const resumed = app.resume()
    const refreshed = resumed.refresh(true)
    assert.equal(app.gates.length, 2, 'resume initialization and connection must share fresh pending work')
    app.gates[1].resolve({ rooms: [{ id: 'room1', lastSeq: 1, lastReadSeq: 0 }] })
    await refreshed
    const state = await app.flush()
    assert.equal(state.active, 'room1', 'the resumed initial response must perform selection, not only refresh rooms')
    assert.equal(state.roomsLoading, false)
    if (requested === 'private-room') { assert.equal(state.joinRoomId, requested); assert.equal(state.discoverOpen, true) }
    if (requested === 'room1') assert.equal(app.replacements.length, 1, 'consume a member deeplink only after initialized')
  } finally { app.dispose() }
})

test('initialized Workspace resume refreshes without resetting selection or reconsuming startup links', async () => {
  const app = await workspaceHarness('?room=room1')
  try {
    app.gates[0].resolve({ rooms: [{ id: 'room1' }, { id: 'room2' }] })
    let state = await app.flush()
    state.setActive('room2')
    app.pause()
    state = app.resume()
    const refresh = state.refresh()
    app.gates[1].resolve({ rooms: [{ id: 'room1' }, { id: 'room2' }] })
    await refresh
    state = await app.flush()
    assert.equal(state.active, 'room2', 'already initialized workspaces retain the user selection/draft subtree')
    assert.equal(app.replacements.length, 1)
  } finally { app.dispose() }
})

test('room startup and connection share only the pending request, with fresh retries after settlement', async () => {
  const { createRoomRequest } = await source('roomRequests')
  const first = deferred(), second = deferred()
  let calls = 0
  const request = createRoomRequest(() => ++calls === 1 ? first.promise : second.promise)
  const startup = request(), connection = request()
  assert.equal(calls, 1)
  assert.equal(startup, connection)
  first.resolve({ rooms: ['first'] })
  assert.deepEqual(await startup, { rooms: ['first'] })
  const next = request()
  assert.equal(calls, 2, 'settled data is not a TTL cache')
  second.reject(new TypeError('offline'))
  await assert.rejects(next)
  const retry = request()
  assert.equal(calls, 3, 'failure releases the single-flight slot')
  await assert.rejects(retry)
})

test('transport failure holds identity and cache; successful retry resumes the same session', async () => {
  const { createSessionRevalidator } = await source('sessionRevalidation')
  const gate = deferred(), states = []
  let held = false, invalidations = 0, checks = 0
  const verifier = createSessionRevalidator({
    ownerId: 'alice', check: () => ++checks === 1 ? gate.promise : Promise.resolve({ user: { id: 'alice' } }),
    isCurrent: () => true,
    hold: () => { held = true }, resume: () => { held = false },
    invalidate: () => { invalidations++ }, onState: state => states.push(state),
  })
  const pending = verifier.revalidate()
  assert.equal(held, true, 'protected operations must stop synchronously')
  assert.equal(verifier.revalidate(), pending, 'overlapping focus/visibility must share a check')
  gate.reject(new TypeError('Failed to fetch'))
  await pending
  assert.equal(invalidations, 0)
  assert.equal(held, true)
  assert.equal(states.at(-1), 'uncertain')
  await verifier.revalidate()
  assert.equal(held, false)
  assert.equal(states.at(-1), 'verified')
  assert.equal(checks, 2)
})
