import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  recordPathologyAssets,
  reviewPathologyAssets,
} from '../../src/infrastructure/imaging-assets/pathology-asset-store.ts'
import type { PathologyCatalogAssetEntry } from '../../src/infrastructure/imaging-assets/pathology-catalog.ts'
import {
  encodeJpegTile,
  jpegBaselineSyntax,
  syntheticSlideLevel,
  syntheticSlideStudyUid,
  syntheticTiles,
} from './pathology-dicom.ts'

/** 与固定版本 Synthea 乳腺癌模块导出的编码一致的适配规则。 */
export const syntheticPathologyMatching = {
  codeSystem: 'http://snomed.info/sct',
  facts: {
    'estrogen-receptor': { code: '85337-4', values: { negative: ['260385009'], positive: ['10828004'] } },
    'her2': { code: '85319-2', values: { negative: ['260385009'], positive: ['10828004'] } },
    'lymph-nodes': {
      code: '21906-3',
      values: { negative: ['1229967007'], positive: ['1229973008', '1229978004', '1229984001'] },
    },
    'progesterone-receptor': { code: '85339-0', values: { negative: ['260385009'], positive: ['10828004'] } },
    'tumor-category': {
      code: '21905-5',
      values: { T1: ['1228889001'], T2: ['1228929004'], T3: ['1228938002'], T4: ['1228944003'] },
    },
  },
  observationSystem: 'http://loinc.org',
  ruleVersion: 1,
  schemaVersion: 1,
  services: [{
    conditionCodes: ['254837009'],
    examCode: 'breast-slide-consultation',
    generationAgeRange: [45, 80],
    label: '乳腺切片会诊',
    profilePrefix: 'breast',
    sex: 'female',
    sourceProcedureCodes: ['392021009', '392023007'],
  }],
}

export interface SyntheticSlide {
  assetId: string
  /** 缺省为 ER 阳性、PR 阳性、HER2 阴性（FISH）、N1、T2 的浸润性导管癌。 */
  clinical?: {
    er?: 'Negative' | 'Positive'
    fish?: 'Negative' | 'Positive'
    histologicType?: 'Infiltrating Ductal Carcinoma' | 'Infiltrating Lobular Carcinoma'
    n?: string
    pr?: 'Negative' | 'Positive'
    t?: string
  }
  /** 缺省签署复核并发布；false 时保留未复核的报告草稿。 */
  published?: boolean
  /** 大于 1 时追加同一切片的后续已发布报告修订，供报告更正使用。 */
  reportRevisions?: number
}

const tileSize = 16
/** 原生 20 倍的合成切片：20 倍与 5 倍两个来源层级，摄取时派生 10 倍。 */
const levels = [
  { height: 25, micronsPerPixel: 0.5, scale: 1, width: 41 },
  { height: 6, micronsPerPixel: 2, scale: 4, width: 10 },
]

const zh = (status: string) => status === 'Positive' ? '阳性' : '阴性'

function report(slide: SyntheticSlide, revision: number) {
  const { er = 'Positive', fish = 'Negative', histologicType = 'Infiltrating Ductal Carcinoma', pr = 'Positive' } = slide.clinical ?? {}
  return {
    diagnosis: `乳腺${histologicType === 'Infiltrating Ductal Carcinoma' ? '浸润性导管癌' : '浸润性小叶癌'}。原始资料未提供组织学分级。`,
    draft: { model: 'synthetic-model', promptVersion: 'breast-pathology-report-v1' },
    immunohistochemistry: `以下结果引自原始病理资料，本次会诊未提供免疫组化切片。ER：${zh(er)}；PR：${zh(pr)}；HER2：${zh(fish)}（FISH ${zh(fish)}）。`,
    microscopy: revision === 1
      ? '送检切片为 HE 染色乳腺组织，见浸润性癌，浸润纤维间质。'
      : `送检切片为 HE 染色乳腺组织，见浸润性癌，浸润纤维间质（第 ${['一', '二', '三', '四'][revision - 1]} 次修订）。`,
    note: '本次会诊切片为原发灶组织，未包含淋巴结；淋巴结情况以原病例记录为准。',
    revision,
    specimen: { procedure: 'case-source-procedure' as const, slideCount: 1 as const, stain: 'HE' as const },
  }
}

/**
 * 重写一个完全合成的病理素材清单目录，并用合成 DICOM 经真实摄取流水线登记、安装切片，再按 `published` 签署复核。
 * `matching` 为 false 时不写适配规则。
 */
export async function installSyntheticPathologySlides(input: {
  assetDirectory: string
  catalogDirectory: string
  matching?: unknown
  slides: SyntheticSlide[]
}): Promise<void> {
  const { catalogDirectory } = input
  const seriesUid = (index: number) => `2.25.72${index}0`
  await rm(catalogDirectory, { force: true, recursive: true })
  await mkdir(join(catalogDirectory, 'assets'), { recursive: true })
  await mkdir(join(catalogDirectory, 'prompts'), { recursive: true })
  await writeFile(join(catalogDirectory, 'prompts', 'breast-pathology-report-v1.md'), '# Synthetic report prompt\n')
  await writeFile(join(catalogDirectory, 'manifest.json'), `${JSON.stringify({
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
  if (input.matching !== false) {
    await writeFile(
      join(catalogDirectory, 'matching.json'),
      `${JSON.stringify(input.matching ?? syntheticPathologyMatching, null, 2)}\n`,
    )
  }
  const assetPath = (assetId: string) => join(catalogDirectory, 'assets', `${assetId}.json`)
  for (const [index, slide] of input.slides.entries()) {
    const { er = 'Positive', fish = 'Negative', histologicType = 'Infiltrating Ductal Carcinoma', n = 'N1', pr = 'Positive', t = 'T2' } = slide.clinical ?? {}
    const entry: PathologyCatalogAssetEntry = {
      assetId: slide.assetId,
      clinical: {
        estrogenReceptor: er,
        her2: { fish },
        histologicType,
        pathologicN: n,
        pathologicT: t,
        progesteroneReceptor: pr,
        sampleId: `SYNTHETIC-SAMPLE-${index}`,
        sampleType: 'Primary Tumor',
        sex: 'female',
        sourceId: 'synthetic-clinical',
      },
      collectionId: 'synthetic-slides',
      reports: [report(slide, 1)],
      schemaVersion: 1,
      source: {
        series: [{ idcSeriesUuid: `11111111-2222-4333-8444-55555555555${index}`, seriesInstanceUid: seriesUid(index) }],
        slideId: `SYNTHETIC-SLIDE-${index}`,
        studyInstanceUid: syntheticSlideStudyUid,
        subjectId: `SYNTHETIC-SUBJECT-${index}`,
      },
    }
    await writeFile(assetPath(slide.assetId), `${JSON.stringify(entry, null, 2)}\n`)
  }

  const instances = new Map(input.slides.map((_, index) => [seriesUid(index), levels.map((level, levelIndex) => {
    const sopInstanceUid = `${seriesUid(index)}.${levelIndex + 1}`
    return {
      bytes: syntheticSlideLevel({
        // 每张切片的像素略有不同，瓦片哈希可以区分切片。
        frames: syntheticTiles(level.width, level.height, tileSize, level.scale + index * 0.01)
          .map(tile => encodeJpegTile(tile, tileSize)),
        height: level.height,
        imageType: levelIndex === 0 ? 'DERIVED\\PRIMARY\\VOLUME\\NONE' : 'DERIVED\\PRIMARY\\VOLUME\\RESAMPLED',
        micronsPerPixel: level.micronsPerPixel,
        photometric: 'YBR_FULL',
        seriesInstanceUid: seriesUid(index),
        sopInstanceUid,
        tileSize,
        transferSyntaxUid: jpegBaselineSyntax,
        width: level.width,
      }),
      sopInstanceUid,
    }
  })]))
  const recorded = await recordPathologyAssets({
    assetDirectory: input.assetDirectory,
    catalogDirectory,
    sourceClient: {
      async fetchInstance(reference) {
        const instance = instances.get(reference.seriesInstanceUid)
          ?.find(candidate => candidate.sopInstanceUid === reference.sopInstanceUid)
        if (instance === undefined) throw new Error(`unknown instance ${reference.sopInstanceUid}`)
        return instance.bytes
      },
      async listInstances(reference) {
        return instances.get(reference.seriesInstanceUid)?.map(instance => instance.sopInstanceUid) ?? []
      },
    },
  })
  const failed = recorded.assets.filter(asset => asset.status === 'failed')
  if (failed.length > 0) throw new Error(`Synthetic slides were not recorded: ${JSON.stringify(failed)}`)

  for (const slide of input.slides) {
    const revisions = slide.reportRevisions ?? 1
    if (revisions > 1) {
      const entry = JSON.parse(await readFile(assetPath(slide.assetId), 'utf8')) as PathologyCatalogAssetEntry
      entry.reports = Array.from({ length: revisions }, (_, index) => report(slide, index + 1))
      await writeFile(assetPath(slide.assetId), `${JSON.stringify(entry, null, 2)}\n`)
    }
    if (slide.published === false) continue
    for (let revision = 1; revision <= revisions; revision += 1) {
      const reviewed = await reviewPathologyAssets({
        assetDirectory: input.assetDirectory,
        assetIds: [slide.assetId],
        catalogDirectory,
        conclusion: 'approved',
        reviewer: 'Synthetic Reviewer',
        reviewerIsPathologist: false,
        revision,
      })
      if (reviewed.assets.some(asset => asset.status === 'failed')) {
        throw new Error(`Synthetic slide ${slide.assetId} was not reviewed: ${JSON.stringify(reviewed.assets)}`)
      }
    }
  }
}
