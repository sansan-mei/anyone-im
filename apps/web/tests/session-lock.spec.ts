import { expect, test, type Page } from '@playwright/test'

const user = { id: 'session-cache-owner', displayName: '缓存会话', username: null, isGuest: true }
const room = { id: 'session-cache-room', name: '缓存房间', description: '', visibility: 'public', role: 'owner', memberCount: 1, onlineCount: 0, lastSeq: 1, lastReadSeq: 1, lastMessage: null, updatedAt: '2026-01-01T00:00:00Z' }
const message = { id: 'session-cache-message', roomId: room.id, clientMessageId: '00000000-0000-4000-8000-000000000001', seq: 1, sender: user, text: '当前页面已缓存的历史', attachment: null, createdAt: '2026-01-01T00:00:00Z', deletedAt: null }

async function fixture(page: Page, options: { deferRooms?: boolean; attachment?: boolean; query?: string } = {}) {
  let mode: 'ok' | 'transport' | 'unavailable' | 'replacement' = 'ok', messageReads = 0, roomReads = 0, imageReads = 0
  let releaseRooms!: () => void, releaseImage!: () => void
  const roomsGate = new Promise<void>(resolve => { releaseRooms = resolve })
  const imageGate = new Promise<void>(resolve => { releaseImage = resolve })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cWQAAAAASUVORK5CYII=', 'base64')
  const imageMessage = { ...message, attachment: { id: 'session-image', roomId: room.id, filename: 'recovered.png', mimeType: 'image/png', size: png.length, url: '/api/attachments/session-image', expiresAt: '2099-01-01T00:00:00Z', expired: false } }
  await page.routeWebSocket('**/socket.io/**', ws => ws.close())
  await page.route('**/socket.io/**', route => route.fulfill({ status: 503, body: 'isolated UI fixture' }))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/session') {
      if (mode === 'transport') return route.abort('failed')
      if (mode === 'unavailable') return route.fulfill({ status: 503, json: { error: { code: 'TEMPORARY', message: 'try again' } } })
      return route.fulfill({ json: { data: { user: mode === 'replacement' ? { ...user, id: 'replacement-owner' } : user } } })
    }
    if (path === '/api/rooms') { roomReads++; if (options.deferRooms && roomReads === 1) await roomsGate }
    if (path === '/api/attachments/session-image') {
      imageReads++
      expect(route.request().headers()['x-anyone-user-id']).toBe(user.id)
      if (imageReads === 1) await imageGate
      return route.fulfill({ contentType: 'image/png', body: png })
    }
    if (path.endsWith('/messages')) messageReads++
    const data = path === '/api/rooms' ? { rooms: [room] } : path === '/api/rooms/public' ? { rooms: [] } : path.endsWith('/messages') ? { messages: [options.attachment ? imageMessage : message], hasMore: false } : path.endsWith('/members') ? { members: [{ user, role: 'owner', online: false }] } : null
    return route.fulfill({ json: { data } })
  })
  await page.goto(`/${options.query || ''}`)
  if (options.deferRooms) await expect.poll(() => roomReads).toBe(1)
  else {
    await page.getByTestId(`room-${room.id}`).click()
    await expect(page.getByText(message.text, { exact: true })).toBeVisible()
    if (options.attachment) await expect.poll(() => imageReads).toBe(1)
  }
  return { setMode: (next: typeof mode) => { mode = next }, releaseRooms, releaseImage, get roomReads() { return roomReads }, get imageReads() { return imageReads }, get messageReads() { return messageReads } }
}

for (const mode of ['transport', 'unavailable'] as const) test(`session ${mode} locks but preserves the same history and unsent draft`, async ({ page }) => {
  const f = await fixture(page)
  const draft = '弱网恢复后仍保留的草稿'
  await page.getByTestId('message-input').fill(draft)
  const before = f.messageReads
  f.setMode(mode)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const lock = page.getByTestId('session-lock')
  await expect(lock).toBeVisible()
  await expect(page.getByRole('button', { name: '重新验证会话', exact: true })).toBeEnabled()
  await expect(page.getByTestId('app-shell')).toBeHidden()
  await expect(page.getByText('会话已变化。', { exact: false })).toHaveCount(0)
  f.setMode('ok')
  await page.getByRole('button', { name: '重新验证会话', exact: true }).click()
  await expect(lock).toHaveCount(0)
  await expect(page.getByText(message.text, { exact: true })).toBeVisible()
  await expect(page.getByTestId('message-input')).toHaveValue(draft)
  expect(f.messageReads).toBe(before)
})

test('uncertain identity closes body portals and releases focus for retry', async ({ page }) => {
  const f = await fixture(page)
  await page.getByRole('button', { name: '个人设置', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '个人设置', exact: true })).toBeVisible()
  f.setMode('unavailable')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const retry = page.getByRole('button', { name: '重新验证会话', exact: true })
  await expect(retry).toBeEnabled()
  await expect(page.locator('.modal:visible, .modal-overlay:visible')).toHaveCount(0)
  await retry.focus()
  await expect(retry).toBeFocused()
  f.setMode('ok')
  await retry.click()
  await expect(page.getByTestId('session-lock')).toHaveCount(0)
})

test('a nested room action confirmation releases its portal focus scope while session verification is unavailable', async ({ page }) => {
  const f = await fixture(page)
  await page.getByTestId('room-actions').click()
  await page.getByRole('button', { name: '撤销全部邀请', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '撤销全部邀请？', exact: true })).toBeVisible()
  f.setMode('unavailable')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const retry = page.getByRole('button', { name: '重新验证会话', exact: true })
  await expect(retry).toBeEnabled()
  await expect(page.locator('.modal:visible, .modal-overlay:visible')).toHaveCount(0)
  await retry.focus()
  await expect(retry).toBeFocused()
  f.setMode('ok')
  await retry.click()
  await expect(page.getByTestId('session-lock')).toHaveCount(0)
  // Radix can dismiss a nested confirmation while releasing its focus scope.
  // Require a usable resumed workspace and an explicitly reopenable action,
  // not automatic reopening of a destructive confirmation after verification.
  const details = page.getByRole('dialog', { name: '房间详情', exact: true })
  if (!await details.isVisible()) await page.getByTestId('room-actions').click()
  const confirmation = page.getByRole('dialog', { name: '撤销全部邀请？', exact: true })
  if (!await confirmation.isVisible()) await page.getByRole('button', { name: '撤销全部邀请', exact: true }).click()
  await expect(confirmation).toBeVisible()
})

for (const requested of ['', room.id, 'unjoined-private-room']) test(`an interrupted initial room response retries startup selection/deeplinks: ${requested || 'desktop default'}`, async ({ page }) => {
  const f = await fixture(page, { deferRooms: true, query: requested ? `?room=${requested}` : '' })
  f.setMode('unavailable')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const retry = page.getByRole('button', { name: '重新验证会话', exact: true })
  await expect(retry).toBeEnabled()
  const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/rooms')
  f.releaseRooms()
  await oldResponse
  f.setMode('ok')
  await retry.click()
  await expect(page.getByTestId('session-lock')).toHaveCount(0)
  await expect(page.getByTestId(`room-${room.id}`)).toHaveAttribute('aria-current', 'true')
  expect(f.roomReads).toBe(2)
  if (requested === room.id) await expect.poll(() => new URL(page.url()).searchParams.has('room')).toBe(false)
  else if (requested) {
    await expect(page.getByRole('dialog', { name: '发现公开房间', exact: true })).toBeVisible()
    await expect(page.getByLabel('私密房间 ID', { exact: true })).toHaveValue(requested)
  } else await expect(page.getByText(message.text, { exact: true })).toBeVisible()
})

for (const settlement of ['before resume', 'after resume'] as const) test(`same-session resume automatically reauthorizes a pending image settling ${settlement}`, async ({ page }) => {
  const f = await fixture(page, { attachment: true })
  f.setMode('unavailable')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const retry = page.getByRole('button', { name: '重新验证会话', exact: true })
  await expect(retry).toBeEnabled()
  const releaseOld = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/attachments/session-image')
    f.releaseImage()
    await response
  }
  if (settlement === 'before resume') await releaseOld()
  f.setMode('ok')
  await retry.click()
  await expect(page.getByTestId('session-lock')).toHaveCount(0)
  if (settlement === 'after resume') await releaseOld()
  await expect(page.getByRole('img', { name: 'recovered.png', exact: true })).toBeVisible()
  expect(f.imageReads).toBe(2)
  await expect(page.getByRole('button', { name: '重试加载图片', exact: true })).toHaveCount(0)
  // A later successful check must retain the valid blob instead of refetching.
  const blob = await page.getByRole('img', { name: 'recovered.png', exact: true }).getAttribute('src')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('session-lock')).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'recovered.png', exact: true })).toHaveAttribute('src', blob!)
  expect(f.imageReads).toBe(2)
})

test('authoritative replacement identity destroys the old workspace rather than unlocking its cache', async ({ page }) => {
  const f = await fixture(page)
  f.setMode('replacement')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: '重新确认身份', exact: true })).toBeVisible()
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
  await expect(page.getByText(message.text, { exact: true })).toHaveCount(0)
})
