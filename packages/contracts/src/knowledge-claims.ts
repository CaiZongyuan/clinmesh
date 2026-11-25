import { z } from 'zod'
import {
  diseasePackSha256Schema,
  diseasePackSlugSchema,
  diseasePackTriggerNodeSchema,
} from './disease-pack-triggers.ts'

export const SIMULATION_TRIAL_DISCLAIMER_ZH = '未经医生检查，仅用于仿真' as const

const dt = z.iso.datetime({ offset: true })
const boundedId = z.string().trim().min(1).max(128)
const boundedVersion = z.string().trim().min(1).max(64)
const boundedTitle = z.string().trim().min(1).max(500)
const boundedText = z.string().trim().min(1).max(4000)

export const knowledgePublicationStatusSchema = z.enum([
  'imported',
  'draft',
  'concept-mapped',
  'auto-verified',
  'clinician-reviewed',
  'published',
  'rejected',
  'superseded',
  'retracted',
])
export type KnowledgePublicationStatus = z.infer<typeof knowledgePublicationStatusSchema>

export const clinicalReviewerRecordSchema = z.object({
  licenseVerified: z.literal(true),
  nameZh: boundedId,
  reviewerId: boundedId,
  specialty: boundedId,
}).strict()
export type ClinicalReviewerRecord = z.infer<typeof clinicalReviewerRecordSchema>

export const knowledgeAnchorCitationSchema = z.object({
  locator: z.string().trim().min(1).max(256).optional(),
  page: z.number().int().positive(),
  quoteFragment: z.string().trim().min(1).max(2000),
  sha256: diseasePackSha256Schema,
  sourceId: z.string().trim().min(1).max(256),
  title: boundedTitle,
  version: boundedVersion,
}).strict()
export type KnowledgeAnchorCitation = z.infer<typeof knowledgeAnchorCitationSchema>

const REVIEWER_REQUIRED_STATUSES = new Set<KnowledgePublicationStatus>(['clinician-reviewed', 'published'])

function enforceReviewerRequirementForPublication(
  entry: { readonly id: string; readonly reviewerId: string | null; readonly status: KnowledgePublicationStatus },
  ctx: z.RefinementCtx,
  kindLabel: string,
): void {
  if (REVIEWER_REQUIRED_STATUSES.has(entry.status) && (entry.reviewerId === null || entry.reviewerId.trim().length === 0)) {
    ctx.addIssue({
      code: 'custom',
      message: `${kindLabel} ${entry.id} with status '${entry.status}' requires a non-empty reviewerId`,
      path: ['reviewerId'],
    })
  }
}

export const knowledgeTopicCardSchema = z.object({
  effectiveFrom: dt,
  id: boundedId,
  limitationsZh: z.array(z.string().trim().min(1).max(2000)).min(1),
  navigationZh: boundedText,
  packId: diseasePackSlugSchema,
  references: z.array(knowledgeAnchorCitationSchema).min(1),
  reviewerId: boundedId.nullable().default(null),
  status: knowledgePublicationStatusSchema,
  supersededByVersion: boundedVersion.optional(),
  titleEn: boundedTitle.optional(),
  titleZh: boundedTitle,
  version: boundedVersion,
}).strict().superRefine((topic, ctx) => {
  enforceReviewerRequirementForPublication(topic, ctx, 'Knowledge topic')
})
export type KnowledgeTopicCard = z.infer<typeof knowledgeTopicCardSchema>

export const knowledgeClaimSchema = z.object({
  anchor: knowledgeAnchorCitationSchema,
  applicabilityCondition: diseasePackTriggerNodeSchema,
  associatedConceptCodes: z.array(boundedId).min(1),
  effectiveFrom: dt,
  id: boundedId,
  packId: diseasePackSlugSchema,
  reviewerId: boundedId.nullable().default(null),
  statementZh: boundedText,
  status: knowledgePublicationStatusSchema,
  supersededByClaimId: boundedId.optional(),
  topicId: boundedId,
  version: boundedVersion,
}).strict().superRefine((claim, ctx) => {
  enforceReviewerRequirementForPublication(claim, ctx, 'Knowledge claim')
})
export type KnowledgeClaim = z.infer<typeof knowledgeClaimSchema>

export const knowledgeSnapshotSchema = z.object({
  claims: z.array(knowledgeClaimSchema),
  effectiveFrom: dt,
  snapshotVersion: boundedVersion,
  topics: z.array(knowledgeTopicCardSchema),
}).strict()
export type KnowledgeSnapshot = z.infer<typeof knowledgeSnapshotSchema>

export const knowledgeDisplayStageSchema = z.enum(['试用版', '正式版', '未发布', '已退役'])
export type KnowledgeDisplayStage = z.infer<typeof knowledgeDisplayStageSchema>

export const evaluatedKnowledgeClaimSchema = z.object({
  active: z.boolean(),
  anchor: knowledgeAnchorCitationSchema,
  anchorValid: z.boolean(),
  applicable: z.boolean(),
  associatedConceptCodes: z.array(z.string().min(1)),
  deactivationReasons: z.array(z.string().min(1)),
  displayStageZh: knowledgeDisplayStageSchema,
  effectiveFrom: dt,
  id: z.string().min(1),
  matchedFactIds: z.array(z.string().min(1)),
  packId: diseasePackSlugSchema,
  reviewerId: z.string().min(1).nullable(),
  statementZh: z.string().min(1),
  status: knowledgePublicationStatusSchema,
  supersededByClaimId: z.string().min(1).optional(),
  topicId: z.string().min(1),
  trialDisclaimerZh: z.literal(SIMULATION_TRIAL_DISCLAIMER_ZH).nullable(),
  version: z.string().min(1),
}).strict()
export type EvaluatedKnowledgeClaim = z.infer<typeof evaluatedKnowledgeClaimSchema>

export const evaluatedKnowledgeTopicSchema = z.object({
  active: z.boolean(),
  activeClaimCount: z.number().int().nonnegative(),
  deactivationReasons: z.array(z.string().min(1)),
  displayStageZh: knowledgeDisplayStageSchema,
  effectiveFrom: dt,
  id: z.string().min(1),
  limitationsZh: z.array(z.string().min(1)),
  navigationZh: z.string().min(1),
  packId: diseasePackSlugSchema,
  references: z.array(knowledgeAnchorCitationSchema),
  referencesValid: z.boolean(),
  reviewerId: z.string().min(1).nullable(),
  status: knowledgePublicationStatusSchema,
  supersededByVersion: z.string().min(1).optional(),
  titleEn: z.string().min(1).optional(),
  titleZh: z.string().min(1),
  totalClaimCount: z.number().int().nonnegative(),
  trialDisclaimerZh: z.literal(SIMULATION_TRIAL_DISCLAIMER_ZH).nullable(),
  version: z.string().min(1),
}).strict()
export type EvaluatedKnowledgeTopic = z.infer<typeof evaluatedKnowledgeTopicSchema>

export const knowledgeVersionComparisonSchema = z.object({
  addedClaimIds: z.array(z.string().min(1)),
  baselineSnapshotVersion: z.string().min(1),
  latestSnapshotVersion: z.string().min(1),
  removedOrRetiredClaimIds: z.array(z.string().min(1)),
  statementChanges: z.array(z.object({
    claimId: z.string().min(1),
    fromStatementZh: z.string().min(1),
    toStatementZh: z.string().min(1),
  }).strict()),
  statusChanges: z.array(z.object({
    claimId: z.string().min(1),
    fromStatus: knowledgePublicationStatusSchema,
    toStatus: knowledgePublicationStatusSchema,
  }).strict()),
}).strict()
export type KnowledgeVersionComparison = z.infer<typeof knowledgeVersionComparisonSchema>

export const diseasePackKnowledgeEvaluationSchema = z.object({
  asOf: dt,
  claims: z.array(evaluatedKnowledgeClaimSchema),
  latestComparison: knowledgeVersionComparisonSchema.optional(),
  packId: diseasePackSlugSchema,
  packVersion: z.string().min(1),
  retiredClaimStatuses: z.record(z.string().min(1), z.enum(['superseded', 'retracted'])).optional(),
  snapshotEffectiveFrom: dt,
  snapshotVersion: z.string().min(1),
  topics: z.array(evaluatedKnowledgeTopicSchema),
}).strict()
export type DiseasePackKnowledgeEvaluation = z.infer<typeof diseasePackKnowledgeEvaluationSchema>

export const diseasePackKnowledgeReadQuerySchema = z.object({
  asOf: dt.optional(),
  includeRetired: z.boolean().optional(),
  recheckLatest: z.boolean().optional(),
}).strict()
export type DiseasePackKnowledgeReadQuery = z.infer<typeof diseasePackKnowledgeReadQuerySchema>

export const outpatientDiseasePackKnowledgeInputSchema = diseasePackKnowledgeReadQuerySchema.extend({
  caseId: z.string().trim().min(1).max(64),
  packId: diseasePackSlugSchema,
}).strict()

export const inpatientDiseasePackKnowledgeInputSchema = diseasePackKnowledgeReadQuerySchema.extend({
  admissionId: z.string().trim().min(1).max(64),
  packId: diseasePackSlugSchema,
}).strict()
