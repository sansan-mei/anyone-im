import { test, expect } from '@playwright/test'

// Full Chromium supports native persistent notifications; headless-shell does not.
test.use({ channel: 'chromium' })

test('returning to foreground during notification validation cancels the delayed alert', async ({ page, browser, context }) => {
  await context.grantPermissions(['notifications'], { origin: 'http://127.0.0.1:4190' })
  const peer = await browser.newContext()
  let release = () => {}
  try {
    const origin = { Origin: 'http://127.0.0.1:4190' }
    const me = (await (await context.request.post('/api/auth/guest', { headers: origin, data: { displayName: '通知竞态接收者' } })).json()).data.user.id
    const sender = (await (await peer.request.post('/api/auth/guest', { headers: origin, data: { displayName: '通知竞态发送者' } })).json()).data.user.id
    await page.goto('/')
    await expect(page.locator('.connection.connected')).toBeVisible()
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.getByRole('button', { name: '个人设置' }).click()
    await page.getByRole('button', { name: '开启消息通知' }).click()
    await expect(page.getByRole('button', { name: '关闭消息通知' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }))
    let started!: () => void, completed!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { completed = resolve })
    await page.route('**/api/session', async route => {
      if (route.request().headers()['x-anyone-user-id'] !== me) return route.continue()
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response }); completed()
    })
    expect((await peer.request.post('/api/rooms/lobby/messages', { headers: { ...origin, 'X-Anyone-User-Id': sender }, data: { text: '回前台后无需提醒', clientMessageId: crypto.randomUUID() } })).ok()).toBe(true)
    await waiting
    await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true }))
    release(); await done
    // Negative assertion: allow the released async browser notification work to settle.
    await page.waitForTimeout(300)
    expect(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length)).toBe(0)
  } finally { release(); await peer.close() }
})

test('logout and account switch close notifications and cancel delayed old-user notification work', async ({ page, browser, context }) => {
  await context.grantPermissions(['notifications'], { origin: 'http://127.0.0.1:4190' })
  const peer = await browser.newContext()
  let release = () => {}
  try {
    const origin = { Origin: 'http://127.0.0.1:4190' }
    const me = (await (await context.request.post('/api/auth/guest', { headers: origin, data: { displayName: '账户 A' } })).json()).data.user.id
    const sender = (await (await peer.request.post('/api/auth/guest', { headers: origin, data: { displayName: '对方' } })).json()).data.user.id
    await page.goto('/')
    await expect(page.locator('.connection.connected')).toBeVisible()
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.getByRole('button', { name: '个人设置' }).click()
    await page.getByRole('button', { name: '开启消息通知' }).click()
    await expect(page.getByRole('button', { name: '关闭消息通知' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }))
    const send = async (text: string) => expect((await peer.request.post('/api/rooms/lobby/messages', { headers: { ...origin, 'X-Anyone-User-Id': sender }, data: { text, clientMessageId: crypto.randomUUID() } })).ok()).toBe(true)
    const count = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length)
    await send('旧账户的第一条通知')
    await expect.poll(count).toBe(1)
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    await page.route('**/api/session', async route => {
      if (route.request().headers()['x-anyone-user-id'] !== me) return route.continue()
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response })
    })
    await send('账户切换过程中不得展示')
    await waiting
    const otherTab = await context.newPage(); await otherTab.goto('/')
    await otherTab.getByRole('button', { name: '个人设置' }).click()
    await otherTab.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('会话已变化')
    await expect.poll(count).toBe(0)
    await otherTab.getByLabel('你的称呼').fill('账户 B')
    await otherTab.getByTestId('guest-submit').click()
    await otherTab.getByRole('button', { name: '个人设置' }).click()
    await expect(otherTab.getByRole('button', { name: '开启消息通知' })).toHaveAttribute('aria-pressed', 'false')
    release()
    await expect.poll(count).toBe(0)
    await expect(page.getByTestId('app-shell')).toHaveCount(0)
  } finally { release(); await peer.close() }
})

test('offline shell never caches authenticated data or fabricates a signed-in chat', async ({ page, context }) => {
  await page.goto('/')
  await page.getByLabel('你的称呼').fill('离线缓存测试')
  await page.getByTestId('guest-submit').click()
  await expect(page.getByTestId('message-input')).toBeVisible()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await page.evaluate(async () => { await fetch('/api/session'); await fetch('/api/rooms'); await fetch('/api/attachments/private-do-not-cache'); await fetch('/socket.io/?EIO=4&transport=polling') })
  const keys = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(r => new URL(r.url).pathname)))).flat().sort())
  expect(keys).toEqual(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/offline.html'])
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: '暂时无法连接' })).toBeVisible()
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
  await expect(page.getByText('离线缓存测试', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('offline-shell.png') })
})

test('install prompt received before login is retained until explicit install action', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('你的称呼').fill('安装前置事件')
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(event, { prompt: async () => { (window as unknown as { prompts: number }).prompts = 1 }, userChoice: Promise.resolve({ outcome: 'dismissed' }) })
    window.dispatchEvent(event)
  })
  await page.getByTestId('guest-submit').click()
  await page.getByRole('button', { name: '个人设置' }).click()
  await page.getByRole('button', { name: '安装到桌面' }).click()
  expect(await page.evaluate(() => (window as unknown as { prompts: number }).prompts)).toBe(1)
})

test('notification navigation selects a current member room without trusting stale identities', async ({ page, context }) => {
  const response = await context.request.post('/api/auth/guest', { headers: { Origin: 'http://127.0.0.1:4190' }, data: { displayName: '通知导航' } })
  const userId = (await response.json()).data.user.id
  const created = await context.request.post('/api/rooms', { headers: { Origin: 'http://127.0.0.1:4190', 'X-Anyone-User-Id': userId }, data: { name: '通知目标房间', description: '', visibility: 'private' } })
  const roomId = (await created.json()).data.id
  await page.goto(`/?room=${roomId}`)
  await expect(page.getByRole('heading', { name: '通知目标房间', exact: true })).toBeVisible()
  await page.getByTestId('room-list').getByRole('button').filter({ hasNotText: '通知目标房间' }).first().click()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  const event = async (ownerId: string) => page.evaluate(({ ownerId, roomId }) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: navigator.serviceWorker.controller, data: { type: 'notification-room', roomId, ownerId } })), { ownerId, roomId })
  await event('previous-account')
  await expect(page.getByRole('heading', { name: '通知目标房间', exact: true })).toHaveCount(0)
  await event(userId)
  await expect(page.getByRole('heading', { name: '通知目标房间', exact: true })).toBeVisible()
})

for (const modal of ['create', 'discover', 'invite', 'profile', 'details'] as const) {
  test(`notification navigation dismisses ${modal} without losing create drafts or trusting invalid events`, async ({ page, context, browser }) => {
    const origin = { Origin: 'http://127.0.0.1:4190' }
    const me = (await (await context.request.post('/api/auth/guest', { headers: origin, data: { displayName: '弹窗导航接收者' } })).json()).data.user.id
    const created = await context.request.post('/api/rooms', { headers: { ...origin, 'X-Anyone-User-Id': me }, data: { name: `通知目标-${modal}`, description: '', visibility: 'private' } })
    const roomId = (await created.json()).data.id
    const peer = await browser.newContext()
    let path = '/?keep=safe#anchor'
    try {
      if (modal === 'invite') {
        const owner = (await (await peer.request.post('/api/auth/guest', { headers: origin, data: { displayName: '邀请房主' } })).json()).data.user.id
        const headers = { ...origin, 'X-Anyone-User-Id': owner }
        const invitationRoom = (await (await peer.request.post('/api/rooms', { headers, data: { name: '尚未接受的受邀房间', description: '', visibility: 'private' } })).json()).data.id
        const code = (await (await peer.request.post(`/api/rooms/${invitationRoom}/invites`, { headers, data: {} })).json()).data.code
        path = `/invite/${code}?keep=safe#anchor`
      }
      await page.goto(path)
      await expect(page.locator('.connection.connected')).toBeVisible()
      await page.evaluate(() => navigator.serviceWorker.ready)
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
      if (modal !== 'invite') {
        await page.getByTestId('room-lobby').click()
        const button = { create: '新建房间', discover: '发现公开房间', profile: '个人设置', details: '房间详情' }[modal]
        await page.getByRole('button', { name: button, exact: true }).click()
      }
      await expect(page.getByRole('dialog')).toBeVisible()
      if (modal === 'create') {
        await page.getByLabel('房间名称').fill('未提交的房间草稿')
        await page.getByLabel('房间介绍').fill('切换通知后仍应保留')
        await page.getByRole('radio', { name: /公开房间/ }).check()
      }
      const event = (ownerId: string, target = roomId) => page.evaluate(({ ownerId, roomId }) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: navigator.serviceWorker.controller, data: { type: 'notification-room', roomId, ownerId } })), { ownerId, roomId: target })
      await event('previous-account')
      await event(me, 'not-a-member-room')
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page).toHaveURL(`http://127.0.0.1:4190${path}`)
      await event(me)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('heading', { name: `通知目标-${modal}`, exact: true })).toBeVisible()
      await expect(page.getByTestId('message-input')).toBeEditable()
      await expect(page).toHaveURL(`http://127.0.0.1:4190${modal === 'invite' ? '/' : path}`)
      if (modal === 'create') {
        await page.getByRole('button', { name: '新建房间', exact: true }).click()
        await expect(page.getByLabel('房间名称')).toHaveValue('未提交的房间草稿')
        await expect(page.getByLabel('房间介绍')).toHaveValue('切换通知后仍应保留')
        await expect(page.getByRole('radio', { name: /公开房间/ })).toBeChecked()
      }
      if (modal === 'invite') {
        await page.reload()
        await expect(page.getByTestId('message-input')).toBeVisible()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page.getByTestId('room-list')).not.toContainText('尚未接受的受邀房间')
      }
    } finally { await peer.close() }
  })
}

test('summary refresh before a delayed realtime frame still notifies exactly once', async ({ page, context, browser }) => {
  await context.grantPermissions(['notifications'], { origin: 'http://127.0.0.1:4190' })
  const peer = await browser.newContext()
  let release = () => {}
  try {
    const origin = { Origin: 'http://127.0.0.1:4190' }
    await context.request.post('/api/auth/guest', { headers: origin, data: { displayName: '摘要竞态接收者' } })
    const sender = (await (await peer.request.post('/api/auth/guest', { headers: origin, data: { displayName: '摘要竞态发送者' } })).json()).data.user.id
    await page.addInitScript(() => {
      const show = ServiceWorkerRegistration.prototype.showNotification
      ;(window as unknown as { notificationCalls: number }).notificationCalls = 0
      ServiceWorkerRegistration.prototype.showNotification = function(...args) { (window as unknown as { notificationCalls: number }).notificationCalls++; return show.apply(this, args) }
    })
    let held!: () => void
    const frameHeld = new Promise<void>(resolve => { held = resolve })
    await page.routeWebSocket('**/socket.io/**', socket => {
      const server = socket.connectToServer()
      server.onMessage(packet => {
        if (String(packet).startsWith('42["message:new"')) {
          release = () => { socket.send(packet); socket.send(packet) }; held()
        } else socket.send(packet)
      })
    })
    await page.goto('/')
    await expect(page.locator('.connection.connected')).toBeVisible()
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.getByRole('button', { name: '个人设置' }).click()
    await page.getByRole('button', { name: '开启消息通知' }).click()
    await expect(page.getByRole('button', { name: '关闭消息通知' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }))
    const text = `摘要先到-${crypto.randomUUID()}`
    const response = await peer.request.post('/api/rooms/lobby/messages', { headers: { ...origin, 'X-Anyone-User-Id': sender }, data: { text, clientMessageId: crypto.randomUUID() } })
    expect(response.ok()).toBe(true)
    const message = (await response.json()).data
    await frameHeld
    // The real room:updated frame is not held: wait for its HTTP summary to render first.
    await expect(page.getByTestId('room-lobby')).toContainText(text)
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toHaveCount(0)
    release()
    await expect(page.getByText(text, { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length)).toBe(1)
    expect(await page.evaluate(() => (window as unknown as { notificationCalls: number }).notificationCalls)).toBe(1)
  } finally { await peer.close() }
})

test('obsolete reconnect snapshot cannot swallow a delayed live notification from the replacement connection', async ({ page, context, browser }) => {
  await context.grantPermissions(['notifications'], { origin: 'http://127.0.0.1:4190' })
  const peer = await browser.newContext()
  let releaseRequest = () => {}, releaseFrame = () => {}
  try {
    const origin = { Origin: 'http://127.0.0.1:4190' }
    const me = (await (await context.request.post('/api/auth/guest', { headers: origin, data: { displayName: '重叠重连接收者' } })).json()).data.user.id
    const sender = (await (await peer.request.post('/api/auth/guest', { headers: origin, data: { displayName: '重叠重连发送者' } })).json()).data.user.id
    const headers = { ...origin, 'X-Anyone-User-Id': me }
    const roomId = (await (await context.request.post('/api/rooms', { headers, data: { name: '重叠重连隔离房间', description: '', visibility: 'private' } })).json()).data.id
    const code = (await (await context.request.post(`/api/rooms/${roomId}/invites`, { headers, data: {} })).json()).data.code
    expect((await peer.request.post(`/api/invites/${code}`, { headers: { ...origin, 'X-Anyone-User-Id': sender }, data: {} })).ok()).toBe(true)
    await page.addInitScript(() => {
      const show = ServiceWorkerRegistration.prototype.showNotification
      ;(window as unknown as { notificationCalls: number }).notificationCalls = 0
      ServiceWorkerRegistration.prototype.showNotification = function(...args) { (window as unknown as { notificationCalls: number }).notificationCalls++; return show.apply(this, args) }
    })
    let held!: () => void
    const frameHeld = new Promise<void>(resolve => { held = resolve })
    await page.routeWebSocket('**/socket.io/**', socket => {
      const server = socket.connectToServer()
      server.onMessage(packet => {
        if (String(packet).startsWith('42["message:new"')) {
          releaseFrame = () => { socket.send(packet); socket.send(packet) }; held()
        // Isolate the obsolete snapshot's room mutation from ordinary summary refreshes.
        } else if (!String(packet).startsWith('42["room:updated"')) socket.send(packet)
      })
    })
    await page.goto(`/?room=${roomId}`)
    await expect(page.locator('.connection.connected')).toBeVisible()
    await expect(page.getByTestId('message-input')).toBeEditable()
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.getByRole('button', { name: '个人设置' }).click()
    await page.getByRole('button', { name: '开启消息通知' }).click()
    await expect(page.getByRole('button', { name: '关闭消息通知' })).toBeVisible()
    await page.keyboard.press('Escape')
    // Simulate OS focus only; permission and notification APIs remain native.
    await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }))

    let started!: () => void, completed!: () => void, snapshotSeq = -1, holdNext = true
    const requestHeld = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { releaseRequest = resolve })
    const requestDone = new Promise<void>(resolve => { completed = resolve })
    await page.route('**/api/rooms', async route => {
      if (!holdNext) return route.continue()
      holdNext = false; started()
      // Hold reconnect A before the server observes this request, not just its response.
      await gate
      const response = await route.fetch()
      snapshotSeq = (await response.json()).data.rooms.find((room: { id: string }) => room.id === roomId).lastSeq
      await route.fulfill({ response }); completed()
    })
    const disconnect = async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('offline')))
      await expect(page.locator('.connection.offline')).toBeVisible()
    }
    const reconnect = () => page.evaluate(() => window.dispatchEvent(new Event('online')))
    await disconnect(); await reconnect(); await requestHeld
    // A is obsolete before B completes its own real /rooms handshake at seq 0.
    await disconnect(); await reconnect()
    await expect(page.locator('.connection.connected')).toBeVisible()
    const text = `替代连接实时消息-${crypto.randomUUID()}`
    const response = await peer.request.post(`/api/rooms/${roomId}/messages`, { headers: { ...origin, 'X-Anyone-User-Id': sender }, data: { text, clientMessageId: crypto.randomUUID() } })
    expect(response.ok()).toBe(true)
    const message = (await response.json()).data
    expect(message.seq).toBe(1)
    await frameHeld
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/rooms')
    releaseRequest(); await requestDone
    await (await delivered).finished()
    expect(snapshotSeq).toBe(1)
    // Let the delivered fetch and React commit settle before checking the absent mutation.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect.soft(page.getByTestId(`room-${roomId}`)).not.toContainText(text)
    await expect(page.locator('.connection.connected')).toBeVisible()
    releaseFrame()
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toHaveCount(1)
    await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => n.tag))).toEqual([`anyone:${me}:${message.id}`])
    expect(await page.evaluate(() => (window as unknown as { notificationCalls: number }).notificationCalls)).toBe(1)
  } finally { releaseRequest(); await peer.close() }
})

test('explicit opt-in delivers real service-worker notifications only for live other-user background messages', async ({ page, browser, context }) => {

  await context.grantPermissions(['notifications'], { origin: 'http://127.0.0.1:4190' })
  await page.addInitScript(() => {
    const original = Notification.requestPermission.bind(Notification)
    ;(window as unknown as { permissionRequests: number }).permissionRequests = 0
    Notification.requestPermission = (...args) => { (window as unknown as { permissionRequests: number }).permissionRequests++; return original(...args) }
    const show = ServiceWorkerRegistration.prototype.showNotification
    ;(window as unknown as { notificationCalls: number }).notificationCalls = 0
    ServiceWorkerRegistration.prototype.showNotification = function(...args) { (window as unknown as { notificationCalls: number }).notificationCalls++; return show.apply(this, args) }
  })
  let replay: ((message: unknown) => void) | undefined
  await page.routeWebSocket('**/socket.io/**', socket => {
    const server = socket.connectToServer()
    replay = message => socket.send('42' + JSON.stringify(['message:new', message]))
    server.onMessage(packet => { socket.send(packet); if (String(packet).startsWith('42["message:new"')) socket.send(packet) })
  })
  const other = await browser.newContext()
  try {
    const login = async (c: typeof context, displayName: string) => {
      const response = await c.request.post('/api/auth/guest', { headers: { Origin: 'http://127.0.0.1:4190' }, data: { displayName } })
      expect(response.ok()).toBe(true)
      return (await response.json()).data.user.id as string
    }
    const me = await login(context, '通知接收者'), peer = await login(other, '通知发送者')
    const rooms = (await (await context.request.get('/api/rooms')).json()).data.rooms
    const roomId = rooms[0].id
    const send = async (c: typeof context, owner: string, text: string) => {
      const response = await c.request.post(`/api/rooms/${roomId}/messages`, { headers: { Origin: 'http://127.0.0.1:4190', 'X-Anyone-User-Id': owner }, data: { clientMessageId: crypto.randomUUID(), text } })
      expect(response.ok()).toBe(true)
      return (await response.json()).data
    }
    const historical = await send(other, peer, '历史私密内容不应该进入通知')
    await page.goto('/')
    await expect(page.locator('.connection.connected')).toBeVisible()
    await page.evaluate(() => navigator.serviceWorker.ready)
    const notifications = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag, data: n.data })))
    expect(await page.evaluate(() => (window as unknown as { permissionRequests: number }).permissionRequests)).toBe(0)
    expect(await notifications()).toEqual([])
    await page.getByRole('button', { name: '个人设置' }).click()
    await expect(page.getByRole('button', { name: '开启消息通知' })).toBeVisible()
    await page.getByRole('button', { name: '开启消息通知' }).click()
    expect(await page.evaluate(() => (window as unknown as { permissionRequests: number }).permissionRequests)).toBe(1)
    await expect(page.getByRole('button', { name: '关闭消息通知' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.bringToFront()
    await send(other, peer, '前台不打扰')
    await expect(page.getByText('前台不打扰', { exact: true })).toBeVisible()
    expect(await notifications()).toEqual([])
    const blank = await context.newPage(); await blank.goto('about:blank'); await blank.bringToFront()
    // Automation forces all documents focused; simulate only OS focus, never notification APIs.
    await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }))
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
    const message = await send(other, peer, '后台敏感聊天正文不能展示在锁屏')
    await expect.poll(async () => (await notifications()).length).toBe(1)
    const shown = (await notifications())[0]
    expect(shown).toMatchObject({ title: 'Anyone IM', body: '收到一条新消息，打开应用查看。', data: { roomId, ownerId: me } })
    expect(JSON.stringify(shown)).not.toContain(message.text)
    replay?.(historical); replay?.(message)
    await expect(page.getByText(message.text, { exact: true })).toHaveCount(1)
    expect(await page.evaluate(() => (window as unknown as { notificationCalls: number }).notificationCalls)).toBe(1)
    await send(context, me, '自己的消息不通知')
    await expect(page.getByText('自己的消息不通知', { exact: true })).toHaveCount(1)
    expect(await notifications()).toHaveLength(1)
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await expect(page.locator('.connection.offline')).toBeVisible()
    const missed = await send(other, peer, '离线期间只补历史不通知')
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(page.locator('.connection.connected')).toBeVisible()
    await expect(page.getByText('离线期间只补历史不通知', { exact: true })).toHaveCount(1)
    expect(await page.evaluate(() => (window as unknown as { notificationCalls: number }).notificationCalls)).toBe(1)
    // Even a replayed missed frame after ready is history, but the next genuine live frame is not.
    replay?.(missed)
    const afterReconnect = await send(other, peer, '重连之后的新消息应当通知')
    await expect.poll(async () => (await notifications()).length).toBe(2)
    expect((await notifications()).map(n => n.tag).sort()).toEqual([message, afterReconnect].map(m => `anyone:${me}:${m.id}`).sort())
    expect(await page.evaluate(() => (window as unknown as { notificationCalls: number }).notificationCalls)).toBe(2)
    await page.bringToFront()
    await page.getByRole('button', { name: '个人设置' }).click()
    await page.getByRole('button', { name: '关闭消息通知' }).click()
    await expect(page.getByText('消息通知已关闭。', { exact: true })).toBeVisible()
    await expect.poll(async () => (await notifications()).length).toBe(0)
    await page.keyboard.press('Escape'); await blank.bringToFront()
    await send(other, peer, '关闭后不通知')
    await expect(page.getByText('关闭后不通知', { exact: true })).toHaveCount(1)
    expect(await notifications()).toEqual([])
  } finally { await other.close() }
})

test('static frontend serves installable metadata, real icons and root worker; install entry handles prompt and manual fallback', async ({ page }) => {
  await page.goto('/')
  const manifestLink = page.locator('link[rel="manifest"]')
  await expect(manifestLink).toHaveAttribute('href', '/manifest.webmanifest')
  const manifest = await (await page.request.get('/manifest.webmanifest')).json()
  expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone', theme_color: '#11796f', background_color: '#f5faf9' })
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src)
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toContain('image/png')
    const bytes = await response.body()
    const size = Number(icon.sizes.split('x')[0])
    expect(bytes.readUInt32BE(16)).toBe(size)
    expect(bytes.readUInt32BE(20)).toBe(size)
  }
  expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true)
  const sw = await page.request.get('/sw.js')
  expect(sw.ok()).toBe(true)
  expect(sw.headers()['content-type']).toContain('javascript')
  expect(sw.headers()['cache-control']).toBe('no-cache')
  await page.evaluate(() => navigator.serviceWorker.ready)
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe('http://127.0.0.1:4190/')
  await page.getByLabel('你的称呼').fill(`安装-${crypto.randomUUID().slice(0, 8)}`)
  await page.getByTestId('guest-submit').click()
  await page.getByRole('button', { name: '个人设置' }).click()
  await page.getByRole('button', { name: '安装到桌面' }).click()
  await expect(page.getByText(/添加到主屏幕/)).toBeVisible()
  // Browser install dialogs cannot be driven by Playwright; exercise the native event seam.
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(event, { prompt: async () => { (window as unknown as { prompts: number }).prompts = 1 }, userChoice: Promise.resolve({ outcome: 'accepted' }) })
    window.dispatchEvent(event)
  })
  await page.getByRole('button', { name: '安装到桌面' }).click()
  expect(await page.evaluate(() => (window as unknown as { prompts: number }).prompts)).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(page.getByRole('button', { name: '已安装到桌面' })).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath('pwa-settings.png') })
})

for (const width of [1440, 320]) {
  test(`composer hint precedes input with safe geometry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 568 })
    await page.goto('/')
    await page.getByLabel('你的称呼').fill(`布局-${crypto.randomUUID().slice(0, 8)}`)
    await page.getByTestId('guest-submit').click()
    await page.getByTestId('room-list').getByRole('button').first().click()
    const input = page.getByTestId('message-input')
    await expect(input).toBeVisible()
    const hint = await page.getByText('Enter 发送 · Shift + Enter 换行', { exact: true }).boundingBox()
    const box = await input.boundingBox()
    expect(hint!.y + hint!.height).toBeLessThanOrEqual(box!.y)
    expect(box!.y + box!.height).toBeLessThanOrEqual(568)
    await expect(input).toHaveAttribute('aria-describedby', 'composer-hint')
    await expect(page.getByTestId('send-message')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`composer-${width}.png`) })
  })
}
