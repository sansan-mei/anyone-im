import { test, expect, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'
test('optional account login, accessible profile dialog, theme preference and logout', async ({ page }) => {
  await fixture(page)
  await page.route('**/api/auth/login', route => route.fulfill({ json: { data: { user: { ...user, username: 'lin', isGuest: false } } } }))
  await page.route('**/api/me', route => route.fulfill({ json: { data: { ...user, displayName: route.request().postDataJSON().displayName, username: 'lin', isGuest: false } } }))
  await page.goto('/')
  await page.getByRole('button', { name: '账号登录', exact: true }).click()
  await page.getByLabel('用户名', { exact: true }).fill('lin')
  await page.getByLabel('密码', { exact: true }).fill('fixture password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: '个人设置' }).click()
  const dialog = page.getByRole('dialog', { name: '个人设置' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('显示名称').fill('林间新名字')
  await dialog.getByRole('button', { name: '保存名称' }).click()
  await expect(page.locator('.sidebar-footer strong')).toHaveText('林间新名字')
  await dialog.getByLabel('外观').selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: '个人设置' })).toBeFocused()
  await page.getByRole('button', { name: '个人设置' }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByLabel('你的称呼')).toBeVisible()
})
// Models the server's cookie-authoritative, expected-user precondition, including shared-tab cookies.
test('socket session mismatch invalidates the stale workspace rather than only showing offline', async ({ page }) => {
  await fixture(page, true)
  await page.routeWebSocket('**/socket.io/**', ws => {
    ws.send('0' + JSON.stringify({ sid: 'identity-test', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 32768 }))
    ws.onMessage(packet => { if (String(packet).startsWith('40')) ws.send('44' + JSON.stringify({ message: 'SESSION_CHANGED' })) })
  })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('会话已变化')
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
})
async function accountFixture(context: BrowserContext) {
  const peer = { ...user, id: 'fixture-B', displayName: '账户 B' }
  const attempts: { owner: string; expected?: string; text: string }[] = [], published: string[] = []
  let failSend = true
  await context.addCookies([{ name: 'fixture-owner', value: user.id, url: 'http://127.0.0.1:4101' }])
  await context.routeWebSocket('**/socket.io/**', ws => ws.close())
  await context.route('**/socket.io/**', route => route.fulfill({ status: 503, body: 'fixture realtime disabled' }))
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const owner = request.headers().cookie?.match(/fixture-owner=([^;]+)/)?.[1] || ''
    const current = owner === user.id ? user : owner === peer.id ? peer : null
    if (path === '/api/session') return route.fulfill({ json: { data: { user: current } } })
    if (path === '/api/auth/guest') return route.fulfill({ headers: { 'set-cookie': `fixture-owner=${peer.id}; Path=/; SameSite=Lax` }, json: { data: { user: peer } } })
    const expected = request.headers()['x-anyone-user-id']
    if (path.endsWith('/messages') && request.method() === 'POST') attempts.push({ owner, expected, text: request.postDataJSON().text })
    if (!expected) return route.fulfill({ status: 428, json: { error: { code: 'EXPECTED_USER_REQUIRED', message: 'Expected user required' } } })
    if (expected !== owner) return route.fulfill({ status: 409, json: { error: { code: 'SESSION_CHANGED', message: '会话已变化，请重新确认身份' } } })
    if (path === '/api/auth/logout') return route.fulfill({ headers: { 'set-cookie': 'fixture-owner=; Path=/; Max-Age=0' }, json: { data: null } })
    if (path === '/api/rooms') return route.fulfill({ json: { data: { rooms: [{ ...room, name: owner === user.id ? room.name : 'B 的房间' }] } } })
    if (path.endsWith('/messages') && request.method() === 'POST') {
      if (failSend) return route.fulfill({ status: 503, json: { error: { code: 'TEMP', message: '暂时无法发送' } } })
      const input = request.postDataJSON(); published.push(`${owner}:${input.text}`)
      return route.fulfill({ json: { data: { ...msg(1), ...input, sender: current } } })
    }
    if (path.endsWith('/messages')) return route.fulfill({ json: { data: { messages: [], hasMore: false } } })
    return route.fulfill({ json: { data: null } })
  })
  return { peer, attempts, published, allowSend: () => { failSend = false } }
}

test('cross-tab cookie switch never publishes A outbox content as B even without notification', async ({ page, context }) => {
  const server = await accountFixture(context)
  await page.goto('/')
  await expect(page.getByTestId('message-input')).toBeVisible()
  await page.getByTestId('message-input').fill('A 的私密待发送内容')
  await page.getByTestId('send-message').click()
  await expect(page.getByRole('button', { name: '重试发送' })).toBeVisible()
  const other = await context.newPage(); await other.goto('/')
  // A client that does not emit our notification changes the shared HttpOnly-style session.
  await other.evaluate(() => fetch('/api/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: '账户 B' }) }))
  server.allowSend()
  await page.getByRole('button', { name: '重试发送' }).click()
  await expect(page.getByRole('alert')).toContainText('会话已变化')
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
  expect(server.published).toEqual([])
  expect(server.attempts).toEqual([
    { owner: user.id, expected: user.id, text: 'A 的私密待发送内容' },
    { owner: server.peer.id, expected: user.id, text: 'A 的私密待发送内容' },
  ])
  const saved = await page.evaluate(id => JSON.parse(localStorage.getItem(`anyone.outbox.${id}`) || '[]'), user.id)
  expect(saved).toHaveLength(1)
  expect(saved[0].state).toBe('failed')
  await page.getByRole('button', { name: '重新确认身份' }).click()
  await expect(page.locator('.sidebar-footer strong')).toHaveText('账户 B')
  await expect(page.getByText('A 的私密待发送内容')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'B 的房间', exact: true })).toBeVisible()
  expect(server.published).toEqual([])
})

test('first-party logout and login in another tab immediately invalidate the old workspace without submitting its outbox', async ({ page, context }) => {
  const server = await accountFixture(context)
  await page.goto('/')
  await page.getByTestId('message-input').fill('仍属于 A 的发件箱')
  await page.getByTestId('send-message').click()
  await expect(page.getByRole('button', { name: '重试发送' })).toBeVisible()
  const other = await context.newPage(); await other.goto('/')
  await other.getByRole('button', { name: '个人设置' }).click()
  await other.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('会话已变化')
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
  await other.getByLabel('你的称呼').fill('账户 B')
  await other.getByTestId('guest-submit').click()
  await expect(other.locator('.sidebar-footer strong')).toHaveText('账户 B')
  await page.getByRole('button', { name: '重新确认身份' }).click()
  await expect(page.locator('.sidebar-footer strong')).toHaveText('账户 B')
  await expect(page.getByText('仍属于 A 的发件箱')).toHaveCount(0)
  expect(server.attempts).toHaveLength(1)
  expect(server.published).toEqual([])
  const eventValue = await page.evaluate(() => localStorage.getItem('anyone.account-change'))
  expect(eventValue).toBeTruthy()
  expect(eventValue).not.toContain(user.id)
  expect(eventValue).not.toContain(server.peer.id)
})

test('focus revalidation detects an unannounced account switch before showing another users rooms', async ({ page, context }) => {
  await accountFixture(context)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: room.name, exact: true })).toBeVisible()
  const other = await context.newPage(); await other.goto('/')
  await other.evaluate(() => fetch('/api/auth/guest', { method: 'POST', body: '{}' }))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('alert')).toContainText('会话已变化')
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
  await expect(page.getByText('B 的房间')).toHaveCount(0)
  await page.getByRole('button', { name: '重新确认身份' }).click()
  await expect(page.getByRole('heading', { name: 'B 的房间', exact: true })).toBeVisible()
})

test('reconnecting under B cannot merge B socket data into the A workspace while identity-bound reads are pending', async ({ page, context }) => {
  await accountFixture(context)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let switched = false
  await page.route('**/api/rooms', async route => { if (switched) await gate; await route.fallback() })
  const socket = await fixtureSocket(page, (_input, connection) => ({ messages: connection > 1 ? [msg(1, 'B 的私密实时内容')] : [], hasMore: false }))
  await page.goto('/')
  await expect.poll(() => socket.subscriptions.length).toBeGreaterThan(0)
  await page.evaluate(() => {
    (window as unknown as { leaked: boolean }).leaked = false
    new MutationObserver(() => { if (document.body.textContent?.includes('B 的私密实时内容')) (window as unknown as { leaked: boolean }).leaked = true }).observe(document.body, { childList: true, subtree: true })
  })
  const other = await context.newPage(); await other.goto('/')
  await other.evaluate(() => fetch('/api/auth/guest', { method: 'POST', body: '{}' }))
  switched = true
  const before = socket.connections(); socket.disconnect()
  await expect.poll(() => socket.connections()).toBeGreaterThan(before)
  // Let the socket acknowledge before releasing the rejected HTTP refresh.
  await page.waitForTimeout(150)
  const leaked = await page.evaluate(() => (window as unknown as { leaked: boolean }).leaked)
  release()
  await expect(page.getByRole('alert')).toContainText('会话已变化')
  expect(leaked).toBe(false)
  await expect(page.getByText('B 的私密实时内容')).toHaveCount(0)
})

for (const pending of ['upload', 'send', 'rooms'] as const) {
  test(`late A ${pending} response cannot mutate the replacement B workspace or submit A content`, async ({ page, context }) => {
    const server = await accountFixture(context)
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { started = resolve })
    let held = false
    const attachment = { id: '00000000-0000-4000-8000-000000000099', roomId: room.id, filename: 'A.png', mimeType: 'image/png', size: 4, url: '/api/attachments/A-image' }
    const path = pending === 'upload' ? '**/api/rooms/fixture-room/attachments' : pending === 'send' ? '**/api/rooms/fixture-room/messages' : '**/api/rooms'
    await page.route(path, async route => {
      if (held || (pending === 'send' && route.request().method() !== 'POST')) return route.fallback()
      held = true
      expect(route.request().headers()['x-anyone-user-id']).toBe(user.id)
      started(); await gate
      const data = pending === 'upload' ? attachment : pending === 'send' ? { ...msg(1, 'A 的异步私密内容'), ...route.request().postDataJSON(), sender: user } : { rooms: [{ ...room, name: 'A 的延迟房间' }] }
      await route.fulfill({ json: { data } })
    })
    await page.goto('/')
    if (pending === 'upload') {
      await page.getByTestId('message-input').fill('A 的异步私密内容')
      await page.getByLabel('选择图片').setInputFiles({ name: 'A.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) })
    } else if (pending === 'send') {
      await page.getByTestId('message-input').fill('A 的异步私密内容')
      await page.getByTestId('send-message').click()
    }
    await waiting
    const other = await context.newPage(); await other.goto('/')
    await other.getByRole('button', { name: '个人设置' }).click()
    await other.getByRole('button', { name: '退出登录', exact: true }).click()
    await other.getByLabel('你的称呼').fill('账户 B')
    await other.getByTestId('guest-submit').click()
    await expect(other.locator('.sidebar-footer strong')).toHaveText('账户 B')
    await expect(page.getByRole('alert')).toContainText('会话已变化')
    await page.getByRole('button', { name: '重新确认身份' }).click()
    await expect(page.locator('.sidebar-footer strong')).toHaveText('账户 B')
    release()
    await expect(page.getByRole('heading', { name: 'B 的房间', exact: true })).toBeVisible()
    await expect(page.getByText('A 的异步私密内容')).toHaveCount(0)
    await expect(page.getByText('A 的延迟房间')).toHaveCount(0)
    await expect(page.getByText('A.png')).toHaveCount(0)
    await expect(page.getByTestId('message-input')).toHaveValue('')
    server.allowSend()
    await page.getByTestId('message-input').fill('B 的新内容')
    await page.getByTestId('send-message').click()
    await expect.poll(() => server.published).toEqual([`${server.peer.id}:B 的新内容`])
    if (pending === 'send') {
      const saved = await page.evaluate(id => JSON.parse(localStorage.getItem(`anyone.outbox.${id}`) || '[]'), user.id)
      expect(saved).toHaveLength(1); expect(saved[0].state).toBe('failed')
    }
  })
}

// All identities and conversations in this file are isolated HTTP fixtures, never application seed data.
export const user = { id: 'fixture-me', displayName: '林间', username: null, isGuest: true }
export const room = { id: 'fixture-room', name: '设计讨论', description: '一起把想法变成现实', visibility: 'private', role: 'owner', memberCount: 1, onlineCount: 1, lastSeq: 0, lastReadSeq: 0, lastMessage: null, updatedAt: '2026-01-01T12:00:00Z' }
async function fixture(page: Page, authenticated = false) {
  let signedIn = authenticated
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return
    if (/^\/api\/auth\/(guest|register|login)$/.test(path)) { signedIn = true; expect(request.headers()['x-anyone-user-id']).toBeUndefined(); return }
    if (path !== '/api/session') expect(request.headers()['x-anyone-user-id']).toBe(user.id)
    if (path === '/api/auth/logout') signedIn = false
  })
  await page.routeWebSocket('**/socket.io/**', ws => ws.close())
  await page.route('**/socket.io/**', route => route.fulfill({status:503,body:'isolated fixture: realtime disabled'}))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method()
    let data: unknown = null
    if (path === '/api/session') data = { user: signedIn ? user : null }
    else if (path === '/api/auth/guest') { signedIn = true; data = { user: { ...user, displayName: route.request().postDataJSON().displayName } } }
    else if (path === '/api/rooms') data = { rooms: [room] }
    else if (path.endsWith('/messages')) data = { messages: [], hasMore: false }
    else if (path.endsWith('/members')) data = { members: [{ user, role: 'owner', online: true }] }
    await route.fulfill({ json: { data } })
  })
}
test('account registration sends only canonical credentials and name', async ({ page }) => {
  await fixture(page)
  await page.route('**/api/auth/register', async route => { expect(route.request().postDataJSON()).toEqual({ username: 'lin_12', password: 'long-fixture-password', displayName: '林间' }); await route.fulfill({ json: { data: { user: { ...user, username: 'lin_12', isGuest: false } } } }) })
  await page.goto('/')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await page.getByLabel('你的称呼').fill('林间')
  await page.getByLabel('用户名', { exact: true }).fill('lin_12')
  await page.getByLabel('密码', { exact: true }).fill('long-fixture-password')
  await page.getByRole('button', { name: '注册并进入' }).click()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  expect(await page.evaluate(() => Object.entries(localStorage).some(([k,v]) => /password|credential|session/.test(k) || v.includes('long-fixture-password')))).toBe(false)
})

test('room lifecycle: create private room, inspect live members, invite, revoke and remove member', async ({ page }) => {
  await fixture(page, true)
  const created = { ...room, id: 'fixture-created', name: '新项目', description: '项目协调', memberCount: 2 }
  const peer = { ...user, id: 'fixture-peer', displayName: '另一个成员' }
  await page.route('**/api/rooms', async route => {
    if (route.request().method() === 'POST') { expect(route.request().postDataJSON()).toEqual({ name: '新项目', description: '项目协调', visibility: 'private' }); return route.fulfill({ json: { data: created } }) }
    return route.fallback()
  })
  await page.route('**/api/rooms/fixture-created/members', route => route.fulfill({ json: { data: { members: [{ user, role: 'owner', online: true }, { user: peer, role: 'member', online: false }] } } }))
  await page.route('**/api/rooms/fixture-created/invites', route => route.fulfill({ json: { data: route.request().method() === 'POST' ? { code: 'fixture-code', urlPath: '/invite/fixture-code', expiresAt: '2026-01-02T12:00:00Z' } : { revoked: 1 } } }))
  await page.goto('/')
  await page.getByRole('button', { name: '新建房间' }).click()
  await page.getByLabel('房间名称').fill('新项目')
  await page.getByLabel('房间介绍').fill('项目协调')
  await page.getByRole('button', { name: '创建房间', exact: true }).click()
  await expect(page.getByRole('heading', { name: '新项目', exact: true })).toBeVisible()
  await page.getByTestId('room-actions').click()
  const dialog = page.getByRole('dialog', { name: '房间详情' })
  await expect(dialog.getByText('另一个成员')).toBeVisible()
  await dialog.getByRole('button', { name: '生成邀请链接' }).click()
  await expect(dialog.getByLabel('邀请链接')).toHaveValue('http://127.0.0.1:4101/invite/fixture-code')
  await dialog.getByRole('button', { name: '撤销全部邀请' }).click()
  await page.getByRole('button', { name: '确认撤销' }).click()
  await expect(dialog.getByLabel('邀请链接')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '撤销全部邀请' })).toBeFocused()
  await dialog.getByRole('button', { name: '移除 另一个成员' }).click()
  const kick = page.waitForRequest(r => r.url().endsWith('/members/fixture-peer') && r.method() === 'DELETE')
  await page.getByRole('button', { name: '确认移除' }).click(); await kick
})

test('public discovery joins only on request, search filters member rooms and nonowner can leave', async ({ page }) => {
  await fixture(page, true)
  const publicRoom = { ...room, id: 'fixture-public', visibility: 'public', role: 'member', name: '开放空间' }
  await page.route('**/api/rooms/public', route => route.fulfill({ json: { data: { rooms: [publicRoom] } } }))
  await page.route('**/api/rooms/fixture-public/join', route => route.fulfill({ json: { data: publicRoom } }))
  await page.goto('/')
  await page.getByRole('button', { name: '发现公开房间' }).click()
  await expect(page.getByRole('heading', { name: '发现公开房间' })).toBeVisible()
  await page.getByRole('button', { name: '加入 开放空间' }).click()
  await expect(page.getByRole('heading', { name: '开放空间', exact: true })).toBeVisible()
  await page.getByTestId('room-actions').click()
  await expect(page.getByRole('button', { name: '生成邀请链接' })).toHaveCount(0)
  await page.getByRole('button', { name: '离开房间', exact: true }).click()
  const left = page.waitForRequest(r => r.url().endsWith('/fixture-public/leave') && r.method() === 'POST')
  await page.getByRole('button', { name: '确认离开' }).click(); await left
  await expect(page.getByTestId('room-fixture-public')).toHaveCount(0)
  await page.getByLabel('搜索房间').fill('没有这个房间')
  await expect(page.getByText('没有匹配的会话')).toBeVisible()
})

test('invite URL survives guest onboarding and joins only after confirmation', async ({ page }) => {
  await fixture(page)
  await page.route('**/api/invites/fixture-bearer', route => route.fulfill({ json: { data: route.request().method() === 'GET' ? { roomId: 'fixture-invited', roomName: '受邀空间', expiresAt: '2026-01-02T12:00:00Z' } : { ...room, id: 'fixture-invited', name: '受邀空间', role: 'member' } } }))
  await page.goto('/invite/fixture-bearer')
  await page.getByLabel('你的称呼').fill('林间')
  await page.getByTestId('guest-submit').click()
  await expect(page.getByRole('dialog', { name: '你收到了一份邀请' })).toBeVisible()
  await page.getByRole('button', { name: '加入受邀房间' }).click()
  await expect(page.getByRole('heading', { name: '受邀空间', exact: true })).toBeVisible()
  await expect(page).toHaveURL('/')
})

test('mobile 320px has separate room list, safe composer, back navigation and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await fixture(page, true); await page.goto('/')
  await expect(page.getByTestId('room-list')).toBeVisible()
  await page.getByTestId('room-fixture-room').click()
  await expect(page.getByTestId('chat-panel')).toBeVisible()
  await expect(page.getByTestId('room-list')).not.toBeVisible()
  const input = await page.getByTestId('message-input').boundingBox()
  expect(input!.y + input!.height).toBeLessThanOrEqual(568)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByTestId('mobile-back').click()
  await expect(page.getByTestId('room-list')).toBeVisible()
  await page.screenshot({ path: 'test-results/mobile-rooms-320.png' })
})

const msg = (seq: number, text = `历史消息 ${seq}`) => ({ id: `fixture-msg-${seq}`, roomId: room.id, seq, clientMessageId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, sender: { ...user, id: 'fixture-other', displayName: '对方' }, text, attachment: null, createdAt: '2026-01-01T12:00:00Z', deletedAt: null })
async function fixtureSocket(page: Page, onSubscribe: (input: { roomId: string; afterSeq?: number }, connection: number) => { messages: unknown[]; hasMore: boolean } = () => ({ messages: [], hasMore: false })) {
  let socket: WebSocketRoute | undefined, connections = 0
  const subscriptions: {roomId: string; afterSeq?: number}[] = []
  await page.routeWebSocket('**/socket.io/**', ws => {
    let connection = 0
    ws.send('0' + JSON.stringify({ sid: 'fixture-engine', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 }))
    ws.onMessage(packet => {
      const p = String(packet)
      if (p.startsWith('40')) { socket = ws; connection = ++connections; ws.send('40' + JSON.stringify({ sid: `fixture-socket-${connection}` })) }
      if (p === '3') return
      const match = p.match(/^42(\d+)(.*)$/)
      if (match) { const [event, input] = JSON.parse(match[2]); if (event === 'room:subscribe') { subscriptions.push(input); ws.send(`43${match[1]}${JSON.stringify([{data: onSubscribe(input, connection)}])}`) } }
    })
  })
  return { subscriptions, emit: (event: string, data: unknown) => socket?.send('42' + JSON.stringify([event, data])), disconnect: () => socket?.close(), connections: () => connections }
}

test('realtime reconciles HTTP and socket duplicates, reconnect backfills all pages, removal revokes UI', async ({ page }) => {
  await fixture(page, true)
  await page.route('**/api/rooms/fixture-room/messages*', route => route.fulfill({ json: { data: { messages: [msg(1)], hasMore: false } } }))
  const socket = await fixtureSocket(page, (input, connection) => ({ messages: connection > 1 ? [msg(1), msg(2, '离线期间的消息')] : [msg(1)], hasMore: false }))
  await page.goto('/')
  await expect(page.getByText('历史消息 1', { exact: true })).toHaveCount(1)
  await expect.poll(() => socket.subscriptions.length).toBeGreaterThan(0)
  socket.emit('message:new', msg(1))
  await expect(page.getByText('历史消息 1', { exact: true })).toHaveCount(1)
  const beforeReconnect = socket.connections(); socket.disconnect()
  await expect.poll(() => socket.connections()).toBeGreaterThan(beforeReconnect)
  await expect(page.getByText('离线期间的消息', { exact: true })).toHaveCount(1)
  expect(socket.subscriptions.some(s => s.afterSeq === 1)).toBe(true)
  socket.emit('message:new', msg(3, '即时新消息'))
  await expect(page.getByText('即时新消息', { exact: true })).toHaveCount(1)
  socket.emit('message:deleted', {roomId: room.id, messageId: 'fixture-msg-3', seq: 3})
  await expect(page.getByText('即时新消息', { exact: true })).toHaveCount(0)
  socket.emit('room:removed', {roomId: room.id, reason: 'kicked'})
  await expect(page.getByTestId('room-fixture-room')).toHaveCount(0)
})

test('older pagination preserves viewport, new messages never pull history reader to bottom; read only at bottom', async ({ page }) => {
  await fixture(page, true)
  const reads: number[] = []
  await page.route('**/api/rooms/fixture-room/read', async route => { reads.push(route.request().postDataJSON().seq); await route.fulfill({json:{data:null}}) })
  await page.route('**/api/rooms/fixture-room/messages*', async route => { const old = new URL(route.request().url()).searchParams.has('beforeSeq'); await route.fulfill({ json: { data: { messages: Array.from({length: 30}, (_,i) => msg(i + (old ? 1 : 31))), hasMore: !old } } }) })
  const socket = await fixtureSocket(page)
  await page.goto('/')
  await expect(page.getByText('历史消息 60', { exact:true })).toBeVisible()
  const list = page.getByTestId('message-list')
  await list.evaluate(el => {el.scrollTop = 0})
  await page.getByRole('button', {name:'加载更早消息'}).click()
  await expect(page.getByText('历史消息 1', {exact:true})).toHaveCount(1)
  expect(await list.evaluate(el => el.scrollTop)).toBeGreaterThan(100)
  const before = await list.evaluate(el => el.scrollTop), beforeReads = reads.length
  socket.emit('message:new', msg(61, '历史浏览期间的新消息'))
  await expect(page.getByText('历史浏览期间的新消息', {exact:true})).toHaveCount(1)
  expect(Math.abs((await list.evaluate(el => el.scrollTop)) - before)).toBeLessThan(5)
  expect(reads.length).toBe(beforeReads)
  await page.getByRole('button', {name:'回到最新消息'}).click()
  await expect.poll(() => reads.at(-1)).toBe(61)
})

test('image upload is HTTP multipart, preview and send use server attachment, paste and validation keep text draft', async ({ page }) => {
  await fixture(page, true)
  const attachment = { id: '00000000-0000-4000-8000-000000000099', roomId: room.id, filename: 'fixture.png', mimeType: 'image/png', size: 68, url: '/api/attachments/fixture-image' }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cWQAAAAASUVORK5CYII=', 'base64')
  let uploads = 0
  await page.route('**/api/attachments/fixture-image', route => { expect(route.request().headers()['x-anyone-user-id']).toBe(user.id); return route.fulfill({ contentType: 'image/png', body: png }) })
  await page.route('**/api/rooms/fixture-room/attachments', async route => { uploads++; expect(route.request().headers()['content-type']).toContain('multipart/form-data'); await route.fulfill({ json:{data:attachment} }) })
  await page.route('**/api/rooms/fixture-room/messages', async route => { if (route.request().method() !== 'POST') return route.fallback(); const input = route.request().postDataJSON(); expect(input.attachmentId).toBe(attachment.id); await route.fulfill({ json:{data:{...msg(1),...input,sender:user,attachment}} }) })
  await page.goto('/')
  await page.getByTestId('message-input').fill('保留这个草稿')
  await page.getByLabel('选择图片').setInputFiles({ name:'bad.svg', mimeType:'image/svg+xml', buffer:Buffer.from('<svg/>') })
  await expect(page.getByText('请选择 PNG、JPEG 或 WebP 图片')).toBeVisible()
  await expect(page.getByTestId('message-input')).toHaveValue('保留这个草稿')
  await page.getByLabel('选择图片').setInputFiles({ name:'fixture.png', mimeType:'image/png', buffer:png })
  await expect(page.getByText('图片已就绪')).toBeVisible()
  await page.getByTestId('send-message').click()
  const image = page.locator('.bubble img')
  await expect(image).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await page.getByTestId('message-input').evaluate(el => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137,80,78,71])], 'paste.png', {type:'image/png'})); el.dispatchEvent(new ClipboardEvent('paste', {clipboardData:dt,bubbles:true,cancelable:true})) })
  await expect.poll(() => uploads).toBe(2)
  await page.screenshot({ path:'test-results/desktop-image-chat.png' })
})

test('message deletion asks confirmation and only sender or owner receives controls', async ({ page }) => {
  await fixture(page, true)
  await page.route('**/api/rooms', route => route.fulfill({json:{data:{rooms:[{...room,role:'member'}]}}}))
  await page.route('**/api/rooms/fixture-room/messages*', route => route.fulfill({json:{data:{messages:[msg(1),{...msg(2,'我的消息'),sender:user}],hasMore:false}}}))
  await page.goto('/')
  await expect(page.getByRole('button', {name:'删除消息'})).toHaveCount(1)
  await page.getByRole('button', {name:'删除消息'}).click()
  const deletion = page.waitForRequest(r => r.url().endsWith('/api/messages/fixture-msg-2') && r.method() === 'DELETE')
  await page.getByRole('button', {name:'确认删除'}).click(); await deletion
  await expect(page.getByText('我的消息',{exact:true})).toHaveCount(0)
  await expect(page.getByText('消息已删除',{exact:true})).toHaveCount(1)
  await expect(page.getByText('历史消息 1',{exact:true})).toBeVisible()
})

test('room loading errors have retry and recover to a truthful empty state', async ({ page }) => {
  await fixture(page, true)
  let fail = true
  await page.route('**/api/rooms', route => fail ? route.fulfill({status:503,json:{error:{code:'TEMP',message:'房间暂时无法读取'}}}) : route.fulfill({json:{data:{rooms:[]}}}))
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('房间暂时无法读取')
  fail = false
  await page.getByRole('button', {name:'重新加载房间'}).click()
  await expect(page.getByText('还没有加入房间')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('unread positions stay per room and mobile shows offline state while composer remains usable', async ({ page }) => {
  await fixture(page, true)
  const other = {...room,id:'fixture-other-room',name:'另一个房间',lastSeq:3,lastReadSeq:1}
  await page.route('**/api/rooms', route => route.fulfill({json:{data:{rooms:[room,other]}}}))
  const reads: string[] = []
  await page.route('**/api/rooms/*/read', async route => { reads.push(route.request().url()); await route.fulfill({json:{data:null}}) })
  const socket = await fixtureSocket(page)
  await page.goto('/')
  await expect(page.getByTestId('room-fixture-other-room').getByLabel('2 条未读')).toBeVisible()
  await expect(page.locator('.connection.connected')).toBeVisible()
  socket.emit('message:new', {...msg(4),roomId:other.id})
  await expect(page.getByTestId('room-fixture-other-room').getByLabel('3 条未读')).toBeVisible()
  expect(reads.some(url => url.includes(other.id))).toBe(false)
  await page.setViewportSize({width:320,height:568})
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(page.getByTestId('chat-panel').getByText('连接中断，未发送消息会保留在本机')).toBeVisible()
  await expect(page.getByTestId('message-input')).toBeEditable()
})

test('system dark theme uses readable foreground tokens; narrow chat and dialogs fit the viewport', async ({ page }) => {
  await page.emulateMedia({colorScheme:'dark'}); await fixture(page, true)
  await page.route('**/api/rooms/fixture-room/messages*', route => route.fulfill({json:{data:{messages:[msg(1,'一条用于布局验证的真实测试夹具。'.repeat(8))],hasMore:false}}}))
  await page.goto('/')
  await expect(page.getByTestId('app-shell')).toHaveCSS('color','rgb(226, 234, 235)')
  await expect(page.getByTestId('send-message')).toHaveCSS('color','rgb(14, 40, 37)')
  await page.screenshot({path:'test-results/desktop-dark.png'})
  await page.setViewportSize({width:320,height:568})
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({path:'test-results/mobile-chat-dark-320.png'})
  await page.getByTestId('room-actions').click()
  const dialog = await page.getByRole('dialog',{name:'房间详情'}).boundingBox()
  expect(dialog!.width).toBeLessThanOrEqual(320)
  await page.screenshot({path:'test-results/mobile-details-dark-320.png'})
})

test('mobile controls keep 44px touch targets and muted text meets small-text contrast', async ({ page }) => {
  await fixture(page, true); await page.setViewportSize({width:320,height:568}); await page.goto('/')
  await expect(page.getByTestId('app-shell')).toBeVisible(); await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(page.getByRole('button',{name:'重连',exact:true}).first()).toBeVisible()
  const undersized = await page.locator('button').evaluateAll(nodes => nodes.filter(node => { const r=node.getBoundingClientRect(); return r.width>0 && r.height>0 && (r.width<44 || r.height<44) }).map(node=>node.textContent || node.getAttribute('aria-label')))
  expect(undersized).toEqual([])
  await expect(page.locator('.room-copy>span')).toHaveCSS('color','rgb(94, 110, 117)')
})

test('reduced visual viewport keeps composer and form dialog above mobile keyboard', async ({ page }) => {
  await fixture(page, true); await page.setViewportSize({width:320,height:568}); await page.goto('/')
  await page.getByTestId('room-fixture-room').click()
  await page.evaluate(() => { Object.defineProperty(window.visualViewport,'height',{configurable:true,value:320}); window.visualViewport?.dispatchEvent(new Event('resize')) })
  await expect.poll(async () => { const b=await page.getByTestId('message-input').boundingBox(); return b!.y+b!.height }).toBeLessThanOrEqual(320)
  await page.getByTestId('mobile-back').click()
  await page.getByRole('button',{name:'新建房间'}).click()
  const dialog = await page.getByRole('dialog',{name:'新建房间'}).boundingBox()
  expect(dialog!.y+dialog!.height).toBeLessThanOrEqual(320)
  await page.screenshot({path:'test-results/mobile-keyboard-dialog-320.png'})
})

test('reconnect refreshes cached tombstones, not only messages after the cursor', async ({ page }) => {
  await fixture(page, true)
  let deletedOnServer = false
  await page.route('**/api/rooms/fixture-room/messages*', route => route.fulfill({json:{data:{messages:[{...msg(1,'离线期间删除'), deletedAt: deletedOnServer ? '2026-01-01T13:00:00Z' : null}, msg(2)],hasMore:false}}}))
  const socket = await fixtureSocket(page)
  await page.goto('/')
  await expect.poll(() => socket.subscriptions.length).toBeGreaterThan(0)
  await expect(page.getByText('离线期间删除',{exact:true})).toBeVisible()
  deletedOnServer = true; const before = socket.connections(); socket.disconnect()
  await expect.poll(() => socket.connections()).toBeGreaterThan(before)
  await expect(page.getByText('离线期间删除',{exact:true})).toHaveCount(0)
  await expect(page.getByText('消息已删除',{exact:true})).toHaveCount(1)
})

test('guest onboarding uses real endpoint, shows actual empty room without invented conversation', async ({ page }) => {
  await fixture(page)
  await page.goto('/')
  await page.getByLabel('你的称呼').fill('林间')
  const request = page.waitForRequest(r => r.url().endsWith('/api/auth/guest') && r.method() === 'POST')
  await page.getByRole('button', { name: '以访客身份进入' }).click()
  expect((await request).postDataJSON()).toEqual({ displayName: '林间' })
  await expect(page.getByRole('heading', { name: '设计讨论', exact: true })).toBeVisible()
  await expect(page.getByText('从第一句开始')).toBeVisible()
})

test('failed send persists across reload and retries stable id; composition Enter does not send; text stays escaped', async ({ page }) => {
  await fixture(page, true)
  const attempts: Record<string, unknown>[] = []
  await page.route('**/api/rooms/fixture-room/messages', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON(); attempts.push(body)
    if (attempts.length === 1) return route.fulfill({ status: 503, json: { error: { code: 'TEMP', message: '暂时无法发送' } } })
    await route.fulfill({ json: { data: { id: 'fixture-message', roomId: room.id, seq: 1, ...body, sender: user, attachment: null, createdAt: '2026-01-01T12:00:00Z', deletedAt: null } } })
  })
  await page.goto('/')
  const input = page.getByLabel('输入消息')
  await input.fill('<img src=x onerror=alert(1)>')
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  expect(attempts).toHaveLength(0)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '重试发送' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '重试发送' })).toBeVisible()
  await page.getByRole('button', { name: '重试发送' }).click()
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '重试发送' })).toHaveCount(0)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toEqual(attempts[1])
  expect(Object.keys(attempts[0]).sort()).toEqual(['clientMessageId', 'text'])
  await expect(page.locator('.bubble img')).toHaveCount(0)
})
