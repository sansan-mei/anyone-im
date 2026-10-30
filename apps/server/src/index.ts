import { createApplication } from './app'
export { createApplication } from './app'
export type { ApplicationOptions } from './app'

if (import.meta.main) {
  const application = await createApplication()
  console.log(`Anyone listening at ${application.url}`)
  const stop = async () => { await application.close(); process.exit(0) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
