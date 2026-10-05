import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

export const dicomUidSchema = z.string().regex(/^[0-9]+(\.[0-9]+)*$/).max(64)

/** 素材级失败：转成该素材的结果项，不中断其余素材；`code` 由通用存储或摄取适配器定义。 */
export class ImagingAssetError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ImagingAssetError'
    this.code = code
  }
}

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
  error: { code: string; message: string }
  status: 'failed'
}

export type ImagingAssetResult<Status extends string> =
  | { assetId: string; status: Status }
  | ImagingAssetFailure

export type ImagingAssetInstallStatus = 'corrupt' | 'missing' | 'outdated' | 'ready' | 'unrecorded'
/** 完整核对结果：安装目录就绪后再核对本地保留的来源实例，来源缺失或损坏时安装虽可用但不能离线修复。 */
export type ImagingAssetVerifyStatus = ImagingAssetInstallStatus | 'sources-corrupt' | 'sources-missing'

export interface ImagingSourceInstance {
  bytes: number
  sha256: string
  sopInstanceUid: string
}

/** 通用存储读取的素材条目字段：素材标识、按 DICOM UID 登记的来源实例和登记的安装输出；其余内容由适配器定义。 */
export interface ImagingPackAsset {
  assetId: string
  /** 登记的安装输出，形状由适配器的 `outputSchema` 定义。 */
  output?: unknown
  source: {
    series: Array<{ instances?: ImagingSourceInstance[] | undefined; seriesInstanceUid: string }>
    studyInstanceUid: string
  }
}

type RecordedOutput<Asset extends ImagingPackAsset> = NonNullable<Asset['output']>

/**
 * 一类素材包的摄取适配器：清单格式、来源规范化与安装文件、已安装素材的打开与读取方式。
 * 通用存储负责来源下载与哈希、临时目录、原子发布、安装回执、核对、修复和离线重建。
 */
export interface ImagingIngestAdapter<
  Asset extends ImagingPackAsset,
  Catalog extends { assets: Asset[] } = { assets: Asset[] },
  Opened = unknown,
> {
  /** 在 `directory` 中写出安装文件；`series` 与清单来源序列一一对应，返回登记输出与每个序列安装后的实例顺序（输入下标）。 */
  install(
    asset: Asset,
    series: Array<Array<{ bytes: Uint8Array; sopInstanceUid: string }>>,
    directory: string,
  ): Promise<{ instanceOrder: number[][]; output: RecordedOutput<Asset> }>
  /** 登记输出覆盖的安装文件（相对安装目录）；给出 `bytes` 的文件在快速就绪判断中核对大小。 */
  installedFiles(output: RecordedOutput<Asset>): Array<{ bytes?: number; path: string; sha256: string }>
  /** 读取并校验清单目录；目录或必需文件不存在时以 ENOENT 抛出。 */
  loadCatalog(catalogDirectory: string): Promise<Catalog>
  /** 打开与 `output` 一致的安装目录；文件缺失或损坏时返回 undefined。读取寻址由返回值定义。 */
  open(directory: string, output: RecordedOutput<Asset>): Promise<Opened | undefined>
  outputSchema: z.ZodType<RecordedOutput<Asset>>
  /** 把登记得到的实例清单（按安装顺序）与输出写回素材条目。 */
  recordAsset(
    catalogDirectory: string,
    asset: Asset,
    recorded: { instances: ImagingSourceInstance[][]; output: RecordedOutput<Asset> },
  ): Promise<void>
}

export interface ImagingPackInput<Asset extends ImagingPackAsset> {
  adapter: ImagingIngestAdapter<Asset>
  assetDirectory: string
  assetIds?: string[] | undefined
  catalogDirectory: string
}

const sourceDownloadConcurrency = 4

export function sha256(bytes: Uint8Array): string {
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

/** 流式计算文件的大小与 SHA-256，不把整个文件读入内存（单个层级或来源文件可达数百 MB）；文件不存在时返回 undefined。 */
async function fileDigest(path: string): Promise<{ bytes: number; sha256: string } | undefined> {
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      hash.update(chunk)
      bytes += chunk.byteLength
    }
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  return { bytes, sha256: hash.digest('hex') }
}

/** 读取安装回执中的输出；回执缺失返回 'missing'，无法解析返回 'corrupt'。 */
async function receiptOutput<Asset extends ImagingPackAsset>(
  adapter: ImagingIngestAdapter<Asset>,
  installed: string,
): Promise<RecordedOutput<Asset> | 'corrupt' | 'missing'> {
  const bytes = await readOptionalFile(join(installed, 'receipt.json'))
  if (bytes === undefined) return 'missing'
  try {
    return z.object({ assetId: z.string().min(1), output: adapter.outputSchema }).strict()
      .parse(JSON.parse(Buffer.from(bytes).toString('utf8'))).output
  } catch {
    return 'corrupt'
  }
}

export async function selectImagingPackAssets<Asset extends ImagingPackAsset>(
  input: Omit<ImagingPackInput<Asset>, 'assetDirectory'>,
): Promise<Asset[]> {
  const { assets } = await input.adapter.loadCatalog(input.catalogDirectory)
  if (input.assetIds === undefined) return assets
  return input.assetIds.map((assetId) => {
    const asset = assets.find(candidate => candidate.assetId === assetId)
    if (asset === undefined) throw new Error(`Imaging asset ${assetId} is not in the catalog`)
    return asset
  })
}

/**
 * 清理被中断的进程遗留的临时目录；素材维护命令不支持同一素材目录上的并发执行。
 * 替换安装时被移开的旧版本若因中断没有新版本取代，放回原位，不丢失已经可用的安装。
 */
async function sweepStaging(assetDirectory: string): Promise<void> {
  const replaced = join(assetDirectory, '.replaced')
  for (const kind of await readdir(replaced).catch(() => [])) {
    for (const entry of await readdir(join(replaced, kind))) {
      const target = join(assetDirectory, kind, entry.slice(0, entry.lastIndexOf('@')))
      if (await stat(target).then(() => true, () => false)) {
        await rm(join(replaced, kind, entry), { force: true, recursive: true })
      } else {
        await rename(join(replaced, kind, entry), target)
      }
    }
  }
  await rm(replaced, { force: true, recursive: true })
  await rm(join(assetDirectory, '.staging'), { force: true, recursive: true })
}

/** 逐个素材执行；素材级失败转成结果项，其余异常（磁盘、目录结构）照常抛出。 */
export async function forEachImagingPackAsset<Asset extends ImagingPackAsset, Status extends string>(
  input: ImagingPackInput<Asset>,
  run: (asset: Asset, staging: string) => Promise<Status>,
): Promise<{ assets: ImagingAssetResult<Status>[] }> {
  const results: ImagingAssetResult<Status>[] = []
  for (const asset of await selectImagingPackAssets(input)) {
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

type SourceSeries = ImagingPackAsset['source']['series'][number]
type ResolvedInstance = { bytes: Uint8Array; sopInstanceUid: string }

/**
 * 在临时目录中写出一个素材的来源实例、安装文件与回执，返回按安装顺序排列的实例登记和输出。
 * 发布由调用方在哈希核对之后通过改名完成，失败时临时目录整体丢弃。
 */
async function stageAsset<Asset extends ImagingPackAsset>(
  adapter: ImagingIngestAdapter<Asset>,
  asset: Asset,
  staging: string,
  resolveSeries: (series: SourceSeries, seriesIndex: number) => Promise<ResolvedInstance[]>,
): Promise<{ instances: ImagingSourceInstance[][]; output: RecordedOutput<Asset> }> {
  const unordered: ResolvedInstance[][] = []
  for (const [seriesIndex, series] of asset.source.series.entries()) {
    unordered.push(await resolveSeries(series, seriesIndex))
  }
  await mkdir(join(staging, 'installed'), { recursive: true })
  const { instanceOrder, output } = await adapter.install(asset, unordered, join(staging, 'installed'))
  // 实例按安装顺序登记，清单中的第 N 个实例对应安装后的第 N 项。
  const resolved = instanceOrder.map((order, seriesIndex) => order.map(index => unordered[seriesIndex]![index]!))
  for (const [seriesIndex, instances] of resolved.entries()) {
    await mkdir(join(staging, 'sources', String(seriesIndex)), { recursive: true })
    for (const instance of instances) {
      await writeFile(sourcePath(join(staging, 'sources'), seriesIndex, instance.sopInstanceUid), instance.bytes)
    }
  }
  await writeFile(
    join(staging, 'installed', 'receipt.json'),
    `${JSON.stringify({ assetId: asset.assetId, output }, null, 2)}\n`,
  )
  return {
    instances: resolved.map(instances => instances.map(instance => ({
      bytes: instance.bytes.byteLength,
      sha256: sha256(instance.bytes),
      sopInstanceUid: instance.sopInstanceUid,
    }))),
    output,
  }
}

/**
 * 以改名发布暂存目录。已有安装先移到 `.replaced`，新版本就位后才删除；新版本未能就位时放回旧版本，
 * 进程在两次改名之间中断时由下次维护命令的清理放回。两次改名之间的极短时间内读取会看到素材不可用。
 */
async function publish(staged: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const retired = join(dirname(dirname(target)), '.replaced', basename(dirname(target)), `${basename(target)}@${randomUUID()}`)
  const replacing = await stat(target).then(() => true, () => false)
  if (replacing) {
    await mkdir(dirname(retired), { recursive: true })
    await rename(target, retired)
  }
  try {
    await rename(staged, target)
  } catch (error) {
    if (replacing) await rename(retired, target)
    throw error
  }
  if (replacing) await rm(retired, { force: true, recursive: true })
}

/** 维护命令要求素材已登记来源实例与输出哈希。 */
export function requireRecordedImagingAsset<Asset extends ImagingPackAsset>(asset: Asset): RecordedOutput<Asset> {
  if (asset.output === undefined || asset.source.series.some(series => series.instances === undefined)) {
    throw new ImagingAssetError(
      'IMAGING_ASSET_UNRECORDED',
      `The imaging asset ${asset.assetId} has no recorded source or output hashes`,
    )
  }
  return asset.output as RecordedOutput<Asset>
}

function assertRecordedOutput(asset: ImagingPackAsset, output: unknown): void {
  if (!isDeepStrictEqual(output, asset.output)) {
    throw new ImagingAssetError(
      'IMAGING_OUTPUT_HASH_MISMATCH',
      `The canonical output of ${asset.assetId} differs from the recorded hashes`,
    )
  }
}

async function installStatus<Asset extends ImagingPackAsset>(
  adapter: ImagingIngestAdapter<Asset>,
  assetDirectory: string,
  asset: Asset,
): Promise<ImagingAssetInstallStatus> {
  if (asset.output === undefined) return 'unrecorded'
  const installed = join(assetDirectory, 'installed', asset.assetId)
  const output = await receiptOutput(adapter, installed)
  if (output === 'missing') return 'missing'
  if (output === 'corrupt') return 'corrupt'
  if (!isDeepStrictEqual(output, asset.output)) return 'outdated'
  // 任一文件缺失时报告 missing，否则有哈希不符时报告 corrupt。
  let corrupt = false
  for (const file of adapter.installedFiles(output)) {
    const digest = await fileDigest(join(installed, file.path))
    if (digest === undefined) return 'missing'
    corrupt ||= digest.sha256 !== file.sha256
  }
  return corrupt ? 'corrupt' : 'ready'
}

/** 安装目录就绪后，逐个核对本地保留的来源实例的字节数与哈希。 */
async function verifyStatus<Asset extends ImagingPackAsset>(
  adapter: ImagingIngestAdapter<Asset>,
  assetDirectory: string,
  asset: Asset,
): Promise<ImagingAssetVerifyStatus> {
  const status = await installStatus(adapter, assetDirectory, asset)
  if (status !== 'ready') return status
  const retained = join(assetDirectory, 'sources', asset.assetId)
  for (const [seriesIndex, series] of asset.source.series.entries()) {
    for (const instance of series.instances ?? []) {
      const digest = await fileDigest(sourcePath(retained, seriesIndex, instance.sopInstanceUid))
      if (digest === undefined) return 'sources-missing'
      if (digest.bytes !== instance.bytes || digest.sha256 !== instance.sha256) return 'sources-corrupt'
    }
  }
  return 'ready'
}

/** 取回一个已登记序列的全部实例：本地保留副本哈希相符时直接复用，否则下载并核对登记的哈希。 */
async function loadRecordedSeries(
  input: { assetDirectory: string; sourceClient: ImagingSourceClient },
  asset: ImagingPackAsset,
  recorded: ImagingSourceInstance[],
  series: SourceSeries,
  seriesIndex: number,
): Promise<ResolvedInstance[]> {
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
 * 维护者登记：按来源 UID 下载、规范化并安装素材，再由适配器把实例哈希与输出哈希写回清单。
 * 已登记过实例哈希的序列（例如转码规则升级后重新登记输出）沿用登记的实例清单与本地保留副本。
 * 规范化被拒绝的素材不会写入清单，也不会留下安装目录。
 */
export async function recordImagingPack<Asset extends ImagingPackAsset>(
  input: ImagingPackInput<Asset> & { sourceClient: ImagingSourceClient },
): Promise<{ assets: ImagingAssetResult<'recorded'>[] }> {
  await sweepStaging(input.assetDirectory)
  return await forEachImagingPackAsset(input, async (asset, staging) => {
    const recorded = await stageAsset(input.adapter, asset, staging, async (series, seriesIndex) => {
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
    await input.adapter.recordAsset(input.catalogDirectory, asset, recorded)
    return 'recorded'
  })
}

/**
 * 部署同步：只安装清单已登记的素材。来源字节优先复用本地保留副本，缺失或哈希不符时重新下载；
 * 来源哈希或安装输出哈希与清单不一致时整个素材不发布。安装与保留的来源都完好时跳过。
 */
export async function syncImagingPack<Asset extends ImagingPackAsset>(
  input: ImagingPackInput<Asset> & { sourceClient: ImagingSourceClient },
): Promise<{ assets: ImagingAssetResult<'already-installed' | 'installed'>[] }> {
  await sweepStaging(input.assetDirectory)
  return await forEachImagingPackAsset(input, async (asset, staging) => {
    requireRecordedImagingAsset(asset)
    if (await verifyStatus(input.adapter, input.assetDirectory, asset) === 'ready') return 'already-installed'
    const { output } = await stageAsset(input.adapter, asset, staging, (series, seriesIndex) => (
      loadRecordedSeries(input, asset, series.instances!, series, seriesIndex)
    ))
    assertRecordedOutput(asset, output)
    await publish(join(staging, 'sources'), join(input.assetDirectory, 'sources', asset.assetId))
    await publish(join(staging, 'installed'), join(input.assetDirectory, 'installed', asset.assetId))
    return 'installed'
  })
}

/** 离线修复：只用本地保留且哈希相符的来源实例重建安装目录，不访问网络。 */
export async function repairImagingPack<Asset extends ImagingPackAsset>(
  input: ImagingPackInput<Asset>,
): Promise<{ assets: ImagingAssetResult<'repaired'>[] }> {
  await sweepStaging(input.assetDirectory)
  return await forEachImagingPackAsset(input, async (asset, staging) => {
    requireRecordedImagingAsset(asset)
    const retained = join(input.assetDirectory, 'sources', asset.assetId)
    const { output } = await stageAsset(input.adapter, asset, staging, async (series, seriesIndex) => {
      const resolved: ResolvedInstance[] = []
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
export async function verifyImagingPack<Asset extends ImagingPackAsset>(
  input: ImagingPackInput<Asset>,
): Promise<{ assets: Array<{ assetId: string; status: ImagingAssetVerifyStatus }> }> {
  const assets = []
  for (const asset of await selectImagingPackAssets(input)) {
    assets.push({ assetId: asset.assetId, status: await verifyStatus(input.adapter, input.assetDirectory, asset) })
  }
  return { assets }
}

interface InstalledAssetInput<Asset extends ImagingPackAsset> {
  adapter: ImagingIngestAdapter<Asset>
  asset: Asset
  assetDirectory: string
}

/**
 * 运行时使用的快速就绪判断：安装回执与清单输出一致，且安装文件都存在、登记了大小的文件大小相符。
 * 不逐字节核对哈希；完整核对由 `imagingPackAssetVerified` 与 `verifyImagingPack` 承担。
 */
export async function imagingPackAssetInstalled<Asset extends ImagingPackAsset>(
  input: InstalledAssetInput<Asset>,
): Promise<boolean> {
  if (input.asset.output === undefined) return false
  const installed = join(input.assetDirectory, 'installed', input.asset.assetId)
  const output = await receiptOutput(input.adapter, installed)
  if (output === 'missing' || output === 'corrupt' || !isDeepStrictEqual(output, input.asset.output)) return false
  for (const file of input.adapter.installedFiles(output)) {
    try {
      const { size } = await stat(join(installed, file.path))
      if (file.bytes !== undefined && size !== file.bytes) return false
    } catch (error) {
      if (isMissingFile(error)) return false
      throw error
    }
  }
  return true
}

/** 逐字节核对一个素材的安装文件是否与清单登记的输出一致。 */
export async function imagingPackAssetVerified<Asset extends ImagingPackAsset>(
  input: InstalledAssetInput<Asset>,
): Promise<boolean> {
  return await installStatus(input.adapter, input.assetDirectory, input.asset) === 'ready'
}

/**
 * 已安装文件的变化指纹：回执与各安装文件的 inode、大小与修改时间；任一文件缺失时返回 undefined。
 * 运行时据此判断已打开的素材是否仍然有效，安装、修复或文件被改动后会得到不同的指纹。
 */
export async function installedImagingPackFingerprint<Asset extends ImagingPackAsset>(
  input: InstalledAssetInput<Asset>,
): Promise<string | undefined> {
  if (input.asset.output === undefined) return undefined
  const installed = join(input.assetDirectory, 'installed', input.asset.assetId)
  const paths = ['receipt.json', ...input.adapter.installedFiles(input.asset.output as RecordedOutput<Asset>).map(file => file.path)]
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

/** 按安装回执打开一个已安装素材，供维护命令使用；回执缺失或无法解析时返回 undefined。 */
export async function openImagingPackAsset<Asset extends ImagingPackAsset, Opened>(input: {
  adapter: ImagingIngestAdapter<Asset, { assets: Asset[] }, Opened>
  assetDirectory: string
  assetId: string
}): Promise<Opened | undefined> {
  const installed = join(input.assetDirectory, 'installed', input.assetId)
  const output = await receiptOutput(input.adapter, installed)
  if (output === 'missing' || output === 'corrupt') return undefined
  return await input.adapter.open(installed, output)
}
