import { expect, test } from 'bun:test'
import { readLimited } from '../src/security'

test('body read uses a total deadline despite progress and cancels the underlying reader', async () => {
  let cancelled = false
  let progress = 0
  let interval: ReturnType<typeof setInterval>
  const body = new ReadableStream<Uint8Array>({
    start(controller) { interval = setInterval(() => { controller.enqueue(new Uint8Array([1])); progress++ }, 10) },
    cancel() { cancelled = true; clearInterval(interval) }
  })
  const request = new Request('http://localhost', { method: 'POST', body })
  let result: unknown
  const started = Date.now()
  try {
    result = await Promise.race([
      readLimited(request, 1024, 70).catch(error => error),
      Bun.sleep(300).then(() => 'deadline missing')
    ])
    expect(result).toMatchObject({ status: 408, code: 'REQUEST_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(250)
    expect(progress).toBeGreaterThan(1)
    expect(cancelled).toBe(true)
    expect(request.body!.locked).toBe(false)
  } finally { clearInterval(interval!); if (!request.body!.locked) await request.body!.cancel() }
})
