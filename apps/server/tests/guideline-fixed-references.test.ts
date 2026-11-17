import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { guidelineTopicIds } from '@clinmesh/contracts/guideline-topics'
import { afterEach, expect, it } from 'vitest'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import {
  computeGuidelineTopicFingerprint,
  getGuidelineTopicDefinition,
  matchApplicableGuidelineTopicIds,
  normalizeGuidelineFragmentText,
  readGuidelineTopicSource,
  summarizeCoronaryAngiographyVessels,
} from '../src/application/guideline-topic-registry.ts'
import { defaultGuidelineReleaseOverlay } from '../src/infrastructure/guidelines/guideline-release-overlay.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'

const disposals: Array<() => void> = []
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose() })

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'clinmesh-fixed-guidelines-'))
  disposals.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'guidelines.sqlite')
  const writer = new GuidelineCorpus({ databasePath: path })
  const reader = new GuidelineCorpus({ databasePath: path, readOnly: true })
  disposals.push(() => writer.close(), () => reader.close())
  const document: GuidelineDocument = { source: { id: 'synthetic-stent-guideline', title: '合成支架指南',
    publisher: '合成机构', documentType: 'guideline', version: '2021', url: 'https://example.test/stent',
    sha256: 'a'.repeat(64), format: 'pdf', scope: '仅供合成回归', status: 'active',
    license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' }, topics: [] }, passages: [
    { locator: 'PDF 物理第 35 页', text: 'Synthetic category recommendation. Retain the patient population and exceptions.' },
    { locator: 'PDF 物理第 36 页', text: 'Synthetic selective imaging guidance; this is optional, not compulsory.' },
  ] }
  writer.importDocument(document)
  const reference = { sourceId: document.source.id, version: '2021', sha256: document.source.sha256, page: 35 }
  return { path, reader, writer, document, reference }
}

it('固定引用从精确身份、版本、哈希和物理页回读完整原文，不依赖检索关键词', () => {
  const s = setup()
  const result = s.reader.readReferences([s.reference, { ...s.reference, page: 36 }])
  expect(result.missing).toEqual([])
  expect(result.guidelines.map(item => ({ title: item.title, version: item.version, sourceHash: item.sourceHash,
    locator: item.locator, text: item.text }))).toEqual(s.document.passages.map(passage => ({ title: '合成支架指南',
    version: '2021', sourceHash: 'a'.repeat(64), ...passage })))
  expect(s.reader.readReferences([s.reference, s.reference]).guidelines).toHaveLength(1)
})

it('固定引用版本、哈希或页码不匹配时保留来源缺口，不替换成相似正文', () => {
  const s = setup()
  for (const reference of [{ ...s.reference, version: '2022' }, { ...s.reference, sha256: 'b'.repeat(64) },
    { ...s.reference, page: 99 }]) {
    const result = s.reader.readReferences([reference])
    expect(result.guidelines).toEqual([])
    expect(result.missing).toHaveLength(1)
  }
})

it.each(['withdrawn', 'superseded', 'restricted', 'damaged'] as const)('固定引用在来源%s后立即失效，不复用旧正文', reason => {
  const s = setup()
  const original = s.reader.readReferences([s.reference])
  if (reason === 'damaged') {
    const connection = new Database(s.path)
    try { connection.prepare('UPDATE guideline_passage SET text=?').run('Silently damaged source text.') }
    finally { connection.close() }
  } else {
    s.writer.importDocument({ ...s.document, source: { ...s.document.source,
      ...(reason === 'restricted' ? { license: { ...s.document.source.license, usage: 'unverified' } } : { status: reason }) }, passages: [] })
  }
  const current = s.reader.readReferences([s.reference])
  expect(current.guidelines).toEqual([])
  expect(current.missing).toHaveLength(1)
  expect(current.revision).not.toBe(original.revision)
})

it('正式来源与院内副本指向同一正文时只回读一次，祖先撤回后副本也失效', () => {
  const s = setup(), aliasId = 'local-evaluation-synthetic-stent-copy'
  s.writer.importDocument({ ...s.document, source: { ...s.document.source, id: aliasId, derivedFromSourceId: s.document.source.id } })
  const reader = new GuidelineCorpus({ databasePath: s.path, readOnly: true, allowLocalEvaluation: true })
  disposals.push(() => reader.close())
  const references = [s.reference, { ...s.reference, sourceId: aliasId }]
  const original = reader.readReferences(references)
  expect(original.missing).toEqual([])
  expect(original.guidelines).toHaveLength(1)
  s.writer.importDocument({ ...s.document, source: { ...s.document.source, status: 'withdrawn', sha256: 'c'.repeat(64) }, passages: [] })
  expect(reader.readReferences(references)).toMatchObject({ guidelines: [], missing: [{ sourceId: s.reference.sourceId }, { sourceId: aliasId }] })
})

it('固定引用按患者人群过滤成人与儿科来源，不匹配时标记 withheld 且更新 revision', () => {
  const s = setup()
  const adultSource = { ...s.document.source, id: 'synthetic-adult-pci', population: 'adult' as const, sha256: '1'.repeat(64) }
  const pediatricSource = { ...s.document.source, id: 'synthetic-pediatric-all', population: 'pediatric' as const, sha256: '2'.repeat(64) }
  const universalSource = { ...s.document.source, id: 'synthetic-universal-flu', population: 'all' as const, sha256: '3'.repeat(64) }
  s.writer.importDocuments([
    { source: adultSource, passages: [{ locator: 'PDF 物理第 35 页', text: 'Adult PCI recommendation.' }] },
    { source: pediatricSource, passages: [{ locator: 'PDF 物理第 35 页', text: 'Pediatric oncology recommendation.' }] },
    { source: universalSource, passages: [{ locator: 'PDF 物理第 35 页', text: 'All-age influenza recommendation.' }] },
  ])
  const refs = [
    { sourceId: adultSource.id, version: '2021', sha256: adultSource.sha256, page: 35 },
    { sourceId: pediatricSource.id, version: '2021', sha256: pediatricSource.sha256, page: 35 },
    { sourceId: universalSource.id, version: '2021', sha256: universalSource.sha256, page: 35 },
  ]
  const adultRead = s.reader.readReferences(refs, { population: 'adult' })
  expect(adultRead.guidelines.map(item => item.sourceHash)).toEqual([adultSource.sha256, universalSource.sha256])
  expect(adultRead.missing).toEqual([{ sourceId: pediatricSource.id, page: 35, status: 'withheld', reason: 'population-mismatch' }])

  const pediatricRead = s.reader.readReferences(refs, { population: 'pediatric' })
  expect(pediatricRead.guidelines.map(item => item.sourceHash)).toEqual([pediatricSource.sha256, universalSource.sha256])
  expect(pediatricRead.missing).toEqual([{ sourceId: adultSource.id, page: 35, status: 'withheld', reason: 'population-mismatch' }])

  const allOnlyRead = s.reader.readReferences(refs, { population: 'all-only' })
  expect(allOnlyRead.guidelines.map(item => item.sourceHash)).toEqual([universalSource.sha256])
  expect(allOnlyRead.missing).toEqual([
    { sourceId: adultSource.id, page: 35, status: 'withheld', reason: 'population-mismatch' },
    { sourceId: pediatricSource.id, page: 35, status: 'withheld', reason: 'population-mismatch' },
  ])

  const unfilteredRead = s.reader.readReferences(refs)
  expect(unfilteredRead.missing).toEqual([])
  expect(new Set([adultRead.revision, pediatricRead.revision, allOnlyRead.revision, unfilteredRead.revision]).size).toBe(4)
})

function buildSyntheticTopicCorpusDocuments(options: {
  corruptTopicFragment?: boolean
  exceedByteBudget?: boolean
  useUnicodeNonBreakingHyphen?: boolean
} = {}): GuidelineDocument[] {
  const bySource = new Map<string, {
    pages: Map<number, string[]>
    sha256: string
    specialty: 'cardiology' | 'endocrinology'
    title: string
    version: string
  }>()
  for (const topicId of guidelineTopicIds) {
    const def = getGuidelineTopicDefinition(topicId)
    for (const ref of def.references) {
      let entry = bySource.get(ref.sourceId)
      if (!entry) {
        entry = {
          pages: new Map(),
          sha256: ref.sha256,
          specialty: def.specialty,
          title: ref.title,
          version: ref.version,
        }
        bySource.set(ref.sourceId, entry)
      }
      const list = entry.pages.get(ref.page) ?? []
      for (const fragment of ref.fragments) {
        const rendered = options.useUnicodeNonBreakingHyphen
          ? fragment.replaceAll('-', '\u2011')
          : fragment
        if (!list.includes(rendered)) list.push(rendered)
      }
      entry.pages.set(ref.page, list)
    }
  }
  const erratum = defaultGuidelineReleaseOverlay.errata.find(e => e.sourceId === 'coronary-20-2021')!
  return [...bySource.entries()].map(([sourceId, entry]) => ({
    passages: [...entry.pages.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, fragments]) => {
        if (sourceId === 'coronary-20-2021' && page === 4 && !options.corruptTopicFragment && !options.exceedByteBudget) {
          return { locator: erratum.afterLocator, text: erratum.afterText }
        }
        return {
          locator: `PDF 物理第 ${page} 页`,
          text: options.corruptTopicFragment
            ? fragments[0]!.slice(0, 6)
            : options.exceedByteBudget
              ? `${fragments.join('。 ')} ${'长文填充'.repeat(1500)}`
              : `${fragments.join('。 ')}（仅供合成回归核验）`,
        }
      }),
    source: {
      documentType: 'guideline',
      format: 'pdf',
      id: sourceId,
      license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' },
      population: 'adult',
      publisher: '合成指南注册表核验机构',
      scope: '仅供合成回归核验',
      sha256: entry.sha256,
      specialty: entry.specialty,
      status: 'active',
      title: entry.title,
      topics: [],
      url: `https://example.test/${sourceId}`,
      version: entry.version,
    },
  }))
}

it('六个注册 Guideline Topic 均通过精确 SHA-256、物理页码、软连字符规范化及片段门禁核验，残缺或超 48 KiB 预算时失败闭合', () => {
  const s = setup()
  s.writer.importDocuments(buildSyntheticTopicCorpusDocuments({ useUnicodeNonBreakingHyphen: true }))

  for (const topicId of guidelineTopicIds) {
    const def = getGuidelineTopicDefinition(topicId)
    const read = readGuidelineTopicSource(topicId, s.reader, { population: 'adult' })
    expect(read.sourceStatus, topicId).toBe('available')
    expect(read.degradedReason, topicId).toBeNull()
    expect(read.missing, topicId).toEqual([])
    expect(read.guidelines.length, topicId).toBe(def.references.length)
    expect(read.guidelines.map(g => Number(/^PDF 物理第 (\d+) 页/.exec(g.locator)?.[1]))).toEqual(def.references.map(r => r.page))

    const pediatric = readGuidelineTopicSource(topicId, s.reader, { population: 'pediatric' })
    expect(pediatric.sourceStatus, `${topicId}:pediatric`).toBe('unavailable')
    expect(pediatric.guidelines, `${topicId}:pediatric`).toEqual([])
    expect(pediatric.degradedReason, `${topicId}:pediatric`).toContain('适用人群与当前患者不匹配')
  }

  const sTruncated = setup()
  sTruncated.writer.importDocuments(buildSyntheticTopicCorpusDocuments({ corruptTopicFragment: true }))
  for (const topicId of guidelineTopicIds) {
    const degraded = readGuidelineTopicSource(topicId, sTruncated.reader, { population: 'adult' })
    expect(degraded.sourceStatus, topicId).toBe('unavailable')
    expect(degraded.guidelines, topicId).toEqual([])
    expect(degraded.degradedReason).toContain('未完整保留本专题所需条款与限定语')
  }

  const sOverBudget = setup()
  sOverBudget.writer.importDocuments(buildSyntheticTopicCorpusDocuments({ exceedByteBudget: true }))
  const overBudget = readGuidelineTopicSource('contrast-kidney-hydration', sOverBudget.reader, { population: 'adult' })
  expect(overBudget.sourceStatus).toBe('unavailable')
  expect(overBudget.guidelines).toEqual([])
  expect(overBudget.degradedReason).toContain('超出证据预算')

  // Verify soft-hyphen word wrap vs uppercase acronym line wrap
  expect(normalizeGuidelineFragmentText('plaque measure-\nments')).toContain(normalizeGuidelineFragmentText('plaque measurements'))
  expect(normalizeGuidelineFragmentText('评估 NSTE-\nACS 缺血风险')).toContain(normalizeGuidelineFragmentText('评估 NSTE-ACS 缺血风险'))

  // Verify per-vessel coronary angiography indicator summary (prevents multi-vessel misclassification)
  const mixed = summarizeCoronaryAngiographyVessels([
    { lesionCharacteristics: '弥漫钙化', segment: '近段', stenosisPercent: 95, timiFlow: 2, vessel: 'RCA' },
    { ffr: 0.86, lesionCharacteristics: '偏心斑块', segment: '中段', stenosisPercent: 65, timiFlow: 3, vessel: 'LAD' },
  ])
  expect(mixed.summaryText).toContain('RCA(近段) 狭窄 95%')
  expect(mixed.summaryText).toContain('LAD(中段) 狭窄 65%（FFR 0.86 > 0.80 保守治疗范围）')
  expect(mixed.missingFfrMessages).toEqual([])

  const unmeasuredIntermediate = summarizeCoronaryAngiographyVessels([
    { ffr: 0.92, lesionCharacteristics: '轻度斑块', segment: '远段', stenosisPercent: 25, timiFlow: 3, vessel: 'LCX' },
    { lesionCharacteristics: '临界狭窄', segment: '中段', stenosisPercent: 65, timiFlow: 3, vessel: 'LAD' },
  ])
  expect(unmeasuredIntermediate.missingFfrMessages).toEqual([
    'LAD(中段) 呈 65% 临界/中等狭窄，尚未记录该支 FFR/iFR 功能学测量或客观缺血证据。',
  ])

  // Verify topic fingerprint incorporates generationRule and conclusionKinds so semantic changes invalidate prior advice
  const acsDef = getGuidelineTopicDefinition('acute-chest-pain-acs')
  const { fingerprint: baseFp, ...acsSpec } = acsDef
  expect(computeGuidelineTopicFingerprint(acsSpec)).toBe(baseFp)
  expect(matchApplicableGuidelineTopicIds('{"speaker":"doctor","text":"description of sacral pain"}')).toEqual([])
  expect(matchApplicableGuidelineTopicIds('拟行 OCT 指导 DES 支架置入')).toContain('pci-stent')
  expect(computeGuidelineTopicFingerprint({ ...acsSpec, generationRule: `${acsSpec.generationRule}（附加条款）` })).not.toBe(baseFp)
  expect(
    computeGuidelineTopicFingerprint({
      ...acsSpec,
      conclusionKinds: [acsSpec.conclusionKinds[0], acsSpec.conclusionKinds[1], 'stent-category'],
    }),
  ).not.toBe(baseFp)
})
