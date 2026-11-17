import { expect, test } from '@playwright/test'

test('a stranger joins a short room by typing only its six-digit code and password', async ({ page, browser, baseURL }) => {
  const origin = { Origin: baseURL! }
  const owner = await page.request.post('/api/auth/guest', { headers: origin, data: { displayName: '电脑A' } })
  const ownerId = (await owner.json()).data.user.id as string
  const created = await page.request.post('/api/rooms', { headers: { ...origin, 'X-Anyone-User-Id': ownerId }, data: { name: '临时传输', visibility: 'private', lifetime: 'short', password: 'hand off 1' } })
  expect(created.ok()).toBe(true)
  const room = (await created.json()).data
  expect(room.code).toMatch(/^\d{6}$/)
  const sent = await page.request.post(`/api/rooms/${room.id}/messages`, { headers: { ...origin, 'X-Anyone-User-Id': ownerId }, data: { clientMessageId: crypto.randomUUID(), text: '从电脑A发出的地址' } })
  expect(sent.ok()).toBe(true)
  const stranger = await browser.newContext({ baseURL })
  try {
    const other = await stranger.newPage()
    await other.goto('/')
    await other.getByTestId('guest-name').fill('电脑B')
    await other.getByTestId('guest-submit').click()
    await other.getByRole('button', { name: '加入房间', exact: true }).first().click()
    const dialog = other.getByRole('dialog', { name: '加入房间' })
    await dialog.getByLabel('房间码', { exact: true }).fill(room.code)
    await dialog.getByLabel('房间密码', { exact: true }).fill('wrong pass')
    await dialog.getByRole('button', { name: '进入房间', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('房间码或密码错误')
    await dialog.getByLabel('房间密码', { exact: true }).fill('hand off 1')
    await dialog.getByRole('button', { name: '进入房间', exact: true }).click()
    await expect(other.getByRole('heading', { name: '临时传输', exact: true })).toBeVisible()
    await expect(other.getByText('从电脑A发出的地址', { exact: true })).toBeVisible()
    await expect(other.getByTestId('room-code')).toHaveText(room.code)
  } finally { await stranger.close() }
})
