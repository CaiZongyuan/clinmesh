import { z } from 'zod'
import {
  clinicalFactCategorySchema,
  clinicalFactLedgerSchema,
} from './clinical-fact-ledger.ts'
import { conceptVocabularySchema } from './concept-vocabulary.ts'
import {
  examCategorySchema,
  examFailureLayerSchema,
  examPublicTrapKindSchema,
} from './disease-pack-exam.ts'
import {
  diseasePackRegexPatternSchema,
  diseasePackSha256Schema,
  diseasePackSlugSchema,
  diseasePackTimestampFieldSchema,
  diseasePackTriggerNodeSchema,
  type DiseasePackAllOfTriggerNode,
  type DiseasePackAnyOfTriggerNode,
  type DiseasePackFactTriggerNode,
  type DiseasePackNotTriggerNode,
  type DiseasePackSequenceTriggerNode,
  type DiseasePackSlug,
  type DiseasePackTimestampField,
  type DiseasePackTriggerNode,
} from './disease-pack-triggers.ts'
import { guidelineTopicIdSchema } from './guideline-topics.ts'
import { commandResponseSchema } from './his.ts'
import { knowledgeSnapshotSchema } from './knowledge-claims.ts'
import {
  orderSetScopeSchema,
  orderSetScreeningRuleSchema,
  orderSetTemplateIdSchema,
  orderSetTemplateOptionSchema,
} from './order-set-templates.ts'

export {
  diseasePackSha256Schema,
  diseasePackSlugSchema,
  diseasePackTimestampFieldSchema,
  diseasePackTriggerNodeSchema,
  type DiseasePackAllOfTriggerNode,
  type DiseasePackAnyOfTriggerNode,
  type DiseasePackFactTriggerNode,
  type DiseasePackNotTriggerNode,
  type DiseasePackSequenceTriggerNode,
  type DiseasePackSlug,
  type DiseasePackTimestampField,
  type DiseasePackTriggerNode,
}

export const diseasePackTypeSchema = z.enum(['full', 'recognition'])
export type DiseasePackType = z.infer<typeof diseasePackTypeSchema>

export const diseasePackStatusSchema = z.enum(['draft', 'active', 'retired'])
export type DiseasePackStatus = z.infer<typeof diseasePackStatusSchema>

const nonEmptyText = z.string().trim().min(1).max(1000)
const boundedCode = z.string().trim().min(1).max(128)
const boundedId = z.string().trim().min(1).max(64)
const dt = z.iso.datetime({ offset: true })

export const MANDATORY_FORBIDDEN_PACK_ACTIONS = [
  'auto-prescribe-medication',
  'sign-clinical-document',
  'autonomous-treatment-decision',
] as const

export const diseasePackDependencySchema = z.object({
  minVersion: z.string().trim().min(1).max(64),
  packId: diseasePackSlugSchema,
}).strict()

export const diseasePackManifestSchema = z.object({
  dependencies: z.array(diseasePackDependencySchema).max(32).default([]),
  fingerprint: diseasePackSha256Schema,
  id: diseasePackSlugSchema,
  packType: diseasePackTypeSchema,
  specialty: diseasePackSlugSchema,
  status: diseasePackStatusSchema,
  supportedTasks: z.array(boundedId).min(1).max(64),
  titleEn: nonEmptyText,
  titleZh: nonEmptyText,
  version: z.string().trim().min(1).max(64),
}).strict()
export type DiseasePackManifest = z.infer<typeof diseasePackManifestSchema>

export const diseasePackStageSchema = z.object({
  entryCondition: diseasePackTriggerNodeSchema,
  id: diseasePackSlugSchema,
  order: z.number().int().nonnegative(),
  orderSetIds: z.array(orderSetTemplateIdSchema).max(32).default([]),
  questionnaireItemCodes: z.array(boundedCode).max(32).default([]),
  restrictRuntimeScope: z.boolean().optional(),
  taskIds: z.array(boundedId).max(32).default([]),
  titleEn: nonEmptyText.optional(),
  titleZh: nonEmptyText,
  topicIds: z.array(guidelineTopicIdSchema).max(32).default([]),
}).strict()
export type DiseasePackStage = z.infer<typeof diseasePackStageSchema>

export const diseasePackInapplicablePopulationSchema = z.object({
  condition: diseasePackTriggerNodeSchema,
  descriptionZh: nonEmptyText,
  id: diseasePackSlugSchema,
}).strict()
export type DiseasePackInapplicablePopulation = z.infer<typeof diseasePackInapplicablePopulationSchema>

export const diseasePackReadinessItemSchema = z.object({
  alternateItemCodes: z.array(boundedCode).max(16).optional(),
  category: clinicalFactCategorySchema.optional(),
  itemCode: boundedCode,
  labelZh: nonEmptyText,
  maxAgeDays: z.number().positive().max(36500).optional(),
}).strict()
export type DiseasePackReadinessItem = z.infer<typeof diseasePackReadinessItemSchema>

export const diseasePackReadinessTaskSchema = z.object({
  criticalItems: z.array(diseasePackReadinessItemSchema).max(32),
  relevantCategories: z.array(clinicalFactCategorySchema).max(8).optional(),
  relevantItemCodes: z.array(boundedCode).max(64).optional(),
  secondaryItems: z.array(diseasePackReadinessItemSchema).max(32),
  taskId: boundedId,
  titleZh: nonEmptyText,
}).strict()
export type DiseasePackReadinessTask = z.infer<typeof diseasePackReadinessTaskSchema>

export const diseasePackRuleOutCheckItemSchema = z.object({
  condition: diseasePackTriggerNodeSchema.optional(),
  id: diseasePackSlugSchema,
  labelZh: nonEmptyText,
  minCount: z.number().int().positive().optional(),
  purposeZh: nonEmptyText,
  requiredItemCodes: z.array(boundedCode).min(1).max(32).optional(),
  requireNormal: z.boolean().optional(),
}).strict()

export const diseasePackRuleOutItemSchema = z.object({
  actionHintZh: nonEmptyText,
  checkItems: z.array(diseasePackRuleOutCheckItemSchema).max(32).optional(),
  id: diseasePackSlugSchema,
  requiredTestCodes: z.array(boundedCode).max(32).optional(),
  targetConditionCodes: z.array(boundedCode).max(32).default([]),
  titleZh: nonEmptyText,
  trigger: diseasePackTriggerNodeSchema,
}).strict()

export const diseasePackExitCriterionSchema = z.object({
  condition: diseasePackTriggerNodeSchema,
  descriptionZh: nonEmptyText,
  id: diseasePackSlugSchema,
}).strict()

export const diseasePackConfusablePackSchema = z.object({
  differentialHintZh: nonEmptyText,
  packId: diseasePackSlugSchema,
}).strict()

export const diseasePackQuestionnaireItemSchema = z.object({
  code: boundedCode,
  labelZh: nonEmptyText,
  options: z.array(boundedCode).max(32).optional(),
  unit: z.string().trim().min(1).max(32).optional(),
  valueType: z.enum(['boolean', 'number', 'enum', 'text']),
}).strict()
export type DiseasePackQuestionnaireItem = z.infer<typeof diseasePackQuestionnaireItemSchema>

export const deduplicatedQuestionnaireItemSchema = diseasePackQuestionnaireItemSchema.extend({
  packIds: z.array(diseasePackSlugSchema).min(1),
}).strict()
export type DeduplicatedQuestionnaireItem = z.infer<typeof deduplicatedQuestionnaireItemSchema>

export const diseasePackGuidelineTopicReferenceSchema = z.object({
  fragments: z.array(z.string().min(1).max(1000)).min(1).max(16),
  page: z.number().int().positive(),
  sha256: diseasePackSha256Schema,
  sourceId: boundedCode,
  title: nonEmptyText,
  version: z.string().trim().min(1).max(64),
}).strict()

export const diseasePackGuidelineTopicSchema = z.object({
  conclusionKinds: z.tuple([boundedId, boundedId, boundedId]),
  generationRule: z.string().trim().min(1).max(4000),
  id: guidelineTopicIdSchema,
  limitations: z.array(z.string().trim().min(1).max(4000)).min(1).max(12),
  matchTerms: z.array(nonEmptyText).min(1).max(64),
  navigation: z.string().trim().min(1).max(4000),
  references: z.array(diseasePackGuidelineTopicReferenceSchema).min(1).max(16),
  specialty: diseasePackSlugSchema,
  titleEn: z.string().trim().min(1).max(240),
  titleZh: z.string().trim().min(1).max(240),
  version: z.string().trim().min(1).max(64),
}).strict()
export type DiseasePackGuidelineTopic = z.infer<typeof diseasePackGuidelineTopicSchema>

export const diseasePackOrderSetItemSchema = z.object({
  activeMedicationConflictCodes: z.array(boundedCode).max(32).optional(),
  catalogBindingCode: boundedCode.optional(),
  channel: z.enum(['laboratory', 'investigation', 'medication', 'procedure', 'nursing', 'service']).optional(),
  key: diseasePackSlugSchema,
  kind: z.enum(['laboratory', 'examination', 'imaging', 'medication', 'procedure', 'nursing', 'service']),
  options: z.array(orderSetTemplateOptionSchema).min(1).max(4).optional(),
  panelServiceCodes: z.array(boundedCode).max(32).optional(),
  procedureCode: boundedCode.optional(),
  rationaleZh: nonEmptyText.optional(),
  rules: z.array(orderSetScreeningRuleSchema).max(8).optional(),
  scopes: z.array(orderSetScopeSchema).min(1).max(2).optional(),
  tier: z.number().int().min(1).max(4).optional(),
  titleEn: nonEmptyText.optional(),
  titleZh: nonEmptyText,
  unlockCondition: diseasePackTriggerNodeSchema.optional(),
}).strict()

export const diseasePackOrderSetSchema = z.object({
  applicableProcedureCodes: z.array(boundedCode).min(1).max(32).optional(),
  descriptionZh: nonEmptyText.optional(),
  id: orderSetTemplateIdSchema,
  items: z.array(diseasePackOrderSetItemSchema).min(1).max(32),
  scopes: z.array(orderSetScopeSchema).min(1).max(2),
  titleEn: nonEmptyText.optional(),
  titleZh: nonEmptyText,
  unlockCondition: diseasePackTriggerNodeSchema.optional(),
  version: z.string().trim().min(1).max(64).optional(),
}).strict()

export const diseasePackPointScaleSchema = z.object({
  criteria: z.array(z.object({
    condition: diseasePackTriggerNodeSchema,
    id: diseasePackSlugSchema,
    labelZh: nonEmptyText,
    points: z.number().finite(),
  }).strict()).min(1).max(32),
  guidelineCitation: z.object({
    locator: nonEmptyText,
    sourceTitle: nonEmptyText,
    version: z.string().trim().min(1).max(64),
  }).strict(),
  id: diseasePackSlugSchema,
  riskBands: z.array(z.object({
    guidanceZh: nonEmptyText.optional(),
    labelZh: nonEmptyText,
    maxScore: z.number().finite().nullable(),
    minScore: z.number().finite(),
    skipTests: z.boolean().optional(),
  }).strict()).min(1).max(16),
  titleZh: nonEmptyText,
}).strict()

export const diseasePackIndicationRuleSchema = z.object({
  condition: diseasePackTriggerNodeSchema,
  id: diseasePackSlugSchema,
  itemCodePattern: diseasePackRegexPatternSchema,
  orderKind: z.enum(['laboratory', 'examination', 'imaging', 'pathology', 'medication', 'procedure']),
  rationaleZh: nonEmptyText,
  requiredItemCodes: z.array(boundedCode).min(1).max(32).optional(),
}).strict()

export const diseasePackRiskTagSchema = z.object({
  candidateMedicationClasses: z.array(boundedCode).min(1).max(16).optional(),
  condition: diseasePackTriggerNodeSchema,
  descriptionZh: nonEmptyText.optional(),
  id: diseasePackSlugSchema,
  labelZh: nonEmptyText,
  severity: z.enum(['info', 'warning', 'critical']),
  timing: z.enum([
    'encounter-open',
    'order-draft-select',
    'order-sign',
    'encounter-complete',
    'pci-plan',
    'discharge',
    'report-arrived',
  ]).optional(),
}).strict()
export type DiseasePackRiskTag = z.infer<typeof diseasePackRiskTagSchema>

export const diseasePackExamCaseSchema = z.object({
  caseId: boundedId,
  category: examCategorySchema.optional(),
  expectedActive: z.boolean(),
  expectedBlockedTaskIds: z.array(boundedId).max(32).optional(),
  expectedExited: z.boolean().optional(),
  expectedInapplicable: z.boolean().optional(),
  expectedKnowledgeClaimValid: z.boolean().optional(),
  expectedReadyTaskIds: z.array(boundedId).max(32).optional(),
  expectedRedLineCodes: z.array(boundedCode).max(32).optional(),
  expectedRuleOutActive: z.boolean().optional(),
  expectedScoreFormulaIds: z.array(diseasePackSlugSchema).max(32).optional(),
  expectedStageId: diseasePackSlugSchema.optional(),
  expectedUnnecessaryOrderCodes: z.array(boundedCode).max(32).optional(),
  layer: examFailureLayerSchema.optional(),
  publicTrapKind: examPublicTrapKindSchema.optional(),
  titleZh: nonEmptyText,
}).strict()
export type DiseasePackExamCase = z.infer<typeof diseasePackExamCaseSchema>

export const diseasePackExamSuiteSchema = z.object({
  cases: z.array(diseasePackExamCaseSchema).min(1).max(64),
  passThreshold: z.number().min(0).max(1),
}).strict()

export const diseasePackRecognitionCardSchema = z.object({
  differentialPackIds: z.array(diseasePackSlugSchema).max(16).default([]),
  escalationGuidanceZh: nonEmptyText,
  id: diseasePackSlugSchema,
  summaryZh: nonEmptyText,
  titleZh: nonEmptyText,
}).strict()

export const diseasePackFormulaRefSchema = z.object({
  formulaId: diseasePackSlugSchema,
  version: z.number().int().positive(),
}).strict()

export const diseasePackValidityOverrideSchema = z.object({
  itemCode: boundedCode,
  maxValidityDays: z.number().int().positive().max(3650),
}).strict()

export const diseasePackRedLineRuleSchema = z.object({
  conditionSummary: nonEmptyText,
  id: diseasePackSlugSchema,
  itemCode: boundedCode,
}).strict()

export const diseasePackQualityTighteningsSchema = z.object({
  examPassThreshold: z.number().min(0).max(1).optional(),
  redLineRules: z.array(diseasePackRedLineRuleSchema).max(64).default([]),
  validityOverrides: z.array(diseasePackValidityOverrideSchema).max(64).default([]),
}).strict()

export const diseasePackToolPolicySchema = z.object({
  allowedTools: z.array(boundedCode).max(128),
  forbiddenActions: z.array(boundedCode).max(64).default([]),
}).strict()

export const diseasePackTriggerRuleSchema = z.object({
  condition: diseasePackTriggerNodeSchema,
  descriptionZh: nonEmptyText.optional(),
  id: diseasePackSlugSchema,
}).strict()

export const diseasePackSchema = z.object({
  conceptVocabulary: conceptVocabularySchema.optional(),
  confusablePacks: z.array(diseasePackConfusablePackSchema).max(32).optional(),
  examSuite: diseasePackExamSuiteSchema,
  exitCriteria: z.array(diseasePackExitCriterionSchema).max(32).optional(),
  formulaRefs: z.array(diseasePackFormulaRefSchema).max(32).default([]),
  guidelineTopics: z.array(diseasePackGuidelineTopicSchema).max(32).optional(),
  inapplicablePopulations: z.array(diseasePackInapplicablePopulationSchema).max(32).default([]),
  indicationRules: z.array(diseasePackIndicationRuleSchema).max(64).optional(),
  knowledgeSnapshots: z.array(knowledgeSnapshotSchema).max(32).optional(),
  manifest: diseasePackManifestSchema,
  orderSets: z.array(diseasePackOrderSetSchema).max(32).optional(),
  pointScales: z.array(diseasePackPointScaleSchema).max(16).optional(),
  qualityTightenings: diseasePackQualityTighteningsSchema.default({ redLineRules: [], validityOverrides: [] }),
  questionnaireItems: z.array(diseasePackQuestionnaireItemSchema).max(64).optional(),
  readinessTasks: z.array(diseasePackReadinessTaskSchema).max(32).default([]),
  recognitionCard: diseasePackRecognitionCardSchema.optional(),
  riskTags: z.array(diseasePackRiskTagSchema).max(32).optional(),
  ruleOutChecklist: z.array(diseasePackRuleOutItemSchema).max(32).optional(),
  stages: z.array(diseasePackStageSchema).max(32).default([]),
  toolPolicy: diseasePackToolPolicySchema,
  triggers: z.array(diseasePackTriggerRuleSchema).min(1).max(32),
}).strict().superRefine((pack, ctx) => {
  if (pack.manifest.packType === 'full') {
    if (pack.stages.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Full disease pack must declare at least one pathway stage',
        path: ['stages'],
      })
    }
    if (pack.readinessTasks.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Full disease pack must declare at least one readinessTask',
        path: ['readinessTasks'],
      })
    }
  } else {
    if (pack.recognitionCard === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Recognition disease pack must declare recognitionCard',
        path: ['recognitionCard'],
      })
    }
  }
})
export type DiseasePack = z.infer<typeof diseasePackSchema>

export const hospitalOverlayLocalizationsSchema = z.object({
  approvers: z.array(z.object({
    labelZh: nonEmptyText,
    roleCode: boundedId,
  }).strict()).max(16).optional(),
  catalogBindings: z.record(boundedCode, boundedCode).optional(),
  codingMappings: z.record(boundedCode, boundedCode).optional(),
  reportTemplates: z.record(boundedCode, nonEmptyText).optional(),
}).strict()

export const hospitalOverlaySafetyAdjustmentsSchema = z.object({
  examPassThreshold: z.number().min(0).max(1).optional(),
  forbiddenActionAdditions: z.array(boundedCode).max(64).optional(),
  forbiddenActionRemovals: z.array(boundedCode).max(64).optional(),
  redLineAdditions: z.array(diseasePackRedLineRuleSchema).max(64).optional(),
  redLineRemovals: z.array(boundedCode).max(64).optional(),
  triggerAdditions: z.array(diseasePackTriggerRuleSchema).max(32).optional(),
  triggerRemovals: z.array(diseasePackSlugSchema).max(32).optional(),
  validityOverrides: z.array(diseasePackValidityOverrideSchema).max(64).optional(),
}).strict()

export const hospitalOverlaySchema = z.object({
  conceptVocabulary: conceptVocabularySchema.optional(),
  hospitalId: diseasePackSlugSchema,
  localizations: hospitalOverlayLocalizationsSchema.default({}),
  packId: diseasePackSlugSchema,
  safetyAdjustments: hospitalOverlaySafetyAdjustmentsSchema.optional(),
  version: z.string().trim().min(1).max(64).default('1.0.0'),
}).strict()
export type HospitalOverlay = z.infer<typeof hospitalOverlaySchema>

export const effectiveDiseasePackSchema = z.object({
  effectiveAllowedTools: z.array(boundedCode),
  effectiveExamPassThreshold: z.number().min(0).max(1),
  effectiveForbiddenActions: z.array(boundedCode),
  effectiveRedLines: z.array(diseasePackRedLineRuleSchema),
  effectiveValidityDaysByItemCode: z.record(boundedCode, z.number().int().positive()),
  hospitalOverlay: hospitalOverlaySchema.optional(),
  localizations: hospitalOverlayLocalizationsSchema,
  pack: diseasePackSchema,
}).strict()
export type EffectiveDiseasePack = z.infer<typeof effectiveDiseasePackSchema>

export const diseasePackActivationStatusSchema = z.enum(['active', 'inactive', 'inapplicable'])
export type DiseasePackActivationStatus = z.infer<typeof diseasePackActivationStatusSchema>

export const diseasePackActivationReasonSchema = z.enum([
  'trigger-matched',
  'not-triggered',
  'manual-enabled',
  'manual-disabled',
  'inapplicable-population',
  'pack-exited',
  'pack-draft',
  'pack-retired',
])
export type DiseasePackActivationReason = z.infer<typeof diseasePackActivationReasonSchema>

export const diseasePackStageStateSchema = z.object({
  active: z.boolean(),
  id: diseasePackSlugSchema,
  matchedFactIds: z.array(z.string().min(1)),
  order: z.number().int().nonnegative(),
  orderSetIds: z.array(orderSetTemplateIdSchema),
  questionnaireItemCodes: z.array(boundedCode),
  taskIds: z.array(boundedId),
  titleEn: nonEmptyText.optional(),
  titleZh: nonEmptyText,
  topicIds: z.array(guidelineTopicIdSchema),
}).strict()
export type DiseasePackStageState = z.infer<typeof diseasePackStageStateSchema>

export const diseasePackReadinessStatusSchema = z.enum(['ready', 'missing-secondary', 'missing-critical'])
export type DiseasePackReadinessStatus = z.infer<typeof diseasePackReadinessStatusSchema>

export const diseasePackMissingReadinessItemSchema = z.object({
  ineligibleReasons: z.array(z.string().min(1)),
  itemCode: boundedCode,
  labelZh: nonEmptyText,
  tier: z.enum(['critical', 'secondary']),
}).strict()
export type DiseasePackMissingReadinessItem = z.infer<typeof diseasePackMissingReadinessItemSchema>

export const diseasePackTaskReadinessResultSchema = z.object({
  annotations: z.array(nonEmptyText),
  canProceed: z.boolean(),
  matchedFactIds: z.array(z.string().min(1)),
  missingCriticalItems: z.array(diseasePackMissingReadinessItemSchema),
  missingSecondaryItems: z.array(diseasePackMissingReadinessItemSchema),
  packId: diseasePackSlugSchema,
  status: diseasePackReadinessStatusSchema,
  taskId: boundedId,
  titleZh: nonEmptyText,
}).strict()
export type DiseasePackTaskReadinessResult = z.infer<typeof diseasePackTaskReadinessResultSchema>

export const followUpLdlSummarySchema = z.object({
  atGoal: z.boolean(),
  baselineFactId: z.string().min(1),
  baselineLdlMmolL: z.number().finite().positive(),
  baselineMeasuredAt: dt,
  comparisonTextZh: nonEmptyText,
  deltaMmolL: z.number().finite(),
  latestFactId: z.string().min(1),
  latestLdlMmolL: z.number().finite().positive(),
  latestMeasuredAt: dt,
  targetLdlMmolL: z.number().finite().positive(),
}).strict()
export type FollowUpLdlSummary = z.infer<typeof followUpLdlSummarySchema>

export const diseasePackRuntimeEntrySchema = z.object({
  activationReason: diseasePackActivationReasonSchema,
  activationStatus: diseasePackActivationStatusSchema,
  allowedTools: z.array(boundedCode),
  currentStageId: diseasePackSlugSchema.nullable(),
  exited: z.boolean().optional(),
  exitReasonZh: nonEmptyText.nullable().optional(),
  followUpLdlSummary: followUpLdlSummarySchema.nullable().optional(),
  forbiddenActions: z.array(boundedCode),
  localizations: hospitalOverlayLocalizationsSchema,
  manualOverride: z.enum(['enabled', 'disabled']).nullable(),
  manualOverrideVersion: z.number().int().nonnegative(),
  matchedInapplicableIds: z.array(diseasePackSlugSchema),
  matchedTriggerIds: z.array(diseasePackSlugSchema),
  packId: diseasePackSlugSchema,
  packType: diseasePackTypeSchema,
  readinessTasks: z.array(diseasePackTaskReadinessResultSchema),
  recognitionCard: diseasePackRecognitionCardSchema.nullable(),
  specialty: diseasePackSlugSchema,
  stages: z.array(diseasePackStageStateSchema),
  status: diseasePackStatusSchema,
  titleEn: nonEmptyText,
  titleZh: nonEmptyText,
  version: z.string().trim().min(1).max(64),
}).strict()
export type DiseasePackRuntimeEntry = z.infer<typeof diseasePackRuntimeEntrySchema>

export const diseasePackRuntimeBundleSchema = z.object({
  activeQuestionnaireItems: z.array(deduplicatedQuestionnaireItemSchema).max(128).optional(),
  evaluatedAt: dt,
  packs: z.array(diseasePackRuntimeEntrySchema),
  subjectId: boundedId,
  subjectKind: z.enum(['outpatient', 'inpatient']),
}).strict()
export type DiseasePackRuntimeBundle = z.infer<typeof diseasePackRuntimeBundleSchema>

export const hospitalGeneralLabPanelSchema = z.object({
  code: boundedCode,
  displayZh: nonEmptyText,
  memberCodes: z.array(boundedCode).min(1).max(32),
  specimenZh: nonEmptyText,
}).strict()
export type HospitalGeneralLabPanel = z.infer<typeof hospitalGeneralLabPanelSchema>

export const hospitalBaselineConfigSchema = z.object({
  generalLabPanels: z.array(hospitalGeneralLabPanelSchema).min(1).max(32),
  hospitalId: diseasePackSlugSchema,
  nameZh: nonEmptyText,
  orderSets: z.array(diseasePackOrderSetSchema).max(32),
  version: z.string().trim().min(1).max(64),
}).strict()
export type HospitalBaselineConfig = z.infer<typeof hospitalBaselineConfigSchema>

export const diseasePackSummarySchema = z.object({
  fingerprint: diseasePackSha256Schema,
  id: diseasePackSlugSchema,
  packType: diseasePackTypeSchema,
  specialty: diseasePackSlugSchema,
  status: diseasePackStatusSchema,
  supportedTasks: z.array(boundedId),
  titleEn: nonEmptyText,
  titleZh: nonEmptyText,
  version: z.string().trim().min(1).max(64),
}).strict()

export const diseasePackCatalogListSchema = z.object({
  items: z.array(diseasePackSummarySchema),
}).strict()
export type DiseasePackCatalogList = z.infer<typeof diseasePackCatalogListSchema>

export const diseasePackToggleModeSchema = z.enum(['enabled', 'disabled', 'auto'])

export const diseasePackToggleBodySchema = z.object({
  expectedVersion: z.number().int().nonnegative().optional(),
  note: z.string().trim().min(1).max(500).optional(),
  overrideMode: diseasePackToggleModeSchema,
}).strict()
export type DiseasePackToggleBody = z.infer<typeof diseasePackToggleBodySchema>

export const outpatientDiseasePackToggleInputSchema = diseasePackToggleBodySchema.extend({
  caseId: boundedId,
  packId: diseasePackSlugSchema,
}).strict()

export const inpatientDiseasePackToggleInputSchema = diseasePackToggleBodySchema.extend({
  admissionId: boundedId,
  packId: diseasePackSlugSchema,
}).strict()

export const diseasePackToggleResponseSchema = commandResponseSchema(diseasePackRuntimeEntrySchema)

export const diseasePackTaskFactsResponseSchema = z.object({
  declaredItemCodes: z.array(boundedCode),
  ledger: clinicalFactLedgerSchema,
  packId: diseasePackSlugSchema,
  readiness: diseasePackTaskReadinessResultSchema,
  taskId: boundedId,
}).strict()
export type DiseasePackTaskFactsResponse = z.infer<typeof diseasePackTaskFactsResponseSchema>

export const diseasePackToolAuthorizeBodySchema = z.object({
  actionTag: boundedCode.optional(),
  operationId: boundedCode,
}).strict()

export const outpatientDiseasePackToolAuthorizeInputSchema = diseasePackToolAuthorizeBodySchema.extend({
  caseId: boundedId,
  packId: diseasePackSlugSchema,
}).strict()

export const inpatientDiseasePackToolAuthorizeInputSchema = diseasePackToolAuthorizeBodySchema.extend({
  admissionId: boundedId,
  packId: diseasePackSlugSchema,
}).strict()

export const diseasePackToolAuthorizeResponseSchema = z.object({
  auditId: z.string().min(1),
  authorized: z.literal(true),
  operationId: boundedCode,
  packId: diseasePackSlugSchema,
}).strict()

export const outpatientDiseasePackReadQuerySchema = z.object({
  caseId: boundedId,
}).strict()

export const inpatientDiseasePackReadQuerySchema = z.object({
  admissionId: boundedId,
}).strict()

export const outpatientDiseasePackTaskQuerySchema = z.object({
  caseId: boundedId,
  packId: diseasePackSlugSchema,
  taskId: boundedId,
}).strict()

export const inpatientDiseasePackTaskQuerySchema = z.object({
  admissionId: boundedId,
  packId: diseasePackSlugSchema,
  taskId: boundedId,
}).strict()
