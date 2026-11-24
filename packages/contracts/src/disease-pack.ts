import { z } from 'zod'
import {
  clinicalFactCategorySchema,
  clinicalFactLedgerSchema,
  clinicalFactVerificationStatusSchema,
} from './clinical-fact-ledger.ts'
import { guidelineTopicIdSchema } from './guideline-topics.ts'
import { commandResponseSchema } from './his.ts'
import { orderSetTemplateIdSchema } from './order-set-templates.ts'

export const diseasePackSlugSchema = z.string().regex(/^[a-z0-9-]{1,64}$/)
export type DiseasePackSlug = z.infer<typeof diseasePackSlugSchema>

export const diseasePackSha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
export const diseasePackTypeSchema = z.enum(['full', 'recognition'])
export type DiseasePackType = z.infer<typeof diseasePackTypeSchema>

export const diseasePackStatusSchema = z.enum(['draft', 'active', 'retired'])
export type DiseasePackStatus = z.infer<typeof diseasePackStatusSchema>

export const diseasePackTimestampFieldSchema = z.enum(['effectiveAt', 'reportedAt', 'ingestedAt'])
export type DiseasePackTimestampField = z.infer<typeof diseasePackTimestampFieldSchema>

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

export interface DiseasePackFactTriggerNode {
  kind: 'fact'
  category?: z.infer<typeof clinicalFactCategorySchema> | undefined
  itemCodes?: string[] | undefined
  itemCodePattern?: string | undefined
  presence: 'present' | 'absent'
  requireEligible: boolean
  verificationStatus?: z.infer<typeof clinicalFactVerificationStatusSchema> | undefined
  minValue?: number | undefined
  maxValue?: number | undefined
  unit?: string | undefined
  textPattern?: string | undefined
  withinDays?: number | undefined
  timestampField?: DiseasePackTimestampField | undefined
}

export interface DiseasePackSequenceTriggerNode {
  kind: 'sequence'
  first: DiseasePackTriggerNode
  then: DiseasePackTriggerNode
  maxGapDays?: number | undefined
  requireDistinctEncounters?: boolean | undefined
  timestampField: DiseasePackTimestampField
}

export interface DiseasePackAllOfTriggerNode {
  kind: 'allOf'
  nodes: DiseasePackTriggerNode[]
}

export interface DiseasePackAnyOfTriggerNode {
  kind: 'anyOf'
  nodes: DiseasePackTriggerNode[]
}

export interface DiseasePackNotTriggerNode {
  kind: 'not'
  node: DiseasePackTriggerNode
}

export type DiseasePackTriggerNode =
  | DiseasePackFactTriggerNode
  | DiseasePackSequenceTriggerNode
  | DiseasePackAllOfTriggerNode
  | DiseasePackAnyOfTriggerNode
  | DiseasePackNotTriggerNode

export const diseasePackTriggerNodeSchema: z.ZodType<DiseasePackTriggerNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('fact'),
      category: clinicalFactCategorySchema.optional(),
      itemCodes: z.array(boundedCode).min(1).max(64).optional(),
      itemCodePattern: z.string().trim().min(1).max(200).optional(),
      presence: z.enum(['present', 'absent']).default('present'),
      requireEligible: z.boolean().default(true),
      verificationStatus: clinicalFactVerificationStatusSchema.optional(),
      minValue: z.number().finite().optional(),
      maxValue: z.number().finite().optional(),
      unit: z.string().trim().min(1).max(64).optional(),
      textPattern: z.string().trim().min(1).max(200).optional(),
      withinDays: z.number().positive().max(36500).optional(),
      timestampField: diseasePackTimestampFieldSchema.optional(),
    }).strict().superRefine((node, ctx) => {
      if (node.category === undefined && node.itemCodes === undefined && node.itemCodePattern === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Fact trigger must declare category, itemCodes, or itemCodePattern',
        })
      }
      if (node.withinDays !== undefined && node.timestampField === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Fact trigger with withinDays must explicitly specify timestampField',
          path: ['timestampField'],
        })
      }
    }),
    z.object({
      kind: z.literal('sequence'),
      first: diseasePackTriggerNodeSchema,
      // oxlint-disable-next-line unicorn/no-thenable -- Schema preserves DSAP TriggerNode AST contract ('first' -> 'then').
      then: diseasePackTriggerNodeSchema,
      maxGapDays: z.number().positive().max(36500).optional(),
      requireDistinctEncounters: z.boolean().optional(),
      timestampField: diseasePackTimestampFieldSchema,
    }).strict(),
    z.object({
      kind: z.literal('allOf'),
      nodes: z.array(diseasePackTriggerNodeSchema).min(1).max(32),
    }).strict(),
    z.object({
      kind: z.literal('anyOf'),
      nodes: z.array(diseasePackTriggerNodeSchema).min(1).max(32),
    }).strict(),
    z.object({
      kind: z.literal('not'),
      node: diseasePackTriggerNodeSchema,
    }).strict(),
  ]),
)

export const diseasePackStageSchema = z.object({
  entryCondition: diseasePackTriggerNodeSchema,
  id: diseasePackSlugSchema,
  order: z.number().int().nonnegative(),
  orderSetIds: z.array(orderSetTemplateIdSchema).max(32).default([]),
  questionnaireItemCodes: z.array(boundedCode).max(32).default([]),
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

export const diseasePackRuleOutItemSchema = z.object({
  actionHintZh: nonEmptyText,
  id: diseasePackSlugSchema,
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

export const diseasePackOrderSetItemSchema = z.object({
  activeMedicationConflictCodes: z.array(boundedCode).max(32).optional(),
  catalogBindingCode: boundedCode.optional(),
  channel: z.enum(['laboratory', 'investigation', 'medication', 'procedure', 'nursing']).optional(),
  key: diseasePackSlugSchema,
  kind: z.enum(['laboratory', 'examination', 'imaging', 'medication', 'procedure', 'nursing']),
  panelServiceCodes: z.array(boundedCode).max(32).optional(),
  procedureCode: boundedCode.optional(),
  titleZh: nonEmptyText,
}).strict()

export const diseasePackOrderSetSchema = z.object({
  id: orderSetTemplateIdSchema,
  items: z.array(diseasePackOrderSetItemSchema).min(1).max(32),
  scopes: z.array(z.enum(['outpatient', 'inpatient'])).min(1).max(2),
  titleEn: nonEmptyText.optional(),
  titleZh: nonEmptyText,
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
    labelZh: nonEmptyText,
    maxScore: z.number().finite().nullable(),
    minScore: z.number().finite(),
  }).strict()).min(1).max(16),
  titleZh: nonEmptyText,
}).strict()

export const diseasePackIndicationRuleSchema = z.object({
  condition: diseasePackTriggerNodeSchema,
  id: diseasePackSlugSchema,
  itemCodePattern: z.string().trim().min(1).max(200),
  orderKind: z.enum(['laboratory', 'examination', 'imaging', 'pathology', 'medication', 'procedure']),
  rationaleZh: nonEmptyText,
}).strict()

export const diseasePackRiskTagSchema = z.object({
  condition: diseasePackTriggerNodeSchema,
  id: diseasePackSlugSchema,
  labelZh: nonEmptyText,
  severity: z.enum(['info', 'warning', 'critical']),
}).strict()

export const diseasePackExamCaseSchema = z.object({
  caseId: boundedId,
  expectedActive: z.boolean(),
  expectedBlockedTaskIds: z.array(boundedId).max(32).optional(),
  expectedStageId: diseasePackSlugSchema.optional(),
  titleZh: nonEmptyText,
}).strict()

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
  confusablePacks: z.array(diseasePackConfusablePackSchema).max(32).optional(),
  examSuite: diseasePackExamSuiteSchema,
  exitCriteria: z.array(diseasePackExitCriterionSchema).max(32).optional(),
  formulaRefs: z.array(diseasePackFormulaRefSchema).max(32).default([]),
  inapplicablePopulations: z.array(diseasePackInapplicablePopulationSchema).max(32).default([]),
  indicationRules: z.array(diseasePackIndicationRuleSchema).max(64).optional(),
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
  validityOverrides: z.array(diseasePackValidityOverrideSchema).max(64).optional(),
}).strict()

export const hospitalOverlaySchema = z.object({
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

export const diseasePackRuntimeEntrySchema = z.object({
  activationReason: diseasePackActivationReasonSchema,
  activationStatus: diseasePackActivationStatusSchema,
  allowedTools: z.array(boundedCode),
  currentStageId: diseasePackSlugSchema.nullable(),
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
  evaluatedAt: dt,
  packs: z.array(diseasePackRuntimeEntrySchema),
  subjectId: boundedId,
  subjectKind: z.enum(['outpatient', 'inpatient']),
}).strict()
export type DiseasePackRuntimeBundle = z.infer<typeof diseasePackRuntimeBundleSchema>

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
