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
  referenceLaboratoryDefinitionSchema,
  referenceLaboratoryPanelMemberSchema,
  referenceLaboratorySpecimenSchema,
  referenceLaboratoryUnitSchema,
  referenceMedicationProductSchema,
  type ReferenceArtifact,
  type ReferenceConcept,
  type ReferenceDataReleaseList,
  type ReferenceDataReleaseSummary,
  type ReferenceImportManifest,
  type ReferenceLaboratoryDefinition,
  type ReferenceLaboratoryPanelMember,
  type ReferenceLaboratoryRecord,
  type ReferenceLaboratorySpecimen,
  type ReferenceLaboratoryUnit,
  type ReferenceMedicalService,
  type ReferenceMedicationProduct,
  type ReferenceSourceManifest,
  type ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { parseReferenceSourceArtifact } from '../reference-data/reference-source-importers.ts'
import {
  parseCnHealthCandidateReferenceArtifact,
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
  laboratoryDefinitions: SourcedLaboratoryDefinition[]
  laboratoryPanelMembers: SourcedLaboratoryPanelMember[]
  laboratorySpecimens: SourcedLaboratorySpecimen[]
  laboratoryUnits: SourcedLaboratoryUnit[]
  medicationProducts: Array<ReferenceMedicationProduct & { sourceId: string }>
  release: Pick<ReferenceImportManifest, 'createdAt' | 'releaseId' | 'schemaVersion'>
  services: Array<ReferenceMedicalService & { sourceId: string }>
  sources: ReferenceSourceManifest[]
  valueSetEntries: Array<ReferenceValueSetEntry & { sourceId: string }>
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
    ...(input.medicationProducts.length === 0 ? {} : {
      medicationProducts: input.medicationProducts.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId) || left.id.localeCompare(right.id)
      )),
    }),
    ...(input.laboratoryDefinitions.length === 0 ? {} : {
      laboratoryDefinitions: input.laboratoryDefinitions.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId) || left.conceptId.localeCompare(right.conceptId)
      )),
    }),
    ...(input.laboratoryUnits.length === 0 ? {} : {
      laboratoryUnits: input.laboratoryUnits.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId)
        || left.conceptId.localeCompare(right.conceptId)
        || left.sourceLocator.localeCompare(right.sourceLocator)
      )),
    }),
    ...(input.laboratorySpecimens.length === 0 ? {} : {
      laboratorySpecimens: input.laboratorySpecimens.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId)
        || left.conceptId.localeCompare(right.conceptId)
        || left.partNumber.localeCompare(right.partNumber)
      )),
    }),
    ...(input.laboratoryPanelMembers.length === 0 ? {} : {
      laboratoryPanelMembers: input.laboratoryPanelMembers.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId)
        || left.panelConceptId.localeCompare(right.panelConceptId)
        || left.memberOrder - right.memberOrder
        || left.memberConceptId.localeCompare(right.memberConceptId)
        || left.sourceLocator.localeCompare(right.sourceLocator)
      )),
    }),
    ...(input.services.length === 0 ? {} : {
      services: input.services.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId) || left.id.localeCompare(right.id)
      )),
    }),
    ...(input.valueSetEntries.length === 0 ? {} : {
      valueSetEntries: input.valueSetEntries.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId) || left.id.localeCompare(right.id)
      )),
    }),
  })))
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
    candidate_provenance_json: z.string().nullable(),
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
      import_diagnostics_json, candidate_provenance_json
    FROM reference_source_manifest
    WHERE release_id = ?
    ORDER BY source_id
  `).all(releaseId)).map(row => ({
    acquisitionMethod: row.acquisition_method,
    artifactFormat: row.artifact_format,
    ...(row.candidate_provenance_json === null
      ? {}
      : { candidate: JSON.parse(row.candidate_provenance_json) }),
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

function mapConceptRow(row: z.infer<typeof conceptDatabaseRowSchema>) {
  return {
    ...referenceArtifactSchema.shape.concepts.element.parse({
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

function conceptRows(
  database: ReferenceDatabase,
  releaseId: string,
): Array<ReferenceConcept & { sourceId: string }> {
  return z.array(conceptDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT concept_id, domain, system, system_version, code, display, status,
      laboratory_metadata_json,
      source_id, source_locator
    FROM reference_concept
    WHERE release_id = ?
    ORDER BY source_id, concept_id
  `).all(releaseId)).map(mapConceptRow)
}

function laboratoryDefinitionRows(
  database: ReferenceDatabase,
  releaseId: string,
  conceptId?: string,
): SourcedLaboratoryDefinition[] {
  const parameters = conceptId === undefined ? [releaseId] : [releaseId, conceptId]
  return z.array(z.object({
    class_code: z.string().nullable(),
    class_type: z.number().int().nullable(),
    component: z.string().nullable(),
    concept_id: z.string(),
    method_type: z.string().nullable(),
    order_observation: z.string().nullable(),
    panel_type: z.string().nullable(),
    property: z.string().nullable(),
    scale_type: z.string().nullable(),
    source_id: z.string(),
    source_locator: z.string(),
    system_part: z.string().nullable(),
    time_aspect: z.string().nullable(),
  }).strict()).parse(database.driver.prepare(`
    SELECT concept_id, component, property, time_aspect, system_part, scale_type,
      method_type, class_code, class_type, order_observation, panel_type,
      source_id, source_locator
    FROM reference_laboratory_definition
    WHERE release_id = ?
      ${conceptId === undefined ? '' : 'AND concept_id = ?'}
    ORDER BY source_id, concept_id
  `).all(...parameters)).map(row => ({
    ...referenceLaboratoryDefinitionSchema.parse({
      classCode: row.class_code,
      classType: row.class_type,
      component: row.component,
      conceptId: row.concept_id,
      methodType: row.method_type,
      orderObservation: row.order_observation,
      panelType: row.panel_type,
      property: row.property,
      scaleType: row.scale_type,
      sourceLocator: row.source_locator,
      system: row.system_part,
      timeAspect: row.time_aspect,
    }),
    sourceId: row.source_id,
  }))
}

function laboratoryUnitRows(
  database: ReferenceDatabase,
  releaseId: string,
  conceptId?: string,
): SourcedLaboratoryUnit[] {
  const parameters = conceptId === undefined ? [releaseId] : [releaseId, conceptId]
  return z.array(z.object({
    code: z.string(),
    concept_id: z.string(),
    kind: z.string(),
    ordinal: z.number().int(),
    source_id: z.string(),
    source_locator: z.string(),
  }).strict()).parse(database.driver.prepare(`
    SELECT concept_id, code, kind, ordinal, source_id, source_locator
    FROM reference_laboratory_unit
    WHERE release_id = ?
      ${conceptId === undefined ? '' : 'AND concept_id = ?'}
    ORDER BY source_id, concept_id, ordinal, code, source_locator
  `).all(...parameters)).map(row => ({
    ...referenceLaboratoryUnitSchema.parse({
      code: row.code,
      conceptId: row.concept_id,
      kind: row.kind,
      ordinal: row.ordinal,
      sourceLocator: row.source_locator,
    }),
    sourceId: row.source_id,
  }))
}

function laboratorySpecimenRows(
  database: ReferenceDatabase,
  releaseId: string,
  conceptId?: string,
): SourcedLaboratorySpecimen[] {
  const parameters = conceptId === undefined ? [releaseId] : [releaseId, conceptId]
  return z.array(z.object({
    concept_id: z.string(),
    display: z.string(),
    link_type: z.string(),
    part_name: z.string(),
    part_number: z.string(),
    source_id: z.string(),
    source_locator: z.string(),
  }).strict()).parse(database.driver.prepare(`
    SELECT concept_id, part_number, part_name, display, link_type,
      source_id, source_locator
    FROM reference_laboratory_specimen
    WHERE release_id = ?
      ${conceptId === undefined ? '' : 'AND concept_id = ?'}
    ORDER BY source_id, concept_id, part_number, link_type
  `).all(...parameters)).map(row => ({
    ...referenceLaboratorySpecimenSchema.parse({
      conceptId: row.concept_id,
      display: row.display,
      linkType: row.link_type,
      partName: row.part_name,
      partNumber: row.part_number,
      sourceLocator: row.source_locator,
    }),
    sourceId: row.source_id,
  }))
}

function laboratoryPanelMemberRows(
  database: ReferenceDatabase,
  releaseId: string,
  panelConceptId?: string,
): SourcedLaboratoryPanelMember[] {
  const parameters = panelConceptId === undefined ? [releaseId] : [releaseId, panelConceptId]
  return z.array(z.object({
    member_concept_id: z.string(),
    member_order: z.number().int(),
    panel_concept_id: z.string(),
    relationship: z.string(),
    source_id: z.string(),
    source_locator: z.string(),
  }).strict()).parse(database.driver.prepare(`
    SELECT panel_concept_id, member_concept_id, member_order, relationship,
      source_id, source_locator
    FROM reference_laboratory_panel_member
    WHERE release_id = ?
      ${panelConceptId === undefined ? '' : 'AND panel_concept_id = ?'}
    ORDER BY source_id, panel_concept_id, member_order, member_concept_id, source_locator
  `).all(...parameters)).map(row => ({
    ...referenceLaboratoryPanelMemberSchema.parse({
      memberConceptId: row.member_concept_id,
      memberOrder: row.member_order,
      panelConceptId: row.panel_concept_id,
      relationship: row.relationship,
      sourceLocator: row.source_locator,
    }),
    sourceId: row.source_id,
  }))
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

function mapMedicationProductRow(row: z.infer<typeof medicationProductDatabaseRowSchema>) {
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
  `).all(releaseId)).map(mapMedicationProductRow) as Array<
    ReferenceMedicationProduct & { sourceId: string }
  >
}

function medicalServiceRows(
  database: ReferenceDatabase,
  releaseId: string,
): Array<ReferenceMedicalService & { sourceId: string }> {
  return z.array(z.object({
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
  })).parse(database.driver.prepare(`
    SELECT service_id, system, system_version, code, display, category_code,
      billing_unit_code, status, source_id, source_locator
    FROM reference_medical_service
    WHERE release_id = ?
    ORDER BY source_id, service_id
  `).all(releaseId)).map(row => ({
    billingUnitCode: row.billing_unit_code,
    categoryCode: row.category_code,
    code: row.code,
    display: row.display,
    id: row.service_id,
    sourceId: row.source_id,
    sourceLocator: row.source_locator,
    status: row.status,
    system: row.system,
    version: row.system_version,
  })) as Array<ReferenceMedicalService & { sourceId: string }>
}

function valueSetEntryRows(
  database: ReferenceDatabase,
  releaseId: string,
): Array<ReferenceValueSetEntry & { sourceId: string }> {
  return z.array(z.object({
    code: z.string(),
    display: z.string(),
    entry_id: z.string(),
    source_id: z.string(),
    source_locator: z.string(),
    status: z.string(),
    system: z.string(),
    system_version: z.string(),
    value_set: z.string(),
  })).parse(database.driver.prepare(`
    SELECT entry_id, value_set, system, system_version, code, display,
      status, source_id, source_locator
    FROM reference_value_set_entry
    WHERE release_id = ?
    ORDER BY source_id, entry_id
  `).all(releaseId)).map(row => ({
    code: row.code,
    display: row.display,
    id: row.entry_id,
    sourceId: row.source_id,
    sourceLocator: row.source_locator,
    status: row.status,
    system: row.system,
    valueSet: row.value_set,
    version: row.system_version,
  })) as Array<ReferenceValueSetEntry & { sourceId: string }>
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
  if (input.query.length < 3) {
    const total = countSchema.parse(database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM reference_concept
      WHERE release_id = ? AND domain = ?
        AND (
          instr(lower(display), lower(?)) > 0
          OR instr(lower(code), lower(?)) > 0
        )
    `).get(releaseId, domain, input.query, input.query)).count
    const rows = z.array(conceptDatabaseRowSchema).parse(database.driver.prepare(`
      SELECT concept_id, domain, system, system_version, code, display, status,
        laboratory_metadata_json, source_id, source_locator
      FROM reference_concept
      WHERE release_id = ? AND domain = ?
        AND (
          instr(lower(display), lower(?)) > 0
          OR instr(lower(code), lower(?)) > 0
        )
      ORDER BY display, code, concept_id
      LIMIT ? OFFSET ?
    `).all(releaseId, domain, input.query, input.query, input.pageSize, offset))
    return {
      items: rows.map(mapConceptRow).map(({ sourceId: _sourceId, ...concept }) => concept),
      total,
    }
  }
  const match = ftsPhrase(input.query)
  const total = countSchema.parse(database.driver.prepare(`
    SELECT COUNT(*) AS count
    FROM reference_concept
    JOIN reference_concept_fts ON reference_concept_fts.rowid = reference_concept.rowid
    WHERE reference_concept.release_id = ? AND reference_concept.domain = ?
      AND reference_concept_fts MATCH ?
  `).get(releaseId, domain, match)).count
  const rows = z.array(conceptDatabaseRowSchema).parse(database.driver.prepare(`
    SELECT reference_concept.concept_id, reference_concept.domain,
      reference_concept.system, reference_concept.system_version,
      reference_concept.code, reference_concept.display, reference_concept.status,
      reference_concept.laboratory_metadata_json,
      reference_concept.source_id, reference_concept.source_locator
    FROM reference_concept
    JOIN reference_concept_fts ON reference_concept_fts.rowid = reference_concept.rowid
    WHERE reference_concept.release_id = ? AND reference_concept.domain = ?
      AND reference_concept_fts MATCH ?
    ORDER BY reference_concept.display, reference_concept.code, reference_concept.concept_id
    LIMIT ? OFFSET ?
  `).all(releaseId, domain, match, input.pageSize, offset))
  return {
    items: rows.map(mapConceptRow).map(({ sourceId: _sourceId, ...concept }) => concept),
    total,
  }
}

export function searchReferenceLaboratoryRecords(
  database: ReferenceDatabase,
  releaseId: string,
  input: ReferenceCatalogSearchInput,
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
      AND reference_laboratory_definition.class_type = 1
      AND reference_laboratory_definition.order_observation IN ('Order', 'Both')
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
  if (input.query.length < 3) {
    const total = countSchema.parse(database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM reference_medication_product
      WHERE release_id = ?
        AND (
          instr(lower(generic_name), lower(?)) > 0
          OR instr(lower(COALESCE(brand_name, '')), lower(?)) > 0
          OR instr(lower(manufacturer), lower(?)) > 0
          OR instr(lower(code), lower(?)) > 0
        )
    `).get(
      releaseId,
      input.query,
      input.query,
      input.query,
      input.query,
    )).count
    const rows = z.array(medicationProductDatabaseRowSchema).parse(database.driver.prepare(`
      SELECT product_id, system, system_version, code, generic_name, brand_name,
        dosage_form, strength, package_description, manufacturer, approval_number,
        status, source_id, source_locator
      FROM reference_medication_product
      WHERE release_id = ?
        AND (
          instr(lower(generic_name), lower(?)) > 0
          OR instr(lower(COALESCE(brand_name, '')), lower(?)) > 0
          OR instr(lower(manufacturer), lower(?)) > 0
          OR instr(lower(code), lower(?)) > 0
        )
      ORDER BY generic_name, code, product_id
      LIMIT ? OFFSET ?
    `).all(
      releaseId,
      input.query,
      input.query,
      input.query,
      input.query,
      input.pageSize,
      offset,
    ))
    return {
      items: rows.map(mapMedicationProductRow).map(({ sourceId: _sourceId, ...product }) => product),
      total,
    }
  }
  const match = ftsPhrase(input.query)
  const total = countSchema.parse(database.driver.prepare(`
    SELECT COUNT(*) AS count
    FROM reference_medication_product
    JOIN reference_medication_product_fts
      ON reference_medication_product_fts.rowid = reference_medication_product.rowid
    WHERE reference_medication_product.release_id = ?
      AND reference_medication_product_fts MATCH ?
  `).get(releaseId, match)).count
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
    FROM reference_medication_product
    JOIN reference_medication_product_fts
      ON reference_medication_product_fts.rowid = reference_medication_product.rowid
    WHERE reference_medication_product.release_id = ?
      AND reference_medication_product_fts MATCH ?
    ORDER BY reference_medication_product.generic_name,
      reference_medication_product.code, reference_medication_product.product_id
    LIMIT ? OFFSET ?
  `).all(releaseId, match, input.pageSize, offset))
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

function readReferenceDataReleases(database: ReferenceDatabase): ReferenceDataReleaseList {
  const rows = z.array(z.object({
    concept_count: z.number().int(),
    content_hash: z.string(),
    created_at: z.string(),
    laboratory_definition_count: z.number().int(),
    laboratory_panel_member_count: z.number().int(),
    laboratory_specimen_count: z.number().int(),
    laboratory_unit_count: z.number().int(),
    release_id: z.string(),
    medication_product_count: z.number().int(),
    service_count: z.number().int(),
    schema_version: z.string(),
    source_count: z.number().int(),
    status: z.string(),
    value_set_entry_count: z.number().int(),
  })).parse(database.driver.prepare(`
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

export function importReferenceDataRelease(
  database: ReferenceDatabase,
  manifestPath: string,
): ReferenceImportResult {
  verifyReferenceMigrations(database)
  const manifest = referenceImportManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const manifestDirectory = dirname(resolve(manifestPath))
  const sources: ReferenceSourceManifest[] = []
  const concepts: Array<ReferenceConcept & { sourceId: string }> = []
  const laboratoryDefinitions: SourcedLaboratoryDefinition[] = []
  const laboratoryPanelMembers: SourcedLaboratoryPanelMember[] = []
  const laboratorySpecimens: SourcedLaboratorySpecimen[] = []
  const laboratoryUnits: SourcedLaboratoryUnit[] = []
  const medicationProducts: Array<ReferenceMedicationProduct & { sourceId: string }> = []
  const services: Array<ReferenceMedicalService & { sourceId: string }> = []
  const valueSetEntries: Array<ReferenceValueSetEntry & { sourceId: string }> = []
  for (const source of manifest.sources) {
    const artifactPath = resolve(manifestDirectory, source.artifactPath)
    const artifactBytes = readFileSync(artifactPath)
    const actualChecksum = checksum(artifactBytes)
    if (actualChecksum !== source.checksum) {
      throw new Error(`Reference source checksum mismatch: ${source.sourceId}`)
    }
    let candidate: ReturnType<typeof parseCnHealthCandidateReferenceArtifact> | undefined
    let artifact: ReferenceArtifact
    if (source.artifactFormat === 'cn-health-candidate') {
      candidate = parseCnHealthCandidateReferenceArtifact(artifactPath)
      if (candidate.provenance.releaseId !== source.upstreamVersion) {
        throw new Error(`Reference source version does not match Candidate: ${source.sourceId}`)
      }
      artifact = candidate.artifact
    } else {
      artifact = parseReferenceSourceArtifact({
        content: artifactBytes.toString('utf8'),
        format: source.artifactFormat,
        version: source.upstreamVersion,
      })
    }
    sources.push({
      acquisitionMethod: source.acquisitionMethod,
      artifactFormat: source.artifactFormat,
      ...(candidate === undefined ? {} : { candidate: candidate.provenance }),
      checksum: actualChecksum,
      licenseId: source.licenseId,
      ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
      importDiagnostics: {
        acceptedCount: artifact.concepts.length
          + artifact.laboratoryPanelMembers.length
          + artifact.laboratorySpecimens.length
          + artifact.laboratoryUnits.length
          + artifact.medicationProducts.length
          + artifact.services.length
          + artifact.valueSetEntries.length,
        rejectedCount: 0,
        warnings: [],
      },
      recordCount: artifact.concepts.length
        + artifact.laboratoryPanelMembers.length
        + artifact.laboratorySpecimens.length
        + artifact.laboratoryUnits.length
        + artifact.medicationProducts.length
        + artifact.services.length
        + artifact.valueSetEntries.length,
      retrievedAt: source.retrievedAt,
      sourceId: source.sourceId,
      sourceUrl: source.sourceUrl,
      upstreamVersion: source.upstreamVersion,
    })
    for (const concept of artifact.concepts) {
      concepts.push({ ...concept, sourceId: source.sourceId })
    }
    for (const definition of artifact.laboratoryDefinitions) {
      laboratoryDefinitions.push({ ...definition, sourceId: source.sourceId })
    }
    for (const member of artifact.laboratoryPanelMembers) {
      laboratoryPanelMembers.push({ ...member, sourceId: source.sourceId })
    }
    for (const specimen of artifact.laboratorySpecimens) {
      laboratorySpecimens.push({ ...specimen, sourceId: source.sourceId })
    }
    for (const unit of artifact.laboratoryUnits) {
      laboratoryUnits.push({ ...unit, sourceId: source.sourceId })
    }
    for (const product of artifact.medicationProducts) {
      medicationProducts.push({ ...product, sourceId: source.sourceId })
    }
    for (const service of artifact.services) {
      services.push({ ...service, sourceId: source.sourceId })
    }
    for (const entry of artifact.valueSetEntries) {
      valueSetEntries.push({ ...entry, sourceId: source.sourceId })
    }
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
  const seenProductIds = new Set<string>()
  const seenProductCodes = new Set<string>()
  for (const product of medicationProducts) {
    if (seenProductIds.has(product.id)) throw new Error(`Reference medication product ID was repeated: ${product.id}`)
    seenProductIds.add(product.id)
    const codingKey = referenceCodingIdentity(product)
    if (seenProductCodes.has(codingKey)) {
      throw new Error(`Reference medication product coding was repeated: ${product.system}|${product.version}|${product.code}`)
    }
    seenProductCodes.add(codingKey)
  }
  for (const [label, entries] of [
    ['medical service', services],
    ['value set entry', valueSetEntries],
  ] as const) {
    const ids = new Set<string>()
    const codes = new Set<string>()
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new Error(`Reference ${label} ID was repeated: ${entry.id}`)
      ids.add(entry.id)
      const codingKey = referenceCodingIdentity(entry)
      if (codes.has(codingKey)) {
        throw new Error(`Reference ${label} coding was repeated: ${entry.system}|${entry.version}|${entry.code}`)
      }
      codes.add(codingKey)
    }
  }
  const hash = contentHash({
    concepts,
    laboratoryDefinitions,
    laboratoryPanelMembers,
    laboratorySpecimens,
    laboratoryUnits,
    medicationProducts,
    release: manifest,
    services,
    sources,
    valueSetEntries,
  })
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
      laboratoryDefinitionCount: laboratoryDefinitions.length,
      laboratoryPanelMemberCount: laboratoryPanelMembers.length,
      laboratorySpecimenCount: laboratorySpecimens.length,
      laboratoryUnitCount: laboratoryUnits.length,
      medicationProductCount: medicationProducts.length,
      releaseId: manifest.releaseId,
      serviceCount: services.length,
      sourceCount: sources.length,
      valueSetEntryCount: valueSetEntries.length,
    }
  }

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
      sources.length,
      concepts.length,
      laboratoryDefinitions.length,
      laboratoryUnits.length,
      laboratorySpecimens.length,
      laboratoryPanelMembers.length,
      medicationProducts.length,
      services.length,
      valueSetEntries.length,
    )
    const insertSource = database.driver.prepare(`
      INSERT INTO reference_source_manifest (
        release_id, source_id, upstream_version, published_at, retrieved_at,
        source_url, checksum, license_id, acquisition_method, artifact_format, record_count,
        import_diagnostics_json, candidate_provenance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        source.candidate === undefined ? null : JSON.stringify(source.candidate),
      )
    }
    const insertConcept = database.driver.prepare(`
      INSERT INTO reference_concept (
        release_id, concept_id, domain, system, system_version, code, display,
        status, source_id, source_locator, laboratory_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        concept.laboratory === undefined ? null : JSON.stringify(concept.laboratory),
      )
    }
    const insertLaboratoryDefinition = database.driver.prepare(`
      INSERT INTO reference_laboratory_definition (
        release_id, concept_id, component, property, time_aspect, system_part,
        scale_type, method_type, class_code, class_type, order_observation,
        panel_type, source_id, source_locator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const definition of laboratoryDefinitions) {
      insertLaboratoryDefinition.run(
        manifest.releaseId,
        definition.conceptId,
        definition.component,
        definition.property,
        definition.timeAspect,
        definition.system,
        definition.scaleType,
        definition.methodType,
        definition.classCode,
        definition.classType,
        definition.orderObservation,
        definition.panelType,
        definition.sourceId,
        definition.sourceLocator,
      )
    }
    const insertLaboratoryUnit = database.driver.prepare(`
      INSERT INTO reference_laboratory_unit (
        release_id, concept_id, code, kind, ordinal, source_id, source_locator
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const unit of laboratoryUnits) {
      insertLaboratoryUnit.run(
        manifest.releaseId,
        unit.conceptId,
        unit.code,
        unit.kind,
        unit.ordinal,
        unit.sourceId,
        unit.sourceLocator,
      )
    }
    const insertLaboratorySpecimen = database.driver.prepare(`
      INSERT INTO reference_laboratory_specimen (
        release_id, concept_id, part_number, part_name, display, link_type,
        source_id, source_locator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const specimen of laboratorySpecimens) {
      insertLaboratorySpecimen.run(
        manifest.releaseId,
        specimen.conceptId,
        specimen.partNumber,
        specimen.partName,
        specimen.display,
        specimen.linkType,
        specimen.sourceId,
        specimen.sourceLocator,
      )
    }
    const insertLaboratoryPanelMember = database.driver.prepare(`
      INSERT INTO reference_laboratory_panel_member (
        release_id, panel_concept_id, member_concept_id, member_order,
        relationship, source_id, source_locator
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const member of laboratoryPanelMembers) {
      insertLaboratoryPanelMember.run(
        manifest.releaseId,
        member.panelConceptId,
        member.memberConceptId,
        member.memberOrder,
        member.relationship,
        member.sourceId,
        member.sourceLocator,
      )
    }
    const insertMedicationProduct = database.driver.prepare(`
      INSERT INTO reference_medication_product (
        release_id, product_id, system, system_version, code, generic_name,
        brand_name, dosage_form, strength, package_description, manufacturer,
        approval_number, status, source_id, source_locator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const product of medicationProducts) {
      insertMedicationProduct.run(
        manifest.releaseId,
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
        product.sourceId,
        product.sourceLocator,
      )
    }
    const insertService = database.driver.prepare(`
      INSERT INTO reference_medical_service (
        release_id, service_id, system, system_version, code, display,
        category_code, billing_unit_code, status, source_id, source_locator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const service of services) {
      insertService.run(
        manifest.releaseId,
        service.id,
        service.system,
        service.version,
        service.code,
        service.display,
        service.categoryCode,
        service.billingUnitCode,
        service.status,
        service.sourceId,
        service.sourceLocator,
      )
    }
    const insertValueSetEntry = database.driver.prepare(`
      INSERT INTO reference_value_set_entry (
        release_id, entry_id, value_set, system, system_version, code,
        display, status, source_id, source_locator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const entry of valueSetEntries) {
      insertValueSetEntry.run(
        manifest.releaseId,
        entry.id,
        entry.valueSet,
        entry.system,
        entry.version,
        entry.code,
        entry.display,
        entry.status,
        entry.sourceId,
        entry.sourceLocator,
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
    laboratoryDefinitionCount: laboratoryDefinitions.length,
    laboratoryPanelMemberCount: laboratoryPanelMembers.length,
    laboratorySpecimenCount: laboratorySpecimens.length,
    laboratoryUnitCount: laboratoryUnits.length,
    medicationProductCount: medicationProducts.length,
    releaseId: manifest.releaseId,
    serviceCount: services.length,
    sourceCount: sources.length,
    valueSetEntryCount: valueSetEntries.length,
  }
}

export function verifyReferenceDatabase(database: ReferenceDatabase): ReferenceDatabaseDiagnostics {
  const migration = verifyReferenceMigrations(database)
  const integrity = String(database.driver.pragma('integrity_check', { simple: true }))
  if (integrity !== 'ok') throw new Error(`Reference database integrity check failed: ${integrity}`)
  const foreignKeyViolations = z.array(z.object({
    fkid: z.number().int().nonnegative(),
    parent: z.string(),
    rowid: z.number().int().nullable(),
    table: z.string(),
  })).parse(database.driver.pragma('foreign_key_check'))
  if (foreignKeyViolations.length > 0) {
    const violation = foreignKeyViolations[0]!
    throw new Error(
      `Reference database foreign key check failed: ${violation.table}->${violation.parent}`,
    )
  }
  const releases = readReferenceDataReleases(database)
  for (const release of releases.items) {
    referenceDataReleaseSummarySchema.parse(release)
    const concepts = conceptRows(database, release.releaseId)
    const laboratoryDefinitions = laboratoryDefinitionRows(database, release.releaseId)
    const laboratoryPanelMembers = laboratoryPanelMemberRows(database, release.releaseId)
    const laboratorySpecimens = laboratorySpecimenRows(database, release.releaseId)
    const laboratoryUnits = laboratoryUnitRows(database, release.releaseId)
    const medicationProducts = medicationProductRows(database, release.releaseId)
    const services = medicalServiceRows(database, release.releaseId)
    const valueSetEntries = valueSetEntryRows(database, release.releaseId)
    if (release.sourceCount !== release.sources.length) {
      throw new Error(`Reference Data Release source count mismatch: ${release.releaseId}`)
    }
    if (release.conceptCount !== concepts.length) {
      throw new Error(`Reference Data Release concept count mismatch: ${release.releaseId}`)
    }
    if (release.medicationProductCount !== medicationProducts.length) {
      throw new Error(`Reference Data Release medication product count mismatch: ${release.releaseId}`)
    }
    if (release.laboratoryDefinitionCount !== laboratoryDefinitions.length) {
      throw new Error(`Reference Data Release laboratory definition count mismatch: ${release.releaseId}`)
    }
    if (release.laboratoryPanelMemberCount !== laboratoryPanelMembers.length) {
      throw new Error(`Reference Data Release laboratory panel member count mismatch: ${release.releaseId}`)
    }
    if (release.laboratorySpecimenCount !== laboratorySpecimens.length) {
      throw new Error(`Reference Data Release laboratory specimen count mismatch: ${release.releaseId}`)
    }
    if (release.laboratoryUnitCount !== laboratoryUnits.length) {
      throw new Error(`Reference Data Release laboratory unit count mismatch: ${release.releaseId}`)
    }
    if (release.serviceCount !== services.length) {
      throw new Error(`Reference Data Release service count mismatch: ${release.releaseId}`)
    }
    if (release.valueSetEntryCount !== valueSetEntries.length) {
      throw new Error(`Reference Data Release value set entry count mismatch: ${release.releaseId}`)
    }
    const acceptedCountBySource = new Map<string, number>()
    for (const concept of concepts) {
      acceptedCountBySource.set(concept.sourceId, (acceptedCountBySource.get(concept.sourceId) ?? 0) + 1)
    }
    for (const item of [
      ...laboratoryPanelMembers,
      ...laboratorySpecimens,
      ...laboratoryUnits,
    ]) {
      acceptedCountBySource.set(item.sourceId, (acceptedCountBySource.get(item.sourceId) ?? 0) + 1)
    }
    for (const product of medicationProducts) {
      acceptedCountBySource.set(product.sourceId, (acceptedCountBySource.get(product.sourceId) ?? 0) + 1)
    }
    for (const service of services) {
      acceptedCountBySource.set(service.sourceId, (acceptedCountBySource.get(service.sourceId) ?? 0) + 1)
    }
    for (const entry of valueSetEntries) {
      acceptedCountBySource.set(entry.sourceId, (acceptedCountBySource.get(entry.sourceId) ?? 0) + 1)
    }
    for (const source of release.sources) {
      if ((acceptedCountBySource.get(source.sourceId) ?? 0) !== source.importDiagnostics.acceptedCount) {
        throw new Error(`Reference source accepted count mismatch: ${release.releaseId}/${source.sourceId}`)
      }
    }
    const actualHash = contentHash({
      concepts,
      laboratoryDefinitions,
      laboratoryPanelMembers,
      laboratorySpecimens,
      laboratoryUnits,
      medicationProducts,
      release,
      services,
      sources: release.sources,
      valueSetEntries,
    })
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
