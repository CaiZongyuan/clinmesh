import { z } from 'zod'
import { imagingStudyViewSchema, pathologyExamCodeSchema } from './imaging.ts'

export type PathologyExamCode = z.infer<typeof pathologyExamCodeSchema>

/** 病例匹配使用的来源固定事实。受体与淋巴结取 `positive` / `negative`，肿瘤 T 类别取 `T1`–`T4`。 */
export const pathologyFactNameSchema = z.enum([
  'estrogen-receptor',
  'her2',
  'lymph-nodes',
  'progesterone-receptor',
  'tumor-category',
])
export type PathologyFactName = z.infer<typeof pathologyFactNameSchema>

export const pathologyFactValueSchema = z.enum(['negative', 'positive', 'T1', 'T2', 'T3', 'T4'])
export type PathologyFactValue = z.infer<typeof pathologyFactValueSchema>

/**
 * 一项会诊没有得到可用切片的原因；`FIXED_FACT_CONFLICT` 对应 `conflict`，其余对应 `unsupported`。
 * `FACT_UNKNOWN` 表示来源缺少某项固定事实，无法确认任何素材与病例相容。
 */
export const pathologyPreparationReasonSchema = z.enum([
  'ASSET_NOT_PUBLISHED',
  'FACT_UNKNOWN',
  'FIXED_FACT_CONFLICT',
  'NO_APPLICABLE_RULE',
  'NO_SOURCE_PROCEDURE',
])
export type PathologyPreparationReason = z.infer<typeof pathologyPreparationReasonSchema>

const sourceCodingEvidenceSchema = z.object({
  code: z.string().min(1).max(64),
  display: z.string().min(1).max(512).optional(),
  sourceReference: z.string().min(1).max(512),
}).strict()

/** 可送检的来源手术：来自病例的既往来源病史，早于本次就诊。 */
export const pathologySourceProcedureSchema = sourceCodingEvidenceSchema.extend({
  performedAt: z.string().min(10).max(64),
}).strict()
export type PathologySourceProcedure = z.infer<typeof pathologySourceProcedureSchema>

export const pathologyExamPreparationSchema = z.object({
  evidence: z.object({
    /** 使病例适用该会诊的来源诊断。 */
    conditions: z.array(sourceCodingEvidenceSchema),
    /** 来源 Observation 给出的固定事实；缺少的事实不出现在这里。 */
    facts: z.array(sourceCodingEvidenceSchema.extend({
      fact: pathologyFactNameSchema,
      value: pathologyFactValueSchema,
      valueCode: z.string().min(1).max(64),
    }).strict()),
  }).strict(),
  examCode: pathologyExamCodeSchema,
  matchingProfileId: z.string().min(1).max(128).optional(),
  reason: pathologyPreparationReasonSchema.optional(),
  /** 每个可送检的来源手术一项；`ready` 时各带所选素材、报告修订与来自素材的补充事实。 */
  sourceProcedures: z.array(pathologySourceProcedureSchema.extend({
    assetId: z.string().min(1).max(128).optional(),
    reportRevision: z.number().int().positive().optional(),
    /** 来源未描述、由素材补充的事实，例如组织学类型。 */
    supplements: z.array(z.object({
      fact: z.enum(['histologic-type']),
      value: z.string().min(1).max(128),
    }).strict()),
  }).strict()),
  status: z.enum(['conflict', 'ready', 'unsupported']),
}).strict()
export type PathologyExamPreparation = z.infer<typeof pathologyExamPreparationSchema>

const pathologyCatalogIdentitySchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  packId: z.string().min(1).max(128),
  ruleVersion: z.number().int().positive(),
}).strict()

/** 一次病理准备的不可变结果：记录所依附的病例来源身份、规则与素材版本，以及每项会诊的结论。 */
export const pathologyCasePreparationSchema = z.object({
  caseId: z.string().min(1).max(128),
  catalog: pathologyCatalogIdentitySchema,
  createdAt: z.iso.datetime({ offset: true }),
  exams: z.array(pathologyExamPreparationSchema),
  profileId: z.string().min(1),
  profileRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type PathologyCasePreparation = z.infer<typeof pathologyCasePreparationSchema>

/** 病例、来源手术与切片素材的固定绑定；跨 Epoch 保留，病例开始后不再替换。 */
export const pathologyCaseBindingSchema = z.object({
  assetId: z.string().min(1).max(128),
  boundAt: z.iso.datetime({ offset: true }),
  examCode: pathologyExamCodeSchema,
  matchingProfileId: z.string().min(1).max(128),
  preparationRevision: z.number().int().positive(),
  reportRevision: z.number().int().positive(),
  sourceProcedureReference: z.string().min(1).max(512),
}).strict()
export type PathologyCaseBinding = z.infer<typeof pathologyCaseBindingSchema>

export const administratorPathologyPreparationSchema = z.object({
  bindings: z.array(pathologyCaseBindingSchema),
  caseId: z.string().min(1).max(128),
  preparation: pathologyCasePreparationSchema.nullable(),
  /** 病例是否已经开始过；开始后只允许为尚未绑定的来源手术首次追加素材。 */
  started: z.boolean(),
}).strict()

export const preparePathologyCasesRequestSchema = z.object({
  input: z.object({
    caseIds: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
  }).strict(),
}).strict()

export const pathologyPreparationBatchSchema = z.object({
  prepared: z.array(administratorPathologyPreparationSchema),
  /** 未指定病例时，本批之后仍待准备的病例数。 */
  remaining: z.number().int().nonnegative(),
}).strict()

const pathologyCoverageAssetSchema = z.object({
  assetId: z.string().min(1).max(128),
  blockers: z.array(z.string().min(1)),
  installed: z.boolean(),
  published: z.boolean(),
}).strict()

/**
 * 管理员覆盖清单：由素材临床字段派生的适配条目及其素材状态、因缺少字段无法形成条目的素材，
 * 以及当前病例库的准备结果统计。
 */
export const pathologyCoverageSchema = z.object({
  cases: z.object({
    exams: z.array(z.object({
      conflict: z.number().int().nonnegative(),
      examCode: pathologyExamCodeSchema,
      ready: z.number().int().nonnegative(),
      unsupported: z.array(z.object({
        count: z.number().int().positive(),
        reason: pathologyPreparationReasonSchema,
      }).strict()),
    }).strict()),
    prepared: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  catalog: pathologyCatalogIdentitySchema.nullable(),
  gaps: z.array(pathologyCoverageAssetSchema.extend({
    missing: z.array(pathologyFactNameSchema).min(1),
  }).strict()),
  profiles: z.array(z.object({
    assets: z.array(pathologyCoverageAssetSchema).min(1),
    examCode: pathologyExamCodeSchema,
    facts: z.record(pathologyFactNameSchema, pathologyFactValueSchema),
    id: z.string().min(1).max(128),
    label: z.string().min(1),
  }).strict()),
}).strict()
export type PathologyCoverage = z.infer<typeof pathologyCoverageSchema>

/** 管理员复核一份切片素材所需的信息：来源临床字段与派生事实、报告修订与自动检查结果、发布状态和读取描述。 */
export const administratorPathologyAssetSchema = z.object({
  assetId: z.string().min(1).max(128),
  clinical: z.record(z.string(), z.json()),
  facts: z.partialRecord(pathologyFactNameSchema, pathologyFactValueSchema),
  publication: z.object({
    publishedRevisions: z.array(z.number().int().positive()),
    reasons: z.array(z.object({
      code: z.string().min(1),
      revision: z.number().int().positive().optional(),
    }).strict()),
  }).strict(),
  reports: z.array(z.object({
    checkIssues: z.array(z.object({ code: z.string().min(1), message: z.string().min(1) }).strict()),
    diagnosis: z.string().min(1),
    immunohistochemistry: z.string().min(1),
    microscopy: z.string().min(1),
    note: z.string().min(1),
    review: z.record(z.string(), z.json()).optional(),
    revision: z.number().int().positive(),
  }).strict()),
  study: imagingStudyViewSchema,
}).strict()
export type AdministratorPathologyAsset = z.infer<typeof administratorPathologyAssetSchema>
