import { z } from 'zod'
import { commandResponseSchema, paymentSimulatorRuleSchema, paymentTendersSchema } from './his.ts'

const id = z.string().min(1)
const fen = z.number().int().nonnegative().safe()
const positiveFen = fen.positive().max(1_000_000_000)
export const refundSourceKindSchema = z.enum(['outpatient-payment', 'inpatient-deposit', 'inpatient-supplement'])
export const refundAttemptSchema = z.object({
  refundId: id, sourceKind: refundSourceKindSchema, sourceId: id, basisId: id,
  ownerKind: z.enum(['outpatient', 'inpatient']), ownerId: id, amountFen: positiveFen,
  initialOutcome: z.enum(['success', 'declined', 'ambiguous']), outcome: z.enum(['success', 'declined', 'ambiguous']),
  correlationId: id, createdAt: id, resolvedAt: id.nullable(), version: z.number().int().positive(),
  tenders: paymentTendersSchema.optional(),
}).strict()
export const refundResponseSchema = commandResponseSchema(refundAttemptSchema)
export const chargeAdjustmentInputSchema = z.object({ chargeItemId: id, amountFen: positiveFen, reason: z.string().trim().min(5).max(1000) }).strict()
export const chargeAdjustmentResponseSchema = commandResponseSchema(z.object({ adjustmentId: id, chargeItemId: id, adjustedFen: positiveFen, chargeVersion: z.number().int().positive() }))
export const refundPreviewInputSchema = z.object({ paymentId: id, amountFen: positiveFen, expectedSourceVersion: z.number().int().positive(), simulatorRule: paymentSimulatorRuleSchema }).strict()
export const refundConfirmInputSchema = z.object({ commitToken: z.string().min(16).max(256) }).strict()
export const refundRecoverInputSchema = z.object({ expectedRefundVersion: z.number().int().positive() }).strict()
export const refundPreviewResponseSchema = commandResponseSchema(z.object({
  previewId: id, commitToken: id, sourceId: id, chargeItemId: id, amountFen: positiveFen,
  refundableFen: fen, expectedSourceVersion: z.number().int().positive(), expectedOutcome: z.enum(['success', 'declined', 'ambiguous']), expiresAt: id,
}))
export const refundCaseSchema = z.object({
  caseId: id,
  adjustments: z.array(z.object({ adjustmentId: id, chargeItemId: id, amountFen: positiveFen, reason: id, createdAt: id })),
  refunds: z.array(refundAttemptSchema),
  sources: z.array(z.object({ sourceId: id, chargeItemId: id, amountFen: fen, refundedFen: fen, reservedFen: fen, refundableFen: fen, version: z.number().int().positive() })),
  adjustedFen: fen, refundedFen: fen, reservedFen: fen,
}).strict()
