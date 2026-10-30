import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
import { inpatientDrgAgentObservationSchema } from './inpatient-drg-agent.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)

export const inpatientDrgExplanationResultSchema = z.object({
  id, fingerprint, model: z.string().min(1).max(1024), createdAt: z.iso.datetime({ offset: true }),
  observations: z.array(inpatientDrgAgentObservationSchema).max(500),
}).strict()
export const inpatientDrgExplanationSchema = z.object({
  admissionId: id, taskId: id.nullable(), version: z.number().int().nonnegative(), fingerprint,
  status: z.enum(['idle', 'queued', 'running', 'succeeded', 'stale', 'blocked', 'unknown', 'failed', 'frozen']),
  failureCode: z.string().nullable(), result: inpatientDrgExplanationResultSchema.nullable(),
}).strict()
export type InpatientDrgExplanation = z.infer<typeof inpatientDrgExplanationSchema>
export const inpatientDrgExplanationResponseSchema = commandResponseSchema(inpatientDrgExplanationSchema)
export const inpatientDrgExplainInputSchema = z.object({
  admissionId: id, expectedFingerprint: fingerprint, expectedVersion: z.number().int().nonnegative(),
}).strict()

export const inpatientDrgExplanationGenerationSchema = z.object({
  observations: z.array(inpatientDrgAgentObservationSchema).max(500)
    .refine(items => new Set(items.map(item => item.key)).size === items.length, '核对解释不得重复'),
}).strict()
export const inpatientDrgExplanationVerificationSchema = z.object({
  observations: z.array(z.object({ key: z.string().min(1).max(256), supported: z.boolean(),
    reason: z.string().trim().min(1).max(2000) }).strict()).max(500)
    .refine(items => new Set(items.map(item => item.key)).size === items.length, '核对核验不得重复'),
}).strict()
