import { inpatientDrgAgentSchema, inpatientDrgAgentObservationSchema } from './inpatient-drg-agent.ts'
import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
import { inpatientDrgSimulationSchema } from './inpatient-drg-simulation.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const text = z.string().trim().min(1).max(2000)
export const inpatientDrgReviewIssueSchema = z.object({
  key: z.string().min(1).max(256), kind: z.enum(['extra-use', 'unused-plan', 'unplanned-product', 'replacement', 'billing-mismatch', 'missing-plan', 'grouping-incomplete', 'primary-procedure-difference', 'grouping-difference']),
  requestId: id.optional(), executionId: id.optional(), procedureDisplay: text.optional(),
  ownerRole: z.enum(['inpatient-doctor', 'cashier', 'medical-records']), materialId: id.nullable(), display: text,
  plannedQuantity: z.number().int().nonnegative().nullable(), actualQuantity: z.number().int().nonnegative().nullable(),
  explanation: text, evidence: z.array(z.string().min(1).max(512)).min(1).max(100),
}).strict()
export const inpatientDrgReviewBasisSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.object({ formalDrgCode: z.string().nullable(), formalChargesFen: z.number().int().safe().nullable(), projectedTotalFen: z.number().int().safe().nullable() }).strict(),
  simulation: inpatientDrgSimulationSchema.nullable(), issues: z.array(inpatientDrgReviewIssueSchema),
  comparisons: z.array(z.object({ requestId: id.optional(), executionId: id.optional(), procedureDisplay: text.optional(), materialId: id, catalogVersion: z.number().int().positive(), display: text,
    plannedQuantity: z.number().int().nonnegative().nullable(), actualQuantity: z.number().int().nonnegative() }).strict()),
  missing: z.array(text),
}).strict()
export type InpatientDrgReviewBasis = z.infer<typeof inpatientDrgReviewBasisSchema>

/** 无需活动跟进的确定性记录核对；来源来自当前岗位可见的正式记录和计划。 */
export const inpatientDrgRecordChecksSchema = z.object({
  admissionId: id, encounterVersion: z.string().regex(/^\d+$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['complete', 'incomplete', 'frozen']),
  simulation: inpatientDrgSimulationSchema.nullable(),
  issues: z.array(inpatientDrgReviewIssueSchema),
  sources: z.array(z.object({ reference: z.string().min(1).max(512), display: text,
    target: z.enum(['record', 'surgery', 'orders', 'drg']) }).strict()),
  paymentStatus: z.enum(['available', 'missing', 'grouping-incomplete']),
  paymentMessage: text,
  missing: z.array(text),
}).strict()
export type InpatientDrgRecordChecks = z.infer<typeof inpatientDrgRecordChecksSchema>
export const inpatientDrgReviewTodoSchema = inpatientDrgReviewIssueSchema.extend({
  id, version: z.number().int().positive(), evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'in-progress', 'resolved', 'dismissed']), reason: text.nullable(),
}).strict()
export const inpatientDrgReviewSchema = z.object({
  admissionId: id, taskId: id.nullable(), version: z.number().int().nonnegative(),
  status: z.enum(['waiting-surgery', 'complete', 'incomplete', 'frozen', 'inactive']),
  fingerprint: z.string().nullable(), freezeReason: text.nullable().default(null), summary: inpatientDrgReviewBasisSchema.shape.summary,
  simulation: inpatientDrgSimulationSchema.nullable(), comparisons: inpatientDrgReviewBasisSchema.shape.comparisons,
  missing: z.array(text), todos: z.array(inpatientDrgReviewTodoSchema), resolvedTodos: z.array(inpatientDrgReviewTodoSchema),
  actions: z.array(z.object({ todoId: id.nullable(), action: z.string(), note: text, actorId: z.string(), role: z.string(), at: z.iso.datetime({ offset: true }) }).strict()),
  model: z.object({ current: z.boolean(), status: inpatientDrgAgentSchema.shape.status, failureCode: z.string().nullable(), observations: z.array(inpatientDrgAgentObservationSchema) }).strict().nullable(),
  handedOver: z.object({ by: z.string(), role: z.string(), at: z.iso.datetime({ offset: true }), note: text }).strict().nullable(),
}).strict()
export const inpatientDrgReviewResponseSchema = commandResponseSchema(inpatientDrgReviewSchema)
export const inpatientDrgReviewTodoActionInputSchema = z.object({ admissionId: id, todoId: id,
  expectedTodoVersion: z.number().int().positive(), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(['in-progress', 'dismiss', 'resolve', 'recheck']), note: text,
}).strict()
export const inpatientDrgReviewHandoffInputSchema = z.object({ admissionId: id, expectedVersion: z.number().int().nonnegative(), note: text }).strict()
