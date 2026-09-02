import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'dsh-react-surface/client': fileURLToPath(
        new URL('./src/client/dsh-react-surface.test-stub.ts', import.meta.url),
      ),
    },
  },
})
