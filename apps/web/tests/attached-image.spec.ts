import { test, expect, type Page } from '@playwright/test'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cWQAAAAASUVORK5CYII=', 'base64')

async function mount(page: Page, fakeObserver = true) {
  await page.clock.install({ time: new Date('2030-01-07T23:59:40Z') })
  await page.clock.pauseAt(new Date('2030-01-07T23:59:50Z'))
  if (fakeObserver) await page.addInitScript(() => {
    const instances: Array<{ callback: IntersectionObserverCallback; targets: Set<Element> }> = []
    class Observer {
      targets = new Set<Element>()
      constructor(public callback: IntersectionObserverCallback) { instances.push(this) }
      observe(target: Element) { this.targets.add(target) }
      unobserve(target: Element) { this.targets.delete(target) }
      disconnect() { this.targets.clear() }
    }
    window.IntersectionObserver = Observer as unknown as typeof IntersectionObserver
    window.__imageIntersect = visible => {
      for (const observer of instances) for (const target of [...observer.targets]) observer.callback([{ target, isIntersecting: visible } as IntersectionObserverEntry], observer as unknown as IntersectionObserver)
    }
  })
  await page.route('**/__image-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div><script type="module" src="/tests/fixtures/attached-image.tsx"></script>' }))
  await page.goto('/__image-fixture')
  await page.waitForFunction(() => !!window.__imageFixture)
  await page.evaluate(() => window.__imageFixture.render())
  await expect(page.getByRole('status')).toContainText('图片将在滚动到附近时加载')
}

test('source component defers the authenticated request, retries with a loading state, and expires offscreen', async ({ page }) => {
  let requests = 0
  let releaseRetry: (() => void) | undefined
  const retryGate = new Promise<void>(resolve => { releaseRetry = resolve })
  await page.route('**/api/attachments/**', async route => {
    expect(route.request().headers()['x-anyone-user-id']).toBe('fixture-owner')
    requests++
    if (requests === 1) return route.fulfill({ status: 503, json: { error: { code: 'NETWORK', message: 'retry' } } })
    await retryGate
    return route.fulfill({ contentType: 'image/png', body: png })
  })
  await mount(page)
  expect(requests).toBe(0)
  await page.evaluate(() => window.__imageIntersect(false))
  expect(requests).toBe(0)
  await page.evaluate(() => window.__imageIntersect(true))
  const retry = page.getByRole('button', { name: '重试加载图片' })
  await expect(retry).toBeAttached()
  // The fake observer deliberately reports an offscreen source as near.
  await retry.evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.getByRole('status')).toContainText('正在加载图片')
  await expect(retry).toHaveCount(0)
  releaseRetry!()
  await expect(page.getByRole('img', { name: 'fixture.png' })).toBeAttached()
  await expect.poll(() => page.evaluate(() => window.__imageFixture.loads())).toBe(1)
  await page.evaluate(() => window.__imageIntersect(false))
  await page.clock.runFor(10_000)
  await expect(page.getByText('图片已过期', { exact: true })).toBeAttached()
  await expect(page.getByRole('img')).toHaveCount(0)
  await expect(page.getByRole('link')).toHaveCount(0)
  await expect(page.getByText('保留图片说明')).toBeAttached()
  expect(requests).toBe(2)
})

test('real observer waits for the scroll container and keeps the existing preview image geometry', async ({ page }) => {
  let requests = 0
  await page.route('**/api/attachments/**', route => { requests++; return route.fulfill({ contentType: 'image/png', body: png }) })
  await mount(page, false)
  const box = await page.locator('#timeline .image-link').boundingBox()
  expect(box!.height).toBeGreaterThanOrEqual(48)
  expect(box!.width).toBeGreaterThanOrEqual(48)
  expect(requests).toBe(0)
  await page.locator('#timeline').evaluate(element => { element.scrollTop = 1100 })
  await expect(page.getByRole('img')).toBeVisible()
  expect(requests).toBe(1)
  await page.locator('#timeline').evaluate(element => { element.scrollTop = 0 })
  await expect(page.getByRole('img')).toBeAttached()
  expect(requests).toBe(1)
  await page.evaluate(() => window.__imageFixture.render({}, 'preview'))
  const preview = page.locator('.attachment-preview > a.image-link')
  await expect(preview).toBeVisible()
  const previewBox = await preview.boundingBox()
  expect(previewBox!.width).toBe(48)
  expect(previewBox!.height).toBe(48)
  const imageBox = await preview.locator('img').boundingBox()
  expect(imageBox!.width).toBe(48)
  expect(imageBox!.height).toBe(48)
  expect(requests).toBe(2) // A remount must still validate ACL through api.resource.
})

for (const metadata of [{ expired: true }, { expiresAt: '2030-01-07T23:59:50Z' }]) {
  test(`known-expired metadata never requests bytes: ${JSON.stringify(metadata)}`, async ({ page }) => {
    let requests = 0
    await page.route('**/api/attachments/**', route => { requests++; return route.fulfill({ status: 410 }) })
    await mount(page)
    await page.evaluate(metadata => window.__imageFixture.render(metadata), metadata)
    await expect(page.getByText('图片已过期', { exact: true })).toBeAttached()
    await page.evaluate(() => window.__imageIntersect(true))
    expect(requests).toBe(0)
    await expect(page.getByRole('img')).toHaveCount(0)
  })
}
