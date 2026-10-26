import { z } from 'zod'
import { drgGroupingInputSchema } from './drg.ts'
import { inpatientDiagnosisSchema } from './inpatient-clinical.ts'
import { inpatientProcedureCodingSchema } from './inpatient-surgery.ts'
import { inpatientDrgPaymentReferenceSchema } from './inpatient-drg-simulation.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const stamp = z.iso.datetime({ offset: true })
const text = z.string().min(1).max(1_000)

/** 只投影归档分组复核必需的病例及编码来源，不开放完整病案。 */
export const inpatientDrgPayerCaseSummarySchema = z.object({
  recordRevision: z.number().int().positive(),
  rulesId: text, rulesVersion: text,
  inputCoding: z.literal('nhc-icd10-clinical@2022.r4'), codingNote: text,
  groupingInput: drgGroupingInputSchema,
  diagnoses: z.array(inpatientDiagnosisSchema.shape.entries.element.omit({ note: true })),
  operations: z.array(z.object({ executionId: id, procedureVersion: text, primary: z.boolean(),
    coding: inpatientProcedureCodingSchema }).strict()),
}).strict()

const estimateComparison = {
  /** 归档时医院支付预估及其参数身份；历史归档没有基线时不可对账。 */
  paymentEstimate: inpatientDrgPaymentReferenceSchema.nullable().default(null),
  /** 模拟核定额减归档预估额；独立于核定额减正式收费的 differenceFen。 */
  estimateDifferenceFen: z.number().int().safe().nullable().default(null),
}

/**
 * 医保办 DRG 模拟核定复核：基于归档冻结分组与固定版本合成支付参数的受控仿真，
 * 由服务端确定性产生，不接受手填金额；差异不构成完整盈亏，独立于患者结算。
 */
export const inpatientDrgPayerReviewSchema = z.object({
  id, admissionId: id,
  /** 复核绑定的归档快照来源哈希；归档后财务更正不回写已形成的复核记录。 */
  archiveSourcesHash: z.string().regex(/^[a-f0-9]{64}$/),
  recordRevision: z.number().int().positive(),
  frozenRulesId: text, frozenRulesVersion: text,
  /** 冻结分组结果的规范哈希，复核与分组依据可追溯。 */
  frozenResultHash: z.string().regex(/^[a-f0-9]{64}$/),
  drgCode: z.string().min(1).max(64),
  parameterSetId: text, parameterVersion: text,
  /** 模拟核定支付额=基础费率×病组权重（万分位），整数分明确舍入。 */
  simulatedPaymentFen: z.number().int().safe().nonnegative(),
  /** 医院侧口径=归档快照正式收费净额，非完整成本。 */
  hospitalChargesFen: z.number().int().safe().nonnegative(),
  differenceFen: z.number().int().safe(),
  ...estimateComparison,
  note: text,
  reason: z.string().trim().min(1).max(2000),
  reviewedAt: stamp,
}).strict()

export type InpatientDrgPayerReview = z.infer<typeof inpatientDrgPayerReviewSchema>

export const inpatientDrgPayerReviewPreviewSchema = z.object({
  admissionId: id,
  encounterVersion: z.string().regex(/^\d+$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  archiveSourcesHash: z.string().regex(/^[a-f0-9]{64}$/),
  frozenResultHash: z.string().regex(/^[a-f0-9]{64}$/),
  drgCode: text, parameterSetId: text, parameterVersion: text,
  simulatedPaymentFen: z.number().int().safe().nonnegative(),
  hospitalChargesFen: z.number().int().safe().nonnegative(),
  differenceFen: z.number().int().safe(), note: text,
  ...estimateComparison,
  caseSummary: inpatientDrgPayerCaseSummarySchema,
}).strict()

export type InpatientDrgPayerReviewPreview = z.infer<typeof inpatientDrgPayerReviewPreviewSchema>

export const inpatientDrgPayerReviewCreateInputSchema = z.object({
  admissionId: id,
  encounterVersion: z.string().regex(/^\d+$/),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(2000),
}).strict()

export const inpatientDrgPayerReviewListSchema = z.object({
  admissionId: id,
  reviews: z.array(inpatientDrgPayerReviewSchema),
}).strict()

export type InpatientDrgPayerReviewList = z.infer<typeof inpatientDrgPayerReviewListSchema>
