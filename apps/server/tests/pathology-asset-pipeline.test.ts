import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import jpeg from 'jpeg-js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultImagingAssetDirectory,
  defaultImagingCatalogDirectory,
  defaultPathologyAssetDirectory,
  defaultPathologyCatalogDirectory,
} from '../src/config.ts'
import type { ImagingSourceClient } from '../src/infrastructure/imaging-assets/imaging-pack-store.ts'
import {
  openInstalledPathologyAsset,
  recordPathologyAssets,
  repairPathologyAssets,
  syncPathologyAssets,
  verifyPathologyAssets,
} from '../src/infrastructure/imaging-assets/pathology-asset-store.ts'
import { inspectJpegTile, pathologyIngestParameters } from '../src/infrastructure/imaging-assets/pathology-slide.ts'
import { runPathologyAssetsCli } from '../src/pathology-assets-cli.ts'
import {
  asAdobeTile,
  encodeJpeg2000Tile,
  encodeJpegTile,
  explicitVrLittleEndianSyntax,
  jpeg2000Syntax,
  jpegBaselineSyntax,
  syntheticPatientIdentifiers,
  syntheticPixel,
  syntheticSlideLevel,
  syntheticSlideStudyUid,
  syntheticTextElement,
  syntheticTiles,
  syntheticUnsignedElement,
  withJpegComment,
  withoutJfif,
  type SyntheticSlideLevel,
} from './fixtures/pathology-dicom.ts'

const slideSeries = '2.25.7100'
const tileSize = 16
const idcSeriesUuid = '11111111-2222-4333-8444-555555555555'

interface SourceInstance {
  bytes: Uint8Array
  sopInstanceUid: string
}

interface LevelSpec {
  height: number
  micronsPerPixel: number
  /** 该层一个像素对应的 20 倍像素数。 */
  scale: number
  width: number
}

/** 原生 20 倍切片：20 倍与 5 倍两个组织层级，尺寸不是瓦片的整数倍，20 倍边长为奇数。 */
const twentyTimesLevels: LevelSpec[] = [
  { height: 25, micronsPerPixel: 0.5, scale: 1, width: 41 },
  { height: 6, micronsPerPixel: 2, scale: 4, width: 10 },
]
/** 原生 40 倍切片：40 倍、10 倍与 2.5 倍。 */
const fortyTimesLevels: LevelSpec[] = [
  { height: 48, micronsPerPixel: 0.25, scale: 0.5, width: 80 },
  { height: 12, micronsPerPixel: 1, scale: 2, width: 20 },
  { height: 3, micronsPerPixel: 4, scale: 8, width: 5 },
]

async function slideInstances(input: {
  codec?: 'jpeg' | 'jpeg-rgb' | 'jpeg2000'
  extra?: Array<Partial<SyntheticSlideLevel> & { imageType: string }>
  levels?: LevelSpec[]
  override?: (level: SyntheticSlideLevel, index: number) => SyntheticSlideLevel
} = {}): Promise<{ frames: Uint8Array[][]; instances: SourceInstance[] }> {
  const codec = input.codec ?? 'jpeg'
  const frames: Uint8Array[][] = []
  const instances: SourceInstance[] = []
  const iccProfile = Buffer.from('synthetic ICC profile bytes.')
  for (const [index, level] of (input.levels ?? twentyTimesLevels).entries()) {
    const tiles = syntheticTiles(level.width, level.height, tileSize, level.scale)
    const encoded = codec === 'jpeg2000'
      ? await Promise.all(tiles.map(tile => encodeJpeg2000Tile(tile, tileSize)))
      : tiles.map(tile => codec === 'jpeg-rgb' ? asAdobeTile(encodeJpegTile(tile, tileSize)) : encodeJpegTile(tile, tileSize))
    frames.push(encoded)
    const sopInstanceUid = `2.25.71${index + 1}0`
    const base: SyntheticSlideLevel = {
      frames: encoded,
      height: level.height,
      iccProfile,
      imageType: index === 0 ? 'DERIVED\\PRIMARY\\VOLUME\\NONE' : 'DERIVED\\PRIMARY\\VOLUME\\RESAMPLED',
      micronsPerPixel: level.micronsPerPixel,
      photometric: codec === 'jpeg' ? 'YBR_FULL' : 'RGB',
      seriesInstanceUid: slideSeries,
      sopInstanceUid,
      tileSize,
      transferSyntaxUid: codec === 'jpeg2000' ? jpeg2000Syntax : jpegBaselineSyntax,
      width: level.width,
    }
    instances.push({ bytes: syntheticSlideLevel(input.override?.(base, index) ?? base), sopInstanceUid })
  }
  // 来源序列另含一张未压缩缩略图，以及测试指定的标签图、宏观图等非组织实例。
  const others = [{ imageType: 'DERIVED\\PRIMARY\\THUMBNAIL\\RESAMPLED' }, ...(input.extra ?? [])]
  for (const [index, other] of others.entries()) {
    const sopInstanceUid = `2.25.719${index}`
    instances.push({
      bytes: syntheticSlideLevel({
        frames: [new Uint8Array(4 * 4 * 3).fill(200)],
        height: 4,
        iccProfile,
        micronsPerPixel: 5,
        photometric: 'RGB',
        seriesInstanceUid: slideSeries,
        sopInstanceUid,
        tileSize: 4,
        transferSyntaxUid: explicitVrLittleEndianSyntax,
        width: 4,
        ...other,
      }),
      sopInstanceUid,
    })
  }
  return { frames, instances }
}

function sourceClient(instances: SourceInstance[], calls: string[] = []): ImagingSourceClient {
  return {
    async fetchInstance(reference) {
      calls.push(reference.sopInstanceUid)
      const instance = reference.seriesInstanceUid === slideSeries
        ? instances.find(candidate => candidate.sopInstanceUid === reference.sopInstanceUid)
        : undefined
      if (instance === undefined) throw new Error(`unknown instance ${reference.sopInstanceUid}`)
      return instance.bytes
    },
    async listInstances(reference) {
      return reference.seriesInstanceUid === slideSeries ? instances.map(instance => instance.sopInstanceUid) : []
    },
  }
}

async function writeCatalog(directory: string) {
  await mkdir(join(directory, 'assets'), { recursive: true })
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
    clinicalSources: [{
      attribution: 'Synthetic clinical fixture',
      id: 'synthetic-clinical',
      sha256: '0'.repeat(64),
      terms: 'Synthetic',
      title: 'Synthetic clinical fields',
      url: 'https://example.invalid/clinical',
    }],
    collections: [{
      attribution: 'Synthetic fixture collection',
      doi: '10.0000/synthetic-slides',
      id: 'synthetic-slides',
      license: 'CC-BY-4.0',
      source: { kind: 'idc-s3' },
      title: 'Synthetic slide fixture',
    }],
    packId: 'clinmesh-pathology-test',
    schemaVersion: 1,
  }, null, 2)}\n`)
  await writeFile(join(directory, 'assets', 'synthetic-slide.json'), `${JSON.stringify({
    assetId: 'synthetic-slide',
    clinical: {
      estrogenReceptor: 'Positive',
      her2: { fish: 'Negative' },
      histologicType: 'Infiltrating Ductal Carcinoma',
      pathologicN: 'N1',
      pathologicT: 'T2',
      progesteroneReceptor: 'Positive',
      sampleId: 'SYNTHETIC-SAMPLE-01',
      sampleType: 'Primary Tumor',
      sex: 'female',
      sourceId: 'synthetic-clinical',
    },
    collectionId: 'synthetic-slides',
    schemaVersion: 1,
    source: {
      series: [{ idcSeriesUuid, seriesInstanceUid: slideSeries }],
      slideId: 'SYNTHETIC-SLIDE-01',
      studyInstanceUid: syntheticSlideStudyUid,
      subjectId: 'SYNTHETIC-SUBJECT-01',
    },
  }, null, 2)}\n`)
}

async function readAsset(catalogDirectory: string) {
  return JSON.parse(await readFile(join(catalogDirectory, 'assets', 'synthetic-slide.json'), 'utf8'))
}

async function openInstalled(assetDirectory: string) {
  const opened = await openInstalledPathologyAsset({ assetDirectory, assetId: 'synthetic-slide' })
  if (opened === undefined) throw new Error('synthetic-slide is not installed')
  return opened
}

function decodeTile(tile: Uint8Array): Uint8Array {
  const decoded = jpeg.decode(tile, { formatAsRGBA: false, useTArray: true })
  expect([decoded.width, decoded.height]).toEqual([tileSize, tileSize])
  return decoded.data
}

function pixelAt(tile: Uint8Array, x: number, y: number): number[] {
  return Array.from(tile.subarray((y * tileSize + x) * 3, (y * tileSize + x) * 3 + 3))
}

function expectClose(actual: number[], expected: number[], tolerance: number) {
  for (const [channel, value] of actual.entries()) expect(Math.abs(value - expected[channel]!)).toBeLessThanOrEqual(tolerance)
}

/** 20 倍像素函数在 factor×factor 区域内（限于层级范围）的均值。 */
function boxMean(x: number, y: number, factor: number, scale: number, width: number, height: number): number[] {
  const sum = [0, 0, 0]
  let count = 0
  for (let dy = 0; dy < factor && y * factor + dy < height; dy += 1) {
    for (let dx = 0; dx < factor && x * factor + dx < width; dx += 1) {
      for (const [channel, value] of syntheticPixel(x * factor + dx, y * factor + dy, scale).entries()) sum[channel]! += value
      count += 1
    }
  }
  return sum.map(value => value / count)
}

async function listTree(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true }).catch(() => [])).map(String).toSorted()
}

/** 素材目录中除空的临时目录根之外的全部条目。 */
async function assetTree(assetDirectory: string): Promise<string[]> {
  return (await listTree(assetDirectory)).filter(path => path !== '.staging')
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('pathology slide asset pipeline', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), 'clinmesh-pathology-assets-'))
    temporaryDirectories.push(root)
    const catalogDirectory = join(root, 'catalog')
    await writeCatalog(catalogDirectory)
    return { assetDirectory: join(root, 'assets'), catalogDirectory, root }
  }

  it('keeps the pathology pack apart from the radiology pack', () => {
    expect(defaultPathologyAssetDirectory).not.toBe(defaultImagingAssetDirectory)
    expect(defaultPathologyCatalogDirectory).not.toBe(defaultImagingCatalogDirectory)
  })

  it('records ingest parameters that match the pinned codec libraries', async () => {
    const { dependencies } = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    expect(pathologyIngestParameters.jpegEncoder.version).toBe(dependencies['jpeg-js'])
    expect(pathologyIngestParameters.jpeg2000Decoder.version).toBe(dependencies['@cornerstonejs/codec-openjpeg'])
  })

  it('drops the thumbnail, copies native JPEG tiles byte for byte and derives a 10x level from 20x', async () => {
    const { assetDirectory, catalogDirectory } = await workspace()
    const { frames, instances } = await slideInstances()

    expect(await recordPathologyAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(instances) }))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'recorded' }] })

    const recorded = await readAsset(catalogDirectory)
    // 只登记并保留组织层级（按倍率从高到低）；缩略图既不登记也不保留。
    expect(recorded.source.series[0].instances).toEqual([instances[0]!, instances[1]!].map(instance => ({
      bytes: instance.bytes.byteLength,
      sha256: sha256(instance.bytes),
      sopInstanceUid: instance.sopInstanceUid,
    })))
    expect(await listTree(join(assetDirectory, 'sources', 'synthetic-slide'))).toEqual(['0', '0/2.25.7110.dcm', '0/2.25.7120.dcm'])
    expect(await listTree(join(assetDirectory, 'installed', 'synthetic-slide'))).toEqual([
      'icc-profile.icc',
      'levels',
      'levels/0.index',
      'levels/0.tiles',
      'levels/1.index',
      'levels/1.tiles',
      'levels/2.index',
      'levels/2.tiles',
      'receipt.json',
    ])
    expect(recorded.output.levels.map((level: { magnification: number }) => level.magnification)).toEqual([20, 10, 5])
    expect(recorded.output).toMatchObject({
      iccProfile: { bytes: 28, sha256: sha256(Buffer.from('synthetic ICC profile bytes.')) },
      ingestVersion: 1,
      levels: [
        {
          height: 25,
          micronsPerPixel: 0.5,
          origin: { kind: 'source', sourceCodec: 'jpeg-baseline', sourceInstance: 0, tiles: 'copied' },
          tileHeight: tileSize,
          tileWidth: tileSize,
          tiles: { count: 6 },
          width: 41,
        },
        {
          height: 13,
          micronsPerPixel: 1,
          origin: { factor: 2, kind: 'derived', method: 'box', sourceInstance: 0 },
          tiles: { count: 2 },
          width: 21,
        },
        {
          height: 6,
          micronsPerPixel: 2,
          origin: { kind: 'source', sourceCodec: 'jpeg-baseline', sourceInstance: 1, tiles: 'copied' },
          tiles: { count: 1 },
          width: 10,
        },
      ],
      parameters: pathologyIngestParameters,
    })

    // 打包与索引：登记的偏移处就是来源片段的字节（DICOM 片段按偶数长度补 0x00），并且能解码成瓦片尺寸。
    const installed = join(assetDirectory, 'installed', 'synthetic-slide')
    const pack = await readFile(join(installed, 'levels', '0.tiles'))
    const index = await readFile(join(installed, 'levels', '0.index'))
    expect(index.byteLength).toBe((6 + 1) * 8)
    expect(Number(index.readBigUInt64LE(6 * 8))).toBe(pack.byteLength)
    const slide = await openInstalled(assetDirectory)
    for (const [tile, frame] of frames[0]!.entries()) {
      const stored = pack.subarray(Number(index.readBigUInt64LE(tile * 8)), Number(index.readBigUInt64LE(tile * 8 + 8)))
      expect(Buffer.from(stored.subarray(0, frame.byteLength)).equals(Buffer.from(frame))).toBe(true)
      expect(stored.byteLength - frame.byteLength).toBe(frame.byteLength % 2)
      expect(Buffer.from(await slide.readTile(0, tile % 3, Math.floor(tile / 3))).equals(stored)).toBe(true)
      decodeTile(stored)
    }
    expect(recorded.output.levels[0].tiles).toMatchObject({ bytes: pack.byteLength, sha256: sha256(pack) })
    expect(recorded.output.levels[0].tiles.largestBytes).toBeLessThan(64 * 1024)
    await expect(slide.readTile(0, 3, 0)).rejects.toThrow(RangeError)
    await expect(slide.readTile(3, 0, 0)).rejects.toThrow(RangeError)

    // 10 倍层级：每个像素是 20 倍 2×2 区域（限于层级范围）的均值；超出层级尺寸的填充像素为白色。
    const left = decodeTile(await slide.readTile(1, 0, 0))
    const right = decodeTile(await slide.readTile(1, 1, 0))
    expectClose(pixelAt(left, 3, 5), boxMean(3, 5, 2, 1, 41, 25), 12)
    expectClose(pixelAt(left, 15, 12), boxMean(15, 12, 2, 1, 41, 25), 12)
    expectClose(pixelAt(right, 2, 6), boxMean(18, 6, 2, 1, 41, 25), 12)
    expectClose(pixelAt(right, 12, 15), [255, 255, 255], 12)
    expectClose(pixelAt(left, 8, 15), [255, 255, 255], 12)

    expect(await verifyPathologyAssets({ assetDirectory, catalogDirectory }))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'ready' }] })
  })

  it('caps the pyramid at 20x by deriving it from a native 40x level and keeps the native 10x level', async () => {
    const { assetDirectory, catalogDirectory } = await workspace()
    const { instances } = await slideInstances({ levels: fortyTimesLevels })

    expect((await recordPathologyAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(instances) })).assets[0])
      .toEqual({ assetId: 'synthetic-slide', status: 'recorded' })

    const recorded = await readAsset(catalogDirectory)
    expect(recorded.output.levels.map((level: { magnification: number; origin: unknown; width: number }) => (
      { magnification: level.magnification, origin: level.origin, width: level.width }
    ))).toEqual([
      { magnification: 20, origin: { factor: 2, kind: 'derived', method: 'box', sourceInstance: 0 }, width: 40 },
      { magnification: 10, origin: { kind: 'source', sourceCodec: 'jpeg-baseline', sourceInstance: 1, tiles: 'copied' }, width: 20 },
      { magnification: 2.5, origin: { kind: 'source', sourceCodec: 'jpeg-baseline', sourceInstance: 2, tiles: 'copied' }, width: 5 },
    ])
    // 40 倍来源实例保留用于离线重建，但不安装为可读层级。
    expect(recorded.source.series[0].instances.map((instance: { sopInstanceUid: string }) => instance.sopInstanceUid))
      .toEqual(['2.25.7110', '2.25.7120', '2.25.7130'])
    const slide = await openInstalled(assetDirectory)
    expect(Math.min(...slide.levels.map(level => level.micronsPerPixel))).toBe(0.5)
    expectClose(pixelAt(decodeTile(await slide.readTile(0, 1, 1)), 4, 3), boxMean(20, 19, 2, 0.5, 80, 48), 12)
  })

  it('transcodes JPEG 2000 tiles to baseline JPEG deterministically and rebuilds identical bytes', async () => {
    const { assetDirectory, catalogDirectory, root } = await workspace()
    const { instances } = await slideInstances({ codec: 'jpeg2000' })

    expect((await recordPathologyAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(instances) })).assets[0])
      .toEqual({ assetId: 'synthetic-slide', status: 'recorded' })
    const recorded = await readAsset(catalogDirectory)
    expect(recorded.output.levels.map((level: { origin: unknown }) => level.origin)).toEqual([
      { kind: 'source', sourceCodec: 'jpeg2000', sourceInstance: 0, tiles: 'transcoded' },
      { factor: 2, kind: 'derived', method: 'box', sourceInstance: 0 },
      { kind: 'source', sourceCodec: 'jpeg2000', sourceInstance: 1, tiles: 'transcoded' },
    ])
    const slide = await openInstalled(assetDirectory)
    // 转码后的瓦片是浏览器可直接解码的 JFIF 基线 JPEG，像素与来源一致。
    const transcoded = await slide.readTile(0, 1, 1)
    expect(Buffer.from(transcoded.subarray(6, 10)).toString('latin1')).toBe('JFIF')
    expectClose(pixelAt(decodeTile(transcoded), 5, 4), syntheticPixel(21, 20, 1), 8)
    expectClose(pixelAt(decodeTile(await slide.readTile(1, 0, 0)), 3, 5), boxMean(3, 5, 2, 1, 41, 25), 8)

    // 另一个维护环境从未登记的清单重新登记，得到相同的输出哈希。
    const secondCatalog = join(root, 'second-catalog')
    await writeCatalog(secondCatalog)
    await recordPathologyAssets({ assetDirectory: join(root, 'second-assets'), catalogDirectory: secondCatalog, sourceClient: sourceClient(instances) })
    expect((await readAsset(secondCatalog)).output).toEqual(recorded.output)

    // 部署同步按登记的哈希安装；损坏后只用保留的来源离线重建出相同字节。
    const deployed = join(root, 'deployed')
    expect((await syncPathologyAssets({ assetDirectory: deployed, catalogDirectory, sourceClient: sourceClient(instances) })).assets[0])
      .toEqual({ assetId: 'synthetic-slide', status: 'installed' })
    const derivedPack = join(deployed, 'installed', 'synthetic-slide', 'levels', '1.tiles')
    const original = await readFile(derivedPack)
    await writeFile(derivedPack, Buffer.alloc(original.byteLength, 1))
    expect(await verifyPathologyAssets({ assetDirectory: deployed, catalogDirectory }))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'corrupt' }] })
    expect(await openInstalledPathologyAsset({ assetDirectory: deployed, assetId: 'synthetic-slide' })).toBeDefined()
    expect(await repairPathologyAssets({ assetDirectory: deployed, catalogDirectory }))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'repaired' }] })
    expect((await readFile(derivedPack)).equals(original)).toBe(true)
    expect(await verifyPathologyAssets({ assetDirectory: deployed, catalogDirectory }))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'ready' }] })
  })

  it('accepts source-style RGB JPEG tiles and drops label and overview images', async () => {
    const { assetDirectory, catalogDirectory } = await workspace()
    const { frames, instances } = await slideInstances({
      codec: 'jpeg-rgb',
      extra: [{ imageType: 'ORIGINAL\\PRIMARY\\LABEL\\NONE' }, { imageType: 'ORIGINAL\\PRIMARY\\OVERVIEW\\NONE' }],
    })

    expect((await recordPathologyAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(instances) })).assets[0])
      .toEqual({ assetId: 'synthetic-slide', status: 'recorded' })
    const recorded = await readAsset(catalogDirectory)
    expect(recorded.source.series[0].instances).toHaveLength(2)
    expect(recorded.output.levels).toHaveLength(3)
    const slide = await openInstalled(assetDirectory)
    const stored = await slide.readTile(0, 0, 0)
    expect(Buffer.from(stored.subarray(0, frames[0]![0]!.byteLength)).equals(Buffer.from(frames[0]![0]!))).toBe(true)
  })

  it('decodes each JPEG tile by its own color markers when a level mixes encodings', async () => {
    const { assetDirectory, catalogDirectory } = await workspace()
    // 来源的 RGB 层级中混有按 YCbCr 编码的瓦片（真实切片的填充瓦片即如此）；这里第一个 20 倍瓦片保留 JFIF 编码。
    const ycbcrTile = encodeJpegTile(syntheticTiles(41, 25, tileSize, 1)[0]!, tileSize)
    const { instances } = await slideInstances({
      codec: 'jpeg-rgb',
      override: (level, index) => index === 0 ? { ...level, frames: [ycbcrTile, ...level.frames.slice(1)] } : level,
    })

    expect((await recordPathologyAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(instances) })).assets[0])
      .toEqual({ assetId: 'synthetic-slide', status: 'recorded' })

    const slide = await openInstalled(assetDirectory)
    expect(Buffer.from((await slide.readTile(0, 0, 0)).subarray(0, ycbcrTile.byteLength)).equals(Buffer.from(ycbcrTile))).toBe(true)
    // 10 倍瓦片左上象限来自该 YCbCr 瓦片：颜色按 YCbCr 解码后降采样，与合成像素函数一致。
    expectClose(pixelAt(decodeTile(await slide.readTile(1, 0, 0)), 3, 5), boxMean(3, 5, 2, 1, 41, 25), 12)
  })

  it('reads the color model a browser would use from the JPEG markers', () => {
    const jfif = encodeJpegTile(syntheticTiles(tileSize, tileSize, tileSize, 1)[0]!, tileSize)
    const bare = withoutJfif(jfif)
    const frameHeader = Buffer.from(bare).indexOf(Buffer.from([0xff, 0xc0]))
    const rgbIds = Uint8Array.from(bare)
    rgbIds.set([0x52], frameHeader + 10)
    rgbIds.set([0x47], frameHeader + 13)
    rgbIds.set([0x42], frameHeader + 16)
    const subsampled = Uint8Array.from(bare)
    subsampled.set([0x22], frameHeader + 11)

    expect(inspectJpegTile(jfif, tileSize, tileSize)).toEqual({ explicit: true, model: 'YCbCr' })
    expect(inspectJpegTile(asAdobeTile(jfif, 0), tileSize, tileSize)).toEqual({ explicit: true, model: 'RGB' })
    expect(inspectJpegTile(asAdobeTile(jfif, 1), tileSize, tileSize)).toEqual({ explicit: true, model: 'YCbCr' })
    expect(inspectJpegTile(rgbIds, tileSize, tileSize)).toEqual({ explicit: true, model: 'RGB' })
    expect(inspectJpegTile(subsampled, tileSize, tileSize)).toEqual({ explicit: true, model: 'YCbCr' })
    expect(inspectJpegTile(bare, tileSize, tileSize)).toEqual({ explicit: false, model: 'YCbCr' })
  })

  it('writes no patient identifiers into installed files, the catalog or command results', async () => {
    const { assetDirectory, catalogDirectory } = await workspace()
    const { instances } = await slideInstances({ codec: 'jpeg2000' })
    for (const identifier of syntheticPatientIdentifiers) {
      expect(Buffer.from(instances[0]!.bytes).includes(identifier)).toBe(true)
    }

    const result = await recordPathologyAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(instances) })

    const installed = join(assetDirectory, 'installed', 'synthetic-slide')
    const outputs = [Buffer.from(JSON.stringify(result)), await readFile(join(catalogDirectory, 'assets', 'synthetic-slide.json'))]
    for (const file of await listTree(installed)) {
      if ((await stat(join(installed, file))).isFile()) outputs.push(await readFile(join(installed, file)))
    }
    expect(outputs.length).toBeGreaterThan(8)
    for (const output of outputs) {
      for (const identifier of syntheticPatientIdentifiers) expect(output.includes(identifier)).toBe(false)
    }
  })

  it.each([
    {
      code: 'IMAGING_SOURCE_UID_MISMATCH',
      name: 'an instance from another study',
      override: (level: SyntheticSlideLevel) => ({ ...level, studyInstanceUid: '2.25.7999' }),
    },
    {
      code: 'IMAGING_SOURCE_UID_MISMATCH',
      name: 'an instance from another series',
      override: (level: SyntheticSlideLevel, index: number) => index === 1 ? { ...level, seriesInstanceUid: '2.25.7998' } : level,
    },
    {
      code: 'IMAGING_SOURCE_UID_MISMATCH',
      name: 'an instance whose SOP Instance UID differs from the requested one',
      override: (level: SyntheticSlideLevel, index: number) => index === 0
        ? { ...level, elements: { '00080018': syntheticTextElement('00080018', 'UI', '2.25.7997') } }
        : level,
    },
    {
      code: 'PATHOLOGY_TRANSFER_SYNTAX_UNSUPPORTED',
      name: 'a JPEG-LS level',
      override: (level: SyntheticSlideLevel) => ({ ...level, transferSyntaxUid: '1.2.840.10008.1.2.4.80' }),
    },
    {
      code: 'PATHOLOGY_COLOR_UNSUPPORTED',
      name: 'RGB JPEG tiles without color markers, which a browser would decode as YCbCr',
      override: (level: SyntheticSlideLevel) => ({ ...level, frames: level.frames.map(withoutJfif), photometric: 'RGB' }),
    },
    {
      code: 'PATHOLOGY_COLOR_UNSUPPORTED',
      name: 'a palette color level',
      override: (level: SyntheticSlideLevel) => ({ ...level, photometric: 'PALETTE COLOR' }),
    },
    {
      code: 'PATHOLOGY_LEVEL_UNSUPPORTED',
      name: 'a level that is not TILED_FULL',
      override: (level: SyntheticSlideLevel) => ({ ...level, elements: { '00209311': syntheticTextElement('00209311', 'CS', 'TILED_SPARSE') } }),
    },
    {
      code: 'PATHOLOGY_DICOM_INVALID',
      name: 'a level without pixel spacing',
      override: (level: SyntheticSlideLevel) => ({ ...level, elements: { '52009229': undefined } }),
    },
    {
      code: 'PATHOLOGY_LEVEL_UNSUPPORTED',
      name: 'a level whose pixel spacing is not a supported magnification',
      override: (level: SyntheticSlideLevel, index: number) => index === 1 ? { ...level, micronsPerPixel: 1.4 } : level,
    },
    {
      code: 'PATHOLOGY_LEVEL_UNSUPPORTED',
      name: 'a level whose size disagrees with its pixel spacing',
      override: (level: SyntheticSlideLevel, index: number) => index === 1 ? { ...level, micronsPerPixel: 4 } : level,
    },
    {
      code: 'PATHOLOGY_LEVEL_UNSUPPORTED',
      name: 'a level with fewer fragments than tiles',
      override: (level: SyntheticSlideLevel, index: number) => index === 0 ? { ...level, frames: level.frames.slice(1) } : level,
    },
    {
      code: 'PATHOLOGY_LEVEL_UNSUPPORTED',
      name: 'a level with burned-in annotation',
      override: (level: SyntheticSlideLevel) => ({ ...level, elements: { '00280301': syntheticTextElement('00280301', 'CS', 'YES') } }),
    },
    {
      code: 'PATHOLOGY_LEVEL_UNSUPPORTED',
      name: 'a level with several focal planes',
      override: (level: SyntheticSlideLevel) => ({ ...level, elements: { '00480303': syntheticUnsignedElement('00480303', 'UL', 3) } }),
    },
    {
      code: 'PATHOLOGY_LEVEL_UNSUPPORTED',
      name: 'a level with several optical paths',
      override: (level: SyntheticSlideLevel) => ({ ...level, elements: { '00480302': syntheticUnsignedElement('00480302', 'UL', 2) } }),
    },
    {
      code: 'PATHOLOGY_TILE_INVALID',
      name: 'a JPEG tile that carries a comment segment',
      override: (level: SyntheticSlideLevel, index: number) => index === 0
        ? { ...level, frames: level.frames.map((frame, tile) => tile === 2 ? withJpegComment(frame, syntheticPatientIdentifiers[1]!) : frame) }
        : level,
    },
    {
      code: 'PATHOLOGY_TILE_INVALID',
      name: 'a JPEG tile whose size differs from the declared tile size',
      override: (level: SyntheticSlideLevel, index: number) => index === 1
        ? { ...level, frames: [new Uint8Array(jpeg.encode({ data: new Uint8Array(8 * 8 * 4).fill(128), height: 8, width: 8 }, 90).data)] }
        : level,
    },
    {
      code: 'PATHOLOGY_LEVEL_MISSING',
      name: 'a slide whose highest level is below 10x',
      override: (level: SyntheticSlideLevel) => ({ ...level, micronsPerPixel: level.micronsPerPixel * 4 }),
    },
  ])('rejects $name without recording or installing anything', async ({ code, override }) => {
    const { assetDirectory, catalogDirectory } = await workspace()
    const { instances } = await slideInstances({ override })

    const result = await recordPathologyAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(instances) })

    expect(result.assets).toEqual([{ assetId: 'synthetic-slide', error: expect.objectContaining({ code }), status: 'failed' }])
    for (const identifier of syntheticPatientIdentifiers) expect(JSON.stringify(result)).not.toContain(identifier)
    const recorded = await readAsset(catalogDirectory)
    expect(recorded.output).toBeUndefined()
    expect(recorded.source.series[0].instances).toBeUndefined()
    expect(await assetTree(assetDirectory)).toEqual([])
  })

  it('leaves no partial install when downloaded bytes do not match the catalog and repairs only from retained sources', async () => {
    const { assetDirectory, catalogDirectory, root } = await workspace()
    const { instances } = await slideInstances()
    await recordPathologyAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(instances) })

    const tampered = instances.map((instance, index) => index === 1
      ? { ...instance, bytes: Uint8Array.from(instance.bytes, (byte, offset) => offset === instance.bytes.byteLength - 20 ? byte ^ 0xff : byte) }
      : instance)
    const deployed = join(root, 'deployed')
    const calls: string[] = []
    expect((await syncPathologyAssets({ assetDirectory: deployed, catalogDirectory, sourceClient: sourceClient(tampered, calls) })).assets)
      .toEqual([{ assetId: 'synthetic-slide', error: expect.objectContaining({ code: 'IMAGING_SOURCE_HASH_MISMATCH' }), status: 'failed' }])
    // 同步只下载登记的组织层级实例，不再请求缩略图。
    expect(calls.toSorted()).toEqual(['2.25.7110', '2.25.7120'])
    expect(await assetTree(deployed)).toEqual([])
    expect(await verifyPathologyAssets({ assetDirectory: deployed, catalogDirectory }))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'missing' }] })

    // 安装目录被删除后，离线修复只依赖保留的来源；来源也缺失时报告失败而不是留下半套文件。
    await rm(join(assetDirectory, 'installed'), { recursive: true })
    expect(await repairPathologyAssets({ assetDirectory, catalogDirectory }))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'repaired' }] })
    await rm(join(assetDirectory, 'installed'), { recursive: true })
    await rm(join(assetDirectory, 'sources', 'synthetic-slide', '0', '2.25.7120.dcm'))
    expect((await repairPathologyAssets({ assetDirectory, catalogDirectory })).assets)
      .toEqual([{ assetId: 'synthetic-slide', error: expect.objectContaining({ code: 'IMAGING_SOURCE_MISSING' }), status: 'failed' }])
    expect(await listTree(assetDirectory)).not.toContain('installed/synthetic-slide')
  })

  it('runs record, verify, repair and check through the CLI entry with explicit directories', async () => {
    const { assetDirectory, catalogDirectory } = await workspace()
    const { instances } = await slideInstances()
    const directories = ['--catalog', catalogDirectory, '--asset-directory', assetDirectory]

    expect(await runPathologyAssetsCli(['record', ...directories], { environment: {}, sourceClient: sourceClient(instances) }))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'recorded' }] })
    expect(await runPathologyAssetsCli(['verify', ...directories, '--asset', 'synthetic-slide'], { environment: {} }))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'ready' }] })
    expect(await runPathologyAssetsCli(['repair', ...directories], { environment: {} }))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'repaired' }] })
    expect(await runPathologyAssetsCli(['sync'], {
      environment: { CLINMESH_PATHOLOGY_ASSET_DIRECTORY: assetDirectory, CLINMESH_PATHOLOGY_CATALOG_DIRECTORY: catalogDirectory },
      sourceClient: sourceClient(instances),
    })).toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'already-installed' }] })
    expect(await runPathologyAssetsCli(['check', ...directories], { environment: {} })).toEqual({
      assets: [{
        assetId: 'synthetic-slide',
        clinical: { er: 'positive', her2: 'negative', histologicType: '浸润性导管癌', pr: 'positive' },
        publishedRevisions: [],
        reasons: [{ code: 'REPORT_MISSING' }],
        reports: [],
        status: 'unpublished',
      }],
    })
    await expect(runPathologyAssetsCli(['review', ...directories], { environment: {} })).rejects.toThrow('--asset is required')
    await expect(runPathologyAssetsCli(['annotate', ...directories], { environment: {} })).rejects.toThrow()
  })
})
