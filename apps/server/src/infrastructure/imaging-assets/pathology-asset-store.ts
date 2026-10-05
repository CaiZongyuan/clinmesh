import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  forEachImagingPackAsset,
  ImagingAssetError,
  openImagingPackAsset,
  recordImagingPack,
  repairImagingPack,
  requireRecordedImagingAsset,
  selectImagingPackAssets,
  syncImagingPack,
  verifyImagingPack,
  type ImagingAssetResult,
  type ImagingIngestAdapter,
  type ImagingSourceClient,
} from './imaging-pack-store.ts'
import {
  loadPathologyCatalog,
  pathologyAssetOutputSchema,
  pathologyReviewItems,
  writePathologyCatalogAsset,
  type PathologyCatalog,
  type PathologyCatalogAsset,
  type PathologyLevelOutput,
} from './pathology-catalog.ts'
import {
  checkPathologyReport,
  pathologyAssetPublication,
  pathologyClinicalStatus,
  pathologyReportCheckVersion,
  pathologyReportContentSha256,
  type PathologyPublicationBlockCode,
  type PathologyReportIssue,
} from './pathology-report-check.ts'
import { installPathologySlide } from './pathology-slide.ts'

/** 已安装切片的读取入口：层级描述加按层级与瓦片坐标读取 JPEG 码流。 */
export interface InstalledPathologySlide {
  levels: PathologyLevelOutput[]
  readTile(level: number, column: number, row: number): Promise<Uint8Array>
}

/**
 * 病理切片素材包的摄取适配器。每张切片安装为 `levels/<n>.tiles`（按行优先拼接的 JPEG 瓦片）与
 * `levels/<n>.index`（瓦片累计偏移），以及来源携带时的 `icc-profile.icc`；输出登记层级几何、来源、摄取参数与文件哈希。
 */
export const pathologyImagingAdapter: ImagingIngestAdapter<PathologyCatalogAsset, PathologyCatalog, InstalledPathologySlide> = {
  async install(asset, series, directory) {
    const [source] = asset.source.series
    const { instanceOrder, output } = await installPathologySlide({
      directory,
      instances: series[0]!,
      source: { seriesInstanceUid: source.seriesInstanceUid, studyInstanceUid: asset.source.studyInstanceUid },
    })
    return { instanceOrder: [instanceOrder], output }
  },
  installedFiles: output => [
    ...(output.iccProfile === undefined ? [] : [{ ...output.iccProfile, path: 'icc-profile.icc' }]),
    ...output.levels.flatMap((level, index) => [
      { ...level.index, path: `levels/${index}.index` },
      { bytes: level.tiles.bytes, path: `levels/${index}.tiles`, sha256: level.tiles.sha256 },
    ]),
  ],
  loadCatalog: loadPathologyCatalog,
  /** 偏移索引缺失、长度与登记的瓦片数不符或末尾偏移与瓦片文件大小不符时返回 undefined。 */
  async open(directory, output) {
    const offsets: BigUint64Array[] = []
    for (const [index, level] of output.levels.entries()) {
      let bytes: Buffer
      try {
        bytes = await readFile(join(directory, 'levels', `${index}.index`))
      } catch {
        return undefined
      }
      if (bytes.byteLength !== (level.tiles.count + 1) * 8) return undefined
      const levelOffsets = new BigUint64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      if (levelOffsets.at(-1) !== BigInt(level.tiles.bytes)) return undefined
      offsets.push(levelOffsets)
    }
    return {
      levels: output.levels,
      async readTile(levelIndex, column, row) {
        const level = output.levels[levelIndex]
        const across = level === undefined ? 0 : Math.ceil(level.width / level.tileWidth)
        const down = level === undefined ? 0 : Math.ceil(level.height / level.tileHeight)
        if (level === undefined || !Number.isInteger(column) || !Number.isInteger(row) || column < 0 || row < 0 || column >= across || row >= down) {
          throw new RangeError(`Tile ${levelIndex}/${column}/${row} does not exist`)
        }
        const tile = row * across + column
        const start = Number(offsets[levelIndex]![tile]!)
        const length = Number(offsets[levelIndex]![tile + 1]!) - start
        const handle = await open(join(directory, 'levels', `${levelIndex}.tiles`))
        try {
          const bytes = new Uint8Array(length)
          const { bytesRead } = await handle.read(bytes, 0, length, start)
          if (bytesRead !== length) throw new Error('The installed tile file is truncated')
          return bytes
        } finally {
          await handle.close()
        }
      },
    }
  },
  outputSchema: pathologyAssetOutputSchema,
  async recordAsset(catalogDirectory, asset, { instances, output }) {
    const [series] = asset.source.series
    await writePathologyCatalogAsset(catalogDirectory, {
      ...asset,
      output,
      source: { ...asset.source, series: [{ ...series, instances: instances[0]! }] },
    })
  },
}

interface AssetStoreInput {
  assetDirectory: string
  assetIds?: string[]
  catalogDirectory: string
}

function pack<Input extends AssetStoreInput>(input: Input) {
  return { ...input, adapter: pathologyImagingAdapter }
}

export async function recordPathologyAssets(input: AssetStoreInput & { sourceClient: ImagingSourceClient }) {
  return await recordImagingPack(pack(input))
}

export async function syncPathologyAssets(input: AssetStoreInput & { sourceClient: ImagingSourceClient }) {
  return await syncImagingPack(pack(input))
}

export async function repairPathologyAssets(input: AssetStoreInput) {
  return await repairImagingPack(pack(input))
}

export async function verifyPathologyAssets(input: AssetStoreInput) {
  return await verifyImagingPack(pack(input))
}

/** 按安装回执打开一个已安装的切片；回执或偏移索引缺失、损坏时返回 undefined。 */
export async function openInstalledPathologyAsset(input: {
  assetDirectory: string
  assetId: string
}): Promise<InstalledPathologySlide | undefined> {
  return await openImagingPackAsset({ ...input, adapter: pathologyImagingAdapter })
}

/**
 * 维护者签署复核：对一份报告修订记录复核人、结论与逐项核对，并绑定当前素材、层级、临床字段和报告内容的哈希。
 * 自动一致性检查未通过的草稿不能签署为通过；之后任何一项内容变化都会使签署失效。
 */
export async function reviewPathologyAssets(input: AssetStoreInput & {
  conclusion: 'approved' | 'rejected'
  note?: string | undefined
  reviewer: string
  reviewerIsPathologist: boolean
  /** 缺省时复核最新的报告修订。 */
  revision?: number | undefined
}): Promise<{ assets: ImagingAssetResult<'reviewed'>[] }> {
  return await forEachImagingPackAsset(pack(input), async (asset) => {
    requireRecordedImagingAsset(asset)
    const report = input.revision === undefined
      ? asset.reports?.at(-1)
      : asset.reports?.find(candidate => candidate.revision === input.revision)
    if (report === undefined) {
      throw new ImagingAssetError('PATHOLOGY_REVIEW_REJECTED', `The pathology asset ${asset.assetId} has no such report revision`)
    }
    const { issues } = checkPathologyReport(asset, report)
    if (input.conclusion === 'approved' && issues.length > 0) {
      throw new ImagingAssetError(
        'PATHOLOGY_REVIEW_REJECTED',
        `The report draft fails the automated check: ${issues.map(issue => issue.code).join(', ')}`,
      )
    }
    const items = pathologyReviewItems.map(item => ({
      conclusion: input.conclusion === 'approved' ? 'confirmed' as const : 'rejected' as const,
      item,
    }))
    await writePathologyCatalogAsset(input.catalogDirectory, {
      ...asset,
      reports: asset.reports!.map(candidate => candidate.revision !== report.revision
        ? candidate
        : {
            ...candidate,
            review: {
              automatedCheck: { checkVersion: pathologyReportCheckVersion, passed: issues.length === 0 },
              conclusion: input.conclusion,
              contentSha256: pathologyReportContentSha256(asset, candidate),
              items,
              ...(input.note === undefined ? {} : { note: input.note }),
              reviewedAt: new Date().toISOString().slice(0, 10),
              reviewer: input.reviewer,
              reviewerIsPathologist: input.reviewerIsPathologist,
            },
          }),
    })
    return 'reviewed'
  })
}

/** 逐个素材给出派生的受体状态、自动一致性检查结果与发布状态；只读。 */
export async function checkPathologyAssets(input: Omit<AssetStoreInput, 'assetDirectory'>): Promise<{
  assets: Array<{
    assetId: string
    clinical: Omit<ReturnType<typeof pathologyClinicalStatus>, 'issues'>
    publishedRevisions: number[]
    reasons: Array<{ code: PathologyPublicationBlockCode; revision?: number }>
    reports: Array<{ issues: PathologyReportIssue[]; revision: number }>
    status: 'published' | 'unpublished'
  }>
}> {
  return {
    assets: (await selectImagingPackAssets({ ...input, adapter: pathologyImagingAdapter })).map((asset) => {
      const { issues: _issues, ...clinical } = pathologyClinicalStatus(asset.clinical)
      const publication = pathologyAssetPublication(asset)
      return {
        assetId: asset.assetId,
        clinical,
        ...publication,
        reports: (asset.reports ?? []).map(report => ({
          issues: checkPathologyReport(asset, report).issues,
          revision: report.revision,
        })),
        status: publication.publishedRevisions.length > 0 ? 'published' as const : 'unpublished' as const,
      }
    }),
  }
}
