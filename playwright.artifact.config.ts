import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Reuse loopback/isolated-DB guards, but execute the built server and built static frontend.
export default defineConfig({
  ...base,
  testMatch: 'pwa.spec.ts',
  grep: /static frontend serves|offline shell never caches/,
  outputDir: './test-results/artifact',
  webServer: {
    command: 'bun run scripts/e2e-server.ts --artifact',
    url: 'http://127.0.0.1:4190/readyz',
    timeout: 180000,
    reuseExistingServer: false
  }
})
