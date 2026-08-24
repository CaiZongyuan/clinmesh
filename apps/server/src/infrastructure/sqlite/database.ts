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
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'

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
    resource: canonicalize(fhirResourceSchema.parse(JSON.parse(row.content_json))),
    resourceId: row.resource_id,
    resourceType: row.resource_type,
    versionId: row.version_id,
    workspaceId: row.workspace_id,
  }))
}

const NON_AUTHORITATIVE_STATE_TABLES = new Set([
  'fhir_history',
  'fhir_resource',
  'fhir_sp_string',
  'runtime_metadata',
  'schema_migration',
])

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function canonicalDomainRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).flatMap(([column, value]) => {
    if (column === 'canonical_state_hash') return []
    if (typeof value !== 'string' || !column.endsWith('_json')) return [[column, value]]
    return [[column, JSON.parse(value) as unknown]]
  }))
}

function canonicalDomainTables(database: ClinMeshDatabase): Record<string, unknown[]> {
  const tables = (database.driver.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(row => row.name)
    .filter(table => !NON_AUTHORITATIVE_STATE_TABLES.has(table))

  return Object.fromEntries(tables.map((table) => {
    const columns = database.driver.prepare(
      `PRAGMA table_info(${quotedIdentifier(table)})`,
    ).all() as Array<{ name: string; pk: number }>
    const primaryKey = columns.filter(column => column.pk > 0).toSorted((left, right) => left.pk - right.pk)
    const orderBy = (primaryKey.length > 0 ? primaryKey : columns)
      .map(column => quotedIdentifier(column.name))
      .join(', ')
    const rows = database.driver.prepare(
      `SELECT * FROM ${quotedIdentifier(table)} ORDER BY ${orderBy}`,
    ).all() as Array<Record<string, unknown>>
    return [table, rows.map(canonicalDomainRow)]
  }))
}

async function removeDatabaseArtifacts(databasePath: string): Promise<void> {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
  ])
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
  const canonical = canonicalize({
    domainTables: canonicalDomainTables(database),
    fhirCurrent: canonicalFhirRows(database, 'fhir_resource'),
    fhirHistory: canonicalFhirRows(database, 'fhir_history'),
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
  const sourceVerification = verifySnapshot(database)
  if (sourceVerification.integrity !== 'ok') {
    throw new Error(`Backup source failed integrity check: ${sourceVerification.integrity}`)
  }
  let verificationDatabase: ClinMeshDatabase | undefined
  try {
    await database.driver.backup(backupPath)
    verificationDatabase = openClinMeshDatabase({
      busyTimeoutMs: database.diagnostics().busyTimeoutMs,
      databasePath: backupPath,
    })
    const candidateVerification = verifySnapshot(verificationDatabase)
    if (candidateVerification.integrity !== 'ok') {
      throw new Error(`Backup candidate failed integrity check: ${candidateVerification.integrity}`)
    }
    if (
      candidateVerification.schemaVersion !== sourceVerification.schemaVersion
      || candidateVerification.canonicalStateHash !== sourceVerification.canonicalStateHash
    ) {
      throw new Error('Backup candidate does not match the source database')
    }
    return candidateVerification
  } catch (error) {
    verificationDatabase?.close()
    verificationDatabase = undefined
    await removeDatabaseArtifacts(backupPath)
    throw error
  } finally {
    verificationDatabase?.close()
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
  let source: ClinMeshDatabase | undefined
  try {
    source = openClinMeshDatabase({
      busyTimeoutMs: options.busyTimeoutMs,
      databasePath: options.backupPath,
    })
    const sourceVerification = verifySnapshot(source)
    if (sourceVerification.integrity !== 'ok') {
      throw new Error(`Restore source failed integrity check: ${sourceVerification.integrity}`)
    }
    if (sourceVerification.schemaVersion !== options.expectedSchemaVersion) {
      throw new Error(
        `Restore source schema version ${sourceVerification.schemaVersion} does not match ${options.expectedSchemaVersion}`,
      )
    }
    verifyMigrations(source)
    source.close()
    source = undefined
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
    if (verification.canonicalStateHash !== sourceVerification.canonicalStateHash) {
      throw new Error('Restore candidate does not match the backup source')
    }
    candidate.close()
    candidate = undefined
    await rename(candidatePath, options.destinationPath)
    return verification
  } catch (error) {
    candidate?.close()
    source?.close()
    await removeDatabaseArtifacts(candidatePath)
    throw error
  }
}
