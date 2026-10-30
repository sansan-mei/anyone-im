import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', outputDir: './test-results', fullyParallel: false,
  timeout: 20000, expect: { timeout: 5000 },
  use: { baseURL: 'http://127.0.0.1:4101', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: { command: 'bun run dev', url: 'http://127.0.0.1:4101', reuseExistingServer: false, timeout: 30000 },
})
