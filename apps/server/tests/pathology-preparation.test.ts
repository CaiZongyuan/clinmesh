import { describe, expect, it } from 'vitest'
import {
  matchCasePathology,
  pathologyMatchingCatalogHash,
  type PathologyMatchingCatalog,
} from '../src/application/pathology-preparation.ts'
import {
  pathologyMatchingRulesSchema,
  type PathologyCatalogAsset,
} from '../src/infrastructure/imaging-assets/pathology-catalog.ts'
import { pathologyAssetFacts, pathologyProfile } from '../src/infrastructure/imaging-assets/pathology-matching.ts'

const snomed = 'http://snomed.info/sct'
const loinc = 'http://loinc.org'
const positive = '10828004'
const negative = '260385009'

/** 与固定版本 Synthea 乳腺癌模块导出的编码一致。 */
const rules = pathologyMatchingRulesSchema.parse({
  codeSystem: snomed,
  facts: {
    'estrogen-receptor': { code: '85337-4', values: { negative: [negative], positive: [positive] } },
    'her2': { code: '85319-2', values: { negative: [negative], positive: [positive] } },
    'lymph-nodes': {
      code: '21906-3',
      values: { negative: ['1229967007'], positive: ['1229973008', '1229978004', '1229984001'] },
    },
    'progesterone-receptor': { code: '85339-0', values: { negative: [negative], positive: [positive] } },
    'tumor-category': {
      code: '21905-5',
      values: { T1: ['1228889001'], T2: ['1228929004'], T3: ['1228938002'], T4: ['1228944003'] },
    },
  },
  observationSystem: loinc,
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
})

interface Clinical {
  er?: 'Negative' | 'Positive'
  fish?: 'Negative' | 'Positive'
  histologicType?: string
  n?: string
  pr?: 'Negative' | 'Positive'
  t?: string
}

function asset(assetId: string, clinical: Clinical = {}): PathologyCatalogAsset {
  return {
    assetId,
    clinical: {
      estrogenReceptor: clinical.er ?? 'Positive',
      her2: { fish: clinical.fish ?? 'Negative' },
      histologicType: clinical.histologicType ?? 'Infiltrating Ductal Carcinoma',
      pathologicN: clinical.n ?? 'N1a',
      pathologicT: clinical.t ?? 'T2',
      progesteroneReceptor: clinical.pr ?? 'Positive',
      sampleId: `${assetId}-01`,
      sampleType: 'Primary Tumor',
      sex: 'female',
      sourceId: 'synthetic',
    },
    collectionId: 'synthetic',
    reviewScope: {
      clinicalSource: { id: 'synthetic', sha256: 'c'.repeat(64), terms: 'synthetic', url: 'https://example.invalid/clinical' },
      collection: { doi: '10.0000/synthetic', id: 'synthetic', license: 'CC0' },
      promptSha256: {},
    },
    schemaVersion: 1,
    source: {
      series: [{ idcSeriesUuid: '00000000-0000-4000-8000-000000000000', seriesInstanceUid: '1.2.3' }],
      slideId: assetId,
      studyInstanceUid: '1.2',
      subjectId: assetId,
    },
  }
}

function catalog(entries: Array<{ asset: PathologyCatalogAsset; publishedRevisions?: number[] }>): PathologyMatchingCatalog {
  const assets: PathologyMatchingCatalog['assets'] = new Map(entries.map(entry => [entry.asset.assetId, {
    asset: entry.asset,
    facts: pathologyAssetFacts(entry.asset.clinical),
    publishedRevisions: entry.publishedRevisions ?? [1],
  }]))
  return { assets, hash: pathologyMatchingCatalogHash(rules, assets), packId: 'synthetic-pathology', rules }
}

const condition = (id = 'condition') => ({
  resource: {
    code: { coding: [{ code: '254837009', display: '乳腺恶性肿瘤', system: snomed }] },
    resourceType: 'Condition',
  },
  sourceReference: `urn:uuid:${id}`,
})
const procedure = (id: string, code: string, start: string) => ({
  resource: {
    code: { coding: [{ code, display: code === '392021009' ? '乳房肿块切除术' : '乳腺病灶切除术', system: snomed }] },
    performedPeriod: { end: start, start },
    resourceType: 'Procedure',
  },
  sourceReference: `urn:uuid:${id}`,
})
const observation = (id: string, code: string, valueCode: string, effectiveDateTime = '2022-03-01T09:00:00+08:00') => ({
  resource: {
    code: { coding: [{ code, display: `LOINC ${code}`, system: loinc }] },
    effectiveDateTime,
    resourceType: 'Observation',
    valueCodeableConcept: { coding: [{ code: valueCode, display: `SNOMED ${valueCode}`, system: snomed }] },
  },
  sourceReference: `urn:uuid:${id}`,
})

/** 缺省病例：ER 阳性、PR 阳性、HER2 阴性、淋巴结阳性（cN1）、cT2，2022 年行肿块切除。 */
function history(overrides: {
  er?: string | null
  her2?: string | null
  n?: string | null
  pr?: string | null
  procedures?: ReturnType<typeof procedure>[]
  t?: string | null
} = {}) {
  const fact = (id: string, code: string, value: string | null | undefined, fallback: string) => (
    value === null ? [] : [observation(id, code, value ?? fallback)]
  )
  return [
    condition(),
    ...fact('er', '85337-4', overrides.er, positive),
    ...fact('pr', '85339-0', overrides.pr, positive),
    ...fact('her2', '85319-2', overrides.her2, negative),
    ...fact('n', '21906-3', overrides.n, '1229973008'),
    ...fact('t', '21905-5', overrides.t, '1228929004'),
    ...(overrides.procedures ?? [procedure('lumpectomy', '392021009', '2022-04-01T08:00:00+08:00')]),
  ]
}

function match(input: Partial<Parameters<typeof matchCasePathology>[0]> & { catalog: PathologyMatchingCatalog }) {
  const [exam] = matchCasePathology({
    bound: [],
    gender: 'female',
    historyResources: history(),
    indexEncounterReference: 'urn:uuid:index',
    indexResources: [{
      resource: { period: { start: '2026-05-01T09:00:00+08:00' }, resourceType: 'Encounter' },
      sourceReference: 'urn:uuid:index',
    }],
    sourceHash: 'a'.repeat(64),
    ...input,
  })
  return exam!
}

describe('Pathology asset facts', () => {
  it('derives node status and T category from the pathologic stage and leaves unknown stages out', () => {
    expect(pathologyAssetFacts(asset('a', { n: 'N1a', t: 'T1c' }).clinical)).toStrictEqual({
      'estrogen-receptor': 'positive',
      'her2': 'negative',
      'lymph-nodes': 'positive',
      'progesterone-receptor': 'positive',
      'tumor-category': 'T1',
    })
    expect(pathologyAssetFacts(asset('a', { n: 'N0 (i-)', t: 'T4b' }).clinical)).toMatchObject({
      'lymph-nodes': 'negative',
      'tumor-category': 'T4',
    })
    const unknown = pathologyAssetFacts(asset('a', { n: 'NX', t: 'TX' }).clinical)
    expect(unknown).not.toHaveProperty('lymph-nodes')
    expect(unknown).not.toHaveProperty('tumor-category')
  })

  it('names a profile only when all five facts are known', () => {
    const [service] = rules.services
    expect(pathologyProfile(service!, pathologyAssetFacts(asset('a').clinical))).toMatchObject({
      id: 'breast-er-pos-pr-pos-her2-neg-ln-pos-t2',
      label: '乳腺切片会诊：ER 阳性 · PR 阳性 · HER2 阴性 · 淋巴结阳性 · T2',
    })
    expect(pathologyProfile(service!, pathologyAssetFacts(asset('a', { n: 'NX' }).clinical))).toBeUndefined()
  })
})

describe('Pathology case matching', () => {
  it('prepares a slide for each eligible source procedure when every fixed fact agrees', () => {
    const exam = match({
      catalog: catalog([
        { asset: asset('slide-match', { histologicType: 'Infiltrating Lobular Carcinoma' }), publishedRevisions: [1, 3] },
        { asset: asset('slide-triple-negative', { er: 'Negative', pr: 'Negative' }) },
      ]),
    })

    expect(exam).toMatchObject({
      examCode: 'breast-slide-consultation',
      matchingProfileId: 'breast-er-pos-pr-pos-her2-neg-ln-pos-t2',
      status: 'ready',
    })
    expect(exam).not.toHaveProperty('reason')
    expect(exam.sourceProcedures).toStrictEqual([{
      assetId: 'slide-match',
      code: '392021009',
      display: '乳房肿块切除术',
      performedAt: '2022-04-01T08:00:00+08:00',
      reportRevision: 3,
      sourceReference: 'urn:uuid:lumpectomy',
      supplements: [{ fact: 'histologic-type', value: '浸润性小叶癌' }],
    }])
    expect(exam.evidence.conditions).toStrictEqual([
      { code: '254837009', display: '乳腺恶性肿瘤', sourceReference: 'urn:uuid:condition' },
    ])
    expect(exam.evidence.facts.map(fact => [fact.fact, fact.value, fact.valueCode, fact.sourceReference])).toStrictEqual([
      ['estrogen-receptor', 'positive', positive, 'urn:uuid:er'],
      ['progesterone-receptor', 'positive', positive, 'urn:uuid:pr'],
      ['her2', 'negative', negative, 'urn:uuid:her2'],
      ['lymph-nodes', 'positive', '1229973008', 'urn:uuid:n'],
      ['tumor-category', 'T2', '1228929004', 'urn:uuid:t'],
    ])
  })

  it.each([
    { clinical: { er: 'Negative' }, label: 'receptor status' },
    { clinical: { n: 'N0' }, label: 'lymph node status' },
    { clinical: { t: 'T1c' }, label: 'T category' },
  ] as const)('reports a conflict when every published slide contradicts the $label', ({ clinical }) => {
    const exam = match({ catalog: catalog([{ asset: asset('slide', clinical) }]) })

    expect(exam).toMatchObject({ reason: 'FIXED_FACT_CONFLICT', status: 'conflict' })
    expect(exam.sourceProcedures).toHaveLength(1)
    expect(exam.sourceProcedures[0]).not.toHaveProperty('assetId')
  })

  it.each([
    { history: history({ pr: null }), label: 'the source has no PR result', slide: asset('slide') },
    // Synthea 的 cT0（未见原发灶）不在 T1–T4 中。
    { history: history({ t: '1228882005' }), label: 'the source T category is outside T1–T4', slide: asset('slide') },
    { history: history(), label: 'the slide has no node stage', slide: asset('slide', { n: 'NX' }) },
  ])('leaves the case unsupported when $label', ({ history: historyResources, slide }) => {
    const exam = match({ catalog: catalog([{ asset: slide }]), historyResources })

    expect(exam).toMatchObject({ reason: 'FACT_UNKNOWN', status: 'unsupported' })
    expect(exam.sourceProcedures[0]).not.toHaveProperty('assetId')
  })

  it('prefers a conflict-free unknown over a conflict and a compatible slide over both', () => {
    const contradicting = { asset: asset('slide-conflict', { er: 'Negative' }) }
    const unknown = { asset: asset('slide-unknown', { t: 'TX' }) }

    expect(match({ catalog: catalog([contradicting, unknown]) })).toMatchObject({ reason: 'FACT_UNKNOWN', status: 'unsupported' })
    expect(match({ catalog: catalog([contradicting, unknown, { asset: asset('slide-match') }]) }).sourceProcedures[0])
      .toMatchObject({ assetId: 'slide-match' })
  })

  it('uses the latest result of each source Observation', () => {
    const historyResources = [
      ...history(),
      observation('er-earlier', '85337-4', negative, '2021-01-01T09:00:00+08:00'),
    ]

    expect(match({ catalog: catalog([{ asset: asset('slide') }]), historyResources }).status).toBe('ready')
  })

  it('applies only to the service sex and diagnosis', () => {
    const slides = catalog([{ asset: asset('slide') }])

    expect(match({ catalog: slides, gender: 'male' })).toMatchObject({
      evidence: { facts: [] },
      reason: 'NO_APPLICABLE_RULE',
      sourceProcedures: [],
      status: 'unsupported',
    })
    expect(match({ catalog: slides, historyResources: history().slice(1) })).toMatchObject({
      evidence: { conditions: [] },
      reason: 'NO_APPLICABLE_RULE',
      status: 'unsupported',
    })
  })

  it('requires a compatible source procedure before the index visit', () => {
    const slides = catalog([{ asset: asset('slide') }])
    const sameDay = procedure('same-day', '392021009', '2026-05-01T09:00:00+08:00')
    const biopsy = procedure('biopsy', '122548005', '2022-03-01T09:00:00+08:00')

    expect(match({ catalog: slides, historyResources: history({ procedures: [sameDay, biopsy] }) })).toMatchObject({
      reason: 'NO_SOURCE_PROCEDURE',
      sourceProcedures: [],
      status: 'unsupported',
    })

    const excision = procedure('excision', '392023007', '2023-01-05T08:00:00+08:00')
    const lumpectomy = procedure('lumpectomy', '392021009', '2022-04-01T08:00:00+08:00')
    const exam = match({ catalog: slides, historyResources: history({ procedures: [excision, biopsy, lumpectomy] }) })
    expect(exam.sourceProcedures.map(item => [item.sourceReference, item.code, item.assetId])).toStrictEqual([
      ['urn:uuid:lumpectomy', '392021009', 'slide'],
      ['urn:uuid:excision', '392023007', 'slide'],
    ])
  })

  it('reports an empty library separately from a conflict', () => {
    expect(match({ catalog: catalog([{ asset: asset('slide'), publishedRevisions: [] }]) })).toMatchObject({
      reason: 'ASSET_NOT_PUBLISHED',
      status: 'unsupported',
    })
  })

  it('chooses among equally compatible slides by case source identity and source procedure', () => {
    const slides = catalog(['a', 'b', 'c', 'd'].map(id => ({ asset: asset(`slide-${id}`) })))
    const chosen = (sourceHash: string) => match({ catalog: slides, sourceHash }).sourceProcedures[0]!.assetId

    expect(chosen('a'.repeat(64))).toBe(chosen('a'.repeat(64)))
    expect(new Set(Array.from({ length: 16 }, (_, index) => chosen(index.toString(16).repeat(64)))).size).toBeGreaterThan(1)
  })

  it('keeps a fixed binding when the current catalog no longer supports it', () => {
    const exam = match({
      bound: [{
        assetId: 'slide-retired',
        examCode: 'breast-slide-consultation',
        matchingProfileId: 'breast-er-pos-pr-pos-her2-neg-ln-pos-t2',
        reportRevision: 2,
        sourceProcedureReference: 'urn:uuid:lumpectomy',
      }],
      catalog: catalog([{ asset: asset('slide-other', { er: 'Negative' }) }]),
      historyResources: history({
        procedures: [
          procedure('lumpectomy', '392021009', '2022-04-01T08:00:00+08:00'),
          procedure('excision', '392023007', '2023-01-05T08:00:00+08:00'),
        ],
      }),
    })

    expect(exam).toMatchObject({ matchingProfileId: 'breast-er-pos-pr-pos-her2-neg-ln-pos-t2', status: 'ready' })
    expect(exam.sourceProcedures[0]).toMatchObject({ assetId: 'slide-retired', reportRevision: 2 })
    expect(exam.sourceProcedures[1]).not.toHaveProperty('assetId')
  })
})
