import { test, expect, type Page } from '@playwright/test'

const user = { id: 'code-owner', displayName: '房主', username: null, isGuest: true }
const room = { id: 'code-room', name: '临时传输', description: '', visibility: 'private', code: '042917', lifetime: 'short', expiresAt: '2030-01-01T12:00:00Z', role: 'owner', memberCount: 1, onlineCount: 0, lastSeq: 0, lastReadSeq: 0, lastMessage: null, updatedAt: '2030-01-01T00:00:00Z' }
async function fixture(page: Page, joined: unknown[] = []) {
  await page.routeWebSocket('**/socket.io/**', ws => ws.close())
  await page.route('**/socket.io/**', route => route.fulfill({ status: 503, body: 'isolated fixture' }))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const data = path === '/api/session' ? { user } : path === '/api/rooms' ? { rooms: joined } : path === '/api/rooms/public' ? { rooms: [] } : path.endsWith('/members') ? { members: [{ user, role: 'owner', online: false }] } : path.endsWith('/messages') ? { messages: [], hasMore: false } : null
    return route.fulfill({ json: { data } })
  })
}

test('new rooms default to short-lived and show their six-digit code right away', async ({ page }) => {
  await fixture(page)
  const bodies: unknown[] = []
  await page.route('**/api/rooms', route => {
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON()
    bodies.push(body)
    return route.fulfill({ json: { data: { ...room, name: body.name, lifetime: body.lifetime } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '新建房间' }).click()
  await expect(page.getByRole('radio', { name: /短期房间/ })).toBeChecked()
  await expect(page.getByRole('radio', { name: /长期房间/ })).not.toBeChecked()
  await page.getByLabel('房间名称').fill('临时传输')
  await page.getByLabel('房间密码', { exact: true }).fill('hand off 1')
  await page.getByRole('button', { name: '创建房间', exact: true }).click()
  expect(bodies[0]).toEqual({ name: '临时传输', description: '', visibility: 'private', lifetime: 'short', password: 'hand off 1' })
  await expect(page.getByTestId('room-code')).toHaveText('042917')
  await page.getByRole('button', { name: '新建房间' }).click()
  await page.getByLabel('房间名称').fill('长期空间')
  await page.getByRole('radio', { name: /长期房间/ }).check()
  await page.getByLabel('房间密码', { exact: true }).fill('hand off 2')
  await page.getByRole('button', { name: '创建房间', exact: true }).click()
  expect(bodies[1]).toMatchObject({ lifetime: 'long' })
})

test('joining by code sends the code and password together and shows one opaque error', async ({ page }) => {
  await fixture(page)
  const bodies: unknown[] = []
  let attempts = 0
  await page.route('**/api/rooms/join-by-code', route => {
    bodies.push(route.request().postDataJSON())
    return ++attempts === 1
      ? route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '房间码或密码错误' } } })
      : route.fulfill({ json: { data: { ...room, role: 'member' } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '加入房间', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '加入房间' })
  const code = dialog.getByLabel('房间码', { exact: true })
  await expect(code).toHaveAttribute('inputmode', 'numeric')
  await code.fill('04 29-17')
  await expect(code).toHaveValue('042917')
  await dialog.getByLabel('房间密码', { exact: true }).fill('wrong pass')
  await dialog.getByRole('button', { name: '进入房间', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('房间码或密码错误')
  await dialog.getByLabel('房间密码', { exact: true }).fill('hand off 1')
  await dialog.getByRole('button', { name: '进入房间', exact: true }).click()
  await expect(page.getByRole('heading', { name: room.name, exact: true })).toBeVisible()
  expect(bodies).toEqual([{ code: '042917', password: 'wrong pass' }, { code: '042917', password: 'hand off 1' }])
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('hand off 1')
})

test('details show the code and closing time; the owner can destroy the room', async ({ page }) => {
  await fixture(page, [room])
  let destroyed = false
  await page.route('**/api/rooms/code-room', route => {
    expect(route.request().method()).toBe('DELETE')
    destroyed = true
    return route.fulfill({ json: { data: null } })
  })
  await page.goto('/')
  await page.getByTestId('room-code-room').click()
  await page.getByRole('button', { name: '房间详情' }).click()
  const details = page.getByRole('dialog', { name: '房间详情' })
  await expect(details.getByLabel('房间码', { exact: true })).toHaveValue('042917')
  await expect(details.getByText(/短期房间 · .*自动关闭并清空/)).toBeVisible()
  await details.getByRole('button', { name: '立即销毁房间', exact: true }).click()
  await page.getByRole('dialog', { name: '销毁房间？' }).getByRole('button', { name: '确认销毁', exact: true }).click()
  await expect(page.getByTestId('room-code-room')).toHaveCount(0)
  expect(destroyed).toBe(true)
})
