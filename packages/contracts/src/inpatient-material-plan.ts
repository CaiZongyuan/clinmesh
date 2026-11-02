import { z } from 'zod'
import { inpatientDrgAgentMaterialSchema, inpatientDrgAgentSourcesSchema } from './inpatient-drg-agent.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
/** 医生实际确认的不可变术前依据；数量不随预留余额变化。 */
export const inpatientMaterialPlanSchema = z.object({
  reference: z.string().min(1).max(512), requestId: id,
  source: z.enum(['material-estimate', 'drg-agent']), sourceId: id,
  sourceVersion: z.number().int().positive(),
  basisFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sources: inpatientDrgAgentSourcesSchema,
  confirmedBy: z.string().min(1), confirmedAt: z.iso.datetime({ offset: true }),
  supersedes: z.string().min(1).max(512).nullable(),
  items: z.array(inpatientDrgAgentMaterialSchema.extend({ specification: z.string().min(1).nullable() }).strict()).max(20),
  reservationIds: z.array(id).max(20),
}).strict()
export const inpatientMaterialPlanBasisSchema = z.object({
  requestId: id, status: z.enum(['confirmed', 'missing', 'unverifiable', 'conflict']),
  effectiveReference: z.string().min(1).max(512).nullable(),
  history: z.array(inpatientMaterialPlanSchema),
}).strict()
export type InpatientMaterialPlan = z.infer<typeof inpatientMaterialPlanSchema>
export type InpatientMaterialPlanBasis = z.infer<typeof inpatientMaterialPlanBasisSchema>
