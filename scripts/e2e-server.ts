import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestEnvironment } from './e2e-environment'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = await mkdtemp(join(tmpdir(), 'anyone-im-e2e-'))
const env = createTestEnvironment(process.env, directory)
env.PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ''}`
let child: ReturnType<typeof Bun.spawn> | undefined
let stopped = false
async function cleanup() {
  if (stopped) return
  stopped = true
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([child.exited, Bun.sleep(5000)])
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
  }
  await rm(directory, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void cleanup().then(() => process.exit(0)) })
}
try {
  for (const script of ['db:generate', 'db:push']) {
    const setup = Bun.spawn([process.execPath, 'run', '--filter', '@anyone-im/server', script], { cwd: root, env, stdout: 'inherit', stderr: 'inherit' })
    if (await setup.exited !== 0) throw new Error(`Isolated E2E setup failed: ${script}`)
  }
  const entry = process.argv.includes('--artifact') ? 'apps/server/dist/index.js' : 'apps/server/src/index.ts'
  child = Bun.spawn([process.execPath, 'run', entry], { cwd: root, env, stdout: 'inherit', stderr: 'inherit' })
  const exitCode = await child.exited
  await cleanup()
  process.exit(exitCode)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'E2E startup failed')
  await cleanup()
  process.exit(1)
}
