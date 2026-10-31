import { expect, test } from '@playwright/test'

test('a real private room uses a password link without an invitation, including password rotation', async ({ page, browser, baseURL }) => {
  const origin = { Origin: baseURL! }
  const login = async (request: typeof page.request, name: string) => {
    const response = await request.post('/api/auth/guest', { headers: origin, data: { displayName: name } })
    expect(response.ok()).toBe(true)
    return (await response.json()).data.user.id as string
  }
  const ownerId = await login(page.request, '密码房主')
  const ownerHeaders = { ...origin, 'X-Anyone-User-Id': ownerId }
  const created = await page.request.post('/api/rooms', { headers: ownerHeaders, data: { name: '真实密码房间', visibility: 'private', password: 'initial room secret' } })
  expect(created.ok()).toBe(true)
  const roomId = (await created.json()).data.id as string
  const peer = await browser.newContext({ baseURL })
  const newcomer = await browser.newContext({ baseURL })
  try {
    await login(peer.request, '密码成员')
    const memberPage = await peer.newPage()
    await memberPage.goto(`/?room=${roomId}`)
    const dialog = memberPage.getByRole('dialog', { name: '发现公开房间' })
    await expect(dialog.getByLabel('私密房间 ID')).toHaveValue(roomId)
    await dialog.getByLabel('房间密码', { exact: true }).fill('incorrect room secret')
    await dialog.getByRole('button', { name: '密码加入私密房间' }).click()
    await expect(dialog.getByRole('alert')).toContainText('聊天室不存在')
    await dialog.getByLabel('房间密码', { exact: true }).fill('initial room secret')
    await dialog.getByRole('button', { name: '密码加入私密房间' }).click()
    await expect(memberPage.getByRole('heading', { name: '真实密码房间', exact: true })).toBeVisible()
    expect(memberPage.url()).not.toContain('secret')
    expect(await memberPage.evaluate(() => JSON.stringify(localStorage))).not.toContain('initial room secret')
    const updated = await page.request.patch(`/api/rooms/${roomId}/password`, { headers: ownerHeaders, data: { password: 'replacement room secret' } })
    expect(updated.ok()).toBe(true)
    const newId = await login(newcomer.request, '新成员')
    const newHeaders = { ...origin, 'X-Anyone-User-Id': newId }
    expect((await newcomer.request.post(`/api/rooms/${roomId}/join`, { headers: newHeaders, data: { password: 'initial room secret' } })).status()).toBe(404)
    expect((await newcomer.request.post(`/api/rooms/${roomId}/join`, { headers: newHeaders, data: { password: 'replacement room secret' } })).ok()).toBe(true)
    await memberPage.screenshot({ path: test.info().outputPath('password-room-joined.png') })
  } finally { await peer.close(); await newcomer.close() }
})
