import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
import { inpatientDetailSchema, inpatientAdmissionSchema } from './inpatient.ts'
import { inpatientChargeSchema } from './inpatient-clinical.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const fen = z.number().int().nonnegative().safe()
export const inpatientDischargeInputSchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/), reason: z.string().trim().min(1).max(2000) }).strict()
const transaction = z.object({ id, virtualTime: z.iso.datetime({ offset: true }) })
const financialTransaction = z.discriminatedUnion('kind', [
  transaction.extend({ kind: z.literal('deposit'), amountFen: fen.positive() }).strict(),
  transaction.extend({ kind: z.literal('supplement'), amountFen: fen.positive() }).strict(),
  transaction.extend({ kind: z.literal('refund'), amountFen: z.number().int().negative().safe(), sourceDepositId: id }).strict(),
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
