import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readServerConfig, readServerEnvironment } from './config.ts'
import { createClinMeshRuntime } from './runtime.ts'
import { startServer } from './server.ts'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const config = readServerConfig(readServerEnvironment(process.env))
const defaultWebRoot = resolve(moduleDirectory, '../../web/dist')
const webRoot = resolve(config.webRoot ?? defaultWebRoot)
const databasePath = resolve(config.databasePath)
await mkdir(dirname(databasePath), { recursive: true })
const runtime = await createClinMeshRuntime({
  ...(config.ai === undefined ? {} : { ai: config.ai }),
  ...(config.referenceReleaseId === undefined
    ? {}
    : { activeReferenceReleaseId: config.referenceReleaseId }),
  authBaseUrl: config.authBaseUrl,
  authSecret: config.authSecret,
  autoDispatchIntervalMs: 250,
  cursorSecret: config.cursorSecret,
  databasePath,
  demoPassword: config.demoPassword,
  ...(config.dshBridgeSecret === undefined
    ? {}
    : { dshBridgeSecret: config.dshBridgeSecret }),
  migrationMode: 'verify',
  ...(config.referenceDatabasePath === undefined
    ? {}
    : { referenceDatabasePath: config.referenceDatabasePath }),
  ...(config.syntheaProviderUrl === undefined
    ? {}
    : { syntheaProviderUrl: config.syntheaProviderUrl }),
  trustedOrigins: config.trustedOrigins,
  webRoot,
})
const server = startServer({
  app: runtime.app,
  hostname: config.hostname,
  port: config.port,
})

server.once('close', () => {
  void runtime.close().catch(() => {
    console.error('ClinMesh runtime shutdown failed')
  })
})

server.once('listening', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  console.info(`ClinMesh listening on http://${config.hostname}:${port}`)
})

const shutdown = (): void => {
  server.close()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
