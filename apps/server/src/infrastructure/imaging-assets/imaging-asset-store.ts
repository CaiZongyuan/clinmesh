import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  canonicalizeSeries,
  imagingTranscoderVersion,
  seriesGeometrySchema,
  type SeriesGeometry,
} from './dicom-canonical.ts'
import {
  imagingAssetOutputSchema,
  imagingReviewItems,
  loadImagingCatalog,
  writeImagingCatalogAsset,
  type ImagingAssetOutput,
  type ImagingCatalog,
  type ImagingCatalogAsset,
} from './imaging-catalog.ts'
import {
  forEachImagingPackAsset,
  ImagingAssetError,
  imagingPackAssetVerified,
  openImagingPackAsset,
  recordImagingPack,
  repairImagingPack,
  requireRecordedImagingAsset,
  selectImagingPackAssets,
  sha256,
  syncImagingPack,
  verifyImagingPack,
  type ImagingAssetResult,
  type ImagingIngestAdapter,
  type ImagingSourceClient,
} from './imaging-pack-store.ts'
import {
  checkImagingReport,
  imagingAssetPublication,
  imagingReportCheckVersion,
  imagingReportContentSha256,
  type ImagingPublicationBlockCode,
  type ImagingReportIssue,
} from './imaging-report-check.ts'
import { lidcAnnotation } from './lidc-annotation.ts'

/** 放射序列的读取入口：几何描述加按帧与像素块读取。 */
export interface InstalledImagingSeries {
  geometry: SeriesGeometry
  readBlock(frameIndex: number, blockIndex: number): Promise<Uint8Array>
}

/**
 * 放射素材包（胸片与胸部 CT 平扫）的摄取适配器。每个序列安装为 `<序列号>/series.json`（几何描述）
 * 与 `<序列号>/frames.bin`（按帧、按块排列的规范像素）；输出登记两者的哈希与像素文件大小。
 */
export const radiologyImagingAdapter: ImagingIngestAdapter<ImagingCatalogAsset, ImagingCatalog, InstalledImagingSeries[]> = {
  async install(asset, series, directory) {
    const instanceOrder: number[][] = []
    const output: ImagingAssetOutput = { series: [], transcoderVersion: imagingTranscoderVersion }
    for (const [seriesIndex, instances] of series.entries()) {
      const source = asset.source.series[seriesIndex]!
      const canonical = canonicalizeSeries({
        examCode: asset.examCode,
        instances: instances.map(instance => instance.bytes),
        modality: source.modality,
        ...(source.orientation === undefined ? {} : { orientation: source.orientation }),
        source: {
          seriesInstanceUid: source.seriesInstanceUid,
          sopInstanceUids: instances.map(instance => instance.sopInstanceUid),
          studyInstanceUid: asset.source.studyInstanceUid,
        },
      })
      // 经 schema 解析后再序列化，字段顺序由 schema 固定，几何哈希不依赖对象构造顺序。
      const geometry = Buffer.from(`${JSON.stringify(seriesGeometrySchema.parse(canonical.geometry))}\n`)
      await mkdir(join(directory, String(seriesIndex)), { recursive: true })
      await writeFile(join(directory, String(seriesIndex), 'series.json'), geometry)
      await writeFile(join(directory, String(seriesIndex), 'frames.bin'), canonical.frames)
      instanceOrder.push(canonical.frameInstances)
      output.series.push({
        framesBytes: canonical.frames.byteLength,
        framesSha256: sha256(canonical.frames),
        geometrySha256: sha256(geometry),
      })
    }
    return { instanceOrder, output }
  },
  installedFiles: output => output.series.flatMap((series, seriesIndex) => [
    { path: `${seriesIndex}/series.json`, sha256: series.geometrySha256 },
    { bytes: series.framesBytes, path: `${seriesIndex}/frames.bin`, sha256: series.framesSha256 },
  ]),
  loadCatalog: loadImagingCatalog,
  /** `series.json` 缺失、与登记的几何哈希不符或无法解析时返回 undefined。 */
  async open(directory, output) {
    const series: InstalledImagingSeries[] = []
    for (const [seriesIndex, recorded] of output.series.entries()) {
      const seriesDirectory = join(directory, String(seriesIndex))
      let geometry: SeriesGeometry
      try {
        const bytes = await readFile(join(seriesDirectory, 'series.json'))
        if (sha256(bytes) !== recorded.geometrySha256) return undefined
        geometry = seriesGeometrySchema.parse(JSON.parse(bytes.toString('utf8')))
      } catch {
        return undefined
      }
      series.push({
        geometry,
        async readBlock(frameIndex: number, blockIndex: number) {
          const block = geometry.frames[frameIndex]?.blocks[blockIndex]
          if (block === undefined) {
            throw new RangeError(`Pixel block ${frameIndex}/${blockIndex} does not exist`)
          }
          const handle = await open(join(seriesDirectory, 'frames.bin'))
          try {
            const bytes = new Uint8Array(block.length)
            const { bytesRead } = await handle.read(bytes, 0, block.length, block.offset)
            if (bytesRead !== block.length) throw new Error('The installed pixel file is truncated')
            return bytes
          } finally {
            await handle.close()
          }
        },
      })
    }
    return series
  },
  outputSchema: imagingAssetOutputSchema,
  async recordAsset(catalogDirectory, asset, { instances, output }) {
    // 输出变化说明帧几何可能已不同，依据旧几何导出的标注随之作废，需要重新标注。
    const { annotation: _annotation, ...unannotated } = asset
    await writeImagingCatalogAsset(catalogDirectory, {
      ...(isDeepStrictEqual(asset.output, output) ? asset : unannotated),
      output,
      source: {
        ...asset.source,
        series: asset.source.series.map((series, index) => ({ ...series, instances: instances[index]! })),
      },
    })
  },
}

interface AssetStoreInput {
  assetDirectory: string
  assetIds?: string[]
  catalogDirectory: string
}

function pack<Input extends AssetStoreInput>(input: Input) {
  return { ...input, adapter: radiologyImagingAdapter }
}

export async function recordImagingAssets(input: AssetStoreInput & { sourceClient: ImagingSourceClient }) {
  return await recordImagingPack(pack(input))
}

export async function syncImagingAssets(input: AssetStoreInput & { sourceClient: ImagingSourceClient }) {
  return await syncImagingPack(pack(input))
}

export async function repairImagingAssets(input: AssetStoreInput) {
  return await repairImagingPack(pack(input))
}

export async function verifyImagingAssets(input: AssetStoreInput) {
  return await verifyImagingPack(pack(input))
}

/** 按安装回执打开一个已安装的放射素材；回执或几何描述缺失、损坏时返回 undefined。 */
export async function openInstalledImagingAsset(input: {
  assetDirectory: string
  assetId: string
}): Promise<{ series: InstalledImagingSeries[] } | undefined> {
  const series = await openImagingPackAsset({ ...input, adapter: radiologyImagingAdapter })
  return series === undefined ? undefined : { series }
}

/**
 * 维护者标注：在本地 LIDC 读片 XML 目录中找到描述该序列的唯一文件，按已安装几何导出结构化标注并写回清单。
 * 标注变化会使已签署的复核失效。
 */
export async function annotateImagingAssets(
  input: AssetStoreInput & { annotationDirectory: string },
): Promise<{ assets: ImagingAssetResult<'annotated'>[] }> {
  const files = (await readdir(input.annotationDirectory, { recursive: true }))
    .filter(file => file.endsWith('.xml'))
    .toSorted()
  const documents = await Promise.all(files.map(async file => ({
    file: file.split(sep).join('/'),
    xml: await readFile(join(input.annotationDirectory, file)),
  })))
  return await forEachImagingPackAsset(pack(input), async (asset) => {
    requireRecordedImagingAsset(asset)
    const [series, ...others] = asset.source.series
    if (others.length > 0 || !await imagingPackAssetVerified({ ...pack(input), asset })) {
      throw new ImagingAssetError(
        'IMAGING_ANNOTATION_INVALID',
        `The imaging asset ${asset.assetId} must be a verified single-series install before it is annotated`,
      )
    }
    // CT 读片文件以 SeriesInstanceUid 标明序列；胸片读片文件用 CXRSeriesInstanceUid，并另行引用配对的 CT。
    const header = `<${series!.modality === 'CT' ? '' : 'CXR'}SeriesInstanceUid>${series!.seriesInstanceUid}</`
    const matches = documents.filter(document => document.xml.includes(header))
    if (matches.length !== 1) {
      throw new ImagingAssetError(
        'IMAGING_ANNOTATION_INVALID',
        `Expected one annotation file for series ${series!.seriesInstanceUid}, found ${matches.length}`,
      )
    }
    const installed = await openImagingPackAsset({ ...pack(input), assetId: asset.assetId })
    if (installed === undefined) {
      throw new ImagingAssetError('IMAGING_ANNOTATION_INVALID', `The imaging asset ${asset.assetId} changed while it was annotated`)
    }
    await writeImagingCatalogAsset(input.catalogDirectory, {
      ...asset,
      annotation: lidcAnnotation({
        fileName: matches[0]!.file,
        geometry: installed[0]!.geometry,
        seriesInstanceUid: series!.seriesInstanceUid,
        sopInstanceUids: series!.instances!.map(instance => instance.sopInstanceUid),
        xml: matches[0]!.xml,
      }),
    })
    return 'annotated'
  })
}

/**
 * 维护者签署复核：对一份报告修订记录复核人、结论与逐项核对，并绑定当前素材、像素、标注和报告内容的哈希。
 * 自动一致性检查未通过的草稿不能签署为通过；之后任何一项内容变化都会使签署失效。
 */
export async function reviewImagingAssets(input: AssetStoreInput & {
  conclusion: 'approved' | 'rejected'
  note?: string | undefined
  reviewer: string
  reviewerIsRadiologist: boolean
  /** 缺省时复核最新的报告修订。 */
  revision?: number | undefined
}): Promise<{ assets: ImagingAssetResult<'reviewed'>[] }> {
  return await forEachImagingPackAsset(pack(input), async (asset) => {
    requireRecordedImagingAsset(asset)
    const report = input.revision === undefined
      ? asset.reports?.at(-1)
      : asset.reports?.find(candidate => candidate.revision === input.revision)
    if (report === undefined) {
      throw new ImagingAssetError('IMAGING_REVIEW_REJECTED', `The imaging asset ${asset.assetId} has no such report revision`)
    }
    const { issues } = checkImagingReport(asset, report)
    if (input.conclusion === 'approved' && issues.length > 0) {
      throw new ImagingAssetError(
        'IMAGING_REVIEW_REJECTED',
        `The report draft fails the automated check: ${issues.map(issue => issue.code).join(', ')}`,
      )
    }
    const items = imagingReviewItems
      .filter(item => item !== 'plain-scan' || asset.examCode === 'chest-ct-plain')
      .map(item => ({ conclusion: input.conclusion === 'approved' ? 'confirmed' as const : 'rejected' as const, item }))
    await writeImagingCatalogAsset(input.catalogDirectory, {
      ...asset,
      reports: asset.reports!.map(candidate => candidate.revision !== report.revision
        ? candidate
        : {
            ...candidate,
            review: {
              automatedCheck: { checkVersion: imagingReportCheckVersion, passed: issues.length === 0 },
              conclusion: input.conclusion,
              contentSha256: imagingReportContentSha256(asset, candidate),
              items,
              ...(input.note === undefined ? {} : { note: input.note }),
              reviewedAt: new Date().toISOString().slice(0, 10),
              reviewer: input.reviewer,
              reviewerIsRadiologist: input.reviewerIsRadiologist,
            },
          }),
    })
    return 'reviewed'
  })
}

/** 逐个素材给出自动一致性检查结果与发布状态；只读。 */
export async function checkImagingAssets(input: Omit<AssetStoreInput, 'assetDirectory'>): Promise<{
  assets: Array<{
    assetId: string
    publishedRevisions: number[]
    reasons: Array<{ code: ImagingPublicationBlockCode; revision?: number }>
    reports: Array<{ issues: ImagingReportIssue[]; revision: number }>
    status: 'published' | 'unpublished'
  }>
}> {
  return {
    assets: (await selectImagingPackAssets({ ...input, adapter: radiologyImagingAdapter })).map((asset) => {
      const publication = imagingAssetPublication(asset)
      return {
        assetId: asset.assetId,
        ...publication,
        reports: (asset.reports ?? []).map(report => ({
          issues: checkImagingReport(asset, report).issues,
          revision: report.revision,
        })),
        status: publication.publishedRevisions.length > 0 ? 'published' as const : 'unpublished' as const,
      }
    }),
  }
}
