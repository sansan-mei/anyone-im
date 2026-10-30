import { expect, test } from '@playwright/test'

// Isolated visual fixture; no backend, seed data, or production conversations.
test('Material-inspired blue surfaces, readable hierarchy and responsive themes', async ({ page }) => {
  const user = { id: 'style-me', displayName: '林间', username: null, isGuest: true }
  const room = { id: 'style-room', name: '设计讨论', description: '一起把想法变成现实', visibility: 'private', role: 'member', memberCount: 2, onlineCount: 1, lastSeq: 2, lastReadSeq: 2, lastMessage: null, updatedAt: '2026-01-01T12:00:00Z' }
  const messages = [
    { id: 'style-1', seq: 1, sender: { ...user, id: 'style-peer', displayName: '小雨' }, text: '新的方向很清晰。让对话成为界面的主角。' },
    { id: 'style-2', seq: 2, sender: user, text: '留一些呼吸的空间，也让每一个操作更自然。' },
  ].map(m => ({ ...m, roomId: room.id, clientMessageId: `00000000-0000-4000-8000-${String(m.seq).padStart(12, '0')}`, attachment: null, createdAt: '2026-01-01T12:00:00Z', deletedAt: null }))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.routeWebSocket('**/socket.io/**', ws => {
    ws.send('0' + JSON.stringify({ sid: 'style-engine', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 }))
    ws.onMessage(packet => {
      const p = String(packet)
      if (p === '40') ws.send('40' + JSON.stringify({ sid: 'style-socket' }))
      const ack = p.match(/^42(\d+)(.*)$/)
      if (ack) ws.send(`43${ack[1]}${JSON.stringify([{ data: { messages: [], hasMore: false } }])}`)
    })
  })
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const data = path === '/api/session' ? { user } : path === '/api/rooms' ? { rooms: [room] } : path.endsWith('/messages') ? { messages, hasMore: false } : null
    return route.fulfill({ json: { data } })
  })
  await page.goto('/')
  await expect(page.locator('.connection')).toContainText('实时连接已建立')
  await page.getByTestId('message-input').fill('一起开始下一段对话')
  const send = page.getByTestId('send-message')
  await expect(send).toHaveCSS('background-color', 'rgb(11, 87, 208)')
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(234, 241, 251)')
  await expect(page.getByTestId('chat-panel')).toHaveCSS('border-top-left-radius', '24px')
  await expect(page.locator('.bubble').first()).toHaveCSS('font-size', '15px')
  await expect(page.locator('.message-meta').first()).toHaveCSS('font-size', '12px')
  await expect(page.locator('.room-copy > span')).toHaveCSS('font-size', '13px')
  await page.screenshot({ path: 'test-results/material-desktop-light.png' })

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    const pairs = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      const rgb = (token: string) => {
        const probe = document.createElement('span')
        probe.style.color = root.getPropertyValue(token)
        document.body.append(probe)
        const values = getComputedStyle(probe).color.match(/\d+/g)!.slice(0, 3).map(Number)
        probe.remove()
        const linear = values.map(v => { const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4 })
        return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]
      }
      return [['--ink', '--panel'], ['--muted', '--side'], ['--muted', '--accent-soft'], ['--on-accent', '--accent'], ['--accent', '--accent-soft']].map(([fg, bg]) => {
        const a = rgb(fg), b = rgb(bg)
        return { pair: `${fg}/${bg}`, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
      })
    })
    for (const pair of pairs) expect(pair.contrast, `${theme}: ${pair.pair}`).toBeGreaterThanOrEqual(4.5)
  }
  await expect(send).toHaveCSS('background-color', 'rgb(168, 199, 250)')
  await page.screenshot({ path: 'test-results/material-desktop-dark.png' })
  await page.setViewportSize({ width: 320, height: 568 })
  await expect(page.getByTestId('chat-panel')).toHaveCSS('border-top-left-radius', '0px')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/material-mobile-dark-320.png' })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.screenshot({ path: 'test-results/material-mobile-light-320.png' })
})
