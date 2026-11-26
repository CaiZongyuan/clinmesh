import { describe, expect, it } from 'vitest'
import { clinicalFactLedgerSchema, type ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import {
  phenotypeKnowledgeBaseSchema,
  type PhenotypeKnowledgeBase,
} from '@clinmesh/contracts/phenotype-matcher'
import {
  evaluateClinicalFactLedger,
  transcribeBedsideQuestionnaireFacts,
  transcribeLocalFhirFacts,
  transcribeVisibleSourceHistoryFacts,
} from '../src/clinical-fact-ledger.ts'
import { filterPromptCardsBeforeDisplay } from '../src/clinical-prompt-cards.ts'
import { PUBLIC_CONCEPT_VOCABULARY } from '../src/concept-vocabulary.ts'
import { SYNTHETIC_PHENOTYPE_KB, matchPhenotypeCandidates } from '../src/phenotype-matcher.ts'

type TranscribedFactCandidate = Parameters<typeof evaluateClinicalFactLedger>[0]['candidates'][number]

function buildEvaluatedLedger(params: {
  readonly asOf?: string
  readonly candidates: readonly TranscribedFactCandidate[]
  readonly patientId?: string
  readonly patientSex?: 'male' | 'female' | 'other' | 'unknown'
  readonly verifyExternal?: boolean
}): ClinicalFactLedger {
  const evaluatedAsOf = params.asOf ?? '2026-08-24T10:00:00+08:00'
  const patientId = params.patientId ?? 'pat-synth-fh-1'
  const patientSex = params.patientSex ?? 'male'
  const initial = evaluateClinicalFactLedger({
    candidates: [...params.candidates],
    evaluatedAsOf,
    patientId,
    patientSex,
    subjectId: 'case-synth-1',
    subjectKind: 'outpatient',
  })
  if (!params.verifyExternal) {
    return clinicalFactLedgerSchema.parse(initial)
  }

  const verifications = initial.facts
    .filter(fact => fact.institutionScope === 'external')
    .map((fact, idx) => ({
      decision: 'verified' as const,
      factId: fact.factId,
      itemCode: fact.itemCode.code,
      note: '门诊核对确认外院历史记录',
      patientId,
      sourceReference: fact.provenance.recordId,
      sourceVersion: fact.provenance.recordVersion,
      subjectId: 'case-synth-1',
      subjectKind: 'outpatient' as const,
      verificationId: `ver-ext-${idx + 1}`,
      verifiedAt: '2026-08-24T09:05:00+08:00',
      verifiedByActorId: 'pract-card-1',
      verifiedByPractitionerId: 'pract-card-1',
      verifiedByPractitionerRoleId: 'role-card-1',
    }))

  const verified = evaluateClinicalFactLedger({
    candidates: [...params.candidates],
    evaluatedAsOf,
    patientId,
    patientSex,
    subjectId: 'case-synth-1',
    subjectKind: 'outpatient',
    verifications,
  })
  return clinicalFactLedgerSchema.parse(verified)
}

function buildFhGoldenLikeCandidates(): TranscribedFactCandidate[] {
  const externalCandidates = transcribeVisibleSourceHistoryFacts({
    entries: [
      {
        clinical: {
          code: { coding: [{ code: '13457-7', display: '低密度脂蛋白胆固醇 (LDL-C)', system: 'http://loinc.org' }] },
          valueQuantity: { unit: 'mmol/L', value: 5.5 },
        },
        clinicalDate: '2023-09-12T09:10:00+08:00',
        entryId: 'vh-ldl-2023',
        resourceType: 'Observation',
        sourceReference: 'Observation/ext-ldl-2023',
        title: '外院2023年血脂检测 LDL-C',
      },
      {
        clinical: {
          code: { coding: [{ code: '13457-7', display: '低密度脂蛋白胆固醇 (LDL-C)', system: 'http://loinc.org' }] },
          valueQuantity: { unit: 'mmol/L', value: 5.8 },
        },
        clinicalDate: '2025-07-18T09:30:00+08:00',
        entryId: 'vh-ldl-2025',
        resourceType: 'Observation',
        sourceReference: 'Observation/ext-ldl-2025',
        title: '外院2025年体检 LDL-C',
      },
      {
        clinical: {
          code: { coding: [{ code: 'Z82.4', display: '缺血性心脏病及早发心肌梗死家族史', system: 'http://hl7.org/fhir/sid/icd-10' }] },
          conclusion: '父亲44岁急性心肌梗死，外院长期高胆固醇血症未规律降脂',
        },
        clinicalDate: '2025-07-18T09:35:00+08:00',
        entryId: 'vh-fam-2025',
        resourceType: 'Condition',
        sourceReference: 'Condition/ext-fam-2025',
        title: '早发心肌梗死家族史',
      },
    ],
  })

  const localCandidates = transcribeLocalFhirFacts({
    conditions: [
      {
        code: { coding: [{ code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', system: 'http://hl7.org/fhir/sid/icd-10' }] },
        id: 'cond-cad-2026',
        meta: { lastUpdated: '2026-08-24T09:00:00+08:00', versionId: '1' },
        recordedDate: '2026-08-24T09:00:00+08:00',
        verificationStatus: { coding: [{ code: 'confirmed' }] },
      },
    ],
    observations: [
      {
        category: [{ coding: [{ code: 'laboratory' }] }],
        code: { coding: [{ code: '13457-7', display: '低密度脂蛋白胆固醇', system: 'http://loinc.org' }] },
        effectiveDateTime: '2026-08-24T09:20:00+08:00',
        id: 'obs-ldl-2026',
        issued: '2026-08-24T09:25:00+08:00',
        meta: { lastUpdated: '2026-08-24T09:25:00+08:00', versionId: '1' },
        status: 'final',
        valueQuantity: { unit: 'mg/dL', value: 235.89 },
      },
    ],
  })

  return [...externalCandidates, ...localCandidates]
}

describe('matchPhenotypeCandidates deterministic cross-time phenotype matcher (AC30)', () => {
  it('detects cross-time FH clues across 2023-2026 without E78.01, converts units, preserves >180d verified longitudinal labs, and produces non-blocking cards', () => {
    const ledger = buildEvaluatedLedger({
      candidates: buildFhGoldenLikeCandidates(),
      patientSex: 'male',
      verifyExternal: true,
    })

    // Confirm historical LDL facts are marked expired (>180d) in ledger yet retained for longitudinal phenotype matching
    const hist2023 = ledger.facts.find(f => f.provenance.recordId === 'Observation/ext-ldl-2023')
    expect(hist2023?.isExpiredAtAsOf).toBe(true)
    expect(hist2023?.eligibleForScoringAndRedLine).toBe(false)

    const result = matchPhenotypeCandidates({
      asOf: '2026-08-24T10:00:00+08:00',
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger,
      patientBirthDate: '1988-03-18',
      patientSex: 'male',
      timing: 'encounter-open',
      vocabulary: PUBLIC_CONCEPT_VOCABULARY,
    })

    expect(result.llmInvocationCount).toBe(0)
    expect(result.candidates).toHaveLength(1)
    const fh = result.candidates[0]!
    expect(fh.diseaseId).toBe('familial-hypercholesterolemia')
    expect(fh.packId).toBe('familial-hypercholesterolemia')
    expect(fh.confidenceScore).toBe(1)
    expect(fh.matchedPhenotypeCount).toBe(5)

    const matchedCodes = new Set(fh.matchedPhenotypes.map(t => t.phenotypeCode))
    expect(matchedCodes).toEqual(new Set([
      'PHENO-SEVERE-HYPER-LDL',
      'PHENO-PERSISTENT-SEVERE-HYPER-LDL',
      'PHENO-PREMATURE-CAD',
      'PHENO-CORONARY-ATHEROSCLEROSIS',
      'PHENO-FAMILY-HISTORY-PREMATURE-CAD',
    ]))

    const persistentTerm = fh.matchedPhenotypes.find(t => t.phenotypeCode === 'PHENO-PERSISTENT-SEVERE-HYPER-LDL')
    expect(persistentTerm?.distinctEncounterCount).toBe(3)
    expect(persistentTerm?.spanDays).toBeGreaterThan(1000)

    expect(fh.crossTimeTimeline.length).toBeGreaterThanOrEqual(4)
    expect(fh.crossTimeTimeline[0]?.observedAt.startsWith('2023-09-12')).toBe(true)
    expect(fh.crossTimeTimeline.some(entry => entry.observedAt.startsWith('2025-07-18'))).toBe(true)
    expect(fh.crossTimeTimeline.some(entry => entry.observedAt.startsWith('2026-08-24'))).toBe(true)
    expect(fh.recommendedWorkupZh.some(text => text.includes('LDLR'))).toBe(true)

    // Non-blocking prompt cards pass filterPromptCardsBeforeDisplay cleanly
    expect(result.promptCards).toHaveLength(1)
    const card = result.promptCards[0]!
    expect(card.category).toBe('phenotype-candidate')
    expect(card.blockingTier).toBe('none')
    expect(card.deliveryMode).toBe('display')
    expect(card.knowledgeStatus).toBe('published')
    expect(card.suggestions.every(s => s.isDraftOnly)).toBe(true)

    const filtered = filterPromptCardsBeforeDisplay({
      cards: result.promptCards,
      effectivePacks: [],
      ledger,
    })
    expect(filtered.blockedRecords).toHaveLength(0)
    expect(filtered.visibleCards).toHaveLength(1)
    expect(filtered.visibleCards[0]?.cardId).toBe(card.cardId)
  })

  it('excludes external-unverified, suspicious, conflict, superseded, entered-in-error, and clinician-rejected facts', () => {
    // Same patient timeline, EXCEPT external facts are unverified and local LDL is implausible (suspicious > 20 / value anomaly)
    const unverifiedLedger = buildEvaluatedLedger({
      candidates: buildFhGoldenLikeCandidates(),
      patientSex: 'male',
      verifyExternal: false,
    })

    const unverifiedResult = matchPhenotypeCandidates({
      asOf: '2026-08-24T10:00:00+08:00',
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: unverifiedLedger,
      patientBirthDate: '1988-03-18',
      patientSex: 'male',
      vocabulary: PUBLIC_CONCEPT_VOCABULARY,
    })

    expect(unverifiedResult.excludedFactSummary.externalUnverifiedCount).toBe(3)
    const localTemplate = unverifiedLedger.facts.find(f => f.institutionScope === 'local')!
    const poisonedFacts = unverifiedLedger.facts.map(fact => {
      if (fact.provenance.recordId === 'obs-ldl-2026') {
        return {
          ...fact,
          qualityFlags: ['suspicious'] as const,
          suspiciousReasons: ['out-of-plausible-range'] as const,
        }
      }
      return fact
    })
    const syntheticCorruptedLedger = clinicalFactLedgerSchema.parse({
      ...unverifiedLedger,
      facts: [
        ...poisonedFacts,
        {
          ...localTemplate,
          factId: 'fact:synthetic:superseded-1',
          itemCode: { code: 'fh-genetic-variant', display: 'LDLR 变异', system: 'urn:clinmesh:local' },
          relation: { supersededByFactId: 'fact:synthetic:replacement', supersedesFactId: null },
        },
        {
          ...localTemplate,
          conflictingFactIds: ['fact:other'],
          factId: 'fact:synthetic:conflict-1',
          itemCode: { code: 'fh-tendon-xanthoma', display: '肌腱黄色瘤', system: 'urn:clinmesh:local' },
          qualityFlags: ['conflict'],
        },
        {
          ...localTemplate,
          factId: 'fact:synthetic:error-1',
          itemCode: { code: 'fh-corneal-arcus-premature', display: '早发角膜弓', system: 'urn:clinmesh:local' },
          recordStatus: 'entered-in-error',
        },
        {
          ...localTemplate,
          factId: 'fact:synthetic:rejected-1',
          ineligibleReasons: ['clinician-rejected'],
          itemCode: { code: 'fh-genetic-variant', display: 'PCSK9 变异', system: 'urn:clinmesh:local' },
        },
      ],
    })

    const excludedResult = matchPhenotypeCandidates({
      asOf: '2026-08-24T10:00:00+08:00',
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: syntheticCorruptedLedger,
      patientBirthDate: '1988-03-18',
      patientSex: 'male',
      vocabulary: PUBLIC_CONCEPT_VOCABULARY,
    })

    expect(excludedResult.excludedFactSummary.externalUnverifiedCount).toBe(3)
    expect(excludedResult.excludedFactSummary.suspiciousCount).toBe(1)
    expect(excludedResult.excludedFactSummary.supersededCount).toBe(1)
    expect(excludedResult.excludedFactSummary.conflictCount).toBe(1)
    expect(excludedResult.excludedFactSummary.notAskedOrErrorCount).toBe(2)
    expect(excludedResult.candidates).toHaveLength(0)
    expect(excludedResult.promptCards).toHaveLength(0)
  })

  it('normalizes local codes strictly through approved + exact ConceptVocabulary mappings and rejects unapproved/close/deprecated mappings', () => {
    const customVocab: ConceptVocabulary = {
      ...PUBLIC_CONCEPT_VOCABULARY,
      mappings: [
        ...PUBLIC_CONCEPT_VOCABULARY.mappings,
        {
          effectiveDate: '2020-01-01',
          id: 'map-local-ldl',
          relation: 'exact',
          reviewStatus: 'approved',
          reviewerId: 'rev-vocab-1',
          sourceCode: 'LOCAL-LAB-LDL-EXT',
          sourceDisplay: '本院特殊化验血脂',
          sourceSystem: 'urn:clinmesh:local',
          targetConceptCode: '13457-7',
          version: '2026-11-26.r1',
        },
        {
          effectiveDate: '2020-01-01',
          id: 'map-local-xanthoma',
          relation: 'exact',
          reviewStatus: 'approved',
          reviewerId: 'rev-vocab-1',
          sourceCode: 'LOCAL-XANTHOMA-NODE',
          sourceDisplay: '跟腱结节查体阳性',
          sourceSystem: 'urn:clinmesh:local',
          targetConceptCode: 'fh-tendon-xanthoma',
          version: '2026-11-26.r1',
        },
        {
          effectiveDate: '2020-01-01',
          id: 'map-local-proposed-gene',
          relation: 'exact',
          reviewStatus: 'proposed',
          reviewerId: null,
          sourceCode: 'LOCAL-UNAPPROVED-GENETIC',
          sourceDisplay: '待审核基因项',
          sourceSystem: 'urn:clinmesh:local',
          targetConceptCode: 'fh-genetic-variant',
          version: '2026-11-26.r1',
        },
        {
          effectiveDate: '2020-01-01',
          id: 'map-local-close-famhx',
          relation: 'close',
          reviewStatus: 'approved',
          reviewerId: 'rev-vocab-1',
          sourceCode: 'LOCAL-CLOSE-FAMHX',
          sourceDisplay: '疑似早发心血管家族史',
          sourceSystem: 'urn:clinmesh:local',
          targetConceptCode: 'fh-premature-cad-family-history',
          version: '2026-11-26.r1',
        },
        {
          effectiveDate: '2020-01-01',
          id: 'map-local-deprecated-arcus',
          relation: 'exact',
          reviewStatus: 'deprecated',
          reviewerId: 'rev-vocab-1',
          sourceCode: 'LOCAL-DEPRECATED-ARCUS',
          sourceDisplay: '废止代码角膜改变',
          sourceSystem: 'urn:clinmesh:local',
          targetConceptCode: 'fh-corneal-arcus-premature',
          version: '2026-11-26.r1',
        },
      ],
    }

    const candidates = transcribeLocalFhirFacts({
      conditions: [
        {
          code: { coding: [{ code: 'LOCAL-CLOSE-FAMHX', display: '疑似早发心血管家族史' }] },
          id: 'cond-close',
          meta: { lastUpdated: '2026-08-24T09:00:00+08:00', versionId: '1' },
          recordedDate: '2026-08-24T09:00:00+08:00',
          verificationStatus: { coding: [{ code: 'confirmed' }] },
        },
        {
          code: { coding: [{ code: 'LOCAL-UNAPPROVED-GENETIC', display: '待审核基因项' }] },
          id: 'cond-proposed',
          meta: { lastUpdated: '2026-08-24T09:00:00+08:00', versionId: '1' },
          recordedDate: '2026-08-24T09:00:00+08:00',
          verificationStatus: { coding: [{ code: 'confirmed' }] },
        },
      ],
      observations: [
        {
          category: [{ coding: [{ code: 'laboratory' }] }],
          code: { coding: [{ code: 'LOCAL-LAB-LDL-EXT', display: '本院特殊化验血脂' }] },
          effectiveDateTime: '2026-08-24T09:10:00+08:00',
          id: 'obs-ldl-custom',
          issued: '2026-08-24T09:15:00+08:00',
          meta: { lastUpdated: '2026-08-24T09:15:00+08:00', versionId: '1' },
          status: 'final',
          valueQuantity: { unit: 'mmol/L', value: 6.2 },
        },
        {
          category: [{ coding: [{ code: 'exam' }] }],
          code: { coding: [{ code: 'LOCAL-XANTHOMA-NODE', display: '跟腱结节查体阳性' }] },
          effectiveDateTime: '2026-08-24T09:12:00+08:00',
          id: 'obs-xanthoma-custom',
          issued: '2026-08-24T09:15:00+08:00',
          meta: { lastUpdated: '2026-08-24T09:15:00+08:00', versionId: '1' },
          status: 'final',
          valueString: '阳性',
        },
        {
          category: [{ coding: [{ code: 'exam' }] }],
          code: { coding: [{ code: 'LOCAL-DEPRECATED-ARCUS', display: '废止代码角膜改变' }] },
          effectiveDateTime: '2026-08-24T09:14:00+08:00',
          id: 'obs-deprecated',
          issued: '2026-08-24T09:15:00+08:00',
          meta: { lastUpdated: '2026-08-24T09:15:00+08:00', versionId: '1' },
          status: 'final',
          valueString: '阳性',
        },
      ],
    })

    const ledger = buildEvaluatedLedger({ candidates })
    const result = matchPhenotypeCandidates({
      asOf: '2026-08-24T10:00:00+08:00',
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger,
      vocabulary: customVocab,
    })

    expect(result.candidates).toHaveLength(1)
    const matchedCodes = new Set(result.candidates[0]!.matchedPhenotypes.map(t => t.phenotypeCode))
    // LOCAL-LAB-LDL-EXT (approved exact) + LOCAL-XANTHOMA-NODE (approved exact) match
    expect(matchedCodes.has('PHENO-SEVERE-HYPER-LDL')).toBe(true)
    expect(matchedCodes.has('PHENO-TENDON-XANTHOMA-OR-ARCUS')).toBe(true)
    // LOCAL-UNAPPROVED-GENETIC (proposed) + LOCAL-CLOSE-FAMHX (close) MUST NOT match
    expect(matchedCodes.has('PHENO-FH-GENETIC-VARIANT')).toBe(false)
    expect(matchedCodes.has('PHENO-FAMILY-HISTORY-PREMATURE-CAD')).toBe(false)
  })

  it('suppresses FH when secondary hyperlipidemia exclusion diagnosis is active, and yields 0 candidates on healthy/unrelated controls', () => {
    const nephroticCandidates = [
      ...buildFhGoldenLikeCandidates(),
      ...transcribeLocalFhirFacts({
        conditions: [
          {
            code: { coding: [{ code: 'N04.9', display: '肾病综合征' }] },
            id: 'cond-nephrotic',
            meta: { lastUpdated: '2026-08-24T09:05:00+08:00', versionId: '1' },
            recordedDate: '2026-08-24T09:05:00+08:00',
            verificationStatus: { coding: [{ code: 'confirmed' }] },
          },
        ],
      }),
    ]
    const nephroticResult = matchPhenotypeCandidates({
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: buildEvaluatedLedger({ candidates: nephroticCandidates, verifyExternal: true }),
      patientBirthDate: '1988-03-18',
      patientSex: 'male',
    })
    expect(nephroticResult.candidates.some(c => c.diseaseId === 'familial-hypercholesterolemia')).toBe(false)

    // Elderly CAD control with LDL 3.2 mmol/L and no family history
    const elderlyControl = buildEvaluatedLedger({
      candidates: transcribeLocalFhirFacts({
        conditions: [
          {
            code: { coding: [{ code: 'I25.103', display: '冠状动脉粥样硬化性心脏病' }] },
            id: 'cond-elderly-cad',
            meta: { lastUpdated: '2026-08-24T09:00:00+08:00', versionId: '1' },
            recordedDate: '2026-08-24T09:00:00+08:00',
            verificationStatus: { coding: [{ code: 'confirmed' }] },
          },
        ],
        observations: [
          {
            category: [{ coding: [{ code: 'laboratory' }] }],
            code: { coding: [{ code: '13457-7', display: 'LDL-C' }] },
            effectiveDateTime: '2026-08-24T09:10:00+08:00',
            id: 'obs-elderly-ldl',
            issued: '2026-08-24T09:15:00+08:00',
            meta: { lastUpdated: '2026-08-24T09:15:00+08:00', versionId: '1' },
            status: 'final',
            valueQuantity: { unit: 'mmol/L', value: 3.2 },
          },
        ],
      }),
    })
    const elderlyResult = matchPhenotypeCandidates({
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: elderlyControl,
      patientBirthDate: '1950-01-10',
      patientSex: 'male',
    })
    expect(elderlyResult.candidates).toHaveLength(0)

    // Single-clue elevated LDL without CAD/family history/persistence/xanthoma stays below threshold
    const isolatedLdl = buildEvaluatedLedger({
      candidates: transcribeLocalFhirFacts({
        observations: [
          {
            category: [{ coding: [{ code: 'laboratory' }] }],
            code: { coding: [{ code: '13457-7', display: 'LDL-C' }] },
            effectiveDateTime: '2026-08-24T09:10:00+08:00',
            id: 'obs-single-ldl',
            issued: '2026-08-24T09:15:00+08:00',
            meta: { lastUpdated: '2026-08-24T09:15:00+08:00', versionId: '1' },
            status: 'final',
            valueQuantity: { unit: 'mmol/L', value: 5.1 },
          },
        ],
      }),
    })
    const isolatedResult = matchPhenotypeCandidates({
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: isolatedLdl,
    })
    expect(isolatedResult.candidates).toHaveLength(0)
  })

  it('matches non-FH synthetic KB profiles (Alport, FCS, Fabry/ATTR ranking) and works cleanly on arbitrary caller-defined synthetic KBs with zero hardcoded disease IDs', () => {
    // 1) Alport Syndrome: 2024 CKD diagnosis + 2026 elevated creatinine (195 umol/L -> >90d persistence!) + hematuria + sensorineural hearing loss
    const alportExternal = transcribeVisibleSourceHistoryFacts({
      entries: [
        {
          clinical: {
            code: { coding: [{ code: 'N18.3', display: '慢性肾脏病3期' }] },
          },
          clinicalDate: '2024-03-10T10:00:00+08:00',
          entryId: 'vh-ckd-2024',
          resourceType: 'Condition',
          sourceReference: 'Condition/ext-ckd-2024',
          title: '既往慢性肾脏病诊断',
        },
      ],
    })
    const alportLocal = transcribeLocalFhirFacts({
      conditions: [
        {
          code: { coding: [{ code: 'H90.3', display: '双侧感音神经性耳聋' }] },
          id: 'cond-hearing',
          meta: { lastUpdated: '2026-08-24T09:00:00+08:00', versionId: '1' },
          recordedDate: '2026-08-24T09:00:00+08:00',
          verificationStatus: { coding: [{ code: 'confirmed' }] },
        },
        {
          code: { coding: [{ code: 'R31', display: '镜下血尿' }] },
          id: 'cond-hematuria',
          meta: { lastUpdated: '2026-08-24T09:00:00+08:00', versionId: '1' },
          recordedDate: '2026-08-24T09:00:00+08:00',
          verificationStatus: { coding: [{ code: 'confirmed' }] },
        },
      ],
      observations: [
        {
          category: [{ coding: [{ code: 'laboratory' }] }],
          code: { coding: [{ code: '2160-0', display: '血肌酐' }] },
          effectiveDateTime: '2026-08-24T09:10:00+08:00',
          id: 'obs-cr-2026',
          issued: '2026-08-24T09:15:00+08:00',
          meta: { lastUpdated: '2026-08-24T09:15:00+08:00', versionId: '1' },
          status: 'final',
          valueQuantity: { unit: 'umol/L', value: 195 },
        },
      ],
    })
    const alportResult = matchPhenotypeCandidates({
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: buildEvaluatedLedger({ candidates: [...alportExternal, ...alportLocal], verifyExternal: true }),
    })
    expect(alportResult.candidates[0]?.diseaseId).toBe('alport-syndrome-renal-cardiac')
    expect(alportResult.candidates[0]?.matchedPhenotypeCount).toBe(3)

    // 2) FCS: severe TG + pancreatitis
    const fcsResult = matchPhenotypeCandidates({
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: buildEvaluatedLedger({
        candidates: transcribeLocalFhirFacts({
          conditions: [
            {
              code: { coding: [{ code: 'K85.9', display: '急性胰腺炎' }] },
              id: 'cond-pancreatitis',
              meta: { lastUpdated: '2026-08-24T09:00:00+08:00', versionId: '1' },
              recordedDate: '2026-08-24T09:00:00+08:00',
              verificationStatus: { coding: [{ code: 'confirmed' }] },
            },
          ],
          observations: [
            {
              category: [{ coding: [{ code: 'laboratory' }] }],
              code: { coding: [{ code: '2571-8', display: '甘油三酯' }] },
              effectiveDateTime: '2026-08-24T09:10:00+08:00',
              id: 'obs-tg',
              issued: '2026-08-24T09:15:00+08:00',
              meta: { lastUpdated: '2026-08-24T09:15:00+08:00', versionId: '1' },
              status: 'final',
              valueQuantity: { unit: 'mmol/L', value: 16.4 },
            },
          ],
        }),
      }),
    })
    expect(fcsResult.candidates[0]?.diseaseId).toBe('familial-chylomicronemia-syndrome')

    // 3) Fabry outranks ATTR-CM when Fabry-specific GLA/acroparesthesia + LVH are present while ATTR has LVH + NT-proBNP? Wait both can rank cleanly
    const fabryVsAttr = matchPhenotypeCandidates({
      knowledgeBase: SYNTHETIC_PHENOTYPE_KB,
      ledger: buildEvaluatedLedger({
        candidates: [
          ...transcribeLocalFhirFacts({
            conditions: [
              {
                code: { coding: [{ code: 'I42.1', display: '梗阻性肥厚型心肌病' }] },
                id: 'cond-lvh',
                meta: { lastUpdated: '2026-08-24T09:00:00+08:00', versionId: '1' },
                recordedDate: '2026-08-24T09:00:00+08:00',
                verificationStatus: { coding: [{ code: 'confirmed' }] },
              },
              {
                code: { coding: [{ code: 'G60.8', display: '肢端疼痛性周围神经病变' }] },
                id: 'cond-acro',
                meta: { lastUpdated: '2026-08-24T09:00:00+08:00', versionId: '1' },
                recordedDate: '2026-08-24T09:00:00+08:00',
                verificationStatus: { coding: [{ code: 'confirmed' }] },
              },
              {
                code: { coding: [{ code: 'G56.0', display: '腕管综合征' }] },
                id: 'cond-cts',
                meta: { lastUpdated: '2025-02-10T09:00:00+08:00', versionId: '1' },
                recordedDate: '2025-02-10T09:00:00+08:00',
                verificationStatus: { coding: [{ code: 'confirmed' }] },
              },
            ],
            observations: [
              {
                category: [{ coding: [{ code: 'laboratory' }] }],
                code: { coding: [{ code: 'alpha-gal-a-activity', display: 'α-Gal A 活性显著降低' }] },
                effectiveDateTime: '2026-08-24T09:10:00+08:00',
                id: 'obs-gla',
                issued: '2026-08-24T09:15:00+08:00',
                meta: { lastUpdated: '2026-08-24T09:15:00+08:00', versionId: '1' },
                status: 'final',
                valueString: '显著降低',
              },
            ],
          }),
          ...transcribeBedsideQuestionnaireFacts({ revisions: [] }),
        ],
      }),
    })
    expect(fabryVsAttr.candidates.map(c => c.diseaseId)).toEqual([
      'fabry-cardiomyopathy-renal',
      'transthyretin-amyloid-cardiomyopathy',
    ])
    expect(fabryVsAttr.candidates[0]!.confidenceScore).toBeGreaterThan(fabryVsAttr.candidates[1]!.confidenceScore)

    // 4) Arbitrary caller-defined KB (zero dependency on SYNTHETIC_PHENOTYPE_KB or hardcoded disease IDs)
    const customKb: PhenotypeKnowledgeBase = phenotypeKnowledgeBaseSchema.parse({
      version: 'custom-test.r1',
      phenotypeRules: [
        {
          domain: 'other',
          labelEn: 'Novel Marker X',
          labelZh: '合成标志物 X',
          matcher: { categories: ['laboratory'], conceptCodes: ['X-MARK-1'], minValue: 10 },
          phenotypeCode: 'PHENO-X',
        },
        {
          domain: 'other',
          labelEn: 'Novel Feature Y',
          labelZh: '合成表型 Y',
          matcher: { categories: ['diagnosis'], codePatterns: ['^SYNTH\\.Y'] },
          phenotypeCode: 'PHENO-Y',
        },
      ],
      candidates: [
        {
          diseaseId: 'synthetic-novel-syndrome-z',
          minMatchedTerms: 2,
          minScoreThreshold: 0.7,
          recommendedWorkupZh: ['复核合成标志物 X'],
          referralSuggestionZh: '转诊合成专病组',
          specialty: 'cardiology',
          titleEn: 'Synthetic Novel Syndrome Z',
          titleZh: '合成新综合征 Z',
          weightedTerms: [
            { phenotypeCode: 'PHENO-X', rationaleZh: '标志物 X 升高', weight: 0.45 },
            { phenotypeCode: 'PHENO-Y', rationaleZh: '伴表型 Y', weight: 0.45 },
          ],
        },
      ],
    })

    const customMatch = matchPhenotypeCandidates({
      knowledgeBase: customKb,
      ledger: buildEvaluatedLedger({
        candidates: transcribeLocalFhirFacts({
          conditions: [
            {
              code: { coding: [{ code: 'SYNTH.Y1', display: '合成表型Y1' }] },
              id: 'cond-sy',
              meta: { lastUpdated: '2026-08-24T09:00:00+08:00', versionId: '1' },
              recordedDate: '2026-08-24T09:00:00+08:00',
              verificationStatus: { coding: [{ code: 'confirmed' }] },
            },
          ],
          observations: [
            {
              category: [{ coding: [{ code: 'laboratory' }] }],
              code: { coding: [{ code: 'X-MARK-1', display: '标志物X' }] },
              effectiveDateTime: '2026-08-24T09:10:00+08:00',
              id: 'obs-sx',
              issued: '2026-08-24T09:15:00+08:00',
              meta: { lastUpdated: '2026-08-24T09:15:00+08:00', versionId: '1' },
              status: 'final',
              valueQuantity: { unit: 'U/L', value: 42 },
            },
          ],
        }),
      }),
    })
    expect(customMatch.candidates).toHaveLength(1)
    expect(customMatch.candidates[0]?.diseaseId).toBe('synthetic-novel-syndrome-z')
    expect(customMatch.candidates[0]?.confidenceScore).toBe(0.9)
    expect(customMatch.candidates[0]?.packId).toBeNull()
    expect(customMatch.llmInvocationCount).toBe(0)
  })
})
