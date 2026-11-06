import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

// Optional isolated tool directory; normal CI resolves the checkout's dependencies.
const require = createRequire(process.env.IMAGE_TEST_TOOLS ? path.join(process.env.IMAGE_TEST_TOOLS, 'package.json') : import.meta.url)
const ts = require('typescript')
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const contracts = readFileSync(path.resolve(src, '../../../packages/contracts/src/index.ts'), 'utf8')
const constants = Object.fromEntries(['EXPECTED_USER_HEADER', 'MAX_ATTACHMENT_BYTES'].map(name => {
  const expression = contracts.match(new RegExp(`export const ${name} = ([^\\n]+)`))?.[1]
  assert.ok(expression, `real contract constant ${name}`)
  return [name, vm.runInNewContext(expression)]
}))

function loadSources() {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const source = readFileSync(file, 'utf8')
    const output = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
    const localRequire = id => {
      if (id === '@anyone-im/contracts') return constants
      if (!id.startsWith('.')) return require(id)
      const base = path.resolve(path.dirname(file), id)
      for (const extension of ['.ts', '.tsx']) {
        try { readFileSync(base + extension); return load(base + extension) } catch (e) { if (e.code !== 'ENOENT') throw e }
      }
      throw new Error(`Unresolved source import ${id}`)
    }
    vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename: file })(localRequire, module, module.exports)
    return module.exports
  }
  return { ...load(path.join(src, 'AttachedImage.tsx')), ...load(path.join(src, 'api.ts')), ...load(path.join(src, 'SessionContext.tsx')) }
}

const attachment = { id: 'image-1', roomId: 'room-1', filename: 'photo.png', mimeType: 'image/png', size: 8, url: '/api/attachments/image-1', expiresAt: '2030-01-08T00:00:00Z', expired: false }

async function fixture({ observer = true, response } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://attachment.test' })
  const saved = new Map()
  function replace(key, value) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  for (const name of ['window', 'document', 'location', 'HTMLElement', 'MouseEvent']) replace(name, dom.window[name])
  replace('IS_REACT_ACT_ENVIRONMENT', true)
  const observers = [], requests = [], revoked = [], created = [], timers = new Map()
  let now = Date.parse('2030-01-07T23:59:50Z'), nextTimer = 0
  const realNow = Date.now, realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL
  Date.now = () => now
  URL.createObjectURL = blob => { const url = `blob:test-${created.length + 1}`; created.push({ url, blob }); return url }
  URL.revokeObjectURL = url => revoked.push(url)
  replace('setTimeout', (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id })
  replace('clearTimeout', id => timers.delete(id))
  class Observer {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this) }
    observe(target) { this.targets.add(target) }
    disconnect() { this.targets.clear() }
    unobserve(target) { this.targets.delete(target) }
  }
  replace('IntersectionObserver', observer ? Observer : undefined)
  dom.window.IntersectionObserver = observer ? Observer : undefined
  replace('fetch', async (url, options) => {
    requests.push({ url, ...options })
    return response ? response(requests.length, options) : new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
  })
  const { AttachedImage, createSessionApi, SessionContext } = loadSources()
  const api = createSessionApi('test-user', () => {})
  const subscribe = api.onResume
  let resumeListeners = 0
  if (subscribe) api.onResume = listener => {
    resumeListeners++
    const unsubscribe = subscribe(listener)
    let active = true
    return () => { if (active) { active = false; resumeListeners--; unsubscribe() } }
  }
  const root = createRoot(document.getElementById('root'))
  let current = { ...attachment }, onLoad = () => {}
  async function render(next = current, nextApi = api) {
    current = next
    await act(async () => root.render(React.createElement(SessionContext.Provider, { value: nextApi }, React.createElement(AttachedImage, { attachment: current, onLoad: () => onLoad() }))))
  }
  async function intersect(visible = true) {
    await act(async () => {
      for (const instance of observers) for (const target of [...instance.targets]) instance.callback([{ target, isIntersecting: visible }], instance)
    })
  }
  async function advance(milliseconds) {
    const until = now + milliseconds
    await act(async () => {
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry) break
        now = entry[1].at; timers.delete(entry[0]); entry[1].callback()
      }
      now = until
    })
  }
  return {
    api, createSessionApi, requests, revoked, created, observers, timers, render, intersect, advance,
    get resumeListeners() { return resumeListeners },
    get html() { return document.getElementById('root') }, setOnLoad(callback) { onLoad = callback },
    async dispose() {
      await act(async () => root.unmount())
      Date.now = realNow; URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
      dom.window.close()
    },
  }
}

async function withFixture(options, body) {
  const f = await fixture(options)
  try { await body(f) } finally { await f.dispose() }
}

for (const settlement of ['before resume', 'after resume']) test(`a generation-interrupted pending image automatically reauthorizes when rejected ${settlement}`, async () => {
  let resolveOld
  await withFixture({ response: n => n === 1 ? new Promise(resolve => { resolveOld = resolve }) : new Response('fresh protected bytes') }, async f => {
    await f.render(); await f.intersect()
    f.api.hold()
    if (settlement === 'after resume') await act(async () => f.api.resume())
    await act(async () => resolveOld(new Response('obsolete protected bytes')))
    assert.equal(f.created.length, settlement === 'before resume' ? 0 : 1, 'never turn an old-generation response into an object URL')
    if (settlement === 'before resume') {
      assert.equal(f.requests.length, 1, 'never request protected bytes while held')
      await act(async () => f.api.resume())
    }
    assert.equal(f.requests.length, 2, 'same-session resume must retry the interrupted visible request without a click')
    assert.ok(f.html.querySelector('img[src^="blob:"]'))
    assert.equal(await f.created[0].blob.text(), 'fresh protected bytes')
    for (const request of f.requests) assert.equal(request.headers.get(constants.EXPECTED_USER_HEADER), 'test-user')
    assert.notEqual(f.requests[0].signal, f.requests[1].signal)
  })
})

test('resume leaves loaded blobs, manual network failures, unseen images and terminal expiry alone', async () => {
  for (const kind of ['loaded', 'network', 'unseen', 'expired']) {
    await withFixture({ response: () => kind === 'network' ? new Response(JSON.stringify({ error: { code: 'NETWORK', message: 'offline' } }), { status: 503 }) : kind === 'expired' ? new Response(JSON.stringify({ error: { code: 'ATTACHMENT_EXPIRED', message: 'expired' } }), { status: 410 }) : new Response('valid bytes') }, async f => {
      await f.render()
      if (kind !== 'unseen') await f.intersect()
      const requests = f.requests.length, blob = f.html.querySelector('img')?.src
      await act(async () => { f.api.hold(); f.api.resume() })
      assert.equal(f.requests.length, requests, `${kind} must not refetch on resume`)
      if (blob) assert.equal(f.html.querySelector('img').src, blob)
      if (kind === 'network') assert.ok(f.html.querySelector('button'))
      if (kind === 'expired') assert.match(f.html.textContent, /图片已过期/)
    })
  }
})

test('pending image resume subscription is removed on unmount', async () => {
  const f = await fixture({ response: () => new Promise(() => {}) })
  try {
    await f.render(); await f.intersect()
    assert.equal(f.resumeListeners, 1, 'visible pending requests subscribe to the session resume boundary')
  } finally { await f.dispose() }
  assert.equal(f.resumeListeners, 0)
  f.api.hold(); f.api.resume()
  assert.equal(f.requests.length, 1)
})

test('no IntersectionObserver falls back to normal authenticated loading', async () => {
  await withFixture({ observer: false }, async f => {
    await f.render()
    assert.equal(f.requests.length, 1)
    assert.ok(f.html.querySelector('a.image-link > img'))
  })
})

for (const metadata of [{ expired: true }, { expiresAt: '2030-01-07T23:59:50Z' }]) {
  test(`known expiry never requests bytes: ${JSON.stringify(metadata)}`, async () => {
    await withFixture({}, async f => {
      await f.render({ ...attachment, ...metadata })
      await f.intersect()
      assert.equal(f.requests.length, 0)
      assert.match(f.html.textContent, /图片已过期/)
      assert.equal(f.html.querySelector('a, img, button'), null)
    })
  })
}

test('an unseen image expires before intersection without ever fetching', async () => {
  await withFixture({}, async f => {
    await f.render()
    await f.advance(10_000)
    assert.match(f.html.textContent, /图片已过期/)
    await f.intersect()
    assert.equal(f.requests.length, 0)
    assert.equal(f.html.querySelector('a, img, button'), null)
  })
})

test('the deadline clears rendered bytes and the preview link even after scrolling away', async () => {
  await withFixture({}, async f => {
    await f.render(); await f.intersect()
    const url = f.html.querySelector('a').href
    await f.intersect(false)
    await f.advance(9_999)
    assert.ok(f.html.querySelector('img'))
    await f.advance(1)
    assert.match(f.html.textContent, /图片已过期/)
    assert.equal(f.html.querySelector('a, img, button'), null)
    assert.deepEqual(f.revoked, [url])
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].signal.aborted, true)
  })
})

test('expiry aborts inflight work and rejects a late blob even if transport ignores abort', async () => {
  let resolve
  await withFixture({ response: () => new Promise(done => { resolve = done }) }, async f => {
    await f.render(); await f.intersect()
    await f.advance(10_000)
    assert.equal(f.requests[0].signal.aborted, true)
    await act(async () => resolve(new Response('late blob')))
    assert.equal(f.created.length, 0)
    assert.match(f.html.textContent, /图片已过期/)
    assert.equal(f.html.querySelector('a, img, button'), null)
  })
})

test('a network retry shows loading, keeps identity protection and produces a fresh blob', async () => {
  let resolveRetry
  await withFixture({ response: n => n === 1 ? new Response(JSON.stringify({ error: { code: 'NETWORK', message: 'retry' } }), { status: 503 }) : new Promise(done => { resolveRetry = done }) }, async f => {
    await f.render(); await f.intersect()
    assert.match(f.html.querySelector('button').textContent, /重试/)
    await act(async () => f.html.querySelector('button').click())
    assert.equal(f.requests.length, 2)
    assert.equal(f.html.querySelector('button, img, a'), null)
    assert.match(f.html.querySelector('[role=status]').textContent, /正在加载图片/)
    assert.notEqual(f.requests[0].signal, f.requests[1].signal)
    assert.equal(f.requests[0].signal.aborted, true)
    for (const request of f.requests) assert.equal(request.headers.get(constants.EXPECTED_USER_HEADER), 'test-user')
    await act(async () => resolveRetry(new Response('image')))
    assert.ok(f.html.querySelector('a > img'))
  })
})

test('decode failure retries release the previous object URL before showing loading', async () => {
  let resolveRetry
  await withFixture({ response: n => n === 1 ? new Response('image') : new Promise(done => { resolveRetry = done }) }, async f => {
    await f.render(); await f.intersect()
    const url = f.html.querySelector('a').href
    await act(async () => f.html.querySelector('img').dispatchEvent(new window.Event('error')))
    await act(async () => f.html.querySelector('button').click())
    assert.equal(f.html.querySelector('a, img, button'), null)
    assert.match(f.html.textContent, /正在加载图片/)
    assert.deepEqual(f.revoked, [url])
    await act(async () => resolveRetry(new Response('fixed image')))
    assert.notEqual(f.html.querySelector('a').href, url)
  })
})

for (const error of [{ code: 'ATTACHMENT_EXPIRED', status: 403 }, { code: 'GONE', status: 410 }]) {
  test(`server expiry is terminal: ${JSON.stringify(error)}`, async () => {
    await withFixture({ response: () => new Response(JSON.stringify({ error: { code: error.code, message: 'expired' } }), { status: error.status }) }, async f => {
      await f.render(); await f.intersect()
      assert.match(f.html.textContent, /图片已过期/)
      assert.equal(f.html.querySelector('a, img, button'), null)
      await f.intersect()
      assert.equal(f.requests.length, 1)
    })
  })
}

test('the pending sentinel reserves a box and loaded images keep image-link and onLoad', async () => {
  await withFixture({}, async f => {
    let loaded = 0; f.setOnLoad(() => loaded++)
    await f.render()
    const placeholder = f.html.querySelector('.image-link')
    assert.ok(placeholder)
    assert.equal(placeholder.style.minWidth, '48px')
    assert.equal(placeholder.style.minHeight, '48px')
    assert.equal(placeholder.querySelector('[role=status]').style.aspectRatio, '4 / 3')
    assert.equal(f.observers[0].options.rootMargin, '200px 0px')
    assert.ok(f.observers[0].targets.has(placeholder))
    await f.intersect()
    assert.equal(f.html.querySelector('a.image-link').getAttribute('aria-label'), '查看图片 photo.png')
    await act(async () => f.html.querySelector('img').dispatchEvent(new window.Event('load')))
    assert.equal(loaded, 1, 'Chat imageLoaded callback must still run')
  })
})

test('unsafe attachment URLs never reach the resource transport', async () => {
  await withFixture({}, async f => {
    await f.render({ ...attachment, url: 'https://other.test/api/attachments/image-1' })
    await f.intersect()
    assert.equal(f.requests.length, 0)
    assert.equal(f.html.querySelector('button, img, a'), null)
    assert.match(f.html.textContent, /图片暂不可用/)
  })
})

test('legacy attachments without a deadline still lazy load', async () => {
  await withFixture({}, async f => {
    await f.render({ ...attachment, expiresAt: undefined })
    assert.equal(f.requests.length, 0)
    await f.intersect()
    await f.advance(20_000)
    assert.ok(f.html.querySelector('img'))
    assert.equal(f.requests.length, 1)
  })
})

test('changing authenticated owner discards old bytes and requires a fresh protected request', async () => {
  await withFixture({}, async f => {
    await f.render(); await f.intersect()
    const url = f.html.querySelector('a').href
    const api = f.createSessionApi('replacement-user', () => {})
    await f.render(attachment, api)
    assert.equal(f.html.querySelector('a, img'), null)
    assert.ok(f.revoked.includes(url))
    assert.equal(f.requests.length, 1)
    await f.intersect()
    assert.equal(f.requests.length, 2)
    assert.equal(f.requests[1].headers.get(constants.EXPECTED_USER_HEADER), 'replacement-user')
  })
})

test('unmount disconnects the sentinel and clears timers, requests and object URLs', async () => {
  const f = await fixture()
  await f.render(); await f.intersect()
  const url = f.html.querySelector('a').href
  await f.dispose()
  assert.equal(f.requests[0].signal.aborted, true)
  assert.deepEqual(f.revoked, [url])
  assert.equal(f.timers.size, 0)
  assert.equal(f.observers[0].targets.size, 0)
})

test('replacement attachments wait for their own intersection and cannot retain an old blob', async () => {
  await withFixture({}, async f => {
    await f.render()
    await f.intersect()
    const oldUrl = f.html.querySelector('a').href
    await f.intersect(false)
    await f.render({ ...attachment, id: 'image-2', url: '/api/attachments/image-2', filename: 'next.png' })
    assert.equal(f.requests.length, 1, 'a replacement must not inherit the previous intersection')
    assert.equal(f.html.querySelector('a'), null)
    assert.ok(f.revoked.includes(oldUrl))
    await f.intersect()
    assert.equal(f.requests.length, 2)
    assert.equal(f.html.querySelector('img').alt, 'next.png')
  })
})

test('attachment network starts only after its placeholder enters the near viewport', async () => {
  await withFixture({}, async f => {
    await f.render()
    assert.equal(f.requests.length, 0, 'offscreen mount must not fetch attachment bytes')
    assert.equal(f.observers.length, 1)
    await f.intersect(false)
    assert.equal(f.requests.length, 0)
    await f.intersect()
    assert.equal(f.requests.length, 1)
    assert.ok(f.html.querySelector('img[src^="blob:"]'))
    assert.equal(f.requests[0].headers.get(constants.EXPECTED_USER_HEADER), 'test-user')
    assert.equal(f.requests[0].credentials, 'same-origin')
    await f.intersect(false)
    await f.intersect()
    assert.equal(f.requests.length, 1, 'scrolling does not unload or refetch')
  })
})
