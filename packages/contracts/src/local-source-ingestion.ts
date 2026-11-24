import { z } from 'zod'
import {
  DEFAULT_CLINICAL_FACT_HOSPITAL_ID,
  DEFAULT_CLINICAL_FACT_MAPPING_VERSION,
  type ClinicalFact,
} from './clinical-fact-ledger.ts'
import { commandResponseSchema } from './his.ts'

const s = z.string()
const nonEmpty = s.trim().min(1)
const dt = z.iso.datetime({ offset: true })
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected ISO YYYY-MM-DD date')

export const PRIMARY_LOCAL_SOURCE_SYSTEM_ID = 'clinmesh-his-fhir'
export const SIM_LIS_V2_SOURCE_SYSTEM_ID = 'clinmesh-sim-lis-v2'
export const DEFAULT_LOCAL_INGESTION_HOSPITAL_ID = DEFAULT_CLINICAL_FACT_HOSPITAL_ID
export const DEFAULT_LOCAL_INGESTION_MAPPING_VERSION = DEFAULT_CLINICAL_FACT_MAPPING_VERSION
export const DEFAULT_PATIENT_MATCH_CONFIDENCE_THRESHOLD = 0.9

export const localSourceSystemIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'Expected lowercase alphanumeric/hyphen sourceSystemId slug')
export type LocalSourceSystemId = z.infer<typeof localSourceSystemIdSchema>

export const localIngestionHospitalIdSchema = nonEmpty
export type LocalIngestionHospitalId = z.infer<typeof localIngestionHospitalIdSchema>

export const localIngestionBatchStatusSchema = z.enum(['incomplete', 'complete'])
export type LocalIngestionBatchStatus = z.infer<typeof localIngestionBatchStatusSchema>

export const localIngestionBatchContractSchema = z.object({
  sourceSystemId: localSourceSystemIdSchema,
  hospitalId: localIngestionHospitalIdSchema,
  batchId: nonEmpty,
  expectedItemCount: z.number().int().positive(),
  receivedItemCount: z.number().int().nonnegative(),
  batchStatus: localIngestionBatchStatusSchema,
  ingestedAt: dt,
}).strict()
export type LocalIngestionBatchContract = z.infer<typeof localIngestionBatchContractSchema>

export const localIngestionPatientRefSchema = z.object({
  externalPatientId: nonEmpty,
  localPatientId: nonEmpty.nullable().optional(),
  fullName: nonEmpty,
  birthDate: isoDate,
  nationalId: nonEmpty,
  phone: nonEmpty.nullable().optional(),
}).strict()
export type LocalIngestionPatientRef = z.infer<typeof localIngestionPatientRefSchema>

export const localSourceReportStatusSchema = z.enum([
  'final',
  'amended',
  'corrected',
  'entered-in-error',
])
export type LocalSourceReportStatus = z.infer<typeof localSourceReportStatusSchema>

export const simLisV2RecordSchema = z.object({
  externalReportId: nonEmpty,
  orderId: nonEmpty,
  analyte_local_code: nonEmpty,
  analyte_label: nonEmpty,
  result_num: z.number().finite(),
  uom_text: nonEmpty,
  collected_ts: dt,
  released_ts: dt,
  ordered_ts: dt.nullable().optional(),
  report_status: localSourceReportStatusSchema,
  version: z.number().int().positive(),
  specimen_type: nonEmpty.nullable().optional(),
  method_text: nonEmpty.nullable().optional(),
  reference_low: z.number().finite().nullable().optional(),
  reference_high: z.number().finite().nullable().optional(),
  interpretation_flag: nonEmpty.nullable().optional(),
}).strict()
export type SimLisV2Record = z.infer<typeof simLisV2RecordSchema>

export const simLisV2BatchPayloadSchema = z.object({
  sourceSystemId: localSourceSystemIdSchema.optional(),
  hospitalId: localIngestionHospitalIdSchema.optional(),
  batchId: nonEmpty,
  expectedItemCount: z.number().int().positive(),
  ingestedAt: dt.optional(),
  specimen_barcode: nonEmpty,
  patient_ref: localIngestionPatientRefSchema,
  records: z.array(simLisV2RecordSchema).min(1),
}).strict()
export type SimLisV2BatchPayload = z.infer<typeof simLisV2BatchPayloadSchema>

export const primaryHisLabRecordSchema = z.object({
  externalReportId: nonEmpty,
  orderId: nonEmpty.nullable().optional(),
  loincCode: nonEmpty,
  display: nonEmpty,
  value: z.number().finite(),
  unit: nonEmpty,
  effectiveDateTime: dt,
  issued: dt,
  orderedAt: dt.nullable().optional(),
  status: localSourceReportStatusSchema,
  version: z.number().int().positive(),
  specimenLabel: nonEmpty.nullable().optional(),
  methodText: nonEmpty.nullable().optional(),
  referenceLow: z.number().finite().nullable().optional(),
  referenceHigh: z.number().finite().nullable().optional(),
  interpretationCode: nonEmpty.nullable().optional(),
}).strict()
export type PrimaryHisLabRecord = z.infer<typeof primaryHisLabRecordSchema>

export const primaryHisBatchPayloadSchema = z.object({
  sourceSystemId: z.literal(PRIMARY_LOCAL_SOURCE_SYSTEM_ID),
  hospitalId: localIngestionHospitalIdSchema.optional(),
  batchId: nonEmpty,
  expectedItemCount: z.number().int().positive(),
  ingestedAt: dt.optional(),
  specimenBarcode: nonEmpty.optional(),
  patientRef: localIngestionPatientRefSchema,
  records: z.array(primaryHisLabRecordSchema).min(1),
}).strict()
export type PrimaryHisBatchPayload = z.infer<typeof primaryHisBatchPayloadSchema>

export const ingestLocalSourceBatchRequestSchema = z.union([
  simLisV2BatchPayloadSchema,
  primaryHisBatchPayloadSchema,
])
export type IngestLocalSourceBatchRequest = z.infer<typeof ingestLocalSourceBatchRequestSchema>

export const patientIdentityMatchDecisionSchema = z.enum([
  'matched',
  'distinct-patient',
  'quarantined',
])
export type PatientIdentityMatchDecision = z.infer<typeof patientIdentityMatchDecisionSchema>

export const patientIdentityResolutionStatusSchema = z.enum([
  'auto-matched',
  'pending-review',
  'confirmed-merged',
  'rejected-distinct',
])
export type PatientIdentityResolutionStatus = z.infer<typeof patientIdentityResolutionStatusSchema>

export const patientIdentityCandidateSchema = z.object({
  candidateId: nonEmpty,
  sourceSystemId: localSourceSystemIdSchema,
  externalPatientId: nonEmpty,
  batchId: nonEmpty,
  patientPayload: localIngestionPatientRefSchema,
  matchedLocalPatientId: nonEmpty.nullable(),
  confidenceScore: z.number().min(0).max(1),
  confidenceThreshold: z.number().min(0).max(1),
  decision: patientIdentityMatchDecisionSchema,
  mismatchReasons: z.array(nonEmpty),
  resolutionStatus: patientIdentityResolutionStatusSchema,
  resolvedByActorId: nonEmpty.nullable(),
  resolvedAt: dt.nullable(),
  auditNote: s.nullable(),
}).strict()
export type PatientIdentityCandidate = z.infer<typeof patientIdentityCandidateSchema>

export const ingestLocalSourceBatchResultSchema = z.object({
  batch: localIngestionBatchContractSchema,
  identityCandidate: patientIdentityCandidateSchema,
  acceptedRecordCount: z.number().int().nonnegative(),
  visibleInClinicalLedger: z.boolean(),
}).strict()
export type IngestLocalSourceBatchResult = z.infer<typeof ingestLocalSourceBatchResultSchema>

export const ingestLocalSourceBatchResponseSchema = commandResponseSchema(
  ingestLocalSourceBatchResultSchema,
)
export type IngestLocalSourceBatchResponse = z.infer<typeof ingestLocalSourceBatchResponseSchema>

export const listIdentityQuarantineQuerySchema = z.object({
  resolutionStatus: patientIdentityResolutionStatusSchema.optional(),
  sourceSystemId: localSourceSystemIdSchema.optional(),
  batchId: nonEmpty.optional(),
}).strict()
export type ListIdentityQuarantineQuery = z.infer<typeof listIdentityQuarantineQuerySchema>

export const listIdentityQuarantineResponseSchema = z.object({
  items: z.array(patientIdentityCandidateSchema),
  totalCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
}).strict()
export type ListIdentityQuarantineResponse = z.infer<typeof listIdentityQuarantineResponseSchema>

export const confirmIdentityQuarantineMergeBodySchema = z.object({
  decision: z.enum(['confirm-merge', 'reject-distinct']),
  targetPatientId: nonEmpty.nullable().optional(),
  auditNote: nonEmpty,
}).strict()
export type ConfirmIdentityQuarantineMergeBody = z.infer<typeof confirmIdentityQuarantineMergeBodySchema>

export const confirmIdentityQuarantineMergeInputSchema = confirmIdentityQuarantineMergeBodySchema.extend({
  candidateId: nonEmpty,
}).strict()
export type ConfirmIdentityQuarantineMergeInput = z.infer<typeof confirmIdentityQuarantineMergeInputSchema>

export const confirmIdentityQuarantineMergeDataSchema = z.object({
  candidate: patientIdentityCandidateSchema,
  releasedObservationCount: z.number().int().nonnegative(),
}).strict()
export type ConfirmIdentityQuarantineMergeData = z.infer<typeof confirmIdentityQuarantineMergeDataSchema>

export const confirmIdentityQuarantineMergeResponseSchema = commandResponseSchema(
  confirmIdentityQuarantineMergeDataSchema,
)
export type ConfirmIdentityQuarantineMergeResponse = z.infer<typeof confirmIdentityQuarantineMergeResponseSchema>

export const sourceAgnosticismResultSchema = z.object({
  identicalNormalizedFacts: z.boolean(),
  mismatches: z.array(nonEmpty),
  sourceSystemsCompared: z.array(localSourceSystemIdSchema).min(2),
  comparedFactCount: z.number().int().nonnegative(),
}).strict()
export type SourceAgnosticismResult = z.infer<typeof sourceAgnosticismResultSchema>

export interface SourceSystemLedgerSnapshot {
  sourceSystemId: string
  facts: readonly ClinicalFact[]
}

function normalizeTimestampSortToken(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : String(ms).padStart(16, '0')
}

function timestampsEqualUtc(left: string | null, right: string | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  if (!Number.isNaN(leftMs) && !Number.isNaN(rightMs)) {
    return leftMs === rightMs
  }
  return false
}

function stableFactSortKey(fact: ClinicalFact): string {
  return [
    fact.category,
    fact.itemCode.system,
    fact.itemCode.code,
    normalizeTimestampSortToken(fact.effectiveAt),
    normalizeTimestampSortToken(fact.reportedAt),
    fact.recordStatus,
    fact.provenance.recordVersion,
    JSON.stringify(fact.value.normalizedValue),
  ].join('|')
}

function valuesDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left === 'number' && typeof right === 'number') {
    return Math.abs(left - right) < 1e-6
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  const leftObj = left as Record<string, unknown>
  const rightObj = right as Record<string, unknown>
  const leftKeys = Object.keys(leftObj)
  const rightKeys = Object.keys(rightObj)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(
    key => Object.prototype.hasOwnProperty.call(rightObj, key) && valuesDeepEqual(leftObj[key], rightObj[key]),
  )
}

export function evaluateSourceAgnosticismResult(
  left: SourceSystemLedgerSnapshot,
  right: SourceSystemLedgerSnapshot,
): SourceAgnosticismResult {
  const mismatches: string[] = []
  const sourceSystemsCompared = [left.sourceSystemId, right.sourceSystemId]

  if (left.sourceSystemId === right.sourceSystemId) {
    mismatches.push(`Expected two distinct source systems, received duplicate '${left.sourceSystemId}'`)
  }
  if (left.facts.length === 0) {
    mismatches.push(`Source system '${left.sourceSystemId}' produced zero clinical facts`)
  }
  if (right.facts.length === 0) {
    mismatches.push(`Source system '${right.sourceSystemId}' produced zero clinical facts`)
  }

  const leftSorted = [...left.facts].sort((a, b) => stableFactSortKey(a).localeCompare(stableFactSortKey(b)))
  const rightSorted = [...right.facts].sort((a, b) => stableFactSortKey(a).localeCompare(stableFactSortKey(b)))

  if (leftSorted.length !== rightSorted.length) {
    mismatches.push(
      `Fact count mismatch: '${left.sourceSystemId}' has ${leftSorted.length} vs '${right.sourceSystemId}' has ${rightSorted.length}`,
    )
  }

  const count = Math.min(leftSorted.length, rightSorted.length)
  for (let i = 0; i < count; i += 1) {
    const l = leftSorted[i]!
    const r = rightSorted[i]!
    const label = `${l.itemCode.system}:${l.itemCode.code}[${i}]`

    if (l.provenance.sourceSystemId !== left.sourceSystemId) {
      mismatches.push(`${label} left provenance.sourceSystemId '${l.provenance.sourceSystemId}' !== '${left.sourceSystemId}'`)
    }
    if (r.provenance.sourceSystemId !== right.sourceSystemId) {
      mismatches.push(`${label} right provenance.sourceSystemId '${r.provenance.sourceSystemId}' !== '${right.sourceSystemId}'`)
    }
    if (l.category !== r.category) {
      mismatches.push(`${label} category mismatch: '${l.category}' vs '${r.category}'`)
    }
    if (!valuesDeepEqual(l.itemCode, r.itemCode)) {
      mismatches.push(`${label} itemCode mismatch: ${JSON.stringify(l.itemCode)} vs ${JSON.stringify(r.itemCode)}`)
    }
    if (!valuesDeepEqual(l.value.normalizedValue, r.value.normalizedValue)) {
      mismatches.push(
        `${label} value.normalizedValue mismatch: ${JSON.stringify(l.value.normalizedValue)} vs ${JSON.stringify(r.value.normalizedValue)}`,
      )
    }
    if (l.method !== r.method) {
      mismatches.push(`${label} method mismatch: ${String(l.method)} vs ${String(r.method)}`)
    }
    if (!valuesDeepEqual(l.specimenOrSite, r.specimenOrSite)) {
      mismatches.push(
        `${label} specimenOrSite mismatch: ${JSON.stringify(l.specimenOrSite)} vs ${JSON.stringify(r.specimenOrSite)}`,
      )
    }
    if (!timestampsEqualUtc(l.effectiveAt, r.effectiveAt)) {
      mismatches.push(`${label} effectiveAt mismatch: ${String(l.effectiveAt)} vs ${String(r.effectiveAt)}`)
    }
    if (!timestampsEqualUtc(l.reportedAt, r.reportedAt)) {
      mismatches.push(`${label} reportedAt mismatch: ${String(l.reportedAt)} vs ${String(r.reportedAt)}`)
    }
    if (l.recordStatus !== r.recordStatus) {
      mismatches.push(`${label} recordStatus mismatch: '${l.recordStatus}' vs '${r.recordStatus}'`)
    }
    if (l.presence !== r.presence) {
      mismatches.push(`${label} presence mismatch: '${l.presence}' vs '${r.presence}'`)
    }
  }

  return sourceAgnosticismResultSchema.parse({
    identicalNormalizedFacts: mismatches.length === 0,
    mismatches,
    sourceSystemsCompared,
    comparedFactCount: count,
  })
}
