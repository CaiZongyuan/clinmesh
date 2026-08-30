import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  applyReferenceMigrations,
  importReferenceDataRelease,
  listReferenceDataReleases,
  openReferenceDatabase,
  verifyReferenceDatabase,
} from './infrastructure/sqlite/reference-database.ts'

const commandSchema = z.enum(['import', 'list', 'migrate', 'verify'])
const optionNames = new Set(['--busy-timeout-ms', '--database', '--manifest'])

function parseOptions(arguments_: string[]): Map<string, string> {
  const options = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (name === undefined || !optionNames.has(name) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid reference database CLI option near: ${name ?? '<end>'}`)
    }
    if (options.has(name)) throw new Error(`Reference database CLI option was repeated: ${name}`)
    options.set(name, value)
  }
  return options
}

function requiredPath(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`${label} is required`)
  return resolve(value)
}

export async function runReferenceDatabaseCli(arguments_: string[]): Promise<unknown> {
  const [commandValue, ...optionArguments] = arguments_
  const command = commandSchema.parse(commandValue)
  const options = parseOptions(optionArguments)
  const databasePath = requiredPath(options.get('--database'), 'Reference database path')
  const busyTimeoutMs = z.coerce.number().int().min(1).max(60_000).parse(
    options.get('--busy-timeout-ms') ?? '5000',
  )
  const database = openReferenceDatabase({ busyTimeoutMs, databasePath })
  try {
    if (command === 'migrate') return applyReferenceMigrations(database)
    if (command === 'import') {
      return importReferenceDataRelease(
        database,
        requiredPath(options.get('--manifest'), 'Reference release manifest path'),
      )
    }
    if (command === 'list') return listReferenceDataReleases(database)
    return verifyReferenceDatabase(database)
  } finally {
    database.close()
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runReferenceDatabaseCli(process.argv.slice(2))
    .then(result => console.info(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Reference database operation failed')
      process.exitCode = 1
    })
}
