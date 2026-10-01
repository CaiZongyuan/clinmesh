import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runImagingAssetsCli } from '../src/imaging-assets-cli.ts'
import {
  openInstalledImagingAsset,
  recordImagingAssets,
  repairImagingAssets,
  syncImagingAssets,
  verifyImagingAssets,
  type ImagingSourceClient,
} from '../src/infrastructure/imaging-assets/imaging-asset-store.ts'
import {
  jpegBaseline,
  syntheticCtSlice,
  syntheticRadiograph,
} from './fixtures/imaging-dicom.ts'

const ctSeries = '2.25.1100'
const radiographSeries = '2.25.1200'
const wideRadiographSeries = '2.25.1300'

interface SourceInstance {
  bytes: Uint8Array
  sopInstanceUid: string
}

function sourceClient(series: Map<string, SourceInstance[]>, calls: string[] = []): ImagingSourceClient {
  return {
    async fetchInstance(reference) {
      calls.push(reference.sopInstanceUid)
      const instance = series.get(reference.seriesInstanceUid)
        ?.find(candidate => candidate.sopInstanceUid === reference.sopInstanceUid)
      if (instance === undefined) throw new Error(`unknown instance ${reference.sopInstanceUid}`)
      return instance.bytes
    },
    async listInstances(reference) {
      return (series.get(reference.seriesInstanceUid) ?? []).map(instance => instance.sopInstanceUid)
    },
  }
}

function ctInstances(overrides: {
  attributes?: Record<string, unknown>
  positions?: number[]
  transferSyntaxUid?: string
} = {}): SourceInstance[] {
  const positions = overrides.positions ?? [0, -160, -80]
  // 行方向指向患者右侧（-X），摄取后需要水平翻转成放射学显示方向。
  const pixelsByPosition = new Map<number, number[]>([
    [0, [1024, 1034, 1044, 1054, 1064, -2000]],
    [-80, [1124, 1134, 1144, 1154, 1164, 1174]],
    [-160, [24, 1024, 2024, 3024, 5024, 1024]],
  ])
  return positions.map((z, index) => {
    const sopInstanceUid = `2.25.110${index + 1}`
    return {
      bytes: syntheticCtSlice({
        attributes: overrides.attributes,
        imageOrientationPatient: [-1, 0, 0, 0, 1, 0],
        pixels: pixelsByPosition.get(z) ?? [0, 0, 0, 0, 0, 0],
        seriesInstanceUid: ctSeries,
        sopInstanceUid,
        transferSyntaxUid: overrides.transferSyntaxUid,
        z,
      }),
      sopInstanceUid,
    }
  })
}

function radiographInstances(attributes: Record<string, unknown> = {}): SourceInstance[] {
  return [{
    bytes: syntheticRadiograph({
      attributes,
      // 0xF064 的高位超出 BitsStored=12，应被屏蔽为 100。
      pixels: [0, 0xf064, 4095, 10, 20, 30],
      seriesInstanceUid: radiographSeries,
      sopInstanceUid: '2.25.1201',
    }),
    sopInstanceUid: '2.25.1201',
  }]
}

async function writeCatalog(directory: string, assets: Array<{
  assetId: string
  examCode: 'chest-ct-plain' | 'chest-radiograph'
  modality: 'CT' | 'DX'
  seriesInstanceUid: string
}>) {
  await mkdir(join(directory, 'assets'), { recursive: true })
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
    collections: [{
      attribution: 'Synthetic fixture collection',
      doi: '10.0000/synthetic',
      id: 'synthetic-collection',
      license: 'CC-BY-4.0',
      source: { kind: 'tcia-nbia' },
      title: 'Synthetic imaging fixture',
    }],
    packId: 'clinmesh-imaging-test',
    schemaVersion: 1,
  }, null, 2)}\n`)
  for (const asset of assets) {
    await writeFile(join(directory, 'assets', `${asset.assetId}.json`), `${JSON.stringify({
      assetId: asset.assetId,
      collectionId: 'synthetic-collection',
      examCode: asset.examCode,
      schemaVersion: 1,
      source: {
        series: [{ modality: asset.modality, seriesInstanceUid: asset.seriesInstanceUid }],
        studyInstanceUid: '2.25.9',
        subjectId: 'SYNTHETIC-0001',
      },
    }, null, 2)}\n`)
  }
}

function int16Values(bytes: Uint8Array): number[] {
  return Array.from(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
}

function uint16Values(bytes: Uint8Array): number[] {
  return Array.from(new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
}

async function listTree(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true }))
    .map(String)
    .toSorted()
}

describe('imaging asset pipeline', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), 'clinmesh-imaging-assets-'))
    temporaryDirectories.push(root)
    const catalogDirectory = join(root, 'catalog')
    await writeCatalog(catalogDirectory, [
      { assetId: 'synthetic-ct', examCode: 'chest-ct-plain', modality: 'CT', seriesInstanceUid: ctSeries },
      { assetId: 'synthetic-radiograph', examCode: 'chest-radiograph', modality: 'DX', seriesInstanceUid: radiographSeries },
    ])
    return { catalogDirectory, root }
  }

  it('records source and output hashes and installs canonical chest CT and radiograph pixels', async () => {
    const { catalogDirectory, root } = await workspace()
    const series = new Map([[ctSeries, ctInstances()], [radiographSeries, radiographInstances()]])
    const maintainerAssets = join(root, 'maintainer-assets')

    expect(await recordImagingAssets({
      assetDirectory: maintainerAssets,
      catalogDirectory,
      sourceClient: sourceClient(series),
    })).toEqual({
      assets: [
        { assetId: 'synthetic-ct', status: 'recorded' },
        { assetId: 'synthetic-radiograph', status: 'recorded' },
      ],
    })
    const recorded = JSON.parse(await readFile(join(catalogDirectory, 'assets', 'synthetic-ct.json'), 'utf8'))
    // 登记的实例顺序与安装后的帧顺序一致（从头到足），而不是来源返回的顺序。
    const [superior, inferior, middle] = ctInstances()
    expect(recorded.source.series[0].instances).toEqual([superior!, middle!, inferior!].map(instance => ({
      bytes: instance.bytes.byteLength,
      sha256: createHash('sha256').update(instance.bytes).digest('hex'),
      sopInstanceUid: instance.sopInstanceUid,
    })))
    expect(recorded.output).toMatchObject({
      series: [{ framesSha256: expect.stringMatching(/^[a-f0-9]{64}$/), geometrySha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      transcoderVersion: 1,
    })

    const deployedAssets = join(root, 'deployed-assets')
    expect(await syncImagingAssets({
      assetDirectory: deployedAssets,
      catalogDirectory,
      sourceClient: sourceClient(series),
    })).toEqual({
      assets: [
        { assetId: 'synthetic-ct', status: 'installed' },
        { assetId: 'synthetic-radiograph', status: 'installed' },
      ],
    })

    const ct = await openInstalledImagingAsset({ assetDirectory: deployedAssets, assetId: 'synthetic-ct' })
    expect(ct.series).toHaveLength(1)
    const [ctGeometry] = ct.series.map(item => item.geometry)
    expect(ctGeometry).toMatchObject({
      modality: 'CT',
      pixelFormat: 'int16',
      sliceOrder: 'superior-to-inferior',
      transform: { downsampleFactor: 1, flipHorizontal: true, flipVertical: false, inverted: false },
      valueUnit: 'hu',
    })
    expect(ctGeometry?.frames.map(frame => frame.positionMm)).toEqual([0, -80, -160])
    expect(ctGeometry?.frames[0]).toMatchObject({ columns: 3, pixelSpacingMm: [0.7, 0.8], rows: 2 })
    expect(int16Values(await ct.series[0]!.readBlock(0, 0))).toEqual([20, 10, 0, -1024, 40, 30])
    expect(int16Values(await ct.series[0]!.readBlock(1, 0))).toEqual([120, 110, 100, 150, 140, 130])
    // HU 超出显示范围的值被钳制到 [-1024, 3071]。
    expect(int16Values(await ct.series[0]!.readBlock(2, 0))).toEqual([1000, 0, -1000, 0, 3071, 2000])

    const radiograph = await openInstalledImagingAsset({ assetDirectory: deployedAssets, assetId: 'synthetic-radiograph' })
    expect(radiograph.series[0]?.geometry).toMatchObject({
      modality: 'DX',
      pixelFormat: 'uint16',
      transform: { downsampleFactor: 1, flipHorizontal: true, flipVertical: false, inverted: true },
      valueUnit: 'stored',
    })
    expect(radiograph.series[0]?.geometry.frames[0]).toMatchObject({
      columns: 3,
      rows: 2,
      view: 'frontal',
      viewPosition: 'PA',
      // 默认窗来自像素直方图分位数；来源声明的 WindowCenter/WindowWidth 不被采用。
      window: { center: 2048, width: 4095 },
    })
    expect(uint16Values(await radiograph.series[0]!.readBlock(0, 0))).toEqual([0, 3995, 4095, 4065, 4075, 4085])

    const maintainerCt = await openInstalledImagingAsset({ assetDirectory: maintainerAssets, assetId: 'synthetic-ct' })
    expect(await maintainerCt.series[0]!.readBlock(0, 0)).toEqual(await ct.series[0]!.readBlock(0, 0))
    expect(await syncImagingAssets({
      assetDirectory: deployedAssets,
      catalogDirectory,
      sourceClient: sourceClient(series),
    })).toEqual({
      assets: [
        { assetId: 'synthetic-ct', status: 'already-installed' },
        { assetId: 'synthetic-radiograph', status: 'already-installed' },
      ],
    })
  })

  it('orders radiograph frames by acquisition and records instances in frame order', async () => {
    const { catalogDirectory, root } = await workspace()
    await rm(join(catalogDirectory, 'assets', 'synthetic-ct.json'))
    const view = (sopInstanceUid: string, attributes: Record<string, unknown>) => ({
      bytes: syntheticRadiograph({
        attributes: { PhotometricInterpretation: 'MONOCHROME2', ...attributes },
        pixels: [1, 2, 3, 4, 5, 6],
        seriesInstanceUid: radiographSeries,
        sopInstanceUid,
      }),
      sopInstanceUid,
    })
    const series = new Map([[radiographSeries, [
      view('2.25.1201', { InstanceNumber: 2, PatientOrientation: ['P', 'F'], ViewPosition: 'LL' }),
      view('2.25.1202', { InstanceNumber: 1, PatientOrientation: ['L', 'F'], ViewPosition: 'W CHEST PA' }),
    ]]])
    const assetDirectory = join(root, 'assets')

    await recordImagingAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(series) })

    const asset = await openInstalledImagingAsset({ assetDirectory, assetId: 'synthetic-radiograph' })
    expect(asset.series[0]?.geometry.frames.map(frame => frame.view)).toEqual(['frontal', 'lateral'])
    // 设备自定义的投照体位文本不进入几何描述，只保留 DICOM 定义的取值。
    expect(asset.series[0]?.geometry.frames.map(frame => frame.viewPosition)).toEqual([undefined, 'LL'])
    const recorded = JSON.parse(await readFile(join(catalogDirectory, 'assets', 'synthetic-radiograph.json'), 'utf8'))
    expect(recorded.source.series[0].instances.map((instance: { sopInstanceUid: string }) => instance.sopInstanceUid))
      .toEqual(['2.25.1202', '2.25.1201'])
  })

  it('splits radiograph rows into bounded pixel blocks', async () => {
    const { catalogDirectory, root } = await workspace()
    await writeCatalog(catalogDirectory, [{
      assetId: 'synthetic-wide-radiograph',
      examCode: 'chest-radiograph',
      modality: 'DX',
      seriesInstanceUid: wideRadiographSeries,
    }])
    await rm(join(catalogDirectory, 'assets', 'synthetic-ct.json'))
    await rm(join(catalogDirectory, 'assets', 'synthetic-radiograph.json'))
    const pixels = new Uint16Array(600 * 2048).map((_, index) => index % 4096)
    const series = new Map([[wideRadiographSeries, [{
      bytes: syntheticRadiograph({
        attributes: { PatientOrientation: ['L', 'F'], PhotometricInterpretation: 'MONOCHROME2' },
        columns: 2048,
        pixels,
        rows: 600,
        seriesInstanceUid: wideRadiographSeries,
        sopInstanceUid: '2.25.1301',
      }),
      sopInstanceUid: '2.25.1301',
    }]]])
    const assetDirectory = join(root, 'assets')

    await recordImagingAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(series) })

    const asset = await openInstalledImagingAsset({ assetDirectory, assetId: 'synthetic-wide-radiograph' })
    expect(asset.series[0]?.geometry.frames[0]?.blocks.map(block => ({
      length: block.length,
      rowCount: block.rowCount,
      rowStart: block.rowStart,
    }))).toEqual([
      { length: 2 * 1024 * 1024, rowCount: 512, rowStart: 0 },
      { length: 88 * 2048 * 2, rowCount: 88, rowStart: 512 },
    ])
    const secondBlock = uint16Values(await asset.series[0]!.readBlock(0, 1))
    expect(secondBlock.slice(0, 3)).toEqual([(512 * 2048) % 4096, (512 * 2048 + 1) % 4096, (512 * 2048 + 2) % 4096])
  })

  it('detects damaged installs and repairs identical bytes only from retained sources', async () => {
    const { catalogDirectory, root } = await workspace()
    const series = new Map([[ctSeries, ctInstances()], [radiographSeries, radiographInstances()]])
    const assetDirectory = join(root, 'assets')
    await recordImagingAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(series) })
    const original = await openInstalledImagingAsset({ assetDirectory, assetId: 'synthetic-ct' })
    const originalBlock = await original.series[0]!.readBlock(1, 0)

    const framesPath = join(assetDirectory, 'installed', 'synthetic-ct', '0', 'frames.bin')
    const frames = await readFile(framesPath)
    frames[0] = frames[0]! ^ 0xff
    await writeFile(framesPath, frames)
    await rm(join(assetDirectory, 'installed', 'synthetic-radiograph', '0', 'series.json'))

    expect(await verifyImagingAssets({ assetDirectory, catalogDirectory })).toEqual({
      assets: [
        { assetId: 'synthetic-ct', status: 'corrupt' },
        { assetId: 'synthetic-radiograph', status: 'missing' },
      ],
    })

    expect(await repairImagingAssets({ assetDirectory, catalogDirectory, assetIds: ['synthetic-ct'] })).toEqual({
      assets: [{ assetId: 'synthetic-ct', status: 'repaired' }],
    })
    const repaired = await openInstalledImagingAsset({ assetDirectory, assetId: 'synthetic-ct' })
    expect(await repaired.series[0]!.readBlock(1, 0)).toEqual(originalBlock)

    await rm(join(assetDirectory, 'sources', 'synthetic-radiograph'), { recursive: true })
    expect(await repairImagingAssets({ assetDirectory, catalogDirectory, assetIds: ['synthetic-radiograph'] })).toEqual({
      assets: [{
        assetId: 'synthetic-radiograph',
        error: { code: 'IMAGING_SOURCE_MISSING', message: expect.any(String) },
        status: 'failed',
      }],
    })
    expect(await verifyImagingAssets({ assetDirectory, catalogDirectory })).toEqual({
      assets: [
        { assetId: 'synthetic-ct', status: 'ready' },
        { assetId: 'synthetic-radiograph', status: 'missing' },
      ],
    })
  })

  it('retries a transient download failure and gives up after three attempts', async () => {
    const { catalogDirectory, root } = await workspace()
    await rm(join(catalogDirectory, 'assets', 'synthetic-ct.json'))
    const reliable = sourceClient(new Map([[radiographSeries, radiographInstances()]]))
    let failures = 2
    const flaky: ImagingSourceClient = {
      ...reliable,
      async fetchInstance(reference) {
        if (failures > 0) {
          failures -= 1
          throw new Error('connection reset')
        }
        return await reliable.fetchInstance(reference)
      },
    }

    expect(await recordImagingAssets({ assetDirectory: join(root, 'assets'), catalogDirectory, sourceClient: flaky }))
      .toEqual({ assets: [{ assetId: 'synthetic-radiograph', status: 'recorded' }] })

    failures = 3
    expect(await syncImagingAssets({ assetDirectory: join(root, 'deployed'), catalogDirectory, sourceClient: flaky }))
      .toEqual({
        assets: [{
          assetId: 'synthetic-radiograph',
          error: { code: 'IMAGING_SOURCE_UNAVAILABLE', message: expect.stringContaining('connection reset') },
          status: 'failed',
        }],
      })
  })

  it('leaves no partial install when downloaded bytes do not match the catalog', async () => {
    const { catalogDirectory, root } = await workspace()
    const series = new Map([[ctSeries, ctInstances()], [radiographSeries, radiographInstances()]])
    await recordImagingAssets({ assetDirectory: join(root, 'maintainer'), catalogDirectory, sourceClient: sourceClient(series) })
    const tampered = new Map(series)
    tampered.set(ctSeries, ctInstances().map((instance, index) => index === 1
      ? { ...instance, bytes: Uint8Array.from([...instance.bytes.slice(0, -1), 7]) }
      : instance))
    const assetDirectory = join(root, 'deployed')

    expect(await syncImagingAssets({ assetDirectory, catalogDirectory, sourceClient: sourceClient(tampered) })).toEqual({
      assets: [
        {
          assetId: 'synthetic-ct',
          error: { code: 'IMAGING_SOURCE_HASH_MISMATCH', message: expect.any(String) },
          status: 'failed',
        },
        { assetId: 'synthetic-radiograph', status: 'installed' },
      ],
    })
    expect((await listTree(assetDirectory)).filter(path => (
      /^(installed|sources)\/synthetic-ct(\/|$)/.test(path) || /^\.staging\/./.test(path)
    ))).toEqual([])
    expect(await verifyImagingAssets({ assetDirectory, catalogDirectory })).toEqual({
      assets: [
        { assetId: 'synthetic-ct', status: 'missing' },
        { assetId: 'synthetic-radiograph', status: 'ready' },
      ],
    })
  })

  it.each([
    {
      code: 'IMAGING_TRANSFER_SYNTAX_UNSUPPORTED',
      instances: () => ctInstances({ transferSyntaxUid: jpegBaseline }),
      name: 'a compressed transfer syntax',
    },
    {
      code: 'IMAGING_CONTRAST_NOT_ALLOWED',
      instances: () => ctInstances({ attributes: { ContrastBolusAgent: 'IODINATED CONTRAST' } }),
      name: 'a contrast-enhanced chest CT',
    },
    {
      code: 'IMAGING_SERIES_NONCONTIGUOUS',
      instances: () => ctInstances({ positions: [0, -80, -400] }),
      name: 'a chest CT with a slice gap',
    },
  ])('rejects $name before recording or installing it', async ({ code, instances }) => {
    const { catalogDirectory, root } = await workspace()
    await rm(join(catalogDirectory, 'assets', 'synthetic-radiograph.json'))
    const assetDirectory = join(root, 'assets')

    expect(await recordImagingAssets({
      assetDirectory,
      catalogDirectory,
      sourceClient: sourceClient(new Map([[ctSeries, instances()]])),
    })).toEqual({
      assets: [{ assetId: 'synthetic-ct', error: { code, message: expect.any(String) }, status: 'failed' }],
    })
    expect(JSON.parse(await readFile(join(catalogDirectory, 'assets', 'synthetic-ct.json'), 'utf8')).output)
      .toBeUndefined()
    expect((await listTree(assetDirectory).catch(() => [])).filter(path => /^installed\/./.test(path)))
      .toEqual([])
  })

  it('runs record, verify and repair through the CLI entry with explicit directories', async () => {
    const { catalogDirectory, root } = await workspace()
    const series = new Map([[ctSeries, ctInstances()], [radiographSeries, radiographInstances()]])
    const directories = ['--catalog', catalogDirectory, '--asset-directory', join(root, 'assets')]
    const options = { environment: {}, sourceClient: sourceClient(series) }

    expect(await runImagingAssetsCli(['record', ...directories, '--asset', 'synthetic-ct'], options)).toEqual({
      assets: [{ assetId: 'synthetic-ct', status: 'recorded' }],
    })
    expect(await runImagingAssetsCli(['verify', ...directories], options)).toEqual({
      assets: [
        { assetId: 'synthetic-ct', status: 'ready' },
        { assetId: 'synthetic-radiograph', status: 'unrecorded' },
      ],
    })
    expect(await runImagingAssetsCli(['repair', ...directories, '--asset', 'synthetic-ct'], options)).toEqual({
      assets: [{ assetId: 'synthetic-ct', status: 'repaired' }],
    })
    await expect(runImagingAssetsCli(['sync', ...directories, '--url', 'https://example.test'], options))
      .rejects.toThrow('Invalid imaging assets CLI option')
    await expect(runImagingAssetsCli(['verify', ...directories, '--asset', 'unknown-asset'], options))
      .rejects.toThrow('unknown-asset')
  })

  it('derives source annotations for recorded assets and reports their publication state', async () => {
    const { catalogDirectory, root } = await workspace()
    const series = new Map([[ctSeries, ctInstances()], [radiographSeries, radiographInstances()]])
    const annotationDirectory = join(root, 'annotations')
    await mkdir(join(annotationDirectory, 'reads'), { recursive: true })
    // 一位读片者在 z=-80 的层面标了一个小于 3 mm 的结节；来源列 0 翻转后位于图像右侧，即患者左侧。
    await writeFile(join(annotationDirectory, 'reads', '001.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<LidcReadMessage xmlns="http://www.nih.gov"><ResponseHeader><SeriesInstanceUid>${ctSeries}</SeriesInstanceUid></ResponseHeader>
<readingSession><unblindedReadNodule><noduleID>1</noduleID><roi><imageZposition>-80.0</imageZposition>
<imageSOP_UID>2.25.1103</imageSOP_UID><inclusion>TRUE</inclusion><edgeMap><xCoord>0</xCoord><yCoord>1</yCoord></edgeMap>
</roi></unblindedReadNodule></readingSession></LidcReadMessage>`)
    const directories = ['--catalog', catalogDirectory, '--asset-directory', join(root, 'assets')]
    const options = { environment: {}, sourceClient: sourceClient(series) }
    await runImagingAssetsCli(['record', ...directories], options)

    expect(await runImagingAssetsCli(['annotate', ...directories, '--annotation-directory', annotationDirectory], options))
      .toEqual({
        assets: [
          { assetId: 'synthetic-ct', status: 'annotated' },
          {
            assetId: 'synthetic-radiograph',
            error: { code: 'IMAGING_ANNOTATION_INVALID', message: expect.any(String) },
            status: 'failed',
          },
        ],
      })
    const annotated = JSON.parse(await readFile(join(catalogDirectory, 'assets', 'synthetic-ct.json'), 'utf8'))
    expect(annotated.annotation).toMatchObject({
      kind: 'lidc-ct',
      nodules: [{ agreement: 1, frameIndex: 1, id: 'n1', side: 'left', sizeClass: 'under-3mm' }],
      readerCount: 1,
      source: { file: 'reads/001.xml' },
    })

    // 重新登记得到相同输出时保留标注；输出与此前登记的不同（转码规则变化）时标注作废。
    await runImagingAssetsCli(['record', ...directories, '--asset', 'synthetic-ct'], options)
    const rerecorded = JSON.parse(await readFile(join(catalogDirectory, 'assets', 'synthetic-ct.json'), 'utf8'))
    expect(rerecorded.annotation).toEqual(annotated.annotation)
    await writeFile(join(catalogDirectory, 'assets', 'synthetic-ct.json'), JSON.stringify({
      ...rerecorded,
      output: { ...rerecorded.output, transcoderVersion: 99 },
    }))
    await runImagingAssetsCli(['record', ...directories, '--asset', 'synthetic-ct'], options)
    const upgraded = JSON.parse(await readFile(join(catalogDirectory, 'assets', 'synthetic-ct.json'), 'utf8'))
    expect(upgraded.output).toEqual(rerecorded.output)
    expect(upgraded.annotation).toBeUndefined()

    expect(await runImagingAssetsCli(['check', ...directories], options)).toEqual({
      assets: [
        { assetId: 'synthetic-ct', publishedRevisions: [], reasons: [{ code: 'REPORT_MISSING' }], reports: [], status: 'unpublished' },
        {
          assetId: 'synthetic-radiograph',
          publishedRevisions: [],
          reasons: [{ code: 'REPORT_MISSING' }],
          reports: [],
          status: 'unpublished',
        },
      ],
    })
  })

  it('rejects a radiograph with burned-in annotation', async () => {
    const { catalogDirectory, root } = await workspace()
    await rm(join(catalogDirectory, 'assets', 'synthetic-ct.json'))

    expect(await recordImagingAssets({
      assetDirectory: join(root, 'assets'),
      catalogDirectory,
      sourceClient: sourceClient(new Map([[radiographSeries, radiographInstances({ BurnedInAnnotation: 'YES' })]])),
    })).toEqual({
      assets: [{
        assetId: 'synthetic-radiograph',
        error: { code: 'IMAGING_BURNED_IN_ANNOTATION', message: expect.any(String) },
        status: 'failed',
      }],
    })
  })
})
