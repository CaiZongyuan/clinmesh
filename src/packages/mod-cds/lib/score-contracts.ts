import { z } from 'zod';

export const killipClassSchema = z.enum(['I', 'II', 'III', 'IV'])
export type KillipClass = z.infer<typeof killipClassSchema>

export const smokingStatusSchema = z.enum(['current', 'former', 'never'])
export type SmokingStatus = z.infer<typeof smokingStatusSchema>

export const priorBleedingHistorySchema = z.enum(['spontaneous', 'non-spontaneous', 'negative'])
export type PriorBleedingHistory = z.infer<typeof priorBleedingHistorySchema>

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
  'severeAscvdEventCount', 'priorCoronaryRevascularization',
  'hypertensionHistory', 'diabetesHistory',
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
