import { expect, test } from '@playwright/test'

for (const visibility of ['public', 'private'] as const) {
  test(`${visibility} history and reconnect use 15-message batches without gaps or lost tombstones`, async ({ page, browser, baseURL }) => {
    const peer = await browser.newContext({ baseURL })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const enter = async (request: typeof page.request, name: string) => {
        const response = await request.post('/api/auth/guest', { data: { displayName: name } })
        expect(response.ok()).toBe(true)
        return (await response.json()).data.user.id as string
      }
      const ownerId = await enter(page.request, '分页房主')
      const peerId = await enter(peer.request, '分页成员')
      const ownerHeaders = { 'X-Anyone-User-Id': ownerId }
      const peerHeaders = { 'X-Anyone-User-Id': peerId }
      const created = await page.request.post('/api/rooms', { headers: ownerHeaders, data: { name: '分页验证', visibility } })
      expect(created.ok()).toBe(true)
      const roomId = (await created.json()).data.id
      const path = `/api/rooms/${roomId}/messages`
      const invite = await page.request.post(`/api/rooms/${roomId}/invites`, { headers: ownerHeaders, data: {} })
      const code = (await invite.json()).data.code
      expect((await peer.request.post(`/api/invites/${code}`, { headers: peerHeaders, data: {} })).ok()).toBe(true)
      const send = async (request: typeof page.request, headers: Record<string, string>, seq: number) => {
        const response = await request.post(path, { headers, data: { clientMessageId: crypto.randomUUID(), text: `分页消息 ${seq}` } })
        expect(response.ok()).toBe(true)
        return (await response.json()).data.id as string
      }
      const ids: string[] = []
      for (let seq = 1; seq <= 46; seq++) ids.push(await send(page.request, ownerHeaders, seq))
      const requests: URL[] = []
      const failures: number[] = []
      page.on('request', request => { const url = new URL(request.url()); if (url.pathname === path && request.method() === 'GET') requests.push(url) })
      page.on('response', response => { if (new URL(response.url()).pathname === path && !response.ok()) failures.push(response.status()) })
      await page.goto(`/?room=${roomId}`)
      const list = page.getByTestId('message-list')
      await expect(list.locator('.message')).toHaveCount(15)
      await expect(page.getByText('实时连接已建立', { exact: true })).toBeVisible()
      await expect.poll(() => requests.length).toBeGreaterThan(0)
      expect(requests.every(url => url.searchParams.get('limit') === '15')).toBe(true)
      for (const count of [30, 45, 46]) {
        await list.evaluate(el => { el.scrollTop = 0 })
        await page.getByRole('button', { name: '加载更早消息' }).click()
        await expect(list.locator('.message')).toHaveCount(count)
      }
      await expect(page.getByRole('button', { name: '加载更早消息' })).toHaveCount(0)
      await page.evaluate(() => window.dispatchEvent(new Event('offline')))
      await expect(page.locator('.connection.offline')).toBeVisible()
      expect((await page.request.delete(`/api/messages/${ids[0]}`, { headers: ownerHeaders })).ok()).toBe(true)
      for (let seq = 47; seq <= 83; seq++) await send(peer.request, peerHeaders, seq)
      const refreshStart = requests.length
      await page.evaluate(() => window.dispatchEvent(new Event('online')))
      await expect(list.locator('.message')).toHaveCount(83)
      await expect(page.getByText('分页消息 1', { exact: true })).toHaveCount(0)
      await expect(list.getByText('消息已删除', { exact: true })).toHaveCount(1)
      for (let seq = 2; seq <= 83; seq++) await expect(list.getByText(`分页消息 ${seq}`, { exact: true })).toHaveCount(1)
      await expect.poll(() => requests.slice(refreshStart).some(url => url.searchParams.get('afterSeq') === '76')).toBe(true)
      expect(requests.every(url => url.searchParams.get('limit') === '15')).toBe(true)
      expect(failures).toEqual([])
      expect(errors).toEqual([])
      // Recovering and rendering many batches does not impose a total-history cap.
      const stored = await page.request.get(`${path}?afterSeq=0&limit=20`)
      expect((await stored.json()).data.messages[0]).toMatchObject({ seq: 1, text: '' })
      await page.screenshot({ path: test.info().outputPath(`${visibility}-recovered.png`), fullPage: true })
    } finally { await peer.close() }
  })
}
