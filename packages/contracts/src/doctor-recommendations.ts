import { z } from 'zod'
import { commandResponseSchema, saveDiagnosisDraftRequestSchema, prescriptionDraftItemSchema } from './his.ts'
import { referenceConceptSnapshotSchema } from './reference-data.ts'
import { outpatientInvestigationPriceSchema } from './investigation-billing.ts'

export const doctorRecommendationKindSchema = z.enum(['laboratory', 'imaging', 'pathology', 'diagnosis', 'prescription'])
export type DoctorRecommendationKind = z.infer<typeof doctorRecommendationKindSchema>

const identity = z.string().trim().min(1).max(256)
const text = z.string().trim().min(1).max(2_000)
const notes = z.array(text).max(12)
const ids = z.array(identity).min(1).max(12)

export const guidelineEvidenceSchema = z.object({
  id: identity,
  title: text,
  publisher: text,
  documentType: z.enum(['national-standard', 'health-standard', 'guideline', 'official-protocol', 'product-information']),
  version: identity,
  publishedAt: z.iso.date().optional(),
  effectiveAt: z.iso.date().optional(),
  url: z.url(),
  locator: text,
  scope: text,
  text: z.string().trim().min(1).max(12_000),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type GuidelineEvidence = z.infer<typeof guidelineEvidenceSchema>

export const doctorCaseEvidenceSchema = z.object({
  id: identity,
  kind: z.enum(['consultation', 'draft', 'report', 'diagnosis', 'history', 'demographics', 'presentation']),
  label: text,
  text: z.string().trim().min(1).max(12_000),
  reference: identity.optional(),
}).strict()
export type DoctorCaseEvidence = z.infer<typeof doctorCaseEvidenceSchema>

const caseReasoning = {
  id: identity,
  label: text,
  rationale: text,
  supportingInformation: notes,
  opposingInformation: notes,
  missingInformation: notes,
  caseEvidenceIds: ids,
}
const common = { ...caseReasoning, guidelineEvidenceIds: ids }

export const doctorRecommendationConsiderationSchema = z.object(caseReasoning).strict()
export type DoctorRecommendationConsideration = z.infer<typeof doctorRecommendationConsiderationSchema>
export const doctorConsiderationDispositionStatusSchema = z.enum(['verified', 'dismissed'])
export type DoctorConsiderationDispositionStatus = z.infer<typeof doctorConsiderationDispositionStatusSchema>
export const doctorConsiderationDispositionSchema = z.object({
  labelKey: text,
  status: doctorConsiderationDispositionStatusSchema,
  label: text,
}).strict()
export type DoctorConsiderationDisposition = z.infer<typeof doctorConsiderationDispositionSchema>
// 处方类没有待核实思路通道，处置不开放。
export const doctorConsiderationDispositionKindSchema = doctorRecommendationKindSchema.exclude(['prescription'])
export type DoctorConsiderationDispositionKind = z.infer<typeof doctorConsiderationDispositionKindSchema>
// 思路处置按归一化标题字面匹配；重新生成后标题不同即视为新思路，不做语义模糊匹配。
export const considerationLabelKey = (label: string) => label.trim().replace(/\s+/g, ' ')
export const doctorRecommendationNoticeSchema = z.object({
  category: z.enum(['guideline', 'catalog', 'verification', 'processing']),
  message: z.string().trim().min(1).max(6_000),
}).strict()
export type DoctorRecommendationNotice = z.infer<typeof doctorRecommendationNoticeSchema>

export const doctorRecommendationSuggestionSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('laboratory'), catalogItemId: identity, indicationCode: identity }).strict(),
  z.object({ ...common, kind: z.literal('imaging'), serviceId: identity, indication: text }).strict(),
  z.object({ ...common, kind: z.literal('pathology'), serviceId: identity, sourceProcedureReference: identity, purpose: text }).strict(),
  z.object({ ...common, kind: z.literal('diagnosis'), catalogItemId: identity, role: z.enum(['primary', 'secondary']).optional(),
    referenceConcept: referenceConceptSnapshotSchema.optional() }).strict(),
  z.object({ ...common, kind: z.literal('prescription'), catalogItemId: identity,
    doseText: z.string().trim().min(1).max(256).nullable(),
    frequencyCode: z.string().trim().min(1).max(128).nullable(),
    courseDays: z.number().int().min(1).max(365).nullable(),
    quantity: z.number().int().min(1).max(10_000).nullable(),
  }).strict(),
])
export type DoctorRecommendationSuggestion = z.infer<typeof doctorRecommendationSuggestionSchema>

const generationSuggestionSchema = z.discriminatedUnion('kind', [
  doctorRecommendationSuggestionSchema.options[0],
  doctorRecommendationSuggestionSchema.options[1],
  doctorRecommendationSuggestionSchema.options[2],
  doctorRecommendationSuggestionSchema.options[3].extend({ role: z.enum(['primary', 'secondary']) }),
  doctorRecommendationSuggestionSchema.options[4],
])
export const doctorRecommendationGenerationSchema = z.object({
  items: z.array(generationSuggestionSchema).max(8),
  considerations: z.array(doctorRecommendationConsiderationSchema).max(8).optional(),
  missingInformation: notes,
}).strict().refine(output => output.items.length + (output.considerations?.length ?? 0) <= 8,
  'Suggestions and considerations together must not exceed eight')
export type DoctorRecommendationGeneration = z.infer<typeof doctorRecommendationGenerationSchema>

export const doctorRecommendationRecoverySchema = z.object({
  status: z.enum(['pending', 'running', 'failed', 'unknown', 'exhausted', 'completed']),
  requestCount: z.number().int().nonnegative(), extraRequestCount: z.number().int().min(0).max(4),
  maxRequestsPerUnit: z.literal(3), maxExtraRequests: z.literal(4), canContinue: z.boolean(),
  units: z.array(z.object({
    stage: z.enum(['history-selection', 'history-consolidation', 'catalog-selection', 'generation', 'verification']),
    batchId: z.string().min(1).max(256),
    status: z.enum(['pending', 'dispatching', 'succeeded', 'failed', 'unknown']),
    requestCount: z.number().int().min(0).max(3), errorCode: z.string().min(1).max(64).optional(),
  }).strict()).max(26),
}).strict()

export const doctorRecommendationStateSchema = z.object({
  caseId: identity,
  kind: doctorRecommendationKindSchema,
  encounterId: identity,
  encounterVersion: z.string().regex(/^\d+$/),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['idle', 'pending', 'ready', 'failed', 'missing-evidence']),
  generation: z.number().int().min(0),
  stale: z.boolean(),
  hidePreviousResults: z.literal(true).optional(),
  items: z.array(doctorRecommendationSuggestionSchema).max(8),
  // 当前医院服务投影由服务端读取合并，不来自模型，也不随建议持久化。
  laboratoryServices: z.array(z.object({
    id: identity,
    version: z.number().int().positive(),
    allowedIndicationCodes: z.array(identity).min(1),
    outpatientBilling: outpatientInvestigationPriceSchema.optional(),
  }).strict()).max(8).optional(),
  considerations: z.array(doctorRecommendationConsiderationSchema).max(8).optional(),
  considerationDispositions: z.array(doctorConsiderationDispositionSchema).max(64).optional(),
  notices: z.array(doctorRecommendationNoticeSchema).max(12).optional(),
  guidelines: z.array(guidelineEvidenceSchema).max(64),
  caseEvidence: z.array(doctorCaseEvidenceSchema).max(100),
  missingInformation: z.array(doctorRecommendationNoticeSchema.shape.message).max(12),
  errorCode: z.enum(['MODEL_UNAVAILABLE', 'MODEL_AUTH_FAILED', 'MODEL_TIMEOUT', 'AI_RESPONSE_INVALID', 'WORKFLOW_CONFLICT',
    'MODEL_OUTCOME_UNKNOWN', 'MODEL_REQUEST_LIMIT']).optional(),
  recovery: doctorRecommendationRecoverySchema.optional(),
}).strict().superRefine((state, context) => {
  const itemIds = new Set<string>()
  const guidelineIds = new Set(state.guidelines.map(item => item.id))
  const sourceIds = new Set(state.caseEvidence.map(item => item.id))
  const laboratoryServiceIds = new Set<string>()
  for (const [index, service] of (state.laboratoryServices ?? []).entries()) {
    if (state.kind !== 'laboratory' || laboratoryServiceIds.has(service.id)
      || !state.items.some(item => item.kind === 'laboratory' && item.catalogItemId === service.id)) {
      context.addIssue({ code: 'custom', path: ['laboratoryServices', index], message: 'Current services must uniquely match laboratory suggestions in this case' })
    }
    laboratoryServiceIds.add(service.id)
  }
  for (const [index, item] of state.items.entries()) {
    if (item.kind !== state.kind || itemIds.has(item.id)
      || item.guidelineEvidenceIds.some(id => !guidelineIds.has(id))
      || item.caseEvidenceIds.some(id => !sourceIds.has(id))) {
      context.addIssue({ code: 'custom', path: ['items', index], message: 'Suggestion requires unique identity and evidence in this case and kind' })
    }
    itemIds.add(item.id)
  }
  for (const [index, item] of (state.considerations ?? []).entries()) {
    if (state.kind === 'prescription' || itemIds.has(item.id) || item.caseEvidenceIds.some(id => !sourceIds.has(id))) {
      context.addIssue({ code: 'custom', path: ['considerations', index], message: 'Read-only diagnostic or investigation reasoning requires unique identity and actual case evidence' })
    }
    itemIds.add(item.id)
  }
  if (itemIds.size > 8) context.addIssue({ code: 'custom', path: ['items'], message: 'Suggestions and considerations together must not exceed eight' })
})
export type DoctorRecommendationState = z.infer<typeof doctorRecommendationStateSchema>

export const generateDoctorRecommendationsResponseSchema = commandResponseSchema(doctorRecommendationStateSchema)

export const generateDoctorRecommendationsRequestSchema = z.object({
  expectedVersions: saveDiagnosisDraftRequestSchema.shape.expectedVersions,
  input: z.object({
    expectedInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    refresh: z.boolean(),
    continueGeneration: z.number().int().positive().optional(),
  }).strict().refine(input => !input.refresh || input.continueGeneration === undefined,
    'Choose either continuing the original generation or starting a new generation'),
}).strict()
export type GenerateDoctorRecommendationsRequest = z.infer<typeof generateDoctorRecommendationsRequestSchema>


const preparationSelectionSource = {
  source: z.enum(['agent', 'manual']),
  suggestionId: identity.optional(),
}

/** 用户本次审阅的服务版本与完整门诊价目；null 明确表示审阅时缺价。 */
export const doctorReviewedInvestigationServiceSchema = z.object({
  id: z.string().min(1).max(512),
  version: z.number().int().positive(),
  outpatientBilling: outpatientInvestigationPriceSchema.nullable(),
}).strict()
export type DoctorReviewedInvestigationService = z.infer<typeof doctorReviewedInvestigationServiceSchema>

export const doctorPreparationSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ ...preparationSelectionSource, kind: z.literal('diagnosis'),
    catalogItemId: identity, role: z.enum(['primary', 'secondary']),
    referenceConcept: referenceConceptSnapshotSchema.optional(),
    note: z.string().trim().min(1).max(500).optional() }).strict(),
  z.object({ ...prescriptionDraftItemSchema.shape,
    ...preparationSelectionSource, kind: z.literal('prescription') }).strict(),
  z.object({ ...preparationSelectionSource, kind: z.literal('laboratory'),
    reviewedService: doctorReviewedInvestigationServiceSchema,
    catalogItemId: identity, indicationCode: z.string().min(1).max(64) }).strict(),
  z.object({ ...preparationSelectionSource, kind: z.literal('imaging'),
    reviewedService: doctorReviewedInvestigationServiceSchema,
    serviceId: z.string().min(1).max(128), indication: z.string().trim().min(2).max(500) }).strict(),
  z.object({ ...preparationSelectionSource, kind: z.literal('pathology'),
    reviewedService: doctorReviewedInvestigationServiceSchema,
    serviceId: z.string().min(1).max(128), purpose: z.string().trim().min(2).max(500),
    sourceProcedureReference: z.string().min(1).max(512) }).strict(),
]).superRefine((selection, context) => {
  if ((selection.source === 'agent') !== (selection.suggestionId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['suggestionId'], message: 'Agent selections require a suggestion identity; manual selections do not use an agent proof' })
  }
})
export type DoctorPreparationSelection = z.infer<typeof doctorPreparationSelectionSchema>

export const confirmDoctorPreparationRequestSchema = z.object({
  expectedVersions: saveDiagnosisDraftRequestSchema.shape.expectedVersions,
  input: z.object({
    generation: z.number().int().positive().optional(),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    expectedDraftVersion: z.number().int().nonnegative(),
    resolveExistingDraft: z.boolean().optional(),
    selections: z.array(doctorPreparationSelectionSchema).min(1).max(8),
  }).strict().superRefine((input, context) => {
    if (new Set(input.selections.map(selection => selection.kind)).size !== 1) {
      context.addIssue({ code: 'custom', path: ['selections'], message: 'Confirm one recommendation kind at a time' })
    }
    if (input.selections.some(selection => selection.source === 'agent')
      && (input.generation === undefined || input.inputFingerprint === undefined)) {
      context.addIssue({ code: 'custom', path: ['selections'], message: 'Agent selections require the current preparation generation and input fingerprint' })
    }
  }),
}).strict()
export type ConfirmDoctorPreparationRequest = z.infer<typeof confirmDoctorPreparationRequestSchema>

export const confirmDoctorPreparationResponseSchema = commandResponseSchema(z.object({
  kind: doctorRecommendationKindSchema,
  draftVersion: z.number().int().positive(),
  encounterVersion: z.string().regex(/^\d+$/),
  recordIds: z.array(identity).min(1).max(8),
}).strict())
export type ConfirmDoctorPreparationResponse = z.infer<typeof confirmDoctorPreparationResponseSchema>

// 思路处置不改变 Encounter 与临床事实，只按医生授权做幂等 upsert，不要求版本或幂等键。
export const setDoctorConsiderationDispositionRequestSchema = z.object({
  input: z.object({
    label: text,
    status: z.enum(['verified', 'dismissed', 'clear']),
  }).strict(),
}).strict()
export type SetDoctorConsiderationDispositionRequest = z.infer<typeof setDoctorConsiderationDispositionRequestSchema>
export const setDoctorConsiderationDispositionResponseSchema = z.object({
  dispositions: z.array(doctorConsiderationDispositionSchema).max(64),
}).strict()
export type SetDoctorConsiderationDispositionResponse = z.infer<typeof setDoctorConsiderationDispositionResponseSchema>
