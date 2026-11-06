import { expect, test } from '@playwright/test'

// Browser layout/integration coverage; offline Node tests cover journal/async ordering.
test('bounded history windows retain backscroll, expose forward paging, and cold-load evicted rooms', async ({ page }) => {
  // This intentionally performs 22 sequential history requests plus nine room visits.
  // Keep each assertion's normal timeout; allow enough time for the complete browser journey.
  test.setTimeout(60_000)
  const user = { id: 'history-user', displayName: '历史用户', username: null, isGuest: true }
  const rooms = Array.from({ length: 9 }, (_, i) => ({ id: `history-${i}`, name: `历史房间 ${i}`, description: '', visibility: 'public', role: 'owner', memberCount: 1, onlineCount: 1, lastSeq: 345, lastReadSeq: 0, lastMessage: null, updatedAt: '2026-11-01T00:00:00Z' }))
  let coldReads = 0
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.routeWebSocket('**/socket.io/**', ws => ws.close())
  await page.route('**/socket.io/**', route => route.fulfill({ status: 503, body: 'offline fixture' }))
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url())
    const data = (value: unknown) => route.fulfill({ json: { data: value } })
    if (url.pathname === '/api/session') return data({ user })
    if (url.pathname === '/api/rooms') return data({ rooms })
    if (url.pathname.endsWith('/read')) return data(null)
    const match = url.pathname.match(/^\/api\/rooms\/(history-\d+)\/messages$/)
    if (match) {
      const roomId = match[1], before = Number(url.searchParams.get('beforeSeq') || 346), after = url.searchParams.has('afterSeq') ? Number(url.searchParams.get('afterSeq')) : undefined
      if (roomId === 'history-0' && !url.searchParams.has('beforeSeq') && after === undefined) coldReads++
      const rows = Array.from({ length: 345 }, (_, i) => ({ id: `${roomId}-${i + 1}`, roomId, seq: i + 1, clientMessageId: `${i + 1}`, sender: user, text: `窗口消息 ${i + 1}`, attachment: null, createdAt: '2026-11-01T00:00:00Z', deletedAt: null })).filter(m => after === undefined ? m.seq < before : m.seq > after)
      return data({ messages: after === undefined ? rows.slice(-15) : rows.slice(0, 15), hasMore: rows.length > 15, changeCursor: { generation: 'fixture', revision: 0 } })
    }
    return data(null)
  })
  await page.goto('/?room=history-0')
  const list = page.getByTestId('message-list'), articles = list.locator('article[data-message-id]')
  await expect(articles).toHaveCount(15)
  await expect(articles.last()).toHaveAttribute('data-message-id', 'history-0-345')
  expect(await articles.first().evaluate(el => getComputedStyle(el).contentVisibility)).toBe('auto')
  for (let i = 1; i <= 22; i++) {
    await list.evaluate(el => { el.scrollTop = 0 })
    await page.getByRole('button', { name: '加载更早消息', exact: true }).click()
    await expect(articles.first()).toHaveAttribute('data-message-id', `history-0-${331 - i * 15}`)
    await expect(articles).toHaveCount(Math.min(300, (i + 1) * 15))
  }
  await expect(page.getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '加载更新消息', exact: true })).toBeVisible()
  await list.evaluate(el => { el.scrollTop = el.scrollHeight })
  await page.getByRole('button', { name: '加载更新消息', exact: true }).click()
  await expect(articles.last()).toHaveAttribute('data-message-id', 'history-0-315')
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click()
  await expect(articles).toHaveCount(15)
  await expect(articles.last()).toHaveAttribute('data-message-id', 'history-0-345')
  expect(coldReads).toBe(2)
  for (let i = 1; i <= 8; i++) {
    await page.getByTestId(`room-history-${i}`).click()
    await expect(articles.last()).toHaveAttribute('data-message-id', `history-${i}-345`)
  }
  await page.getByTestId('room-history-0').click()
  await expect(articles.last()).toHaveAttribute('data-message-id', 'history-0-345')
  expect(coldReads).toBe(3)
  expect(errors).toEqual([])
})
