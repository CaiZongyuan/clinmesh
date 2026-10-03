import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/*.browser.test.ts'] },
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./src/client/dsh-ui-primitives.test-stub.tsx', import.meta.url),
      ),
      'dsh-react-surface/client': fileURLToPath(
        new URL('./src/client/dsh-react-surface.test-stub.ts', import.meta.url),
      ),
    },
  },
})
