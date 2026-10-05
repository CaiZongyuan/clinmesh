import { z } from 'zod'

export const imagingExamCodeSchema = z.enum(['chest-ct-plain', 'chest-radiograph'])
export type ImagingExamCode = z.infer<typeof imagingExamCodeSchema>

/** 一项检查没有得到可用素材的原因；`FIXED_FACT_CONFLICT` 对应 `conflict`，其余对应 `unsupported`。 */
export const imagingPreparationReasonSchema = z.enum([
  'ASSET_NOT_PUBLISHED',
  'FIXED_FACT_CONFLICT',
  'NO_APPLICABLE_RULE',
  'NO_ASSET_FOR_DEMOGRAPHICS',
  'PROFILE_LACKS_EXAM',
  'UNCOVERED_CONDITION',
])
export type ImagingPreparationReason = z.infer<typeof imagingPreparationReasonSchema>

const sourceCodingEvidenceSchema = z.object({
  code: z.string().min(1).max(64),
  display: z.string().min(1).max(512).optional(),
  sourceReference: z.string().min(1).max(512),
}).strict()

export const imagingExamPreparationSchema = z.object({
  assetId: z.string().min(1).max(128).optional(),
  evidence: z.object({
    /** 决定适配规则的来源疾病与操作；`index` 来自本次病例真值，`history` 来自既往来源病史。 */
    facts: z.array(sourceCodingEvidenceSchema.extend({ scope: z.enum(['history', 'index']) }).strict()),
    /** 本次病例真值中与该检查相容的来源检查记录，是适合开立该检查的正向证据。 */
    sourceExams: z.array(sourceCodingEvidenceSchema),
  }).strict(),
  examCode: imagingExamCodeSchema,
  matchingProfileId: z.string().min(1).max(128).optional(),
  reason: imagingPreparationReasonSchema.optional(),
  reportRevision: z.number().int().positive().optional(),
  status: z.enum(['conflict', 'ready', 'unsupported']),
}).strict()
export type ImagingExamPreparation = z.infer<typeof imagingExamPreparationSchema>

const imagingCatalogIdentitySchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  packId: z.string().min(1).max(128),
  ruleVersion: z.number().int().positive(),
}).strict()

/** 一次影像准备的不可变结果：记录所依附的病例来源身份、规则与素材版本，以及每项检查的结论。 */
export const imagingCasePreparationSchema = z.object({
  caseId: z.string().min(1).max(128),
  catalog: imagingCatalogIdentitySchema,
  createdAt: z.iso.datetime({ offset: true }),
  exams: z.array(imagingExamPreparationSchema),
  profileId: z.string().min(1),
  profileRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type ImagingCasePreparation = z.infer<typeof imagingCasePreparationSchema>

/** 病例与素材的固定绑定；跨 Epoch 保留，病例开始后不再替换。 */
export const imagingCaseBindingSchema = z.object({
  assetId: z.string().min(1).max(128),
  boundAt: z.iso.datetime({ offset: true }),
  examCode: imagingExamCodeSchema,
  matchingProfileId: z.string().min(1).max(128),
  preparationRevision: z.number().int().positive(),
  reportRevision: z.number().int().positive(),
}).strict()
export type ImagingCaseBinding = z.infer<typeof imagingCaseBindingSchema>

export const administratorImagingPreparationSchema = z.object({
  bindings: z.array(imagingCaseBindingSchema),
  caseId: z.string().min(1).max(128),
  preparation: imagingCasePreparationSchema.nullable(),
  /** 病例是否已经开始过；开始后只允许为尚未绑定的检查首次追加素材。 */
  started: z.boolean(),
}).strict()

export const prepareImagingCasesRequestSchema = z.object({
  input: z.object({
    caseIds: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
  }).strict(),
}).strict()

export const imagingPreparationBatchSchema = z.object({
  prepared: z.array(administratorImagingPreparationSchema),
  /** 未指定病例时，本批之后仍待准备的病例数。 */
  remaining: z.number().int().nonnegative(),
}).strict()

const imagingCoverageProfileSchema = z.object({
  ageRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  asset: z.object({
    assetId: z.string().min(1).max(128),
    blockers: z.array(z.string().min(1)),
    installed: z.boolean(),
    published: z.boolean(),
  }).strict().nullable(),
  conditionCodes: z.array(z.string().min(1)),
  finding: z.enum(['negative', 'positive']),
  id: z.string().min(1).max(128),
  label: z.string().min(1),
  sex: z.enum(['female', 'male']).optional(),
}).strict()

/** 管理员覆盖清单：每类检查的适配规则、素材状态、明确未覆盖的疾病，以及当前病例库的准备结果统计。 */
export const imagingCoverageSchema = z.object({
  cases: z.object({
    exams: z.array(z.object({
      conflict: z.number().int().nonnegative(),
      examCode: imagingExamCodeSchema,
      ready: z.number().int().nonnegative(),
      unsupported: z.array(z.object({
        count: z.number().int().positive(),
        reason: imagingPreparationReasonSchema,
      }).strict()),
    }).strict()),
    prepared: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  catalog: imagingCatalogIdentitySchema.nullable(),
  exams: z.array(z.object({
    examCode: imagingExamCodeSchema,
    profiles: z.array(imagingCoverageProfileSchema),
  }).strict()),
  uncovered: z.array(z.object({
    codes: z.array(z.string().min(1)).min(1),
    id: z.string().min(1).max(128),
    label: z.string().min(1),
  }).strict()),
}).strict()
export type ImagingCoverage = z.infer<typeof imagingCoverageSchema>

const imagingPixelBlockViewSchema = z.object({
  length: z.number().int().positive(),
  rowCount: z.number().int().positive(),
  rowStart: z.number().int().nonnegative(),
}).strict()

const imagingFrameViewSchema = z.object({
  /** 一帧按行切成的有界像素块，逐块读取后按行拼接。 */
  blocks: z.array(imagingPixelBlockViewSchema).min(1),
  columns: z.number().int().positive(),
  pixelSpacingMm: z.tuple([z.number().positive(), z.number().positive()]).nullable(),
  positionMm: z.number().optional(),
  rows: z.number().int().positive(),
  view: z.enum(['frontal', 'lateral']).optional(),
  viewPosition: z.string().min(1).optional(),
  window: z.object({ center: z.number(), width: z.number().positive() }).strict().optional(),
}).strict()

/** 切片金字塔的显示倍率上限；摄取不保留高于 20 倍的层级。 */
export const maxSlideMagnification = 20

/** 金字塔的一个层级。尺寸与瓦片尺寸单位为该层像素；行末与列末的瓦片按层级尺寸裁切显示。 */
const imagingPyramidLevelViewSchema = z.object({
  height: z.number().int().positive(),
  /** 摄取记录的名义倍率（如 20、10、5、1.25），用于标注层级；连续缩放时的倍率读数从像素间距换算。 */
  magnification: z.number().positive().max(maxSlideMagnification),
  micronsPerPixel: z.number().positive(),
  tileHeight: z.number().int().positive().max(4096),
  tileWidth: z.number().int().positive().max(4096),
  width: z.number().int().positive(),
}).strict()

/**
 * 一张 RGB 切片的分层瓦片描述。层级按分辨率从高到低排列，第 0 层是最高分辨率；
 * 后一层的尺寸不大于前一层，像素间距不小于前一层。
 */
const imagingTiledPyramidViewSchema = z.object({
  /** 切片的 ICC profile 不应用于显示；阅片页据此注明未做颜色管理。 */
  colorManaged: z.literal(false),
  kind: z.literal('tiled-pyramid'),
  levels: z.array(imagingPyramidLevelViewSchema).min(1).max(16).superRefine((levels, context) => {
    for (const [index, level] of levels.entries()) {
      const higher = levels[index - 1]
      if (higher === undefined) continue
      if (level.width > higher.width || level.height > higher.height || level.micronsPerPixel < higher.micronsPerPixel) {
        context.addIssue({ code: 'custom', message: 'Pyramid levels must be ordered from high to low resolution', path: [index] })
      }
    }
  }),
  modality: z.literal('SM'),
  /** 会诊切片的显示标签，例如玻片编号。 */
  slideLabel: z.string().min(1).max(64),
  tileFormat: z.literal('jpeg'),
}).strict()

/**
 * 一个序列的读取描述。`kind` 区分像素组织方式：`frame-stack` 是按帧堆叠的灰度图（CT 与胸片），
 * `tiled-pyramid` 是病理切片的 RGB 分层瓦片。
 */
export const imagingSeriesViewSchema = z.discriminatedUnion('kind', [
  z.object({
    frames: z.array(imagingFrameViewSchema).min(1),
    kind: z.literal('frame-stack'),
    modality: z.enum(['CR', 'CT', 'DX']),
    pixelFormat: z.enum(['int16', 'uint16']),
    /** `hu` 表示像素值即 CT 值；`stored` 表示设备存储值，只做窗宽窗位显示。 */
    valueUnit: z.enum(['hu', 'stored']),
  }).strict(),
  imagingTiledPyramidViewSchema,
])
export type ImagingSeriesView = z.infer<typeof imagingSeriesViewSchema>

/** 病理检查项目；放射检查的准备、绑定与覆盖清单仍只接受 `imagingExamCodeSchema`。 */
export const pathologyExamCodeSchema = z.enum(['breast-slide-consultation'])

/** 阅片器读取一次本院检查所需的描述；像素当前不可读时 `available` 为 false 且没有序列。 */
export const imagingStudyViewSchema = z.object({
  available: z.boolean(),
  examCode: z.union([imagingExamCodeSchema, pathologyExamCodeSchema]),
  series: z.array(imagingSeriesViewSchema),
  studyId: z.string().min(1).max(128),
}).strict()
export type ImagingStudyView = z.infer<typeof imagingStudyViewSchema>

/** 管理员复核一套素材所需的信息：来源标注、报告修订与自动检查结果、发布状态和读取描述。 */
export const administratorImagingAssetSchema = z.object({
  annotation: z.record(z.string(), z.json()).optional(),
  assetId: z.string().min(1).max(128),
  publication: z.object({
    publishedRevisions: z.array(z.number().int().positive()),
    reasons: z.array(z.object({
      code: z.string().min(1),
      revision: z.number().int().positive().optional(),
    }).strict()),
  }).strict(),
  reports: z.array(z.object({
    checkIssues: z.array(z.object({ code: z.string().min(1), message: z.string().min(1) }).strict()),
    findings: z.string().min(1),
    impression: z.string().min(1),
    review: z.record(z.string(), z.json()).optional(),
    revision: z.number().int().positive(),
    technique: z.string().min(1),
  }).strict()),
  study: imagingStudyViewSchema,
}).strict()
export type AdministratorImagingAsset = z.infer<typeof administratorImagingAssetSchema>
