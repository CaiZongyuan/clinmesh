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
    uncompressedName: z.string().min(1).optional(),
    uncompressedSha256: sha256Schema.optional(),
    uncompressedSizeBytes: z.number().int().nonnegative().optional(),
    url: z.string().min(1),
  }).passthrough()).min(1),
  canonical: z.object({
    recordCount: z.number().int().nonnegative(),
    serialization: z.enum([
      'canonical-ndjson-v1',
      'canonical-table-hashes-v1',
      'canonical-multitable-ndjson-v1',
    ]),
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
  const expectedSerialization = manifest.dataset.datasetSchemaVersion === 1
    ? 'canonical-ndjson-v1'
    : manifest.dataset.id === 'loinc-zh-cn'
      ? 'canonical-table-hashes-v1'
      : manifest.dataset.id === 'laboratory-cn'
        ? 'canonical-multitable-ndjson-v1'
        : undefined
  if (manifest.canonical.serialization !== expectedSerialization) {
    context.addIssue({
      code: 'custom',
      message: 'Candidate Dataset Schema and canonical serialization are incompatible',
      path: ['canonical', 'serialization'],
    })
  }
  if (manifest.dataset.datasetSchemaVersion === 2
    && manifest.dataset.id !== 'loinc-zh-cn'
    && manifest.dataset.id !== 'laboratory-cn') {
    context.addIssue({
      code: 'custom',
      message: 'Candidate Dataset Schema v2 is unsupported for this Dataset',
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
const laboratoryTestV2Columns = [
  'code', 'name', 'category', 'analyte', 'specimen', 'scale', 'result_kind',
  'unit_display', 'unit_ucum', 'precision', 'healthy_strategy', 'loinc_code',
  'status', 'source_version',
] as const
const laboratoryReferenceV2Columns = [
  'test_code', 'sex', 'reference_kind', 'low_value', 'high_value', 'normal_value',
  'simulation_low', 'simulation_high', 'source_type', 'source_standard',
  'source_version', 'source_location', 'notes',
] as const
const laboratoryPanelV2Columns = [
  'code', 'name', 'specimen', 'status', 'source_type', 'source_location', 'notes',
] as const
const laboratoryPanelMemberV2Columns = [
  'panel_code', 'test_code', 'sort_order',
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

const laboratoryTestV2RowSchema = z.object({
  analyte: z.string().min(1).max(1_000),
  category: z.string().min(1).max(1_000),
  code: z.string().regex(/^[A-Za-z0-9]{8}$/),
  healthy_strategy: z.enum(['uniform', 'fixed-normal']),
  loinc_code: z.string().regex(/^\d{1,6}-\d$/).nullable(),
  name: z.string().min(1).max(1_000),
  precision: z.number().int().min(0).max(4),
  result_kind: z.enum(['quantity', 'qualitative', 'ordinal', 'named']),
  scale: z.string().min(1).max(256),
  source_version: z.string().min(1).max(256),
  specimen: z.string().min(1).max(1_000),
  status: z.enum(['active', 'inactive']),
  unit_display: z.string().min(1).max(128).nullable(),
  unit_ucum: z.string().min(1).max(128).nullable(),
}).strict()

const laboratoryReferenceV2RowSchema = z.object({
  high_value: z.number().finite().nullable(),
  low_value: z.number().finite().nullable(),
  normal_value: z.string().min(1).max(256).nullable(),
  notes: z.string().max(1_000),
  reference_kind: z.enum(['range', 'upper-bound', 'lower-bound', 'coded', 'ordinal']),
  sex: z.enum(['all', 'male', 'female']),
  simulation_high: z.number().finite().nullable(),
  simulation_low: z.number().finite().nullable(),
  source_location: z.string().min(1).max(1_000),
  source_standard: z.string().min(1).max(1_000),
  source_type: z.enum(['national-standard', 'project-curated']),
  source_version: z.string().min(1).max(256),
  test_code: z.string().regex(/^[A-Za-z0-9]{8}$/),
}).strict()

const laboratoryPanelV2RowSchema = z.object({
  code: z.string().min(1).max(256),
  name: z.string().min(1).max(1_000),
  notes: z.string().max(1_000),
  source_location: z.string().min(1).max(1_000),
  source_type: z.literal('project-authored'),
  specimen: z.string().min(1).max(1_000),
  status: z.enum(['active', 'inactive']),
}).strict()

const laboratoryPanelMemberV2RowSchema = z.object({
  panel_code: z.string().min(1).max(256),
  sort_order: z.number().int().positive(),
  test_code: z.string().regex(/^[A-Za-z0-9]{8}$/),
}).strict()

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
  loinc_unit: ['loinc_code', 'unit_kind', 'source_member', 'source_row', 'unit_ordinal'],
  loinc_specimen: ['loinc_code', 'part_number', 'link_type'],
  loinc_panel_member: ['parent_id', 'member_id'],
} as const
const laboratoryCanonicalTableOrder = {
  laboratory_test: ['code'],
  laboratory_reference: ['test_code', 'sex'],
  laboratory_panel: ['code'],
  laboratory_panel_member: ['panel_code', 'sort_order', 'test_code'],
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
  expectedOrder: Record<string, readonly string[]> = loincCanonicalTableOrder,
  aggregateShape: 'array' | 'object' = 'object',
): void {
  const expectedTables = Object.keys(expectedOrder)
  const actualTables = tables.map(table => table.table)
  if (actualTables.length !== expectedTables.length
    || actualTables.some((table, index) => table !== expectedTables[index])) {
    throw new Error('cn-health LOINC Candidate canonical tables are unsupported')
  }
  for (const table of tables) {
    const order = expectedOrder[table.table]
    if (order === undefined) throw new Error(`cn-health Candidate table is unsupported: ${table.table}`)
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
  const aggregate = aggregateShape === 'array' ? tables : { tables }
  if (createHash('sha256').update(canonicalJson(aggregate)).digest('hex') !== canonicalSha256) {
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
      kind: 'loinc',
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

const wst886System = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
const laboratoryPanelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'

function wst886ConceptId(code: string): string {
  return `wst-886:2026:${code}`
}

function laboratoryPanelConceptId(sourceVersion: string, code: string): string {
  return `laboratory-panel-cn:${sourceVersion}:${code}`
}

function laboratoryV2Artifact(
  database: Database.Database,
  releaseId: string,
  sourceVersion: string,
  tables: readonly { recordCount: number; sha256: string; table: string }[],
  canonicalSha256: string,
): ReferenceArtifact {
  assertTableShape(database, 'laboratory_test', laboratoryTestV2Columns)
  assertTableShape(database, 'laboratory_reference', laboratoryReferenceV2Columns)
  assertTableShape(database, 'laboratory_panel', laboratoryPanelV2Columns)
  assertTableShape(database, 'laboratory_panel_member', laboratoryPanelMemberV2Columns)
  assertCanonicalTables(
    database,
    tables,
    canonicalSha256,
    laboratoryCanonicalTableOrder,
    'array',
  )
  const references = z.array(laboratoryReferenceV2RowSchema).parse(database.prepare(`
    SELECT * FROM laboratory_reference ORDER BY test_code, sex
  `).all())
  const referencesByTest = new Map<
    string,
    Array<z.infer<typeof laboratoryReferenceV2RowSchema>>
  >()
  for (const reference of references) {
    const values = referencesByTest.get(reference.test_code) ?? []
    values.push(reference)
    referencesByTest.set(reference.test_code, values)
  }
  const concepts = []
  const laboratoryDefinitions = []
  for (const value of database.prepare(`
    SELECT * FROM laboratory_test ORDER BY code
  `).iterate()) {
    const row = laboratoryTestV2RowSchema.parse(value)
    if (row.source_version !== sourceVersion) throw new Error('Candidate source version mismatch')
    const conceptId = wst886ConceptId(row.code)
    concepts.push({
      code: row.code,
      display: row.name,
      domain: 'laboratory' as const,
      id: conceptId,
      sourceLocator: `cn-health:${releaseId}:laboratory-test:${row.code}`,
      status: row.status,
      system: wst886System,
      version: '2026',
    })
    laboratoryDefinitions.push({
      adultReferenceRules: (referencesByTest.get(row.code) ?? []).map(rule => ({
        ...(rule.high_value === null ? {} : { high: rule.high_value }),
        ...(rule.low_value === null ? {} : { low: rule.low_value }),
        ...(rule.normal_value === null ? {} : { normalValue: rule.normal_value }),
        notes: rule.notes,
        referenceKind: rule.reference_kind,
        sex: rule.sex,
        ...(rule.simulation_high === null ? {} : { simulationHigh: rule.simulation_high }),
        ...(rule.simulation_low === null ? {} : { simulationLow: rule.simulation_low }),
        sourceLocation: rule.source_location,
        sourceStandard: rule.source_standard,
        sourceType: rule.source_type,
        sourceVersion: rule.source_version,
      })),
      alternateCodings: row.loinc_code === null
        ? []
        : [{ code: row.loinc_code, system: 'http://loinc.org' as const, version: '2.83' }],
      analyte: row.analyte,
      category: row.category,
      conceptId,
      datasetReleaseId: releaseId,
      healthyStrategy: row.healthy_strategy,
      kind: 'laboratory-cn-test' as const,
      precision: row.precision,
      resultKind: row.result_kind,
      scale: row.scale,
      sourceLocator: `cn-health:${releaseId}:laboratory-test:${row.code}`,
      sourceVersion,
      specimen: row.specimen,
      ...(row.unit_ucum === null || row.unit_display === null
        ? {}
        : {
            unit: {
              code: row.unit_ucum,
              display: row.unit_display,
              system: 'http://unitsofmeasure.org' as const,
            },
          }),
    })
  }
  for (const value of database.prepare(`
    SELECT * FROM laboratory_panel ORDER BY code
  `).iterate()) {
    const row = laboratoryPanelV2RowSchema.parse(value)
    const conceptId = laboratoryPanelConceptId(sourceVersion, row.code)
    concepts.push({
      code: row.code,
      display: row.name,
      domain: 'laboratory' as const,
      id: conceptId,
      sourceLocator: `cn-health:${releaseId}:laboratory-panel:${row.code}`,
      status: row.status,
      system: laboratoryPanelSystem,
      version: sourceVersion,
    })
    laboratoryDefinitions.push({
      conceptId,
      datasetReleaseId: releaseId,
      kind: 'laboratory-cn-panel' as const,
      notes: row.notes,
      sourceLocation: row.source_location,
      sourceLocator: `cn-health:${releaseId}:laboratory-panel:${row.code}`,
      sourceType: row.source_type,
      sourceVersion,
      specimen: row.specimen,
    })
  }
  const laboratoryPanelMembers = z.array(laboratoryPanelMemberV2RowSchema).parse(
    database.prepare(`
      SELECT * FROM laboratory_panel_member ORDER BY panel_code, sort_order, test_code
    `).all(),
  ).map(row => ({
    memberConceptId: wst886ConceptId(row.test_code),
    memberOrder: row.sort_order,
    panelConceptId: laboratoryPanelConceptId(sourceVersion, row.panel_code),
    relationship: 'contains' as const,
    sourceLocator: `cn-health:${releaseId}:laboratory-panel-member:${row.panel_code}:${row.sort_order}`,
  }))
  return referenceArtifactSchema.parse({
    concepts,
    laboratoryDefinitions,
    laboratoryPanelMembers,
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
  const directSqliteArtifacts = manifest.artifacts.filter(artifact => (
    artifact.name === 'data.sqlite'
    && artifact.mediaType === 'application/vnd.sqlite3'
    && artifact.url === 'data.sqlite'
  ))
  const compressedSqliteArtifacts = manifest.artifacts.filter(artifact => (
    artifact.name === 'data.sqlite.zst'
    && artifact.mediaType === 'application/zstd'
    && artifact.url === 'data.sqlite.zst'
    && artifact.uncompressedName === 'data.sqlite'
    && artifact.uncompressedSha256 !== undefined
    && artifact.uncompressedSizeBytes !== undefined
  ))
  if (directSqliteArtifacts.length + compressedSqliteArtifacts.length !== 1) {
    throw new Error('cn-health Candidate must declare one materializable data.sqlite artifact')
  }
  const directSqlite = directSqliteArtifacts[0]
  const compressedSqlite = compressedSqliteArtifacts[0]
  const expectedSqlite = directSqlite === undefined
    ? {
        sha256: compressedSqlite!.uncompressedSha256!,
        sizeBytes: compressedSqlite!.uncompressedSizeBytes!,
      }
    : { sha256: directSqlite.sha256, sizeBytes: directSqlite.sizeBytes }
  const databasePath = resolve(dirname(resolve(manifestPath)), 'data.sqlite')
  const actual = hashFile(databasePath)
  if (actual.sha256 !== expectedSqlite.sha256 || actual.sizeBytes !== expectedSqlite.sizeBytes) {
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
          ? manifest.dataset.datasetSchemaVersion === 2
            ? laboratoryV2Artifact(
                database,
                manifest.release.id,
                manifest.dataset.sourceVersion,
                manifest.canonical.tables ?? [],
                manifest.canonical.sha256,
              )
            : laboratoryArtifact(database, manifest.release.id, manifest.dataset.sourceVersion)
          : manifest.dataset.datasetSchemaVersion === 2
            ? loincV2Artifact(
                database,
                manifest.release.id,
                manifest.dataset.sourceVersion,
                manifest.canonical.tables ?? [],
                manifest.canonical.sha256,
              )
            : legacyLoincArtifact(database, manifest.release.id, manifest.dataset.sourceVersion)
    const recordCount = manifest.dataset.id === 'laboratory-cn'
      && manifest.dataset.datasetSchemaVersion === 2
      ? manifest.canonical.recordCount
      : artifactRecordCount(artifact)
    if (manifest.dataset.id !== 'laboratory-cn'
      && recordCount !== manifest.canonical.recordCount) {
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
