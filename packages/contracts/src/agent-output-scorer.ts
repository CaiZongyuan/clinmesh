import { z } from 'zod'
import {
  clinicalFactCategorySchema,
  clinicalFactSubjectKindSchema,
} from './clinical-fact-ledger.ts'
import {
  diseasePackSlugSchema,
  diseasePackTriggerNodeSchema,
} from './disease-pack-triggers.ts'

export const UNEVALUATED_AGENT_OUTPUT_LABEL_ZH = 'Agent 输出未评测' as const
export const EVALUATED_SIMULATION_LABEL_ZH = '受控流仿真已评测' as const
export const EVALUATED_LIVE_AUTHORIZED_LABEL_ZH = '真实模型本次授权已评测' as const
export const SIMULATION_SCORING_DISCLAIMER_ZH = '仿真评测（受控模型流），不代表真实模型临床效果' as const

const dt = z.iso.datetime({ offset: true })
const boundedId = z.string().trim().min(1).max(128)
const boundedLabel = z.string().trim().min(1).max(500)
const boundedText = z.string().trim().min(1).max(4000)
const boundedVersion = z.string().trim().min(1).max(64)
const nonEmpty = z.string().trim().min(1).max(500)

export const agentScoringRubricFactVerificationSchema = z.object({
  itemCodes: z.array(nonEmpty).min(1),
  maxValue: z.number().finite().optional(),
  minValue: z.number().finite().optional(),
  unit: z.string().trim().min(1).max(64).optional(),
}).strict().superRefine((value, ctx) => {
  if (
    value.minValue !== undefined
    && value.maxValue !== undefined
    && value.minValue > value.maxValue
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'factVerification minValue cannot exceed maxValue',
      path: ['minValue'],
    })
  }
})
export type AgentScoringRubricFactVerification = z.infer<typeof agentScoringRubricFactVerificationSchema>

export const agentScoringRubricItemSchema = z.object({
  expectedPatterns: z.array(nonEmpty).min(1),
  factVerification: agentScoringRubricFactVerificationSchema.optional(),
  id: boundedId,
  labelZh: boundedLabel,
  omissionPenaltyPoints: z.number().nonnegative().finite(),
  positivePoints: z.number().positive().finite(),
  requiredWhenCondition: diseasePackTriggerNodeSchema.optional(),
}).strict()
export type AgentScoringRubricItem = z.infer<typeof agentScoringRubricItemSchema>

export const agentScoringRubricSchema = z.object({
  fabricationPenaltyPoints: z.number().positive().finite().default(5),
  items: z.array(agentScoringRubricItemSchema).min(1),
  packId: diseasePackSlugSchema,
  rubricId: boundedId,
  taskId: boundedId,
  version: boundedVersion,
}).strict()
export type AgentScoringRubric = z.infer<typeof agentScoringRubricSchema>
export type AgentScoringRubricInput = z.input<typeof agentScoringRubricSchema>

export const draftStructuredFactClaimSchema = z.object({
  category: clinicalFactCategorySchema.optional(),
  claimId: boundedId,
  claimedNumericValue: z.number().finite().optional(),
  claimedPresent: z.boolean(),
  claimedUnit: z.string().trim().min(1).max(64).optional(),
  expectedResultSummary: boundedText.optional(),
  itemCode: boundedId.optional(),
  statementZh: boundedText,
}).strict()
export type DraftStructuredFactClaim = z.infer<typeof draftStructuredFactClaimSchema>

export const agentDraftScoringModeSchema = z.enum(['controlled-stream', 'live-model'])
export type AgentDraftScoringMode = z.infer<typeof agentDraftScoringModeSchema>

export const liveModelScoringPermitSchema = z.object({
  authorizedAt: dt,
  authorizedByActorId: boundedId,
  explicitUserPermissionGranted: z.literal(true),
  runId: boundedId,
}).strict()
export type LiveModelScoringPermit = z.infer<typeof liveModelScoringPermitSchema>

export const evaluateAgentOutputInputSchema = z.object({
  asOf: dt.optional(),
  clinicianFinalFields: z.record(z.string(), z.string()).optional(),
  draftFields: z.record(z.string(), z.string()),
  draftText: z.string().trim().min(1).max(20000),
  liveRunPermit: liveModelScoringPermitSchema.optional(),
  mode: agentDraftScoringModeSchema,
  rubric: agentScoringRubricSchema,
  structuredClaims: z.array(draftStructuredFactClaimSchema).default([]),
  subjectId: boundedId.optional(),
  subjectKind: clinicalFactSubjectKindSchema.optional(),
}).strict()
export type EvaluateAgentOutputInput = z.infer<typeof evaluateAgentOutputInputSchema>
export type EvaluateAgentOutputRequestInput = z.input<typeof evaluateAgentOutputInputSchema>

export const agentOutputEvaluationBadgeSchema = z.discriminatedUnion('status', [
  z.object({
    labelZh: z.literal(UNEVALUATED_AGENT_OUTPUT_LABEL_ZH),
    status: z.literal('unevaluated'),
  }).strict(),
  z.object({
    disclaimerZh: z.literal(SIMULATION_SCORING_DISCLAIMER_ZH),
    labelZh: z.literal(EVALUATED_SIMULATION_LABEL_ZH),
    status: z.literal('evaluated-simulation'),
  }).strict(),
  z.object({
    labelZh: z.literal(EVALUATED_LIVE_AUTHORIZED_LABEL_ZH),
    runId: boundedId,
    status: z.literal('evaluated-live-authorized'),
  }).strict(),
])
export type AgentOutputEvaluationBadge = z.infer<typeof agentOutputEvaluationBadgeSchema>

export const agentFactCoverageStatusSchema = z.enum([
  'covered-accurate',
  'covered-inaccurate',
  'omitted',
  'not-applicable',
])
export type AgentFactCoverageStatus = z.infer<typeof agentFactCoverageStatusSchema>

export const agentFactCoverageItemSchema = z.object({
  labelZh: boundedLabel,
  matchedLedgerFactIds: z.array(nonEmpty),
  pointsDelta: z.number().finite(),
  reasonZh: boundedText,
  rubricItemId: boundedId,
  status: agentFactCoverageStatusSchema,
}).strict()
export type AgentFactCoverageItem = z.infer<typeof agentFactCoverageItemSchema>

export const agentFabricationReasonCodeSchema = z.enum([
  'NONEXISTENT_LAB_OR_EXAM',
  'CONTRADICTORY_VALUE',
  'UNVERIFIED_EXTERNAL_USED_AS_FACT',
])
export type AgentFabricationReasonCode = z.infer<typeof agentFabricationReasonCodeSchema>

export const agentFabricationFindingSchema = z.object({
  claimId: boundedId,
  itemCode: boundedId.optional(),
  penaltyPoints: z.number().positive().finite(),
  reasonCode: agentFabricationReasonCodeSchema,
  reasonZh: boundedText,
  relatedLedgerFactIds: z.array(nonEmpty),
  statementZh: boundedText,
}).strict()
export type AgentFabricationFinding = z.infer<typeof agentFabricationFindingSchema>

export const clinicianFieldEditStatusSchema = z.enum([
  'unchanged',
  'modified',
  'added',
  'deleted',
])
export type ClinicianFieldEditStatus = z.infer<typeof clinicianFieldEditStatusSchema>

export const clinicianFieldEditDeltaSchema = z.object({
  addedChars: z.number().int().nonnegative(),
  draftChars: z.number().int().nonnegative(),
  editRatio: z.number().min(0).max(1),
  fieldKey: nonEmpty,
  finalChars: z.number().int().nonnegative(),
  removedChars: z.number().int().nonnegative(),
  status: clinicianFieldEditStatusSchema,
}).strict()
export type ClinicianFieldEditDelta = z.infer<typeof clinicianFieldEditDeltaSchema>

export const clinicianEditMetricsSchema = z.object({
  addedFieldsCount: z.number().int().nonnegative(),
  deletedFieldsCount: z.number().int().nonnegative(),
  fields: z.array(clinicianFieldEditDeltaSchema),
  modifiedFieldsCount: z.number().int().nonnegative(),
  overallEditRatio: z.number().min(0).max(1),
  totalAddedChars: z.number().int().nonnegative(),
  totalFields: z.number().int().nonnegative(),
  totalRemovedChars: z.number().int().nonnegative(),
  unchangedFieldsCount: z.number().int().nonnegative(),
}).strict()
export type ClinicianEditMetrics = z.infer<typeof clinicianEditMetricsSchema>

export const agentOutputScoreResultSchema = z.object({
  badge: agentOutputEvaluationBadgeSchema,
  clinicianEditMetrics: clinicianEditMetricsSchema.nullable(),
  coverageItems: z.array(agentFactCoverageItemSchema),
  evaluatedAt: dt,
  fabricationPenalty: z.number().nonnegative().finite(),
  fabrications: z.array(agentFabricationFindingSchema),
  keyFactCoverageRate: z.number().min(0).max(1),
  maxPossiblePositiveScore: z.number().nonnegative().finite(),
  mode: agentDraftScoringModeSchema,
  netScore: z.number().finite(),
  omissionPenalty: z.number().nonnegative().finite(),
  omissions: z.array(agentFactCoverageItemSchema),
  packId: diseasePackSlugSchema,
  positiveScore: z.number().nonnegative().finite(),
  rubricId: boundedId,
  taskId: boundedId,
  zeroLiveModelCalls: z.boolean(),
}).strict()
export type AgentOutputScoreResult = z.infer<typeof agentOutputScoreResultSchema>

export const agentOutputEvaluationStateSchema = z.object({
  badge: agentOutputEvaluationBadgeSchema,
  scoreResult: agentOutputScoreResultSchema.nullable(),
}).strict()
export type AgentOutputEvaluationState = z.infer<typeof agentOutputEvaluationStateSchema>

export function createUnevaluatedAgentOutputState(): {
  badge: { labelZh: typeof UNEVALUATED_AGENT_OUTPUT_LABEL_ZH; status: 'unevaluated' }
  scoreResult: null
} {
  return {
    badge: {
      labelZh: UNEVALUATED_AGENT_OUTPUT_LABEL_ZH,
      status: 'unevaluated',
    },
    scoreResult: null,
  }
}
