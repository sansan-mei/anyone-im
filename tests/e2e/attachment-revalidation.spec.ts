import { expect, test } from '@playwright/test'

const base = 'http://127.0.0.1:4190'

test('private image reload revalidates over HTTP with 304 and zero encoded body bytes', async ({ page, browser }) => {
  // Do not add page/context.route: Playwright routing disables the HTTP cache.
  const owner = page.context()
  const outsider = await browser.newContext()
  const cdp = await owner.newCDPSession(page)
  try {
    const guest = async (context: typeof owner, name: string) => {
      const response = await context.request.post(`${base}/api/auth/guest`, { headers: { Origin: base }, data: { displayName: name } })
      expect(response.status()).toBe(200)
      return (await response.json()).data.user.id as string
    }
    const userId = await guest(owner, 'HTTP cache owner')
    const outsiderId = await guest(outsider, 'HTTP cache outsider')
    const auth = { Origin: base, 'X-Anyone-User-Id': userId }
    const created = await owner.request.post(`${base}/api/rooms`, { headers: auth, data: { name: 'HTTP revalidation', password: 'cache-room-secret' } })
    expect(created.status()).toBe(200)
    const roomId = (await created.json()).data.id as string
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cWQAAAAASUVORK5CYII=', 'base64')
    const uploaded = await owner.request.post(`${base}/api/rooms/${roomId}/attachments`, { headers: auth, multipart: { file: { name: 'revalidation.png', mimeType: 'image/png', buffer: png } } })
    expect(uploaded.status()).toBe(200)
    const attachment = (await uploaded.json()).data as { id: string; url: string }
    const sent = await owner.request.post(`${base}/api/rooms/${roomId}/messages`, { headers: auth, data: { clientMessageId: crypto.randomUUID(), text: '', attachmentId: attachment.id } })
    expect(sent.status()).toBe(200)
    const messageId = (await sent.json()).data.id as string

    type Transfer = { url?: string; status?: number; headers?: Record<string, string>; encodedBody: number; finished?: boolean }
    const transfers = new Map<string, Transfer>()
    const transfer = (id: string) => {
      let value = transfers.get(id)
      if (!value) { value = { encodedBody: 0 }; transfers.set(id, value) }
      return value
    }
    // ExtraInfo exposes actual wire status (fetch itself receives the merged 200).
    cdp.on('Network.requestWillBeSent', event => { transfer(event.requestId).url = event.request.url })
    cdp.on('Network.requestWillBeSentExtraInfo', event => { transfer(event.requestId).headers = event.headers })
    cdp.on('Network.responseReceivedExtraInfo', event => { transfer(event.requestId).status = event.statusCode })
    cdp.on('Network.dataReceived', event => { transfer(event.requestId).encodedBody += event.encodedDataLength })
    cdp.on('Network.loadingFinished', event => { transfer(event.requestId).finished = true })
    await cdp.send('Network.enable')
    await page.goto(base)
    await page.getByTestId(`room-${roomId}`).click()
    const image = page.getByRole('img', { name: 'revalidation.png', exact: true })
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const imageTransfers = () => [...transfers.values()].filter(value => value.url === `${base}${attachment.url}`)
    await expect.poll(() => imageTransfers().some(value => value.status === 200 && value.finished)).toBe(true)
    expect(imageTransfers().some(value => value.status === 200 && value.encodedBody > 0)).toBe(true)
    transfers.clear()

    await page.reload()
    // Room selection may or may not be restored; both paths exercise real UI fetch-to-Blob.
    if (!await page.getByTestId('message-input').isVisible()) await page.getByTestId(`room-${roomId}`).click()
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => imageTransfers().some(value => {
      const headers = Object.fromEntries(Object.entries(value.headers ?? {}).map(([key, val]) => [key.toLowerCase(), val]))
      return value.status === 304 && value.finished && Boolean(headers['if-none-match']) && headers['x-anyone-user-id'] === userId
    })).toBe(true)
    const revalidated = imageTransfers().filter(value => value.status === 304 && value.finished)
    for (const value of revalidated) {
      const headers = Object.fromEntries(Object.entries(value.headers ?? {}).map(([key, val]) => [key.toLowerCase(), val]))
      expect(headers['if-none-match']).toMatch(/^"[a-f0-9]{64}"$/)
      expect(headers['x-anyone-user-id']).toBe(userId)
      expect(value.encodedBody).toBe(0)
    }
    expect(imageTransfers().some(value => value.status === 200)).toBe(false)

    const resource = (expectedUser: string) => page.evaluate(async ({ url, expectedUser }) => {
      const response = await fetch(url, { credentials: 'same-origin', headers: { 'X-Anyone-User-Id': expectedUser } })
      return { status: response.status, cache: response.headers.get('cache-control'), etag: response.headers.get('etag') }
    }, { url: attachment.url, expectedUser })
    // Exercise an account switch while the successful cached image is still warm.
    const ownerCookies = await owner.cookies()
    await owner.addCookies(await outsider.cookies())
    expect(await resource(userId)).toEqual({ status: 409, cache: 'no-store', etag: null })
    expect(await resource(outsiderId)).toEqual({ status: 403, cache: 'no-store', etag: null })
    await owner.addCookies(ownerCookies)
    expect((await resource(userId)).status).toBe(200)
    // A cached browser entry also cannot override a newly deleted message.
    expect((await owner.request.delete(`${base}/api/messages/${messageId}`, { headers: auth })).status()).toBe(200)
    expect(await resource(userId)).toEqual({ status: 404, cache: 'no-store', etag: null })
  } finally {
    await cdp.detach()
    await outsider.close()
  }
})
