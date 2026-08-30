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
    serialization: z.literal('canonical-ndjson-v1'),
    sha256: sha256Schema,
  }).passthrough(),
  dataset: z.object({
    datasetSchemaVersion: z.literal(1),
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
  'status',
  'zh_display',
  'source_version',
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
  code: z.string().regex(/^\d{1,5}-\d$/),
  long_common_name: z.string().min(1).max(1_000),
  source_version: z.string().min(1).max(256),
  status: z.string().nullable(),
  zh_display: z.string().nullable(),
}).passthrough()

const laboratoryRowSchema = z.object({
  code: z.string().regex(/^\d{1,5}-\d$/),
  display_zh: z.string().min(1).max(1_000),
  source_row: z.number().int().positive(),
  source_version: z.string().min(1).max(256),
  status: z.enum(['active', 'inactive']),
  system: z.literal('http://loinc.org'),
  terminology_version: z.string().min(1).max(256),
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

function loincArtifact(
  database: Database.Database,
  releaseId: string,
  sourceVersion: string,
): ReferenceArtifact {
  assertTableShape(database, 'loinc', loincColumns)
  const concepts = []
  for (const value of database.prepare(`
    SELECT code, long_common_name, status, zh_display, source_version
    FROM loinc ORDER BY code
  `).iterate()) {
    const row = loincRowSchema.parse(value)
    if (row.source_version !== sourceVersion) throw new Error('Candidate source version mismatch')
    concepts.push({
      code: row.code,
      display: row.zh_display?.trim() || row.long_common_name,
      domain: 'laboratory' as const,
      id: `loinc:${releaseId}:${row.code}`,
      sourceLocator: `cn-health:${releaseId}:loinc:${row.code}`,
      status: row.status === 'ACTIVE' ? 'active' as const : 'inactive' as const,
      system: 'http://loinc.org',
      version: sourceVersion,
    })
  }
  return referenceArtifactSchema.parse({ concepts, schemaVersion: '1' })
}

function laboratoryArtifact(
  database: Database.Database,
  releaseId: string,
  sourceVersion: string,
): ReferenceArtifact {
  assertTableShape(database, 'laboratory_concept', laboratoryColumns)
  const concepts = []
  for (const value of database.prepare(`
    SELECT code, system, terminology_version, display_zh, status,
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
          : loincArtifact(database, manifest.release.id, manifest.dataset.sourceVersion)
    const recordCount = artifact.concepts.length + artifact.medicationProducts.length
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
