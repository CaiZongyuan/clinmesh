import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPathologyCatalogDirectory } from '../src/config.ts'
import { checkPathologyAssets, reviewPathologyAssets } from '../src/infrastructure/imaging-assets/pathology-asset-store.ts'
import {
  loadPathologyCatalog,
  type PathologyCatalogAssetEntry,
  type PathologyClinicalFields,
  type PathologyReportRevision,
} from '../src/infrastructure/imaging-assets/pathology-catalog.ts'
import {
  checkPathologyReport,
  pathologyClinicalStatus,
  pathologyReportCheckVersion,
} from '../src/infrastructure/imaging-assets/pathology-report-check.ts'
import { pathologyIngestParameters } from '../src/infrastructure/imaging-assets/pathology-slide.ts'

const digest = (character: string) => character.repeat(64)

function clinical(overrides: Partial<PathologyClinicalFields> = {}): PathologyClinicalFields {
  return {
    estrogenReceptor: 'Positive',
    her2: { fish: 'Negative' },
    histologicType: 'Infiltrating Ductal Carcinoma',
    pathologicN: 'N1',
    pathologicT: 'T2',
    progesteroneReceptor: 'Negative',
    sampleId: 'SYNTHETIC-SAMPLE-01',
    sampleType: 'Primary Tumor',
    sex: 'female',
    sourceId: 'synthetic-clinical',
    ...overrides,
  }
}

function report(overrides: Partial<PathologyReportRevision> = {}): PathologyReportRevision {
  return {
    diagnosis: '乳腺浸润性导管癌（浸润性癌，非特殊类型）。原始资料未提供组织学分级。',
    draft: { model: 'synthetic-model', promptVersion: 'breast-pathology-report-v1' },
    immunohistochemistry: '以下结果引自原始病理资料，本次会诊未提供免疫组化切片。ER：阳性；PR：阴性；HER2：阴性（FISH 阴性）。',
    microscopy: '送检切片为 HE 染色乳腺组织，见浸润性癌，癌细胞呈巢状、条索状或腺管样排列，浸润纤维间质。',
    note: '本次会诊切片为原发灶组织，未包含淋巴结；淋巴结情况以原病例记录为准。',
    revision: 1,
    specimen: { procedure: 'case-source-procedure', slideCount: 1, stain: 'HE' },
    ...overrides,
  }
}

function asset(overrides: Partial<PathologyCatalogAssetEntry> = {}): PathologyCatalogAssetEntry {
  const level = {
    height: 25,
    index: { bytes: 56, sha256: digest('a') },
    magnification: 20,
    micronsPerPixel: 0.5,
    origin: { kind: 'source' as const, sourceCodec: 'jpeg-baseline' as const, sourceInstance: 0, tiles: 'copied' as const },
    tileHeight: 16,
    tileWidth: 16,
    tiles: { bytes: 4000, count: 6, largestBytes: 800, sha256: digest('b') },
    width: 41,
  }
  return {
    assetId: 'synthetic-slide',
    clinical: clinical(),
    collectionId: 'synthetic-slides',
    output: { ingestVersion: 1, levels: [level], parameters: pathologyIngestParameters },
    reports: [report()],
    schemaVersion: 1,
    source: {
      series: [{
        idcSeriesUuid: '11111111-2222-4333-8444-555555555555',
        instances: [{ bytes: 5000, sha256: digest('c'), sopInstanceUid: '2.25.7110' }],
        seriesInstanceUid: '2.25.7100',
      }],
      slideId: 'SYNTHETIC-SLIDE-01',
      studyInstanceUid: '2.25.7000',
      subjectId: 'SYNTHETIC-SUBJECT-01',
    },
    ...overrides,
  }
}

function issueCodes(entry: PathologyCatalogAssetEntry, revision: PathologyReportRevision): string[] {
  return [...new Set(checkPathologyReport(entry, revision).issues.map(issue => issue.code))]
}

describe('pathology clinical fields', () => {
  it.each([
    { her2: { ihcScore: '3+' }, status: 'positive' },
    { her2: { fish: 'Positive' }, status: 'positive' },
    { her2: { fish: 'Positive', ihcScore: '2+' }, status: 'positive' },
    { her2: { finalStatus: 'Positive', fish: 'Positive', ihcScore: '3+', ihcStatus: 'Positive' }, status: 'positive' },
    { her2: { ihcScore: '0' }, status: 'negative' },
    { her2: { ihcScore: '1+' }, status: 'negative' },
    { her2: { ihcStatus: 'Negative' }, status: 'negative' },
    { her2: { fish: 'Negative', ihcScore: '2+' }, status: 'negative' },
    { her2: { fish: 'Negative' }, status: 'negative' },
  ])('derives HER2 $status from $her2', ({ her2, status }) => {
    expect(pathologyClinicalStatus(clinical({ her2 }))).toMatchObject({ her2: status, issues: [] })
  })

  it.each([
    { code: 'CLINICAL_HER2_CONTRADICTORY', her2: { fish: 'Negative', ihcScore: '3+' } },
    { code: 'CLINICAL_HER2_CONTRADICTORY', her2: { fish: 'Positive', ihcScore: '1+' } },
    { code: 'CLINICAL_HER2_CONTRADICTORY', her2: { ihcScore: '3+', ihcStatus: 'Negative' } },
    { code: 'CLINICAL_HER2_CONTRADICTORY', her2: { finalStatus: 'Negative', fish: 'Positive' } },
    { code: 'CLINICAL_HER2_CONTRADICTORY', her2: { ihcScore: '4+' } },
    { code: 'CLINICAL_HER2_UNDETERMINED', her2: {} },
    { code: 'CLINICAL_HER2_UNDETERMINED', her2: { ihcScore: '2+' } },
    { code: 'CLINICAL_HER2_UNDETERMINED', her2: { fish: 'Equivocal', ihcStatus: 'Equivocal' } },
  ])('refuses to derive HER2 from $her2', ({ code, her2 }) => {
    const status = pathologyClinicalStatus(clinical({ her2 }))
    expect(status.her2).toBeUndefined()
    expect(status.issues.map(issue => issue.code)).toEqual([code])
    // 字段矛盾或无法判定的素材，任何报告都不能通过自动检查。
    expect(issueCodes(asset({ clinical: clinical({ her2 }) }), report())).toContain(code)
  })

  it('requires definite ER and PR statuses and a supported histologic type', () => {
    const { estrogenReceptor: _estrogenReceptor, ...withoutEr } = clinical()
    expect(pathologyClinicalStatus(withoutEr).issues.map(issue => issue.code)).toEqual(['CLINICAL_RECEPTOR_MISSING'])
    expect(pathologyClinicalStatus(clinical({ progesteroneReceptor: 'Indeterminate' })).issues.map(issue => issue.code))
      .toEqual(['CLINICAL_RECEPTOR_MISSING'])
    expect(pathologyClinicalStatus(clinical({ histologicType: 'Mucinous Carcinoma' })).issues.map(issue => issue.code))
      .toEqual(['CLINICAL_HISTOLOGIC_TYPE_UNSUPPORTED'])
    expect(pathologyClinicalStatus(clinical({ histologicType: 'Infiltrating Lobular Carcinoma' })))
      .toEqual({ er: 'positive', her2: 'negative', histologicType: '浸润性小叶癌', issues: [], pr: 'negative' })
  })
})

describe('pathology report check', () => {
  it('accepts a draft that restates only the source fields', () => {
    expect(checkPathologyReport(asset(), report())).toEqual({ checkVersion: pathologyReportCheckVersion, issues: [] })
    expect(checkPathologyReport(
      asset({ clinical: clinical({ estrogenReceptor: 'Negative', her2: { fish: 'Positive', ihcScore: '3+', ihcStatus: 'Positive' }, histologicType: 'Infiltrating Lobular Carcinoma' }) }),
      report({
        diagnosis: '乳腺浸润性小叶癌。原始资料未提供组织学分级。',
        immunohistochemistry: '以下结果引自原始病理资料，本次会诊未提供免疫组化切片。ER：阴性；PR：阴性；HER2：阳性（IHC 3+，FISH 阳性）。',
        microscopy: '送检切片为 HE 染色乳腺组织，见浸润性癌，癌细胞黏附性差，呈单行条索状排列或散在浸润纤维间质。',
      }),
    ).issues).toEqual([])
  })

  const base = report()
  it.each([
    { code: 'REPORT_HISTOLOGIC_TYPE_MISMATCH', name: 'another histologic type', overrides: { diagnosis: '乳腺浸润性小叶癌。原始资料未提供组织学分级。' } },
    { code: 'REPORT_HISTOLOGIC_TYPE_MISMATCH', name: 'an in situ component', overrides: { microscopy: `${base.microscopy}伴导管原位癌。` } },
    { code: 'REPORT_GRADE_CLAIMED', name: 'a histologic grade', overrides: { diagnosis: `乳腺浸润性导管癌，组织学 II 级。${base.diagnosis}` } },
    { code: 'REPORT_GRADE_CLAIMED', name: 'a differentiation claim', overrides: { diagnosis: `${base.diagnosis}中分化。` } },
    { code: 'REPORT_GRADE_CLAIMED', name: 'a mitotic count', overrides: { microscopy: `${base.microscopy}核分裂象易见。` } },
    { code: 'REPORT_GRADE_STATEMENT_MISSING', name: 'no statement that the source has no grade', overrides: { diagnosis: '乳腺浸润性导管癌（浸润性癌，非特殊类型）。' } },
    { code: 'REPORT_RECEPTOR_MISMATCH', name: 'a flipped ER status', overrides: { immunohistochemistry: base.immunohistochemistry.replace('ER：阳性', 'ER：阴性') } },
    { code: 'REPORT_RECEPTOR_MISMATCH', name: 'a flipped HER2 status', overrides: { immunohistochemistry: base.immunohistochemistry.replace('HER2：阴性', 'HER2：阳性') } },
    { code: 'REPORT_RECEPTOR_MISMATCH', name: 'a missing PR status', overrides: { immunohistochemistry: base.immunohistochemistry.replace('PR：阴性；', '') } },
    { code: 'REPORT_RECEPTOR_MISMATCH', name: 'a FISH result the source does not have', overrides: { immunohistochemistry: base.immunohistochemistry.replace('FISH 阴性', 'FISH 阳性') } },
    { code: 'REPORT_RECEPTOR_MISMATCH', name: 'an IHC score the source does not have', overrides: { immunohistochemistry: base.immunohistochemistry.replace('FISH 阴性', 'IHC 1+，FISH 阴性') } },
    { code: 'REPORT_RECEPTOR_MISMATCH', name: 'receptor results outside the immunohistochemistry section', overrides: { diagnosis: `${base.diagnosis}ER 阳性型。` } },
    { code: 'REPORT_RECEPTOR_SOURCE_MISSING', name: 'no source attribution', overrides: { immunohistochemistry: 'ER：阳性；PR：阴性；HER2：阴性（FISH 阴性）。' } },
    { code: 'REPORT_LYMPH_NODE_CLAIMED', name: 'a positive lymph node claim', overrides: { note: `${base.note}腋窝淋巴结见癌转移（2/18）。` } },
    { code: 'REPORT_LYMPH_NODE_CLAIMED', name: 'a negative lymph node claim', overrides: { microscopy: `${base.microscopy}淋巴结未见转移。` } },
    { code: 'REPORT_NOTE_MISMATCH', name: 'a note without the fixed scope statement', overrides: { note: '本次会诊仅供参考。' } },
    { code: 'REPORT_UNSUPPORTED_DETAIL', name: 'a tumour size', overrides: { microscopy: `${base.microscopy}肿瘤最大径 2.5 cm。` } },
    { code: 'REPORT_UNSUPPORTED_DETAIL', name: 'a laterality', overrides: { diagnosis: `左${base.diagnosis}` } },
    { code: 'REPORT_UNSUPPORTED_DETAIL', name: 'a stage', overrides: { diagnosis: `${base.diagnosis}pT2。` } },
    { code: 'REPORT_UNSUPPORTED_DETAIL', name: 'a margin statement', overrides: { microscopy: `${base.microscopy}切缘未见癌。` } },
  ])('rejects a draft with $name', ({ code, overrides }) => {
    expect(issueCodes(asset(), report(overrides))).toEqual([code])
  })
})

describe('pathology review signing', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

  async function catalog(entry: PathologyCatalogAssetEntry) {
    const root = await mkdtemp(join(tmpdir(), 'clinmesh-pathology-review-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'assets'))
    await mkdir(join(root, 'prompts'))
    await writeFile(join(root, 'prompts', 'breast-pathology-report-v1.md'), '# Synthetic prompt\n')
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      clinicalSources: [{
        attribution: 'Synthetic clinical fixture',
        id: 'synthetic-clinical',
        sha256: digest('d'),
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
    }))
    await writeFile(join(root, 'assets', 'synthetic-slide.json'), JSON.stringify(entry))
    return root
  }

  const reviewInput = (catalogDirectory: string) => ({
    assetDirectory: join(catalogDirectory, 'unused-assets'),
    assetIds: ['synthetic-slide'],
    catalogDirectory,
    conclusion: 'approved' as const,
    reviewer: 'Synthetic Reviewer',
    reviewerIsPathologist: false,
  })

  async function publication(catalogDirectory: string) {
    const [checked] = (await checkPathologyAssets({ catalogDirectory })).assets
    return { publishedRevisions: checked!.publishedRevisions, reasons: checked!.reasons, status: checked!.status }
  }

  async function rewriteAsset(catalogDirectory: string, change: (entry: PathologyCatalogAssetEntry) => void) {
    const path = join(catalogDirectory, 'assets', 'synthetic-slide.json')
    const entry = JSON.parse(await readFile(path, 'utf8')) as PathologyCatalogAssetEntry
    change(entry)
    await writeFile(path, JSON.stringify(entry))
  }

  it('publishes a revision only after an approved review of the current content and records the reviewer honestly', async () => {
    const catalogDirectory = await catalog(asset())
    expect(await publication(catalogDirectory))
      .toEqual({ publishedRevisions: [], reasons: [{ code: 'REVIEW_MISSING', revision: 1 }], status: 'unpublished' })

    expect(await reviewPathologyAssets(reviewInput(catalogDirectory)))
      .toEqual({ assets: [{ assetId: 'synthetic-slide', status: 'reviewed' }] })

    const [signed] = (await loadPathologyCatalog(catalogDirectory)).assets
    expect(signed!.reports![0]!.review).toEqual({
      automatedCheck: { checkVersion: pathologyReportCheckVersion, passed: true },
      conclusion: 'approved',
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      items: ['no-identifying-content', 'findings-match-slide', 'source-fields', 'report-wording']
        .map(item => ({ conclusion: 'confirmed', item })),
      reviewedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      reviewer: 'Synthetic Reviewer',
      reviewerIsPathologist: false,
    })
    expect(await publication(catalogDirectory)).toEqual({ publishedRevisions: [1], reasons: [], status: 'published' })
  })

  it.each([
    { change: (entry: PathologyCatalogAssetEntry) => { entry.reports![0]!.microscopy += '间质纤维组织增生。' }, name: 'the report text' },
    { change: (entry: PathologyCatalogAssetEntry) => { entry.clinical.pathologicN = 'N0' }, name: 'a clinical field' },
    { change: (entry: PathologyCatalogAssetEntry) => { entry.output!.levels[0]!.tiles.sha256 = digest('e') }, name: 'the installed level hashes' },
    { change: (entry: PathologyCatalogAssetEntry) => { entry.source.series[0].instances![0]!.sha256 = digest('f') }, name: 'a source instance hash' },
  ])('invalidates the signature when $name changes', async ({ change }) => {
    const catalogDirectory = await catalog(asset())
    await reviewPathologyAssets(reviewInput(catalogDirectory))

    await rewriteAsset(catalogDirectory, change)

    expect(await publication(catalogDirectory))
      .toEqual({ publishedRevisions: [], reasons: [{ code: 'REVIEW_STALE', revision: 1 }], status: 'unpublished' })
  })

  it('invalidates the signature when the prompt file or the collection licence changes', async () => {
    const catalogDirectory = await catalog(asset())
    await reviewPathologyAssets(reviewInput(catalogDirectory))

    await writeFile(join(catalogDirectory, 'prompts', 'breast-pathology-report-v1.md'), '# Changed prompt\n')
    expect((await publication(catalogDirectory)).reasons).toEqual([{ code: 'REVIEW_STALE', revision: 1 }])

    await writeFile(join(catalogDirectory, 'prompts', 'breast-pathology-report-v1.md'), '# Synthetic prompt\n')
    expect((await publication(catalogDirectory)).publishedRevisions).toEqual([1])
    const manifestPath = join(catalogDirectory, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.collections[0].license = 'CC-BY-NC-4.0'
    await writeFile(manifestPath, JSON.stringify(manifest))
    expect((await publication(catalogDirectory)).reasons).toEqual([{ code: 'REVIEW_STALE', revision: 1 }])
  })

  it('refuses to approve a draft that fails the automated check, an unrecorded asset or a missing revision', async () => {
    const failing = await catalog(asset({ reports: [report({ diagnosis: '乳腺浸润性导管癌，组织学 III 级。' })] }))
    expect((await reviewPathologyAssets(reviewInput(failing))).assets).toEqual([{
      assetId: 'synthetic-slide',
      error: { code: 'PATHOLOGY_REVIEW_REJECTED', message: expect.stringContaining('REPORT_GRADE_CLAIMED') },
      status: 'failed',
    }])
    // 拒绝结论可以签署，但不会发布。
    await reviewPathologyAssets({ ...reviewInput(failing), conclusion: 'rejected', note: 'grade is not in the source' })
    expect((await publication(failing)).reasons).toEqual([{ code: 'REVIEW_NOT_APPROVED', revision: 1 }])

    const { output: _output, ...unrecorded } = asset()
    expect((await reviewPathologyAssets(reviewInput(await catalog(unrecorded)))).assets[0])
      .toMatchObject({ error: { code: 'IMAGING_ASSET_UNRECORDED' }, status: 'failed' })
    expect((await reviewPathologyAssets({ ...reviewInput(await catalog(asset())), revision: 2 })).assets[0])
      .toMatchObject({ error: { code: 'PATHOLOGY_REVIEW_REJECTED' }, status: 'failed' })
  })
})

describe('committed pathology catalog', () => {
  it('holds model-drafted reports that pass the automated check for every slide', async () => {
    const { assets, manifest } = await loadPathologyCatalog(defaultPathologyCatalogDirectory)

    expect(manifest.collections).toEqual([expect.objectContaining({ doi: '10.5281/zenodo.12689962', license: 'CC-BY-3.0' })])
    expect(assets.length).toBeGreaterThanOrEqual(2)
    const combinations = new Set<string>()
    for (const entry of assets) {
      expect(entry.clinical.sex).toBe('female')
      expect(entry.reports?.length).toBeGreaterThan(0)
      for (const revision of entry.reports ?? []) {
        expect(revision.draft.model).not.toBe('')
        expect(checkPathologyReport(entry, revision).issues).toEqual([])
      }
      const status = pathologyClinicalStatus(entry.clinical)
      combinations.add(`${status.er}/${status.pr}/${status.her2}`)
      // 素材标识不携带来源受试者编号；编号只出现在清单条目的来源字段中。
      expect(entry.assetId).not.toContain(entry.source.subjectId.toLowerCase().replace(/^tcga-/, ''))
    }
    expect(combinations.size).toBeGreaterThanOrEqual(2)
  })
})
