import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  defaultPathologyAssetDirectory,
  defaultPathologyCatalogDirectory,
  readServerEnvironment,
} from './config.ts'
import { createIdcSourceClient } from './infrastructure/imaging-assets/idc-source-client.ts'
import type { ImagingSourceClient } from './infrastructure/imaging-assets/imaging-pack-store.ts'
import {
  checkPathologyAssets,
  recordPathologyAssets,
  repairPathologyAssets,
  reviewPathologyAssets,
  syncPathologyAssets,
  verifyPathologyAssets,
} from './infrastructure/imaging-assets/pathology-asset-store.ts'
import { loadPathologyCatalog } from './infrastructure/imaging-assets/pathology-catalog.ts'

const commandSchema = z.enum(['check', 'record', 'repair', 'review', 'sync', 'verify'])
const optionNames = new Set([
  '--asset',
  '--asset-directory',
  '--catalog',
  '--conclusion',
  '--note',
  '--pathologist',
  '--reviewer',
  '--revision',
])
const reviewOptionsSchema = z.object({
  conclusion: z.enum(['approved', 'rejected']),
  note: z.string().trim().min(1).optional(),
  pathologist: z.enum(['no', 'yes']),
  reviewer: z.string().trim().min(1).max(128),
  revision: z.coerce.number().int().positive().optional(),
}).strict()
const succeededStatuses = new Set(['already-installed', 'installed', 'published', 'ready', 'recorded', 'repaired', 'reviewed'])

type PathologyAssetsCliResult = Awaited<ReturnType<
  | typeof checkPathologyAssets
  | typeof recordPathologyAssets
  | typeof repairPathologyAssets
  | typeof reviewPathologyAssets
  | typeof syncPathologyAssets
  | typeof verifyPathologyAssets
>>

/**
 * 病理切片素材的显式维护入口，与放射素材的 `imaging-assets-cli` 使用不同的清单目录与素材目录：
 * `sync` 按清单下载安装，`verify` 只读核对，`repair` 用本地保留的来源实例离线重建；维护者用 `record` 登记哈希、
 * `check` 查看派生受体状态、自动检查与发布状态、`review` 签署复核（需要 `--asset`、`--reviewer`、`--conclusion`
 * 与 `--pathologist yes|no`）。`--asset` 可重复。下载进度写入 stderr。
 */
export async function runPathologyAssetsCli(
  arguments_: string[],
  options: { environment?: NodeJS.ProcessEnv; sourceClient?: ImagingSourceClient } = {},
): Promise<PathologyAssetsCliResult> {
  const [commandValue, ...optionArguments] = arguments_
  const command = commandSchema.parse(commandValue)
  const values = new Map<string, string[]>()
  for (let index = 0; index < optionArguments.length; index += 2) {
    const name = optionArguments[index]
    const value = optionArguments[index + 1]
    if (name === undefined || !optionNames.has(name) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid pathology assets CLI option near: ${name ?? '<end>'}`)
    }
    if (name !== '--asset' && values.has(name)) throw new Error(`Pathology assets CLI option was repeated: ${name}`)
    values.set(name, [...values.get(name) ?? [], value])
  }
  const environment = options.environment ?? readServerEnvironment(process.env)
  const input = {
    assetDirectory: resolve(
      values.get('--asset-directory')?.[0]
      ?? environment.CLINMESH_PATHOLOGY_ASSET_DIRECTORY
      ?? defaultPathologyAssetDirectory,
    ),
    catalogDirectory: resolve(
      values.get('--catalog')?.[0]
      ?? environment.CLINMESH_PATHOLOGY_CATALOG_DIRECTORY
      ?? defaultPathologyCatalogDirectory,
    ),
    ...(values.has('--asset') ? { assetIds: values.get('--asset')! } : {}),
  }
  if (command === 'check') return await checkPathologyAssets(input)
  if (command === 'review') {
    // 复核逐套签署，不提供对整个清单的批量签署。
    if (input.assetIds === undefined) throw new Error('--asset is required for review')
    const review = reviewOptionsSchema.parse({
      conclusion: values.get('--conclusion')?.[0],
      note: values.get('--note')?.[0],
      pathologist: values.get('--pathologist')?.[0],
      reviewer: values.get('--reviewer')?.[0],
      revision: values.get('--revision')?.[0],
    })
    return await reviewPathologyAssets({
      ...input,
      conclusion: review.conclusion,
      note: review.note,
      reviewer: review.reviewer,
      reviewerIsPathologist: review.pathologist === 'yes',
      revision: review.revision,
    })
  }
  if (command === 'verify') return await verifyPathologyAssets(input)
  if (command === 'repair') return await repairPathologyAssets(input)
  const sourceClient = options.sourceClient ?? createIdcSourceClient({
    onProgress: ({ bytes, key, totalBytes }) => {
      console.error(`Downloaded ${(bytes / 1048576).toFixed(1)} / ${(totalBytes / 1048576).toFixed(1)} MiB of ${key}`)
    },
    seriesUuids: new Map((await loadPathologyCatalog(input.catalogDirectory)).assets
      .map(asset => [asset.source.series[0].seriesInstanceUid, asset.source.series[0].idcSeriesUuid])),
  })
  if (command === 'record') return await recordPathologyAssets({ ...input, sourceClient })
  return await syncPathologyAssets({ ...input, sourceClient })
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runPathologyAssetsCli(process.argv.slice(2))
    .then((result) => {
      console.info(JSON.stringify(result, null, 2))
      if (result.assets.some(asset => !succeededStatuses.has(asset.status))) process.exitCode = 1
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Pathology asset operation failed')
      process.exitCode = 1
    })
}
