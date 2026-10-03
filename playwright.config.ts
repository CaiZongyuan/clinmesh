import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './apps',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results',
  reporter: 'list',
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
