import { existsSync } from 'node:fs'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as base, expect } from '@playwright/test'
import { build } from 'vite'
import { startBrowserServer } from '../../server/tests/browser-server.ts'

async function buildWebBundle(outDir: string) {
  const previousNodeEnv = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'production'
    await build({
      root: fileURLToPath(new URL('../', import.meta.url)),
      envDir: false,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    })
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
}

async function ensureSharedWebRoot(runDir: string): Promise<string> {
  const webRoot = join(runDir, 'web')
  const readyFile = join(runDir, 'web.ready')
  const errorFile = join(runDir, 'web.error')
  const lockFile = join(runDir, 'web.lock')

  while (!existsSync(readyFile)) {
    if (existsSync(errorFile)) {
      throw new Error(await readFile(errorFile, 'utf8'))
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(lockFile, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise(resolve => setTimeout(resolve, 100))
      continue
    }
    try {
      await buildWebBundle(webRoot)
      await writeFile(readyFile, 'ok')
    } catch (error) {
      await writeFile(errorFile, error instanceof Error ? error.stack ?? error.message : String(error)).catch(() => undefined)
      throw error
    } finally {
      await handle.close().catch(() => undefined)
      await rm(lockFile, { force: true }).catch(() => undefined)
    }
  }
  return webRoot
}

export const test = base.extend<{
  browserApp: Awaited<ReturnType<typeof startBrowserServer>>
}, { webRoot: string }>({
  webRoot: [async ({ browserName }, use) => {
    const prebuilt = process.env.CLINMESH_E2E_WEB_ROOT
    if (prebuilt) {
      await use(prebuilt)
      return
    }
    const runDir = process.env.CLINMESH_E2E_RUN_DIR
    if (runDir) {
      const webRoot = await ensureSharedWebRoot(runDir)
      await use(webRoot)
      return
    }
    const directory = await mkdtemp(join(tmpdir(), `clinmesh-e2e-${browserName}-`))
    const webRoot = join(directory, 'web')
    try {
      await buildWebBundle(webRoot)
      await use(webRoot)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, { scope: 'worker', timeout: 120_000 }],
  browserApp: async ({ webRoot }, use) => {
    const app = await startBrowserServer(webRoot)
    try { await use(app) }
    finally { await app.close() }
  },
})

export { expect }
