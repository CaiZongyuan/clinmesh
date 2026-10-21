import { z } from 'zod'

const identifier = z.string().min(1).max(256).regex(/^[\p{L}\p{N}_.:/@+{}", -]+$/u)
const modelName = z.string().min(1).max(1024).regex(/^[\p{L}\p{N}_.:/@+{}", -]+$/u)
const count = z.number().int().nonnegative().safe().nullable()
export const modelUsageFeatureSchema = z.enum(['patient_persona', 'patient_dialogue_reply',
  'consultation_history_increment', 'consultation_history_summary', 'investigation_result',
  'investigation_service_result', 'laboratory_service_enrichment', 'doctor_recommendations',
  'doctor_recommendation_history_selection', 'doctor_recommendation_history_consolidation',
  'doctor_recommendation_catalog_selection', 'doctor_recommendation_verification',
  'clinical_document_quality', 'clinical_document_quality_verification'])
export const modelUsageSourceSchema = z.object({
  kind: z.enum(['case', 'turn', 'recording-source', 'batch', 'report', 'job', 'document', 'unknown']),
  id: identifier,
  relationship: z.enum(['trigger', 'evidence']),
}).strict()
/** Server-created metadata only; never inferred from prompt or model text. */
export const modelUsageContextSchema = z.object({
  workspaceId: identifier, epoch: identifier, taskId: identifier,
  actorId: identifier.optional(), practitionerRoleId: identifier.optional(),
  caseId: identifier.optional(), encounterId: identifier.optional(),
  stage: identifier, trigger: z.enum(['automatic', 'manual', 'recovery', 'unknown']),
  sources: z.array(modelUsageSourceSchema).max(256),
}).strict()
export type ModelUsageContext = z.infer<typeof modelUsageContextSchema>

/** Input includes cached input; output includes reasoning. Subsets are never added twice. */
export const modelTokenUsageSchema = z.object({
  inputTokens: count, outputTokens: count, cachedInputTokens: count,
  reasoningOutputTokens: count, totalTokens: count,
  mapping: z.enum(['openai-v1', 'dsh-v1', 'unknown']),
}).strict()
export type ModelTokenUsage = z.infer<typeof modelTokenUsageSchema>
export const unknownModelTokenUsage: ModelTokenUsage = {
  inputTokens: null, outputTokens: null, cachedInputTokens: null,
  reasoningOutputTokens: null, totalTokens: null, mapping: 'unknown',
}

/** Usage snapshots replace reported counters; omitted counters cannot erase known consumption. */
export function mergeModelTokenUsage(known: ModelTokenUsage, next: ModelTokenUsage): ModelTokenUsage {
  return {
    inputTokens: next.inputTokens ?? known.inputTokens,
    outputTokens: next.outputTokens ?? known.outputTokens,
    cachedInputTokens: next.cachedInputTokens ?? known.cachedInputTokens,
    reasoningOutputTokens: next.reasoningOutputTokens ?? known.reasoningOutputTokens,
    totalTokens: next.totalTokens ?? known.totalTokens,
    mapping: next.mapping === 'unknown' ? known.mapping : next.mapping,
  }
}
export const modelUsageOutcomeSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']),
  dispatch: z.enum(['dispatched', 'not-dispatched', 'unknown']).optional(),
  usage: modelTokenUsageSchema,
  actualModel: modelName.optional(), providerRequestId: identifier.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
}).strict()
export type ModelUsageOutcome = z.infer<typeof modelUsageOutcomeSchema>
export const modelUsageAttemptSchema = z.object({
  id: z.string().uuid(), context: modelUsageContextSchema, feature: modelUsageFeatureSchema,
  provider: identifier, requestedModel: modelName, actualModel: modelName.nullable(),
  reasoningEffort: identifier.nullable(), outputLimit: count,
  kind: z.enum(['initial', 'format-repair', 'rate-limit-retry']),
  status: z.enum(['in-flight', 'succeeded', 'failed', 'cancelled', 'unknown']),
  dispatch: z.enum(['dispatched', 'not-dispatched', 'unknown']).default('unknown'),
  startedAt: z.string().datetime(), endedAt: z.string().datetime().nullable(),
  providerRequestId: identifier.nullable(), httpStatus: z.number().int().nullable(),
  usage: modelTokenUsageSchema,
  cost: z.object({ status: z.literal('price-not-configured'), cny: z.null() }).strict(),
}).strict()
export type ModelUsageAttempt = z.infer<typeof modelUsageAttemptSchema>
export const modelUsageFilterSchema = z.object({
  from: z.string().date().optional(), to: z.string().date().optional(),
  feature: modelUsageFeatureSchema.optional(), provider: identifier.optional(), model: modelName.optional(),
  status: modelUsageAttemptSchema.shape.status.optional(), caseId: identifier.optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict()
export type ModelUsageFilter = z.infer<typeof modelUsageFilterSchema>
const totalsSchema = z.object({
  requests: z.number().int().nonnegative(), inFlight: z.number().int().nonnegative(),
  unknownRequests: z.number().int().nonnegative(), knownTokens: z.number().nonnegative(),
  unknownTokenRequests: z.number().int().nonnegative(), unpricedRequests: z.number().int().nonnegative(),
  cny: z.null(),
}).strict()
export const modelUsageOverviewSchema = z.object({
  totals: totalsSchema,
  trend: z.array(z.object({ date: z.string().date(), requests: z.number().int(), knownTokens: z.number() }).strict()),
  features: z.array(z.object({ feature: modelUsageFeatureSchema, requests: z.number().int(), knownTokens: z.number() }).strict()),
  coverage: z.literal('server-direct-and-bridge'),
  policy: z.object({ enabled: z.literal(true), requests: z.null(), tokens: z.null(), cny: z.null() }).strict(),
}).strict()
export type ModelUsageOverview = z.infer<typeof modelUsageOverviewSchema>
export const modelUsageListSchema = z.object({ items: z.array(modelUsageAttemptSchema), total: z.number().int().nonnegative() }).strict()
