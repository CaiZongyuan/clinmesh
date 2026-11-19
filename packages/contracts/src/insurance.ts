import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
export { catalogInsuranceCoverageSchema } from './investigation-billing.ts'
export type { CatalogInsuranceCoverage } from './investigation-billing.ts'

const s = z.string()
const str = s.min(1)
const fen = z.number().int().nonnegative().safe()
export const insuranceTargetSchema = z.object({ kind: z.enum(['outpatient', 'inpatient']), id: str.max(64) }).strict()
export const insurancePlanCodeSchema = z.enum(['employee-v1', 'resident-v1'])
export type InsurancePlanCode = z.infer<typeof insurancePlanCodeSchema>
export const insurancePlans = {
  'employee-v1': { label: '合成职工医保 v1', initialAccountFen: 2000, outpatient: { deductibleFen: 1000, ratioBps: 7000, capFen: 100000 }, inpatient: { deductibleFen: 5000, ratioBps: 8000, capFen: 1000000 } },
  'resident-v1': { label: '合成居民医保 v1', initialAccountFen: 0, outpatient: { deductibleFen: 2000, ratioBps: 5000, capFen: 50000 }, inpatient: { deductibleFen: 10000, ratioBps: 6000, capFen: 500000 } },
} as const
export const insuranceCoverageSchema = z.object({ code: str, version: str, included: z.boolean(), priorSelfPayBps: z.number().int().min(0).max(10000) }).strict()
export type InsuranceCoverage = z.infer<typeof insuranceCoverageSchema>
export const insuranceChargeItemSchema = z.object({ id: str.optional(), label: str, quantity: z.number().int().positive().optional(), amountFen: fen, coverage: insuranceCoverageSchema }).strict()
export const insuranceAllocationItemSchema = insuranceChargeItemSchema.extend({ outsideFen: fen, priorSelfPayFen: fen, eligibleFen: fen }).strict()
export const insuranceSourceSchema = z.object({ target: insuranceTargetSchema, patientId: str, accountId: str, encounterId: str, charges: z.array(z.object({ reference: str, label: str, version: str, amountFen: fen, coverage: insuranceCoverageSchema, items: z.array(insuranceChargeItemSchema).min(1).optional() }).strict()) }).strict()
export type InsuranceSource = z.infer<typeof insuranceSourceSchema>
export type InsuranceTarget = z.infer<typeof insuranceTargetSchema>
export const insuranceBalanceSchema = z.object({ patientId: s, year: s, version: z.number().int().nonnegative(), planCode: insurancePlanCodeSchema.optional(), accountFen: fen, eligibleFen: fen, fundFen: fen, outpatientEligibleFen: fen, outpatientFundFen: fen, inpatientEligibleFen: fen, inpatientFundFen: fen }).strict()
export type InsuranceBalance = z.infer<typeof insuranceBalanceSchema>
export const insuranceAllocationSchema = z.object({ reference: s, amountFen: fen, outsideFen: fen, priorSelfPayFen: fen, eligibleFen: fen, deductibleFen: fen, fundFen: fen, accountFen: fen, patientFen: fen, items: z.array(insuranceAllocationItemSchema).min(1).optional() }).strict()
export type InsuranceAllocation = z.infer<typeof insuranceAllocationSchema>
export const insuranceSettlementSchema = z.object({ id: s, target: insuranceTargetSchema, planCode: insurancePlanCodeSchema, year: s, source: insuranceSourceSchema, sourceFingerprint: s, allocations: z.array(insuranceAllocationSchema), totalFen: fen, fundFen: fen, accountFen: fen, patientFen: fen, eligibleFen: fen, deductibleFen: fen, balanceVersion: z.number().int(), createdAt: s, reversesId: s.optional() }).strict()
export type InsuranceSettlement = z.infer<typeof insuranceSettlementSchema>
export const insuranceStateSchema = z.object({ target: insuranceTargetSchema, balance: insuranceBalanceSchema, annualBalances: z.array(insuranceBalanceSchema).default([]), active: insuranceSettlementSchema.optional(), activeSettlements: z.array(insuranceSettlementSchema).default([]), history: z.array(insuranceSettlementSchema) }).strict()
export const insurancePreviewInputSchema = z.object({ target: insuranceTargetSchema, planCode: insurancePlanCodeSchema }).strict()
export const insuranceConfirmInputSchema = z.object({ target: insuranceTargetSchema, previewId: str, commitToken: s.min(16).max(256) }).strict()
export const insuranceCancelInputSchema = z.object({ target: insuranceTargetSchema, settlementId: str, expectedBalanceVersion: z.number().int().nonnegative() }).strict()
export const insurancePreviewSchema = z.object({ previewId: s, commitToken: s, expiresAt: s, settlement: insuranceSettlementSchema, balance: insuranceBalanceSchema }).strict()
export const insurancePreviewResponseSchema = commandResponseSchema(insurancePreviewSchema)
export const insuranceResponseSchema = commandResponseSchema(insuranceStateSchema)
