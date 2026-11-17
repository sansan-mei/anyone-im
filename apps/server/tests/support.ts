import { afterAll, afterEach, beforeAll } from 'bun:test'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EXPECTED_USER_HEADER } from '@anyone-im/contracts'
import type { ApplicationOptions } from '../src/app'

// Shared isolated-SQLite fixture for focused suites. Each test gets its own
// copy of a schema-initialized template database and a real loopback listener.
const cleanups: Array<() => Promise<void>> = []
let templateDir: string
export function useIsolatedDatabase() {
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
  beforeAll(async () => {
    templateDir = await mkdtemp(join(tmpdir(), 'anyone-schema-'))
    const proc = Bun.spawn([process.execPath, 'scripts/database.ts', 'push'], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, DB_PROVIDER: 'sqlite', DATABASE_URL: `file:${templateDir}/template.sqlite` },
      stdout: 'pipe', stderr: 'pipe', timeout: 20000
    })
    const [status, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    if (status !== 0) throw new Error(`Test schema initialization failed (${status}):\n${stdout}\n${stderr}`)
  }, 30000)
  afterAll(async () => { if (templateDir) await rm(templateDir, { recursive: true, force: true }) })
}

export async function fixture(options: ApplicationOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'anyone-db-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const databaseUrl = `file:${dir}/test.sqlite`
  await copyFile(join(templateDir, 'template.sqlite'), join(dir, 'test.sqlite'))
  const { createApplication } = await import('../src/app')
  const app = await createApplication({ port: 0, host: '127.0.0.1', dataDir: dir, databaseUrl, ...options })
  cleanups.push(() => app.close())
  return { ...app, dir, databaseUrl }
}

export async function database(url: string) {
  const { PrismaClient } = await import('../generated/client')
  const db = new PrismaClient({ datasources: { db: { url } } })
  cleanups.push(() => db.$disconnect())
  return db
}

export function agent(url: string) {
  let cookie = ''
  let userId = ''
  return {
    get cookie() { return cookie },
    get userId() { return userId },
    async request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(`${url}${path}`, { method, headers: { ...(cookie ? { cookie, [EXPECTED_USER_HEADER]: userId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]!
      const text = await response.text()
      let bodyResult: any
      try { bodyResult = JSON.parse(text) } catch { bodyResult = text }
      if (response.ok && (path === '/api/session' || /^\/api\/auth\/(guest|register|login)$/.test(path))) userId = bodyResult.data.user?.id ?? ''
      return { status: response.status, body: bodyResult, headers: response.headers }
    }
  }
}

export async function guests(url: string, ...names: string[]) {
  const clients = names.map(() => agent(url))
  for (const [i, client] of clients.entries()) await client.request('/api/auth/guest', { displayName: names[i] })
  return clients
}
