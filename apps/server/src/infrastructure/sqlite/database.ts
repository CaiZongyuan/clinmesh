import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  link,
  rm,
} from 'node:fs/promises'
import Database from 'better-sqlite3'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { matchesMigrationChecksum, migrationChecksum } from './migration-checksum.ts'
import { initializeRegistrationNumbering } from './registration-number-migration.ts'
import { readRegistrationNumberState, registrationCountersHash } from './registration-numbering.ts'
import {
  matchesEarlyIncrementalRecordingMigration,
  prepareIncrementalRecordingContextMigration,
} from './incremental-recording-migration.ts'
import {
  instrumentSqliteDriver,
  type SqlitePerformanceObserver,
} from './performance-observer.ts'

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9-]+\.sql$/

export interface OpenDatabaseOptions {
  databasePath: string
  busyTimeoutMs: number
  performanceObserver?: SqlitePerformanceObserver
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
  authorityDatabasePath?: string
  backupPath: string
  busyTimeoutMs: number
  destinationPath: string
  expectedSchemaVersion: number
}

export class RegistrationNumberRecoveryError extends Error {
  readonly code = 'REGISTRATION_NUMBER_RECOVERY_UNVERIFIED'

  constructor(message: string) {
    super(`REGISTRATION_NUMBER_RECOVERY_UNVERIFIED: ${message}`)
    this.name = 'RegistrationNumberRecoveryError'
  }
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
  // 先按本模块自身位置解析，调用方在任何 cwd（如 turbo 从 apps/dsh-web 跑测试）都能找到迁移目录。
  const moduleDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle')
  if (existsSync(moduleDirectory)) return moduleDirectory
  const packageDirectory = resolve(process.cwd(), 'drizzle')
  if (existsSync(packageDirectory)) return packageDirectory
  return resolve(process.cwd(), 'apps/server/drizzle')
}

export function expectedSchemaVersion(
  migrationDirectory = defaultMigrationDirectory(),
): number {
  return readdirSync(migrationDirectory).filter(file => MIGRATION_FILE_PATTERN.test(file)).length
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

function omitDialogueWording(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitDialogueWording)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'messageText')
    .map(([key, entry]) => [key, omitDialogueWording(entry)]))
}

function canonicalDomainRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).flatMap(([column, value]) => {
    if (column === 'canonical_state_hash') return []
    if (table === 'consultation_turn' && column === 'message_text') return []
    if (typeof value !== 'string' || !column.endsWith('_json')) return [[column, value]]
    const parsed: unknown = JSON.parse(value)
    return [[column, table === 'command_receipt' && typeof row.operation === 'string'
      && row.operation.startsWith('consultation.') ? omitDialogueWording(parsed) : parsed]]
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
    return [table, rows.map(row => canonicalDomainRow(table, row))]
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
  try {
    driver.pragma('foreign_keys = ON')
    driver.pragma('journal_mode = WAL')
    driver.pragma(`busy_timeout = ${options.busyTimeoutMs}`)
    return new ClinMeshDatabase(options.performanceObserver === undefined
      ? driver
      : instrumentSqliteDriver(driver, options.performanceObserver))
  } catch (error) {
    driver.close()
    throw error
  }
}

export function applyMigrations(
  database: ClinMeshDatabase,
  migrationDirectory = defaultMigrationDirectory(),
): MigrationResult {
  if (database.driver.inTransaction) throw new Error('Migrations require a connection without an active transaction')
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
      if (!matchesMigrationChecksum(sql, existing.checksum)
        && !matchesEarlyIncrementalRecordingMigration(migrationFile, sql, existing.checksum)) {
        throw new Error(`Applied migration checksum changed: ${migrationFile}`)
      }
      continue
    }

    const rebuildReferences = ['0069_inpatient-admission.sql', '0071_inpatient-investigations-transfer.sql', '0082_practitioner-role-medical-insurance.sql', '0092_outpatient-investigation-billing.sql'].includes(migrationFile)
    if (rebuildReferences) database.driver.pragma('foreign_keys = OFF')
    try {
      database.driver.exec('BEGIN IMMEDIATE')
      prepareIncrementalRecordingContextMigration(database.driver, migrationFile)
      database.driver.exec(sql)
      if (rebuildReferences && (database.driver.pragma('foreign_key_check') as unknown[]).length > 0) {
        throw new Error('Migration violated foreign keys')
      }
      if (migrationFile === '0069_registration-numbering.sql') initializeRegistrationNumbering(database)
      record.run(migrationFile, checksum, new Date().toISOString())
      database.driver.exec('COMMIT')
      applied.push(migrationFile)
    } catch (error) {
      if (database.driver.inTransaction) database.driver.exec('ROLLBACK')
      throw error
    } finally {
      if (rebuildReferences) database.driver.pragma('foreign_keys = ON')
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
  options: { allowRetiredRegistrationAuthority?: boolean } = {},
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
    return [migrationFile, sql] as const
  }))
  for (const row of rows) {
    const sql = expected.get(row.migration_id)
    if (sql === undefined) {
      throw new Error(`Database migration is unknown to this release: ${row.migration_id}`)
    }
    if (!matchesMigrationChecksum(sql, row.checksum)
      && !matchesEarlyIncrementalRecordingMigration(row.migration_id, sql, row.checksum)) {
      throw new Error(`Applied migration checksum changed: ${row.migration_id}`)
    }
  }
  const appliedIds = new Set(rows.map(row => row.migration_id))
  const pending = migrationFiles.filter(migrationFile => !appliedIds.has(migrationFile))
  if (pending.length > 0) {
    throw new Error(`Pending database migrations: ${pending.join(', ')}`)
  }
  if (rows.some(row => row.migration_id === '0069_registration-numbering.sql')) {
    readRegistrationNumberState(database, options.allowRetiredRegistrationAuthority === true ? { allowRetired: true } : {})
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
  if (database.driver.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'registration_number_authority'").get() !== undefined) {
    readRegistrationNumberState(database, { allowRetired: true })
  }
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
  if (options.authorityDatabasePath === undefined || !existsSync(options.authorityDatabasePath)) {
    throw new RegistrationNumberRecoveryError('A trusted current issuance authority database is required')
  }
  if (resolve(options.authorityDatabasePath) === resolve(options.backupPath)) {
    throw new RegistrationNumberRecoveryError('The backup and current issuance authority must be separate files')
  }
  if (!existsSync(options.backupPath)) throw new Error(`Backup does not exist: ${options.backupPath}`)
  if (existsSync(options.destinationPath)) {
    throw new Error(`Restore destination already exists: ${options.destinationPath}`)
  }
  mkdirSync(dirname(resolve(options.destinationPath)), { recursive: true })
  const candidatePath = `${options.destinationPath}.restore-${randomUUID()}`
  let candidate: ClinMeshDatabase | undefined
  let source: ClinMeshDatabase | undefined
  let authority: ClinMeshDatabase | undefined
  let retired = false
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
    verifyMigrations(source, undefined, { allowRetiredRegistrationAuthority: true })
    await source.driver.backup(candidatePath)
    source.close()
    source = undefined
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
    verifyMigrations(candidate, undefined, { allowRetiredRegistrationAuthority: true })
    if (verification.canonicalStateHash !== sourceVerification.canonicalStateHash) {
      throw new Error('Restore candidate does not match the backup source')
    }
    // Prepare and verify the candidate before taking the current writer offline.
    // The committed retirement is deliberately never undone on later failure:
    // a second restore must not activate another candidate from the same source.
    authority = openClinMeshDatabase({ databasePath: options.authorityDatabasePath, busyTimeoutMs: options.busyTimeoutMs })
    authority.driver.exec('BEGIN IMMEDIATE')
    verifyMigrations(authority)
    if (authority.diagnostics().integrity !== 'ok') {
      throw new RegistrationNumberRecoveryError('The current issuance authority failed integrity verification')
    }
    const currentState = readRegistrationNumberState(authority)
    const backupState = readRegistrationNumberState(candidate, { allowRetired: true })
    if (currentState.authorityId !== backupState.authorityId) {
      throw new RegistrationNumberRecoveryError('The backup does not belong to the trusted issuance authority')
    }
    const counters = new Map(backupState.counters.map(counter => [counter.visitDate, counter.highWater]))
    for (const counter of currentState.counters) {
      counters.set(counter.visitDate, Math.max(counter.highWater, counters.get(counter.visitDate) ?? 0))
    }
    authority.driver.prepare("UPDATE registration_number_authority SET status = 'retired' WHERE singleton = 1").run()
    authority.driver.exec('COMMIT')
    retired = true
    authority.close()
    authority = undefined

    candidate.driver.exec('BEGIN IMMEDIATE')
    const merged = [...counters].map(([visitDate, highWater]) => ({ visitDate, highWater }))
    const save = candidate.driver.prepare(`
      INSERT INTO registration_number_counter (visit_date, high_water) VALUES (?, ?)
      ON CONFLICT (visit_date) DO UPDATE SET high_water = excluded.high_water
    `)
    for (const counter of merged) save.run(counter.visitDate, counter.highWater)
    candidate.driver.prepare("UPDATE registration_number_authority SET status = 'active', counters_hash = ? WHERE singleton = 1")
      .run(registrationCountersHash(merged))
    candidate.driver.exec('COMMIT')
    const restoredVerification = verifySnapshot(candidate)
    candidate.close()
    candidate = undefined
    // An exclusive hard link publishes on the same filesystem without the
    // overwrite race of rename when another file appears after the first check.
    await link(candidatePath, options.destinationPath)
    await removeDatabaseArtifacts(candidatePath)
    return restoredVerification
  } catch (error) {
    if (authority?.driver.inTransaction) authority.driver.exec('ROLLBACK')
    authority?.close()
    candidate?.close()
    source?.close()
    await removeDatabaseArtifacts(candidatePath)
    if (retired) {
      throw new RegistrationNumberRecoveryError('The previous writer remains retired after restore failed; preserve its database and do not restart an old snapshot')
    }
    throw error
  }
}
