import { z } from 'zod'
import { packSourceSummarySchema } from './pack-source.ts'
import { commandResponseSchema } from './his.ts'

export const bedsideQuestionnaireValueInputSchema = z.object({
  booleanValue: z.boolean().nullable().optional(),
  code: z.string().trim().min(1).max(128),
  numberValue: z.number().finite().nullable().optional(),
  textValue: z.string().trim().min(1).max(500).nullable().optional(),
}).strict()
export type BedsideQuestionnaireValueInput = z.infer<typeof bedsideQuestionnaireValueInputSchema>

export const killipClassSchema = z.enum(['I', 'II', 'III', 'IV'])
export type KillipClass = z.infer<typeof killipClassSchema>

export const smokingStatusSchema = z.enum(['current', 'former', 'never'])
export type SmokingStatus = z.infer<typeof smokingStatusSchema>

export const priorBleedingHistorySchema = z.enum(['spontaneous', 'non-spontaneous', 'negative'])
export type PriorBleedingHistory = z.infer<typeof priorBleedingHistorySchema>

export const clinicalRiskAssessmentValuesSchema = z.object({
  anginaEpisodes24h: z.number().int().min(0).max(100).nullable(),
  aspirinUsedLast7Days: z.boolean().nullable(),
  cardiacArrestOnAdmission: z.boolean().nullable(),
  familyHistoryPrematureCad: z.boolean().nullable().default(null),
  killipClass: killipClassSchema.nullable(),
  knownCoronaryStenosisGe50: z.boolean().nullable().default(null),
  priorBleedingHistory: priorBleedingHistorySchema.nullable(),
  smokingStatus: smokingStatusSchema.nullable(),
  stSegmentDeviation: z.boolean().nullable(),
}).strict()
export type ClinicalRiskAssessmentValues = z.infer<typeof clinicalRiskAssessmentValuesSchema>

export const clinicalRiskAssessmentFieldsInputSchema = z.object({
  anginaEpisodes24h: z.number().int().min(0).max(100).nullable().optional(),
  aspirinUsedLast7Days: z.boolean().nullable().optional(),
  cardiacArrestOnAdmission: z.boolean().nullable().optional(),
  familyHistoryPrematureCad: z.boolean().nullable().optional(),
  killipClass: killipClassSchema.nullable().optional(),
  knownCoronaryStenosisGe50: z.boolean().nullable().optional(),
  priorBleedingHistory: priorBleedingHistorySchema.nullable().optional(),
  smokingStatus: smokingStatusSchema.nullable().optional(),
  stSegmentDeviation: z.boolean().nullable().optional(),
}).strict()
export type ClinicalRiskAssessmentFieldsInput = z.infer<typeof clinicalRiskAssessmentFieldsInputSchema>

export const effectiveStSegmentDeviationSchema = z.object({
  source: z.enum(['ecg-report', 'bedside']),
  sourceReference: z.string().min(1),
  value: z.boolean(),
  versionId: z.string().min(1),
}).strict()
export type EffectiveStSegmentDeviation = z.infer<typeof effectiveStSegmentDeviationSchema>

export const clinicalRiskAssessmentRecordSchema = z.object({
  effectiveStSegmentDeviation: effectiveStSegmentDeviationSchema.nullable(),
  observationId: z.string().min(1).nullable(),
  observationVersion: z.string().min(1).nullable(),
  provenanceId: z.string().min(1).nullable(),
  recordedAt: z.iso.datetime({ offset: true }).nullable(),
  recordedBy: z.string().min(1).nullable(),
  revision: z.number().int().nonnegative(),
  values: clinicalRiskAssessmentValuesSchema,
}).strict()
export type ClinicalRiskAssessmentRecord = z.infer<typeof clinicalRiskAssessmentRecordSchema>

const vitalSignsFieldsShape = {
  bloodPressure: z.object({
    diastolicMmHg: z.number().finite().min(20).max(200),
    systolicMmHg: z.number().finite().min(40).max(300),
  }).strict(),
  heightCm: z.number().finite().min(30).max(260).optional(),
  oxygenSaturationPct: z.number().finite().min(40).max(100),
  pulseBpm: z.number().finite().min(20).max(300),
  respirationBpm: z.number().finite().min(4).max(80),
  temperatureC: z.number().finite().min(30).max(45),
  weightKg: z.number().finite().min(1).max(400).optional(),
}

export const inpatientVitalSignsValuesSchema = z.object(vitalSignsFieldsShape).strict().refine(
  value => value.bloodPressure.systolicMmHg > value.bloodPressure.diastolicMmHg,
  {
    message: 'Systolic blood pressure must exceed diastolic blood pressure',
    path: ['bloodPressure', 'systolicMmHg'],
  },
)
export type InpatientVitalSignsValues = z.infer<typeof inpatientVitalSignsValuesSchema>

export const inpatientVitalSignsRecordSchema = z.object({
  bloodPressure: z.object({
    diastolicMmHg: z.number().finite(),
    systolicMmHg: z.number().finite(),
  }).strict(),
  heightCm: z.number().finite().optional(),
  observationId: z.string().min(1),
  observationVersion: z.string().min(1),
  oxygenSaturationPct: z.number().finite(),
  provenanceId: z.string().min(1),
  pulseBpm: z.number().finite(),
  recordedAt: z.iso.datetime({ offset: true }),
  recordedBy: z.string().min(1),
  respirationBpm: z.number().finite(),
  revision: z.number().int().positive(),
  temperatureC: z.number().finite(),
  weightKg: z.number().finite().optional(),
}).strict()
export type InpatientVitalSignsRecord = z.infer<typeof inpatientVitalSignsRecordSchema>

export const inpatientVitalSignsInputSchema = z.object({
  admissionId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  expectedRevision: z.number().int().nonnegative(),
  ...vitalSignsFieldsShape,
}).strict().refine(value => value.bloodPressure.systolicMmHg > value.bloodPressure.diastolicMmHg, {
  message: 'Systolic blood pressure must exceed diastolic blood pressure',
  path: ['bloodPressure', 'systolicMmHg'],
})
export type InpatientVitalSignsInput = z.infer<typeof inpatientVitalSignsInputSchema>

export const inpatientRiskAssessmentInputSchema = z.object({
  admissionId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  expectedRevision: z.number().int().nonnegative(),
  fields: clinicalRiskAssessmentFieldsInputSchema.default({}),
  questionnaireAnswers: z.array(bedsideQuestionnaireValueInputSchema).max(64).optional(),
}).strict()
export type InpatientRiskAssessmentInput = z.infer<typeof inpatientRiskAssessmentInputSchema>

export const outpatientRiskAssessmentInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  fields: clinicalRiskAssessmentFieldsInputSchema.default({}),
  questionnaireAnswers: z.array(bedsideQuestionnaireValueInputSchema).max(64).optional(),
}).strict()
export type OutpatientRiskAssessmentInput = z.infer<typeof outpatientRiskAssessmentInputSchema>

export const outpatientRiskAssessmentOperationInputSchema = outpatientRiskAssessmentInputSchema.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()
export type OutpatientRiskAssessmentOperationInput = z.infer<typeof outpatientRiskAssessmentOperationInputSchema>

export const clinicalScoreIdSchema = z.enum([
  'ckd-epi-2021-egfr',
  'cockcroft-gault-crcl',
  'grace-acs',
  'timi-ua-nstemi',
  'precise-dapt',
  'ascvd-ldl-target',
])
export type ClinicalScoreId = z.infer<typeof clinicalScoreIdSchema>

export const clinicalScoreMissingInputSchema = z.enum([
  'acsPresentation',
  'age',
  'cadOnsetAge',
  'ckdChronicity',
  'sex',
  'heightCm',
  'weightKg',
  'heartRateBpm',
  'systolicBpMmHg',
  'diastolicBpMmHg',
  'serumCreatinine',
  'elevatedCardiacBiomarker',
  'hemoglobin',
  'wbc',
  'totalCholesterol',
  'hdlCholesterol',
  'ldlCholesterol',
  'killipClass',
  'cardiacArrestOnAdmission',
  'anginaEpisodes24h',
  'stSegmentDeviation',
  'aspirinUsedLast7Days',
  'smokingStatus',
  'familyHistoryPrematureCad',
  'knownCoronaryStenosisGe50',
  'pciDaptIndication',
  'priorBleedingHistory',
  'uaNstemiPresentation',
])
export type ClinicalScoreMissingInput = z.infer<typeof clinicalScoreMissingInputSchema>

export const clinicalScoreSourceReferenceSchema = z.object({
  label: z.string().min(1),
  reference: z.string().min(1),
  versionId: z.string().min(1),
}).strict()
export type ClinicalScoreSourceReference = z.infer<typeof clinicalScoreSourceReferenceSchema>

export const ldlGoalEvaluationSchema = z.object({
  atGoal: z.boolean(),
  currentLdlMmolL: z.number().finite().positive(),
  targetLdlMmolL: z.number().finite().positive(),
}).strict()
export type LdlGoalEvaluation = z.infer<typeof ldlGoalEvaluationSchema>

export const clinicalScoreCompleteResultSchema = z.object({
  id: clinicalScoreIdSchema,
  ldlGoalEvaluation: ldlGoalEvaluationSchema.optional(),
  missingInputs: z.tuple([]),
  sourceReferences: z.array(clinicalScoreSourceReferenceSchema),
  status: z.literal('complete'),
  summaryEn: z.string().min(1),
  summaryZh: z.string().min(1),
  tierCode: z.string().min(1),
  tierLabelEn: z.string().min(1),
  tierLabelZh: z.string().min(1),
  titleEn: z.string().min(1),
  titleZh: z.string().min(1),
  unit: z.string().min(1),
  value: z.number().finite(),
}).strict()

export const clinicalScoreIncompleteResultSchema = z.object({
  id: clinicalScoreIdSchema,
  missingInputs: z.array(clinicalScoreMissingInputSchema).min(1),
  sourceReferences: z.array(clinicalScoreSourceReferenceSchema),
  status: z.literal('incomplete'),
  summaryEn: z.string().min(1),
  summaryZh: z.string().min(1),
  tierCode: z.null(),
  tierLabelEn: z.null(),
  tierLabelZh: z.null(),
  titleEn: z.string().min(1),
  titleZh: z.string().min(1),
  unit: z.string().min(1),
  value: z.null(),
}).strict()

export const clinicalScoreResultSchema = z.discriminatedUnion('status', [
  clinicalScoreCompleteResultSchema,
  clinicalScoreIncompleteResultSchema,
])
export type ClinicalScoreResult = z.infer<typeof clinicalScoreResultSchema>

export const clinicalScoreVitalSummarySchema = z.object({
  bloodPressure: z.object({
    diastolicMmHg: z.number().finite(),
    systolicMmHg: z.number().finite(),
  }).strict(),
  heightCm: z.number().finite().optional(),
  observationId: z.string().min(1),
  observationVersion: z.string().min(1),
  oxygenSaturationPct: z.number().finite(),
  pulseBpm: z.number().finite(),
  recordedAt: z.iso.datetime({ offset: true }),
  respirationBpm: z.number().finite(),
  temperatureC: z.number().finite(),
  weightKg: z.number().finite().optional(),
}).strict()
export type ClinicalScoreVitalSummary = z.infer<typeof clinicalScoreVitalSummarySchema>

export const clinicalScoreBundleSchema = z.object({
  encounterId: z.string().min(1),
  encounterVersion: z.string().min(1),
  evaluatedAt: z.iso.datetime({ offset: true }),
  packId: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
  packVersion: z.string().trim().min(1).max(64).optional(),
  riskAssessment: clinicalRiskAssessmentRecordSchema,
  scores: z.array(clinicalScoreResultSchema).length(6),
  sourcePacks: z.array(packSourceSummarySchema).max(32).optional(),
  vitalSigns: clinicalScoreVitalSummarySchema.nullable(),
}).strict()
export type ClinicalScoreBundle = z.infer<typeof clinicalScoreBundleSchema>

export const outpatientRiskAssessmentResponseSchema = commandResponseSchema(z.object({
  encounterVersion: z.string().regex(/^\d+$/),
  riskAssessment: clinicalRiskAssessmentRecordSchema,
}).strict())
export type OutpatientRiskAssessmentResponse = z.infer<typeof outpatientRiskAssessmentResponseSchema>

export const bedsideQuestionnaireItemStateSchema = z.object({
  booleanValue: z.boolean().nullable().optional(),
  code: z.string().trim().min(1).max(128),
  labelZh: z.string().trim().min(1).max(1000),
  numberValue: z.number().finite().nullable().optional(),
  options: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  packIds: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).min(1),
  presence: z.enum(['present', 'absent', 'not-asked']),
  recordedAt: z.iso.datetime({ offset: true }).nullable(),
  recordedBy: z.string().min(1).nullable(),
  textValue: z.string().nullable().optional(),
  unit: z.string().trim().min(1).max(32).optional(),
  valueText: z.string().min(1).max(500),
  valueType: z.enum(['boolean', 'number', 'enum', 'text']),
}).strict()
export type BedsideQuestionnaireItemState = z.infer<typeof bedsideQuestionnaireItemStateSchema>

export const bedsidePackMissingSchema = z.object({
  missingCount: z.number().int().positive().max(128),
  missingItems: z.array(z.object({
    code: z.string().trim().min(1).max(128),
    labelZh: z.string().trim().min(1).max(1000),
  }).strict()).min(1).max(128),
  packId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  titleZh: z.string().trim().min(1).max(200),
}).strict()
export type BedsidePackMissing = z.infer<typeof bedsidePackMissingSchema>

export const bedsideQuestionnaireStateSchema = z.object({
  encounterId: z.string().min(1).max(64),
  encounterVersion: z.string().min(1).max(64),
  items: z.array(bedsideQuestionnaireItemStateSchema).max(128),
  legacyRiskAssessment: clinicalRiskAssessmentRecordSchema,
  /** 按已启用专病包汇总的床旁缺项，只住院填充，门诊恒为空。 */
  packMissing: z.array(bedsidePackMissingSchema).max(32),
  recordedAt: z.iso.datetime({ offset: true }).nullable(),
  revision: z.number().int().nonnegative(),
  subjectId: z.string().min(1).max(64),
  subjectKind: z.enum(['outpatient', 'inpatient']),
}).strict()
export type BedsideQuestionnaireState = z.infer<typeof bedsideQuestionnaireStateSchema>

export const outpatientBedsideQuestionnaireReadInputSchema = z.object({
  caseId: z.string().min(1).max(64),
}).strict()

export const inpatientBedsideQuestionnaireReadInputSchema = z.object({
  admissionId: z.string().min(1).max(64),
}).strict()

export const outpatientBedsideQuestionnaireRecordInputSchema = z.object({
  answers: z.array(bedsideQuestionnaireValueInputSchema).min(1).max(64),
  caseId: z.string().min(1).max(64),
  encounterVersion: z.string().regex(/^\d+$/),
  expectedRevision: z.number().int().nonnegative(),
}).strict()
export type OutpatientBedsideQuestionnaireRecordInput = z.infer<typeof outpatientBedsideQuestionnaireRecordInputSchema>

export const inpatientBedsideQuestionnaireRecordInputSchema = z.object({
  admissionId: z.string().min(1).max(64),
  answers: z.array(bedsideQuestionnaireValueInputSchema).min(1).max(64),
  encounterVersion: z.string().regex(/^\d+$/),
  expectedRevision: z.number().int().nonnegative(),
}).strict()
export type InpatientBedsideQuestionnaireRecordInput = z.infer<typeof inpatientBedsideQuestionnaireRecordInputSchema>

export const bedsideQuestionnaireResponseSchema = commandResponseSchema(bedsideQuestionnaireStateSchema)
export type BedsideQuestionnaireResponse = z.infer<typeof bedsideQuestionnaireResponseSchema>
