import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'

const base = 'http://127.0.0.1:4190'
const origin = { Origin: base }
const identities = new WeakMap<APIRequestContext, string>()
function authorizedHeaders(request: APIRequestContext) {
  const id = identities.get(request)
  if (!id) throw new Error('Test mutation requires an established expected user')
  return { ...origin, 'X-Anyone-User-Id': id }
}
const unique = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`
async function post<T>(request: APIRequestContext, path: string, data: unknown = {}): Promise<T> {
  const bootstrap = /^\/api\/auth\/(guest|register|login)$/.test(path)
  const response = await request.post(`${base}${path}`, { headers: bootstrap ? origin : authorizedHeaders(request), data })
  expect(response.ok(), `${path} returned ${response.status()}: ${await response.text()}`).toBe(true)
  const result = (await response.json()).data
  if (bootstrap && result?.user?.id) identities.set(request, result.user.id)
  if (path === '/api/auth/logout') identities.delete(request)
  return result as T
}
async function guest(context: BrowserContext, name: string) {
  return post<{ user: { id: string; displayName: string } }>(context.request, '/api/auth/guest', { displayName: name })
}
async function room(context: BrowserContext) {
  return post<{ id: string; name: string }>(context.request, '/api/rooms', { name: unique('设计讨论'), description: '真实端到端测试房间', visibility: 'private' })
}
async function openRoom(page: Page, roomId: string) {
  await page.goto(base)
  await page.getByTestId(`room-${roomId}`).click()
  await expect(page.getByTestId('message-input')).toBeVisible()
}
async function send(page: Page, text: string) {
  await page.getByTestId('message-input').fill(text)
  await page.getByTestId('send-message').click()
  await expect(page.getByText(text, { exact: true })).toBeVisible()
}

const browserErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
})
test.afterEach(({ page }) => { expect(browserErrors.get(page)).toEqual([]) })

for (const [width, height] of [[320, 568], [390, 844]]) {
  test(`mobile ${width}: real guest, room navigation, IME and message send`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.goto(base)
    await page.getByTestId('guest-name').fill(unique('小未'))
    const entering = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/guest' && response.request().method() === 'POST')
    await page.getByTestId('guest-submit').click()
    const entered = await entering
    expect(entered.ok()).toBe(true)
    await entered.finished()
    await expect(page.getByTestId('room-list')).toBeVisible()
    const response = await page.request.get(`${base}/api/rooms`)
    expect(response.ok()).toBe(true)
    const { data } = await response.json()
    expect(data.rooms.length).toBeGreaterThan(0)
    await page.getByTestId(`room-${data.rooms[0].id}`).click()
    const input = page.getByTestId('message-input')
    await expect(input).toBeVisible()
    await input.fill('输入法组合状态不能误发送')
    await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    await expect(input).toHaveValue('输入法组合状态不能误发送')
    const text = unique('手机发送成功')
    await send(page, text)
    await expect(input).toHaveValue('')
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    const composer = await input.boundingBox()
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(height)
    await page.screenshot({ path: test.info().outputPath('mobile-chat.png'), animations: 'disabled' })
    await page.getByTestId('mobile-back').click()
    await expect(page.getByTestId('room-list')).toBeVisible()
  })
}

test('two browsers exchange real private-room messages and restore missed history', async ({ page, browser }) => {
  const owner = page.context()
  const member = await browser.newContext()
  try {
    await guest(owner, unique('房主'))
    await guest(member, unique('成员'))
    const created = await room(owner)
    const denied = await member.request.get(`${base}/api/rooms/${created.id}/messages`)
    expect(denied.status()).toBe(403)
    const invite = await post<{ code: string }>(owner.request, `/api/rooms/${created.id}/invites`)
    await post(member.request, `/api/invites/${invite.code}`)
    const otherPage = await member.newPage()
    await openRoom(page, created.id)
    await openRoom(otherPage, created.id)
    const text = unique('实时送达')
    await send(page, text)
    await expect(otherPage.getByText(text, { exact: true })).toHaveCount(1)
    await otherPage.close()
    const missed = unique('离线期间的消息')
    await post(owner.request, `/api/rooms/${created.id}/messages`, { clientMessageId: crypto.randomUUID(), text: missed })
    const restored = await member.newPage()
    await openRoom(restored, created.id)
    await expect(restored.getByText(missed, { exact: true })).toHaveCount(1)
    await expect(restored.getByText(text, { exact: true })).toHaveCount(1)
    await page.screenshot({ path: test.info().outputPath('desktop-chat.png'), animations: 'disabled' })
  } finally { await member.close() }
})

test('durable message ids deduplicate retries and reject payload substitution', async ({ page }) => {
  await guest(page.context(), unique('重试测试'))
  const created = await room(page.context())
  const input = { clientMessageId: crypto.randomUUID(), text: unique('仅保存一次') }
  const first = await post<{ id: string; seq: number }>(page.request, `/api/rooms/${created.id}/messages`, input)
  const second = await post<{ id: string; seq: number }>(page.request, `/api/rooms/${created.id}/messages`, input)
  expect(second.id).toBe(first.id)
  expect(second.seq).toBe(first.seq)
  const conflict = await page.request.post(`${base}/api/rooms/${created.id}/messages`, { headers: authorizedHeaders(page.request), data: { ...input, text: '替换内容' } })
  expect(conflict.status()).toBe(409)
  await openRoom(page, created.id)
  await expect(page.getByText(input.text, { exact: true })).toHaveCount(1)
})

test('authorized image renders while nonmembers cannot fetch it; deletion and kick revoke access', async ({ page, browser }) => {
  const owner = page.context()
  const member = await browser.newContext()
  const outsider = await browser.newContext()
  try {
    await guest(owner, unique('图片房主'))
    const memberUser = await guest(member, unique('图片成员'))
    await guest(outsider, unique('外部用户'))
    const created = await room(owner)
    const invite = await post<{ code: string }>(owner.request, `/api/rooms/${created.id}/invites`)
    await post(member.request, `/api/invites/${invite.code}`)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cWQAAAAASUVORK5CYII=', 'base64')
    const uploaded = await owner.request.post(`${base}/api/rooms/${created.id}/attachments`, { headers: authorizedHeaders(owner.request), multipart: { file: { name: 'test-image.png', mimeType: 'image/png', buffer: png } } })
    expect(uploaded.ok()).toBe(true)
    const attachment = (await uploaded.json()).data
    expect((await outsider.request.get(`${base}${attachment.url}`)).status()).toBe(403)
    await post(owner.request, `/api/rooms/${created.id}/messages`, { clientMessageId: crypto.randomUUID(), text: '', attachmentId: attachment.id })
    const otherPage = await member.newPage()
    await openRoom(otherPage, created.id)
    const image = otherPage.getByRole('img', { name: 'test-image.png', exact: true })
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const text = unique('即将删除的消息')
    const message = await post<{ id: string }>(owner.request, `/api/rooms/${created.id}/messages`, { clientMessageId: crypto.randomUUID(), text })
    await expect(otherPage.getByText(text, { exact: true })).toBeVisible()
    expect((await owner.request.delete(`${base}/api/messages/${message.id}`, { headers: authorizedHeaders(owner.request) })).ok()).toBe(true)
    await expect(otherPage.getByText(text, { exact: true })).toHaveCount(0)
    expect((await owner.request.delete(`${base}/api/rooms/${created.id}/members/${memberUser.user.id}`, { headers: authorizedHeaders(owner.request) })).ok()).toBe(true)
    await expect(otherPage.getByTestId(`room-${created.id}`)).toHaveCount(0)
    expect((await member.request.get(`${base}/api/rooms/${created.id}/messages`)).status()).toBe(403)
    expect((await member.request.get(`${base}${attachment.url}`)).status()).toBe(403)
    expect((await member.request.post(`${base}/api/invites/${invite.code}`, { headers: authorizedHeaders(member.request), data: {} })).status()).toBe(403)
  } finally { await member.close(); await outsider.close() }
})

test('a stale tab cannot publish its pending content after another tab changes accounts', async ({ page, browser }) => {
  const seed = await browser.newContext()
  const switchTab = await page.context().newPage()
  try {
    const username = `switch_${crypto.randomUUID().slice(0, 8)}`
    const password = `ci-only-${crypto.randomUUID()}`
    const registered = await post<{ user: { id: string } }>(seed.request, '/api/auth/register', { username, password, displayName: '账户B' })
    const original = await guest(page.context(), unique('账户A'))
    const rooms = (await (await page.request.get(`${base}/api/rooms`)).json()).data.rooms
    const lobby = rooms.find((item: { visibility: string }) => item.visibility === 'public')
    expect(lobby).toBeTruthy()
    await openRoom(page, lobby.id)
    await switchTab.goto(base)
    const text = unique('账户A尚未发送的私密草稿')
    let failedInput: { clientMessageId: string; text: string } | undefined
    const messagePath = `/api/rooms/${lobby.id}/messages`
    await page.route(`**${messagePath}`, async route => {
      if (route.request().method() === 'POST') {
        failedInput = route.request().postDataJSON()
        await route.abort('failed')
      } else await route.continue()
    })
    await page.getByTestId('message-input').fill(text)
    await page.getByTestId('send-message').click()
    await expect(page.getByRole('button', { name: '重试发送', exact: true })).toBeVisible()
    expect(failedInput).toBeDefined()
    await page.unroute(`**${messagePath}`)
    // Same BrowserContext means the other tab replaces the shared HttpOnly cookie.
    // Native API login deliberately emits no frontend broadcast, covering a lost notification.
    const switched = await post<{ user: { id: string } }>(switchTab.request, '/api/auth/login', { username, password })
    expect(switched.user.id).toBe(registered.user.id)
    expect(switched.user.id).not.toBe(original.user.id)
    const retry = page.getByRole('button', { name: '重试发送', exact: true })
    if (await retry.isVisible()) {
      const attempted = page.waitForResponse(response => new URL(response.url()).pathname === messagePath && response.request().method() === 'POST', { timeout: 3000 }).catch(() => null)
      await retry.click({ timeout: 1000 }).catch(() => {}) // a session-change invalidation may remove it first
      const response = await attempted
      if (response) expect([401, 409]).toContain(response.status())
    }
    // Even a delayed old action that bypasses UI invalidation must fail closed server-side.
    const rejected = await page.evaluate(async ({ path, expectedUser, input }) => {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Anyone-User-Id': expectedUser }, body: JSON.stringify(input) })
      return response.status
    }, { path: messagePath, expectedUser: original.user.id, input: failedInput! })
    expect(rejected).toBe(409)
    const history = await switchTab.request.get(`${base}${messagePath}`)
    expect(history.ok()).toBe(true)
    expect((await history.json()).data.messages.some((message: { text: string }) => message.text === text)).toBe(false)
    await openRoom(switchTab, lobby.id)
    await expect(switchTab.getByText(text, { exact: true })).toHaveCount(0)
  } finally { await switchTab.close(); await seed.close() }
})
