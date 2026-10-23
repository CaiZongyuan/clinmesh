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
  /** 年龄岁数；新生儿分组预留给 ageDays 与 birthWeightGrams，当前内核不消费，非新生儿输入恒为 null。 */
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

/**
 * CC/MCC 参数表条目：码 → 并发症级别与所属排除组号；severity 1=CC 2=MCC。
 * groupRef 为官方方案排除表组号（'1' 对应表 6-5-1）；空串表示该码不参与排除组。
 */
export const drgComplicationEntrySchema = z.object({
  code,
  severity: z.union([z.literal(1), z.literal(2)]),
  groupRef: z.string().max(32),
}).strict()

/** 主诊断排除组表：主诊断码 → 排除组号。与主诊断同组号的次诊断不按 CC/MCC 计。 */
export const drgExclusionGroupSchema = z.object({
  code,
  groupRef: z.string().min(1).max(32),
}).strict()

/** 有效手术操作条目：主操作命中后进入手术 ADRG。 */
export const drgValidOperationSchema = z.object({
  code,
  adrgCode: z.string().min(1).max(32),
}).strict()

/** 诊断→ADRG 内科成员条目：主诊断命中（含「主诊断+星号副诊断」组合形态）；外科入口经有效操作表。 */
export const drgMemberSchema = z.object({
  code,
  adrgCode: z.string().min(1).max(32),
}).strict()

/** ADRG → MDC 归属：MDC 前缀表缺失时，按 ADRG 归属回填 MDC 判定。 */
export const drgAdrgMdcSchema = z.object({
  adrgCode: z.string().min(1).max(32),
  mdcCode: z.string().min(1).max(32),
}).strict()

/**
 * DRG 终端组入组谓词：与官方分组函数表同构，按列表顺序匹配首个满足的条目。
 * 带年龄下限的变体组（官方 ≥70 岁，尾码 E/F/G）必须排在同 ADRG 无年龄条件组之前。
 */
export const drgTerminalGroupSchema = z.object({
  adrgCode: z.string().min(1).max(32),
  drgCode: z.string().min(1).max(32),
  /** 并发症条件：mcc=有 MCC；mcc-or-cc=有 MCC 或 CC；any=无条件兜底。 */
  requires: z.enum(['mcc', 'mcc-or-cc', 'any']),
  /** 年龄下限；null=无年龄条件。 */
  minAgeYears: z.number().int().min(0).max(150).nullable(),
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
  exclusionGroups: z.array(drgExclusionGroupSchema),
  adrgMdcEntries: z.array(drgAdrgMdcSchema),
  terminalGroups: z.array(drgTerminalGroupSchema),
}).strict()

export type DrgDiagnosis = z.infer<typeof drgDiagnosisSchema>
export type DrgOperation = z.infer<typeof drgOperationSchema>
export type DrgGroupingInput = z.infer<typeof drgGroupingInputSchema>
export type DrgGroupingResult = z.infer<typeof drgGroupingResultSchema>
export type DrgRules = z.infer<typeof drgRulesSchema>
export type DrgAdrgMdc = z.infer<typeof drgAdrgMdcSchema>
