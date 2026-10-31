import { test, expect, type Page } from '@playwright/test'

const user = { id: 'retention-owner', displayName: '房主', username: null, isGuest: true }
const room = { id: 'retention-private', name: '密码空间', description: '', visibility: 'private', role: 'owner', memberCount: 1, onlineCount: 0, lastSeq: 0, lastReadSeq: 0, lastMessage: null, updatedAt: '2026-01-01T00:00:00Z' }
async function fixture(page: Page, joined = false, messages: unknown[] = []) {
  await page.routeWebSocket('**/socket.io/**', ws => ws.close())
  await page.route('**/socket.io/**', route => route.fulfill({ status: 503, body: 'isolated fixture' }))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const data = path === '/api/session' ? { user } : path === '/api/rooms' ? { rooms: joined ? [room] : [] } : path === '/api/rooms/public' ? { rooms: [] } : path.endsWith('/members') ? { members: [{ user, role: 'owner', online: false }] } : path.endsWith('/messages') ? { messages, hasMore: false } : null
    return route.fulfill({ json: { data } })
  })
}

test('private creation defaults to password entry and never auto-generates invites', async ({ page }) => {
  await fixture(page)
  const posts: string[] = []
  page.on('request', r => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname) })
  await page.route('**/api/rooms', route => {
    if (route.request().method() !== 'POST') return route.fallback()
    expect(route.request().postDataJSON()).toEqual({ name: '密码空间', description: '', visibility: 'private', password: 'only in memory' })
    return route.fulfill({ json: { data: room } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '新建房间' }).click()
  await expect(page.getByRole('radio', { name: /私密房间/ })).toBeChecked()
  await page.getByLabel('房间名称').fill('密码空间')
  const password = page.getByLabel('房间密码', { exact: true })
  await expect(password).toHaveAttribute('type', 'password')
  await expect(page.getByRole('button', { name: '创建房间', exact: true })).toBeDisabled()
  await password.fill('only in memory')
  await page.getByRole('button', { name: '创建房间', exact: true }).click()
  await expect(page.getByRole('heading', { name: '密码空间', exact: true })).toBeVisible()
  expect(posts.some(p => p.endsWith('/invites'))).toBe(false)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('only in memory')
  expect(page.url()).not.toContain('only')
})

test('closing creation clears only the password draft, and public creation omits it', async ({ page }) => {
  await fixture(page)
  await page.route('**/api/rooms', route => {
    if (route.request().method() !== 'POST') return route.fallback()
    expect(route.request().postDataJSON()).toEqual({ name: '保留名称', description: '保留介绍', visibility: 'public' })
    return route.fulfill({ json: { data: { ...room, name: '保留名称', visibility: 'public' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '新建房间' }).click()
  await page.getByLabel('房间名称').fill('保留名称')
  await page.getByLabel('房间介绍').fill('保留介绍')
  await page.getByLabel('房间密码', { exact: true }).fill('temporary password')
  await page.getByRole('button', { name: '关闭弹窗' }).click()
  await page.getByRole('button', { name: '新建房间' }).click()
  await expect(page.getByLabel('房间名称')).toHaveValue('保留名称')
  await expect(page.getByLabel('房间介绍')).toHaveValue('保留介绍')
  await expect(page.getByLabel('房间密码', { exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: '创建房间', exact: true })).toBeDisabled()
  await page.getByLabel('房间密码', { exact: true }).fill('temporary password')
  await page.getByRole('radio', { name: /公开房间/ }).check()
  await expect(page.getByLabel('房间密码', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '创建房间', exact: true }).click()
  await expect(page.getByRole('heading', { name: '保留名称', exact: true })).toBeVisible()
})

test('room-id links open a password join dialog; discovery also exposes private join', async ({ page }) => {
  await fixture(page)
  await page.route('**/api/rooms/retention-private/join', route => {
    expect(route.request().postDataJSON()).toEqual({ password: 'join secret' })
    return route.fulfill({ json: { data: room } })
  })
  await page.goto('/?room=retention-private')
  const dialog = page.getByRole('dialog', { name: '发现公开房间' })
  await expect(dialog.getByLabel('私密房间 ID')).toHaveValue(room.id)
  await dialog.getByLabel('房间密码', { exact: true }).fill('join secret')
  await dialog.getByRole('button', { name: '密码加入私密房间' }).click()
  await expect(page.getByRole('heading', { name: room.name, exact: true })).toBeVisible()
  await page.getByRole('button', { name: '发现公开房间' }).click()
  await expect(page.getByLabel('私密房间 ID')).toBeVisible()
})

test('owner can set a new password and share a password-free room-id link independently of invites', async ({ page }) => {
  await fixture(page, true)
  await page.route('**/api/rooms/retention-private/password', route => {
    expect(route.request().method()).toBe('PATCH')
    expect(route.request().postDataJSON()).toEqual({ password: 'replacement secret' })
    return route.fulfill({ json: { data: null } })
  })
  await page.goto('/')
  await page.getByTestId('room-retention-private').click()
  await page.getByRole('button', { name: '房间详情' }).click()
  await expect(page.getByLabel('房间 ID', { exact: true })).toHaveValue(room.id)
  await expect(page.getByLabel('密码入房链接')).toHaveValue(`${new URL(page.url()).origin}/?room=${room.id}`)
  await page.getByLabel('新房间密码').fill('replacement secret')
  await page.getByRole('button', { name: '设置或更改密码' }).click()
  await expect(page.getByText('房间密码已更新')).toBeVisible()
  await expect(page.getByLabel('新房间密码')).toHaveValue('')
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('replacement secret')
})

for (const expired of [true, false]) test(`expired metadata (flag=${expired}) never fetches bytes and keeps the caption with a clear placeholder`, async ({ page }) => {
  await page.clock.setFixedTime(new Date(expired ? '2026-01-01T00:00:00Z' : '2026-01-08T00:00:00Z'))
  const attachment = { id: 'old-image', roomId: room.id, filename: 'old.png', size: 8, mimeType: 'image/png', url: '/api/attachments/old-image', expiresAt: '2026-01-08T00:00:00Z', expired }
  const message = { id: 'old-message', roomId: room.id, clientMessageId: crypto.randomUUID(), seq: 1, sender: user, text: '保留图片说明', attachment, createdAt: '2026-01-01T00:00:00Z', deletedAt: null }
  await fixture(page, true, [message])
  let byteRequests = 0
  await page.route('**/api/attachments/**', route => { byteRequests++; return route.fulfill({ status: 410, json: { error: { code: 'ATTACHMENT_EXPIRED', message: '图片已过期' } } }) })
  await page.goto('/')
  await page.getByTestId('room-retention-private').click()
  await expect(page.getByText('图片已过期', { exact: true })).toBeVisible()
  await expect(page.getByText('保留图片说明', { exact: true })).toBeVisible()
  expect(byteRequests).toBe(0)
  await expect(page.getByRole('img', { name: 'old.png' })).toHaveCount(0)
})

test('an open image expires at the deadline without refetching bytes or retaining its preview link', async ({ page }) => {
  await page.clock.install({ time: new Date('2030-01-07T23:59:40Z') })
  await page.clock.pauseAt(new Date('2030-01-07T23:59:50Z'))
  const attachment = { id: 'live-image', roomId: room.id, filename: 'live.png', size: 68, mimeType: 'image/png', url: '/api/attachments/live-image', expiresAt: '2030-01-08T00:00:00Z', expired: false }
  const message = { id: 'live-message', roomId: room.id, clientMessageId: crypto.randomUUID(), seq: 1, sender: user, text: '到期仍保留说明', attachment, createdAt: '2030-01-01T00:00:00Z', deletedAt: null }
  await fixture(page, true, [message])
  let byteRequests = 0
  await page.route('**/api/attachments/**', route => {
    byteRequests++
    return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cWQAAAAASUVORK5CYII=', 'base64') })
  })
  await page.goto('/')
  await page.getByTestId('room-retention-private').click()
  await expect(page.getByRole('img', { name: 'live.png' })).toBeVisible()
  const preview = page.getByRole('link', { name: '查看图片 live.png' })
  await expect(preview).toBeVisible()
  const fetched = byteRequests
  expect(fetched).toBeGreaterThan(0)
  await page.clock.runFor(9999)
  await expect(preview).toBeVisible()
  await page.clock.runFor(1)
  await expect(page.getByText('图片已过期', { exact: true })).toBeVisible()
  await expect(page.getByText('到期仍保留说明', { exact: true })).toBeVisible()
  await expect(preview).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'live.png' })).toHaveCount(0)
  expect(byteRequests).toBe(fetched)
})

test('a server expiry response overrides a slow browser clock without offering a retry', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2030-01-01T00:00:00Z'))
  const attachment = { id: 'server-expired', roomId: room.id, filename: 'gone.png', size: 8, mimeType: 'image/png', url: '/api/attachments/server-expired', expiresAt: '2030-01-08T00:00:00Z', expired: false }
  const message = { id: 'server-expired-message', roomId: room.id, clientMessageId: crypto.randomUUID(), seq: 1, sender: user, text: '服务端已过期', attachment, createdAt: '2030-01-01T00:00:00Z', deletedAt: null }
  await fixture(page, true, [message])
  await page.route('**/api/attachments/**', route => route.fulfill({ status: 410, json: { error: { code: 'ATTACHMENT_EXPIRED', message: '图片已过期' } } }))
  await page.goto('/')
  await page.getByTestId('room-retention-private').click()
  await expect(page.getByText('图片已过期', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重试加载图片' })).toHaveCount(0)
  await expect(page.getByText('服务端已过期', { exact: true })).toBeVisible()
})
