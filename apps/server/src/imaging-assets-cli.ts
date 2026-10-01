import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  defaultImagingAssetDirectory,
  defaultImagingCatalogDirectory,
  readServerEnvironment,
} from './config.ts'
import {
  annotateImagingAssets,
  checkImagingAssets,
  recordImagingAssets,
  repairImagingAssets,
  reviewImagingAssets,
  syncImagingAssets,
  verifyImagingAssets,
  type ImagingSourceClient,
} from './infrastructure/imaging-assets/imaging-asset-store.ts'
import { createTciaNbiaSourceClient } from './infrastructure/imaging-assets/tcia-nbia-client.ts'

const commandSchema = z.enum(['annotate', 'check', 'record', 'repair', 'review', 'sync', 'verify'])
const optionNames = new Set([
  '--annotation-directory',
  '--asset',
  '--asset-directory',
  '--catalog',
  '--conclusion',
  '--note',
  '--radiologist',
  '--reviewer',
  '--revision',
])
const reviewOptionsSchema = z.object({
  conclusion: z.enum(['approved', 'rejected']),
  note: z.string().trim().min(1).optional(),
  radiologist: z.enum(['no', 'yes']),
  reviewer: z.string().trim().min(1).max(128),
  revision: z.coerce.number().int().positive().optional(),
}).strict()
const succeededStatuses = new Set([
  'already-installed',
  'annotated',
  'installed',
  'published',
  'ready',
  'recorded',
  'repaired',
  'reviewed',
])

type ImagingAssetsCliResult = Awaited<ReturnType<
  | typeof annotateImagingAssets
  | typeof checkImagingAssets
  | typeof recordImagingAssets
  | typeof repairImagingAssets
  | typeof reviewImagingAssets
  | typeof syncImagingAssets
  | typeof verifyImagingAssets
>>

/**
 * 影像素材的显式维护入口：`sync` 按清单下载安装，`verify` 只读核对，`repair` 用本地保留的来源实例离线重建；
 * 维护者用 `record` 登记哈希、`annotate` 从本地 LIDC 读片 XML 导出标注、`check` 查看自动检查与发布状态、
 * `review` 签署复核（需要 `--asset`、`--reviewer`、`--conclusion` 与 `--radiologist yes|no`）。
 * `--asset` 可重复。
 */
export async function runImagingAssetsCli(
  arguments_: string[],
  options: { environment?: NodeJS.ProcessEnv; sourceClient?: ImagingSourceClient } = {},
): Promise<ImagingAssetsCliResult> {
  const [commandValue, ...optionArguments] = arguments_
  const command = commandSchema.parse(commandValue)
  const values = new Map<string, string[]>()
  for (let index = 0; index < optionArguments.length; index += 2) {
    const name = optionArguments[index]
    const value = optionArguments[index + 1]
    if (name === undefined || !optionNames.has(name) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid imaging assets CLI option near: ${name ?? '<end>'}`)
    }
    if (name !== '--asset' && values.has(name)) throw new Error(`Imaging assets CLI option was repeated: ${name}`)
    values.set(name, [...values.get(name) ?? [], value])
  }
  const environment = options.environment ?? readServerEnvironment(process.env)
  const input = {
    assetDirectory: resolve(
      values.get('--asset-directory')?.[0]
      ?? environment.CLINMESH_IMAGING_ASSET_DIRECTORY
      ?? defaultImagingAssetDirectory,
    ),
    catalogDirectory: resolve(
      values.get('--catalog')?.[0]
      ?? environment.CLINMESH_IMAGING_CATALOG_DIRECTORY
      ?? defaultImagingCatalogDirectory,
    ),
    ...(values.has('--asset') ? { assetIds: values.get('--asset')! } : {}),
  }
  if (command === 'check') return await checkImagingAssets(input)
  if (command === 'annotate') {
    const annotationDirectory = values.get('--annotation-directory')?.[0]
    if (annotationDirectory === undefined) throw new Error('--annotation-directory is required')
    return await annotateImagingAssets({ ...input, annotationDirectory: resolve(annotationDirectory) })
  }
  if (command === 'review') {
    // 复核逐套签署，不提供对整个清单的批量签署。
    if (input.assetIds === undefined) throw new Error('--asset is required for review')
    const review = reviewOptionsSchema.parse({
      conclusion: values.get('--conclusion')?.[0],
      note: values.get('--note')?.[0],
      radiologist: values.get('--radiologist')?.[0],
      reviewer: values.get('--reviewer')?.[0],
      revision: values.get('--revision')?.[0],
    })
    return await reviewImagingAssets({
      ...input,
      conclusion: review.conclusion,
      note: review.note,
      reviewer: review.reviewer,
      reviewerIsRadiologist: review.radiologist === 'yes',
      revision: review.revision,
    })
  }
  if (command === 'verify') return await verifyImagingAssets(input)
  if (command === 'repair') return await repairImagingAssets(input)
  const sourceClient = options.sourceClient ?? createTciaNbiaSourceClient()
  if (command === 'record') return await recordImagingAssets({ ...input, sourceClient })
  return await syncImagingAssets({ ...input, sourceClient })
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runImagingAssetsCli(process.argv.slice(2))
    .then((result) => {
      console.info(JSON.stringify(result, null, 2))
      if (result.assets.some(asset => !succeededStatuses.has(asset.status))) process.exitCode = 1
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Imaging asset operation failed')
      process.exitCode = 1
    })
}
