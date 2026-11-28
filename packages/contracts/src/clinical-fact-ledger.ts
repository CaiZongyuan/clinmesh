import { z } from 'zod'
import { commandResponseSchema } from './his.ts'

const s = z.string()
const nonEmpty = s.min(1)
const dt = z.iso.datetime({ offset: true })

export const KNOWN_CLINICAL_FACT_SOURCE_SYSTEMS = [
  'clinmesh-his-fhir',
  'clinmesh-visible-source-history',
  'clinmesh-bedside-questionnaire',
] as const

export const DEFAULT_CLINICAL_FACT_MAPPING_VERSION = 'clinmesh-fact-map-v1'
export const DEFAULT_CLINICAL_FACT_HOSPITAL_ID = 'hospital-synthetic-clinmesh'

export const CLINICAL_FACT_CATEGORIES = [
  'diagnosis',
  'allergy',
  'laboratory',
  'examination',
  'vital-sign',
  'medication',
  'procedure',
  'bedside-questionnaire',
] as const

export const clinicalFactCategorySchema = z.enum(CLINICAL_FACT_CATEGORIES)
export type ClinicalFactCategory = z.infer<typeof clinicalFactCategorySchema>

export const clinicalFactItemCodeSchema = z.object({
  code: nonEmpty,
  system: nonEmpty,
  display: nonEmpty,
}).strict()
export type ClinicalFactItemCode = z.infer<typeof clinicalFactItemCodeSchema>

export const clinicalFactNormalizedQuantitySchema = z.object({
  value: z.number().finite(),
  unit: nonEmpty,
}).strict()
export type ClinicalFactNormalizedQuantity = z.infer<typeof clinicalFactNormalizedQuantitySchema>

export const clinicalFactNormalizedCodeSchema = z.object({
  code: nonEmpty,
  system: nonEmpty.optional(),
  display: nonEmpty.optional(),
}).strict()
export type ClinicalFactNormalizedCode = z.infer<typeof clinicalFactNormalizedCodeSchema>

export const clinicalFactNormalizedValueSchema = z.union([
  clinicalFactNormalizedQuantitySchema,
  z.boolean(),
  s,
  z.number().finite(),
  clinicalFactNormalizedCodeSchema,
  z.null(),
])
export type ClinicalFactNormalizedValue = z.infer<typeof clinicalFactNormalizedValueSchema>

export const clinicalFactValueSchema = z.object({
  rawText: s,
  normalizedValue: clinicalFactNormalizedValueSchema,
}).strict()
export type ClinicalFactValue = z.infer<typeof clinicalFactValueSchema>

export const clinicalFactSpecimenOrSiteSchema = z.object({
  label: nonEmpty.nullable(),
  specimenId: nonEmpty.nullable(),
}).strict()
export type ClinicalFactSpecimenOrSite = z.infer<typeof clinicalFactSpecimenOrSiteSchema>

export const clinicalFactProvenanceSchema = z.object({
  recordType: nonEmpty,
  recordId: nonEmpty,
  recordVersion: nonEmpty,
  sourceSystemId: nonEmpty,
}).strict()
export type ClinicalFactProvenance = z.infer<typeof clinicalFactProvenanceSchema>

export const clinicalFactInstitutionScopeSchema = z.enum(['local', 'external'])
export type ClinicalFactInstitutionScope = z.infer<typeof clinicalFactInstitutionScopeSchema>

export const clinicalFactRecordStatusSchema = z.enum(['final', 'amended', 'entered-in-error'])
export type ClinicalFactRecordStatus = z.infer<typeof clinicalFactRecordStatusSchema>

export const clinicalFactPresenceSchema = z.enum(['present', 'absent', 'not-asked'])
export type ClinicalFactPresence = z.infer<typeof clinicalFactPresenceSchema>

export const clinicalFactRelationSchema = z.object({
  supersedesFactId: nonEmpty.nullable(),
  supersededByFactId: nonEmpty.nullable(),
}).strict()
export type ClinicalFactRelation = z.infer<typeof clinicalFactRelationSchema>

export const clinicalFactVerificationStatusSchema = z.enum([
  'provisional',
  'confirmed',
  'not-applicable',
])
export type ClinicalFactVerificationStatus = z.infer<typeof clinicalFactVerificationStatusSchema>

export const clinicalFactQualityFlagSchema = z.enum([
  'suspicious',
  'conflict',
  'external-unverified',
])
export type ClinicalFactQualityFlag = z.infer<typeof clinicalFactQualityFlagSchema>

export const clinicalFactSuspiciousReasonSchema = z.enum([
  'unit-not-allowed',
  'out-of-plausible-range',
  'reported-before-ordered',
  'sex-contradiction',
])
export type ClinicalFactSuspiciousReason = z.infer<typeof clinicalFactSuspiciousReasonSchema>

export const clinicalFactClinicianVerificationSchema = z.object({
  verified: z.boolean(),
  verifiedAt: dt.nullable(),
  verifiedByActorId: nonEmpty.nullable(),
  verifiedByPractitionerId: nonEmpty.nullable(),
  note: s.nullable(),
}).strict()
export type ClinicalFactClinicianVerification = z.infer<typeof clinicalFactClinicianVerificationSchema>

export const clinicalFactSchema = z.object({
  factId: nonEmpty,
  category: clinicalFactCategorySchema,
  itemCode: clinicalFactItemCodeSchema,
  value: clinicalFactValueSchema,
  method: nonEmpty.nullable(),
  specimenOrSite: clinicalFactSpecimenOrSiteSchema.nullable(),
  orderedAt: dt.nullable(),
  effectiveAt: dt.nullable(),
  reportedAt: dt.nullable(),
  provenance: clinicalFactProvenanceSchema,
  institutionScope: clinicalFactInstitutionScopeSchema,
  recordStatus: clinicalFactRecordStatusSchema,
  presence: clinicalFactPresenceSchema,
  relation: clinicalFactRelationSchema,
  verificationStatus: clinicalFactVerificationStatusSchema,
  ingestedAt: dt,
  mappingVersion: nonEmpty,
  qualityFlags: z.array(clinicalFactQualityFlagSchema),
  suspiciousReasons: z.array(clinicalFactSuspiciousReasonSchema),
  conflictingFactIds: z.array(nonEmpty),
  requiresRecheckPrompt: z.boolean(),
  validityDays: z.number().int().positive().nullable(),
  isExpiredAtAsOf: z.boolean(),
  clinicianVerification: clinicalFactClinicianVerificationSchema,
  eligibleForScoringAndRedLine: z.boolean(),
  ineligibleReasons: z.array(nonEmpty),
  abnormal: z.boolean().nullable().optional(),
}).strict()
export type ClinicalFact = z.infer<typeof clinicalFactSchema>

export const clinicalFactLedgerTraceSchema = z.object({
  hospitalId: nonEmpty,
  evaluatedAsOf: dt,
  mappingVersion: nonEmpty,
}).strict()
export type ClinicalFactLedgerTrace = z.infer<typeof clinicalFactLedgerTraceSchema>

export const clinicalFactLedgerSummarySchema = z.object({
  totalFacts: z.number().int().nonnegative(),
  eligibleCount: z.number().int().nonnegative(),
  suspiciousCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  externalUnverifiedCount: z.number().int().nonnegative(),
  verifiedExternalCount: z.number().int().nonnegative(),
  expiredCount: z.number().int().nonnegative(),
  supersededCount: z.number().int().nonnegative(),
  notAskedCount: z.number().int().nonnegative(),
}).strict()
export type ClinicalFactLedgerSummary = z.infer<typeof clinicalFactLedgerSummarySchema>

export const clinicalFactSubjectKindSchema = z.enum(['outpatient', 'inpatient'])
export type ClinicalFactSubjectKind = z.infer<typeof clinicalFactSubjectKindSchema>

export const clinicalFactLedgerSchema = z.object({
  trace: clinicalFactLedgerTraceSchema,
  patientId: nonEmpty,
  subjectKind: clinicalFactSubjectKindSchema,
  subjectId: nonEmpty,
  includeSuperseded: z.boolean(),
  facts: z.array(clinicalFactSchema),
  summary: clinicalFactLedgerSummarySchema,
}).strict()
export type ClinicalFactLedger = z.infer<typeof clinicalFactLedgerSchema>

const commaSeparatedListSchema = s.trim().min(1).max(500)

export const clinicalFactLedgerFilterQuerySchema = z.object({
  asOf: dt.optional(),
  itemCodes: commaSeparatedListSchema.optional(),
  categories: commaSeparatedListSchema.optional(),
  includeSuperseded: z.boolean().optional(),
}).strict()
export type ClinicalFactLedgerFilterQuery = z.infer<typeof clinicalFactLedgerFilterQuerySchema>

export const outpatientClinicalFactLedgerQuerySchema = clinicalFactLedgerFilterQuerySchema.extend({
  caseId: nonEmpty,
}).strict()
export type OutpatientClinicalFactLedgerQuery = z.infer<typeof outpatientClinicalFactLedgerQuerySchema>

export const inpatientClinicalFactLedgerQuerySchema = clinicalFactLedgerFilterQuerySchema.extend({
  admissionId: nonEmpty,
}).strict()
export type InpatientClinicalFactLedgerQuery = z.infer<typeof inpatientClinicalFactLedgerQuerySchema>

export const clinicalFactVerificationDecisionSchema = z.enum(['verified', 'rejected'])
export type ClinicalFactVerificationDecision = z.infer<typeof clinicalFactVerificationDecisionSchema>

export const recordClinicalFactVerificationBodySchema = z.object({
  factId: s.trim().min(1).max(200),
  decision: clinicalFactVerificationDecisionSchema.optional(),
  note: s.trim().min(1).max(500).optional(),
  expectedSourceVersion: s.trim().min(1).max(64).optional(),
}).strict()
export type RecordClinicalFactVerificationBody = z.infer<typeof recordClinicalFactVerificationBodySchema>

export const outpatientClinicalFactVerificationInputSchema = recordClinicalFactVerificationBodySchema.extend({
  caseId: nonEmpty,
}).strict()
export type OutpatientClinicalFactVerificationInput = z.infer<typeof outpatientClinicalFactVerificationInputSchema>

export const inpatientClinicalFactVerificationInputSchema = recordClinicalFactVerificationBodySchema.extend({
  admissionId: nonEmpty,
}).strict()
export type InpatientClinicalFactVerificationInput = z.infer<typeof inpatientClinicalFactVerificationInputSchema>

export const clinicalFactVerificationRecordSchema = z.object({
  verificationId: nonEmpty,
  subjectKind: clinicalFactSubjectKindSchema,
  subjectId: nonEmpty,
  patientId: nonEmpty,
  factId: nonEmpty,
  itemCode: nonEmpty,
  sourceReference: nonEmpty,
  sourceVersion: nonEmpty,
  decision: clinicalFactVerificationDecisionSchema,
  note: s.nullable(),
  verifiedAt: dt,
  verifiedByActorId: nonEmpty,
  verifiedByPractitionerId: nonEmpty.nullable(),
  verifiedByPractitionerRoleId: nonEmpty.nullable(),
}).strict()
export type ClinicalFactVerificationRecord = z.infer<typeof clinicalFactVerificationRecordSchema>

export const clinicalFactVerificationDataSchema = z.object({
  verification: clinicalFactVerificationRecordSchema,
  fact: clinicalFactSchema,
}).strict()
export type ClinicalFactVerificationData = z.infer<typeof clinicalFactVerificationDataSchema>

export const clinicalFactVerificationResponseSchema = commandResponseSchema(clinicalFactVerificationDataSchema)
export type ClinicalFactVerificationResponse = z.infer<typeof clinicalFactVerificationResponseSchema>
