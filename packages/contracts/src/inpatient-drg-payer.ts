import { z } from 'zod'
import { drgGroupingResultSchema } from './drg'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const stamp = z.iso.datetime({ offset: true })
const text = z.string().min(1).max(1_000)

/**
 * 医保办 DRG 模拟核定复核：基于归档冻结分组与固定版本合成支付参数的受控仿真，
 * 由服务端确定性产生，不接受手填金额；差异不构成完整盈亏，独立于患者结算。
 */
export const inpatientDrgPayerReviewSchema = z.object({
  id,
  admissionId: id,
  /** 复核绑定的归档快照来源哈希；归档后财务更正不回写已形成的复核记录。 */
  archiveSourcesHash: z.string().regex(/^[a-f0-9]{64}$/),
  recordRevision: z.number().int().positive(),
  frozenRulesId: text,
  frozenRulesVersion: text,
  /** 冻结分组结果的规范哈希，复核与分组依据可追溯。 */
  frozenResultHash: z.string().regex(/^[a-f0-9]{64}$/),
  drgCode: z.string().min(1).max(64),
  parameterSetId: text,
  parameterVersion: text,
  /** 模拟核定支付额=基础费率×病组权重（万分位），整数分明确舍入。 */
  simulatedPaymentFen: z.number().int().safe().nonnegative(),
  /** 医院侧口径=归档快照正式收费净额，非完整成本。 */
  hospitalChargesFen: z.number().int().safe().nonnegative(),
  differenceFen: z.number().int().safe(),
  note: text,
  reason: z.string().trim().min(1).max(2000),
  reviewedAt: stamp,
}).strict()

export type InpatientDrgPayerReview = z.infer<typeof inpatientDrgPayerReviewSchema>
export type InpatientDrgPayerReviewList = z.infer<typeof inpatientDrgPayerReviewListSchema>

export const inpatientDrgPayerReviewCreateInputSchema = z.object({
  admissionId: id,
  reason: z.string().trim().min(1).max(2000),
}).strict()

export const inpatientDrgPayerReviewListSchema = z.object({
  admissionId: id,
  reviews: z.array(inpatientDrgPayerReviewSchema),
}).strict()

/** 模拟核定输入：归档冻结分组（不可变），参数身份随结果落盘可追溯。 */
export const inpatientDrgFrozenResultSchema = z.object({
  admissionId: id,
  recordRevision: z.number().int().positive(),
  rulesId: text,
  rulesVersion: text,
  result: drgGroupingResultSchema,
}).strict()

export type InpatientDrgFrozenResult = z.infer<typeof inpatientDrgFrozenResultSchema>
