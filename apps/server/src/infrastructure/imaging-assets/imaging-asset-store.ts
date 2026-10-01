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
  loadImagingCatalog,
  writeImagingCatalogAsset,
  type ImagingAssetOutput,
  type ImagingCatalogAsset,
} from './imaging-catalog.ts'
import {
  checkImagingReport,
  imagingAssetPublication,
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
const sourceDownloadAttempts = 3

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

/** 单个实例的下载最多尝试三次；一套 CT 有数百个实例，偶发网络失败不应让整套素材从头下载。 */
async function fetchFromSource(
  sourceClient: ImagingSourceClient,
  reference: ImagingInstanceReference,
): Promise<Uint8Array> {
  let failure: unknown
  for (let attempt = 0; attempt < sourceDownloadAttempts; attempt += 1) {
    try {
      return await sourceClient.fetchInstance(reference)
    } catch (error) {
      failure = error
    }
  }
  throw new ImagingAssetError(
    'IMAGING_SOURCE_UNAVAILABLE',
    `The source instance ${reference.sopInstanceUid} cannot be downloaded: ${String(failure)}`,
  )
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
 * 部署同步：只安装清单已登记的素材。来源字节优先复用本地保留副本，哈希不符时重新下载；
 * 来源哈希或规范化输出哈希与清单不一致时整个素材不发布。
 */
export async function syncImagingAssets(
  input: AssetStoreInput & { sourceClient: ImagingSourceClient },
): Promise<{ assets: ImagingAssetResult<'already-installed' | 'installed'>[] }> {
  return await forEachAsset(input, async (asset, staging) => {
    recordedOutput(asset)
    if (await installStatus(input.assetDirectory, asset) === 'ready') return 'already-installed'
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

/** 对照清单逐字节核对已安装素材；只读，不修改任何文件。 */
export async function verifyImagingAssets(
  input: AssetStoreInput,
): Promise<{ assets: Array<{ assetId: string; status: ImagingAssetInstallStatus }> }> {
  const assets = []
  for (const asset of await selectAssets(input)) {
    assets.push({ assetId: asset.assetId, status: await installStatus(input.assetDirectory, asset) })
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

/** 打开一个已安装素材：返回每个序列的几何描述与按块读取像素的入口。 */
export async function openInstalledImagingAsset(input: {
  assetDirectory: string
  assetId: string
}): Promise<{ series: InstalledImagingSeries[] }> {
  const installed = join(input.assetDirectory, 'installed', input.assetId)
  const receipt = installReceiptSchema.parse(JSON.parse(await readFile(join(installed, 'receipt.json'), 'utf8')))
  const series = await Promise.all(receipt.output.series.map(async (_, seriesIndex) => {
    const directory = join(installed, String(seriesIndex))
    const geometry = seriesGeometrySchema.parse(JSON.parse(await readFile(join(directory, 'series.json'), 'utf8')))
    return {
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
    }
  }))
  return { series }
}
