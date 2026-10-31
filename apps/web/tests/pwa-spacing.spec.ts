import { expect, test } from '@playwright/test'

for (const width of [320, 390, 1440]) {
  test(`application and notification buttons keep a 24px gap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
    await page.routeWebSocket('**/socket.io/**', socket => socket.close())
    await page.route('**/socket.io/**', route => route.fulfill({ status: 503, body: 'fixture realtime disabled' }))
    const user = { id: 'spacing-user', displayName: '布局验证', username: null, isGuest: true }
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      const data = path === '/api/session' ? { user } : path === '/api/rooms' || path === '/api/rooms/public' ? { rooms: [] } : null
      return route.fulfill({ json: { data } })
    })
    await page.goto('/')
    await page.getByRole('button', { name: '个人设置' }).click()
    const dialog = page.getByRole('dialog', { name: '个人设置' })
    const install = dialog.getByRole('button', { name: '安装到桌面', exact: true })
    const notifications = dialog.getByRole('button', { name: '开启消息通知', exact: true })
    await expect(install).toBeVisible()
    await expect(notifications).toBeVisible()
    const gap = async () => {
      const first = await install.boundingBox()
      const second = await notifications.boundingBox()
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      return second!.y - (first!.y + first!.height)
    }
    await expect.poll(gap).toBeCloseTo(24, 1)
    // The manual-install explanation must remain in the first action's group
    // without collapsing the space before notification settings.
    await install.click()
    await expect(dialog.getByText(/iPhone \/ iPad：在 Safari/)).toBeVisible()
    await expect.poll(gap).toBeGreaterThanOrEqual(24)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await notifications.scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath(`pwa-actions-${width}.png`), animations: 'disabled' })
  })
}
