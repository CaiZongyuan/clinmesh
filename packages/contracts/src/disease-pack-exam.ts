import { z } from 'zod'
import { diseasePackSlugSchema } from './disease-pack-triggers.ts'

const boundedCode = z.string().trim().min(1).max(128)
const boundedId = z.string().trim().min(1).max(128)
const boundedVersion = z.string().trim().min(1).max(64)
const nonEmptyText = z.string().trim().min(1).max(1000)
const dt = z.iso.datetime({ offset: true })

export const EXAM_FAILURE_LAYERS = [
  'data-normalization',
  'terminology-mapping',
  'knowledge',
  'agent-safety',
  'workflow',
] as const

export const examFailureLayerSchema = z.enum(EXAM_FAILURE_LAYERS)
export type ExamFailureLayer = z.infer<typeof examFailureLayerSchema>

export const EXAM_CATEGORIES = [
  'standard-mild',
  'inpatient-severe',
  'missing-critical-data',
  'red-line-violation',
  'multi-disease-conflict',
  'over-testing-mild',
  'public-trap',
] as const

export const examCategorySchema = z.enum(EXAM_CATEGORIES)
export type ExamCategory = z.infer<typeof examCategorySchema>

export const EXAM_PUBLIC_TRAP_KINDS = [
  'same-name-different-person',
  'amended-report-stale',
  'retracted-guideline',
  'prompt-injection-in-note',
  'missing-critical-lab',
  'external-spoof-as-internal',
  'inapplicable-population',
] as const

export const examPublicTrapKindSchema = z.enum(EXAM_PUBLIC_TRAP_KINDS)
export type ExamPublicTrapKind = z.infer<typeof examPublicTrapKindSchema>

export const examCaseResultSchema = z.object({
  attributedLayer: examFailureLayerSchema.nullable(),
  caseId: boundedId,
  category: examCategorySchema,
  declaredLayer: examFailureLayerSchema,
  failureReasonZh: nonEmptyText.nullable().default(null),
  missedChecks: z.array(nonEmptyText).default([]),
  observed: z.record(z.string(), z.unknown()).optional(),
  packId: diseasePackSlugSchema.nullable(),
  passed: z.boolean(),
  publicTrapKind: examPublicTrapKindSchema.optional(),
  score: z.number().min(0).max(1),
  titleZh: nonEmptyText,
  unnecessaryOrderPenalties: z.array(boundedCode).default([]),
}).strict()
export type ExamCaseResult = z.infer<typeof examCaseResultSchema>

export const examLayerFailureCountMapSchema = z.object({
  'agent-safety': z.number().int().nonnegative(),
  'data-normalization': z.number().int().nonnegative(),
  knowledge: z.number().int().nonnegative(),
  'terminology-mapping': z.number().int().nonnegative(),
  workflow: z.number().int().nonnegative(),
}).strict()
export type ExamLayerFailureCountMap = z.infer<typeof examLayerFailureCountMapSchema>

export const examLayerFailureDetailSchema = z.object({
  caseId: boundedId,
  category: examCategorySchema,
  failureReasonZh: nonEmptyText,
  packId: diseasePackSlugSchema.nullable(),
  titleZh: nonEmptyText,
}).strict()
export type ExamLayerFailureDetail = z.infer<typeof examLayerFailureDetailSchema>

export const examLayerFailureSummaryEntrySchema = z.object({
  failureCount: z.number().int().nonnegative(),
  failingCases: z.array(examLayerFailureDetailSchema),
  layer: examFailureLayerSchema,
}).strict()
export type ExamLayerFailureSummaryEntry = z.infer<typeof examLayerFailureSummaryEntrySchema>

export const examLayerFailureSummaryMapSchema = z.object({
  'agent-safety': examLayerFailureSummaryEntrySchema,
  'data-normalization': examLayerFailureSummaryEntrySchema,
  knowledge: examLayerFailureSummaryEntrySchema,
  'terminology-mapping': examLayerFailureSummaryEntrySchema,
  workflow: examLayerFailureSummaryEntrySchema,
}).strict()
export type ExamLayerFailureSummaryMap = z.infer<typeof examLayerFailureSummaryMapSchema>

export const packExamRunResultSchema = z.object({
  caseResults: z.array(examCaseResultSchema),
  categoriesCovered: z.array(examCategorySchema),
  failedCases: z.number().int().nonnegative(),
  layerFailures: examLayerFailureCountMapSchema,
  llmInvocationCount: z.literal(0),
  packId: diseasePackSlugSchema,
  packStatus: z.enum(['draft', 'active', 'retired']),
  packType: z.enum(['full', 'recognition']),
  packVersion: boundedVersion,
  passRate: z.number().min(0).max(1),
  passThreshold: z.number().min(0).max(1),
  passed: z.boolean(),
  passedCases: z.number().int().nonnegative(),
  publicTrapsPassed: z.boolean(),
  totalCases: z.number().int().nonnegative(),
}).strict()
export type PackExamRunResult = z.infer<typeof packExamRunResultSchema>

export const publicTrapSuiteResultSchema = z.object({
  caseResults: z.array(examCaseResultSchema),
  failedTraps: z.number().int().nonnegative(),
  layerFailures: examLayerFailureCountMapSchema,
  llmInvocationCount: z.literal(0),
  passed: z.boolean(),
  passedTraps: z.number().int().nonnegative(),
  totalTraps: z.number().int().nonnegative(),
}).strict()
export type PublicTrapSuiteResult = z.infer<typeof publicTrapSuiteResultSchema>

export const dsapPackAdditionAuditSchema = z.object({
  addedEntriesCount: z.object({
    examCases: z.number().int().nonnegative(),
    knowledgeClaims: z.number().int().nonnegative(),
    mappings: z.number().int().nonnegative(),
    questionnaireItems: z.number().int().nonnegative(),
  }).strict(),
  contractChangedFiles: z.array(z.string().min(1)),
  platformChangesZero: z.boolean(),
  platformCodeChangedFiles: z.array(z.string().min(1)),
  reuseRatio: z.number().min(0).max(1),
}).strict()
export type DsapPackAdditionAudit = z.infer<typeof dsapPackAdditionAuditSchema>

export const dsapSourceSystemAgnosticSummarySchema = z.object({
  concluded: z.boolean(),
  inspectedSourceSystems: z.array(z.string().min(1)).min(1),
  summaryZh: nonEmptyText,
}).strict()
export type DsapSourceSystemAgnosticSummary = z.infer<typeof dsapSourceSystemAgnosticSummarySchema>

export const dsapBlockedPackSummarySchema = z.object({
  failedLayerCounts: examLayerFailureCountMapSchema,
  packId: diseasePackSlugSchema,
  reasonZh: nonEmptyText,
}).strict()
export type DsapBlockedPackSummary = z.infer<typeof dsapBlockedPackSummarySchema>

export const dsapActivationGateSummarySchema = z.object({
  blockedPacks: z.array(dsapBlockedPackSummarySchema),
  eligiblePacks: z.array(diseasePackSlugSchema),
  llmInvocationCount: z.literal(0),
}).strict()
export type DsapActivationGateSummary = z.infer<typeof dsapActivationGateSummarySchema>

export const dsapStandardizedReportSchema = z.object({
  activationGateSummary: dsapActivationGateSummarySchema,
  coronaryRegressionPassed: z.boolean(),
  failureSummaryByLayer: examLayerFailureSummaryMapSchema,
  generatedAt: dt,
  llmInvocationCount: z.literal(0),
  migrationDiffCount: z.number().int().nonnegative(),
  migrationDiffDetails: z.array(nonEmptyText),
  packAdditionAudit: dsapPackAdditionAuditSchema,
  packRuns: z.array(packExamRunResultSchema),
  publicTrapRun: publicTrapSuiteResultSchema,
  sourceSystemAgnostic: dsapSourceSystemAgnosticSummarySchema,
}).strict()
export type DsapStandardizedReport = z.infer<typeof dsapStandardizedReportSchema>

export const adminDiseasePackExamRunInputSchema = z.object({
  includePublicTraps: z.boolean().default(true),
  injectFault: z.enum(['none', 'unit-conversion']).default('none'),
  packDir: z.string().trim().min(1).max(500).optional(),
  packId: diseasePackSlugSchema.optional(),
}).strict()
export type AdminDiseasePackExamRunInput = z.infer<typeof adminDiseasePackExamRunInputSchema>

export const dsapExamRunResponseSchema = z.object({
  llmInvocationCount: z.literal(0),
  passed: z.boolean(),
  report: dsapStandardizedReportSchema,
}).strict()
export type DsapExamRunResponse = z.infer<typeof dsapExamRunResponseSchema>

export const adminDiseasePackActivateBodySchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
  packDir: z.string().trim().min(1).max(500).optional(),
}).strict()
export type AdminDiseasePackActivateBody = z.infer<typeof adminDiseasePackActivateBodySchema>

export const adminDiseasePackActivateInputSchema = adminDiseasePackActivateBodySchema.extend({
  packId: diseasePackSlugSchema,
}).strict()
export type AdminDiseasePackActivateInput = z.infer<typeof adminDiseasePackActivateInputSchema>

export const diseasePackRegressionCheckSchema = z.object({
  packId: diseasePackSlugSchema,
  passRate: z.number().min(0).max(1),
  passed: z.boolean(),
}).strict()
export type DiseasePackRegressionCheck = z.infer<typeof diseasePackRegressionCheckSchema>

export const diseasePackActivationGateResponseSchema = z.object({
  activated: z.boolean(),
  blocksActivation: z.boolean(),
  gateDecision: z.enum(['approved', 'blocked']),
  llmInvocationCount: z.literal(0),
  packId: diseasePackSlugSchema,
  packRun: packExamRunResultSchema,
  previousStatus: z.enum(['draft', 'active', 'retired']),
  publicTrapRun: publicTrapSuiteResultSchema,
  regressionChecks: z.array(diseasePackRegressionCheckSchema),
  status: z.enum(['draft', 'active', 'retired']),
}).strict()
export type DiseasePackActivationGateResponse = z.infer<typeof diseasePackActivationGateResponseSchema>
