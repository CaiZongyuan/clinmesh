import { z } from 'zod'
import { commandResponseSchema, paymentTendersSchema, paymentSimulatorRuleSchema } from './his.ts'
import { inpatientDetailSchema, inpatientAdmissionSchema } from './inpatient.ts'
import { inpatientChargeSchema } from './inpatient-clinical.ts'
import { refundAttemptSchema, refundSourceKindSchema } from './refunds.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const fen = z.number().int().nonnegative().safe()
const outcome = z.enum(['success', 'declined', 'ambiguous'])
export const inpatientPaymentInputSchema = z.object({ admissionId: id, kind: z.enum(['deposit', 'supplement']),
  amountFen: fen.positive(), tenders: paymentTendersSchema, simulatorRule: paymentSimulatorRuleSchema }).strict()
  .refine(input => input.tenders.reduce((sum, tender) => sum + tender.amountFen, 0) === input.amountFen, '支付方式金额须等于收款金额')
export const inpatientPaymentConfirmInputSchema = z.object({ admissionId: id, previewId: id, commitToken: z.string().min(1).max(256) }).strict()
export const inpatientPaymentRecoverInputSchema = z.object({ admissionId: id, paymentId: id, expectedPaymentVersion: z.number().int().positive() }).strict()
export const inpatientPaymentSchema = z.object({ paymentId: id, admissionId: id, kind: z.enum(['deposit', 'supplement']),
  amountFen: fen.positive(), tenders: paymentTendersSchema, initialOutcome: outcome, outcome,
  correlationId: z.string(), createdAt: z.iso.datetime({ offset: true }), resolvedAt: z.iso.datetime({ offset: true }).nullable(), version: z.number().int().positive() }).strict()
export const inpatientPaymentResponseSchema = commandResponseSchema(inpatientPaymentSchema)
export const inpatientPaymentPreviewResponseSchema = commandResponseSchema(z.object({ admissionId: id, previewId: id, commitToken: z.string(),
  kind: z.enum(['deposit', 'supplement']), amountFen: fen.positive(), tenders: paymentTendersSchema,
  expectedOutcome: outcome, expiresAt: z.iso.datetime({ offset: true }), fingerprint: z.string() }).strict())
export const inpatientPaymentsSchema = z.object({ admissionId: id, payments: z.array(inpatientPaymentSchema),
  depositFen: fen, supplementFen: fen, pendingCount: fen, refundedFen: fen, remainingFen: z.number().int().safe(),
  refunds: z.array(refundAttemptSchema), sources: z.array(z.object({ id, kind: refundSourceKindSchema, amountFen: fen, createdAt: z.string(), tenders: paymentTendersSchema.optional(),
    refundableFen: fen, refundedFen: fen, reservedFen: fen, version: z.number().int().positive() }).strict()) }).strict()
export const inpatientRefundInputSchema = z.object({ admissionId: id, sourceId: id, amountFen: fen.positive(), simulatorRule: paymentSimulatorRuleSchema }).strict()
export const inpatientRefundConfirmInputSchema = inpatientPaymentConfirmInputSchema
export const inpatientRefundRecoverInputSchema = z.object({ admissionId: id, refundId: id, expectedRefundVersion: z.number().int().positive() }).strict()
export const inpatientRefundPreviewResponseSchema = commandResponseSchema(z.object({ admissionId: id, previewId: id, commitToken: z.string(), sourceId: id,
  sourceKind: refundSourceKindSchema, amountFen: fen.positive(), expectedOutcome: outcome, expiresAt: z.string() }).strict())
export const inpatientDischargeInputSchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/), reason: z.string().trim().min(1).max(2000) }).strict()
const transaction = z.object({ id, virtualTime: z.iso.datetime({ offset: true }) })
const financialTransaction = z.discriminatedUnion('kind', [
  transaction.extend({ kind: z.literal('deposit'), amountFen: fen.positive() }).strict(),
  transaction.extend({ kind: z.literal('supplement'), amountFen: fen.positive() }).strict(),
  transaction.extend({ kind: z.literal('refund'), amountFen: z.number().int().negative().safe(), sourceDepositId: id.optional(), sourceSupplementId: id.optional() }).strict()
    .refine(value => (value.sourceDepositId === undefined) !== (value.sourceSupplementId === undefined), '退款须引用唯一原入金'),
])
const settlement = z.object({ id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), chargesFen: fen, depositFen: fen,
  balanceFen: z.number().int().safe(), settledAt: z.iso.datetime({ offset: true }) }).strict()
export const inpatientSettlementPreviewSchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/),
  status: inpatientAdmissionSchema.shape.status, financialStatus: inpatientAdmissionSchema.shape.financialStatus,
  charges: z.array(inpatientChargeSchema), chargesFen: fen, depositFen: fen, balanceFen: z.number().int().safe(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), transactions: z.array(financialTransaction), settlement: settlement.optional(),
}).strict()
export const inpatientSettleInputSchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/),
  fingerprint: inpatientSettlementPreviewSchema.shape.fingerprint, expectedChargesFen: fen, expectedBalanceFen: z.number().int().safe() }).strict()
export const inpatientDischargeResponseSchema = commandResponseSchema(inpatientDetailSchema)
export const inpatientSettlementResponseSchema = commandResponseSchema(inpatientSettlementPreviewSchema)

export const inpatientDepartureMethodSchema = z.enum(['home','transfer','against-advice','death','other'])
export const inpatientDepartInputSchema = inpatientDischargeInputSchema.extend({ departureMethod: inpatientDepartureMethodSchema })
export const inpatientDischargeEventsSchema = z.object({ admissionId: id, events: z.array(z.object({
  id, kind: z.enum(['issue','depart','recall','clear']), reason: z.string(), bedId: id,
  departureMethod: inpatientDepartureMethodSchema.optional(), reversesEventId: id.optional(),
  actorId: z.string(), practitionerRoleId: z.string(), virtualTime: z.iso.datetime({ offset: true }),
}).strict()) }).strict()
