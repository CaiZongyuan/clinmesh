import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/)
export const dicomUidSchema = z.string().regex(/^[0-9]+(\.[0-9]+)*$/).max(64)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const directionSchema = z.enum(['A', 'F', 'H', 'L', 'P', 'R'])

export const imagingCatalogManifestSchema = z.object({
  collections: z.array(z.object({
    /** 来源读片标注包；`annotate` 读取其解压目录，素材条目记录所用文件及其哈希。 */
    annotationArchive: z.object({ sha256: sha256Schema, url: z.url() }).strict().optional(),
    attribution: z.string().min(1),
    doi: z.string().min(1),
    id: identifierSchema,
    license: z.string().min(1),
    source: z.object({ kind: z.literal('tcia-nbia') }).strict(),
    title: z.string().min(1),
  }).strict()).min(1),
  packId: identifierSchema,
  schemaVersion: z.literal(1),
}).strict()

const sourceInstanceSchema = z.object({
  bytes: z.number().int().positive(),
  sha256: sha256Schema,
  sopInstanceUid: dicomUidSchema,
}).strict()

const sourceSeriesSchema = z.object({
  instances: z.array(sourceInstanceSchema).min(1).optional(),
  modality: z.enum(['CR', 'CT', 'DX']),
  orientation: z.tuple([directionSchema, directionSchema]).optional(),
  seriesInstanceUid: dicomUidSchema,
}).strict()

const outputSeriesSchema = z.object({
  framesBytes: z.number().int().positive(),
  framesSha256: sha256Schema,
  geometrySha256: sha256Schema,
}).strict()

export const imagingAssetOutputSchema = z.object({
  series: z.array(outputSeriesSchema).min(1),
  transcoderVersion: z.number().int().positive(),
}).strict()

const sideSchema = z.enum(['left', 'right'])
const annotationSourceSchema = z.object({ file: z.string().min(1), sha256: sha256Schema }).strict()

/** 由 LIDC 读片 XML 确定性导出的结构化标注；报告草稿与自动一致性检查都以它为依据。 */
export const imagingAnnotationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('lidc-ct'),
    nodules: z.array(z.object({
      agreement: z.number().int().positive(),
      calcified: z.boolean().optional(),
      frameIndex: z.number().int().nonnegative(),
      id: identifierSchema,
      longAxisMm: z.number().positive().optional(),
      side: sideSchema,
      sizeClass: z.enum(['3mm-or-larger', 'under-3mm']),
      texture: z.enum(['ground-glass', 'part-solid', 'solid']).optional(),
    }).strict()),
    nonNoduleMarks: z.number().int().nonnegative(),
    readerCount: z.number().int().positive(),
    source: annotationSourceSchema,
  }).strict(),
  z.object({
    kind: z.literal('lidc-radiograph'),
    nodules: z.array(z.object({
      id: identifierSchema,
      ratings: z.array(z.object({
        confidence: z.number().int().min(1).max(3),
        subtlety: z.number().int().min(1).max(5).optional(),
      }).strict()).min(1),
      side: sideSchema,
      visibility: z.enum(['indeterminate', 'not-visible', 'visible']),
    }).strict()),
    readerCount: z.number().int().nonnegative(),
    source: annotationSourceSchema,
  }).strict(),
])

export const imagingReviewItems = [
  'exam-and-orientation',
  'no-identifying-content',
  'findings-match-pixels',
  'report-wording',
  'plain-scan',
] as const

const reportReviewSchema = z.object({
  automatedCheck: z.object({ checkVersion: z.number().int().positive(), passed: z.boolean() }).strict(),
  conclusion: z.enum(['approved', 'rejected']),
  contentSha256: sha256Schema,
  items: z.array(z.object({
    conclusion: z.enum(['confirmed', 'rejected']),
    item: z.enum(imagingReviewItems),
    note: z.string().min(1).optional(),
  }).strict()),
  note: z.string().min(1).optional(),
  reviewedAt: z.iso.date(),
  reviewer: z.string().min(1).max(128),
  reviewerIsRadiologist: z.boolean(),
}).strict()

/** 一份报告内容修订：正文之外的 `lesions` 是正文所述病灶的结构化声明，供自动检查对照标注。 */
const reportRevisionSchema = z.object({
  draft: z.object({ model: z.string().min(1), promptVersion: identifierSchema }).strict(),
  findings: z.string().min(1),
  impression: z.string().min(1),
  lesions: z.array(z.object({
    imageNumber: z.number().int().positive().optional(),
    longAxisMm: z.number().positive().optional(),
    noduleId: identifierSchema,
    side: sideSchema,
  }).strict()),
  review: reportReviewSchema.optional(),
  revision: z.number().int().positive(),
  technique: z.string().min(1),
}).strict()

export const imagingCatalogAssetSchema = z.object({
  annotation: imagingAnnotationSchema.optional(),
  assetId: identifierSchema,
  collectionId: identifierSchema,
  examCode: z.enum(['chest-ct-plain', 'chest-radiograph']),
  output: imagingAssetOutputSchema.optional(),
  reports: z.array(reportRevisionSchema).optional(),
  schemaVersion: z.literal(1),
  source: z.object({
    series: z.array(sourceSeriesSchema).min(1),
    studyInstanceUid: dicomUidSchema,
    subjectId: z.string().min(1).max(128),
  }).strict(),
}).strict()

const examCodeSchema = z.enum(['chest-ct-plain', 'chest-radiograph'])
const sourceCodeSchema = z.string().regex(/^[0-9]{6,18}$/)
const matchingProfileBaseShape = {
  /** 适用年龄范围（周岁，含两端），按本次就诊日期计算。 */
  ageRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .refine(([minimum, maximum]) => minimum <= maximum),
  /** 每项检查对应的素材；同一条目的素材来自同一来源受试者，保证胸片与 CT 相互一致。 */
  assets: z.partialRecord(examCodeSchema, identifierSchema),
  id: identifierSchema,
  label: z.string().min(1),
  sex: z.enum(['female', 'male']).optional(),
}

/**
 * 病例适配规则：用来源编码决定一个病例使用哪个条目的素材。阳性条目要求未缓解的来源疾病，
 * 阴性条目要求本次就诊的疾病属于明确列出的范围；规则未覆盖的病例不配片。
 */
export const imagingMatchingRulesSchema = z.object({
  codeSystem: z.url(),
  profiles: z.array(z.discriminatedUnion('finding', [
    z.object({
      ...matchingProfileBaseShape,
      conditionCodes: z.array(sourceCodeSchema).min(1),
      /** 与素材冲突的既往操作，例如肺切除或肺移植。 */
      conflictProcedureCodes: z.array(sourceCodeSchema).default([]),
      finding: z.literal('positive'),
    }).strict(),
    z.object({
      ...matchingProfileBaseShape,
      finding: z.literal('negative'),
      indexConditionCodes: z.array(sourceCodeSchema).min(1),
    }).strict(),
  ])),
  ruleVersion: z.number().int().positive(),
  schemaVersion: z.literal(1),
  /** 来源检查编码与本院检查的兼容关系，只用作适合开立该检查的证据。 */
  sourceExamCodes: z.partialRecord(examCodeSchema, z.array(sourceCodeSchema)),
  /** 有胸部影像表现但没有对应素材的疾病；出现在未缓解的来源疾病中时不配片。 */
  uncoveredConditions: z.array(z.object({
    codes: z.array(sourceCodeSchema).min(1),
    id: identifierSchema,
    label: z.string().min(1),
  }).strict()),
}).strict()

export type ImagingCatalogManifest = z.infer<typeof imagingCatalogManifestSchema>
export type ImagingMatchingRules = z.infer<typeof imagingMatchingRulesSchema>
export type ImagingCatalogAsset = z.infer<typeof imagingCatalogAssetSchema>
export type ImagingAssetOutput = z.infer<typeof imagingAssetOutputSchema>
export type ImagingAnnotation = z.infer<typeof imagingAnnotationSchema>
export type ImagingReportRevision = z.infer<typeof reportRevisionSchema>

export interface ImagingCatalog {
  assets: ImagingCatalogAsset[]
  manifest: ImagingCatalogManifest
  matching?: ImagingMatchingRules
}

function assetPath(catalogDirectory: string, assetId: string): string {
  return join(catalogDirectory, 'assets', `${assetId}.json`)
}

/** 读取仓库中的素材清单；文件名必须与 assetId 一致，素材只能引用已声明的合集，适配规则只能引用检查相符的素材。 */
export async function loadImagingCatalog(catalogDirectory: string): Promise<ImagingCatalog> {
  const manifest = imagingCatalogManifestSchema.parse(
    JSON.parse(await readFile(join(catalogDirectory, 'manifest.json'), 'utf8')),
  )
  const collections = new Set(manifest.collections.map(collection => collection.id))
  const files = (await readdir(join(catalogDirectory, 'assets')))
    .filter(file => file.endsWith('.json'))
    .toSorted()
  const assets = await Promise.all(files.map(async (file) => {
    const asset = imagingCatalogAssetSchema.parse(
      JSON.parse(await readFile(join(catalogDirectory, 'assets', file), 'utf8')),
    )
    if (`${asset.assetId}.json` !== file) {
      throw new Error(`Imaging asset file ${file} does not match assetId ${asset.assetId}`)
    }
    if (!collections.has(asset.collectionId)) {
      throw new Error(`Imaging asset ${asset.assetId} references unknown collection ${asset.collectionId}`)
    }
    return asset
  }))
  let matchingText: string
  try {
    matchingText = await readFile(join(catalogDirectory, 'matching.json'), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { assets, manifest }
    throw error
  }
  const matching = imagingMatchingRulesSchema.parse(JSON.parse(matchingText))
  if (new Set(matching.profiles.map(profile => profile.id)).size !== matching.profiles.length) {
    throw new Error('Imaging matching profile ids must be unique')
  }
  for (const profile of matching.profiles) {
    for (const [examCode, assetId] of Object.entries(profile.assets)) {
      if (assets.find(asset => asset.assetId === assetId)?.examCode !== examCode) {
        throw new Error(`Imaging matching profile ${profile.id} references ${assetId}, which is not a ${examCode} asset`)
      }
    }
  }
  return { assets, manifest, matching }
}

/** 以临时文件加改名写回单个素材条目，避免中断留下半个 JSON。 */
export async function writeImagingCatalogAsset(
  catalogDirectory: string,
  asset: ImagingCatalogAsset,
): Promise<void> {
  const parsed = imagingCatalogAssetSchema.parse(asset)
  const target = assetPath(catalogDirectory, parsed.assetId)
  const temporary = `${target}.tmp`
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`)
  await rename(temporary, target)
}
