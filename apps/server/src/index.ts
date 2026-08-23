import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readServerConfig } from './config.ts'
import { startServer } from './server.ts'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const config = readServerConfig(process.env)
const defaultWebRoot = resolve(moduleDirectory, '../../web/dist')
const webRoot = resolve(config.webRoot ?? defaultWebRoot)
const server = startServer({
  hostname: config.hostname,
  port: config.port,
  webRoot,
})

server.once('listening', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  console.info(`ClinMesh listening on http://${config.hostname}:${port}`)
})
