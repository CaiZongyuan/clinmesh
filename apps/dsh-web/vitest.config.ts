import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
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
