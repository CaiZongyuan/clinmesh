import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  referenceArtifactSchema,
  referenceCodingIdentity,
  referenceDataReleaseListSchema,
  referenceDataReleaseSummarySchema,
  referenceImportDiagnosticsSchema,
  referenceImportManifestSchema,
  type ReferenceConcept,
  type ReferenceDataReleaseList,
  type ReferenceDataReleaseSummary,
  type ReferenceImportManifest,
  type ReferenceSourceManifest,
} from '@clinmesh/contracts/reference-data'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  parseLoincCsvReferenceArtifact,
  parseUcumXmlReferenceArtifact,
} from '../reference-data/reference-source-importers.ts'

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9-]+\.sql$/

export interface ReferenceMigrationResult {
  applied: string[]
  schemaVersion: number
}

export interface ReferenceDatabaseDiagnostics {
  integrity: string
  releaseCount: number
  schemaVersion: number
}

export interface ReferenceImportResult extends Omit<ReferenceDataReleaseSummary, 'sources' | 'status' | 'schemaVersion' | 'createdAt'> {
  created: boolean
}

export class ReferenceDatabase {
  readonly driver: Database.Database

  constructor(driver: Database.Database) {
    this.driver = driver
  }

  close(): void {
    this.driver.close()
  }
}

function defaultMigrationDirectory(): string {
  const packageDirectory = resolve(process.cwd(), 'reference-drizzle')
  if (existsSync(packageDirectory)) return packageDirectory
  return resolve(process.cwd(), 'apps/server/reference-drizzle')
}

function checksum(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]))
}

function contentHash(input: {
  concepts: Array<ReferenceConcept & { sourceId: string }>
  release: Pick<ReferenceImportManifest, 'createdAt' | 'releaseId' | 'schemaVersion'>
  sources: ReferenceSourceManifest[]
}): string {
  const hashSources = input.sources.map(({ artifactFormat, ...source }) => (
    artifactFormat === 'clinmesh-reference-v1'
      ? source
      : { ...source, artifactFormat }
  ))
  return checksum(JSON.stringify(canonicalize({
    concepts: input.concepts.toSorted((left, right) => (
      left.sourceId.localeCompare(right.sourceId) || left.id.localeCompare(right.id)
    )),
    createdAt: input.release.createdAt,
    releaseId: input.release.releaseId,
    schemaVersion: input.release.schemaVersion,
    sources: hashSources.toSorted((left, right) => left.sourceId.localeCompare(right.sourceId)),
  })))
}

export function openReferenceDatabase(options: {
  busyTimeoutMs: number
  databasePath: string
  readonly?: boolean
}): ReferenceDatabase {
  if (options.readonly !== true) mkdirSync(dirname(resolve(options.databasePath)), { recursive: true })
  const driver = new Database(options.databasePath, options.readonly === true
    ? { fileMustExist: true, readonly: true }
    : undefined)
  driver.pragma('foreign_keys = ON')
  driver.pragma(`busy_timeout = ${options.busyTimeoutMs}`)
  if (options.readonly !== true) driver.pragma('journal_mode = WAL')
  return new ReferenceDatabase(driver)
}

export function applyReferenceMigrations(
  database: ReferenceDatabase,
  migrationDirectory = defaultMigrationDirectory(),
): ReferenceMigrationResult {
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
  const lookup = database.driver.prepare('SELECT checksum FROM schema_migration WHERE migration_id = ?')
  const record = database.driver.prepare(
    'INSERT INTO schema_migration (migration_id, checksum, applied_at) VALUES (?, ?, ?)',
  )
  const applied: string[] = []
  for (const migrationFile of migrationFiles) {
    const sql = readFileSync(resolve(migrationDirectory, migrationFile), 'utf8')
    const migrationChecksum = checksum(sql)
    const existing = lookup.get(migrationFile) as { checksum: string } | undefined
    if (existing !== undefined) {
      if (existing.checksum !== migrationChecksum) {
        throw new Error(`Applied reference migration checksum changed: ${migrationFile}`)
      }
      continue
    }
    database.driver.exec('BEGIN IMMEDIATE')
    try {
      database.driver.exec(sql)
      record.run(migrationFile, migrationChecksum, new Date().toISOString())
      database.driver.exec('COMMIT')
      applied.push(migrationFile)
    } catch (error) {
      database.driver.exec('ROLLBACK')
      throw error
    }
  }
  return { applied, schemaVersion: migrationFiles.length }
}

export function verifyReferenceMigrations(
  database: ReferenceDatabase,
  migrationDirectory = defaultMigrationDirectory(),
): ReferenceMigrationResult {
  const migrationFiles = readdirSync(migrationDirectory)
    .filter(file => MIGRATION_FILE_PATTERN.test(file))
    .toSorted()
  const hasMigrationTable = database.driver.prepare(`
    SELECT 1 AS present FROM sqlite_schema
    WHERE type = 'table' AND name = 'schema_migration'
  `).get() !== undefined
  if (!hasMigrationTable) throw new Error(`Pending reference migrations: ${migrationFiles.join(', ')}`)
  const rows = database.driver.prepare(
    'SELECT migration_id, checksum FROM schema_migration ORDER BY migration_id',
  ).all() as Array<{ checksum: string; migration_id: string }>
  const expected = new Map(migrationFiles.map((file) => {
    const sql = readFileSync(resolve(migrationDirectory, file), 'utf8')
    return [file, checksum(sql)] as const
  }))
  for (const row of rows) {
    const expectedChecksum = expected.get(row.migration_id)
    if (expectedChecksum === undefined) {
      throw new Error(`Reference database migration is unknown: ${row.migration_id}`)
    }
    if (expectedChecksum !== row.checksum) {
      throw new Error(`Applied reference migration checksum changed: ${row.migration_id}`)
    }
  }
  const appliedIds = new Set(rows.map(row => row.migration_id))
  const pending = migrationFiles.filter(file => !appliedIds.has(file))
  if (pending.length > 0) throw new Error(`Pending reference migrations: ${pending.join(', ')}`)
  return { applied: [], schemaVersion: rows.length }
}

function sourceRows(database: ReferenceDatabase, releaseId: string): ReferenceSourceManifest[] {
  return z.array(z.object({
    acquisition_method: z.string(),
    artifact_format: z.string(),
    checksum: z.string(),
    license_id: z.string(),
    import_diagnostics_json: z.string(),
    published_at: z.string().nullable(),
    record_count: z.number().int(),
    retrieved_at: z.string(),
    source_id: z.string(),
    source_url: z.string(),
    upstream_version: z.string(),
  })).parse(database.driver.prepare(`
    SELECT source_id, upstream_version, published_at, retrieved_at, source_url,
      checksum, license_id, acquisition_method, artifact_format, record_count,
      import_diagnostics_json
    FROM reference_source_manifest
    WHERE release_id = ?
    ORDER BY source_id
  `).all(releaseId)).map(row => ({
    acquisitionMethod: row.acquisition_method,
    artifactFormat: row.artifact_format,
    checksum: row.checksum,
    licenseId: row.license_id,
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
    importDiagnostics: referenceImportDiagnosticsSchema.parse(JSON.parse(row.import_diagnostics_json)),
    recordCount: row.record_count,
    retrievedAt: row.retrieved_at,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    upstreamVersion: row.upstream_version,
  })) as ReferenceSourceManifest[]
}

function conceptRows(
  database: ReferenceDatabase,
  releaseId: string,
): Array<ReferenceConcept & { sourceId: string }> {
  return z.array(z.object({
    code: z.string(),
    concept_id: z.string(),
    display: z.string(),
    domain: z.string(),
    source_id: z.string(),
    source_locator: z.string(),
    status: z.string(),
    system: z.string(),
    system_version: z.string(),
  })).parse(database.driver.prepare(`
    SELECT concept_id, domain, system, system_version, code, display, status,
      source_id, source_locator
    FROM reference_concept
    WHERE release_id = ?
    ORDER BY source_id, concept_id
  `).all(releaseId)).map(row => ({
    ...referenceArtifactSchema.shape.concepts.element.parse({
      code: row.code,
      display: row.display,
      domain: row.domain,
      id: row.concept_id,
      sourceLocator: row.source_locator,
      status: row.status,
      system: row.system,
      version: row.system_version,
    }),
    sourceId: row.source_id,
  }))
}

function readReferenceDataReleases(database: ReferenceDatabase): ReferenceDataReleaseList {
  const rows = z.array(z.object({
    concept_count: z.number().int(),
    content_hash: z.string(),
    created_at: z.string(),
    release_id: z.string(),
    schema_version: z.string(),
    source_count: z.number().int(),
    status: z.string(),
  })).parse(database.driver.prepare(`
    SELECT release_id, schema_version, status, created_at, content_hash,
      source_count, concept_count
    FROM reference_release
    ORDER BY created_at DESC, release_id
  `).all())
  return referenceDataReleaseListSchema.parse({
    items: rows.map(row => ({
      conceptCount: row.concept_count,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      releaseId: row.release_id,
      schemaVersion: row.schema_version,
      sourceCount: row.source_count,
      sources: sourceRows(database, row.release_id),
      status: row.status,
    })),
  })
}

export function listReferenceDataReleases(database: ReferenceDatabase): ReferenceDataReleaseList {
  verifyReferenceMigrations(database)
  return readReferenceDataReleases(database)
}

export function importReferenceDataRelease(
  database: ReferenceDatabase,
  manifestPath: string,
): ReferenceImportResult {
  verifyReferenceMigrations(database)
  const manifest = referenceImportManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const manifestDirectory = dirname(resolve(manifestPath))
  const sources: ReferenceSourceManifest[] = []
  const concepts: Array<ReferenceConcept & { sourceId: string }> = []
  for (const source of manifest.sources) {
    const artifactPath = resolve(manifestDirectory, source.artifactPath)
    const artifactBytes = readFileSync(artifactPath)
    const actualChecksum = checksum(artifactBytes)
    if (actualChecksum !== source.checksum) {
      throw new Error(`Reference source checksum mismatch: ${source.sourceId}`)
    }
    const artifactContent = artifactBytes.toString('utf8')
    const artifact = source.artifactFormat === 'loinc-csv'
      ? parseLoincCsvReferenceArtifact({
          content: artifactContent,
          version: source.upstreamVersion,
        })
      : source.artifactFormat === 'ucum-xml'
        ? parseUcumXmlReferenceArtifact({
            content: artifactContent,
            version: source.upstreamVersion,
          })
        : referenceArtifactSchema.parse(JSON.parse(artifactContent))
    sources.push({
      acquisitionMethod: source.acquisitionMethod,
      artifactFormat: source.artifactFormat,
      checksum: actualChecksum,
      licenseId: source.licenseId,
      ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
      importDiagnostics: {
        acceptedCount: artifact.concepts.length,
        rejectedCount: 0,
        warnings: [],
      },
      recordCount: artifact.concepts.length,
      retrievedAt: source.retrievedAt,
      sourceId: source.sourceId,
      sourceUrl: source.sourceUrl,
      upstreamVersion: source.upstreamVersion,
    })
    concepts.push(...artifact.concepts.map(concept => ({ ...concept, sourceId: source.sourceId })))
  }
  const seenIds = new Set<string>()
  const seenCodes = new Set<string>()
  for (const concept of concepts) {
    if (seenIds.has(concept.id)) throw new Error(`Reference concept ID was repeated: ${concept.id}`)
    seenIds.add(concept.id)
    const codingKey = referenceCodingIdentity(concept)
    if (seenCodes.has(codingKey)) throw new Error(`Reference coding was repeated: ${concept.system}|${concept.version}|${concept.code}`)
    seenCodes.add(codingKey)
  }
  const hash = contentHash({ concepts, release: manifest, sources })
  const existing = database.driver.prepare(
    'SELECT content_hash FROM reference_release WHERE release_id = ?',
  ).get(manifest.releaseId) as { content_hash: string } | undefined
  if (existing !== undefined) {
    if (existing.content_hash !== hash) {
      throw new Error(`Reference Data Release is immutable: ${manifest.releaseId}`)
    }
    return {
      conceptCount: concepts.length,
      contentHash: hash,
      created: false,
      releaseId: manifest.releaseId,
      sourceCount: sources.length,
    }
  }

  database.driver.exec('BEGIN IMMEDIATE')
  try {
    database.driver.prepare(`
      INSERT INTO reference_release (
        release_id, schema_version, status, created_at, content_hash, source_count, concept_count
      ) VALUES (?, '1', 'published', ?, ?, ?, ?)
    `).run(manifest.releaseId, manifest.createdAt, hash, sources.length, concepts.length)
    const insertSource = database.driver.prepare(`
      INSERT INTO reference_source_manifest (
        release_id, source_id, upstream_version, published_at, retrieved_at,
        source_url, checksum, license_id, acquisition_method, artifact_format, record_count,
        import_diagnostics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const source of sources) {
      insertSource.run(
        manifest.releaseId,
        source.sourceId,
        source.upstreamVersion,
        source.publishedAt ?? null,
        source.retrievedAt,
        source.sourceUrl,
        source.checksum,
        source.licenseId,
        source.acquisitionMethod,
        source.artifactFormat,
        source.recordCount,
        JSON.stringify(source.importDiagnostics),
      )
    }
    const insertConcept = database.driver.prepare(`
      INSERT INTO reference_concept (
        release_id, concept_id, domain, system, system_version, code, display,
        status, source_id, source_locator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const concept of concepts) {
      insertConcept.run(
        manifest.releaseId,
        concept.id,
        concept.domain,
        concept.system,
        concept.version,
        concept.code,
        concept.display,
        concept.status,
        concept.sourceId,
        concept.sourceLocator,
      )
    }
    database.driver.exec('COMMIT')
  } catch (error) {
    if (database.driver.inTransaction) database.driver.exec('ROLLBACK')
    throw error
  }
  return {
    conceptCount: concepts.length,
    contentHash: hash,
    created: true,
    releaseId: manifest.releaseId,
    sourceCount: sources.length,
  }
}

export function verifyReferenceDatabase(database: ReferenceDatabase): ReferenceDatabaseDiagnostics {
  const migration = verifyReferenceMigrations(database)
  const integrity = String(database.driver.pragma('integrity_check', { simple: true }))
  if (integrity !== 'ok') throw new Error(`Reference database integrity check failed: ${integrity}`)
  const releases = readReferenceDataReleases(database)
  for (const release of releases.items) {
    referenceDataReleaseSummarySchema.parse(release)
    const concepts = conceptRows(database, release.releaseId)
    if (release.sourceCount !== release.sources.length) {
      throw new Error(`Reference Data Release source count mismatch: ${release.releaseId}`)
    }
    if (release.conceptCount !== concepts.length) {
      throw new Error(`Reference Data Release concept count mismatch: ${release.releaseId}`)
    }
    const conceptCountBySource = new Map<string, number>()
    for (const concept of concepts) {
      conceptCountBySource.set(concept.sourceId, (conceptCountBySource.get(concept.sourceId) ?? 0) + 1)
    }
    for (const source of release.sources) {
      if ((conceptCountBySource.get(source.sourceId) ?? 0) !== source.importDiagnostics.acceptedCount) {
        throw new Error(`Reference source accepted count mismatch: ${release.releaseId}/${source.sourceId}`)
      }
    }
    const actualHash = contentHash({ concepts, release, sources: release.sources })
    if (actualHash !== release.contentHash) {
      throw new Error(`Reference Data Release content hash mismatch: ${release.releaseId}`)
    }
  }
  return {
    integrity,
    releaseCount: releases.items.length,
    schemaVersion: migration.schemaVersion,
  }
}
