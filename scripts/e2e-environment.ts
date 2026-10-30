export type TestEnvironment = Record<string, string>

export function createTestEnvironment(base: Record<string, string | undefined>, directory: string): TestEnvironment {
  const env: TestEnvironment = Object.fromEntries(Object.entries(base).filter((pair): pair is [string, string] => pair[1] !== undefined))
  const mysql = base.DB_PROVIDER === 'mysql'
  if (mysql) {
    if (base.ANYONE_E2E_MYSQL !== '1') throw new Error('MySQL E2E requires explicit ANYONE_E2E_MYSQL=1')
    const url = new URL(base.DATABASE_URL ?? '')
    if (url.protocol !== 'mysql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/(anyone_ci|anyone_test_[a-z0-9_]+)$/.test(url.pathname)) {
      throw new Error('Refusing non-loopback or non-test MySQL database')
    }
  }
  return {
    ...env,
    NODE_ENV: 'test',
    DB_PROVIDER: mysql ? 'mysql' : 'sqlite',
    DATABASE_URL: mysql ? base.DATABASE_URL! : `file:${directory}/test.db`,
    DATA_DIR: directory,
    HOST: '127.0.0.1',
    PORT: '4190',
    PUBLIC_ORIGIN: 'http://127.0.0.1:4190',
    ALLOWED_ORIGINS: 'http://127.0.0.1:4190',
    RATE_LIMIT_AUTH_MAX: '100'
  }
}
