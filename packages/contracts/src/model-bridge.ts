import { z } from 'zod'

export const modelBridgePath = '/clinmesh-model-bridge'
export const dshDefaultModel = 'dsh:default'
export const modelRouteSchema = z.object({
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  reasoningEffort: z.string().min(1).max(64).optional(),
}).strict()
export type ModelRoute = z.infer<typeof modelRouteSchema>

/** A pinned route is stored intact in existing job/provenance model columns. */
export function encodeModelRoute(route: ModelRoute): string {
  return `dsh:${JSON.stringify(route)}`
}

export function decodeModelRoute(model: string): ModelRoute {
  if (!model.startsWith('dsh:{')) throw new Error('A pinned DSH model route is required')
  return modelRouteSchema.parse(JSON.parse(model.slice(4)))
}

export const modelBridgeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('resolve') }).strict(),
  z.object({
    operation: z.literal('complete'),
    model: z.string().min(1).max(1024),
    schemaName: z.enum(['patient_persona', 'patient_dialogue_reply', 'investigation_result',
      'investigation_service_result', 'laboratory_service_enrichment']),
    jsonSchema: z.record(z.string(), z.unknown()),
    systemPrompt: z.string().min(1).max(64 * 1024),
    userPayload: z.unknown(),
  }).strict(),
])
export const modelBridgeResponseSchema = z.object({
  model: z.string().min(1).max(1024),
  content: z.string().optional(),
}).strict()
