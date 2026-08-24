import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  applyMigrations,
  backupDatabase,
  expectedSchemaVersion,
  openClinMeshDatabase,
  rebuildDatabaseIndexes,
  restoreDatabase,
  verifyMigrations,
} from './infrastructure/sqlite/database.ts'

const commandSchema = z.enum(['backup', 'migrate', 'reindex', 'restore', 'verify'])
const optionNames = new Set([
  '--backup',
  '--busy-timeout-ms',
  '--database',
  '--destination',
  '--output',
])

function parseOptions(arguments_: string[]): Map<string, string> {
  const options = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (name === undefined || !optionNames.has(name) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid database CLI option near: ${name ?? '<end>'}`)
    }
    if (options.has(name)) throw new Error(`Database CLI option was repeated: ${name}`)
    options.set(name, value)
  }
  return options
}

function requiredPath(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`${label} is required`)
  return resolve(value)
}

export async function runDatabaseCli(
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const [commandValue, ...optionArguments] = arguments_
  const command = commandSchema.parse(commandValue)
  const options = parseOptions(optionArguments)
  const busyTimeoutMs = z.coerce.number().int().min(1).max(60_000).parse(
    options.get('--busy-timeout-ms') ?? environment.CLINMESH_BUSY_TIMEOUT_MS ?? '5000',
  )

  if (command === 'restore') {
    return restoreDatabase({
      backupPath: requiredPath(options.get('--backup'), 'Backup path'),
      busyTimeoutMs,
      destinationPath: requiredPath(options.get('--destination'), 'Restore destination'),
      expectedSchemaVersion: expectedSchemaVersion(),
    })
  }

  const databasePath = requiredPath(
    options.get('--database') ?? environment.CLINMESH_DATABASE_PATH,
    'Database path',
  )
  const database = openClinMeshDatabase({ busyTimeoutMs, databasePath })
  try {
    if (command === 'migrate') return applyMigrations(database)
    verifyMigrations(database)
    if (command === 'backup') {
      return await backupDatabase(
        database,
        requiredPath(options.get('--output'), 'Backup output path'),
      )
    }
    if (command === 'reindex') return rebuildDatabaseIndexes(database)
    return database.diagnostics()
  } finally {
    database.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runDatabaseCli(process.argv.slice(2), process.env)
    .then(result => console.info(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Database operation failed')
      process.exitCode = 1
    })
}
