import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  referenceConceptSchema,
  referenceDataReleaseListSchema,
  referenceDataReleaseSummarySchema,
  referenceImportDiagnosticsSchema,
  referenceImportManifestSchema,
  referenceLaboratoryDefinitionSchema,
  referenceLaboratoryPanelMemberSchema,
  referenceLaboratorySpecimenSchema,
  referenceLaboratoryUnitSchema,
  referenceMedicalServiceSchema,
  referenceMedicationProductSchema,
  referenceSourceManifestSchema,
  referenceValueSetEntrySchema,
  type ReferenceConcept,
  type ReferenceDataReleaseList,
  type ReferenceDataReleaseSummary,
  type ReferenceLaboratoryDefinition,
  type ReferenceLaboratoryPanelMember,
  type ReferenceLaboratoryRecord,
  type ReferenceLaboratorySpecimen,
  type ReferenceLaboratorySourceDataset,
  type ReferenceLaboratoryUnit,
  type ReferenceMedicalService,
  type ReferenceMedicationProduct,
  type ReferenceSourceManifest,
  type ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  computeStreamingReleaseContentHash,
} from '../reference-data/canonical-json-hasher.ts'
import { matchesMigrationChecksum, migrationChecksum } from './migration-checksum.ts'
import {
  stageTextReferenceSourceArtifact,
  type ReferenceStagingSink,
} from '../reference-data/reference-source-importers.ts'
import { verifyOfflineInventories } from '../reference-data/offline-reference-inventory.ts'
import {
  stageCnHealthCandidateReferenceArtifact,
  streamFileSha256AndSize,
} from '../reference-data/cn-health-candidate-importer.ts'
import {
  instrumentSqliteDriver,
  type SqlitePerformanceObserver,
} from './performance-observer.ts'

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

export interface ReferenceCatalogSearchInput {
  page: number
  pageSize: number
  query?: string
}

export interface ReferenceLaboratoryCandidateSearchInput extends ReferenceCatalogSearchInput {
  panelOnly?: boolean
  sourceDataset?: ReferenceLaboratorySourceDataset
}

export interface ReferenceCatalogSearchResult<Item> {
  items: Item[]
  total: number
}

type SourcedLaboratoryDefinition = ReferenceLaboratoryDefinition & { sourceId: string }
type SourcedLaboratoryPanelMember = ReferenceLaboratoryPanelMember & { sourceId: string }
type SourcedLaboratorySpecimen = ReferenceLaboratorySpecimen & { sourceId: string }
type SourcedLaboratoryUnit = ReferenceLaboratoryUnit & { sourceId: string }

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

export function openReferenceDatabase(options: {
  busyTimeoutMs: number
  databasePath: string
  performanceObserver?: SqlitePerformanceObserver
  readonly?: boolean
}): ReferenceDatabase {
  if (options.readonly !== true) mkdirSync(dirname(resolve(options.databasePath)), { recursive: true })
  const driver = new Database(options.databasePath, options.readonly === true
    ? { fileMustExist: true, readonly: true }
    : undefined)
  driver.pragma('foreign_keys = ON')
  driver.pragma(`busy_timeout = ${options.busyTimeoutMs}`)
  if (options.readonly !== true) driver.pragma('journal_mode = WAL')
  return new ReferenceDatabase(options.performanceObserver === undefined
    ? driver
    : instrumentSqliteDriver(driver, options.performanceObserver))
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
    const sqlChecksum = migrationChecksum(sql)
    const existing = lookup.get(migrationFile) as { checksum: string } | undefined
    if (existing !== undefined) {
      if (!matchesMigrationChecksum(sql, existing.checksum)) {
        throw new Error(`Applied reference migration checksum changed: ${migrationFile}`)
      }
      continue
    }
    database.driver.exec('BEGIN IMMEDIATE')
    try {
      database.driver.exec(sql)
      record.run(migrationFile, sqlChecksum, new Date().toISOString())
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
    return [file, sql] as const
  }))
  for (const row of rows) {
    const sql = expected.get(row.migration_id)
    if (sql === undefined) {
      throw new Error(`Reference database migration is unknown: ${row.migration_id}`)
    }
    if (!matchesMigrationChecksum(sql, row.checksum)) {
      throw new Error(`Applied reference migration checksum changed: ${row.migration_id}`)
    }
  }
  const appliedIds = new Set(rows.map(row => row.migration_id))
  const pending = migrationFiles.filter(file => !appliedIds.has(file))
  if (pending.length > 0) throw new Error(`Pending reference migrations: ${pending.join(', ')}`)
  return { applied: [], schemaVersion: rows.length }
}

const sourceManifestDatabaseRowSchema = z.object({
  acquisition_method: z.string(),
  artifact_format: z.string(),
  candidate_provenance_json: z.string().nullable(),
  checksum: z.string(),
  import_diagnostics_json: z.string(),
  license_id: z.string(),
  materialization_json: z.string().nullable(),
  published_at: z.string().nullable(),
  record_count: z.number().int(),
  retrieved_at: z.string(),
  source_id: z.string(),
  source_url: z.string(),
  upstream_version: z.string(),
})

function mapSourceManifestRow(
  row: z.infer<typeof sourceManifestDatabaseRowSchema>,
): ReferenceSourceManifest {
  return referenceSourceManifestSchema.parse({
    acquisitionMethod: row.acquisition_method,
    artifactFormat: row.artifact_format,
    ...(row.candidate_provenance_json === null
      ? {}
      : { candidate: JSON.parse(row.candidate_provenance_json) }),
    checksum: row.checksum,
    importDiagnostics: referenceImportDiagnosticsSchema.parse(JSON.parse(row.import_diagnostics_json)),
    licenseId: row.license_id,
    ...(row.materialization_json === null
      ? {}
      : { materialization: JSON.parse(row.materialization_json) }),
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
    recordCount: row.record_count,
    retrievedAt: row.retrieved_at,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    upstreamVersion: row.upstream_version,
  })
}

function sourceRows(database: ReferenceDatabase, releaseId: string): ReferenceSourceManifest[] {
  return z.array(sourceManifestDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT source_id, upstream_version, published_at, retrieved_at, source_url,
      checksum, license_id, acquisition_method, artifact_format, record_count,
      import_diagnostics_json, candidate_provenance_json, materialization_json
    FROM reference_source_manifest
    WHERE release_id = ?
    ORDER BY source_id
  `).all(releaseId)).map(mapSourceManifestRow)
}

const conceptDatabaseRowSchema = z.object({
  code: z.string(),
  concept_id: z.string(),
  display: z.string(),
  domain: z.string(),
  laboratory_metadata_json: z.string().nullable(),
  source_id: z.string(),
  source_locator: z.string(),
  status: z.string(),
  system: z.string(),
  system_version: z.string(),
})

function mapConceptRow(
  row: z.infer<typeof conceptDatabaseRowSchema>,
): ReferenceConcept & { sourceId: string } {
  return {
    ...referenceConceptSchema.parse({
      code: row.code,
      display: row.display,
      domain: row.domain,
      id: row.concept_id,
      ...(row.laboratory_metadata_json === null
        ? {}
        : { laboratory: JSON.parse(row.laboratory_metadata_json) }),
      sourceLocator: row.source_locator,
      status: row.status,
      system: row.system,
      version: row.system_version,
    }),
    sourceId: row.source_id,
  }
}

const laboratoryDefinitionDatabaseRowSchema = z.object({
  concept_id: z.string(),
  definition_json: z.string(),
  source_id: z.string(),
  source_locator: z.string(),
}).strict()

function mapLaboratoryDefinitionRow(
  row: z.infer<typeof laboratoryDefinitionDatabaseRowSchema>,
): SourcedLaboratoryDefinition {
  return {
    ...referenceLaboratoryDefinitionSchema.parse(JSON.parse(row.definition_json)),
    sourceId: row.source_id,
  }
}

function laboratoryDefinitionRows(
  database: ReferenceDatabase,
  releaseId: string,
  conceptId?: string,
): SourcedLaboratoryDefinition[] {
  const parameters = conceptId === undefined ? [releaseId] : [releaseId, conceptId]
  return z.array(laboratoryDefinitionDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT concept_id, definition_json, source_id, source_locator
    FROM reference_laboratory_definition
    WHERE release_id = ?
      ${conceptId === undefined ? '' : 'AND concept_id = ?'}
    ORDER BY source_id, concept_id
  `).all(...parameters)).map(mapLaboratoryDefinitionRow)
}

const laboratoryUnitDatabaseRowSchema = z.object({
  code: z.string(),
  concept_id: z.string(),
  kind: z.string(),
  ordinal: z.number().int(),
  source_id: z.string(),
  source_locator: z.string(),
}).strict()

function mapLaboratoryUnitRow(
  row: z.infer<typeof laboratoryUnitDatabaseRowSchema>,
): SourcedLaboratoryUnit {
  return {
    ...referenceLaboratoryUnitSchema.parse({
      code: row.code,
      conceptId: row.concept_id,
      kind: row.kind,
      ordinal: row.ordinal,
      sourceLocator: row.source_locator,
    }),
    sourceId: row.source_id,
  }
}

function laboratoryUnitRows(
  database: ReferenceDatabase,
  releaseId: string,
  conceptId?: string,
): SourcedLaboratoryUnit[] {
  const parameters = conceptId === undefined ? [releaseId] : [releaseId, conceptId]
  return z.array(laboratoryUnitDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT concept_id, code, kind, ordinal, source_id, source_locator
    FROM reference_laboratory_unit
    WHERE release_id = ?
      ${conceptId === undefined ? '' : 'AND concept_id = ?'}
    ORDER BY source_id, concept_id, ordinal, code, source_locator
  `).all(...parameters)).map(mapLaboratoryUnitRow)
}

const laboratorySpecimenDatabaseRowSchema = z.object({
  concept_id: z.string(),
  display: z.string(),
  link_type: z.string(),
  part_name: z.string(),
  part_number: z.string(),
  source_id: z.string(),
  source_locator: z.string(),
}).strict()

function mapLaboratorySpecimenRow(
  row: z.infer<typeof laboratorySpecimenDatabaseRowSchema>,
): SourcedLaboratorySpecimen {
  return {
    ...referenceLaboratorySpecimenSchema.parse({
      conceptId: row.concept_id,
      display: row.display,
      linkType: row.link_type,
      partName: row.part_name,
      partNumber: row.part_number,
      sourceLocator: row.source_locator,
    }),
    sourceId: row.source_id,
  }
}

function laboratorySpecimenRows(
  database: ReferenceDatabase,
  releaseId: string,
  conceptId?: string,
): SourcedLaboratorySpecimen[] {
  const parameters = conceptId === undefined ? [releaseId] : [releaseId, conceptId]
  return z.array(laboratorySpecimenDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT concept_id, part_number, part_name, display, link_type,
      source_id, source_locator
    FROM reference_laboratory_specimen
    WHERE release_id = ?
      ${conceptId === undefined ? '' : 'AND concept_id = ?'}
    ORDER BY source_id, concept_id, part_number, link_type
  `).all(...parameters)).map(mapLaboratorySpecimenRow)
}

const laboratoryPanelMemberDatabaseRowSchema = z.object({
  member_concept_id: z.string(),
  member_order: z.number().int(),
  panel_concept_id: z.string(),
  relationship: z.string(),
  source_id: z.string(),
  source_locator: z.string(),
}).strict()

function mapLaboratoryPanelMemberRow(
  row: z.infer<typeof laboratoryPanelMemberDatabaseRowSchema>,
): SourcedLaboratoryPanelMember {
  return {
    ...referenceLaboratoryPanelMemberSchema.parse({
      memberConceptId: row.member_concept_id,
      memberOrder: row.member_order,
      panelConceptId: row.panel_concept_id,
      relationship: row.relationship,
      sourceLocator: row.source_locator,
    }),
    sourceId: row.source_id,
  }
}

function laboratoryPanelMemberRows(
  database: ReferenceDatabase,
  releaseId: string,
  panelConceptId?: string,
): SourcedLaboratoryPanelMember[] {
  const parameters = panelConceptId === undefined ? [releaseId] : [releaseId, panelConceptId]
  return z.array(laboratoryPanelMemberDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT panel_concept_id, member_concept_id, member_order, relationship,
      source_id, source_locator
    FROM reference_laboratory_panel_member
    WHERE release_id = ?
      ${panelConceptId === undefined ? '' : 'AND panel_concept_id = ?'}
    ORDER BY source_id, panel_concept_id, member_order, member_concept_id, source_locator
  `).all(...parameters)).map(mapLaboratoryPanelMemberRow)
}

const medicationProductDatabaseRowSchema = z.object({
  approval_number: z.string(),
  brand_name: z.string().nullable(),
  code: z.string(),
  dosage_form: z.string(),
  generic_name: z.string(),
  manufacturer: z.string(),
  package_description: z.string(),
  product_id: z.string(),
  source_id: z.string(),
  source_locator: z.string(),
  status: z.string(),
  strength: z.string(),
  system: z.string(),
  system_version: z.string(),
})

function mapMedicationProductRow(
  row: z.infer<typeof medicationProductDatabaseRowSchema>,
): ReferenceMedicationProduct & { sourceId: string } {
  return {
    ...referenceMedicationProductSchema.parse({
      approvalNumber: row.approval_number,
      brandName: row.brand_name,
      code: row.code,
      dosageForm: row.dosage_form,
      genericName: row.generic_name,
      id: row.product_id,
      manufacturer: row.manufacturer,
      packageDescription: row.package_description,
      sourceLocator: row.source_locator,
      status: row.status,
      strength: row.strength,
      system: row.system,
      version: row.system_version,
    }),
    sourceId: row.source_id,
  }
}

function medicationProductRows(
  database: ReferenceDatabase,
  releaseId: string,
): Array<ReferenceMedicationProduct & { sourceId: string }> {
  return z.array(medicationProductDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT product_id, system, system_version, code, generic_name, brand_name,
      dosage_form, strength, package_description, manufacturer, approval_number,
      status, source_id, source_locator
    FROM reference_medication_product
    WHERE release_id = ?
    ORDER BY source_id, product_id
  `).all(releaseId)).map(mapMedicationProductRow)
}

const medicalServiceDatabaseRowSchema = z.object({
  billing_unit_code: z.string(),
  category_code: z.string(),
  code: z.string(),
  display: z.string(),
  service_id: z.string(),
  source_id: z.string(),
  source_locator: z.string(),
  status: z.string(),
  system: z.string(),
  system_version: z.string(),
})

function mapMedicalServiceRow(
  row: z.infer<typeof medicalServiceDatabaseRowSchema>,
): ReferenceMedicalService & { sourceId: string } {
  return {
    ...referenceMedicalServiceSchema.parse({
      billingUnitCode: row.billing_unit_code,
      categoryCode: row.category_code,
      code: row.code,
      display: row.display,
      id: row.service_id,
      sourceLocator: row.source_locator,
      status: row.status,
      system: row.system,
      version: row.system_version,
    }),
    sourceId: row.source_id,
  }
}

function medicalServiceRows(
  database: ReferenceDatabase,
  releaseId: string,
): Array<ReferenceMedicalService & { sourceId: string }> {
  return z.array(medicalServiceDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT service_id, system, system_version, code, display, category_code,
      billing_unit_code, status, source_id, source_locator
    FROM reference_medical_service
    WHERE release_id = ?
    ORDER BY source_id, service_id
  `).all(releaseId)).map(mapMedicalServiceRow)
}

const valueSetEntryDatabaseRowSchema = z.object({
  code: z.string(),
  display: z.string(),
  entry_id: z.string(),
  source_id: z.string(),
  source_locator: z.string(),
  status: z.string(),
  system: z.string(),
  system_version: z.string(),
  value_set: z.string(),
})

function mapValueSetEntryRow(
  row: z.infer<typeof valueSetEntryDatabaseRowSchema>,
): ReferenceValueSetEntry & { sourceId: string } {
  return {
    ...referenceValueSetEntrySchema.parse({
      code: row.code,
      display: row.display,
      id: row.entry_id,
      sourceLocator: row.source_locator,
      status: row.status,
      system: row.system,
      valueSet: row.value_set,
      version: row.system_version,
    }),
    sourceId: row.source_id,
  }
}

function valueSetEntryRows(
  database: ReferenceDatabase,
  releaseId: string,
): Array<ReferenceValueSetEntry & { sourceId: string }> {
  return z.array(valueSetEntryDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT entry_id, value_set, system, system_version, code, display,
      status, source_id, source_locator
    FROM reference_value_set_entry
    WHERE release_id = ?
    ORDER BY source_id, entry_id
  `).all(releaseId)).map(mapValueSetEntryRow)
}

export function listReferenceMedicationProducts(
  database: ReferenceDatabase,
  releaseId: string,
  codings?: readonly { code: string; system: string; version: string }[],
): ReferenceMedicationProduct[] {
  verifyReferenceMigrations(database)
  if (codings !== undefined) {
    const lookup = database.driver.prepare(`
      SELECT product_id, system, system_version, code, generic_name, brand_name,
        dosage_form, strength, package_description, manufacturer, approval_number,
        status, source_id, source_locator
      FROM reference_medication_product
      WHERE release_id = ? AND system = ? AND system_version = ? AND code = ?
    `)
    return codings.flatMap((coding) => {
      const row = lookup.get(releaseId, coding.system, coding.version, coding.code)
      return row === undefined
        ? []
        : [mapMedicationProductRow(medicationProductDatabaseRowSchema.parse(row))]
    }).map(({ sourceId: _sourceId, ...product }) => product)
  }
  return medicationProductRows(database, releaseId).map(({ sourceId: _sourceId, ...product }) => (
    product
  ))
}

export function listReferenceConcepts(
  database: ReferenceDatabase,
  releaseId: string,
  codings: readonly { code: string; system: string; version: string }[],
): ReferenceConcept[] {
  verifyReferenceMigrations(database)
  const lookup = database.driver.prepare(`
    SELECT concept_id, domain, system, system_version, code, display, status,
      laboratory_metadata_json,
      source_id, source_locator
    FROM reference_concept
    WHERE release_id = ? AND system = ? AND system_version = ? AND code = ?
  `)
  return codings.flatMap((coding) => {
    const row = lookup.get(releaseId, coding.system, coding.version, coding.code)
    return row === undefined ? [] : [mapConceptRow(conceptDatabaseRowSchema.parse(row))]
  }).map(({ sourceId: _sourceId, ...concept }) => concept)
}

export function listReferenceMedicalServices(
  database: ReferenceDatabase,
  releaseId: string,
): ReferenceMedicalService[] {
  verifyReferenceMigrations(database)
  return medicalServiceRows(database, releaseId).map(({ sourceId: _sourceId, ...service }) => service)
}

export function listReferenceValueSetEntries(
  database: ReferenceDatabase,
  releaseId: string,
): ReferenceValueSetEntry[] {
  verifyReferenceMigrations(database)
  return valueSetEntryRows(database, releaseId).map(({ sourceId: _sourceId, ...entry }) => entry)
}

function ftsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`
}

function referenceCatalogTextSearch(
  table: 'reference_concept' | 'reference_medication_product',
  query: string,
) {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  const indexedTerms = terms.filter(term => [...term].length >= 3)
  const shortTerms = terms.filter(term => [...term].length < 3)
  const columns = table === 'reference_concept'
    ? ['display', 'code']
    : ['generic_name', 'brand_name', 'manufacturer', 'code']
  const conditions: string[] = []
  const parameters: string[] = []
  if (indexedTerms.length > 0) {
    conditions.push(`${table}_fts MATCH ?`)
    parameters.push(indexedTerms.map(ftsPhrase).join(' AND '))
  }
  for (const term of shortTerms) {
    conditions.push(`(${columns.map(column => `instr(lower(${table}.${column}), lower(?)) > 0`).join(' OR ')})`)
    parameters.push(...columns.map(() => term))
  }
  return {
    condition: conditions.length === 0 ? '' : `AND ${conditions.join(' AND ')}`,
    parameters,
    rankOrder: indexedTerms.length === 0 ? '' : `bm25(${table}_fts),`,
    source: indexedTerms.length === 0 ? table : `${table}
      JOIN ${table}_fts ON ${table}_fts.rowid = ${table}.rowid`,
  }
}

function searchReferenceLaboratoryCatalog(
  database: ReferenceDatabase,
  releaseId: string,
  input: ReferenceCatalogSearchInput,
): ReferenceCatalogSearchResult<ReferenceConcept> {
  const parameters: unknown[] = [releaseId]
  let source = 'reference_concept'
  let queryCondition = ''
  if (input.query !== undefined && input.query.length < 3) {
    queryCondition = `
      AND (
        instr(lower(reference_concept.display), lower(?)) > 0
        OR instr(lower(reference_concept.code), lower(?)) > 0
      )
    `
    parameters.push(input.query, input.query)
  } else if (input.query !== undefined) {
    source += `
      JOIN reference_concept_fts
        ON reference_concept_fts.rowid = reference_concept.rowid
    `
    queryCondition = 'AND reference_concept_fts MATCH ?'
    parameters.push(ftsPhrase(input.query))
  }
  const rankedConcepts = `
    WITH ranked_concepts AS (
      SELECT
        reference_concept.concept_id,
        reference_concept.domain,
        reference_concept.system,
        reference_concept.system_version,
        reference_concept.code,
        reference_concept.display,
        reference_concept.status,
        reference_concept.laboratory_metadata_json,
        reference_concept.source_id,
        reference_concept.source_locator,
        ROW_NUMBER() OVER (
          PARTITION BY reference_concept.system, reference_concept.code
          ORDER BY
            CASE WHEN reference_concept.status = 'active' THEN 0 ELSE 1 END,
            reference_concept.source_id DESC,
            reference_concept.system_version DESC,
            reference_concept.concept_id
        ) AS coding_rank
      FROM ${source}
      WHERE reference_concept.release_id = ?
        AND reference_concept.domain = 'laboratory'
        ${queryCondition}
    )
  `
  const countSchema = z.object({ count: z.number().int().nonnegative() }).strict()
  const total = countSchema.parse(database.driver.prepare(`
    ${rankedConcepts}
    SELECT COUNT(*) AS count FROM ranked_concepts WHERE coding_rank = 1
  `).get(...parameters)).count
  const offset = (input.page - 1) * input.pageSize
  const rows = z.array(conceptDatabaseRowSchema).parse(database.driver.prepare(`
    ${rankedConcepts}
    SELECT concept_id, domain, system, system_version, code, display, status,
      laboratory_metadata_json, source_id, source_locator
    FROM ranked_concepts
    WHERE coding_rank = 1
    ORDER BY display, code, concept_id
    LIMIT ? OFFSET ?
  `).all(...parameters, input.pageSize, offset))
  return {
    items: rows.map(mapConceptRow).map(({ sourceId: _sourceId, ...concept }) => concept),
    total,
  }
}

export function searchReferenceConceptCatalog(
  database: ReferenceDatabase,
  releaseId: string,
  domain: 'diagnosis' | 'laboratory',
  input: ReferenceCatalogSearchInput,
): ReferenceCatalogSearchResult<ReferenceConcept> {
  verifyReferenceMigrations(database)
  if (domain === 'laboratory') {
    return searchReferenceLaboratoryCatalog(database, releaseId, input)
  }
  const offset = (input.page - 1) * input.pageSize
  const countSchema = z.object({ count: z.number().int().nonnegative() }).strict()
  if (input.query === undefined) {
    const total = countSchema.parse(database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM reference_concept
      WHERE release_id = ? AND domain = ?
    `).get(releaseId, domain)).count
    const rows = z.array(conceptDatabaseRowSchema).parse(database.driver.prepare(`
      SELECT concept_id, domain, system, system_version, code, display, status,
        laboratory_metadata_json,
        source_id, source_locator
      FROM reference_concept
      WHERE release_id = ? AND domain = ?
      ORDER BY display, code, concept_id
      LIMIT ? OFFSET ?
    `).all(releaseId, domain, input.pageSize, offset))
    return {
      items: rows.map(mapConceptRow).map(({ sourceId: _sourceId, ...concept }) => concept),
      total,
    }
  }
  const search = referenceCatalogTextSearch('reference_concept', input.query)
  const parameters = [releaseId, domain, ...search.parameters]
  const source = search.source
  const where = 'reference_concept.release_id = ? AND reference_concept.domain = ?' + ` ${search.condition}`
  const total = countSchema.parse(database.driver.prepare(`
    SELECT COUNT(*) AS count FROM ${source} WHERE ${where}
  `).get(...parameters)).count
  const rows = z.array(conceptDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT reference_concept.concept_id, reference_concept.domain,
      reference_concept.system, reference_concept.system_version,
      reference_concept.code, reference_concept.display, reference_concept.status,
      reference_concept.laboratory_metadata_json,
      reference_concept.source_id, reference_concept.source_locator
    FROM ${source} WHERE ${where}
    ORDER BY ${search.rankOrder}
      reference_concept.display, reference_concept.code, reference_concept.concept_id
    LIMIT ? OFFSET ?
  `).all(...parameters, input.pageSize, offset))
  return {
    items: rows.map(mapConceptRow).map(({ sourceId: _sourceId, ...concept }) => concept),
    total,
  }
}

export function searchReferenceLaboratoryRecords(
  database: ReferenceDatabase,
  releaseId: string,
  input: ReferenceLaboratoryCandidateSearchInput,
): ReferenceCatalogSearchResult<ReferenceLaboratoryRecord> {
  verifyReferenceMigrations(database)
  const parameters: unknown[] = [releaseId]
  let source = `
    reference_concept
    JOIN reference_laboratory_definition
      ON reference_laboratory_definition.release_id = reference_concept.release_id
     AND reference_laboratory_definition.concept_id = reference_concept.concept_id
  `
  let queryCondition = ''
  let filterCondition = ''
  if (input.sourceDataset === 'laboratory-cn') {
    filterCondition += `
      AND json_extract(
        reference_laboratory_definition.definition_json,
        '$.kind'
      ) IN ('laboratory-cn-panel', 'laboratory-cn-test')
    `
  } else if (input.sourceDataset === 'loinc-zh-cn') {
    filterCondition += `
      AND json_extract(
        reference_laboratory_definition.definition_json,
        '$.kind'
      ) = 'loinc'
    `
  }
  if (input.panelOnly === true) {
    filterCondition += `
      AND (
        json_extract(
          reference_laboratory_definition.definition_json,
          '$.kind'
        ) = 'laboratory-cn-panel'
        OR json_extract(
          reference_laboratory_definition.definition_json,
          '$.panelType'
        ) IS NOT NULL
      )
    `
  }
  if (input.query !== undefined && input.query.length < 3) {
    queryCondition = `
      AND (
        instr(lower(reference_concept.display), lower(?)) > 0
        OR instr(lower(reference_concept.code), lower(?)) > 0
      )
    `
    parameters.push(input.query, input.query)
  } else if (input.query !== undefined) {
    source += `
      JOIN reference_concept_fts
        ON reference_concept_fts.rowid = reference_concept.rowid
    `
    queryCondition = 'AND reference_concept_fts MATCH ?'
    parameters.push(ftsPhrase(input.query))
  }
  const where = `
    WHERE reference_concept.release_id = ?
      AND reference_concept.domain = 'laboratory'
      AND reference_concept.status = 'active'
      AND (
        (
          json_extract(reference_laboratory_definition.definition_json, '$.kind') = 'loinc'
          AND json_extract(reference_laboratory_definition.definition_json, '$.classType') = 1
          AND json_extract(
            reference_laboratory_definition.definition_json,
            '$.orderObservation'
          ) IN ('Order', 'Both')
        )
        OR json_extract(
          reference_laboratory_definition.definition_json,
          '$.kind'
        ) IN ('laboratory-cn-panel', 'laboratory-cn-test')
      )
      ${filterCondition}
      ${queryCondition}
  `
  const total = z.object({ count: z.number().int().nonnegative() }).parse(
    database.driver.prepare(`
      SELECT COUNT(*) AS count FROM ${source} ${where}
    `).get(...parameters),
  ).count
  const rows = z.array(z.object({ concept_id: z.string() }).strict()).parse(
    database.driver.prepare(`
      SELECT reference_concept.concept_id
      FROM ${source}
      ${where}
      ORDER BY reference_concept.display, reference_concept.code,
        reference_concept.concept_id
      LIMIT ? OFFSET ?
    `).all(
      ...parameters,
      input.pageSize,
      (input.page - 1) * input.pageSize,
    ),
  )
  return {
    items: rows.map(row => referenceLaboratoryRecord(
      database,
      releaseId,
      row.concept_id,
    )).filter((record): record is ReferenceLaboratoryRecord => record !== undefined),
    total,
  }
}

export function searchReferenceMedicationCatalog(
  database: ReferenceDatabase,
  releaseId: string,
  input: ReferenceCatalogSearchInput,
): ReferenceCatalogSearchResult<ReferenceMedicationProduct> {
  verifyReferenceMigrations(database)
  const offset = (input.page - 1) * input.pageSize
  const countSchema = z.object({ count: z.number().int().nonnegative() }).strict()
  if (input.query === undefined) {
    const total = countSchema.parse(database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM reference_medication_product
      WHERE release_id = ?
    `).get(releaseId)).count
    const rows = z.array(medicationProductDatabaseRowSchema).parse(database.driver.prepare(`
      SELECT product_id, system, system_version, code, generic_name, brand_name,
        dosage_form, strength, package_description, manufacturer, approval_number,
        status, source_id, source_locator
      FROM reference_medication_product
      WHERE release_id = ?
      ORDER BY generic_name, code, product_id
      LIMIT ? OFFSET ?
    `).all(releaseId, input.pageSize, offset))
    return {
      items: rows.map(mapMedicationProductRow).map(({ sourceId: _sourceId, ...product }) => product),
      total,
    }
  }
  const search = referenceCatalogTextSearch('reference_medication_product', input.query)
  const parameters = [releaseId, ...search.parameters]
  const source = search.source
  const where = 'reference_medication_product.release_id = ?' + ` ${search.condition}`
  const total = countSchema.parse(database.driver.prepare(`
    SELECT COUNT(*) AS count FROM ${source} WHERE ${where}
  `).get(...parameters)).count
  const rows = z.array(medicationProductDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT reference_medication_product.product_id,
      reference_medication_product.system, reference_medication_product.system_version,
      reference_medication_product.code, reference_medication_product.generic_name,
      reference_medication_product.brand_name, reference_medication_product.dosage_form,
      reference_medication_product.strength,
      reference_medication_product.package_description,
      reference_medication_product.manufacturer,
      reference_medication_product.approval_number,
      reference_medication_product.status, reference_medication_product.source_id,
      reference_medication_product.source_locator
    FROM ${source} WHERE ${where}
    ORDER BY ${search.rankOrder}
      reference_medication_product.generic_name,
      reference_medication_product.code, reference_medication_product.product_id
    LIMIT ? OFFSET ?
  `).all(...parameters, input.pageSize, offset))
  return {
    items: rows.map(mapMedicationProductRow).map(({ sourceId: _sourceId, ...product }) => product),
    total,
  }
}

function referenceConceptById(
  database: ReferenceDatabase,
  releaseId: string,
  domain: 'diagnosis' | 'laboratory',
  conceptId: string,
): ReferenceConcept | undefined {
  const row = database.driver.prepare(`
    SELECT concept_id, domain, system, system_version, code, display, status,
      laboratory_metadata_json,
      source_id, source_locator
    FROM reference_concept
    WHERE release_id = ? AND domain = ? AND concept_id = ?
  `).get(releaseId, domain, conceptId)
  if (row === undefined) return undefined
  const { sourceId: _sourceId, ...concept } = mapConceptRow(conceptDatabaseRowSchema.parse(row))
  return concept
}

export function getReferenceConceptById(
  database: ReferenceDatabase,
  releaseId: string,
  domain: 'diagnosis' | 'laboratory',
  conceptId: string,
): ReferenceConcept | undefined {
  verifyReferenceMigrations(database)
  return referenceConceptById(database, releaseId, domain, conceptId)
}

function referenceLaboratoryRecord(
  database: ReferenceDatabase,
  releaseId: string,
  conceptId: string,
): ReferenceLaboratoryRecord | undefined {
  const concept = referenceConceptById(database, releaseId, 'laboratory', conceptId)
  if (concept === undefined) return undefined
  const sourcedDefinition = laboratoryDefinitionRows(database, releaseId, conceptId)[0]
  if (sourcedDefinition === undefined) return undefined
  const { sourceId: _sourceId, ...definition } = sourcedDefinition
  return {
    concept,
    definition,
    panelMembers: laboratoryPanelMemberRows(database, releaseId, conceptId)
      .map(({ sourceId: _sourceId, ...item }) => item),
    specimens: laboratorySpecimenRows(database, releaseId, conceptId)
      .map(({ sourceId: _sourceId, ...item }) => item),
    units: laboratoryUnitRows(database, releaseId, conceptId)
      .map(({ sourceId: _sourceId, ...item }) => item),
  }
}

export function getReferenceLaboratoryRecord(
  database: ReferenceDatabase,
  releaseId: string,
  conceptId: string,
): ReferenceLaboratoryRecord | undefined {
  verifyReferenceMigrations(database)
  return referenceLaboratoryRecord(database, releaseId, conceptId)
}

export function getReferenceMedicationProductById(
  database: ReferenceDatabase,
  releaseId: string,
  productId: string,
): ReferenceMedicationProduct | undefined {
  verifyReferenceMigrations(database)
  const row = database.driver.prepare(`
    SELECT product_id, system, system_version, code, generic_name, brand_name,
      dosage_form, strength, package_description, manufacturer, approval_number,
      status, source_id, source_locator
    FROM reference_medication_product
    WHERE release_id = ? AND product_id = ?
  `).get(releaseId, productId)
  if (row === undefined) return undefined
  const { sourceId: _sourceId, ...product } = mapMedicationProductRow(
    medicationProductDatabaseRowSchema.parse(row),
  )
  return product
}

const releaseDatabaseRowSchema = z.object({
  concept_count: z.number().int(),
  content_hash: z.string(),
  created_at: z.string(),
  laboratory_definition_count: z.number().int(),
  laboratory_panel_member_count: z.number().int(),
  laboratory_specimen_count: z.number().int(),
  laboratory_unit_count: z.number().int(),
  medication_product_count: z.number().int(),
  release_id: z.string(),
  schema_version: z.string(),
  service_count: z.number().int(),
  source_count: z.number().int(),
  status: z.string(),
  value_set_entry_count: z.number().int(),
})

function readReferenceDataReleases(database: ReferenceDatabase): ReferenceDataReleaseList {
  const rows = z.array(releaseDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT release_id, schema_version, status, created_at, content_hash,
      source_count, concept_count, medication_product_count, service_count,
      value_set_entry_count, laboratory_definition_count, laboratory_unit_count,
      laboratory_specimen_count, laboratory_panel_member_count
    FROM reference_release
    ORDER BY created_at DESC, release_id
  `).all())
  return referenceDataReleaseListSchema.parse({
    items: rows.map(row => ({
      conceptCount: row.concept_count,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      laboratoryDefinitionCount: row.laboratory_definition_count,
      laboratoryPanelMemberCount: row.laboratory_panel_member_count,
      laboratorySpecimenCount: row.laboratory_specimen_count,
      laboratoryUnitCount: row.laboratory_unit_count,
      medicationProductCount: row.medication_product_count,
      releaseId: row.release_id,
      serviceCount: row.service_count,
      schemaVersion: row.schema_version,
      sourceCount: row.source_count,
      sources: sourceRows(database, row.release_id),
      status: row.status,
      valueSetEntryCount: row.value_set_entry_count,
    })),
  })
}

export function listReferenceDataReleases(database: ReferenceDatabase): ReferenceDataReleaseList {
  verifyReferenceMigrations(database)
  return readReferenceDataReleases(database)
}

const stagingBatchRowLimit = 500

const dropTempStagingTablesSql = `
  DROP TABLE IF EXISTS temp.staging_laboratory_panel_member;
  DROP TABLE IF EXISTS temp.staging_laboratory_specimen;
  DROP TABLE IF EXISTS temp.staging_laboratory_unit;
  DROP TABLE IF EXISTS temp.staging_laboratory_definition;
  DROP TABLE IF EXISTS temp.staging_value_set_entry;
  DROP TABLE IF EXISTS temp.staging_medical_service;
  DROP TABLE IF EXISTS temp.staging_medication_product;
  DROP TABLE IF EXISTS temp.staging_concept;
  DROP TABLE IF EXISTS temp.staging_source_manifest;
`

const createTempStagingTablesSql = `
  ${dropTempStagingTablesSql}

  CREATE TEMP TABLE staging_source_manifest (
    source_id TEXT PRIMARY KEY,
    upstream_version TEXT NOT NULL,
    published_at TEXT,
    retrieved_at TEXT NOT NULL,
    source_url TEXT NOT NULL,
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    license_id TEXT NOT NULL,
    acquisition_method TEXT NOT NULL CHECK (
      acquisition_method IN ('bundled-fixture', 'documented-api', 'generated', 'manual-download')
    ),
    artifact_format TEXT NOT NULL CHECK (
      artifact_format IN (
        'cn-health-candidate', 'clinmesh-reference-v1', 'loinc-csv',
        'nhc-medical-service-csv', 'nhsa-diagnosis-csv',
        'nhsa-medication-product-csv', 'ucum-xml', 'wst-value-set-csv'
      )
    ),
    record_count INTEGER NOT NULL CHECK (record_count >= 0),
    import_diagnostics_json TEXT NOT NULL CHECK (json_valid(import_diagnostics_json)),
    candidate_provenance_json TEXT
      CHECK (candidate_provenance_json IS NULL OR json_valid(candidate_provenance_json)),
    materialization_json TEXT
      CHECK (materialization_json IS NULL OR json_valid(materialization_json))
  ) STRICT;

  CREATE TEMP TABLE staging_concept (
    concept_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL CHECK (
      domain IN ('diagnosis', 'laboratory', 'medication', 'service', 'unit', 'other')
    ),
    system TEXT NOT NULL,
    system_version TEXT NOT NULL,
    code TEXT NOT NULL,
    display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    source_id TEXT NOT NULL REFERENCES staging_source_manifest (source_id) ON DELETE RESTRICT,
    source_locator TEXT NOT NULL,
    laboratory_metadata_json TEXT
      CHECK (laboratory_metadata_json IS NULL OR json_valid(laboratory_metadata_json)),
    UNIQUE (system, system_version, code)
  ) STRICT;

  CREATE TEMP TABLE staging_laboratory_definition (
    concept_id TEXT PRIMARY KEY,
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    source_id TEXT NOT NULL REFERENCES staging_source_manifest (source_id) ON DELETE RESTRICT,
    source_locator TEXT NOT NULL
  ) STRICT;

  CREATE TEMP TABLE staging_laboratory_unit (
    concept_id TEXT NOT NULL,
    code TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'example'),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    source_id TEXT NOT NULL REFERENCES staging_source_manifest (source_id) ON DELETE RESTRICT,
    source_locator TEXT NOT NULL,
    PRIMARY KEY (concept_id, source_locator)
  ) STRICT;

  CREATE TEMP TABLE staging_laboratory_specimen (
    concept_id TEXT NOT NULL,
    part_number TEXT NOT NULL,
    part_name TEXT NOT NULL,
    display TEXT NOT NULL,
    link_type TEXT NOT NULL CHECK (link_type = 'Primary'),
    source_id TEXT NOT NULL REFERENCES staging_source_manifest (source_id) ON DELETE RESTRICT,
    source_locator TEXT NOT NULL,
    PRIMARY KEY (concept_id, part_number, link_type)
  ) STRICT;

  CREATE TEMP TABLE staging_laboratory_panel_member (
    panel_concept_id TEXT NOT NULL,
    member_concept_id TEXT NOT NULL,
    member_order INTEGER NOT NULL CHECK (member_order >= 0),
    relationship TEXT NOT NULL CHECK (relationship = 'contains'),
    source_id TEXT NOT NULL REFERENCES staging_source_manifest (source_id) ON DELETE RESTRICT,
    source_locator TEXT NOT NULL,
    PRIMARY KEY (panel_concept_id, member_concept_id, source_locator),
    CHECK (panel_concept_id <> member_concept_id)
  ) STRICT;

  CREATE TEMP TABLE staging_medication_product (
    product_id TEXT PRIMARY KEY,
    system TEXT NOT NULL,
    system_version TEXT NOT NULL,
    code TEXT NOT NULL,
    generic_name TEXT NOT NULL,
    brand_name TEXT,
    dosage_form TEXT NOT NULL,
    strength TEXT NOT NULL,
    package_description TEXT NOT NULL,
    manufacturer TEXT NOT NULL,
    approval_number TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    source_id TEXT NOT NULL REFERENCES staging_source_manifest (source_id) ON DELETE RESTRICT,
    source_locator TEXT NOT NULL,
    UNIQUE (system, system_version, code)
  ) STRICT;

  CREATE TEMP TABLE staging_medical_service (
    service_id TEXT PRIMARY KEY,
    system TEXT NOT NULL,
    system_version TEXT NOT NULL,
    code TEXT NOT NULL,
    display TEXT NOT NULL,
    category_code TEXT NOT NULL,
    billing_unit_code TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    source_id TEXT NOT NULL REFERENCES staging_source_manifest (source_id) ON DELETE RESTRICT,
    source_locator TEXT NOT NULL,
    UNIQUE (system, system_version, code)
  ) STRICT;

  CREATE TEMP TABLE staging_value_set_entry (
    entry_id TEXT PRIMARY KEY,
    value_set TEXT NOT NULL,
    system TEXT NOT NULL,
    system_version TEXT NOT NULL,
    code TEXT NOT NULL,
    display TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    source_id TEXT NOT NULL REFERENCES staging_source_manifest (source_id) ON DELETE RESTRICT,
    source_locator TEXT NOT NULL,
    UNIQUE (system, system_version, code)
  ) STRICT;
`

const stagingConstraintMessages: ReadonlyArray<readonly [string, string]> = [
  ['staging_source_manifest.source_id', 'Reference source ID was repeated'],
  ['staging_concept.concept_id', 'Reference concept ID was repeated'],
  ['staging_concept.system', 'Reference coding was repeated'],
  ['staging_medication_product.product_id', 'Reference medication product ID was repeated'],
  ['staging_medication_product.system', 'Reference medication product coding was repeated'],
  ['staging_medical_service.service_id', 'Reference medical service ID was repeated'],
  ['staging_medical_service.system', 'Reference medical service coding was repeated'],
  ['staging_value_set_entry.entry_id', 'Reference value set entry ID was repeated'],
  ['staging_value_set_entry.system', 'Reference value set entry coding was repeated'],
]

function translateStagingConstraintError(error: unknown): never {
  if (error instanceof Database.SqliteError && error.code.startsWith('SQLITE_CONSTRAINT')) {
    for (const [columnTarget, message] of stagingConstraintMessages) {
      if (error.message.includes(columnTarget)) {
        throw new Error(message)
      }
    }
  }
  throw error
}

function runStagingWrite<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch (error) {
    translateStagingConstraintError(error)
  }
}

function insertMultiRowBatch<Item>(input: {
  batch: Item[]
  columnsSql: string
  driver: Database.Database
  fullBatchStatementRef: { current?: Database.Statement<unknown[], unknown> }
  placeholderTuple: string
  serializeRow: (item: Item) => readonly unknown[]
  tableName: string
}): void {
  if (input.batch.length === 0) return
  const parameters: unknown[] = []
  for (const item of input.batch) {
    parameters.push(...input.serializeRow(item))
  }
  const count = input.batch.length
  input.batch.length = 0
  runStagingWrite(() => {
    if (count === stagingBatchRowLimit) {
      input.fullBatchStatementRef.current ??= input.driver.prepare(`
        INSERT INTO temp.${input.tableName} (${input.columnsSql})
        VALUES ${Array.from({ length: count }, () => input.placeholderTuple).join(', ')}
      `)
      input.fullBatchStatementRef.current.run(...parameters)
      return
    }
    input.driver.prepare(`
      INSERT INTO temp.${input.tableName} (${input.columnsSql})
      VALUES ${Array.from({ length: count }, () => input.placeholderTuple).join(', ')}
    `).run(...parameters)
  })
}

class StagingBatchWriter implements ReferenceStagingSink {
  readonly #concepts: ReferenceConcept[] = []
  readonly #conceptsStmt: { current?: Database.Statement<unknown[], unknown> } = {}
  readonly #definitions: ReferenceLaboratoryDefinition[] = []
  readonly #definitionsStmt: { current?: Database.Statement<unknown[], unknown> } = {}
  readonly #driver: Database.Database
  readonly #panelMembers: ReferenceLaboratoryPanelMember[] = []
  readonly #panelMembersStmt: { current?: Database.Statement<unknown[], unknown> } = {}
  readonly #products: ReferenceMedicationProduct[] = []
  readonly #productsStmt: { current?: Database.Statement<unknown[], unknown> } = {}
  readonly #services: ReferenceMedicalService[] = []
  readonly #servicesStmt: { current?: Database.Statement<unknown[], unknown> } = {}
  readonly #sourceId: string
  readonly #specimens: ReferenceLaboratorySpecimen[] = []
  readonly #specimensStmt: { current?: Database.Statement<unknown[], unknown> } = {}
  readonly #units: ReferenceLaboratoryUnit[] = []
  readonly #unitsStmt: { current?: Database.Statement<unknown[], unknown> } = {}
  readonly #valueSetEntries: ReferenceValueSetEntry[] = []
  readonly #valueSetEntriesStmt: { current?: Database.Statement<unknown[], unknown> } = {}

  constructor(driver: Database.Database, sourceId: string) {
    this.#driver = driver
    this.#sourceId = sourceId
  }

  stageConcept(concept: ReferenceConcept): void {
    this.#concepts.push(concept)
    if (this.#concepts.length >= stagingBatchRowLimit) this.#flushConcepts()
  }

  stageLaboratoryDefinition(definition: ReferenceLaboratoryDefinition): void {
    this.#definitions.push(definition)
    if (this.#definitions.length >= stagingBatchRowLimit) {
      this.#flushConcepts()
      this.#flushDefinitions()
    }
  }

  stageLaboratoryUnit(unit: ReferenceLaboratoryUnit): void {
    this.#units.push(unit)
    if (this.#units.length >= stagingBatchRowLimit) {
      this.#flushConcepts()
      this.#flushUnits()
    }
  }

  stageLaboratorySpecimen(specimen: ReferenceLaboratorySpecimen): void {
    this.#specimens.push(specimen)
    if (this.#specimens.length >= stagingBatchRowLimit) {
      this.#flushConcepts()
      this.#flushSpecimens()
    }
  }

  stageLaboratoryPanelMember(member: ReferenceLaboratoryPanelMember): void {
    this.#panelMembers.push(member)
    if (this.#panelMembers.length >= stagingBatchRowLimit) {
      this.#flushConcepts()
      this.#flushPanelMembers()
    }
  }

  stageMedicationProduct(product: ReferenceMedicationProduct): void {
    this.#products.push(product)
    if (this.#products.length >= stagingBatchRowLimit) this.#flushProducts()
  }

  stageMedicalService(service: ReferenceMedicalService): void {
    this.#services.push(service)
    if (this.#services.length >= stagingBatchRowLimit) this.#flushServices()
  }

  stageValueSetEntry(entry: ReferenceValueSetEntry): void {
    this.#valueSetEntries.push(entry)
    if (this.#valueSetEntries.length >= stagingBatchRowLimit) this.#flushValueSetEntries()
  }

  flush(): void {
    this.#flushConcepts()
    this.#flushDefinitions()
    this.#flushUnits()
    this.#flushSpecimens()
    this.#flushPanelMembers()
    this.#flushProducts()
    this.#flushServices()
    this.#flushValueSetEntries()
  }

  #flushConcepts(): void {
    insertMultiRowBatch({
      batch: this.#concepts,
      columnsSql: `
        concept_id, domain, system, system_version, code, display,
        status, source_id, source_locator, laboratory_metadata_json
      `,
      driver: this.#driver,
      fullBatchStatementRef: this.#conceptsStmt,
      placeholderTuple: '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      serializeRow: concept => [
        concept.id,
        concept.domain,
        concept.system,
        concept.version,
        concept.code,
        concept.display,
        concept.status,
        this.#sourceId,
        concept.sourceLocator,
        concept.laboratory === undefined ? null : JSON.stringify(concept.laboratory),
      ],
      tableName: 'staging_concept',
    })
  }

  #flushDefinitions(): void {
    insertMultiRowBatch({
      batch: this.#definitions,
      columnsSql: 'concept_id, definition_json, source_id, source_locator',
      driver: this.#driver,
      fullBatchStatementRef: this.#definitionsStmt,
      placeholderTuple: '(?, ?, ?, ?)',
      serializeRow: definition => [
        definition.conceptId,
        JSON.stringify(definition),
        this.#sourceId,
        definition.sourceLocator,
      ],
      tableName: 'staging_laboratory_definition',
    })
  }

  #flushUnits(): void {
    insertMultiRowBatch({
      batch: this.#units,
      columnsSql: 'concept_id, code, kind, ordinal, source_id, source_locator',
      driver: this.#driver,
      fullBatchStatementRef: this.#unitsStmt,
      placeholderTuple: '(?, ?, ?, ?, ?, ?)',
      serializeRow: unit => [
        unit.conceptId,
        unit.code,
        unit.kind,
        unit.ordinal,
        this.#sourceId,
        unit.sourceLocator,
      ],
      tableName: 'staging_laboratory_unit',
    })
  }

  #flushSpecimens(): void {
    insertMultiRowBatch({
      batch: this.#specimens,
      columnsSql: `
        concept_id, part_number, part_name, display, link_type, source_id, source_locator
      `,
      driver: this.#driver,
      fullBatchStatementRef: this.#specimensStmt,
      placeholderTuple: '(?, ?, ?, ?, ?, ?, ?)',
      serializeRow: specimen => [
        specimen.conceptId,
        specimen.partNumber,
        specimen.partName,
        specimen.display,
        specimen.linkType,
        this.#sourceId,
        specimen.sourceLocator,
      ],
      tableName: 'staging_laboratory_specimen',
    })
  }

  #flushPanelMembers(): void {
    insertMultiRowBatch({
      batch: this.#panelMembers,
      columnsSql: `
        panel_concept_id, member_concept_id, member_order, relationship, source_id, source_locator
      `,
      driver: this.#driver,
      fullBatchStatementRef: this.#panelMembersStmt,
      placeholderTuple: '(?, ?, ?, ?, ?, ?)',
      serializeRow: member => [
        member.panelConceptId,
        member.memberConceptId,
        member.memberOrder,
        member.relationship,
        this.#sourceId,
        member.sourceLocator,
      ],
      tableName: 'staging_laboratory_panel_member',
    })
  }

  #flushProducts(): void {
    insertMultiRowBatch({
      batch: this.#products,
      columnsSql: `
        product_id, system, system_version, code, generic_name, brand_name,
        dosage_form, strength, package_description, manufacturer,
        approval_number, status, source_id, source_locator
      `,
      driver: this.#driver,
      fullBatchStatementRef: this.#productsStmt,
      placeholderTuple: '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      serializeRow: product => [
        product.id,
        product.system,
        product.version,
        product.code,
        product.genericName,
        product.brandName,
        product.dosageForm,
        product.strength,
        product.packageDescription,
        product.manufacturer,
        product.approvalNumber,
        product.status,
        this.#sourceId,
        product.sourceLocator,
      ],
      tableName: 'staging_medication_product',
    })
  }

  #flushServices(): void {
    insertMultiRowBatch({
      batch: this.#services,
      columnsSql: `
        service_id, system, system_version, code, display,
        category_code, billing_unit_code, status, source_id, source_locator
      `,
      driver: this.#driver,
      fullBatchStatementRef: this.#servicesStmt,
      placeholderTuple: '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      serializeRow: service => [
        service.id,
        service.system,
        service.version,
        service.code,
        service.display,
        service.categoryCode,
        service.billingUnitCode,
        service.status,
        this.#sourceId,
        service.sourceLocator,
      ],
      tableName: 'staging_medical_service',
    })
  }

  #flushValueSetEntries(): void {
    insertMultiRowBatch({
      batch: this.#valueSetEntries,
      columnsSql: `
        entry_id, value_set, system, system_version, code,
        display, status, source_id, source_locator
      `,
      driver: this.#driver,
      fullBatchStatementRef: this.#valueSetEntriesStmt,
      placeholderTuple: '(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      serializeRow: entry => [
        entry.id,
        entry.valueSet,
        entry.system,
        entry.version,
        entry.code,
        entry.display,
        entry.status,
        this.#sourceId,
        entry.sourceLocator,
      ],
      tableName: 'staging_value_set_entry',
    })
  }
}

const existingReleaseHashRowSchema = z.object({
  content_hash: z.string(),
}).strict().optional()

const stagingCountsRowSchema = z.object({
  concept_count: z.number().int().nonnegative(),
  has_orphan_laboratory_concept: z.union([z.literal(0), z.literal(1)]),
  laboratory_definition_count: z.number().int().nonnegative(),
  laboratory_panel_member_count: z.number().int().nonnegative(),
  laboratory_specimen_count: z.number().int().nonnegative(),
  laboratory_unit_count: z.number().int().nonnegative(),
  medication_product_count: z.number().int().nonnegative(),
  service_count: z.number().int().nonnegative(),
  value_set_entry_count: z.number().int().nonnegative(),
}).strict()

function streamStagedRows<RawRow, Mapped>(input: {
  count: number
  driver: Database.Database
  mapRow: (row: RawRow) => Mapped
  rowSchema: z.ZodType<RawRow>
  sql: string
}): Iterable<Mapped> {
  if (input.count === 0) return []
  return {
    * [Symbol.iterator]() {
      const statement = input.driver.prepare(input.sql)
      for (const raw of statement.iterate()) {
        yield input.mapRow(input.rowSchema.parse(raw))
      }
    },
  }
}

export function importReferenceDataRelease(
  database: ReferenceDatabase,
  manifestPath: string,
): ReferenceImportResult {
  verifyReferenceMigrations(database)
  const manifest = referenceImportManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const manifestDirectory = dirname(resolve(manifestPath))

  database.driver.exec(createTempStagingTablesSql)
  let result!: ReferenceImportResult
  let primaryError: unknown
  let cleanupError: unknown
  try {
    const insertInitialSource = database.driver.prepare(`
      INSERT INTO temp.staging_source_manifest (
        source_id, upstream_version, published_at, retrieved_at,
        source_url, checksum, license_id, acquisition_method, artifact_format,
        record_count, import_diagnostics_json, candidate_provenance_json, materialization_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)
    `)
    const updateFinalSource = database.driver.prepare(`
      UPDATE temp.staging_source_manifest
      SET record_count = ?,
          import_diagnostics_json = ?,
          candidate_provenance_json = ?
      WHERE source_id = ?
    `)
    const emptyDiagnosticsJson = JSON.stringify({
      acceptedCount: 0,
      rejectedCount: 0,
      warnings: [],
    })

    for (const source of manifest.sources) {
      const artifactPath = resolve(manifestDirectory, source.artifactPath)
      const actualChecksum = streamFileSha256AndSize(artifactPath).sha256
      if (actualChecksum !== source.checksum) {
        throw new Error(`Reference source checksum mismatch: ${source.sourceId}`)
      }
      runStagingWrite(() => {
        insertInitialSource.run(
          source.sourceId,
          source.upstreamVersion,
          source.publishedAt ?? null,
          source.retrievedAt,
          source.sourceUrl,
          actualChecksum,
          source.licenseId,
          source.acquisitionMethod,
          source.artifactFormat,
          emptyDiagnosticsJson,
          source.materialization === undefined ? null : JSON.stringify(source.materialization),
        )
      })
      const sink = new StagingBatchWriter(database.driver, source.sourceId)
      if (source.artifactFormat === 'cn-health-candidate') {
        const stagedCandidate = stageCnHealthCandidateReferenceArtifact({
          driver: database.driver,
          expectedUpstreamVersion: source.upstreamVersion,
          manifestPath: artifactPath,
          runStagingWrite,
          sink,
          sourceId: source.sourceId,
        })
        updateFinalSource.run(
          stagedCandidate.recordCount,
          JSON.stringify({
            acceptedCount: stagedCandidate.acceptedCount,
            rejectedCount: 0,
            warnings: [],
          }),
          JSON.stringify(stagedCandidate.provenance),
          source.sourceId,
        )
      } else {
        const stagedText = stageTextReferenceSourceArtifact({
          artifactPath,
          format: source.artifactFormat,
          sink,
          version: source.upstreamVersion,
        })
        updateFinalSource.run(
          stagedText.recordCount,
          JSON.stringify({
            acceptedCount: stagedText.acceptedCount,
            rejectedCount: 0,
            warnings: [],
          }),
          null,
          source.sourceId,
        )
      }
    }

    const stagedSources = z.array(sourceManifestDatabaseRowSchema).parse(
      database.driver.prepare(`
        SELECT source_id, upstream_version, published_at, retrieved_at, source_url,
          checksum, license_id, acquisition_method, artifact_format, record_count,
          import_diagnostics_json, candidate_provenance_json, materialization_json
        FROM temp.staging_source_manifest
        ORDER BY source_id
      `).all(),
    ).map(mapSourceManifestRow)

    const counts = stagingCountsRowSchema.parse(database.driver.prepare(`
      SELECT
        (SELECT COUNT(*) FROM temp.staging_concept) AS concept_count,
        CASE WHEN EXISTS (
          SELECT 1 FROM temp.staging_laboratory_definition d
          WHERE NOT EXISTS (SELECT 1 FROM temp.staging_concept c WHERE c.concept_id = d.concept_id)
        ) OR EXISTS (
          SELECT 1 FROM temp.staging_laboratory_unit u
          WHERE NOT EXISTS (SELECT 1 FROM temp.staging_concept c WHERE c.concept_id = u.concept_id)
        ) OR EXISTS (
          SELECT 1 FROM temp.staging_laboratory_specimen s
          WHERE NOT EXISTS (SELECT 1 FROM temp.staging_concept c WHERE c.concept_id = s.concept_id)
        ) OR EXISTS (
          SELECT 1 FROM temp.staging_laboratory_panel_member pm
          WHERE NOT EXISTS (SELECT 1 FROM temp.staging_concept c WHERE c.concept_id = pm.panel_concept_id)
             OR NOT EXISTS (SELECT 1 FROM temp.staging_concept c WHERE c.concept_id = pm.member_concept_id)
        ) THEN 1 ELSE 0 END AS has_orphan_laboratory_concept,
        (SELECT COUNT(*) FROM temp.staging_laboratory_definition) AS laboratory_definition_count,
        (SELECT COUNT(*) FROM temp.staging_laboratory_panel_member) AS laboratory_panel_member_count,
        (SELECT COUNT(*) FROM temp.staging_laboratory_specimen) AS laboratory_specimen_count,
        (SELECT COUNT(*) FROM temp.staging_laboratory_unit) AS laboratory_unit_count,
        (SELECT COUNT(*) FROM temp.staging_medication_product) AS medication_product_count,
        (SELECT COUNT(*) FROM temp.staging_medical_service) AS service_count,
        (SELECT COUNT(*) FROM temp.staging_value_set_entry) AS value_set_entry_count
    `).get())
    if (counts.has_orphan_laboratory_concept === 1) {
      throw new Error('FOREIGN KEY constraint failed: reference laboratory concept is missing')
    }

    const hash = computeStreamingReleaseContentHash({
      concepts: streamStagedRows({
        count: counts.concept_count,
        driver: database.driver,
        mapRow: mapConceptRow,
        rowSchema: conceptDatabaseRowSchema,
        sql: `
          SELECT concept_id, domain, system, system_version, code, display, status,
            laboratory_metadata_json, source_id, source_locator
          FROM temp.staging_concept
          ORDER BY source_id, concept_id
        `,
      }),
      laboratoryDefinitions: streamStagedRows({
        count: counts.laboratory_definition_count,
        driver: database.driver,
        mapRow: mapLaboratoryDefinitionRow,
        rowSchema: laboratoryDefinitionDatabaseRowSchema,
        sql: `
          SELECT concept_id, definition_json, source_id, source_locator
          FROM temp.staging_laboratory_definition
          ORDER BY source_id, concept_id
        `,
      }),
      laboratoryPanelMembers: streamStagedRows({
        count: counts.laboratory_panel_member_count,
        driver: database.driver,
        mapRow: mapLaboratoryPanelMemberRow,
        rowSchema: laboratoryPanelMemberDatabaseRowSchema,
        sql: `
          SELECT panel_concept_id, member_concept_id, member_order, relationship,
            source_id, source_locator
          FROM temp.staging_laboratory_panel_member
          ORDER BY source_id, panel_concept_id, member_order, member_concept_id, source_locator
        `,
      }),
      laboratorySpecimens: streamStagedRows({
        count: counts.laboratory_specimen_count,
        driver: database.driver,
        mapRow: mapLaboratorySpecimenRow,
        rowSchema: laboratorySpecimenDatabaseRowSchema,
        sql: `
          SELECT concept_id, part_number, part_name, display, link_type,
            source_id, source_locator
          FROM temp.staging_laboratory_specimen
          ORDER BY source_id, concept_id, part_number, link_type
        `,
      }),
      laboratoryUnits: streamStagedRows({
        count: counts.laboratory_unit_count,
        driver: database.driver,
        mapRow: mapLaboratoryUnitRow,
        rowSchema: laboratoryUnitDatabaseRowSchema,
        sql: `
          SELECT concept_id, code, kind, ordinal, source_id, source_locator
          FROM temp.staging_laboratory_unit
          ORDER BY source_id, concept_id, ordinal, code, source_locator
        `,
      }),
      medicationProducts: streamStagedRows({
        count: counts.medication_product_count,
        driver: database.driver,
        mapRow: mapMedicationProductRow,
        rowSchema: medicationProductDatabaseRowSchema,
        sql: `
          SELECT product_id, system, system_version, code, generic_name, brand_name,
            dosage_form, strength, package_description, manufacturer, approval_number,
            status, source_id, source_locator
          FROM temp.staging_medication_product
          ORDER BY source_id, product_id
        `,
      }),
      release: manifest,
      services: streamStagedRows({
        count: counts.service_count,
        driver: database.driver,
        mapRow: mapMedicalServiceRow,
        rowSchema: medicalServiceDatabaseRowSchema,
        sql: `
          SELECT service_id, system, system_version, code, display, category_code,
            billing_unit_code, status, source_id, source_locator
          FROM temp.staging_medical_service
          ORDER BY source_id, service_id
        `,
      }),
      sources: stagedSources,
      valueSetEntries: streamStagedRows({
        count: counts.value_set_entry_count,
        driver: database.driver,
        mapRow: mapValueSetEntryRow,
        rowSchema: valueSetEntryDatabaseRowSchema,
        sql: `
          SELECT entry_id, value_set, system, system_version, code, display,
            status, source_id, source_locator
          FROM temp.staging_value_set_entry
          ORDER BY source_id, entry_id
        `,
      }),
    })

    const existing = existingReleaseHashRowSchema.parse(
      database.driver.prepare(
        'SELECT content_hash FROM reference_release WHERE release_id = ?',
      ).get(manifest.releaseId),
    )
    if (existing !== undefined) {
      if (existing.content_hash !== hash) {
        throw new Error(`Reference Data Release is immutable: ${manifest.releaseId}`)
      }
      result = {
        conceptCount: counts.concept_count,
        contentHash: hash,
        created: false,
        laboratoryDefinitionCount: counts.laboratory_definition_count,
        laboratoryPanelMemberCount: counts.laboratory_panel_member_count,
        laboratorySpecimenCount: counts.laboratory_specimen_count,
        laboratoryUnitCount: counts.laboratory_unit_count,
        medicationProductCount: counts.medication_product_count,
        releaseId: manifest.releaseId,
        serviceCount: counts.service_count,
        sourceCount: stagedSources.length,
        valueSetEntryCount: counts.value_set_entry_count,
      }
    } else {
      database.driver.exec('BEGIN IMMEDIATE')
      try {
        database.driver.prepare(`
          INSERT INTO reference_release (
            release_id, schema_version, status, created_at, content_hash, source_count,
            concept_count, laboratory_definition_count, laboratory_unit_count,
            laboratory_specimen_count, laboratory_panel_member_count,
            medication_product_count, service_count, value_set_entry_count
          ) VALUES (?, '1', 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          manifest.releaseId,
          manifest.createdAt,
          hash,
          stagedSources.length,
          counts.concept_count,
          counts.laboratory_definition_count,
          counts.laboratory_unit_count,
          counts.laboratory_specimen_count,
          counts.laboratory_panel_member_count,
          counts.medication_product_count,
          counts.service_count,
          counts.value_set_entry_count,
        )
        database.driver.prepare(`
          INSERT INTO reference_source_manifest (
            release_id, source_id, upstream_version, published_at, retrieved_at,
            source_url, checksum, license_id, acquisition_method, artifact_format, record_count,
            import_diagnostics_json, candidate_provenance_json, materialization_json
          )
          SELECT
            ?, source_id, upstream_version, published_at, retrieved_at,
            source_url, checksum, license_id, acquisition_method, artifact_format, record_count,
            import_diagnostics_json, candidate_provenance_json, materialization_json
          FROM temp.staging_source_manifest
          ORDER BY source_id
        `).run(manifest.releaseId)
        if (counts.concept_count > 0) {
          database.driver.prepare(`
            INSERT INTO reference_concept (
              release_id, concept_id, domain, system, system_version, code, display,
              status, source_id, source_locator, laboratory_metadata_json
            )
            SELECT
              ?, concept_id, domain, system, system_version, code, display,
              status, source_id, source_locator, laboratory_metadata_json
            FROM temp.staging_concept
            ORDER BY source_id, concept_id
          `).run(manifest.releaseId)
        }
        if (counts.laboratory_definition_count > 0) {
          database.driver.prepare(`
            INSERT INTO reference_laboratory_definition (
              release_id, concept_id, definition_json, source_id, source_locator
            )
            SELECT ?, concept_id, definition_json, source_id, source_locator
            FROM temp.staging_laboratory_definition
            ORDER BY source_id, concept_id
          `).run(manifest.releaseId)
        }
        if (counts.laboratory_unit_count > 0) {
          database.driver.prepare(`
            INSERT INTO reference_laboratory_unit (
              release_id, concept_id, code, kind, ordinal, source_id, source_locator
            )
            SELECT ?, concept_id, code, kind, ordinal, source_id, source_locator
            FROM temp.staging_laboratory_unit
            ORDER BY source_id, concept_id, ordinal, code, source_locator
          `).run(manifest.releaseId)
        }
        if (counts.laboratory_specimen_count > 0) {
          database.driver.prepare(`
            INSERT INTO reference_laboratory_specimen (
              release_id, concept_id, part_number, part_name, display, link_type,
              source_id, source_locator
            )
            SELECT
              ?, concept_id, part_number, part_name, display, link_type,
              source_id, source_locator
            FROM temp.staging_laboratory_specimen
            ORDER BY source_id, concept_id, part_number, link_type
          `).run(manifest.releaseId)
        }
        if (counts.laboratory_panel_member_count > 0) {
          database.driver.prepare(`
            INSERT INTO reference_laboratory_panel_member (
              release_id, panel_concept_id, member_concept_id, member_order,
              relationship, source_id, source_locator
            )
            SELECT
              ?, panel_concept_id, member_concept_id, member_order,
              relationship, source_id, source_locator
            FROM temp.staging_laboratory_panel_member
            ORDER BY source_id, panel_concept_id, member_order, member_concept_id, source_locator
          `).run(manifest.releaseId)
        }
        if (counts.medication_product_count > 0) {
          database.driver.prepare(`
            INSERT INTO reference_medication_product (
              release_id, product_id, system, system_version, code, generic_name,
              brand_name, dosage_form, strength, package_description, manufacturer,
              approval_number, status, source_id, source_locator
            )
            SELECT
              ?, product_id, system, system_version, code, generic_name,
              brand_name, dosage_form, strength, package_description, manufacturer,
              approval_number, status, source_id, source_locator
            FROM temp.staging_medication_product
            ORDER BY source_id, product_id
          `).run(manifest.releaseId)
        }
        if (counts.service_count > 0) {
          database.driver.prepare(`
            INSERT INTO reference_medical_service (
              release_id, service_id, system, system_version, code, display,
              category_code, billing_unit_code, status, source_id, source_locator
            )
            SELECT
              ?, service_id, system, system_version, code, display,
              category_code, billing_unit_code, status, source_id, source_locator
            FROM temp.staging_medical_service
            ORDER BY source_id, service_id
          `).run(manifest.releaseId)
        }
        if (counts.value_set_entry_count > 0) {
          database.driver.prepare(`
            INSERT INTO reference_value_set_entry (
              release_id, entry_id, value_set, system, system_version, code,
              display, status, source_id, source_locator
            )
            SELECT
              ?, entry_id, value_set, system, system_version, code,
              display, status, source_id, source_locator
            FROM temp.staging_value_set_entry
            ORDER BY source_id, entry_id
          `).run(manifest.releaseId)
        }
        database.driver.exec('COMMIT')
      } catch (error) {
        if (database.driver.inTransaction) database.driver.exec('ROLLBACK')
        throw error
      }

      result = {
        conceptCount: counts.concept_count,
        contentHash: hash,
        created: true,
        laboratoryDefinitionCount: counts.laboratory_definition_count,
        laboratoryPanelMemberCount: counts.laboratory_panel_member_count,
        laboratorySpecimenCount: counts.laboratory_specimen_count,
        laboratoryUnitCount: counts.laboratory_unit_count,
        medicationProductCount: counts.medication_product_count,
        releaseId: manifest.releaseId,
        serviceCount: counts.service_count,
        sourceCount: stagedSources.length,
        valueSetEntryCount: counts.value_set_entry_count,
      }
    }
  } catch (error) {
    primaryError = error
  } finally {
    try {
      database.driver.exec(dropTempStagingTablesSql)
    } catch (error) {
      cleanupError = error
    }
  }
  if (primaryError !== undefined) throw primaryError
  if (cleanupError !== undefined) throw cleanupError
  return result
}

const foreignKeyViolationRowSchema = z.object({
  fkid: z.number().int().nonnegative(),
  parent: z.string(),
  rowid: z.number().int().nullable(),
  table: z.string(),
})

function streamMappedRows<RawRow, Mapped extends { sourceId: string }>(input: {
  acceptedBySource: Map<string, number>
  acceptedWeight?: (row: Mapped) => number
  driver: Database.Database
  mapRow: (row: RawRow) => Mapped
  onCount: () => void
  parameters: readonly unknown[]
  rowSchema: z.ZodType<RawRow>
  sql: string
}): Iterable<Mapped> {
  return {
    * [Symbol.iterator]() {
      const statement = input.driver.prepare(input.sql)
      for (const raw of statement.iterate(...input.parameters)) {
        const mapped = input.mapRow(input.rowSchema.parse(raw))
        input.onCount()
        const weight = input.acceptedWeight === undefined ? 1 : input.acceptedWeight(mapped)
        if (weight > 0) {
          input.acceptedBySource.set(
            mapped.sourceId,
            (input.acceptedBySource.get(mapped.sourceId) ?? 0) + weight,
          )
        }
        yield mapped
      }
    },
  }
}

export function verifyReferenceDatabase(database: ReferenceDatabase): ReferenceDatabaseDiagnostics {
  const migration = verifyReferenceMigrations(database)
  const integrity = String(database.driver.pragma('integrity_check', { simple: true }))
  if (integrity !== 'ok') throw new Error(`Reference database integrity check failed: ${integrity}`)
  const foreignKeyViolations = z.array(foreignKeyViolationRowSchema)
    .parse(database.driver.pragma('foreign_key_check'))
  if (foreignKeyViolations.length > 0) {
    const violation = foreignKeyViolations[0]!
    throw new Error(
      `Reference database foreign key check failed: ${violation.table}->${violation.parent}`,
    )
  }
  verifyOfflineInventories(database)
  const releases = readReferenceDataReleases(database)
  for (const release of releases.items) {
    referenceDataReleaseSummarySchema.parse(release)
    if (release.sourceCount !== release.sources.length) {
      throw new Error(`Reference Data Release source count mismatch: ${release.releaseId}`)
    }
    const counts = {
      conceptCount: 0,
      laboratoryDefinitionCount: 0,
      laboratoryPanelMemberCount: 0,
      laboratorySpecimenCount: 0,
      laboratoryUnitCount: 0,
      medicationProductCount: 0,
      serviceCount: 0,
      valueSetEntryCount: 0,
    }
    const acceptedCountBySource = new Map<string, number>()

    const actualHash = computeStreamingReleaseContentHash({
      concepts: streamMappedRows({
        acceptedBySource: acceptedCountBySource,
        driver: database.driver,
        mapRow: mapConceptRow,
        onCount: () => { counts.conceptCount += 1 },
        parameters: [release.releaseId],
        rowSchema: conceptDatabaseRowSchema,
        sql: `
          SELECT concept_id, domain, system, system_version, code, display, status,
            laboratory_metadata_json, source_id, source_locator
          FROM reference_concept
          WHERE release_id = ?
          ORDER BY source_id, concept_id
        `,
      }),
      laboratoryDefinitions: streamMappedRows({
        acceptedBySource: acceptedCountBySource,
        acceptedWeight: definition => (
          definition.kind === 'laboratory-cn-test'
            ? definition.adultReferenceRules.length
            : 0
        ),
        driver: database.driver,
        mapRow: mapLaboratoryDefinitionRow,
        onCount: () => { counts.laboratoryDefinitionCount += 1 },
        parameters: [release.releaseId],
        rowSchema: laboratoryDefinitionDatabaseRowSchema,
        sql: `
          SELECT concept_id, definition_json, source_id, source_locator
          FROM reference_laboratory_definition
          WHERE release_id = ?
          ORDER BY source_id, concept_id
        `,
      }),
      laboratoryPanelMembers: streamMappedRows({
        acceptedBySource: acceptedCountBySource,
        driver: database.driver,
        mapRow: mapLaboratoryPanelMemberRow,
        onCount: () => { counts.laboratoryPanelMemberCount += 1 },
        parameters: [release.releaseId],
        rowSchema: laboratoryPanelMemberDatabaseRowSchema,
        sql: `
          SELECT panel_concept_id, member_concept_id, member_order, relationship,
            source_id, source_locator
          FROM reference_laboratory_panel_member
          WHERE release_id = ?
          ORDER BY source_id, panel_concept_id, member_order, member_concept_id, source_locator
        `,
      }),
      laboratorySpecimens: streamMappedRows({
        acceptedBySource: acceptedCountBySource,
        driver: database.driver,
        mapRow: mapLaboratorySpecimenRow,
        onCount: () => { counts.laboratorySpecimenCount += 1 },
        parameters: [release.releaseId],
        rowSchema: laboratorySpecimenDatabaseRowSchema,
        sql: `
          SELECT concept_id, part_number, part_name, display, link_type,
            source_id, source_locator
          FROM reference_laboratory_specimen
          WHERE release_id = ?
          ORDER BY source_id, concept_id, part_number, link_type
        `,
      }),
      laboratoryUnits: streamMappedRows({
        acceptedBySource: acceptedCountBySource,
        driver: database.driver,
        mapRow: mapLaboratoryUnitRow,
        onCount: () => { counts.laboratoryUnitCount += 1 },
        parameters: [release.releaseId],
        rowSchema: laboratoryUnitDatabaseRowSchema,
        sql: `
          SELECT concept_id, code, kind, ordinal, source_id, source_locator
          FROM reference_laboratory_unit
          WHERE release_id = ?
          ORDER BY source_id, concept_id, ordinal, code, source_locator
        `,
      }),
      medicationProducts: streamMappedRows({
        acceptedBySource: acceptedCountBySource,
        driver: database.driver,
        mapRow: mapMedicationProductRow,
        onCount: () => { counts.medicationProductCount += 1 },
        parameters: [release.releaseId],
        rowSchema: medicationProductDatabaseRowSchema,
        sql: `
          SELECT product_id, system, system_version, code, generic_name, brand_name,
            dosage_form, strength, package_description, manufacturer, approval_number,
            status, source_id, source_locator
          FROM reference_medication_product
          WHERE release_id = ?
          ORDER BY source_id, product_id
        `,
      }),
      release,
      services: streamMappedRows({
        acceptedBySource: acceptedCountBySource,
        driver: database.driver,
        mapRow: mapMedicalServiceRow,
        onCount: () => { counts.serviceCount += 1 },
        parameters: [release.releaseId],
        rowSchema: medicalServiceDatabaseRowSchema,
        sql: `
          SELECT service_id, system, system_version, code, display, category_code,
            billing_unit_code, status, source_id, source_locator
          FROM reference_medical_service
          WHERE release_id = ?
          ORDER BY source_id, service_id
        `,
      }),
      sources: release.sources,
      valueSetEntries: streamMappedRows({
        acceptedBySource: acceptedCountBySource,
        driver: database.driver,
        mapRow: mapValueSetEntryRow,
        onCount: () => { counts.valueSetEntryCount += 1 },
        parameters: [release.releaseId],
        rowSchema: valueSetEntryDatabaseRowSchema,
        sql: `
          SELECT entry_id, value_set, system, system_version, code, display,
            status, source_id, source_locator
          FROM reference_value_set_entry
          WHERE release_id = ?
          ORDER BY source_id, entry_id
        `,
      }),
    })

    if (release.conceptCount !== counts.conceptCount) {
      throw new Error(`Reference Data Release concept count mismatch: ${release.releaseId}`)
    }
    if (release.medicationProductCount !== counts.medicationProductCount) {
      throw new Error(`Reference Data Release medication product count mismatch: ${release.releaseId}`)
    }
    if (release.laboratoryDefinitionCount !== counts.laboratoryDefinitionCount) {
      throw new Error(`Reference Data Release laboratory definition count mismatch: ${release.releaseId}`)
    }
    if (release.laboratoryPanelMemberCount !== counts.laboratoryPanelMemberCount) {
      throw new Error(`Reference Data Release laboratory panel member count mismatch: ${release.releaseId}`)
    }
    if (release.laboratorySpecimenCount !== counts.laboratorySpecimenCount) {
      throw new Error(`Reference Data Release laboratory specimen count mismatch: ${release.releaseId}`)
    }
    if (release.laboratoryUnitCount !== counts.laboratoryUnitCount) {
      throw new Error(`Reference Data Release laboratory unit count mismatch: ${release.releaseId}`)
    }
    if (release.serviceCount !== counts.serviceCount) {
      throw new Error(`Reference Data Release service count mismatch: ${release.releaseId}`)
    }
    if (release.valueSetEntryCount !== counts.valueSetEntryCount) {
      throw new Error(`Reference Data Release value set entry count mismatch: ${release.releaseId}`)
    }
    for (const source of release.sources) {
      if ((acceptedCountBySource.get(source.sourceId) ?? 0) !== source.importDiagnostics.acceptedCount) {
        throw new Error(`Reference source accepted count mismatch: ${release.releaseId}/${source.sourceId}`)
      }
    }
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
