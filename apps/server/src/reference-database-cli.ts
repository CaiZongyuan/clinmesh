import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { offlineReferenceInventoryQuerySchema } from '@clinmesh/contracts/reference-data'
import { auditOfflineInventory, listOfflineInventories, listOfflineInventoryAudit, prepareOfflineInventory } from './infrastructure/reference-data/offline-reference-inventory.ts'
import {
  applyReferenceMigrations,
  importReferenceDataRelease,
  listReferenceDataReleases,
  openReferenceDatabase,
  verifyReferenceDatabase,
} from './infrastructure/sqlite/reference-database.ts'

const commandSchema = z.enum(['import', 'list', 'migrate', 'verify', 'prepare-inventory', 'list-inventories', 'inventory-audit'])
const optionNames = new Set(['--busy-timeout-ms', '--database', '--manifest', '--input-root', '--page', '--page-size'])

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
    if (command === 'prepare-inventory') return await prepareOfflineInventory(database,
      requiredPath(options.get('--manifest'), 'Offline inventory manifest path'),
      requiredPath(options.get('--input-root'), 'Offline inventory input root'))
    if (command === 'list-inventories') {
      try {
        const query = offlineReferenceInventoryQuerySchema.parse({ page: options.get('--page'), pageSize: options.get('--page-size') })
        const result = listOfflineInventories(database, query)
        auditOfflineInventory(database, { operation: 'list', outcome: 'success' })
        return result
      } catch (error) {
        auditOfflineInventory(database, { operation: 'list', outcome: 'failure' })
        throw error
      }
    }
    if (command === 'inventory-audit') return listOfflineInventoryAudit(database)
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
if (entrypoint !== undefined && /^reference-database-cli\.(ts|js)$/.test(basename(entrypoint))
  && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runReferenceDatabaseCli(process.argv.slice(2))
    .then(result => console.info(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Reference database operation failed')
      process.exitCode = 1
    })
}
