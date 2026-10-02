import { createHash } from 'node:crypto'
import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathologyExamCodeSchema } from '@clinmesh/contracts/imaging'
import { z } from 'zod'
import { dicomUidSchema } from './imaging-pack-store.ts'

const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const fileDigestSchema = z.object({ bytes: z.number().int().positive(), sha256: sha256Schema }).strict()

export const pathologyCatalogManifestSchema = z.object({
  /** 结构化临床字段的来源；与切片像素的许可分开登记，互不替代。 */
  clinicalSources: z.array(z.object({
    attribution: z.string().min(1),
    id: identifierSchema,
    /** 转录字段时所用来源文件的 SHA-256。 */
    sha256: sha256Schema,
    terms: z.string().min(1),
    title: z.string().min(1),
    url: z.url(),
  }).strict()).min(1),
  collections: z.array(z.object({
    attribution: z.string().min(1),
    doi: z.string().min(1),
    id: identifierSchema,
    license: z.string().min(1),
    source: z.object({ kind: z.literal('idc-s3') }).strict(),
    title: z.string().min(1),
  }).strict()).min(1),
  packId: identifierSchema,
  schemaVersion: z.literal(1),
}).strict()

const levelOutputSchema = z.object({
  height: z.number().int().positive(),
  /** `levels/<n>.index`：(瓦片数 + 1) 个小端 uint64 累计偏移。 */
  index: fileDigestSchema,
  magnification: z.number().positive(),
  micronsPerPixel: z.number().positive(),
  /** 层级来源：原生层级的 JPEG 瓦片原样复制、JPEG 2000 瓦片转码；生成层级按区域均值从来源实例降采样。 */
  origin: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('source'),
      sourceCodec: z.enum(['jpeg-baseline', 'jpeg2000']),
      sourceInstance: z.number().int().nonnegative(),
      tiles: z.enum(['copied', 'transcoded']),
    }).strict(),
    z.object({
      factor: z.number().int().min(2),
      kind: z.literal('derived'),
      method: z.literal('box'),
      sourceInstance: z.number().int().nonnegative(),
    }).strict(),
  ]),
  tileHeight: z.number().int().positive(),
  tileWidth: z.number().int().positive(),
  /** `levels/<n>.tiles`：按行优先顺序拼接的 JPEG 瓦片。 */
  tiles: z.object({
    bytes: z.number().int().positive(),
    count: z.number().int().positive(),
    largestBytes: z.number().int().positive(),
    sha256: sha256Schema,
  }).strict(),
  width: z.number().int().positive(),
}).strict()

export const pathologyAssetOutputSchema = z.object({
  /** 来源层级携带的 ICC profile，安装为 `icc-profile.icc`；阅片不应用。 */
  iccProfile: fileDigestSchema.optional(),
  ingestVersion: z.number().int().positive(),
  /** 按倍率从高到低；第一个层级为 20 倍。 */
  levels: z.array(levelOutputSchema).min(1),
  parameters: z.object({
    downsample: z.object({
      domain: z.literal('srgb-code-values'),
      edge: z.literal('in-bounds-mean'),
      method: z.literal('box'),
      padding: z.literal('white'),
      rounding: z.literal('half-up'),
    }).strict(),
    jpeg2000Decoder: z.object({ library: z.literal('@cornerstonejs/codec-openjpeg'), version: z.string().min(1) }).strict(),
    jpegEncoder: z.object({
      chromaSubsampling: z.literal('4:4:4'),
      colorModel: z.literal('YCbCr'),
      library: z.literal('jpeg-js'),
      process: z.literal('baseline'),
      quality: z.number().int().min(1).max(100),
      version: z.string().min(1),
    }).strict(),
  }).strict(),
}).strict()

/**
 * 来源病例的结构化临床字段，按 TCGA 临床矩阵原样转录（取值保持英文原文）；受体状态由自动检查按固定规则派生。
 * 切片为原发灶组织，淋巴结与 T 分期只供病例匹配，报告不据此作出新判断。
 */
const clinicalSchema = z.object({
  estrogenReceptor: z.string().min(1).optional(),
  her2: z.object({
    finalStatus: z.string().min(1).optional(),
    fish: z.string().min(1).optional(),
    ihcScore: z.string().min(1).optional(),
    ihcStatus: z.string().min(1).optional(),
  }).strict(),
  histologicType: z.string().min(1),
  pathologicN: z.string().min(1),
  pathologicT: z.string().min(1),
  progesteroneReceptor: z.string().min(1).optional(),
  sampleId: z.string().min(1).max(64),
  sampleType: z.literal('Primary Tumor'),
  sex: z.enum(['female', 'male']),
  sourceId: identifierSchema,
}).strict()

export const pathologyReviewItems = [
  'no-identifying-content',
  'findings-match-slide',
  'source-fields',
  'report-wording',
] as const

const reportReviewSchema = z.object({
  automatedCheck: z.object({ checkVersion: z.number().int().positive(), passed: z.boolean() }).strict(),
  conclusion: z.enum(['approved', 'rejected']),
  contentSha256: sha256Schema,
  items: z.array(z.object({
    conclusion: z.enum(['confirmed', 'rejected']),
    item: z.enum(pathologyReviewItems),
    note: z.string().min(1).optional(),
  }).strict()),
  note: z.string().min(1).optional(),
  reviewedAt: z.iso.date(),
  reviewer: z.string().min(1).max(128),
  reviewerIsPathologist: z.boolean(),
}).strict()

/** 一份报告内容修订；标本信息中的既往手术名称与日期在会诊时取病例所选的来源手术，这里只固定切片数量与染色。 */
const reportRevisionSchema = z.object({
  diagnosis: z.string().min(1),
  draft: z.object({ model: z.string().min(1), promptVersion: identifierSchema }).strict(),
  immunohistochemistry: z.string().min(1),
  microscopy: z.string().min(1),
  note: z.string().min(1),
  review: reportReviewSchema.optional(),
  revision: z.number().int().positive(),
  specimen: z.object({
    procedure: z.literal('case-source-procedure'),
    slideCount: z.literal(1),
    stain: z.literal('HE'),
  }).strict(),
}).strict()

const sourceInstanceSchema = z.object({
  bytes: z.number().int().positive(),
  sha256: sha256Schema,
  sopInstanceUid: dicomUidSchema,
}).strict()

export const pathologyCatalogAssetSchema = z.object({
  assetId: identifierSchema,
  clinical: clinicalSchema,
  collectionId: identifierSchema,
  output: pathologyAssetOutputSchema.optional(),
  reports: z.array(reportRevisionSchema).optional(),
  schemaVersion: z.literal(1),
  source: z.object({
    /** 一张切片对应一个 SM 序列；`idcSeriesUuid` 是 IDC 公开存储中该序列的目录名。 */
    series: z.tuple([z.object({
      idcSeriesUuid: z.uuid(),
      instances: z.array(sourceInstanceSchema).min(1).optional(),
      seriesInstanceUid: dicomUidSchema,
    }).strict()]),
    slideId: z.string().min(1).max(64),
    studyInstanceUid: dicomUidSchema,
    subjectId: z.string().min(1).max(64),
  }).strict(),
}).strict()

const snomedCodesSchema = z.array(z.string().regex(/^\d{6,18}$/)).min(1).max(8)
const loincCodeSchema = z.string().regex(/^\d{1,6}-\d$/)
const binaryFactSchema = z.object({
  code: loincCodeSchema,
  values: z.object({ negative: snomedCodesSchema, positive: snomedCodesSchema }).strict(),
}).strict()

/**
 * 病理适配规则：哪些来源病例适用一项会诊，以及来源 Observation 的哪些编码值对应病例的固定事实。
 * 适配条目不在这里列举，由每份素材的临床字段派生，素材的事实只有清单条目一个来源。
 */
export const pathologyMatchingRulesSchema = z.object({
  codeSystem: z.literal('http://snomed.info/sct'),
  /** 固定事实 → 来源 Observation 的 LOINC 编码，以及每个取值对应的 SNOMED 编码值。 */
  facts: z.object({
    'estrogen-receptor': binaryFactSchema,
    'her2': binaryFactSchema,
    'lymph-nodes': binaryFactSchema,
    'progesterone-receptor': binaryFactSchema,
    'tumor-category': z.object({
      code: loincCodeSchema,
      values: z.object({ T1: snomedCodesSchema, T2: snomedCodesSchema, T3: snomedCodesSchema, T4: snomedCodesSchema }).strict(),
    }).strict(),
  }).strict(),
  observationSystem: z.literal('http://loinc.org'),
  ruleVersion: z.number().int().positive(),
  schemaVersion: z.literal(1),
  services: z.array(z.object({
    /** 使病例适用该会诊的来源诊断编码。 */
    conditionCodes: z.array(z.string().regex(/^\d{6,18}$/)).min(1).max(16),
    examCode: pathologyExamCodeSchema,
    /** 定向生成使用的年龄范围；只提高命中率，不参与匹配。 */
    generationAgeRange: z.tuple([z.number().int().min(0).max(120), z.number().int().min(0).max(120)]),
    label: z.string().min(1).max(64),
    /** 适配条目标识的前缀。 */
    profilePrefix: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
    sex: z.enum(['female', 'male']),
    /** 可送检的来源手术编码，须与服务定义的部位和标本类型相容。 */
    sourceProcedureCodes: z.array(z.string().regex(/^\d{6,18}$/)).min(1).max(16),
  }).strict()).min(1),
}).strict().superRefine((rules, context) => {
  const examCodes = rules.services.map(service => service.examCode)
  if (new Set(examCodes).size !== examCodes.length) {
    context.addIssue({ code: 'custom', message: 'Each consultation has at most one service rule', path: ['services'] })
  }
})

export type PathologyCatalogManifest = z.infer<typeof pathologyCatalogManifestSchema>
export type PathologyMatchingRules = z.infer<typeof pathologyMatchingRulesSchema>
export type PathologyCatalogAssetEntry = z.infer<typeof pathologyCatalogAssetSchema>
export type PathologyAssetOutput = z.infer<typeof pathologyAssetOutputSchema>
export type PathologyLevelOutput = z.infer<typeof levelOutputSchema>
export type PathologyClinicalFields = z.infer<typeof clinicalSchema>
export type PathologyReportRevision = z.infer<typeof reportRevisionSchema>

/** 复核签署范围中条目之外的部分：读取清单时从合集、临床字段来源和 prompt 文件解析，不写回条目。 */
export interface PathologyReviewScope {
  clinicalSource: { id: string; sha256: string; terms: string; url: string }
  collection: { doi: string; id: string; license: string }
  /** promptVersion → prompt 文件的 SHA-256。 */
  promptSha256: Record<string, string>
}

export type PathologyCatalogAsset = PathologyCatalogAssetEntry & { reviewScope: PathologyReviewScope }

export interface PathologyCatalog {
  assets: PathologyCatalogAsset[]
  manifest: PathologyCatalogManifest
  /** 病例适配规则；清单没有 `matching.json` 时素材只能安装和复核，不参与病例匹配。 */
  matching?: PathologyMatchingRules
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** 读取仓库中的病理素材清单；文件名必须与 assetId 一致，素材只能引用已声明的合集、临床字段来源和存在的 prompt 文件。 */
export async function loadPathologyCatalog(catalogDirectory: string): Promise<PathologyCatalog> {
  const manifest = pathologyCatalogManifestSchema.parse(
    JSON.parse(await readFile(join(catalogDirectory, 'manifest.json'), 'utf8')),
  )
  const files = (await readdir(join(catalogDirectory, 'assets')))
    .filter(file => file.endsWith('.json'))
    .toSorted()
  const entries = await Promise.all(files.map(async (file) => {
    const asset = pathologyCatalogAssetSchema.parse(
      JSON.parse(await readFile(join(catalogDirectory, 'assets', file), 'utf8')),
    )
    if (`${asset.assetId}.json` !== file) {
      throw new Error(`Pathology asset file ${file} does not match assetId ${asset.assetId}`)
    }
    if (!manifest.collections.some(collection => collection.id === asset.collectionId)) {
      throw new Error(`Pathology asset ${asset.assetId} references unknown collection ${asset.collectionId}`)
    }
    if (!manifest.clinicalSources.some(source => source.id === asset.clinical.sourceId)) {
      throw new Error(`Pathology asset ${asset.assetId} references unknown clinical source ${asset.clinical.sourceId}`)
    }
    return asset
  }))
  let matching: PathologyMatchingRules | undefined
  try {
    matching = pathologyMatchingRulesSchema.parse(
      JSON.parse(await readFile(join(catalogDirectory, 'matching.json'), 'utf8')),
    )
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  const promptSha256: Record<string, string> = {}
  for (const promptVersion of new Set(entries.flatMap(asset => (asset.reports ?? []).map(report => report.draft.promptVersion)))) {
    let prompt: Buffer
    try {
      prompt = await readFile(join(catalogDirectory, 'prompts', `${promptVersion}.md`))
    } catch (error) {
      // 不以 ENOENT 上抛：缺少 prompt 是清单无效，不是清单目录不存在。
      if (isMissingFile(error)) throw new Error(`Pathology report prompt ${promptVersion} is missing`)
      throw error
    }
    promptSha256[promptVersion] = createHash('sha256').update(prompt).digest('hex')
  }
  return {
    assets: entries.map((asset) => {
      const collection = manifest.collections.find(candidate => candidate.id === asset.collectionId)!
      const clinicalSource = manifest.clinicalSources.find(candidate => candidate.id === asset.clinical.sourceId)!
      return {
        ...asset,
        reviewScope: {
          clinicalSource: {
            id: clinicalSource.id,
            sha256: clinicalSource.sha256,
            terms: clinicalSource.terms,
            url: clinicalSource.url,
          },
          collection: { doi: collection.doi, id: collection.id, license: collection.license },
          promptSha256: Object.fromEntries((asset.reports ?? []).map(report => [
            report.draft.promptVersion,
            promptSha256[report.draft.promptVersion]!,
          ])),
        },
      }
    }),
    manifest,
    ...(matching === undefined ? {} : { matching }),
  }
}

/** 以临时文件加改名写回单个素材条目，避免中断留下半个 JSON；读取时附带的复核签署范围不写回。 */
export async function writePathologyCatalogAsset(
  catalogDirectory: string,
  asset: PathologyCatalogAssetEntry & { reviewScope?: PathologyReviewScope },
): Promise<void> {
  const { reviewScope: _reviewScope, ...entry } = asset
  const parsed = pathologyCatalogAssetSchema.parse(entry)
  const target = join(catalogDirectory, 'assets', `${parsed.assetId}.json`)
  const temporary = `${target}.tmp`
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`)
  await rename(temporary, target)
}
