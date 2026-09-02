import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readServerConfig, readServerEnvironment } from './config.ts'
import { runDatabaseCli } from './database-cli.ts'
import { runReferenceDatabaseCli } from './reference-database-cli.ts'

export async function prepareDevelopmentDatabases(input: {
  busyTimeoutMs?: number
  databasePath: string
  referenceDatabasePath?: string
}) {
  const busyTimeoutMs = String(input.busyTimeoutMs ?? 5_000)
  const operational = await runDatabaseCli([
    'migrate',
    '--database', resolve(input.databasePath),
    '--busy-timeout-ms', busyTimeoutMs,
  ], {})
  const reference = input.referenceDatabasePath === undefined
    ? null
    : await runReferenceDatabaseCli([
        'migrate',
        '--database', resolve(input.referenceDatabasePath),
        '--busy-timeout-ms', busyTimeoutMs,
      ])
  return { operational, reference }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  const environment = readServerEnvironment(process.env)
  const config = readServerConfig(environment)
  const result = await prepareDevelopmentDatabases({
    busyTimeoutMs: Number(environment.CLINMESH_BUSY_TIMEOUT_MS ?? '5000'),
    databasePath: config.databasePath,
    ...(config.referenceDatabasePath === undefined
      ? {}
      : { referenceDatabasePath: config.referenceDatabasePath }),
  })
  console.info(JSON.stringify(result))
}
