import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const require = createRequire(process.env.IMAGE_TEST_TOOLS ? path.join(process.env.IMAGE_TEST_TOOLS, 'package.json') : import.meta.url)
const ts = require('typescript'), React = require('react')
const { act } = React, { createRoot } = require('react-dom/client'), { JSDOM } = require('jsdom')

// Execute the actual RoomDetails component; only the animation/focus primitive and transport
// are replaced. The companion browser regression exercises the real portal focus scope.
test('closing RoomDetails also closes an already-open action confirmation', async () => {
  const file = fileURLToPath(new URL('../src/RoomDetails.tsx', import.meta.url))
  const output = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://session.test/' })
  const saved = new Map()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const module = { exports: {} }
  const localRequire = id => {
    if (id === './SessionContext') return { useApi: () => async () => ({ members: [] }) }
    if (id === './api') return { errorText: String }
    if (id === './Modal') return { Modal: ({ open, title, children }) => open ? React.createElement('section', { role: 'dialog', 'aria-label': title }, children) : null }
    if (id === 'lucide-react') return new Proxy({}, { get: () => () => null })
    return require(id)
  }
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename: file })(localRequire, module, module.exports)
  const root = createRoot(document.getElementById('root'))
  const props = { room: { id: 'room', role: 'member', name: 'Room', memberCount: 1 }, user: { id: 'alice' }, onOpenChange() {}, onChanged() {}, onLeft() {} }
  const render = open => act(async () => root.render(React.createElement(module.exports.RoomDetails, { ...props, open })))
  try {
    await render(true)
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '离开房间').click())
    assert.equal(document.querySelectorAll('[role=dialog]').length, 2)
    await render(false)
    assert.equal(document.querySelectorAll('[role=dialog]').length, 0, 'a paused parent must release the nested confirmation scope')
    await render(true)
    assert.equal(document.querySelectorAll('[role=dialog]').length, 1, 'resume must not restore a destructive confirmation focus scope')
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '离开房间').click())
    assert.equal(document.querySelectorAll('[role=dialog]').length, 2, 'the user can explicitly reopen a fresh confirmation')
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
    dom.window.close()
  }
})
