import { expect, test } from '@playwright/test'

test('valid reconnect cursor repairs an old deletion without rescanning cached HTTP history', async ({ page }) => {
  const entered = await page.request.post('/api/auth/guest', { data: { displayName: '变更游标验证' } })
  expect(entered.ok()).toBe(true)
  const userId = (await entered.json()).data.user.id as string
  const headers = { 'X-Anyone-User-Id': userId }
  const created = await page.request.post('/api/rooms', { headers, data: { name: '变更游标验证', visibility: 'public' } })
  expect(created.ok()).toBe(true)
  const roomId = (await created.json()).data.id as string
  const path = `/api/rooms/${roomId}/messages`
  let firstId = ''
  for (let seq = 1; seq <= 20; seq++) {
    const sent = await page.request.post(path, { headers, data: { clientMessageId: crypto.randomUUID(), text: `游标消息 ${seq}` } })
    expect(sent.ok()).toBe(true)
    const message = (await sent.json()).data
    if (seq === 1) firstId = message.id
  }
  const reads: string[] = []
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === path) reads.push(request.url()) })
  await page.goto(`/?room=${roomId}`)
  const list = page.getByTestId('message-list')
  await expect(page.getByText('实时连接已建立', { exact: true })).toBeVisible()
  await expect(list.locator('article[data-message-id]')).toHaveCount(15)
  await list.evaluate(el => { el.scrollTop = 0 })
  await page.getByRole('button', { name: '加载更早消息', exact: true }).click()
  await expect(list.locator('article[data-message-id]')).toHaveCount(20)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(page.locator('.connection.offline')).toBeVisible()
  const deleted = await page.request.delete(`/api/messages/${firstId}`, { headers })
  expect(deleted.ok()).toBe(true)
  const before = reads.length
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(list.locator(`[data-message-id="${firstId}"] .tombstone`)).toHaveText('消息已删除')
  await expect(page.getByText('实时连接已建立', { exact: true })).toBeVisible()
  expect(reads.slice(before)).toEqual([])
})
