import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'

export async function startBrowserServer(webRoot: string, options: Pick<CreateClinMeshRuntimeOptions,
  'chatCompletionsProvider' | 'dshModelBridge' | 'syntheaProvider' | 'autoDispatchIntervalMs'> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-e2e-server-'))
  let runtime: Awaited<ReturnType<typeof createClinMeshRuntime>> | undefined
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => runtime?.app.fetch(request) ?? new Response('Starting', { status: 503 }),
  })
  const close = async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
        if ('closeAllConnections' in server) server.closeAllConnections()
      })
    } finally {
      try { await runtime?.close() }
      finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
  try {
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing browser server address')
    const origin = `http://127.0.0.1:${address.port}`
    const password = `Synthetic-${randomUUID()}-Aa1!`
    runtime = await createClinMeshRuntime({
      ...options,
      authBaseUrl: origin,
      authSecret: randomUUID() + randomUUID(),
      cursorSecret: randomUUID() + randomUUID(),
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      imagingAssetDirectory: join(directory, 'imaging-assets'),
      imagingCatalogDirectory: join(directory, 'imaging-catalog'),
      migrationMode: 'apply',
      trustedOrigins: [origin],
      webRoot,
    })
    return { origin, password, close, runtime }
  } catch (error) {
    await close()
    throw error
  }
}
