import { z } from 'zod'
import { drgGroupingResultSchema } from './drg'
import { inpatientDrgPaymentReferenceSchema } from './inpatient-drg-simulation'

const id = z.string().min(1).max(128)
const text = z.string().min(1).max(1_000)

/**
 * 住院病案 DRG 预分组结果：未归档为实时推算（frozen=false）；归档后返回归档时
 * 冻结的分组（frozen=true），与首页快照及来源哈希绑定，规则包升级不回写。
 * 病案诊断/操作为临床版编码（nhc-icd10-clinical@2022.r4），分组规则字典为
 * 医保版口径（官方 CHS-DRG 3.0 分组器码域）；两套码同码直通，差集码按
 * 「无法入组」如实报告，不做名称模糊映射。
 */
export const inpatientDrgPregroupResultSchema = z.object({
  admissionId: id,
  recordRevision: z.number().int().nonnegative(),
  rulesId: text,
  rulesVersion: text,
  inputCoding: z.literal('nhc-icd10-clinical@2022.r4'),
  codingNote: text,
  frozen: z.boolean(),
  result: drgGroupingResultSchema,
  /** 仅在归档时冻结医院支付预估；旧归档缺失时保持缺失，不能用当前参数回填。 */
  paymentEstimate: inpatientDrgPaymentReferenceSchema.nullable().optional(),
}).strict()

export type InpatientDrgPregroupResult = z.infer<typeof inpatientDrgPregroupResultSchema>
