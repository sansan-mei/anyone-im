import { expect, test } from 'bun:test'
import * as setup from './e2e-environment'

const build = () => {
  const fn = (setup as Record<string, any>).createTestEnvironment
  expect(fn).toBeDefined()
  return fn as (env: Record<string, string | undefined>, directory: string) => Record<string, string>
}
test('default E2E database cannot inherit a production database URL', () => {
  const env = build()({ DATABASE_URL: 'mysql://not-a-real-host/production' }, '/workspace/sandbox')
  expect(env.DB_PROVIDER).toBe('sqlite')
  expect(env.DATABASE_URL).toBe('file:/workspace/sandbox/test.db')
  expect(env.HOST).toBe('127.0.0.1')
  expect(env.PORT).toBe('4190')
})
test('MySQL E2E requires explicit opt-in and an isolated loopback test database', () => {
  expect(() => build()({ DB_PROVIDER: 'mysql', DATABASE_URL: 'mysql://test:test@127.0.0.1:3306/relay_ci' }, '/x')).toThrow()
  expect(() => build()({ DB_PROVIDER: 'mysql', RELAY_E2E_MYSQL: '1', DATABASE_URL: 'mysql://test:test@not-a-real-host/relay_ci' }, '/x')).toThrow()
  expect(() => build()({ DB_PROVIDER: 'mysql', RELAY_E2E_MYSQL: '1', DATABASE_URL: 'mysql://test:test@127.0.0.1/production' }, '/x')).toThrow()
  const env = build()({ DB_PROVIDER: 'mysql', RELAY_E2E_MYSQL: '1', DATABASE_URL: 'mysql://test:test@127.0.0.1:3306/relay_ci' }, '/x')
  expect(env.DB_PROVIDER).toBe('mysql')
  expect(env.DATABASE_URL).toEndWith('/relay_ci')
})
