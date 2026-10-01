import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recordImagingAssets } from '../../src/infrastructure/imaging-assets/imaging-asset-store.ts'
import {
  loadImagingCatalog,
  writeImagingCatalogAsset,
  type ImagingCatalogAsset,
} from '../../src/infrastructure/imaging-assets/imaging-catalog.ts'
import { imagingReportContentSha256 } from '../../src/infrastructure/imaging-assets/imaging-report-check.ts'
import { syntheticCtSlice, syntheticRadiograph } from './imaging-dicom.ts'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 不含像素的合成素材条目：阴性标注、通过自动检查的报告；`published` 为 false 时不带复核记录。 */
export function syntheticCatalogAsset(input: {
  assetId: string
  examCode: ImagingCatalogAsset['examCode']
  published?: boolean
}): ImagingCatalogAsset {
  const computed = input.examCode === 'chest-ct-plain'
  const asset: ImagingCatalogAsset = {
    annotation: computed
      ? {
          kind: 'lidc-ct',
          nodules: [],
          nonNoduleMarks: 0,
          readerCount: 4,
          source: { file: `reads/${input.assetId}.xml`, sha256: sha256(`annotation:${input.assetId}`) },
        }
      : {
          kind: 'lidc-radiograph',
          nodules: [],
          readerCount: 4,
          source: { file: `reads/${input.assetId}.xml`, sha256: sha256(`annotation:${input.assetId}`) },
        },
    assetId: input.assetId,
    collectionId: 'synthetic-collection',
    examCode: input.examCode,
    output: {
      series: [{
        framesBytes: 12,
        framesSha256: sha256(`frames:${input.assetId}`),
        geometrySha256: sha256(`geometry:${input.assetId}`),
      }],
      transcoderVersion: 1,
    },
    reports: [{
      draft: { model: 'synthetic-model', promptVersion: 'chest-report-v1' },
      findings: computed ? '双肺未见明确结节。' : '双肺野未见明确结节影。',
      impression: computed ? '胸部 CT 平扫未见明确肺结节。' : '胸片未见明确肺结节影。',
      lesions: [],
      revision: 1,
      technique: computed ? '胸部 CT 平扫，轴位。' : '胸部正位片。',
    }],
    schemaVersion: 1,
    source: {
      series: [{
        instances: [{ bytes: 1, sha256: sha256(`instance:${input.assetId}`), sopInstanceUid: '2.25.3101' }],
        modality: computed ? 'CT' : 'DX',
        seriesInstanceUid: '2.25.3100',
      }],
      studyInstanceUid: '2.25.3000',
      subjectId: 'SYNTHETIC-0001',
    },
  }
  if (input.published === false) return asset
  const report = asset.reports![0]!
  return {
    ...asset,
    reports: [{
      ...report,
      review: {
        automatedCheck: { checkVersion: 1, passed: true },
        conclusion: 'approved',
        contentSha256: imagingReportContentSha256(asset, report),
        items: [
          { conclusion: 'confirmed', item: 'exam-and-orientation' },
          { conclusion: 'confirmed', item: 'no-identifying-content' },
          { conclusion: 'confirmed', item: 'findings-match-pixels' },
          { conclusion: 'confirmed', item: 'report-wording' },
          { conclusion: 'confirmed', item: 'plain-scan' },
        ],
        reviewedAt: '2026-10-01',
        reviewer: 'synthetic-maintainer',
        reviewerIsRadiologist: false,
      },
    }],
  }
}

/** 重写一个完全合成的素材清单目录：合集、素材条目和可选的适配规则。 */
export async function writeSyntheticImagingCatalog(directory: string, input: {
  assets: ImagingCatalogAsset[]
  matching?: unknown
}): Promise<void> {
  await rm(directory, { force: true, recursive: true })
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
  for (const asset of input.assets) {
    await writeFile(join(directory, 'assets', `${asset.assetId}.json`), `${JSON.stringify(asset, null, 2)}\n`)
  }
  if (input.matching !== undefined) {
    await writeFile(join(directory, 'matching.json'), `${JSON.stringify(input.matching, null, 2)}\n`)
  }
}

const reviewItems = [
  'exam-and-orientation',
  'no-identifying-content',
  'findings-match-pixels',
  'report-wording',
  'plain-scan',
] as const

/**
 * 用合成 DICOM 经真实摄取流水线登记并安装素材，再补上阴性标注、报告修订和复核记录。
 * `reportRevisions` 大于 1 时追加同一素材的后续已发布报告修订，供报告更正使用。
 */
export async function installSyntheticImagingAssets(input: {
  assetDirectory: string
  assets: Array<{
    assetId: string
    examCode: ImagingCatalogAsset['examCode']
    published?: boolean
    reportRevisions?: number
  }>
  catalogDirectory: string
  matching?: unknown
}): Promise<void> {
  const seriesUid = (index: number) => `2.25.41${index}0`
  await writeSyntheticImagingCatalog(input.catalogDirectory, {
    assets: input.assets.map((asset, index) => ({
      assetId: asset.assetId,
      collectionId: 'synthetic-collection',
      examCode: asset.examCode,
      schemaVersion: 1 as const,
      source: {
        series: [{
          modality: asset.examCode === 'chest-ct-plain' ? 'CT' as const : 'DX' as const,
          seriesInstanceUid: seriesUid(index),
        }],
        studyInstanceUid: '2.25.4000',
        subjectId: 'SYNTHETIC-0001',
      },
    })),
  })
  const instances = new Map(input.assets.map((asset, index) => [seriesUid(index), asset.examCode === 'chest-ct-plain'
    ? [0, -80, -160].map((z, slice) => ({
        bytes: syntheticCtSlice({
          pixels: [1024, 1034, 1044, 1054, 1064, 1074].map(value => value + index + slice),
          seriesInstanceUid: seriesUid(index),
          sopInstanceUid: `${seriesUid(index)}.${slice + 1}`,
          z,
        }),
        sopInstanceUid: `${seriesUid(index)}.${slice + 1}`,
      }))
    : [{
        bytes: syntheticRadiograph({
          pixels: [0, 100, 4095, 10, 20, 30].map(value => Math.min(4095, value + index)),
          seriesInstanceUid: seriesUid(index),
          sopInstanceUid: `${seriesUid(index)}.1`,
        }),
        sopInstanceUid: `${seriesUid(index)}.1`,
      }]]))
  const recorded = await recordImagingAssets({
    assetDirectory: input.assetDirectory,
    catalogDirectory: input.catalogDirectory,
    sourceClient: {
      fetchInstance: async reference => instances.get(reference.seriesInstanceUid)!
        .find(instance => instance.sopInstanceUid === reference.sopInstanceUid)!.bytes,
      listInstances: async reference => instances.get(reference.seriesInstanceUid)!.map(instance => instance.sopInstanceUid),
    },
  })
  if (recorded.assets.some(asset => asset.status !== 'recorded')) {
    throw new Error(`Synthetic imaging assets could not be recorded: ${JSON.stringify(recorded.assets)}`)
  }
  const catalog = await loadImagingCatalog(input.catalogDirectory)
  for (const recordedAsset of catalog.assets) {
    const options = input.assets.find(asset => asset.assetId === recordedAsset.assetId)!
    const template = syntheticCatalogAsset({ assetId: options.assetId, examCode: options.examCode, published: false })
    const reports = Array.from({ length: options.reportRevisions ?? 1 }, (_, index) => ({
      ...template.reports![0]!,
      // 后续修订只改措辞，仍与阴性标注一致。
      ...(index === 0 ? {} : { impression: `${template.reports![0]!.impression}（第 ${index + 1} 版措辞）` }),
      revision: index + 1,
    }))
    const asset: ImagingCatalogAsset = { ...recordedAsset, annotation: template.annotation, reports }
    await writeImagingCatalogAsset(input.catalogDirectory, options.published === false
      ? asset
      : {
          ...asset,
          reports: reports.map(report => ({
            ...report,
            review: {
              automatedCheck: { checkVersion: 1, passed: true },
              conclusion: 'approved' as const,
              contentSha256: imagingReportContentSha256(asset, report),
              items: reviewItems.map(item => ({ conclusion: 'confirmed' as const, item })),
              reviewedAt: '2026-10-01',
              reviewer: 'synthetic-maintainer',
              reviewerIsRadiologist: false,
            },
          })),
        })
  }
  if (input.matching !== undefined) {
    await writeFile(join(input.catalogDirectory, 'matching.json'), `${JSON.stringify(input.matching, null, 2)}\n`)
  }
}
