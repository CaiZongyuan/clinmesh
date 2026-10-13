import { z } from 'zod'
import { saveDiagnosisDraftRequestSchema } from './his.ts'
import { referenceConceptSnapshotSchema } from './reference-data.ts'

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

const common = {
  id: identity,
  label: text,
  rationale: text,
  supportingInformation: notes,
  opposingInformation: notes,
  missingInformation: notes,
  guidelineEvidenceIds: ids,
  caseEvidenceIds: ids,
}

export const doctorRecommendationSuggestionSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('laboratory'), catalogItemId: identity, indicationCode: identity }).strict(),
  z.object({ ...common, kind: z.literal('imaging'), serviceId: identity, indication: text }).strict(),
  z.object({ ...common, kind: z.literal('pathology'), serviceId: identity, sourceProcedureReference: identity, purpose: text }).strict(),
  z.object({ ...common, kind: z.literal('diagnosis'), catalogItemId: identity,
    referenceConcept: referenceConceptSnapshotSchema.optional() }).strict(),
  z.object({ ...common, kind: z.literal('prescription'), catalogItemId: identity,
    doseText: z.string().trim().min(1).max(256).nullable(),
    frequencyCode: z.string().trim().min(1).max(128).nullable(),
    courseDays: z.number().int().min(1).max(365).nullable(),
    quantity: z.number().int().min(1).max(10_000).nullable(),
  }).strict(),
])
export type DoctorRecommendationSuggestion = z.infer<typeof doctorRecommendationSuggestionSchema>

export const doctorRecommendationGenerationSchema = z.object({
  items: z.array(doctorRecommendationSuggestionSchema).max(8),
  missingInformation: notes,
}).strict()
export type DoctorRecommendationGeneration = z.infer<typeof doctorRecommendationGenerationSchema>

export const doctorRecommendationStateSchema = z.object({
  caseId: identity,
  kind: doctorRecommendationKindSchema,
  encounterId: identity,
  encounterVersion: z.string().regex(/^\d+$/),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['idle', 'pending', 'ready', 'failed', 'missing-evidence']),
  generation: z.number().int().min(0),
  stale: z.boolean(),
  items: z.array(doctorRecommendationSuggestionSchema).max(8),
  guidelines: z.array(guidelineEvidenceSchema).max(64),
  caseEvidence: z.array(doctorCaseEvidenceSchema).max(100),
  missingInformation: notes,
  errorCode: z.enum(['MODEL_UNAVAILABLE', 'MODEL_AUTH_FAILED', 'MODEL_TIMEOUT', 'AI_RESPONSE_INVALID', 'WORKFLOW_CONFLICT']).optional(),
}).strict().superRefine((state, context) => {
  const itemIds = new Set<string>()
  const guidelineIds = new Set(state.guidelines.map(item => item.id))
  const sourceIds = new Set(state.caseEvidence.map(item => item.id))
  for (const [index, item] of state.items.entries()) {
    if (item.kind !== state.kind || itemIds.has(item.id)
      || item.guidelineEvidenceIds.some(id => !guidelineIds.has(id))
      || item.caseEvidenceIds.some(id => !sourceIds.has(id))) {
      context.addIssue({ code: 'custom', path: ['items', index], message: 'Suggestion requires unique identity and evidence in this case and kind' })
    }
    itemIds.add(item.id)
  }
})
export type DoctorRecommendationState = z.infer<typeof doctorRecommendationStateSchema>

export const generateDoctorRecommendationsRequestSchema = z.object({
  expectedVersions: saveDiagnosisDraftRequestSchema.shape.expectedVersions,
  input: z.object({
    expectedInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    refresh: z.boolean(),
  }).strict(),
}).strict()
export type GenerateDoctorRecommendationsRequest = z.infer<typeof generateDoctorRecommendationsRequestSchema>
