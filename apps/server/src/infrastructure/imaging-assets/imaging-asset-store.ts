import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  canonicalizeSeries,
  ImagingAssetError,
  imagingTranscoderVersion,
  seriesGeometrySchema,
  type ImagingAssetErrorCode,
  type SeriesGeometry,
} from './dicom-canonical.ts'
import {
  dicomUidSchema,
  imagingAssetOutputSchema,
  imagingReviewItems,
  loadImagingCatalog,
  writeImagingCatalogAsset,
  type ImagingAssetOutput,
  type ImagingCatalogAsset,
} from './imaging-catalog.ts'
import {
  checkImagingReport,
  imagingAssetPublication,
  imagingReportCheckVersion,
  imagingReportContentSha256,
  type ImagingPublicationBlockCode,
  type ImagingReportIssue,
} from './imaging-report-check.ts'
import { lidcAnnotation } from './lidc-annotation.ts'

export interface ImagingSeriesReference {
  seriesInstanceUid: string
  studyInstanceUid: string
}

export interface ImagingInstanceReference extends ImagingSeriesReference {
  sopInstanceUid: string
}

/** 公开来源的最小读取接口；实现只按来源 UID 取实例，不接受任意 URL。 */
export interface ImagingSourceClient {
  fetchInstance(reference: ImagingInstanceReference): Promise<Uint8Array>
  listInstances(reference: ImagingSeriesReference): Promise<string[]>
}

export interface ImagingAssetFailure {
  assetId: string
  error: { code: ImagingAssetErrorCode; message: string }
  status: 'failed'
}

export type ImagingAssetResult<Status extends string> =
  | { assetId: string; status: Status }
  | ImagingAssetFailure

export type ImagingAssetInstallStatus = 'corrupt' | 'missing' | 'outdated' | 'ready' | 'unrecorded'
/** 完整核对结果：安装目录就绪后再核对本地保留的来源实例，来源缺失或损坏时安装虽可用但不能离线修复。 */
export type ImagingAssetVerifyStatus = ImagingAssetInstallStatus | 'sources-corrupt' | 'sources-missing'

interface AssetStoreInput {
  assetDirectory: string
  assetIds?: string[]
  catalogDirectory: string
}

type SourceInstance = NonNullable<ImagingCatalogAsset['source']['series'][number]['instances']>[number]
type SourceSeries = ImagingCatalogAsset['source']['series'][number]

const installReceiptSchema = z.object({
  assetId: z.string().min(1),
  output: imagingAssetOutputSchema,
}).strict()

const sourceDownloadConcurrency = 4

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sourcePath(root: string, seriesIndex: number, sopInstanceUid: string): string {
  return join(root, String(seriesIndex), `${sopInstanceUid}.dcm`)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function readOptionalFile(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

async function selectAssets(input: Omit<AssetStoreInput, 'assetDirectory'>): Promise<ImagingCatalogAsset[]> {
  const { assets } = await loadImagingCatalog(input.catalogDirectory)
  if (input.assetIds === undefined) return assets
  return input.assetIds.map((assetId) => {
    const asset = assets.find(candidate => candidate.assetId === assetId)
    if (asset === undefined) throw new Error(`Imaging asset ${assetId} is not in the catalog`)
    return asset
  })
}

/** 清理被中断的进程遗留的临时目录；素材维护命令不支持同一素材目录上的并发执行。 */
async function sweepStaging(assetDirectory: string): Promise<void> {
  await rm(join(assetDirectory, '.staging'), { force: true, recursive: true })
}

/** 逐个素材执行；素材级失败转成结果项，其余异常（磁盘、目录结构）照常抛出。 */
async function forEachAsset<Status extends string>(
  input: AssetStoreInput,
  run: (asset: ImagingCatalogAsset, staging: string) => Promise<Status>,
): Promise<{ assets: ImagingAssetResult<Status>[] }> {
  const results: ImagingAssetResult<Status>[] = []
  for (const asset of await selectAssets(input)) {
    const staging = join(input.assetDirectory, '.staging', randomUUID())
    try {
      results.push({ assetId: asset.assetId, status: await run(asset, staging) })
    } catch (error) {
      if (!(error instanceof ImagingAssetError)) throw error
      results.push({
        assetId: asset.assetId,
        error: { code: error.code, message: error.message },
        status: 'failed',
      })
    } finally {
      await rm(staging, { force: true, recursive: true })
    }
  }
  return { assets: results }
}

/** 下载单个实例；重试与退避由来源客户端按其协议负责。 */
async function fetchFromSource(
  sourceClient: ImagingSourceClient,
  reference: ImagingInstanceReference,
): Promise<Uint8Array> {
  try {
    return await sourceClient.fetchInstance(reference)
  } catch (error) {
    throw new ImagingAssetError(
      'IMAGING_SOURCE_UNAVAILABLE',
      `The source instance ${reference.sopInstanceUid} cannot be downloaded: ${String(error)}`,
    )
  }
}

/** 按固定并发取回一个序列的全部实例，保持输入顺序。 */
async function loadInstances(
  sopInstanceUids: string[],
  load: (sopInstanceUid: string) => Promise<Uint8Array>,
): Promise<Uint8Array[]> {
  const loaded: Uint8Array[] = []
  for (let start = 0; start < sopInstanceUids.length; start += sourceDownloadConcurrency) {
    loaded.push(...await Promise.all(sopInstanceUids.slice(start, start + sourceDownloadConcurrency).map(load)))
  }
  return loaded
}

/**
 * 在临时目录中写出一个素材的来源实例与规范化像素，返回按帧顺序排列的实例登记和输出哈希。
 * 发布由调用方在哈希核对之后通过改名完成，失败时临时目录整体丢弃。
 */
async function stageAsset(
  asset: ImagingCatalogAsset,
  staging: string,
  resolveSeries: (series: SourceSeries, seriesIndex: number) => Promise<Array<{
    bytes: Uint8Array
    sopInstanceUid: string
  }>>,
): Promise<{ instances: SourceInstance[][]; output: ImagingAssetOutput }> {
  const instances: SourceInstance[][] = []
  const output: ImagingAssetOutput = { series: [], transcoderVersion: imagingTranscoderVersion }
  for (const [seriesIndex, series] of asset.source.series.entries()) {
    const unordered = await resolveSeries(series, seriesIndex)
    const canonical = canonicalizeSeries({
      examCode: asset.examCode,
      instances: unordered.map(instance => instance.bytes),
      modality: series.modality,
      ...(series.orientation === undefined ? {} : { orientation: series.orientation }),
      source: {
        seriesInstanceUid: series.seriesInstanceUid,
        sopInstanceUids: unordered.map(instance => instance.sopInstanceUid),
        studyInstanceUid: asset.source.studyInstanceUid,
      },
    })
    // 实例按安装后的帧顺序登记，清单中的第 N 个实例就是第 N 帧的来源。
    const resolved = canonical.frameInstances.map(index => unordered[index]!)
    // 经 schema 解析后再序列化，字段顺序由 schema 固定，几何哈希不依赖对象构造顺序。
    const geometry = Buffer.from(`${JSON.stringify(seriesGeometrySchema.parse(canonical.geometry))}\n`)

    await mkdir(join(staging, 'sources', String(seriesIndex)), { recursive: true })
    await mkdir(join(staging, 'installed', String(seriesIndex)), { recursive: true })
    for (const instance of resolved) {
      await writeFile(sourcePath(join(staging, 'sources'), seriesIndex, instance.sopInstanceUid), instance.bytes)
    }
    await writeFile(join(staging, 'installed', String(seriesIndex), 'series.json'), geometry)
    await writeFile(join(staging, 'installed', String(seriesIndex), 'frames.bin'), canonical.frames)

    instances.push(resolved.map(instance => ({
      bytes: instance.bytes.byteLength,
      sha256: sha256(instance.bytes),
      sopInstanceUid: instance.sopInstanceUid,
    })))
    output.series.push({
      framesBytes: canonical.frames.byteLength,
      framesSha256: sha256(canonical.frames),
      geometrySha256: sha256(geometry),
    })
  }
  await writeFile(
    join(staging, 'installed', 'receipt.json'),
    `${JSON.stringify(installReceiptSchema.parse({ assetId: asset.assetId, output }), null, 2)}\n`,
  )
  return { instances, output }
}

async function publish(staged: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  await rm(target, { force: true, recursive: true })
  await rename(staged, target)
}

function recordedOutput(asset: ImagingCatalogAsset): ImagingAssetOutput {
  if (asset.output === undefined || asset.source.series.some(series => series.instances === undefined)) {
    throw new ImagingAssetError(
      'IMAGING_ASSET_UNRECORDED',
      `The imaging asset ${asset.assetId} has no recorded source or output hashes`,
    )
  }
  return asset.output
}

function assertRecordedOutput(asset: ImagingCatalogAsset, output: ImagingAssetOutput): void {
  if (!isDeepStrictEqual(output, asset.output)) {
    throw new ImagingAssetError(
      'IMAGING_OUTPUT_HASH_MISMATCH',
      `The canonical output of ${asset.assetId} differs from the recorded hashes`,
    )
  }
}

async function installStatus(
  assetDirectory: string,
  asset: ImagingCatalogAsset,
): Promise<ImagingAssetInstallStatus> {
  if (asset.output === undefined) return 'unrecorded'
  const installed = join(assetDirectory, 'installed', asset.assetId)
  const receiptBytes = await readOptionalFile(join(installed, 'receipt.json'))
  if (receiptBytes === undefined) return 'missing'
  let receipt
  try {
    receipt = installReceiptSchema.parse(JSON.parse(Buffer.from(receiptBytes).toString('utf8')))
  } catch {
    return 'corrupt'
  }
  if (!isDeepStrictEqual(receipt.output, asset.output)) return 'outdated'
  for (const [seriesIndex, series] of asset.output.series.entries()) {
    const geometry = await readOptionalFile(join(installed, String(seriesIndex), 'series.json'))
    const frames = await readOptionalFile(join(installed, String(seriesIndex), 'frames.bin'))
    if (geometry === undefined || frames === undefined) return 'missing'
    if (sha256(geometry) !== series.geometrySha256 || sha256(frames) !== series.framesSha256) return 'corrupt'
  }
  return 'ready'
}

/** 安装目录就绪后，逐个核对本地保留的来源实例的字节数与哈希。 */
async function verifyStatus(
  assetDirectory: string,
  asset: ImagingCatalogAsset,
): Promise<ImagingAssetVerifyStatus> {
  const status = await installStatus(assetDirectory, asset)
  if (status !== 'ready') return status
  const retained = join(assetDirectory, 'sources', asset.assetId)
  for (const [seriesIndex, series] of asset.source.series.entries()) {
    for (const instance of series.instances ?? []) {
      const bytes = await readOptionalFile(sourcePath(retained, seriesIndex, instance.sopInstanceUid))
      if (bytes === undefined) return 'sources-missing'
      if (bytes.byteLength !== instance.bytes || sha256(bytes) !== instance.sha256) return 'sources-corrupt'
    }
  }
  return 'ready'
}

/** 取回一个已登记序列的全部实例：本地保留副本哈希相符时直接复用，否则下载并核对登记的哈希。 */
async function loadRecordedSeries(
  input: { assetDirectory: string; sourceClient: ImagingSourceClient },
  asset: ImagingCatalogAsset,
  recorded: SourceInstance[],
  series: SourceSeries,
  seriesIndex: number,
): Promise<Array<{ bytes: Uint8Array; sopInstanceUid: string }>> {
  const retained = join(input.assetDirectory, 'sources', asset.assetId)
  const bytes = await loadInstances(recorded.map(instance => instance.sopInstanceUid), async (sopInstanceUid) => {
    const expected = recorded.find(instance => instance.sopInstanceUid === sopInstanceUid)!
    const local = await readOptionalFile(sourcePath(retained, seriesIndex, sopInstanceUid))
    if (local !== undefined && sha256(local) === expected.sha256) return local
    const downloaded = await fetchFromSource(input.sourceClient, {
      seriesInstanceUid: series.seriesInstanceUid,
      sopInstanceUid,
      studyInstanceUid: asset.source.studyInstanceUid,
    })
    if (sha256(downloaded) !== expected.sha256) {
      throw new ImagingAssetError(
        'IMAGING_SOURCE_HASH_MISMATCH',
        `The downloaded instance ${sopInstanceUid} does not match the recorded hash`,
      )
    }
    return downloaded
  })
  return recorded.map((instance, index) => ({ bytes: bytes[index]!, sopInstanceUid: instance.sopInstanceUid }))
}

/**
 * 维护者登记：按来源 UID 下载、规范化并安装素材，再把实例哈希与输出哈希写回清单。
 * 已登记过实例哈希的序列（例如转码规则升级后重新登记输出）沿用登记的实例清单与本地保留副本。
 * 规范化被拒绝的素材不会写入清单，也不会留下安装目录。
 */
export async function recordImagingAssets(
  input: AssetStoreInput & { sourceClient: ImagingSourceClient },
): Promise<{ assets: ImagingAssetResult<'recorded'>[] }> {
  await sweepStaging(input.assetDirectory)
  return await forEachAsset(input, async (asset, staging) => {
    const { instances, output } = await stageAsset(asset, staging, async (series, seriesIndex) => {
      if (series.instances !== undefined) {
        return await loadRecordedSeries(input, asset, series.instances, series, seriesIndex)
      }
      const reference = {
        seriesInstanceUid: series.seriesInstanceUid,
        studyInstanceUid: asset.source.studyInstanceUid,
      }
      let listed: string[]
      try {
        listed = await input.sourceClient.listInstances(reference)
      } catch (error) {
        throw new ImagingAssetError(
          'IMAGING_SOURCE_UNAVAILABLE',
          `The source series ${series.seriesInstanceUid} cannot be listed: ${String(error)}`,
        )
      }
      const sopInstanceUids = z.array(dicomUidSchema).min(1).safeParse(listed)
      if (!sopInstanceUids.success) {
        throw new ImagingAssetError(
          'IMAGING_SOURCE_UNAVAILABLE',
          `The source series ${series.seriesInstanceUid} returned no valid instance list`,
        )
      }
      const bytes = await loadInstances(sopInstanceUids.data, sopInstanceUid => (
        fetchFromSource(input.sourceClient, { ...reference, sopInstanceUid })
      ))
      return sopInstanceUids.data.map((sopInstanceUid, index) => ({ bytes: bytes[index]!, sopInstanceUid }))
    })
    await publish(join(staging, 'sources'), join(input.assetDirectory, 'sources', asset.assetId))
    await publish(join(staging, 'installed'), join(input.assetDirectory, 'installed', asset.assetId))
    // 输出变化说明帧几何可能已不同，依据旧几何导出的标注随之作废，需要重新标注。
    const { annotation: _annotation, ...unannotated } = asset
    await writeImagingCatalogAsset(input.catalogDirectory, {
      ...(isDeepStrictEqual(asset.output, output) ? asset : unannotated),
      output,
      source: {
        ...asset.source,
        series: asset.source.series.map((series, index) => ({ ...series, instances: instances[index]! })),
      },
    })
    return 'recorded'
  })
}

/**
 * 部署同步：只安装清单已登记的素材。来源字节优先复用本地保留副本，缺失或哈希不符时重新下载；
 * 来源哈希或规范化输出哈希与清单不一致时整个素材不发布。安装与保留的来源都完好时跳过。
 */
export async function syncImagingAssets(
  input: AssetStoreInput & { sourceClient: ImagingSourceClient },
): Promise<{ assets: ImagingAssetResult<'already-installed' | 'installed'>[] }> {
  await sweepStaging(input.assetDirectory)
  return await forEachAsset(input, async (asset, staging) => {
    recordedOutput(asset)
    if (await verifyStatus(input.assetDirectory, asset) === 'ready') return 'already-installed'
    const { output } = await stageAsset(asset, staging, (series, seriesIndex) => (
      loadRecordedSeries(input, asset, series.instances!, series, seriesIndex)
    ))
    assertRecordedOutput(asset, output)
    await publish(join(staging, 'sources'), join(input.assetDirectory, 'sources', asset.assetId))
    await publish(join(staging, 'installed'), join(input.assetDirectory, 'installed', asset.assetId))
    return 'installed'
  })
}

/** 离线修复：只用本地保留且哈希相符的来源实例重建安装目录，不访问网络。 */
export async function repairImagingAssets(
  input: AssetStoreInput,
): Promise<{ assets: ImagingAssetResult<'repaired'>[] }> {
  await sweepStaging(input.assetDirectory)
  return await forEachAsset(input, async (asset, staging) => {
    recordedOutput(asset)
    const retained = join(input.assetDirectory, 'sources', asset.assetId)
    const { output } = await stageAsset(asset, staging, async (series, seriesIndex) => {
      const resolved: Array<{ bytes: Uint8Array; sopInstanceUid: string }> = []
      for (const instance of series.instances!) {
        const bytes = await readOptionalFile(sourcePath(retained, seriesIndex, instance.sopInstanceUid))
        if (bytes === undefined) {
          throw new ImagingAssetError(
            'IMAGING_SOURCE_MISSING',
            `The retained source instance ${instance.sopInstanceUid} is missing; run sync to download it again`,
          )
        }
        if (sha256(bytes) !== instance.sha256) {
          throw new ImagingAssetError(
            'IMAGING_SOURCE_HASH_MISMATCH',
            `The retained source instance ${instance.sopInstanceUid} does not match the recorded hash`,
          )
        }
        resolved.push({ bytes, sopInstanceUid: instance.sopInstanceUid })
      }
      return resolved
    })
    assertRecordedOutput(asset, output)
    await publish(join(staging, 'installed'), join(input.assetDirectory, 'installed', asset.assetId))
    return 'repaired'
  })
}

/** 对照清单逐字节核对已安装素材与本地保留的来源实例；只读，不修改任何文件。 */
export async function verifyImagingAssets(
  input: AssetStoreInput,
): Promise<{ assets: Array<{ assetId: string; status: ImagingAssetVerifyStatus }> }> {
  const assets = []
  for (const asset of await selectAssets(input)) {
    assets.push({ assetId: asset.assetId, status: await verifyStatus(input.assetDirectory, asset) })
  }
  return { assets }
}

/**
 * 运行时使用的快速就绪判断：安装回执与清单输出一致，且各序列文件存在、像素文件大小相符。
 * 不逐字节核对哈希；完整核对由 `verifyImagingAssets` 承担。
 */
export async function imagingAssetInstalled(input: {
  asset: ImagingCatalogAsset
  assetDirectory: string
}): Promise<boolean> {
  if (input.asset.output === undefined) return false
  const installed = join(input.assetDirectory, 'installed', input.asset.assetId)
  const receipt = await readOptionalFile(join(installed, 'receipt.json'))
  if (receipt === undefined) return false
  let output: unknown
  try {
    output = installReceiptSchema.parse(JSON.parse(Buffer.from(receipt).toString('utf8'))).output
  } catch {
    return false
  }
  if (!isDeepStrictEqual(output, input.asset.output)) return false
  for (const [seriesIndex, series] of input.asset.output.series.entries()) {
    try {
      const frames = await stat(join(installed, String(seriesIndex), 'frames.bin'))
      await stat(join(installed, String(seriesIndex), 'series.json'))
      if (frames.size !== series.framesBytes) return false
    } catch (error) {
      if (isMissingFile(error)) return false
      throw error
    }
  }
  return true
}

/** 逐字节核对一个素材的已安装像素是否与清单登记的输出一致。 */
export async function imagingAssetVerified(input: {
  asset: ImagingCatalogAsset
  assetDirectory: string
}): Promise<boolean> {
  return await installStatus(input.assetDirectory, input.asset) === 'ready'
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
  return await forEachAsset(input, async (asset) => {
    recordedOutput(asset)
    const [series, ...others] = asset.source.series
    if (others.length > 0 || await installStatus(input.assetDirectory, asset) !== 'ready') {
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
    const installed = await openInstalledImagingAsset({ assetDirectory: input.assetDirectory, assetId: asset.assetId })
    if (installed === undefined) {
      throw new ImagingAssetError('IMAGING_ANNOTATION_INVALID', `The imaging asset ${asset.assetId} changed while it was annotated`)
    }
    await writeImagingCatalogAsset(input.catalogDirectory, {
      ...asset,
      annotation: lidcAnnotation({
        fileName: matches[0]!.file,
        geometry: installed.series[0]!.geometry,
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
  return await forEachAsset(input, async (asset) => {
    recordedOutput(asset)
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
    assets: (await selectAssets(input)).map((asset) => {
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

export interface InstalledImagingSeries {
  geometry: SeriesGeometry
  readBlock(frameIndex: number, blockIndex: number): Promise<Uint8Array>
}

/**
 * 已安装文件的变化指纹：回执与各序列文件的 inode、大小与修改时间；任一文件缺失时返回 undefined。
 * 运行时据此判断已打开的序列是否仍然有效，安装、修复或文件被改动后会得到不同的指纹。
 */
export async function installedImagingAssetFingerprint(input: {
  asset: ImagingCatalogAsset
  assetDirectory: string
}): Promise<string | undefined> {
  const installed = join(input.assetDirectory, 'installed', input.asset.assetId)
  const paths = [
    'receipt.json',
    ...(input.asset.output?.series ?? []).flatMap((_, index) => [`${index}/series.json`, `${index}/frames.bin`]),
  ]
  const parts: string[] = []
  for (const path of paths) {
    try {
      const { ctimeNs, ino, mtimeNs, size } = await stat(join(installed, path), { bigint: true })
      parts.push(`${path}:${ino}:${size}:${mtimeNs}:${ctimeNs}`)
    } catch (error) {
      if (isMissingFile(error)) return undefined
      throw error
    }
  }
  return parts.join('\n')
}

/**
 * 打开一个已安装素材：返回每个序列的几何描述与按块读取像素的入口。
 * 回执或 `series.json` 缺失、无法解析，或 `series.json` 与回执登记的几何哈希不符时返回 undefined。
 */
export async function openInstalledImagingAsset(input: {
  assetDirectory: string
  assetId: string
}): Promise<{ series: InstalledImagingSeries[] } | undefined> {
  const installed = join(input.assetDirectory, 'installed', input.assetId)
  const receiptBytes = await readOptionalFile(join(installed, 'receipt.json'))
  if (receiptBytes === undefined) return undefined
  let receipt
  try {
    receipt = installReceiptSchema.parse(JSON.parse(Buffer.from(receiptBytes).toString('utf8')))
  } catch {
    return undefined
  }
  const series: InstalledImagingSeries[] = []
  for (const [seriesIndex, output] of receipt.output.series.entries()) {
    const directory = join(installed, String(seriesIndex))
    const geometryBytes = await readOptionalFile(join(directory, 'series.json'))
    if (geometryBytes === undefined || sha256(geometryBytes) !== output.geometrySha256) return undefined
    let geometry: SeriesGeometry
    try {
      geometry = seriesGeometrySchema.parse(JSON.parse(Buffer.from(geometryBytes).toString('utf8')))
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
        const handle = await open(join(directory, 'frames.bin'))
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
  return { series }
}
