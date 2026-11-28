import { availableParallelism } from 'node:os'
import { defineConfig, devices } from '@playwright/test'

// Vite builds must not enable production-only defaults in the test host.
process.env.NODE_ENV = 'test'

const envWorkers = Number(process.env.PLAYWRIGHT_WORKERS)
const workers = Number.isInteger(envWorkers) && envWorkers > 0
  ? envWorkers
  : process.env.CI
    ? 2
    : Math.min(6, Math.max(2, Math.floor(availableParallelism() / 2)))

export default defineConfig({
  testDir: './apps',
  globalSetup: './apps/web/e2e/global-setup.ts',
  fullyParallel: true,
  workers,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results',
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    },
  },
  projects: [
    { name: 'contracts', testMatch: '**/*.browser.test.ts', timeout: 30_000 },
    { name: 'web', testMatch: '**/e2e/*.spec.ts' },
  ],
})
