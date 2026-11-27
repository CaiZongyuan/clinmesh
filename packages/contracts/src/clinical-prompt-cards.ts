import { z } from 'zod'
import { clinicalFactSubjectKindSchema } from './clinical-fact-ledger.ts'
import { clinicalOverrideReasonSchema } from './clinical-quality.ts'
import { diseasePackSlugSchema } from './disease-pack-triggers.ts'
import { commandResponseSchema } from './his.ts'
import {
  SIMULATION_TRIAL_DISCLAIMER_ZH,
  knowledgeAnchorCitationSchema,
  knowledgePublicationStatusSchema,
} from './knowledge-claims.ts'

const boundedCode = z.string().trim().min(1).max(128)
const boundedId = z.string().trim().min(1).max(128)
const boundedVersion = z.string().trim().min(1).max(64)
const nonEmptyId = z.string().trim().min(1).max(128)
const nonEmptyText = z.string().trim().min(1).max(1000)
const dt = z.iso.datetime({ offset: true })

export const SYNC_CLINICAL_PROMPT_TIMINGS = [
  'encounter-open',
  'order-draft-select',
  'order-sign',
  'encounter-complete',
  'pci-plan',
  'discharge',
] as const

export const ASYNC_CLINICAL_PROMPT_TIMINGS = [
  'report-arrived',
] as const

export const clinicalPromptTimingSchema = z.enum([
  ...SYNC_CLINICAL_PROMPT_TIMINGS,
  ...ASYNC_CLINICAL_PROMPT_TIMINGS,
])
export type ClinicalPromptTiming = z.infer<typeof clinicalPromptTimingSchema>

export const clinicalPromptIndicatorSchema = z.enum(['info', 'warning', 'critical'])
export type ClinicalPromptIndicator = z.infer<typeof clinicalPromptIndicatorSchema>

export const clinicalPromptBlockingTierSchema = z.enum(['none', 'alert', 'red-line'])
export type ClinicalPromptBlockingTier = z.infer<typeof clinicalPromptBlockingTierSchema>

export const clinicalPromptStatusSchema = z.enum([
  'active',
  'dismissed',
  'superseded',
  'retired',
  'blocked-by-safety-filter',
])
export type ClinicalPromptStatus = z.infer<typeof clinicalPromptStatusSchema>

export const clinicalPromptDeliveryModeSchema = z.enum(['display', 'silent'])
export type ClinicalPromptDeliveryMode = z.infer<typeof clinicalPromptDeliveryModeSchema>

export const clinicalPromptCategorySchema = z.enum([
  'rule-out-checklist',
  'missing-fact',
  'recommendation',
  'guideline-advice',
  'quality-gate',
  'order-set-risk',
  'indication-alert',
  'inapplicable-population',
  'recognition',
  'phenotype-candidate',
  'exit-summary',
  'longitudinal-comparison',
])
export type ClinicalPromptCategory = z.infer<typeof clinicalPromptCategorySchema>

export const clinicalPromptDiffStatusSchema = z.enum([
  'unchanged',
  'added',
  'updated',
  'retired-hidden',
])
export type ClinicalPromptDiffStatus = z.infer<typeof clinicalPromptDiffStatusSchema>

export const clinicalPromptSafetyBlockReasonSchema = z.enum([
  'allergy-conflict',
  'red-line-violation',
  'forbidden-action',
  'inapplicable-population',
  'invalid-citation',
])
export type ClinicalPromptSafetyBlockReason = z.infer<typeof clinicalPromptSafetyBlockReasonSchema>

export const clinicalPromptKnowledgeStatusSchema = z.enum([
  ...knowledgePublicationStatusSchema.options,
  'retired',
])
export type ClinicalPromptKnowledgeStatus = z.infer<typeof clinicalPromptKnowledgeStatusSchema>

export const clinicalPromptSourceSchema = z.object({
  citation: knowledgeAnchorCitationSchema.optional(),
  claimId: boundedId.optional(),
  label: nonEmptyText,
  topicId: boundedId.optional(),
}).strict()
export type ClinicalPromptSource = z.infer<typeof clinicalPromptSourceSchema>

export const clinicalPromptSuggestionSchema = z.object({
  actionKind: z.enum([
    'draft-order',
    'draft-medication',
    'draft-order-set',
    'record-bedside-item',
    'review-guideline',
    'review-differential',
    'verify-external-fact',
  ]),
  candidateClasses: z.array(boundedCode).max(16).optional(),
  catalogItemId: boundedId.optional(),
  doseText: z.string().trim().min(1).max(256).optional(),
  frequencyCode: z.string().trim().min(1).max(128).optional(),
  id: boundedId,
  isDraftOnly: z.literal(true).default(true),
  itemCodes: z.array(boundedCode).max(32).optional(),
  labelZh: nonEmptyText,
  medicationKey: boundedId.optional(),
  routeCode: z.string().trim().min(1).max(64).optional(),
}).strict()
export type ClinicalPromptSuggestion = z.infer<typeof clinicalPromptSuggestionSchema>

export const clinicalPromptFactVersionRefSchema = z.object({
  factId: nonEmptyId,
  itemCode: boundedCode.optional(),
  recordId: nonEmptyId,
  recordType: nonEmptyId,
  recordVersion: nonEmptyId,
}).strict()
export type ClinicalPromptFactVersionRef = z.infer<typeof clinicalPromptFactVersionRefSchema>

export const clinicalPromptRiskTagSchema = z.object({
  id: diseasePackSlugSchema,
  labelZh: nonEmptyText,
  severity: clinicalPromptIndicatorSchema,
}).strict()
export type ClinicalPromptRiskTag = z.infer<typeof clinicalPromptRiskTagSchema>

export const clinicalPromptLongitudinalComparisonSchema = z.object({
  currentValueText: nonEmptyText,
  labelZh: nonEmptyText,
  previousValueText: nonEmptyText,
  unit: z.string().trim().min(1).max(32).optional(),
}).strict()
export type ClinicalPromptLongitudinalComparison = z.infer<typeof clinicalPromptLongitudinalComparisonSchema>

export const clinicalPromptDismissalRecordSchema = z.object({
  auditId: nonEmptyId,
  dismissedAt: dt,
  dismissedByActorId: nonEmptyId,
  note: z.string().trim().min(1).max(500),
  reasonCode: clinicalOverrideReasonSchema,
}).strict()
export type ClinicalPromptDismissalRecord = z.infer<typeof clinicalPromptDismissalRecordSchema>

export const clinicalPromptRuleOutItemSchema = z.object({
  basedOnFactVersions: z.array(clinicalPromptFactVersionRefSchema).max(16).default([]),
  id: diseasePackSlugSchema,
  itemCodes: z.array(boundedCode).max(32),
  labelZh: nonEmptyText,
  purposeZh: nonEmptyText,
  resultText: z.string().trim().min(1).max(1000).optional(),
  status: z.enum(['not-ordered', 'ordered', 'resulted']),
}).strict()
export type ClinicalPromptRuleOutItem = z.infer<typeof clinicalPromptRuleOutItemSchema>

export const clinicalPromptAttachTargetsSchema = z.object({
  candidateClasses: z.array(boundedCode).max(16),
  catalogItemIds: z.array(boundedId).max(32),
}).strict()
export type ClinicalPromptAttachTargets = z.infer<typeof clinicalPromptAttachTargetsSchema>

export const clinicalPromptCardSchema = z.object({
  /** 提示应挂靠的候选药品类别与目录项（如组套内带出血风险的药品行），无挂靠目标时为空。 */
  attachTargets: clinicalPromptAttachTargetsSchema.nullable().default(null),
  basedOnFactVersions: z.array(clinicalPromptFactVersionRefSchema).max(64).default([]),
  blockingTier: clinicalPromptBlockingTierSchema.default('none'),
  cardId: boundedId,
  category: clinicalPromptCategorySchema,
  deliveryMode: clinicalPromptDeliveryModeSchema.default('display'),
  detail: z.string().trim().min(1).max(4000),
  diffStatus: clinicalPromptDiffStatusSchema.nullable().default(null),
  dismissal: clinicalPromptDismissalRecordSchema.nullable().default(null),
  indicator: clinicalPromptIndicatorSchema,
  knowledgeSnapshotVersion: boundedVersion.nullable(),
  knowledgeStatus: clinicalPromptKnowledgeStatusSchema,
  longitudinalComparison: clinicalPromptLongitudinalComparisonSchema.nullable().default(null),
  overrideReasons: z.array(clinicalOverrideReasonSchema).max(12).default([]),
  packId: diseasePackSlugSchema.nullable(),
  packVersion: boundedVersion.nullable(),
  riskTags: z.array(clinicalPromptRiskTagSchema).max(32).default([]),
  ruleOutItems: z.array(clinicalPromptRuleOutItemSchema).max(32).default([]),
  sideBySideGroupKey: boundedId.nullable().default(null),
  source: clinicalPromptSourceSchema,
  stale: z.boolean().default(false),
  staleReason: nonEmptyText.nullable().default(null),
  status: clinicalPromptStatusSchema.default('active'),
  suggestions: z.array(clinicalPromptSuggestionSchema).max(16).default([]),
  summary: nonEmptyText,
  timing: clinicalPromptTimingSchema,
  trialBadgeZh: z.literal('试用版').nullable().default(null),
  trialDisclaimerZh: z.literal(SIMULATION_TRIAL_DISCLAIMER_ZH).nullable().default(null),
}).strict().superRefine((card, ctx) => {
  if (card.knowledgeStatus === 'auto-verified') {
    if (card.trialBadgeZh !== '试用版') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'auto-verified prompt cards must carry trialBadgeZh = "试用版"',
        path: ['trialBadgeZh'],
      })
    }
    if (card.trialDisclaimerZh !== SIMULATION_TRIAL_DISCLAIMER_ZH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `auto-verified prompt cards must carry trialDisclaimerZh = "${SIMULATION_TRIAL_DISCLAIMER_ZH}"`,
        path: ['trialDisclaimerZh'],
      })
    }
  }
})
export type ClinicalPromptCard = z.infer<typeof clinicalPromptCardSchema>

export const clinicalPromptSafetyBlockSchema = z.object({
  auditId: nonEmptyId.optional(),
  blockedAt: dt.optional(),
  blockedReason: clinicalPromptSafetyBlockReasonSchema,
  cardId: boundedId,
  cardSummary: nonEmptyText,
  detailZh: nonEmptyText,
  packId: diseasePackSlugSchema.nullable(),
  ruleId: boundedId,
  suggestionIds: z.array(boundedId).max(16).default([]),
  timing: clinicalPromptTimingSchema,
}).strict()
export type ClinicalPromptSafetyBlock = z.infer<typeof clinicalPromptSafetyBlockSchema>

export const clinicalPromptSideBySideGroupSchema = z.object({
  cardIds: z.array(boundedId).min(1).max(32),
  groupKey: boundedId,
  packIds: z.array(diseasePackSlugSchema).min(1).max(16),
}).strict()
export type ClinicalPromptSideBySideGroup = z.infer<typeof clinicalPromptSideBySideGroupSchema>

export const clinicalPromptReevaluateDiffSchema = z.object({
  cardId: boundedId,
  claimId: boundedId.nullable().default(null),
  diffStatus: clinicalPromptDiffStatusSchema,
  packId: diseasePackSlugSchema.nullable(),
  summary: nonEmptyText,
}).strict()
export type ClinicalPromptReevaluateDiff = z.infer<typeof clinicalPromptReevaluateDiffSchema>

export const clinicalPromptHistoricalReplaySchema = z.object({
  asOf: dt,
  baselineSnapshotVersions: z.record(diseasePackSlugSchema, boundedVersion),
  latestAsOf: dt.nullable(),
  latestSnapshotVersions: z.record(diseasePackSlugSchema, boundedVersion),
  reevaluated: z.boolean(),
  retiredHiddenClaimIds: z.array(boundedId).max(64).default([]),
}).strict()
export type ClinicalPromptHistoricalReplay = z.infer<typeof clinicalPromptHistoricalReplaySchema>

export const clinicalPromptBundleSchema = z.object({
  blockedAuditCount: z.number().int().nonnegative(),
  blockedRecords: z.array(clinicalPromptSafetyBlockSchema).max(64).default([]),
  cards: z.array(clinicalPromptCardSchema),
  evaluatedAt: dt,
  historicalReplay: clinicalPromptHistoricalReplaySchema.nullable(),
  llmInvocationCount: z.number().int().nonnegative(),
  reevaluateDiffs: z.array(clinicalPromptReevaluateDiffSchema).max(128).optional(),
  sideBySideGroups: z.array(clinicalPromptSideBySideGroupSchema).max(32),
  subjectId: nonEmptyId,
  subjectKind: clinicalFactSubjectKindSchema,
}).strict()
export type ClinicalPromptBundle = z.infer<typeof clinicalPromptBundleSchema>

export const clinicalPromptReadQuerySchema = z.object({
  asOf: dt.optional(),
  candidateMedicationClasses: z.string().trim().min(1).max(500).optional(),
  catalogItemId: z.string().trim().min(1).max(128).optional(),
  includeDismissed: z.boolean().optional(),
  includeSilent: z.boolean().optional(),
  reevaluateWithLatestKnowledge: z.boolean().optional(),
  selectedTemplateId: z.string().trim().min(1).max(64).optional(),
  timing: clinicalPromptTimingSchema.optional(),
}).strict()
export type ClinicalPromptReadQuery = z.infer<typeof clinicalPromptReadQuerySchema>

export const outpatientClinicalPromptReadInputSchema = clinicalPromptReadQuerySchema.extend({
  caseId: nonEmptyId,
}).strict()
export type OutpatientClinicalPromptReadInput = z.infer<typeof outpatientClinicalPromptReadInputSchema>

export const inpatientClinicalPromptReadInputSchema = clinicalPromptReadQuerySchema.extend({
  admissionId: nonEmptyId,
}).strict()
export type InpatientClinicalPromptReadInput = z.infer<typeof inpatientClinicalPromptReadInputSchema>

export const clinicalPromptDismissBodySchema = z.object({
  note: z.string().trim().min(4).max(500),
  packId: diseasePackSlugSchema.optional(),
  reasonCode: clinicalOverrideReasonSchema,
  timing: clinicalPromptTimingSchema.optional(),
}).strict()
export type ClinicalPromptDismissBody = z.infer<typeof clinicalPromptDismissBodySchema>

export const outpatientClinicalPromptDismissInputSchema = clinicalPromptDismissBodySchema.extend({
  cardId: boundedId,
  caseId: nonEmptyId,
}).strict()
export type OutpatientClinicalPromptDismissInput = z.infer<typeof outpatientClinicalPromptDismissInputSchema>

export const inpatientClinicalPromptDismissInputSchema = clinicalPromptDismissBodySchema.extend({
  admissionId: nonEmptyId,
  cardId: boundedId,
}).strict()
export type InpatientClinicalPromptDismissInput = z.infer<typeof inpatientClinicalPromptDismissInputSchema>

export const clinicalPromptDismissResponseSchema = commandResponseSchema(clinicalPromptCardSchema)
export type ClinicalPromptDismissResponse = z.infer<typeof clinicalPromptDismissResponseSchema>
