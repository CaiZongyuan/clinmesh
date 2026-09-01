import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  cnHealthCandidateProvenanceSchema,
  referenceArtifactSchema,
  type CnHealthCandidateProvenance,
  type ReferenceArtifact,
} from '@clinmesh/contracts/reference-data'
import Database from 'better-sqlite3'
import { z } from 'zod'

const applicationId = 0x434E4844
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const datasetIdSchema = z.enum([
  'laboratory-cn',
  'loinc-zh-cn',
  'nhc-icd10-clinical',
  'nhsa-drugs',
])

const candidateManifestSchema = z.object({
  artifacts: z.array(z.object({
    mediaType: z.string().min(1),
    name: z.string().min(1),
    sha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
    url: z.string().min(1),
  }).passthrough()).min(1),
  canonical: z.object({
    recordCount: z.number().int().nonnegative(),
    serialization: z.enum(['canonical-ndjson-v1', 'canonical-table-hashes-v1']),
    sha256: sha256Schema,
    tables: z.array(z.object({
      recordCount: z.number().int().nonnegative(),
      sha256: sha256Schema,
      table: z.string().min(1),
    }).strict()).optional(),
  }).passthrough(),
  dataset: z.object({
    datasetSchemaVersion: z.union([z.literal(1), z.literal(2)]),
    id: datasetIdSchema,
    sourceVersion: z.string().min(1).max(256),
  }).passthrough(),
  release: z.object({
    id: z.string().min(1).max(256),
    revoked: z.literal(false),
  }).passthrough(),
  schemaVersion: z.literal(1),
  validation: z.object({ passed: z.literal(true) }).passthrough(),
}).passthrough().superRefine((manifest, context) => {
  if (!manifest.release.id.startsWith(`${manifest.dataset.id}@`)) {
    context.addIssue({
      code: 'custom',
      message: 'Candidate Release ID does not match its Dataset',
      path: ['release', 'id'],
    })
  }
  const isTableCandidate = manifest.canonical.serialization === 'canonical-table-hashes-v1'
  if ((manifest.dataset.datasetSchemaVersion === 2) !== isTableCandidate) {
    context.addIssue({
      code: 'custom',
      message: 'Candidate Dataset Schema and canonical serialization are incompatible',
      path: ['canonical', 'serialization'],
    })
  }
  if (manifest.dataset.datasetSchemaVersion === 2 && manifest.dataset.id !== 'loinc-zh-cn') {
    context.addIssue({
      code: 'custom',
      message: 'Candidate Dataset Schema v2 is supported only for loinc-zh-cn',
      path: ['dataset', 'datasetSchemaVersion'],
    })
  }
})

const diagnosisColumns = [
  'code',
  'main_code',
  'additional_code',
  'name',
  'source_row',
  'source_version',
  'source_sha256',
] as const
const drugColumns = [
  'code',
  'data_source',
  'registered_name',
  'trade_name',
  'registered_dosage_form',
  'dosage_form',
  'registered_specification',
  'specification',
  'packaging_material',
  'minimum_package_quantity',
  'minimum_dosage_unit',
  'minimum_package_unit',
  'drug_company',
  'repackaging_company',
  'manufacturer',
  'approval_number',
  'previous_approval_number',
  'standard_drug_code',
  'marketing_authorization_holder',
  'market_status',
  'insurance_name',
  'reimbursement_class_2025',
  'insurance_dosage_form',
  'insurance_number',
  'note',
  'former_code',
  'source_row',
  'source_version',
  'source_sha256',
] as const
const loincColumns = [
  'code',
  'component',
  'property',
  'time_aspect',
  'system',
  'scale_type',
  'method_type',
  'long_common_name',
  'short_name',
  'consumer_name',
  'class',
  'class_type',
  'order_obs',
  'status',
  'status_reason',
  'status_text',
  'change_type',
  'definition_description',
  'version_first_released',
  'version_last_changed',
  'panel_type',
  'zh_display',
  'source_metadata_json',
  'translation_metadata_json',
  'source_row',
  'translation_source_row',
  'source_version',
  'core_source_sha256',
  'translation_source_sha256',
] as const
const legacyLoincColumns = [
  'code',
  'component',
  'property',
  'time_aspect',
  'system',
  'scale_type',
  'method_type',
  'long_common_name',
  'status',
  'zh_display',
  'source_version',
  'source_sha256',
] as const
const loincUnitColumns = [
  'loinc_code',
  'ucum_unit',
  'unit_kind',
  'unit_ordinal',
  'source_member',
  'source_row',
  'source_sha256',
] as const
const loincSpecimenColumns = [
  'loinc_code',
  'part_number',
  'part_name',
  'part_display_name',
  'link_type',
  'source_member',
  'source_row',
  'source_sha256',
] as const
const loincPanelMemberColumns = [
  'parent_id',
  'member_id',
  'panel_code',
  'member_code',
  'member_order',
  'relationship',
  'source_metadata_json',
  'source_member',
  'source_row',
  'source_sha256',
] as const
const laboratoryColumns = [
  'code',
  'system',
  'terminology_version',
  'display_zh',
  'category',
  'specimen',
  'result_type',
  'ucum_unit',
  'status',
  'source_note',
  'source_row',
  'source_version',
  'source_sha256',
] as const

const diagnosisRowSchema = z.object({
  code: z.string().min(1).max(256),
  name: z.string().min(1).max(1_000),
  source_row: z.number().int().positive(),
  source_version: z.string().min(1).max(256),
}).passthrough()

const drugRowSchema = z.object({
  approval_number: z.string().min(1).max(256),
  code: z.string().min(1).max(256),
  manufacturer: z.string().min(1).max(500),
  market_status: z.enum(['上市', '停产', '未上市']),
  minimum_dosage_unit: z.string().min(1).max(128),
  minimum_package_quantity: z.string().min(1).max(128),
  minimum_package_unit: z.string().min(1).max(128),
  packaging_material: z.string().min(1).max(500),
  registered_dosage_form: z.string().min(1).max(256),
  registered_name: z.string().min(1).max(500),
  registered_specification: z.string().min(1).max(256),
  source_row: z.number().int().positive(),
  source_version: z.string().min(1).max(256),
  trade_name: z.string().min(1).max(500),
}).passthrough()

const loincRowSchema = z.object({
  class: z.string().nullable(),
  class_type: z.number().int().min(1).max(4).nullable(),
  code: z.string().regex(/^\d{1,6}-\d$/),
  component: z.string().nullable(),
  long_common_name: z.string().min(1).max(1_000),
  method_type: z.string().nullable(),
  order_obs: z.enum(['Order', 'Observation', 'Both', 'Subset']).nullable(),
  panel_type: z.string().nullable(),
  property: z.string().nullable(),
  scale_type: z.string().nullable(),
  source_row: z.number().int().min(2),
  source_version: z.string().min(1).max(256),
  status: z.enum(['ACTIVE', 'TRIAL', 'DEPRECATED', 'DISCOURAGED']),
  system: z.string().nullable(),
  time_aspect: z.string().nullable(),
  zh_display: z.string().nullable(),
}).passthrough()

const legacyLoincRowSchema = loincRowSchema.partial({
  class: true,
  class_type: true,
  component: true,
  method_type: true,
  order_obs: true,
  panel_type: true,
  property: true,
  scale_type: true,
  source_row: true,
  system: true,
  time_aspect: true,
})

const loincUnitRowSchema = z.object({
  loinc_code: z.string().regex(/^\d{1,6}-\d$/),
  source_member: z.string().min(1),
  source_row: z.number().int().min(2),
  ucum_unit: z.string().min(1).max(128),
  unit_kind: z.literal('example'),
  unit_ordinal: z.number().int().positive(),
}).passthrough()

const loincSpecimenRowSchema = z.object({
  link_type: z.literal('Primary'),
  loinc_code: z.string().regex(/^\d{1,6}-\d$/),
  part_display_name: z.string().nullable(),
  part_name: z.string().min(1),
  part_number: z.string().min(1).max(128),
  source_member: z.string().min(1),
  source_row: z.number().int().min(2),
}).passthrough()

const loincPanelMemberRowSchema = z.object({
  member_code: z.string().regex(/^\d{1,6}-\d$/),
  member_id: z.string().min(1),
  member_order: z.number().int().nonnegative(),
  panel_code: z.string().regex(/^\d{1,6}-\d$/),
  parent_id: z.string().min(1),
  relationship: z.literal('contains'),
}).passthrough()

const laboratoryRowSchema = z.object({
  category: z.enum(['chemistry', 'hematology', 'vital-sign']),
  code: z.string().regex(/^\d{1,6}-\d$/),
  display_zh: z.string().min(1).max(1_000),
  result_type: z.enum(['panel', 'quantity']),
  source_row: z.number().int().positive(),
  source_version: z.string().min(1).max(256),
  status: z.enum(['active', 'inactive']),
  system: z.literal('http://loinc.org'),
  terminology_version: z.string().min(1).max(256),
  specimen: z.enum(['blood', 'body']),
  ucum_unit: z.string().min(1).max(128).nullable(),
}).passthrough()

function hashFile(path: string): { sha256: string; sizeBytes: number } {
  const descriptor = openSync(path, 'r')
  try {
    const sizeBytes = fstatSync(descriptor).size
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytesRead: number
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
    return { sha256: hash.digest('hex'), sizeBytes }
  } finally {
    closeSync(descriptor)
  }
}

function assertTableShape(
  database: Database.Database,
  table: string,
  expectedColumns: readonly string[],
): void {
  const columns = z.array(z.object({ name: z.string() }).passthrough())
    .parse(database.pragma(`table_info(${table})`))
    .map(column => column.name)
  if (columns.length !== expectedColumns.length
    || columns.some((column, index) => column !== expectedColumns[index])) {
    throw new Error(`cn-health Candidate table shape is unsupported: ${table}`)
  }
}

function diagnosisArtifact(
  database: Database.Database,
  releaseId: string,
  sourceVersion: string,
): ReferenceArtifact {
  assertTableShape(database, 'diagnosis', diagnosisColumns)
  const concepts = []
  for (const value of database.prepare(`
    SELECT code, name, source_row, source_version FROM diagnosis ORDER BY code
  `).iterate()) {
    const row = diagnosisRowSchema.parse(value)
    if (row.source_version !== sourceVersion) throw new Error('Candidate source version mismatch')
    concepts.push({
      code: row.code,
      display: row.name,
      domain: 'diagnosis' as const,
      id: `nhsa-diagnosis:${releaseId}:${row.code}`,
      sourceLocator: `cn-health:${releaseId}:diagnosis:${row.source_row}`,
      status: 'active' as const,
      system: 'urn:clinmesh:reference:nhsa-diagnosis',
      version: sourceVersion,
    })
  }
  return referenceArtifactSchema.parse({ concepts, schemaVersion: '1' })
}

function medicationArtifact(
  database: Database.Database,
  releaseId: string,
  sourceVersion: string,
): ReferenceArtifact {
  assertTableShape(database, 'drug', drugColumns)
  const medicationProducts = []
  for (const value of database.prepare(`
    SELECT code, registered_name, trade_name, registered_dosage_form,
      registered_specification, packaging_material,
      minimum_package_quantity, minimum_dosage_unit, minimum_package_unit,
      manufacturer, approval_number, market_status, source_row, source_version
    FROM drug ORDER BY code
  `).iterate()) {
    const row = drugRowSchema.parse(value)
    if (row.source_version !== sourceVersion) throw new Error('Candidate source version mismatch')
    medicationProducts.push({
      approvalNumber: row.approval_number,
      brandName: row.trade_name === '无' ? null : row.trade_name,
      code: row.code,
      dosageForm: row.registered_dosage_form,
      genericName: row.registered_name,
      id: `nhsa-medication-product:${releaseId}:${row.code}`,
      manufacturer: row.manufacturer,
      packageDescription: `${row.packaging_material}；${row.minimum_package_quantity}${row.minimum_dosage_unit}/${row.minimum_package_unit}`,
      sourceLocator: `cn-health:${releaseId}:drug:${row.source_row}`,
      status: row.market_status === '上市' ? 'active' as const : 'inactive' as const,
      strength: row.registered_specification,
      system: 'urn:clinmesh:reference:nhsa-medication-product',
      version: sourceVersion,
    })
  }
  return referenceArtifactSchema.parse({ concepts: [], medicationProducts, schemaVersion: '1' })
}

function loincConceptId(releaseId: string, code: string): string {
  return `loinc:${releaseId}:${code}`
}

function legacyLoincArtifact(
  database: Database.Database,
  releaseId: string,
  sourceVersion: string,
): ReferenceArtifact {
  assertTableShape(database, 'loinc', legacyLoincColumns)
  const concepts = []
  for (const value of database.prepare(`
    SELECT code, long_common_name, status, zh_display, source_version
    FROM loinc ORDER BY code
  `).iterate()) {
    const row = legacyLoincRowSchema.parse(value)
    if (row.source_version !== sourceVersion) throw new Error('Candidate source version mismatch')
    concepts.push({
      code: row.code,
      display: row.zh_display?.trim() || row.long_common_name,
      domain: 'laboratory' as const,
      id: loincConceptId(releaseId, row.code),
      sourceLocator: `cn-health:${releaseId}:loinc:${row.code}`,
      status: row.status === 'ACTIVE' ? 'active' as const : 'inactive' as const,
      system: 'http://loinc.org',
      version: sourceVersion,
    })
  }
  return referenceArtifactSchema.parse({ concepts, schemaVersion: '1' })
}

const loincCanonicalTableOrder = {
  loinc: ['code'],
  loinc_panel_member: ['parent_id', 'member_id'],
  loinc_specimen: ['loinc_code', 'part_number', 'link_type'],
  loinc_unit: ['loinc_code', 'unit_kind', 'source_member', 'source_row', 'unit_ordinal'],
} as const

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null'
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`
}

function assertCanonicalTables(
  database: Database.Database,
  tables: readonly { recordCount: number; sha256: string; table: string }[],
  canonicalSha256: string,
): void {
  const expectedTables = ['loinc', 'loinc_unit', 'loinc_specimen', 'loinc_panel_member']
  const actualTables = tables.map(table => table.table)
  if (actualTables.length !== expectedTables.length
    || actualTables.some((table, index) => table !== expectedTables[index])) {
    throw new Error('cn-health LOINC Candidate canonical tables are unsupported')
  }
  for (const table of tables) {
    const order = loincCanonicalTableOrder[
      table.table as keyof typeof loincCanonicalTableOrder
    ]
    const digest = createHash('sha256')
    let recordCount = 0
    for (const row of database.prepare(`
      SELECT * FROM ${table.table} ORDER BY ${order.join(', ')}
    `).iterate()) {
      digest.update(canonicalJson(row))
      digest.update('\n')
      recordCount += 1
    }
    if (recordCount !== table.recordCount) {
      throw new Error(`cn-health Candidate canonical record count mismatch: ${table.table}`)
    }
    if (digest.digest('hex') !== table.sha256) {
      throw new Error(`cn-health Candidate canonical SHA256 mismatch: ${table.table}`)
    }
  }
  if (createHash('sha256').update(canonicalJson({ tables })).digest('hex') !== canonicalSha256) {
    throw new Error('cn-health Candidate canonical table set SHA256 mismatch')
  }
}

function loincV2Artifact(
  database: Database.Database,
  releaseId: string,
  sourceVersion: string,
  tables: readonly { recordCount: number; sha256: string; table: string }[],
  canonicalSha256: string,
): ReferenceArtifact {
  assertTableShape(database, 'loinc', loincColumns)
  assertTableShape(database, 'loinc_unit', loincUnitColumns)
  assertTableShape(database, 'loinc_specimen', loincSpecimenColumns)
  assertTableShape(database, 'loinc_panel_member', loincPanelMemberColumns)
  assertCanonicalTables(database, tables, canonicalSha256)

  const concepts = []
  const laboratoryDefinitions = []
  for (const value of database.prepare(`
    SELECT code, component, property, time_aspect, system, scale_type,
      method_type, long_common_name, class, class_type, order_obs, status,
      panel_type, zh_display, source_row, source_version
    FROM loinc ORDER BY code
  `).iterate()) {
    const row = loincRowSchema.parse(value)
    if (row.source_version !== sourceVersion) throw new Error('Candidate source version mismatch')
    const conceptId = loincConceptId(releaseId, row.code)
    concepts.push({
      code: row.code,
      display: row.zh_display?.trim() || row.long_common_name,
      domain: row.class_type === 1 ? 'laboratory' as const : 'other' as const,
      id: conceptId,
      sourceLocator: `cn-health:${releaseId}:loinc:${row.code}`,
      status: row.status === 'ACTIVE' ? 'active' as const : 'inactive' as const,
      system: 'http://loinc.org',
      version: sourceVersion,
    })
    laboratoryDefinitions.push({
      classCode: row.class,
      classType: row.class_type,
      component: row.component,
      conceptId,
      methodType: row.method_type,
      orderObservation: row.order_obs,
      panelType: row.panel_type,
      property: row.property,
      scaleType: row.scale_type,
      sourceLocator: `cn-health:${releaseId}:loinc-definition:${row.source_row}`,
      system: row.system,
      timeAspect: row.time_aspect,
    })
  }

  const laboratoryUnits = z.array(loincUnitRowSchema).parse(database.prepare(`
    SELECT loinc_code, ucum_unit, unit_kind, unit_ordinal,
      source_member, source_row, source_sha256
    FROM loinc_unit
    ORDER BY loinc_code, unit_kind, source_member, source_row, unit_ordinal
  `).all()).map(row => ({
    code: row.ucum_unit,
    conceptId: loincConceptId(releaseId, row.loinc_code),
    kind: row.unit_kind,
    ordinal: row.unit_ordinal,
    sourceLocator: `cn-health:${releaseId}:loinc-unit:${row.source_member}:${row.source_row}:${row.unit_ordinal}`,
  }))
  const laboratorySpecimens = z.array(loincSpecimenRowSchema).parse(database.prepare(`
    SELECT loinc_code, part_number, part_name, part_display_name, link_type,
      source_member, source_row, source_sha256
    FROM loinc_specimen
    ORDER BY loinc_code, part_number, link_type
  `).all()).map(row => ({
    conceptId: loincConceptId(releaseId, row.loinc_code),
    display: row.part_display_name?.trim() || row.part_name,
    linkType: row.link_type,
    partName: row.part_name,
    partNumber: row.part_number,
    sourceLocator: `cn-health:${releaseId}:loinc-specimen:${row.source_member}:${row.source_row}`,
  }))
  const laboratoryPanelMembers = z.array(loincPanelMemberRowSchema).parse(database.prepare(`
    SELECT parent_id, member_id, panel_code, member_code, member_order,
      relationship, source_metadata_json, source_member, source_row, source_sha256
    FROM loinc_panel_member
    ORDER BY panel_code, member_order, member_code, parent_id, member_id
  `).all()).map(row => ({
    memberConceptId: loincConceptId(releaseId, row.member_code),
    memberOrder: row.member_order,
    panelConceptId: loincConceptId(releaseId, row.panel_code),
    relationship: row.relationship,
    sourceLocator: `cn-health:${releaseId}:loinc-panel-member:${row.parent_id}:${row.member_id}`,
  }))
  return referenceArtifactSchema.parse({
    concepts,
    laboratoryDefinitions,
    laboratoryPanelMembers,
    laboratorySpecimens,
    laboratoryUnits,
    schemaVersion: '1',
  })
}

function artifactRecordCount(artifact: ReferenceArtifact): number {
  return artifact.concepts.length
    + artifact.laboratoryPanelMembers.length
    + artifact.laboratorySpecimens.length
    + artifact.laboratoryUnits.length
    + artifact.medicationProducts.length
    + artifact.services.length
    + artifact.valueSetEntries.length
}

function laboratoryArtifact(
  database: Database.Database,
  releaseId: string,
  sourceVersion: string,
): ReferenceArtifact {
  assertTableShape(database, 'laboratory_concept', laboratoryColumns)
  const concepts = []
  for (const value of database.prepare(`
    SELECT code, system, terminology_version, display_zh, category, specimen,
      result_type, ucum_unit, status,
      source_row, source_version
    FROM laboratory_concept ORDER BY code
  `).iterate()) {
    const row = laboratoryRowSchema.parse(value)
    if (row.source_version !== sourceVersion) throw new Error('Candidate source version mismatch')
    concepts.push({
      code: row.code,
      display: row.display_zh,
      domain: 'laboratory' as const,
      id: `laboratory-cn:${releaseId}:${row.code}`,
      laboratory: {
        category: row.category,
        resultType: row.result_type,
        specimen: row.specimen,
        ...(row.ucum_unit === null
          ? {}
          : {
              unit: {
                code: row.ucum_unit,
                display: row.ucum_unit,
                system: 'http://unitsofmeasure.org' as const,
              },
            }),
      },
      sourceLocator: `cn-health:${releaseId}:laboratory:${row.source_row}`,
      status: row.status,
      system: row.system,
      version: row.terminology_version,
    })
  }
  return referenceArtifactSchema.parse({ concepts, schemaVersion: '1' })
}

export function parseCnHealthCandidateReferenceArtifact(manifestPath: string): {
  artifact: ReferenceArtifact
  provenance: CnHealthCandidateProvenance
} {
  const manifest = candidateManifestSchema.parse(JSON.parse(
    readManifest(manifestPath),
  ))
  const sqliteArtifacts = manifest.artifacts.filter(artifact => (
    artifact.name === 'data.sqlite'
    && artifact.mediaType === 'application/vnd.sqlite3'
    && artifact.url === 'data.sqlite'
  ))
  if (sqliteArtifacts.length !== 1) {
    throw new Error('cn-health Candidate must declare one data.sqlite artifact')
  }
  const sqliteArtifact = sqliteArtifacts[0]!
  const databasePath = resolve(dirname(resolve(manifestPath)), 'data.sqlite')
  const actual = hashFile(databasePath)
  if (actual.sha256 !== sqliteArtifact.sha256 || actual.sizeBytes !== sqliteArtifact.sizeBytes) {
    throw new Error('cn-health Candidate SQLite SHA256 or size does not match Manifest')
  }
  const database = new Database(databasePath, { fileMustExist: true, readonly: true })
  try {
    database.pragma('query_only = ON')
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('cn-health Candidate SQLite integrity check failed')
    }
    if (database.pragma('application_id', { simple: true }) !== applicationId) {
      throw new Error('cn-health Candidate SQLite application ID is invalid')
    }
    const datasetId = manifest.dataset.id
    const artifact = datasetId === 'nhc-icd10-clinical'
      ? diagnosisArtifact(database, manifest.release.id, manifest.dataset.sourceVersion)
      : datasetId === 'nhsa-drugs'
        ? medicationArtifact(database, manifest.release.id, manifest.dataset.sourceVersion)
        : datasetId === 'laboratory-cn'
          ? laboratoryArtifact(database, manifest.release.id, manifest.dataset.sourceVersion)
          : manifest.dataset.datasetSchemaVersion === 2
            ? loincV2Artifact(
                database,
                manifest.release.id,
                manifest.dataset.sourceVersion,
                manifest.canonical.tables ?? [],
                manifest.canonical.sha256,
              )
            : legacyLoincArtifact(database, manifest.release.id, manifest.dataset.sourceVersion)
    const recordCount = artifactRecordCount(artifact)
    if (recordCount !== manifest.canonical.recordCount) {
      throw new Error('cn-health Candidate canonical record count does not match SQLite')
    }
    return {
      artifact,
      provenance: cnHealthCandidateProvenanceSchema.parse({
        canonicalSha256: manifest.canonical.sha256,
        datasetId,
        datasetSchemaVersion: manifest.dataset.datasetSchemaVersion,
        recordCount,
        releaseId: manifest.release.id,
        sourceVersion: manifest.dataset.sourceVersion,
        sqliteSha256: actual.sha256,
        sqliteSizeBytes: actual.sizeBytes,
      }),
    }
  } finally {
    database.close()
  }
}

function readManifest(path: string): string {
  if (statSync(path).size > 1024 * 1024) {
    throw new Error('cn-health Candidate Manifest is too large')
  }
  return readFileSync(path, 'utf8')
}
