import { z } from 'zod'
import { commandResponseSchema } from './his.ts'

const fen = z.number().int().nonnegative().safe()
export const insuranceTargetSchema = z.object({ kind: z.enum(['outpatient', 'inpatient']), id: z.string().min(1).max(64) }).strict()
export const insurancePlanCodeSchema = z.enum(['employee-v1', 'resident-v1'])
export const insurancePlans = {
  'employee-v1': { label: '合成职工医保 v1', initialAccountFen: 2000, outpatient: { deductibleFen: 1000, ratioBps: 7000, capFen: 100000 }, inpatient: { deductibleFen: 5000, ratioBps: 8000, capFen: 1000000 } },
  'resident-v1': { label: '合成居民医保 v1', initialAccountFen: 0, outpatient: { deductibleFen: 2000, ratioBps: 5000, capFen: 50000 }, inpatient: { deductibleFen: 10000, ratioBps: 6000, capFen: 500000 } },
} as const
export const insuranceCoverageSchema = z.object({ code: z.string().min(1), version: z.string().min(1), included: z.boolean(), priorSelfPayBps: z.number().int().min(0).max(10000) }).strict()
export const insuranceSourceSchema = z.object({ target: insuranceTargetSchema, patientId: z.string().min(1), accountId: z.string().min(1), encounterId: z.string().min(1), charges: z.array(z.object({ reference: z.string().min(1), label: z.string().min(1), version: z.string().min(1), amountFen: fen, coverage: insuranceCoverageSchema }).strict()) }).strict()
export type InsuranceSource = z.infer<typeof insuranceSourceSchema>
export type InsuranceTarget = z.infer<typeof insuranceTargetSchema>
export const insuranceBalanceSchema = z.object({ patientId: z.string(), year: z.string(), version: z.number().int().nonnegative(), planCode: insurancePlanCodeSchema.optional(), accountFen: fen, eligibleFen: fen, fundFen: fen, outpatientEligibleFen: fen, outpatientFundFen: fen, inpatientEligibleFen: fen, inpatientFundFen: fen }).strict()
export const insuranceAllocationSchema = z.object({ reference: z.string(), amountFen: fen, outsideFen: fen, priorSelfPayFen: fen, eligibleFen: fen, deductibleFen: fen, fundFen: fen, accountFen: fen, patientFen: fen }).strict()
export const insuranceSettlementSchema = z.object({ id: z.string(), target: insuranceTargetSchema, planCode: insurancePlanCodeSchema, year: z.string(), source: insuranceSourceSchema, sourceFingerprint: z.string(), allocations: z.array(insuranceAllocationSchema), totalFen: fen, fundFen: fen, accountFen: fen, patientFen: fen, eligibleFen: fen, deductibleFen: fen, balanceVersion: z.number().int(), createdAt: z.string(), reversesId: z.string().optional() }).strict()
export const insuranceStateSchema = z.object({ target: insuranceTargetSchema, balance: insuranceBalanceSchema, active: insuranceSettlementSchema.optional(), history: z.array(insuranceSettlementSchema) }).strict()
export const insurancePreviewInputSchema = z.object({ target: insuranceTargetSchema, planCode: insurancePlanCodeSchema }).strict()
export const insuranceConfirmInputSchema = z.object({ target: insuranceTargetSchema, previewId: z.string().min(1), commitToken: z.string().min(16).max(256) }).strict()
export const insuranceCancelInputSchema = z.object({ target: insuranceTargetSchema, settlementId: z.string().min(1), expectedBalanceVersion: z.number().int().nonnegative() }).strict()
export const insurancePreviewSchema = z.object({ previewId: z.string(), commitToken: z.string(), expiresAt: z.string(), settlement: insuranceSettlementSchema, balance: insuranceBalanceSchema }).strict()
export const insurancePreviewResponseSchema = commandResponseSchema(insurancePreviewSchema)
export const insuranceResponseSchema = commandResponseSchema(insuranceStateSchema)
