import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as base, expect } from '@playwright/test'
import { build } from 'vite'
import { startBrowserServer } from '../../server/tests/browser-server.ts'

export const test = base.extend<{
  browserApp: Awaited<ReturnType<typeof startBrowserServer>>
}, { webRoot: string }>({
  webRoot: [async ({ browserName }, use) => {
    const directory = await mkdtemp(join(tmpdir(), `clinmesh-e2e-${browserName}-`))
    const webRoot = join(directory, 'web')
    try {
      await build({
        root: fileURLToPath(new URL('../', import.meta.url)),
        envDir: false,
        logLevel: 'silent',
        build: { outDir: webRoot, emptyOutDir: true },
      })
      await use(webRoot)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, { scope: 'worker' }],
  browserApp: async ({ webRoot }, use) => {
    const app = await startBrowserServer(webRoot)
    try { await use(app) }
    finally { await app.close() }
  },
})

export { expect }
