import { z } from 'zod'
import { drgGroupingResultSchema } from './drg'

const id = z.string().min(1).max(128)
const text = z.string().min(1).max(1_000)

/**
 * 住院病案 DRG 预分组结果：从已提交病案首页快照推导，只读不落库。
 * 病案诊断/操作为临床版编码（nhc-icd10-clinical@2022.r4），分组规则字典为
 * 医保版口径（官方 CHS-DRG 3.0 分组器码域）；两套码同码直通，差集码按
 * 「无法入组」如实报告，不做名称模糊映射。
 */
export const inpatientDrgPregroupResultSchema = z.object({
  admissionId: id,
  recordRevision: z.number().int().positive(),
  rulesId: text,
  rulesVersion: text,
  inputCoding: z.literal('nhc-icd10-clinical@2022.r4'),
  codingNote: text,
  result: drgGroupingResultSchema,
}).strict()

export type InpatientDrgPregroupResult = z.infer<typeof inpatientDrgPregroupResultSchema>
