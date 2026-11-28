import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.browser.test.ts', 'e2e/**'],
    setupFiles: ['./src/test-setup.ts'],
  },
})
