import { z } from 'zod'

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
  /** 年龄岁数；新生儿用 ageDays 与 birthWeightGrams 表达。 */
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

/** CC/MCC/CCE 参数表条目：码 → 并发症级别；severity 1=CC 2=MCC。 */
export const drgComplicationEntrySchema = z.object({
  code,
  severity: z.union([z.literal(1), z.literal(2)]),
}).strict()

/** 排除表条目：某 ADRG 下，某次诊断不作为 CC/MCC 计（对应官方方案按成员/组组织的排除表）。 */
export const drgExclusionEntrySchema = z.object({
  /** 排除表编号，对应官方方案表号（如 6-5-1）。 */
  tableId: text,
  /** 触发排除的 ADRG 标识。 */
  ownerCode: code,
  /** 被排除的次诊断码。 */
  excludedCode: code,
}).strict()

/** 有效手术操作条目：主操作命中后进入手术 ADRG。 */
export const drgValidOperationSchema = z.object({
  code,
  adrgCode: z.string().min(1).max(32),
}).strict()

/** 诊断→ADRG 成员条目：内科组以主诊断命中；外科组经有效操作表进入。 */
export const drgMemberSchema = z.object({
  code,
  adrgCode: z.string().min(1).max(32),
  chapter: z.enum(['medical', 'surgical']),
}).strict()

/** ADRG → DRG 三级组：伴严重并发症/伴并发症/不伴并发症。 */
export const drgTerminalGroupSchema = z.object({
  adrgCode: z.string().min(1).max(32),
  withMccCode: z.string().min(1).max(32).nullable(),
  withCcCode: z.string().min(1).max(32).nullable(),
  withoutCode: z.string().min(1).max(32),
}).strict()

/** MDC 判定条目：主诊断码（前缀）→ MDC；特殊 MDC 由人口属性规则另行声明。 */
export const drgMdcEntrySchema = z.object({
  /** 诊断码或其前缀。 */
  codePrefix: code,
  mdcCode: z.string().min(1).max(32),
}).strict()

export const drgRulesSchema = z.object({
  /** 规则身份与版本；分组结果必须可追溯到这里。 */
  rulesId: text,
  version: text,
  mdcEntries: z.array(drgMdcEntrySchema),
  members: z.array(drgMemberSchema),
  validOperations: z.array(drgValidOperationSchema),
  complications: z.array(drgComplicationEntrySchema),
  exclusions: z.array(drgExclusionEntrySchema),
  terminalGroups: z.array(drgTerminalGroupSchema),
}).strict()

export type DrgDiagnosis = z.infer<typeof drgDiagnosisSchema>
export type DrgOperation = z.infer<typeof drgOperationSchema>
export type DrgGroupingInput = z.infer<typeof drgGroupingInputSchema>
export type DrgGroupingResult = z.infer<typeof drgGroupingResultSchema>
export type DrgRules = z.infer<typeof drgRulesSchema>
