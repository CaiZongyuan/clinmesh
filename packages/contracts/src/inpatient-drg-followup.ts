import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
import { inpatientDrgSimulationSchema } from './inpatient-drg-simulation.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
export const inpatientDrgFollowupTaskSchema = z.object({
  id, admissionId: id, status: z.enum(['active', 'stopped', 'authorization-lost', 'archived']),
  version: z.number().int().positive(), startedAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
  reason: z.string().max(2000).nullable(), ruleStatus: z.enum(['pending', 'complete', 'incomplete', 'stale']),
  fingerprint: z.string().nullable(), simulation: inpatientDrgSimulationSchema.nullable(),
  errorCode: z.string().nullable(), exceptionAlert: z.enum(['triggered', 'below-threshold', 'unknown']),
  /** 此规则路径没有模型派发；后续模型请求由模型用量 owner 归集。 */
  modelRequests: z.literal(0),
}).strict()
export type InpatientDrgFollowupTask = z.infer<typeof inpatientDrgFollowupTaskSchema>
export const inpatientDrgFollowupSchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/),
  task: inpatientDrgFollowupTaskSchema.nullable() }).strict()
export const inpatientDrgFollowupStartInputSchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/),
  expectedTaskVersion: z.number().int().nonnegative() }).strict()
export const inpatientDrgFollowupStopInputSchema = inpatientDrgFollowupStartInputSchema.extend({ reason: z.string().trim().min(1).max(2000) }).strict()
export const inpatientDrgFollowupResponseSchema = commandResponseSchema(inpatientDrgFollowupSchema)
