import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const provider = process.env.DB_PROVIDER ?? 'sqlite'
if (provider !== 'sqlite' && provider !== 'mysql') throw new Error('DB_PROVIDER must be sqlite or mysql')
const operation = process.argv[2]
if (operation !== 'generate' && operation !== 'push') throw new Error('Usage: bun scripts/database.ts generate|push')
const root = resolve(import.meta.dir, '..')
const dataDir = resolve(process.env.DATA_DIR ?? resolve(root, '../../.data'))
await mkdir(dataDir, { recursive: true, mode: 0o700 })
const url = process.env.DATABASE_URL ?? (provider === 'sqlite' ? `file:${dataDir}/relay.sqlite` : '')
if (!url) throw new Error('DATABASE_URL is required for mysql')
if (provider === 'sqlite' && url.startsWith('file:')) await mkdir(dirname(url.slice(5)), { recursive: true, mode: 0o700 })
const schema = resolve(root, `prisma/${provider}.prisma`)
const args = operation === 'generate' ? ['generate', '--schema', schema] : ['db', 'push', '--schema', schema, '--skip-generate']
const proc = Bun.spawn([process.execPath, resolve(root, 'node_modules/prisma/build/index.js'), ...args], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdout: 'inherit', stderr: 'inherit' })
process.exit(await proc.exited)
