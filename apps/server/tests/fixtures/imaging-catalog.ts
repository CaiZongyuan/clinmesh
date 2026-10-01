import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImagingCatalogAsset } from '../../src/infrastructure/imaging-assets/imaging-catalog.ts'
import { imagingReportContentSha256 } from '../../src/infrastructure/imaging-assets/imaging-report-check.ts'

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
