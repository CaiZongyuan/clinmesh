import { z } from 'zod'
import { commandResponseSchema, paymentSimulatorRuleSchema, paymentTendersSchema } from './his.ts'
import { inpatientPaymentSchema } from './inpatient-discharge.ts'
import { refundAttemptSchema, refundSourceKindSchema } from './refunds.ts'
import { insuranceBalanceSchema, insuranceSettlementSchema } from './insurance.ts'

const id = z.string().regex(/^[A-Za-z0-9.:-]{1,128}$/)
const fen = z.number().int().nonnegative().safe()
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const insuranceAdjustmentBinding = { admissionId: id, adjustmentId: id }
export const inpatientFinancialInsuranceCancelInputSchema = z.object({ ...insuranceAdjustmentBinding, settlementId: id,
  expectedBalanceVersion: z.number().int().nonnegative(), expectedFingerprint: fingerprint }).strict()
export const inpatientFinancialInsurancePreviewInputSchema = z.object({ ...insuranceAdjustmentBinding, expectedFingerprint: fingerprint }).strict()
export const inpatientFinancialInsuranceConfirmInputSchema = z.object({ ...insuranceAdjustmentBinding,
  previewId: id, commitToken: z.string().min(16).max(256) }).strict()
export const inpatientFinancialInsuranceSchema = z.object({ original: insuranceSettlementSchema, active: insuranceSettlementSchema.optional(),
  balance: insuranceBalanceSchema, sourceFingerprint: fingerprint, ready: z.boolean(),
  cycles: z.array(z.object({ adjustmentId: id, originalSettlementId: id, compensationId: id, replacementSettlementId: id.optional() }).strict()) }).strict()
export const inpatientFinancialAdjustmentInputSchema = z.object({ admissionId: id, chargeId: id, direction: z.enum(['increase', 'decrease']).default('decrease'),
  amountFen: fen.positive().max(1_000_000_000), expectedFingerprint: fingerprint, reason: z.string().trim().min(5).max(1000) }).strict()
export const inpatientFinancialRefundPreviewInputSchema = z.object({ admissionId: id, adjustmentId: id,
  sourceKind: refundSourceKindSchema.exclude(['outpatient-payment']), sourceId: id, amountFen: fen.positive().max(1_000_000_000),
  expectedFingerprint: fingerprint, expectedSourceVersion: z.number().int().positive(), simulatorRule: paymentSimulatorRuleSchema }).strict()
export const inpatientFinancialRefundConfirmInputSchema = z.object({ admissionId: id, previewId: id, commitToken: z.string().min(16).max(256) }).strict()
export const inpatientFinancialRefundRecoverInputSchema = z.object({ admissionId: id, refundId: id, expectedRefundVersion: z.number().int().positive() }).strict()
export const inpatientFinancialPaymentPreviewInputSchema = z.object({ admissionId: id, adjustmentId: id,
  amountFen: fen.positive().max(1_000_000_000), tenders: paymentTendersSchema, expectedFingerprint: fingerprint, simulatorRule: paymentSimulatorRuleSchema }).strict()
  .refine(input => input.tenders.reduce((sum, tender) => sum + tender.amountFen, 0) === input.amountFen, '支付方式金额须等于收款金额')
export const inpatientFinancialSchema = z.object({
  admissionId: id, status: z.enum(['departed', 'cleared']), recordStatus: z.enum(['open', 'reviewed', 'archived']),
  firstSettlement: z.object({ id, chargesFen: fen, depositFen: fen, balanceFen: z.number().int().safe(), fingerprint, settledAt: z.string() }).strict(),
  charges: z.array(z.object({ chargeId: id, label: z.string(), originalFen: z.number().int().safe(), adjustedFen: fen, addedFen: fen, currentFen: z.number().int().safe() }).strict()),
  adjustments: z.array(z.object({ adjustmentId: id, chargeId: id, settlementId: id, direction: z.enum(['increase', 'decrease']), amountFen: fen.positive(), reason: z.string(),
    actorId: z.string(), practitionerRoleId: z.string(), createdAt: z.string(), refundedFen: fen, reservedFen: fen,
    collectedFen: fen, reservedCollectFen: fen, offsetFen: fen, remainingFen: fen,
    status: z.enum(['pending', 'unknown', 'completed']) }).strict()),
  sources: z.array(z.object({ sourceKind: refundSourceKindSchema.exclude(['outpatient-payment']), sourceId: id, amountFen: fen,
    refundedFen: fen, reservedFen: fen, refundableFen: fen, version: z.number().int().positive() }).strict()),
  refunds: z.array(refundAttemptSchema), payments: z.array(inpatientPaymentSchema.extend({ adjustmentId: id })), frozenChargesFen: fen, currentChargesFen: fen,
  insurance: inpatientFinancialInsuranceSchema.optional(),
  frozenFundsFen: fen, currentFundsFen: fen, remainingRefundFen: fen, remainingCollectFen: fen, reservedFen: fen, reservedCollectFen: fen, fingerprint,
}).strict()
export const inpatientFinancialResponseSchema = commandResponseSchema(inpatientFinancialSchema)
export const inpatientFinancialRefundPreviewResponseSchema = commandResponseSchema(z.object({ previewId: id, commitToken: z.string(),
  admissionId: id, adjustmentId: id, sourceKind: refundSourceKindSchema.exclude(['outpatient-payment']), sourceId: id,
  amountFen: fen.positive(), expectedOutcome: z.enum(['success', 'declined', 'ambiguous']), expiresAt: z.string() }).strict())
