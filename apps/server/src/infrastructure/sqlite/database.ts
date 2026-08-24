import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  copyFile,
  rename,
  rm,
} from 'node:fs/promises'
import Database from 'better-sqlite3'

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9-]+\.sql$/

export interface OpenDatabaseOptions {
  databasePath: string
  busyTimeoutMs: number
}

export interface DatabaseDiagnostics {
  busyTimeoutMs: number
  foreignKeys: boolean
  integrity: string
  journalMode: string
  schemaVersion: number
}

export interface MigrationResult {
  applied: string[]
  schemaVersion: number
}

export interface IndexRebuildResult {
  indexes: string[]
  integrity: string
}

export interface DatabaseSnapshotVerification {
  canonicalStateHash: string
  integrity: string
  schemaVersion: number
}

export interface RestoreDatabaseOptions {
  backupPath: string
  busyTimeoutMs: number
  destinationPath: string
  expectedSchemaVersion: number
}

export class ClinMeshDatabase {
  readonly driver: Database.Database

  constructor(driver: Database.Database) {
    this.driver = driver
  }

  close(): void {
    this.driver.close()
  }

  diagnostics(): DatabaseDiagnostics {
    const hasMigrationTable = this.driver.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'schema_migration'
    `).get() !== undefined
    const schemaVersion = hasMigrationTable
      ? (this.driver.prepare(
          'SELECT COUNT(*) AS count FROM schema_migration',
        ).get() as { count: number }).count
      : 0

    return {
      busyTimeoutMs: Number(this.driver.pragma('busy_timeout', { simple: true })),
      foreignKeys: this.driver.pragma('foreign_keys', { simple: true }) === 1,
      integrity: String(this.driver.pragma('integrity_check', { simple: true })),
      journalMode: String(this.driver.pragma('journal_mode', { simple: true })).toLowerCase(),
      schemaVersion,
    }
  }
}

function defaultMigrationDirectory(): string {
  const packageDirectory = resolve(process.cwd(), 'drizzle')
  if (existsSync(packageDirectory)) return packageDirectory
  return resolve(process.cwd(), 'apps/server/drizzle')
}

export function expectedSchemaVersion(
  migrationDirectory = defaultMigrationDirectory(),
): number {
  return readdirSync(migrationDirectory).filter(file => MIGRATION_FILE_PATTERN.test(file)).length
}

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'lastUpdated')
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

function canonicalFhirRows(database: ClinMeshDatabase, table: 'fhir_history' | 'fhir_resource') {
  const rows = database.driver.prepare(`
    SELECT workspace_id, epoch, resource_type, resource_id, version_id,
      owner_kind, deleted, content_json
    FROM ${table}
    ORDER BY workspace_id, epoch, resource_type, resource_id, version_id
  `).all() as Array<{
    content_json: string
    deleted: number
    epoch: string
    owner_kind: string
    resource_id: string
    resource_type: string
    version_id: number
    workspace_id: string
  }>
  return rows.map(row => ({
    deleted: row.deleted,
    epoch: row.epoch,
    ownerKind: row.owner_kind,
    resource: canonicalize(JSON.parse(row.content_json)),
    resourceId: row.resource_id,
    resourceType: row.resource_type,
    versionId: row.version_id,
    workspaceId: row.workspace_id,
  }))
}

export function openClinMeshDatabase(options: OpenDatabaseOptions): ClinMeshDatabase {
  mkdirSync(dirname(resolve(options.databasePath)), { recursive: true })
  const driver = new Database(options.databasePath)
  driver.pragma('foreign_keys = ON')
  driver.pragma('journal_mode = WAL')
  driver.pragma(`busy_timeout = ${options.busyTimeoutMs}`)
  return new ClinMeshDatabase(driver)
}

export function applyMigrations(
  database: ClinMeshDatabase,
  migrationDirectory = defaultMigrationDirectory(),
): MigrationResult {
  database.driver.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      migration_id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `)
  const migrationFiles = readdirSync(migrationDirectory)
    .filter(file => MIGRATION_FILE_PATTERN.test(file))
    .toSorted()
  const applied: string[] = []
  const lookup = database.driver.prepare(
    'SELECT checksum FROM schema_migration WHERE migration_id = ?',
  )
  const record = database.driver.prepare(
    'INSERT INTO schema_migration (migration_id, checksum, applied_at) VALUES (?, ?, ?)',
  )

  for (const migrationFile of migrationFiles) {
    const sql = readFileSync(resolve(migrationDirectory, migrationFile), 'utf8')
    const checksum = migrationChecksum(sql)
    const existing = lookup.get(migrationFile) as { checksum: string } | undefined

    if (existing !== undefined) {
      if (existing.checksum !== checksum) {
        throw new Error(`Applied migration checksum changed: ${migrationFile}`)
      }
      continue
    }

    database.driver.exec('BEGIN IMMEDIATE')
    try {
      database.driver.exec(sql)
      record.run(migrationFile, checksum, new Date().toISOString())
      database.driver.exec('COMMIT')
      applied.push(migrationFile)
    } catch (error) {
      database.driver.exec('ROLLBACK')
      throw error
    }
  }

  return {
    applied,
    schemaVersion: database.diagnostics().schemaVersion,
  }
}

export function verifyMigrations(
  database: ClinMeshDatabase,
  migrationDirectory = defaultMigrationDirectory(),
): MigrationResult {
  const migrationFiles = readdirSync(migrationDirectory)
    .filter(file => MIGRATION_FILE_PATTERN.test(file))
    .toSorted()
  const hasMigrationTable = database.driver.prepare(`
    SELECT 1 AS present FROM sqlite_schema
    WHERE type = 'table' AND name = 'schema_migration'
  `).get() !== undefined
  if (!hasMigrationTable) {
    throw new Error(`Pending database migrations: ${migrationFiles.join(', ')}`)
  }
  const rows = database.driver.prepare(`
    SELECT migration_id, checksum FROM schema_migration ORDER BY migration_id
  `).all() as Array<{ checksum: string; migration_id: string }>
  const expected = new Map(migrationFiles.map((migrationFile) => {
    const sql = readFileSync(resolve(migrationDirectory, migrationFile), 'utf8')
    return [migrationFile, migrationChecksum(sql)] as const
  }))
  for (const row of rows) {
    const checksum = expected.get(row.migration_id)
    if (checksum === undefined) {
      throw new Error(`Database migration is unknown to this release: ${row.migration_id}`)
    }
    if (checksum !== row.checksum) {
      throw new Error(`Applied migration checksum changed: ${row.migration_id}`)
    }
  }
  const appliedIds = new Set(rows.map(row => row.migration_id))
  const pending = migrationFiles.filter(migrationFile => !appliedIds.has(migrationFile))
  if (pending.length > 0) {
    throw new Error(`Pending database migrations: ${pending.join(', ')}`)
  }
  return { applied: [], schemaVersion: rows.length }
}

export function rebuildDatabaseIndexes(database: ClinMeshDatabase): IndexRebuildResult {
  const indexes = (database.driver.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'index' AND sql IS NOT NULL
    ORDER BY name
  `).all() as Array<{ name: string }>).map(row => row.name)
  database.driver.exec('BEGIN IMMEDIATE')
  try {
    for (const index of indexes) {
      database.driver.exec(`REINDEX "${index.replaceAll('"', '""')}"`)
    }
    database.driver.exec('COMMIT')
  } catch (error) {
    if (database.driver.inTransaction) database.driver.exec('ROLLBACK')
    throw error
  }
  const integrity = String(database.driver.pragma('integrity_check', { simple: true }))
  if (integrity !== 'ok') throw new Error(`Index rebuild failed integrity check: ${integrity}`)
  return { indexes, integrity }
}

export function canonicalStateHash(database: ClinMeshDatabase): string {
  const workspaces = database.driver.prepare(`
    SELECT workspace_id, name, active_epoch, policy_version
    FROM workspace
    ORDER BY workspace_id
  `).all()
  const epochs = database.driver.prepare(`
    SELECT workspace_id, epoch, state, scenario_id, canonical_state_hash
    FROM workspace_epoch
    ORDER BY workspace_id, epoch
  `).all()
  const scenarioRuns = database.driver.prepare(`
    SELECT workspace_id, epoch, scenario_run_id, scenario_id, status
    FROM scenario_run
    ORDER BY workspace_id, epoch, scenario_run_id
  `).all()
  const canonical = canonicalize({
    epochs,
    fhirCurrent: canonicalFhirRows(database, 'fhir_resource'),
    fhirHistory: canonicalFhirRows(database, 'fhir_history'),
    scenarioRuns,
    workspaces,
  })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function verifySnapshot(database: ClinMeshDatabase): DatabaseSnapshotVerification {
  const diagnostics = database.diagnostics()
  return {
    canonicalStateHash: canonicalStateHash(database),
    integrity: diagnostics.integrity,
    schemaVersion: diagnostics.schemaVersion,
  }
}

export async function backupDatabase(
  database: ClinMeshDatabase,
  backupPath: string,
): Promise<DatabaseSnapshotVerification> {
  if (existsSync(backupPath)) throw new Error(`Backup destination already exists: ${backupPath}`)
  mkdirSync(dirname(resolve(backupPath)), { recursive: true })
  await database.driver.backup(backupPath)
  const verificationDatabase = openClinMeshDatabase({
    busyTimeoutMs: database.diagnostics().busyTimeoutMs,
    databasePath: backupPath,
  })
  try {
    return verifySnapshot(verificationDatabase)
  } finally {
    verificationDatabase.close()
  }
}

export async function restoreDatabase(
  options: RestoreDatabaseOptions,
): Promise<DatabaseSnapshotVerification> {
  if (!existsSync(options.backupPath)) throw new Error(`Backup does not exist: ${options.backupPath}`)
  if (existsSync(options.destinationPath)) {
    throw new Error(`Restore destination already exists: ${options.destinationPath}`)
  }
  mkdirSync(dirname(resolve(options.destinationPath)), { recursive: true })
  const candidatePath = `${options.destinationPath}.restore-${randomUUID()}`
  let candidate: ClinMeshDatabase | undefined
  try {
    await copyFile(options.backupPath, candidatePath)
    candidate = openClinMeshDatabase({
      busyTimeoutMs: options.busyTimeoutMs,
      databasePath: candidatePath,
    })
    const verification = verifySnapshot(candidate)
    if (verification.integrity !== 'ok') {
      throw new Error(`Restore candidate failed integrity check: ${verification.integrity}`)
    }
    if (verification.schemaVersion !== options.expectedSchemaVersion) {
      throw new Error(
        `Restore candidate schema version ${verification.schemaVersion} does not match ${options.expectedSchemaVersion}`,
      )
    }
    verifyMigrations(candidate)
    candidate.close()
    candidate = undefined
    await rename(candidatePath, options.destinationPath)
    return verification
  } catch (error) {
    candidate?.close()
    await Promise.all([
      rm(candidatePath, { force: true }),
      rm(`${candidatePath}-shm`, { force: true }),
      rm(`${candidatePath}-wal`, { force: true }),
    ])
    throw error
  }
}
