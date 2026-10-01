import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SeriesGeometry } from '../src/infrastructure/imaging-assets/dicom-canonical.ts'
import type { ImagingCatalogAsset } from '../src/infrastructure/imaging-assets/imaging-catalog.ts'
import {
  checkImagingReport,
  imagingAssetPublication,
  imagingReportCheckVersion,
  imagingReportContentSha256,
} from '../src/infrastructure/imaging-assets/imaging-report-check.ts'
import { lidcAnnotation } from '../src/infrastructure/imaging-assets/lidc-annotation.ts'

const ctSeries = '2.25.2100'
const radiographSeries = '2.25.2200'

function ctGeometry(): SeriesGeometry {
  return {
    frames: [0, -2.5, -5, -7.5].map((positionMm, index) => ({
      blocks: [{ length: 512 * 512 * 2, offset: index * 512 * 512 * 2, rowCount: 512, rowStart: 0 }],
      columns: 512,
      pixelSpacingMm: [0.5, 0.5] as [number, number],
      positionMm,
      rows: 512,
    })),
    modality: 'CT',
    pixelFormat: 'int16',
    schemaVersion: 1,
    sliceOrder: 'superior-to-inferior',
    transcoderVersion: 1,
    // 来源行方向指向患者右侧，安装时已水平翻转；标注坐标仍在来源像素网格中。
    transform: { downsampleFactor: 1, flipHorizontal: true, flipVertical: false, inverted: false },
    valueUnit: 'hu',
  }
}

function radiographGeometry(): SeriesGeometry {
  return {
    frames: [{
      blocks: [{ length: 1000 * 800 * 2, offset: 0, rowCount: 1000, rowStart: 0 }],
      columns: 800,
      pixelSpacingMm: [0.4, 0.4],
      rows: 1000,
      view: 'frontal',
      viewPosition: 'PA',
      window: { center: 2000, width: 4000 },
    }],
    modality: 'DX',
    pixelFormat: 'uint16',
    schemaVersion: 1,
    transcoderVersion: 1,
    transform: { downsampleFactor: 2, flipHorizontal: false, flipVertical: false, inverted: false },
    valueUnit: 'stored',
  }
}

function contour(z: number, points: Array<[number, number]>): string {
  return `<roi><imageZposition>${z}</imageZposition><imageSOP_UID>2.25.1</imageSOP_UID><inclusion>TRUE</inclusion>${
    points.map(([x, y]) => `<edgeMap><xCoord>${x}</xCoord><yCoord>${y}</yCoord></edgeMap>`).join('')
  }</roi>`
}

function largeNodule(id: string, texture: number, calcification: number, rois: string): string {
  return `<unblindedReadNodule><noduleID>${id}</noduleID><characteristics><subtlety>5</subtlety>`
    + `<internalStructure>1</internalStructure><calcification>${calcification}</calcification><sphericity>4</sphericity>`
    + `<margin>4</margin><lobulation>1</lobulation><spiculation>1</spiculation><texture>${texture}</texture>`
    + `<malignancy>3</malignancy></characteristics>${rois}</unblindedReadNodule>`
}

function smallNodule(id: string, z: number, x: number, y: number): string {
  return `<unblindedReadNodule><noduleID>${id}</noduleID>${contour(z, [[x, y]])}</unblindedReadNodule>`
}

function ctReadMessage(sessions: string[]): Uint8Array {
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<LidcReadMessage uid="2.25.3" xmlns="http://www.nih.gov">
 <ResponseHeader><Version>1.8.1</Version><SeriesInstanceUid>${ctSeries}</SeriesInstanceUid></ResponseHeader>
 ${sessions.map(session => `<readingSession><annotationVersion>3.12</annotationVersion>${session}</readingSession>`).join('\n')}
</LidcReadMessage>`)
}

function radiographReadMessage(sessions: Array<Array<{ confidence: number; id: string; subtlety?: number; x: number }>>) {
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<IdriReadMessage uid="2.25.4" xmlns="http://www.nih.gov/idri">
 <ResponseHeader><CTSeriesInstanceUid>${ctSeries}</CTSeriesInstanceUid>
 <CXRSeriesInstanceUid>${radiographSeries}</CXRSeriesInstanceUid></ResponseHeader>
 ${sessions.map(reads => `<CXRreadingSession><servicingRadiologistID>anonymous</servicingRadiologistID>${
    reads.map(read => `<unblindedRead><noduleID>${read.id}</noduleID><characteristics><confidence>${read.confidence}</confidence>${
      read.subtlety === undefined ? '' : `<subtlety>${read.subtlety}</subtlety><obscuration>1</obscuration>`
    }</characteristics><roi><imageSOP_UID>2.25.5</imageSOP_UID><edgeMap><xCoord>${read.x}</xCoord><yCoord>900</yCoord></edgeMap></roi></unblindedRead>`).join('')
  }</CXRreadingSession>`).join('\n')}
</IdriReadMessage>`)
}

const ctXml = ctReadMessage([
  // 读片者 1：一个实性结节（来源 x≈110，翻转后位于图像右半，即患者左侧）、一个微小结节、一个非结节标记。
  largeNodule('A1', 5, 6, contour(-2.5, [[100, 200], [120, 200], [110, 210], [110, 190]]) + contour(-5, [[105, 200], [115, 200]]))
  + smallNodule('A2', -5, 400, 300)
  + '<nonNodule><nonNoduleID>A9</nonNoduleID><imageZposition>-7.5</imageZposition><imageSOP_UID>2.25.1</imageSOP_UID>'
  + '<locus><xCoord>250</xCoord><yCoord>250</yCoord></locus></nonNodule>',
  // 读片者 2：同一实性结节轮廓略大、同一微小结节，另有一个只有自己标记的结节。
  largeNodule('B7', 4, 6, contour(-2.5, [[100, 200], [124, 200], [112, 208]]))
  + smallNodule('B8', -5, 402, 301)
  + largeNodule('B9', 1, 3, contour(-7.5, [[300, 100], [310, 100], [305, 108]])),
])

describe('LIDC source annotations', () => {
  it('merges reader marks into nodules located in the installed CT geometry', () => {
    expect(lidcAnnotation({
      fileName: 'tcia-lidc-xml/900/001.xml',
      geometry: ctGeometry(),
      seriesInstanceUid: ctSeries,
      sopInstanceUids: ['2.25.1'],
      xml: ctXml,
    })).toEqual({
      kind: 'lidc-ct',
      nodules: [
        {
          agreement: 2,
          calcified: false,
          frameIndex: 1,
          id: 'n1',
          longAxisMm: 11,
          side: 'left',
          sizeClass: '3mm-or-larger',
          texture: 'solid',
        },
        {
          agreement: 1,
          calcified: true,
          frameIndex: 3,
          id: 'n2',
          longAxisMm: 5,
          side: 'right',
          sizeClass: '3mm-or-larger',
          texture: 'ground-glass',
        },
        { agreement: 2, frameIndex: 2, id: 'n3', side: 'right', sizeClass: 'under-3mm' },
      ],
      nonNoduleMarks: 1,
      readerCount: 2,
      source: {
        file: 'tcia-lidc-xml/900/001.xml',
        sha256: createHash('sha256').update(ctXml).digest('hex'),
      },
    })
  })

  it('records per-reader radiograph visibility ratings for each marked nodule', () => {
    const xml = radiographReadMessage([
      [{ confidence: 3, id: 'N-1', subtlety: 5, x: 300 }, { confidence: 1, id: 'N-2', x: 1300 }],
      [{ confidence: 3, id: 'N-1', subtlety: 4, x: 310 }, { confidence: 1, id: 'N-2', x: 1310 }],
    ])

    expect(lidcAnnotation({
      fileName: 'tcia-lidc-xml/900/002.xml',
      geometry: radiographGeometry(),
      seriesInstanceUid: radiographSeries,
      sopInstanceUids: ['2.25.5'],
      xml,
    })).toEqual({
      kind: 'lidc-radiograph',
      nodules: [
        {
          id: 'n1',
          ratings: [{ confidence: 3, subtlety: 5 }, { confidence: 3, subtlety: 4 }],
          side: 'right',
          visibility: 'visible',
        },
        { id: 'n2', ratings: [{ confidence: 1 }, { confidence: 1 }], side: 'left', visibility: 'not-visible' },
      ],
      readerCount: 2,
      source: { file: 'tcia-lidc-xml/900/002.xml', sha256: createHash('sha256').update(xml).digest('hex') },
    })
  })

  it('marks radiograph visibility as indeterminate when readers disagree', () => {
    const annotation = lidcAnnotation({
      fileName: 'tcia-lidc-xml/900/003.xml',
      geometry: radiographGeometry(),
      seriesInstanceUid: radiographSeries,
      sopInstanceUids: ['2.25.5'],
      xml: radiographReadMessage([
        [{ confidence: 3, id: 'N-1', subtlety: 5, x: 300 }],
        [{ confidence: 2, id: 'N-1', subtlety: 2, x: 310 }],
      ]),
    })

    expect(annotation.nodules.map(nodule => 'visibility' in nodule && nodule.visibility)).toEqual(['indeterminate'])
  })

  it('rejects an annotation file that belongs to another series', () => {
    expect(() => lidcAnnotation({
      fileName: 'tcia-lidc-xml/900/001.xml',
      geometry: ctGeometry(),
      seriesInstanceUid: '2.25.9999',
      sopInstanceUids: ['2.25.1'],
      xml: ctXml,
    })).toThrow('2.25.9999')
  })
})

const output = {
  series: [{ framesBytes: 4 * 512 * 512 * 2, framesSha256: 'a'.repeat(64), geometrySha256: 'b'.repeat(64) }],
  transcoderVersion: 1,
}

function ctAsset(overrides: Partial<ImagingCatalogAsset> = {}): ImagingCatalogAsset {
  return {
    annotation: {
      kind: 'lidc-ct',
      nodules: [
        {
          agreement: 4,
          calcified: false,
          frameIndex: 57,
          id: 'n1',
          longAxisMm: 21.4,
          side: 'right',
          sizeClass: '3mm-or-larger',
          texture: 'solid',
        },
        { agreement: 3, frameIndex: 80, id: 'n2', side: 'left', sizeClass: 'under-3mm' },
        { agreement: 1, frameIndex: 90, id: 'n3', side: 'left', sizeClass: 'under-3mm' },
      ],
      nonNoduleMarks: 0,
      readerCount: 4,
      source: { file: 'tcia-lidc-xml/900/001.xml', sha256: 'c'.repeat(64) },
    },
    assetId: 'synthetic-ct',
    collectionId: 'synthetic-collection',
    examCode: 'chest-ct-plain',
    output,
    reports: [{
      draft: { model: 'synthetic-model', promptVersion: 'chest-report-v1' },
      findings: '右肺见一实性结节（Im 58），长径约 21 mm，未见钙化。左肺见一微小结节（Im 81），直径小于 3 mm。双侧胸腔未见积液。',
      impression: '右肺实性结节，长径约 21 mm，建议结合临床进一步检查。左肺微小结节，建议随访。',
      lesions: [
        { imageNumber: 58, longAxisMm: 21, noduleId: 'n1', side: 'right' },
        { imageNumber: 81, noduleId: 'n2', side: 'left' },
      ],
      revision: 1,
      technique: '胸部 CT 平扫，轴位，层厚 2.5 mm。',
    }],
    schemaVersion: 1,
    source: {
      series: [{
        instances: [{ bytes: 1, sha256: 'd'.repeat(64), sopInstanceUid: '2.25.2101' }],
        modality: 'CT',
        seriesInstanceUid: ctSeries,
      }],
      studyInstanceUid: '2.25.9',
      subjectId: 'SYNTHETIC-0001',
    },
    reviewScope: {
      collection: { doi: '10.0000/synthetic', id: 'synthetic-collection', license: 'CC-BY-4.0' },
      matchingProfiles: [],
      promptSha256: { 'chest-report-v1': 'e'.repeat(64) },
    },
    ...overrides,
  }
}

function withReport(asset: ImagingCatalogAsset, patch: Partial<NonNullable<ImagingCatalogAsset['reports']>[number]>) {
  return { ...asset, reports: [{ ...asset.reports![0]!, ...patch }] }
}

function issueCodes(asset: ImagingCatalogAsset): string[] {
  return checkImagingReport(asset, asset.reports![0]!).issues.map(issue => issue.code)
}

describe('imaging report consistency check', () => {
  it('accepts a report whose lesions and wording match the majority-marked source nodules', () => {
    expect(checkImagingReport(ctAsset(), ctAsset().reports![0]!)).toEqual({ checkVersion: imagingReportCheckVersion, issues: [] })
  })

  it.each([
    {
      code: 'REPORT_LESION_MISSING',
      name: 'a majority-marked nodule is not reported',
      patch: {
        findings: '右肺见一实性结节（Im 58），长径约 21 mm。',
        impression: '右肺实性结节，长径约 21 mm。',
        lesions: [{ imageNumber: 58, longAxisMm: 21, noduleId: 'n1', side: 'right' as const }],
      },
    },
    {
      code: 'REPORT_LESION_UNSUPPORTED',
      name: 'a nodule marked by a minority of readers is reported',
      patch: {
        lesions: [
          { imageNumber: 58, longAxisMm: 21, noduleId: 'n1', side: 'right' as const },
          { imageNumber: 81, noduleId: 'n2', side: 'left' as const },
          { imageNumber: 91, noduleId: 'n3', side: 'left' as const },
        ],
      },
    },
    {
      code: 'REPORT_SIZE_MISMATCH',
      name: 'the reported size differs from the annotated long axis',
      patch: {
        findings: '右肺见一实性结节（Im 58），长径约 25 mm。左肺见一微小结节（Im 81），直径小于 3 mm。',
        impression: '右肺实性结节，长径约 25 mm。左肺微小结节。',
        lesions: [
          { imageNumber: 58, longAxisMm: 25, noduleId: 'n1', side: 'right' as const },
          { imageNumber: 81, noduleId: 'n2', side: 'left' as const },
        ],
      },
    },
    {
      code: 'REPORT_SIDE_MISMATCH',
      name: 'the reported side differs from the annotation',
      patch: {
        lesions: [
          { imageNumber: 58, longAxisMm: 21, noduleId: 'n1', side: 'left' as const },
          { imageNumber: 81, noduleId: 'n2', side: 'left' as const },
        ],
      },
    },
    {
      code: 'REPORT_LOCATION_MISMATCH',
      name: 'the reported image number differs from the annotated frame',
      patch: {
        lesions: [
          { imageNumber: 40, longAxisMm: 21, noduleId: 'n1', side: 'right' as const },
          { imageNumber: 81, noduleId: 'n2', side: 'left' as const },
        ],
      },
    },
    {
      code: 'REPORT_TEXT_LESION_MISMATCH',
      name: 'the findings text places a lesion on the other side',
      patch: {
        findings: '左肺见一实性结节（Im 58），长径约 21 mm。左肺见一微小结节（Im 81），直径小于 3 mm。',
      },
    },
    {
      code: 'REPORT_TEXT_SIZE_UNSUPPORTED',
      name: 'the text states a size that no reported lesion has',
      patch: {
        findings: '右肺见一实性结节（Im 58），长径约 21 mm。左肺见一微小结节（Im 81），直径小于 3 mm。纵隔见淋巴结，短径约 12 mm。',
      },
    },
    {
      code: 'REPORT_IMPRESSION_MISMATCH',
      name: 'the impression does not name the lesion',
      patch: { impression: '胸部 CT 平扫未见明确异常。' },
    },
    {
      code: 'REPORT_LESION_DUPLICATE',
      name: 'a nodule is declared twice',
      patch: {
        lesions: [
          { imageNumber: 58, longAxisMm: 21, noduleId: 'n1', side: 'right' as const },
          { imageNumber: 58, longAxisMm: 21, noduleId: 'n1', side: 'right' as const },
          { imageNumber: 81, noduleId: 'n2', side: 'left' as const },
        ],
      },
    },
    {
      code: 'REPORT_COUNT_MISMATCH',
      name: 'the text states more lesions on a side than are declared',
      patch: {
        findings: '右肺见两枚实性结节（Im 58），长径约 21 mm。左肺见一微小结节（Im 81），直径小于 3 mm。',
      },
    },
    {
      code: 'REPORT_COUNT_MISMATCH',
      name: 'the text calls a single declared lesion multiple',
      patch: { impression: '右肺多发实性结节，长径约 21 mm。左肺微小结节，建议随访。' },
    },
    {
      code: 'REPORT_TEXT_UNSUPPORTED_FINDING',
      name: 'a clause adds a finding on the side without a declared lesion at that image',
      patch: {
        findings: '右肺见一实性结节（Im 58），长径约 21 mm，左肺下叶见斑点状钙化灶。左肺见一微小结节（Im 81），直径小于 3 mm。',
      },
    },
  ])('rejects a report when $name', ({ code, patch }) => {
    expect(issueCodes(withReport(ctAsset(), patch))).toContain(code)
  })

  it('rejects positive findings in the report of an asset without source nodules', () => {
    const negative = ctAsset({
      annotation: { ...ctAsset().annotation!, nodules: [] } as ImagingCatalogAsset['annotation'],
    })
    const clean = withReport(negative, {
      findings: '双肺纹理清晰，未见结节、肿块或实变影。双侧胸腔未见积液。',
      impression: '胸部 CT 平扫未见明确异常。',
      lesions: [],
    })
    expect(issueCodes(clean)).toEqual([])

    expect(issueCodes(withReport(negative, {
      findings: '右肺见一结节影。双侧胸腔未见积液。',
      impression: '右肺结节。',
      lesions: [],
    }))).toContain('REPORT_POSITIVE_FINDING_IN_NEGATIVE')
  })

  it.each([
    '双肺未见明确结节，右肺上叶见一肿块。',
    '胸廓对称无畸形，左肺下叶见结节。',
    '右肺下叶见斑点状钙化灶。',
    '右肺上叶见条索状高密度影。',
    '右肺见多发病灶。',
    '双肺未见结节而右肺见团块影。',
  ])('rejects the positive statement %s in a negative report', (findings) => {
    const negative = ctAsset({
      annotation: { ...ctAsset().annotation!, nodules: [] } as ImagingCatalogAsset['annotation'],
    })
    expect(issueCodes(withReport(negative, {
      findings,
      impression: '胸部 CT 平扫未见明确肺结节。',
      lesions: [],
    }))).toContain('REPORT_POSITIVE_FINDING_IN_NEGATIVE')
  })

  it('compares sizes stated in centimetres without floating point drift', () => {
    const annotation = ctAsset().annotation as Extract<ImagingCatalogAsset['annotation'], { kind: 'lidc-ct' }>
    const asset = ctAsset({
      annotation: { ...annotation, nodules: [{ ...annotation.nodules[0]!, longAxisMm: 11.2 }, ...annotation.nodules.slice(1)] },
    })
    expect(issueCodes(withReport(asset, {
      findings: '右肺见一实性结节（Im 58），长径约 1.1 cm，未见钙化。左肺见一微小结节（Im 81），直径小于 3 mm。',
      impression: '右肺实性结节，长径约 1.1 cm。左肺微小结节，建议随访。',
      lesions: [
        { imageNumber: 58, longAxisMm: 11, noduleId: 'n1', side: 'right' },
        { imageNumber: 81, noduleId: 'n2', side: 'left' },
      ],
    }))).toEqual([])
  })

  it('rejects any report when the source annotation is indeterminate', () => {
    const indeterminate = ctAsset({
      annotation: {
        ...ctAsset().annotation!,
        nodules: [{ agreement: 2, frameIndex: 90, id: 'n1', side: 'left', sizeClass: 'under-3mm' }],
      } as ImagingCatalogAsset['annotation'],
    })
    expect(issueCodes(withReport(indeterminate, {
      findings: '双肺未见结节。',
      impression: '未见明确异常。',
      lesions: [],
    }))).toContain('ANNOTATION_INDETERMINATE')
  })

  it('checks radiograph reports against reader visibility', () => {
    const radiograph: ImagingCatalogAsset = {
      ...ctAsset(),
      annotation: {
        kind: 'lidc-radiograph',
        nodules: [
          { id: 'n1', ratings: [{ confidence: 3, subtlety: 5 }], side: 'right', visibility: 'visible' },
          { id: 'n2', ratings: [{ confidence: 1 }], side: 'left', visibility: 'not-visible' },
        ],
        readerCount: 1,
        source: { file: 'tcia-lidc-xml/900/002.xml', sha256: 'c'.repeat(64) },
      },
      assetId: 'synthetic-radiograph',
      examCode: 'chest-radiograph',
      reports: [{
        draft: { model: 'synthetic-model', promptVersion: 'chest-report-v1' },
        findings: '右肺见结节状致密影。左肺未见明确结节或实变影。双侧肋膈角锐利。',
        impression: '右肺结节影，建议胸部 CT 进一步检查。',
        lesions: [{ noduleId: 'n1', side: 'right' }],
        revision: 1,
        technique: '胸部正位片。',
      }],
    }
    expect(issueCodes(radiograph)).toEqual([])
    expect(issueCodes(withReport(radiograph, {
      lesions: [{ noduleId: 'n1', side: 'right' }, { noduleId: 'n2', side: 'left' }],
    }))).toContain('REPORT_LESION_UNSUPPORTED')
  })
})

describe('imaging asset publication gate', () => {
  function reviewed(asset: ImagingCatalogAsset, patch: Record<string, unknown> = {}): ImagingCatalogAsset {
    const report = asset.reports![0]!
    return withReport(asset, {
      review: {
        automatedCheck: { checkVersion: imagingReportCheckVersion, passed: true },
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
        ...patch,
      } as NonNullable<NonNullable<ImagingCatalogAsset['reports']>[number]['review']>,
    })
  }

  it('publishes only reviewed revisions whose content is unchanged and passes the automated check', () => {
    expect(imagingAssetPublication(ctAsset())).toEqual({
      publishedRevisions: [],
      reasons: [{ code: 'REVIEW_MISSING', revision: 1 }],
    })
    expect(imagingAssetPublication(reviewed(ctAsset()))).toEqual({ publishedRevisions: [1], reasons: [] })
    expect(imagingAssetPublication(reviewed(ctAsset(), { conclusion: 'rejected' }))).toEqual({
      publishedRevisions: [],
      reasons: [{ code: 'REVIEW_NOT_APPROVED', revision: 1 }],
    })
    expect(imagingAssetPublication(reviewed(ctAsset(), {
      items: [{ conclusion: 'confirmed', item: 'exam-and-orientation' }],
    }))).toEqual({
      publishedRevisions: [],
      reasons: [{ code: 'REVIEW_INCOMPLETE', revision: 1 }],
    })
  })

  it('withdraws publication when the report changes after review or the asset is not recorded', () => {
    const approved = reviewed(ctAsset())
    const edited = withReport(approved, { impression: '右肺实性结节，长径约 21 mm。左肺微小结节。' })
    expect(imagingAssetPublication(edited)).toEqual({
      publishedRevisions: [],
      reasons: [{ code: 'REVIEW_STALE', revision: 1 }],
    })

    const failing = reviewed(withReport(ctAsset(), { impression: '未见明确异常。' }))
    expect(imagingAssetPublication(failing)).toEqual({
      publishedRevisions: [],
      reasons: [{ code: 'AUTOMATED_CHECK_FAILED', revision: 1 }],
    })

    const { output: _output, ...unrecorded } = approved
    expect(imagingAssetPublication(unrecorded)).toEqual({
      publishedRevisions: [],
      reasons: [{ code: 'ASSET_UNRECORDED' }],
    })
  })

  it.each([
    {
      name: 'a source instance hash',
      patch: (asset: ImagingCatalogAsset): ImagingCatalogAsset => ({
        ...asset,
        source: {
          ...asset.source,
          series: [{ ...asset.source.series[0]!, instances: [{ bytes: 1, sha256: 'f'.repeat(64), sopInstanceUid: '2.25.2101' }] }],
        },
      }),
    },
    {
      name: 'the collection licence',
      patch: (asset: ImagingCatalogAsset): ImagingCatalogAsset => ({
        ...asset,
        reviewScope: { ...asset.reviewScope, collection: { ...asset.reviewScope.collection, license: 'CC-BY-NC-4.0' } },
      }),
    },
    {
      name: 'the prompt file',
      patch: (asset: ImagingCatalogAsset): ImagingCatalogAsset => ({
        ...asset,
        reviewScope: { ...asset.reviewScope, promptSha256: { 'chest-report-v1': 'f'.repeat(64) } },
      }),
    },
    {
      name: 'a matching profile that uses the asset',
      patch: (asset: ImagingCatalogAsset): ImagingCatalogAsset => ({
        ...asset,
        reviewScope: {
          ...asset.reviewScope,
          matchingProfiles: [{
            ageRange: [40, 79],
            assets: { 'chest-ct-plain': asset.assetId },
            conditionCodes: ['162573006'],
            conflictProcedureCodes: [],
            finding: 'positive',
            id: 'synthetic-profile',
            label: 'Synthetic profile',
          }],
        },
      }),
    },
  ])('withdraws publication when $name changes after review', ({ patch }) => {
    expect(imagingAssetPublication(patch(reviewed(ctAsset())))).toEqual({
      publishedRevisions: [],
      reasons: [{ code: 'REVIEW_STALE', revision: 1 }],
    })
  })
})
