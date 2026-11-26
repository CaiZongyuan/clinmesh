import { z } from 'zod'
import {
  modelTokenUsageSchema,
  modelUsageConfigurationSchema,
  modelUsageFeatureSchema,
  modelUsageOutcomeSchema,
} from './model-usage.ts'

export const modelBridgePath = '/clinmesh-model-bridge'
export const modelCapabilitiesPath = '/clinmesh-model-capabilities'
export const modelBridgeFirstTextHeader = 'x-clinmesh-model-first-text-ms'
export const modelBridgeAccountingMediaType = 'application/x-ndjson'

export const dshDefaultModel = 'dsh:default'
export const dshFastModel = 'dsh:fast'
export const modelTierSchema = z.enum(['strong', 'fast'])
export type ModelTier = z.infer<typeof modelTierSchema>
export const modelReasoningEffortDefault = 'default'
export const modelReasoningEffortAutoLowest = 'auto-lowest'

export type ModelUsageFeature = z.infer<typeof modelUsageFeatureSchema>

export const modelTaskTierByFeature = {
  doctor_delegation: 'fast',
  patient_dialogue_reply: 'fast',
  consultation_history_summary: 'fast',
  consultation_history_increment: 'fast',
  doctor_recommendation_history_selection: 'fast',
  doctor_recommendation_history_consolidation: 'fast',
  doctor_recommendation_catalog_selection: 'fast',
  patient_persona: 'fast',
  investigation_result: 'fast',
  investigation_service_result: 'fast',
  laboratory_service_enrichment: 'fast',
  doctor_recommendations: 'strong',
  doctor_recommendation_verification: 'strong',
  clinical_document_quality: 'strong',
  clinical_document_quality_verification: 'strong',
  inpatient_drg_recommendation: 'strong',
  inpatient_drg_verification: 'strong',
} as const satisfies Record<ModelUsageFeature, ModelTier>

export function dshModelForTier(tier: ModelTier): typeof dshDefaultModel | typeof dshFastModel {
  return tier === 'fast' ? dshFastModel : dshDefaultModel
}

export function dshTierForModel(model: string): ModelTier | undefined {
  if (model === dshDefaultModel) return 'strong'
  if (model === dshFastModel) return 'fast'
  return undefined
}

export const modelRouteSchema = z.object({
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  reasoningEffort: z.string().min(1).max(64).optional(),
}).strict()
export type ModelRoute = z.infer<typeof modelRouteSchema>

export const modelCapabilitiesRequestSchema = z.object({
  provider: modelRouteSchema.shape.provider,
  model: modelRouteSchema.shape.model,
}).strict()
export type ModelCapabilitiesRequest = z.infer<typeof modelCapabilitiesRequestSchema>

export const modelReasoningEffortOptionSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(512).optional(),
}).strict()
export type ModelReasoningEffortOption = z.infer<typeof modelReasoningEffortOptionSchema>

export const modelCapabilitiesResponseSchema = z.object({
  efforts: z.array(modelReasoningEffortOptionSchema).max(32),
  defaultEffort: z.string().min(1).max(64).optional(),
}).strict()
export type ModelCapabilitiesResponse = z.infer<typeof modelCapabilitiesResponseSchema>

/** A pinned route is stored intact in existing job/provenance model columns. */
export function encodeModelRoute(route: ModelRoute): string {
  return `dsh:${JSON.stringify(route)}`
}

export function decodeModelRoute(model: string): ModelRoute {
  if (!model.startsWith('dsh:{')) throw new Error('A pinned DSH model route is required')
  return modelRouteSchema.parse(JSON.parse(model.slice(4)))
}

export const modelBridgeRequestSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('resolve'),
    tier: modelTierSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('complete'),
    model: z.string().min(1).max(1024),
    schemaName: z.enum(['patient_persona', 'patient_dialogue_reply', 'consultation_history_increment',
      'consultation_history_summary', 'investigation_result',
      'investigation_service_result', 'laboratory_service_enrichment', 'doctor_recommendations',
      'doctor_recommendation_history_selection', 'doctor_recommendation_history_consolidation',
      'doctor_recommendation_catalog_selection', 'doctor_recommendation_verification',
      'inpatient_drg_recommendation', 'inpatient_drg_verification',
      'clinical_document_quality', 'clinical_document_quality_verification']),
    jsonSchema: z.record(z.string(), z.unknown()),
    systemPrompt: z.string().min(1).max(64 * 1024),
    userPayload: z.unknown(),
    timeoutMs: z.number().int().min(100).max(10 * 60_000).optional(),
    attemptId: z.string().uuid().optional(),
  }).strict(),
])
export const modelBridgeAccountingSchema = modelUsageOutcomeSchema.extend({ attemptId: z.string().uuid() }).strict()
export const modelBridgeResponseSchema = z.object({
  model: z.string().min(1).max(1024),
  content: z.string().optional(),
  accounting: modelBridgeAccountingSchema.optional(),
  firstTextMs: z.number().finite().nonnegative().max(10 * 60_000).optional(),
}).strict()
export const modelBridgeErrorSchema = z.discriminatedUnion('error', [
  z.object({ error: z.enum(['MODEL_UNAVAILABLE', 'MODEL_AUTH_FAILED', 'MODEL_TIMEOUT']), accounting: modelBridgeAccountingSchema.optional() }).strict(),
  z.object({ error: z.literal('MODEL_RATE_LIMIT'), retryAfterMs: z.number().int().positive().max(10 * 60_000).optional(), accounting: modelBridgeAccountingSchema.optional() }).strict(),
])

/** Only a trusted Server attempt can negotiate incremental, body-free usage metadata. */
export const modelBridgeFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('usage'), attemptId: z.string().uuid(), usage: modelTokenUsageSchema,
    configuration: modelUsageConfigurationSchema.optional() }).strict(),
  z.object({ type: z.literal('result'), attemptId: z.string().uuid(), result: modelBridgeResponseSchema }).strict(),
  z.object({ type: z.literal('error'), attemptId: z.string().uuid(), error: modelBridgeErrorSchema,
    httpStatus: z.number().int().min(400).max(599) }).strict(),
])
