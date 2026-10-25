import { z } from 'zod'
import { drgProgramSchema } from './drg-program.ts'

const code = z.string().min(1).max(64)
const text = z.string().min(1).max(1_000)

/** 分组用诊断编码（医保版口径），顺序即临床顺序。 */
export const drgDiagnosisSchema = z.object({
  code,
  role: z.enum(['main', 'secondary']),
}).strict()

export const drgOperationSchema = z.object({
  code,
  primary: z.boolean(),
}).strict()

export const drgGroupingInputSchema = z.object({
  diagnoses: z.array(drgDiagnosisSchema).max(200),
  operations: z.array(drgOperationSchema).max(200),
  gender: z.enum(['male', 'female', 'unknown']),
  /** 整岁与实际日龄分别参与原程序判定；缺少日龄或出生体重时保持 null。 */
  ageYears: z.number().int().min(0).max(150),
  ageDays: z.number().int().min(0).max(365).nullable(),
  birthWeightGrams: z.number().int().min(0).max(10_000).nullable(),
  /** 离院方式代码（2=医嘱离院等，沿用住院离院方式口径）。 */
  dischargeMode: z.string().min(1).max(32),
  inpatientDays: z.number().int().min(0).max(3650),
}).strict()

export const drgGroupingStepSchema = z.object({
  stage: z.enum(['mdc', 'adrg', 'drg']),
  /** 该步判定依据：命中的码、表名或规则说明。 */
  basis: text,
  matchedCode: code.nullable(),
  result: text,
}).strict()

export const drgGroupingResultSchema = z.object({
  status: z.enum(['grouped', 'ungroupable', 'ambiguous', 'invalid-input']),
  drgCode: z.string().min(1).max(32).nullable(),
  mdcCode: z.string().min(1).max(32).nullable(),
  adrgCode: z.string().min(1).max(32).nullable(),
  steps: z.array(drgGroupingStepSchema).max(50),
  reason: text.nullable(),
}).strict()

export const drgRulesSchema = z.object({
  rulesId: text,
  version: text,
  /** 从完整原程序提取的有序条件；禁止装载缺失条件的旧成员表规则。 */
  program: drgProgramSchema,
}).strict()

export type DrgDiagnosis = z.infer<typeof drgDiagnosisSchema>
export type DrgOperation = z.infer<typeof drgOperationSchema>
export type DrgGroupingInput = z.infer<typeof drgGroupingInputSchema>
export type DrgGroupingResult = z.infer<typeof drgGroupingResultSchema>
export type DrgRules = z.infer<typeof drgRulesSchema>
