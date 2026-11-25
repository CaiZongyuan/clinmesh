import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import { describe, expect, it } from 'vitest'
import {
  ConceptVocabularyError,
  PUBLIC_CONCEPT_VOCABULARY,
  evaluateConceptMappingEligibility,
  expandSearchQueryWithApprovedSynonyms,
  getConceptAncestors,
  getConceptDescendants,
  mergeThreeLayerConceptVocabulary,
  resolveEffectiveConceptVocabulary,
  resolveLedgerFactsForConcept,
  resolvePharmacologyClassesFromVocabulary,
  validateAndNormalizeVocabularyOverride,
} from './concept-vocabulary.ts'
import { evaluatePackTrigger, validateAndParseDiseasePack } from './disease-pack.ts'

function makeFact(overrides: Partial<ClinicalFact> & Pick<ClinicalFact, 'factId' | 'category' | 'itemCode' | 'value'>): ClinicalFact {
  return {
    clinicianVerification: {
      note: null,
      verified: false,
      verifiedAt: null,
      verifiedByActorId: null,
      verifiedByPractitionerId: null,
    },
    conflictingFactIds: [],
    effectiveAt: '2026-08-24T09:00:00+08:00',
    eligibleForScoringAndRedLine: true,
    ineligibleReasons: [],
    ingestedAt: '2026-08-24T09:05:00+08:00',
    institutionScope: 'local',
    isExpiredAtAsOf: false,
    mappingVersion: '2026-11-24.r1',
    method: null,
    orderedAt: '2026-08-24T08:40:00+08:00',
    presence: 'present',
    provenance: {
      recordId: overrides.factId,
      recordType: 'Observation',
      recordVersion: '1',
      sourceSystemId: 'clinmesh-his-fhir',
    },
    qualityFlags: [],
    recordStatus: 'final',
    relation: { supersededByFactId: null, supersedesFactId: null },
    reportedAt: '2026-08-24T09:10:00+08:00',
    requiresRecheckPrompt: false,
    specimenOrSite: null,
    suspiciousReasons: [],
    validityDays: 30,
    verificationStatus: 'confirmed',
    ...overrides,
  }
}

function makeLedger(facts: ClinicalFact[], asOf = '2026-08-24T12:00:00+08:00'): ClinicalFactLedger {
  return {
    facts,
    includeSuperseded: false,
    patientId: 'patient-vocab-1',
    subjectId: 'case-vocab-1',
    subjectKind: 'outpatient',
    summary: {
      conflictCount: 0,
      eligibleCount: facts.filter(f => f.eligibleForScoringAndRedLine).length,
      expiredCount: 0,
      externalUnverifiedCount: 0,
      notAskedCount: 0,
      supersededCount: 0,
      suspiciousCount: 0,
      totalFacts: facts.length,
      verifiedExternalCount: 0,
    },
    trace: {
      evaluatedAsOf: asOf,
      hospitalId: 'hospital-synthetic-clinmesh',
      mappingVersion: '2026-11-24.r1',
    },
  }
}

describe('concept-vocabulary core engine', () => {
  it('provides public 3-layer hierarchy, pharmacology classes, ancestors & descendants', () => {
    expect(getConceptAncestors('nstemi', PUBLIC_CONCEPT_VOCABULARY)).toEqual([
      'myocardial-infarction',
      'acute-coronary-syndrome',
      'coronary-artery-disease',
    ])
    expect(getConceptDescendants('antiplatelet', PUBLIC_CONCEPT_VOCABULARY)).toEqual([
      'antiplatelet-aspirin',
      'p2y12',
    ])
    expect(resolvePharmacologyClassesFromVocabulary(['penicillin'])).toEqual([
      'penicillin',
      'antibacterial',
      'pharmacology-class',
    ])
    expect(resolvePharmacologyClassesFromVocabulary(['calcium-channel-blocker'])).toEqual([
      'ccb',
      'cardiovascular-therapy',
      'pharmacology-class',
    ])
    expect(resolvePharmacologyClassesFromVocabulary(['antiplatelet-aspirin', 'statin'])).toEqual(
      expect.arrayContaining(['antiplatelet-aspirin', 'antiplatelet', 'statin', 'lipid-lowering', 'pharmacology-class']),
    )
    for (const extraClass of ['fluid', 'antiviral', 'analgesic']) {
      expect(resolvePharmacologyClassesFromVocabulary([extraClass])).toEqual(
        expect.arrayContaining([extraClass, 'pharmacology-class']),
      )
    }
  })

  it('merges 3 layers cleanly and enforces hospital leaf-only, non-overwrite, cycle & target checks', () => {
    const packLayer: ConceptVocabulary = {
      mappings: [
        {
          effectiveDate: '2026-06-01',
          id: 'pack-map-exact',
          relation: 'exact',
          reviewStatus: 'approved',
          reviewerId: 'rev-pack-1',
          sourceCode: 'SYN-HS-CTNI',
          sourceDisplay: '合成高敏肌钙蛋白I',
          sourceSystem: 'urn:clinmesh:synthetic',
          targetConceptCode: '89579-7',
          version: '1.0.0',
        },
      ],
      nodes: [
        {
          code: 'syn-cad-subtype',
          displayZh: '合成冠脉亚型',
          domain: 'diagnosis',
          layer: 'disease-pack',
          packId: 'syn-pack',
          parentCode: 'coronary-artery-disease',
          synonyms: [],
        },
      ],
      version: 'pack-1.0.0',
    }
    const hospitalLayer: ConceptVocabulary = {
      mappings: [
        {
          effectiveDate: '2026-07-01',
          hospitalId: 'hosp-alpha',
          id: 'hosp-map-leaf',
          relation: 'exact',
          reviewStatus: 'approved',
          reviewerId: 'rev-hosp-1',
          sourceCode: 'HOSP-LAB-HSCTNI',
          sourceDisplay: '本院检验高敏肌钙蛋白',
          sourceSystem: 'urn:hosp:alpha',
          targetConceptCode: 'hosp-leaf-troponin',
          version: '1.0.0',
        },
      ],
      nodes: [
        {
          code: 'hosp-leaf-troponin',
          displayZh: '本院高敏肌钙蛋白检测叶节点',
          domain: 'laboratory',
          hospitalId: 'hosp-alpha',
          layer: 'hospital',
          parentCode: '89579-7',
          synonyms: ['本院hs-cTnI'],
        },
      ],
      version: 'hosp-1.0.0',
    }

    const merged = mergeThreeLayerConceptVocabulary({ hospitalLayer, packLayer })
    expect(merged.nodes.some(n => n.code === 'syn-cad-subtype')).toBe(true)
    expect(merged.nodes.some(n => n.code === 'hosp-leaf-troponin')).toBe(true)
    expect(getConceptAncestors('hosp-leaf-troponin', merged)).toEqual(['89579-7', 'cardiac-troponin'])

    // Reject pack overwriting public node
    expect(() => mergeThreeLayerConceptVocabulary({
      packLayer: {
        mappings: [],
        nodes: [{
          code: '2160-0',
          displayZh: '覆盖血清肌酐',
          domain: 'laboratory',
          layer: 'disease-pack',
          parentCode: null,
          synonyms: [],
        }],
        version: 'bad',
      },
    })).toThrow(ConceptVocabularyError)

    // Reject hospital node acting as parentCode (even for another hospital node!)
    expect(() => mergeThreeLayerConceptVocabulary({
      hospitalLayer: {
        mappings: [],
        nodes: [
          {
            code: 'hosp-parent',
            displayZh: '医院父节点',
            domain: 'laboratory',
            layer: 'hospital',
            parentCode: '2160-0',
            synonyms: [],
          },
          {
            code: 'hosp-child',
            displayZh: '医院子节点',
            domain: 'laboratory',
            layer: 'hospital',
            parentCode: 'hosp-parent',
            synonyms: [],
          },
        ],
        version: 'bad-hosp-parent',
      },
    })).toThrow(ConceptVocabularyError)

    // Reject hospital declaring layer !== 'hospital'
    expect(() => mergeThreeLayerConceptVocabulary({
      hospitalLayer: {
        mappings: [],
        nodes: [{
          code: 'hosp-wrong-layer',
          displayZh: '错误层级',
          domain: 'laboratory',
          layer: 'disease-pack',
          parentCode: '2160-0',
          synonyms: [],
        }],
        version: 'bad-layer',
      },
    })).toThrow(ConceptVocabularyError)

    // Reject cycle in pack layer
    expect(() => mergeThreeLayerConceptVocabulary({
      packLayer: {
        mappings: [],
        nodes: [
          { code: 'cycle-a', displayZh: '环A', domain: 'diagnosis', layer: 'disease-pack', parentCode: 'cycle-b', synonyms: [] },
          { code: 'cycle-b', displayZh: '环B', domain: 'diagnosis', layer: 'disease-pack', parentCode: 'cycle-a', synonyms: [] },
        ],
        version: 'bad-cycle',
      },
    })).toThrow(ConceptVocabularyError)

    // Reject missing parentCode
    expect(() => mergeThreeLayerConceptVocabulary({
      packLayer: {
        mappings: [],
        nodes: [{
          code: 'orphan-node',
          displayZh: '缺失父节点',
          domain: 'diagnosis',
          layer: 'disease-pack',
          parentCode: 'non-existent-parent',
          synonyms: [],
        }],
        version: 'bad-parent',
      },
    })).toThrow(ConceptVocabularyError)

    // Reject mapping pointing to unknown targetConceptCode
    expect(() => mergeThreeLayerConceptVocabulary({
      packLayer: {
        mappings: [{
          effectiveDate: '2026-01-01',
          id: 'bad-target-map',
          relation: 'exact',
          reviewStatus: 'approved',
          reviewerId: 'rev-1',
          sourceCode: 'X',
          sourceDisplay: 'X',
          sourceSystem: 'urn:test',
          targetConceptCode: 'unknown-target',
          version: '1.0.0',
        }],
        nodes: [],
        version: 'bad-map',
      },
    })).toThrow(ConceptVocabularyError)
  })

  it('AC9: restricts scoring/red-line strictly to approved+exact+effective mappings while close/broader/unapproved never qualify', () => {
    const vocab = mergeThreeLayerConceptVocabulary({
      packLayer: {
        mappings: [
          {
            effectiveDate: '2026-06-01',
            id: 'map-close-troponin',
            relation: 'close',
            reviewStatus: 'approved',
            reviewerId: 'rev-1',
            sourceCode: '10839-9',
            sourceDisplay: '常规cTnI',
            sourceSystem: 'http://loinc.org',
            targetConceptCode: '89579-7',
            version: '1.0.0',
          },
          {
            effectiveDate: '2026-06-01',
            id: 'map-exact-approved',
            relation: 'exact',
            reviewStatus: 'approved',
            reviewerId: 'rev-1',
            sourceCode: 'SYN-HS-CTNI',
            sourceDisplay: '合成高敏肌钙蛋白I',
            sourceSystem: 'urn:syn',
            targetConceptCode: '89579-7',
            version: '1.0.0',
          },
          {
            effectiveDate: '2026-06-01',
            id: 'map-exact-proposed',
            relation: 'exact',
            reviewStatus: 'proposed',
            reviewerId: null,
            sourceCode: 'SYN-PROP-CTNI',
            sourceDisplay: '待审核高敏肌钙蛋白I',
            sourceSystem: 'urn:syn',
            targetConceptCode: '89579-7',
            version: '1.0.0',
          },
          {
            effectiveDate: '2026-06-01',
            id: 'map-exact-reviewed-only',
            relation: 'exact',
            reviewStatus: 'reviewed',
            reviewerId: 'rev-1',
            sourceCode: 'SYN-REV-CTNI',
            sourceDisplay: '仅初审高敏肌钙蛋白I',
            sourceSystem: 'urn:syn',
            targetConceptCode: '89579-7',
            version: '1.0.0',
          },
          {
            effectiveDate: '2026-06-01',
            id: 'map-exact-deprecated',
            relation: 'exact',
            reviewStatus: 'deprecated',
            reviewerId: 'rev-1',
            sourceCode: 'SYN-DEP-CTNI',
            sourceDisplay: '废止高敏肌钙蛋白I',
            sourceSystem: 'urn:syn',
            targetConceptCode: '89579-7',
            version: '1.0.0',
          },
          {
            effectiveDate: '2026-10-01',
            id: 'map-exact-future',
            relation: 'exact',
            reviewStatus: 'approved',
            reviewerId: 'rev-1',
            sourceCode: 'SYN-FUT-CTNI',
            sourceDisplay: '未生效高敏肌钙蛋白I',
            sourceSystem: 'urn:syn',
            targetConceptCode: '89579-7',
            version: '1.0.0',
          },
          {
            effectiveDate: '2026-06-01',
            id: 'map-broader',
            relation: 'broader',
            reviewStatus: 'approved',
            reviewerId: 'rev-1',
            sourceCode: 'SYN-BROAD',
            sourceDisplay: '泛心肌标志物',
            sourceSystem: 'urn:syn',
            targetConceptCode: '89579-7',
            version: '1.0.0',
          },
        ],
        nodes: [],
        version: 'ac9-test',
      },
    })

    const closeEligibility = evaluateConceptMappingEligibility(
      vocab.mappings.find(m => m.id === 'map-close-troponin')!,
      { asOfDate: '2026-08-24' },
    )
    expect(closeEligibility.eligibleForScoreAndRedLine).toBe(false)
    expect(closeEligibility.usableForHint).toBe(true)
    expect(closeEligibility.reasonCode).toBe('MAPPING_CLOSE_HINT_ONLY')
    expect(closeEligibility.explanationZh).toBe('仅作为相近映射提示，不参与临床算分与红线拦截')

    const futureEligibility = evaluateConceptMappingEligibility(
      vocab.mappings.find(m => m.id === 'map-exact-future')!,
      { asOfDate: '2026-08-24' },
    )
    expect(futureEligibility.eligibleForScoreAndRedLine).toBe(false)
    expect(futureEligibility.usableForHint).toBe(false)
    expect(futureEligibility.reasonCode).toBe('MAPPING_NOT_EFFECTIVE')

    const ledger = makeLedger([
      makeFact({
        category: 'laboratory',
        factId: 'fact-conv-ctni',
        itemCode: { code: '10839-9', display: '常规cTnI', system: 'http://loinc.org' },
        value: { normalizedValue: { unit: 'ng/mL', value: 0.15 }, rawText: '0.15 ng/mL' },
      }),
      makeFact({
        category: 'laboratory',
        factId: 'fact-proposed-ctni',
        itemCode: { code: 'SYN-PROP-CTNI', display: '待审hs-cTnI', system: 'urn:syn' },
        value: { normalizedValue: { unit: 'ng/L', value: 80 }, rawText: '80 ng/L' },
      }),
      makeFact({
        category: 'laboratory',
        factId: 'fact-reviewed-ctni',
        itemCode: { code: 'SYN-REV-CTNI', display: '初审hs-cTnI', system: 'urn:syn' },
        value: { normalizedValue: { unit: 'ng/L', value: 85 }, rawText: '85 ng/L' },
      }),
      makeFact({
        category: 'laboratory',
        factId: 'fact-deprecated-ctni',
        itemCode: { code: 'SYN-DEP-CTNI', display: '废止hs-cTnI', system: 'urn:syn' },
        value: { normalizedValue: { unit: 'ng/L', value: 90 }, rawText: '90 ng/L' },
      }),
      makeFact({
        category: 'laboratory',
        factId: 'fact-future-ctni',
        itemCode: { code: 'SYN-FUT-CTNI', display: '未来hs-cTnI', system: 'urn:syn' },
        value: { normalizedValue: { unit: 'ng/L', value: 95 }, rawText: '95 ng/L' },
      }),
      makeFact({
        category: 'laboratory',
        factId: 'fact-broad',
        itemCode: { code: 'SYN-BROAD', display: '泛心肌标志物', system: 'urn:syn' },
        value: { normalizedValue: { unit: 'ng/L', value: 70 }, rawText: '70 ng/L' },
      }),
      makeFact({
        category: 'laboratory',
        factId: 'fact-exact-hs-ctni',
        itemCode: { code: 'SYN-HS-CTNI', display: '合成高敏肌钙蛋白I', system: 'urn:syn' },
        value: { normalizedValue: { unit: 'ng/L', value: 120 }, rawText: '120 ng/L' },
      }),
    ])

    // Scoring/red-line mode accepts ONLY approved+exact+effective ('fact-exact-hs-ctni')
    const scoringRes = resolveLedgerFactsForConcept({
      asOfDate: '2026-08-24',
      ledger,
      mode: 'scoring-or-redline',
      targetConceptCode: '89579-7',
      vocabulary: vocab,
    })
    expect(scoringRes.facts.map(f => f.factId)).toEqual(['fact-exact-hs-ctni'])
    expect(scoringRes.hintOnlyMatches.map(m => m.fact.factId)).toEqual(
      expect.arrayContaining(['fact-conv-ctni', 'fact-broad']),
    )
    expect(scoringRes.excludedMatches.map(m => m.fact.factId)).toEqual(
      expect.arrayContaining([
        'fact-conv-ctni',
        'fact-proposed-ctni',
        'fact-reviewed-ctni',
        'fact-deprecated-ctni',
        'fact-future-ctni',
        'fact-broad',
      ]),
    )

    // Hint mode exposes approved close/broader hints, still blocks proposed/reviewed/deprecated/future
    const hintRes = resolveLedgerFactsForConcept({
      asOfDate: '2026-08-24',
      ledger,
      mode: 'hint',
      targetConceptCode: '89579-7',
      vocabulary: vocab,
    })
    expect(hintRes.facts.map(f => f.factId)).toEqual([
      'fact-conv-ctni',
      'fact-broad',
      'fact-exact-hs-ctni',
    ])

    // Trigger evaluation with vocabulary enforces exact+approved+effective rule too!
    const closeOnlyLedger = makeLedger([ledger.facts[0]!])
    const triggerBlocked = evaluatePackTrigger(
      { category: 'laboratory', itemCodes: ['89579-7'], kind: 'fact', presence: 'present', requireEligible: true },
      closeOnlyLedger,
      { asOf: '2026-08-24T12:00:00+08:00', vocabulary: vocab },
    )
    expect(triggerBlocked.matched).toBe(false)

    const exactLedger = makeLedger([ledger.facts[6]!])
    const triggerAllowed = evaluatePackTrigger(
      { category: 'laboratory', itemCodes: ['89579-7'], kind: 'fact', presence: 'present', requireEligible: true },
      exactLedger,
      { asOf: '2026-08-24T12:00:00+08:00', vocabulary: vocab },
    )
    expect(triggerAllowed.matched).toBe(true)
    expect(triggerAllowed.matchedFactIds).toEqual(['fact-exact-hs-ctni'])
  })

  it('expands search queries with approved exact Chinese medical synonyms only', () => {
    const vocabWithUnapproved = mergeThreeLayerConceptVocabulary({
      packLayer: {
        mappings: [
          {
            effectiveDate: '2026-06-01',
            id: 'unapproved-mi-alias',
            relation: 'exact',
            reviewStatus: 'proposed',
            reviewerId: null,
            sourceCode: 'UNAPPROVED-MI-CODE',
            sourceDisplay: '未审核心梗别名',
            sourceSystem: 'urn:syn',
            targetConceptCode: 'myocardial-infarction',
            version: '1.0.0',
          },
          {
            effectiveDate: '2026-06-01',
            id: 'close-mi-alias',
            relation: 'close',
            reviewStatus: 'approved',
            reviewerId: 'rev-1',
            sourceCode: 'CLOSE-CHEST-PAIN',
            sourceDisplay: '心前区不适',
            sourceSystem: 'urn:syn',
            targetConceptCode: 'myocardial-infarction',
            version: '1.0.0',
          },
        ],
        nodes: [],
        version: '1.0.0',
      },
    })

    const miExpanded = expandSearchQueryWithApprovedSynonyms('心梗', vocabWithUnapproved)
    expect(miExpanded).toEqual(expect.arrayContaining(['心梗', '心肌梗死', 'myocardial-infarction', 'MI']))
    expect(miExpanded).not.toContain('UNAPPROVED-MI-CODE')
    expect(miExpanded).not.toContain('未审核心梗别名')
    expect(miExpanded).not.toContain('心前区不适')

    const cadExpanded = expandSearchQueryWithApprovedSynonyms('冠心病', vocabWithUnapproved)
    expect(cadExpanded).toEqual(expect.arrayContaining(['冠心病', '冠状动脉粥样硬化性心脏病', 'coronary-artery-disease']))

    const cadFullExpanded = expandSearchQueryWithApprovedSynonyms('冠状动脉粥样硬化性心脏病', vocabWithUnapproved)
    expect(cadFullExpanded).toContain('冠心病')

    // Non-public disease-pack node.synonyms cannot trigger expansion without approved+exact mapping,
    // and mappings effective in the future are excluded at earlier asOfDate
    const datedAndScopedVocab = mergeThreeLayerConceptVocabulary({
      packLayer: {
        mappings: [
          {
            effectiveDate: '2026-10-01',
            id: 'future-mi-alias',
            relation: 'exact',
            reviewStatus: 'approved',
            reviewerId: 'rev-1',
            sourceCode: 'FUTURE-MI',
            sourceDisplay: '未来心梗同义词',
            sourceSystem: 'urn:syn',
            targetConceptCode: 'myocardial-infarction',
            version: '1.0.0',
          },
        ],
        nodes: [{
          code: 'pack-scoped-syndrome',
          displayZh: '包级自定义综合征',
          domain: 'diagnosis',
          layer: 'disease-pack',
          parentCode: 'coronary-artery-disease',
          synonyms: ['未批准节点别名'],
        }],
        version: '1.0.0',
      },
    })
    expect(expandSearchQueryWithApprovedSynonyms('心梗', datedAndScopedVocab, { asOfDate: '2026-08-24' })).not.toContain('未来心梗同义词')
    expect(expandSearchQueryWithApprovedSynonyms('心梗', datedAndScopedVocab, { asOfDate: '2026-10-05' })).toContain('未来心梗同义词')
    expect(expandSearchQueryWithApprovedSynonyms('未批准节点别名', datedAndScopedVocab)).toEqual(['未批准节点别名'])

    // validateAndNormalizeVocabularyOverride rejects mutated public hierarchy
    const tamperedPublicVocab: ConceptVocabulary = {
      ...PUBLIC_CONCEPT_VOCABULARY,
      nodes: [
        ...PUBLIC_CONCEPT_VOCABULARY.nodes.filter(n => n.code !== '89579-7'),
        {
          code: '89579-7',
          displayZh: '高敏肌钙蛋白 I',
          domain: 'laboratory',
          layer: 'public',
          parentCode: null,
          synonyms: [],
        },
      ],
    }
    expect(() => validateAndNormalizeVocabularyOverride(tamperedPublicVocab)).toThrow(ConceptVocabularyError)
    expect(resolveEffectiveConceptVocabulary()).toBe(PUBLIC_CONCEPT_VOCABULARY)
  })

  it('validates embedded conceptVocabulary inside DiseasePack on load', () => {
    expect(() => validateAndParseDiseasePack({
      conceptVocabulary: {
        mappings: [],
        nodes: [{
          code: '2160-0',
          displayZh: '篡改血清肌酐',
          domain: 'laboratory',
          layer: 'disease-pack',
          parentCode: null,
          synonyms: [],
        }],
        version: '1.0.0',
      },
      examSuite: {
        cases: [{ caseId: 'c1', expectedActive: true, titleZh: '测试' }],
        passThreshold: 0.8,
      },
      manifest: {
        dependencies: [],
        fingerprint: 'a'.repeat(64),
        id: 'bad-vocab-pack',
        packType: 'recognition',
        specialty: 'synthetic-medicine',
        status: 'active',
        supportedTasks: ['triage'],
        titleEn: 'Bad Vocab Pack',
        titleZh: '非法词表包',
        version: '1.0.0',
      },
      recognitionCard: {
        differentialPackIds: [],
        escalationGuidanceZh: '转诊提示',
        id: 'card-1',
        summaryZh: '摘要',
        titleZh: '标题',
      },
      toolPolicy: { allowedTools: ['outpatient.disease-packs.read'], forbiddenActions: [] },
      triggers: [{
        condition: { category: 'diagnosis', itemCodes: ['SYN-DX-01'], kind: 'fact', presence: 'present', requireEligible: true },
        id: 't1',
      }],
    })).toThrow(ConceptVocabularyError)
  })
})
