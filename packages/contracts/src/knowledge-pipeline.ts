import { z } from 'zod'
import { clinicalFactLedgerSchema } from './clinical-fact-ledger.ts'
import {
  conceptMappingEligibilityReasonCodeSchema,
  conceptMappingReviewStatusSchema,
  conceptVocabularySchema,
  skosMappingRelationSchema,
} from './concept-vocabulary.ts'
import {
  diseasePackExamCaseSchema,
  diseasePackSha256Schema,
  diseasePackSlugSchema,
  diseasePackTriggerNodeSchema,
} from './disease-pack.ts'
import { guidelineEvidenceSchema } from './doctor-recommendations.ts'
import {
  clinicalReviewerRecordSchema,
  knowledgeAnchorCitationSchema,
  knowledgeClaimSchema,
  knowledgeSnapshotSchema,
} from './knowledge-claims.ts'

export const SYNTHETIC_TEST_GUIDELINE_MARKER = 'SYNTHETIC_TEST_GUIDELINE_NOT_CLINICAL' as const
export const SYNTHETIC_TEST_GUIDELINE_DISCLAIMER_ZH = '仅用于合成测试，不冒充真实临床指南' as const

const dt = z.iso.datetime({ offset: true })
const boundedId = z.string().trim().min(1).max(128)
const boundedCode = z.string().trim().min(1).max(128)
const boundedVersion = z.string().trim().min(1).max(64)
const boundedTitle = z.string().trim().min(1).max(500)
const boundedText = z.string().trim().min(1).max(4000)

// ── Synthetic / Pipeline Source Document Schemas ──

export const pipelineGuidelinePassageSchema = z.object({
  conceptCodes: z.array(boundedCode).max(32).optional(),
  locator: z.string().trim().min(1).max(256),
  page: z.number().int().positive(),
  text: z.string().min(1).max(12_000).refine(val => val.trim().length > 0, 'Passage text cannot be blank'),
  topicIds: z.array(boundedId).max(32).optional(),
}).strict()
export type PipelineGuidelinePassage = z.infer<typeof pipelineGuidelinePassageSchema>

const syntheticDisclaimerSchema = z.string().trim().min(1).max(500).superRefine((value, ctx) => {
  if (!value.includes('合成') || !value.includes('不冒充真实临床指南')) {
    ctx.addIssue({
      code: 'custom',
      message: '合成测试指南原文 disclaimerZh 必须明确声明“合成”且“不冒充真实临床指南”',
    })
  }
})

export const syntheticTestGuidelineDocSchema = z.object({
  disclaimerZh: syntheticDisclaimerSchema,
  passages: z.array(pipelineGuidelinePassageSchema).min(1),
  publisher: boundedTitle.optional(),
  sha256: diseasePackSha256Schema,
  sourceId: z.string().trim().min(1).max(256),
  syntheticTestMarker: z.literal(SYNTHETIC_TEST_GUIDELINE_MARKER),
  title: boundedTitle,
  version: boundedVersion,
}).strict()
export type SyntheticTestGuidelineDoc = z.infer<typeof syntheticTestGuidelineDocSchema>

export const pipelineSourceDocumentSchema = z.object({
  disclaimerZh: z.string().trim().min(1).max(500).optional(),
  passages: z.array(pipelineGuidelinePassageSchema).min(1),
  publisher: boundedTitle.optional(),
  sha256: diseasePackSha256Schema,
  sourceId: z.string().trim().min(1).max(256),
  syntheticTestMarker: z.literal(SYNTHETIC_TEST_GUIDELINE_MARKER).optional(),
  title: boundedTitle,
  version: boundedVersion,
}).strict()
export type PipelineSourceDocument = z.infer<typeof pipelineSourceDocumentSchema>

// ── Offline Knowledge Claim Pipeline Schemas ──

export const draftedOptionalConditionDetailsSchema = z.object({
  populationNote: z.string().trim().min(1).max(500).optional(),
  productQuantityNote: z.string().trim().min(1).max(500).optional(),
  requiredEvidenceTerms: z.array(z.string().trim().min(1).max(200)).max(16).optional(),
  thresholdNote: z.string().trim().min(1).max(500).optional(),
}).strict()
export type DraftedOptionalConditionDetails = z.infer<typeof draftedOptionalConditionDetailsSchema>

export const draftedKnowledgeClaimCandidateSchema = z.object({
  anchor: knowledgeAnchorCitationSchema.optional(),
  applicabilityCondition: diseasePackTriggerNodeSchema,
  associatedConceptCodes: z.array(boundedId).min(1),
  candidateId: boundedId,
  claimId: boundedId.optional(),
  optionalConditionsSpecified: draftedOptionalConditionDetailsSchema.optional(),
  packId: diseasePackSlugSchema,
  statementZh: boundedText,
  topicId: boundedId,
  unsupportedDetailClaimed: z.string().trim().min(1).max(500).optional(),
  version: boundedVersion.optional(),
}).strict()
export type DraftedKnowledgeClaimCandidate = z.infer<typeof draftedKnowledgeClaimCandidateSchema>

export const structuralCheckRejectionCodeSchema = z.enum([
  'CLAIM_ANCHOR_MISSING',
  'CLAIM_QUOTE_MISMATCH',
  'CLAIM_SOURCE_UNVERIFIED',
  'CLAIM_UNSUPPORTED_DETAIL',
  'CLAIM_CONCEPT_UNMAPPED',
])
export type StructuralCheckRejectionCode = z.infer<typeof structuralCheckRejectionCodeSchema>

export const structuralCheckRejectionSchema = z.object({
  candidateId: boundedId,
  code: structuralCheckRejectionCodeSchema,
  reasonZh: z.string().trim().min(1).max(1000),
}).strict()
export type StructuralCheckRejection = z.infer<typeof structuralCheckRejectionSchema>

export const offlineKnowledgePipelineTopicMetaSchema = z.object({
  limitationsZh: z.array(z.string().trim().min(1).max(2000)).min(1),
  navigationZh: boundedText,
  titleEn: boundedTitle.optional(),
  titleZh: boundedTitle,
}).strict()
export type OfflineKnowledgePipelineTopicMeta = z.infer<typeof offlineKnowledgePipelineTopicMetaSchema>

export const offlineKnowledgePipelineInputSchema = z.object({
  candidates: z.array(draftedKnowledgeClaimCandidateSchema).max(64).optional(),
  clinicianReviewer: clinicalReviewerRecordSchema.optional(),
  draftStreamMode: z.literal('controlled-deterministic').default('controlled-deterministic'),
  effectiveFrom: dt,
  packId: diseasePackSlugSchema,
  snapshotVersion: boundedVersion,
  sourceDocument: pipelineSourceDocumentSchema,
  topicId: boundedId,
  topicMetadata: offlineKnowledgePipelineTopicMetaSchema.optional(),
  version: boundedVersion,
  vocabulary: conceptVocabularySchema.optional(),
}).strict()
export type OfflineKnowledgePipelineInput = z.infer<typeof offlineKnowledgePipelineInputSchema>

export const offlineKnowledgePipelineResultSchema = z.object({
  acceptedClaims: z.array(knowledgeClaimSchema),
  draftedCount: z.number().int().nonnegative(),
  modelStreamMode: z.literal('controlled-deterministic'),
  publishedSnapshot: knowledgeSnapshotSchema.optional(),
  rejectedClaims: z.array(structuralCheckRejectionSchema),
  runtimeWriteToolsCount: z.literal(0),
}).strict()
export type OfflineKnowledgePipelineResult = z.infer<typeof offlineKnowledgePipelineResultSchema>

// ── Guideline Diff Report & Expert Adjudication Queue Schemas ──

export const guidelineDiffImpactItemSchema = z.object({
  affectedClaimIds: z.array(boundedId),
  affectedExamCaseIds: z.array(boundedId),
  affectedRuleIds: z.array(boundedId),
  affectedTopicIds: z.array(boundedId),
  changeKind: z.enum(['modified', 'added', 'removed']),
  locator: z.string().trim().min(1).max(256),
  page: z.number().int().positive(),
  v1Text: z.string().optional(),
  v2Text: z.string().optional(),
}).strict()
export type GuidelineDiffImpactItem = z.infer<typeof guidelineDiffImpactItemSchema>

export const guidelineClaimConflictStatusSchema = z.enum([
  'pending-adjudication',
  'kept-existing',
  'adopted-new',
])
export type GuidelineClaimConflictStatus = z.infer<typeof guidelineClaimConflictStatusSchema>

export const guidelineClaimConflictAdjudicationSchema = z.object({
  adjudicatedAt: dt,
  decision: z.enum(['keep-existing', 'adopt-new']),
  rationaleZh: z.string().trim().min(1).max(1000),
  reviewer: clinicalReviewerRecordSchema,
}).strict()
export type GuidelineClaimConflictAdjudication = z.infer<typeof guidelineClaimConflictAdjudicationSchema>

export const guidelineClaimConflictItemSchema = z.object({
  adjudication: guidelineClaimConflictAdjudicationSchema.optional(),
  candidateClaim: draftedKnowledgeClaimCandidateSchema,
  conflictId: boundedId,
  existingClaim: knowledgeClaimSchema,
  existingClaimId: boundedId,
  reasonZh: z.string().trim().min(1).max(1000),
  status: guidelineClaimConflictStatusSchema,
  topicId: boundedId,
}).strict()
export type GuidelineClaimConflictItem = z.infer<typeof guidelineClaimConflictItemSchema>

export const guidelineSourceDiffReportSchema = z.object({
  affectedClaimIds: z.array(boundedId),
  affectedExamCaseIds: z.array(boundedId),
  affectedRuleIds: z.array(boundedId),
  affectedTopicIds: z.array(boundedId),
  changedPassages: z.array(guidelineDiffImpactItemSchema),
  conflicts: z.array(guidelineClaimConflictItemSchema),
  expertAdjudicationQueue: z.array(guidelineClaimConflictItemSchema),
  packId: diseasePackSlugSchema,
  snapshot: knowledgeSnapshotSchema,
  syntheticDisclaimerZh: z.string().min(1),
  unchangedExistingClaimIds: z.array(boundedId),
  v1Sha256: diseasePackSha256Schema,
  v1SourceId: z.string().min(1),
  v1Version: boundedVersion,
  v2Sha256: diseasePackSha256Schema,
  v2SourceId: z.string().min(1),
  v2Version: boundedVersion,
}).strict()
export type GuidelineSourceDiffReport = z.infer<typeof guidelineSourceDiffReportSchema>

export const adjudicateConflictInputSchema = z.object({
  conflictId: boundedId,
  decision: z.enum(['keep-existing', 'adopt-new']),
  rationaleZh: z.string().trim().min(1).max(1000),
  reviewer: clinicalReviewerRecordSchema,
}).strict()
export type AdjudicateConflictInput = z.infer<typeof adjudicateConflictInputSchema>

export const guidelineDiffReportRequestSchema = z.object({
  packId: diseasePackSlugSchema,
  snapshot: knowledgeSnapshotSchema.optional(),
  v1Document: syntheticTestGuidelineDocSchema,
  v2Candidates: z.array(draftedKnowledgeClaimCandidateSchema).max(64).optional(),
  v2Document: syntheticTestGuidelineDocSchema,
}).strict()
export type GuidelineDiffReportRequest = z.infer<typeof guidelineDiffReportRequestSchema>

export const adjudicateConflictRequestSchema = z.object({
  adjudication: adjudicateConflictInputSchema,
  effectiveFrom: dt.optional(),
  report: guidelineSourceDiffReportSchema,
  snapshot: knowledgeSnapshotSchema,
}).strict()
export type AdjudicateConflictRequest = z.infer<typeof adjudicateConflictRequestSchema>

export const adjudicateConflictResultSchema = z.object({
  resolvedConflict: guidelineClaimConflictItemSchema,
  updatedReport: guidelineSourceDiffReportSchema,
  updatedSnapshot: knowledgeSnapshotSchema,
}).strict()
export type AdjudicateConflictResult = z.infer<typeof adjudicateConflictResultSchema>

// ── Concept Mapping Impact Report Schemas ──

export const mappingChangeImpactFactSchema = z.object({
  category: z.string().min(1),
  explanationZh: z.string().min(1),
  factId: z.string().min(1),
  itemCode: z.string().min(1),
  mappingId: boundedCode,
  reasonCode: conceptMappingEligibilityReasonCodeSchema,
  sourceSystem: z.string().min(1),
  stillEligibleForScoringAndRedLine: z.literal(false),
  targetConceptCode: boundedCode,
}).strict()
export type MappingChangeImpactFact = z.infer<typeof mappingChangeImpactFactSchema>

export const changedConceptMappingImpactSchema = z.object({
  eligibilityReasonCode: conceptMappingEligibilityReasonCodeSchema,
  explanationZh: z.string().min(1),
  fromRelation: skosMappingRelationSchema,
  fromReviewStatus: conceptMappingReviewStatusSchema,
  mappingId: boundedCode,
  sourceCode: boundedCode,
  sourceSystem: boundedCode,
  stillEligibleForScoringAndRedLine: z.boolean(),
  targetConceptCode: boundedCode,
  toRelation: skosMappingRelationSchema,
  toReviewStatus: conceptMappingReviewStatusSchema,
  wasEligibleForScoringAndRedLine: z.boolean(),
}).strict()
export type ChangedConceptMappingImpact = z.infer<typeof changedConceptMappingImpactSchema>

export const conceptMappingImpactReportSchema = z.object({
  affectedClaimIds: z.array(boundedId),
  affectedExamCaseIds: z.array(boundedId),
  affectedHistoricalFactIds: z.array(z.string().min(1)),
  affectedHistoricalFacts: z.array(mappingChangeImpactFactSchema),
  affectedRuleIds: z.array(boundedId),
  afterVocabularyVersion: boundedVersion,
  asOfDate: z.iso.date(),
  beforeVocabularyVersion: boundedVersion,
  changedMappings: z.array(changedConceptMappingImpactSchema),
  downgradedMappingIds: z.array(boundedCode),
  packId: diseasePackSlugSchema,
  summaryZh: z.string().min(1),
}).strict()
export type ConceptMappingImpactReport = z.infer<typeof conceptMappingImpactReportSchema>

export const conceptMappingImpactRequestSchema = z.object({
  admissionId: boundedId.optional(),
  afterVocabulary: conceptVocabularySchema,
  asOfDate: z.iso.date().optional(),
  beforeVocabulary: conceptVocabularySchema.optional(),
  caseId: boundedId.optional(),
  examCases: z.array(diseasePackExamCaseSchema).max(64).optional(),
  ledger: clinicalFactLedgerSchema.optional(),
  packId: diseasePackSlugSchema,
  snapshots: z.array(knowledgeSnapshotSchema).max(32).optional(),
}).strict()
export type ConceptMappingImpactRequest = z.infer<typeof conceptMappingImpactRequestSchema>

// ── Synonym-Expanded Guideline Search Schemas ──

export const guidelineSearchExpandedTermSchema = z.object({
  conceptCode: boundedId,
  expandedTerm: z.string().trim().min(1).max(200),
  mappingId: boundedId.optional(),
  queryTerm: z.string().trim().min(1).max(200),
}).strict()
export type GuidelineSearchExpandedTerm = z.infer<typeof guidelineSearchExpandedTermSchema>

export const offlineGuidelineSearchRequestSchema = z.object({
  asOfDate: z.iso.date().optional(),
  packId: diseasePackSlugSchema.optional(),
  population: z.enum(['adult', 'pediatric', 'all-only']).optional(),
  query: z.string().trim().min(1).max(500),
  vocabulary: conceptVocabularySchema.optional(),
}).strict()
export type OfflineGuidelineSearchRequest = z.infer<typeof offlineGuidelineSearchRequestSchema>

export const offlineGuidelineSearchResponseSchema = z.object({
  diagnosisQueries: z.array(z.string()),
  expandedTerms: z.array(guidelineSearchExpandedTermSchema).optional(),
  guidelines: z.array(guidelineEvidenceSchema),
  inactiveSources: z.array(z.object({
    id: z.string().min(1),
    sourceHash: z.string().optional(),
    url: z.string().optional(),
  }).strict()),
  revision: z.string().min(1),
}).strict()
export type OfflineGuidelineSearchResponse = z.infer<typeof offlineGuidelineSearchResponseSchema>
