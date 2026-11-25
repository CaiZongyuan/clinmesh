import { createHash } from 'node:crypto'
import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import type { ClinicalReviewerRecord, KnowledgeSnapshot } from '@clinmesh/contracts/knowledge-claims'
import {
  SYNTHETIC_TEST_GUIDELINE_DISCLAIMER_ZH,
  SYNTHETIC_TEST_GUIDELINE_MARKER,
  type DraftedKnowledgeClaimCandidate,
  type SyntheticTestGuidelineDoc,
} from '@clinmesh/contracts/knowledge-pipeline'
import { describe, expect, it } from 'vitest'
import {
  PUBLIC_CONCEPT_VOCABULARY,
  mergeThreeLayerConceptVocabulary,
  resolveLedgerFactsForConcept,
  resolveSearchQuerySynonymExpansions,
} from './concept-vocabulary.ts'
import { evaluatePackTrigger, mergeThreeLayerPack, validateAndParseDiseasePack } from './disease-pack.ts'
import { KnowledgeClaimError } from './knowledge-claims.ts'
import {
  KnowledgePipelineError,
  adjudicateGuidelineClaimConflict,
  buildConceptMappingImpactReport,
  buildGuidelineSourceDiffReport,
  countOnlineKnowledgeAndVocabularyWriteTools,
  createDeterministicClaimDraftStream,
  createPassageBackedDeterministicDraftStream,
  runOfflineKnowledgeClaimPipeline,
} from './knowledge-pipeline.ts'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const REVIEWER: ClinicalReviewerRecord = {
  licenseVerified: true,
  nameZh: '王主任',
  reviewerId: 'clinician-rev-560',
  specialty: 'cardiology',
}

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
    patientId: 'pat-pipe-1',
    subjectId: 'adm-pipe-1',
    subjectKind: 'inpatient',
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

function makeSyntheticV1Doc(): SyntheticTestGuidelineDoc {
  const passages = [
    {
      conceptCodes: ['coronary-artery-disease', 'syn-syndrome-dx'],
      locator: 'PDF 物理第 35 页',
      page: 35,
      text: 'In patients undergoing PCI, DES should be used in preference to BMS. Synthetic test passage; assess the clinical population.',
      topicIds: ['syn-pci-guidance-card'],
    },
    {
      conceptCodes: ['coronary-artery-disease', 'syn-syndrome-dx'],
      locator: 'PDF 物理第 36 页',
      page: 36,
      text: 'OCT is a reasonable alternative, except in ostial left main disease.',
      topicIds: ['syn-pci-guidance-card'],
    },
  ]
  return {
    disclaimerZh: SYNTHETIC_TEST_GUIDELINE_DISCLAIMER_ZH,
    passages,
    publisher: '合成医学指南工作组',
    sha256: sha256(JSON.stringify(passages)),
    sourceId: 'syn-syndrome-guideline',
    syntheticTestMarker: SYNTHETIC_TEST_GUIDELINE_MARKER,
    title: '合成测试综合征诊疗指导意见（v1）',
    version: '1.0.0',
  }
}

function makeSyntheticEffectivePack(vocabulary?: ConceptVocabulary) {
  const rawPack = {
    ...(vocabulary === undefined ? {} : { conceptVocabulary: vocabulary }),
    examSuite: {
      cases: [
        {
          caseId: 'syn-exam-case-1',
          expectedActive: true,
          expectedBlockedTaskIds: ['pci-preop-guideline-advice'],
          expectedStageId: 'baseline-assessment',
          titleZh: '合成测试综合征基线回归例',
        },
        {
          caseId: 'syn-exam-case-negative',
          expectedActive: false,
          titleZh: '非目标人群阴性对照例',
        },
      ],
      passThreshold: 0.85,
    },
    formulaRefs: [{ formulaId: 'ckd-epi-2021', version: 1 }],
    inapplicablePopulations: [],
    indicationRules: [
      {
        condition: {
          category: 'laboratory',
          itemCodes: ['89579-7'],
          kind: 'fact',
          minValue: 50,
          presence: 'present',
          requireEligible: true,
        },
        id: 'hs-ctni-workup-indication',
        itemCodePattern: '^(?:89579-7|SYN-HS-CTNI)$',
        orderKind: 'laboratory',
        rationaleZh: '高敏肌钙蛋白升高时需启动急诊复查',
      },
      {
        condition: {
          category: 'diagnosis',
          itemCodes: ['I25.103'],
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        id: 'creatinine-workup-indication',
        itemCodePattern: '^2160-0$',
        orderKind: 'laboratory',
        rationaleZh: '术前评估血清肌酐',
      },
    ],
    manifest: {
      dependencies: [],
      fingerprint: '0'.repeat(64),
      id: 'synthetic-test-syndrome',
      packType: 'full',
      specialty: 'synthetic-medicine',
      status: 'active',
      supportedTasks: ['pci-preop-guideline-advice'],
      titleEn: 'Synthetic Test Syndrome Pack',
      titleZh: '合成测试综合征专病包',
      version: '1.0.0',
    },
    qualityTightenings: {
      examPassThreshold: 0.85,
      redLineRules: [
        {
          conditionSummary: '高敏肌钙蛋白显著升高须先完成急诊评估红线',
          id: 'hs-ctni-red-line',
          itemCode: '89579-7',
        },
        {
          conditionSummary: '肾功能不全禁止直接开立高肾毒性药物',
          id: 'renal-red-line',
          itemCode: '2160-0',
        },
      ],
      validityOverrides: [{ itemCode: '2160-0', maxValidityDays: 14 }],
    },
    readinessTasks: [
      {
        criticalItems: [
          {
            alternateItemCodes: ['SYN-HS-CTNI'],
            category: 'laboratory',
            itemCode: '89579-7',
            labelZh: '高敏肌钙蛋白 I',
          },
        ],
        relevantItemCodes: ['89579-7'],
        secondaryItems: [],
        taskId: 'pci-preop-guideline-advice',
        titleZh: 'PCI 术前指南参考意见',
      },
    ],
    stages: [
      {
        entryCondition: {
          category: 'diagnosis',
          itemCodes: ['I25.103', 'SYN-DX-01'],
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        id: 'baseline-assessment',
        order: 1,
        orderSetIds: ['cad-admission-baseline'],
        questionnaireItemCodes: [],
        taskIds: ['pci-preop-guideline-advice'],
        titleZh: '基线评估期',
        topicIds: ['syn-pci-guidance-card'],
      },
    ],
    toolPolicy: {
      allowedTools: ['inpatient.disease-packs.read', 'outpatient.disease-packs.read'],
      forbiddenActions: [],
    },
    triggers: [
      {
        condition: {
          kind: 'anyOf',
          nodes: [
            {
              category: 'diagnosis',
              itemCodes: ['I25.103', 'SYN-DX-01'],
              kind: 'fact',
              presence: 'present',
              requireEligible: true,
            },
            {
              category: 'laboratory',
              itemCodes: ['89579-7'],
              kind: 'fact',
              minValue: 50,
              presence: 'present',
              requireEligible: true,
            },
          ],
        },
        id: 'synthetic-dx-or-troponin-trigger',
      },
    ],
  }
  const parsed = validateAndParseDiseasePack(rawPack)
  return mergeThreeLayerPack({ diseasePack: parsed })
}

describe('knowledge-pipeline core engine (AC33–AC36)', () => {
  it('AC33: verifies 0 online knowledge/vocabulary write tools and runs deterministic pipeline capping at auto-verified without reviewer', () => {
    expect(countOnlineKnowledgeAndVocabularyWriteTools()).toBe(0)

    const v1Doc = makeSyntheticV1Doc()
    const vocab = mergeThreeLayerConceptVocabulary({
      packLayer: {
        mappings: [],
        nodes: [{
          code: 'syn-syndrome-dx',
          displayZh: '合成测试综合征诊断',
          domain: 'diagnosis',
          layer: 'disease-pack',
          packId: 'synthetic-test-syndrome',
          parentCode: 'coronary-artery-disease',
          synonyms: ['SYN-DX-01'],
        }],
        version: '1.0.0',
      },
    })

    const validAnchor = {
      locator: 'PDF 物理第 35 页',
      page: 35,
      quoteFragment: 'In patients undergoing PCI, DES should be used in preference to BMS',
      sha256: v1Doc.sha256,
      sourceId: v1Doc.sourceId,
      title: v1Doc.title,
      version: v1Doc.version,
    }
    const baseCondition = {
      category: 'diagnosis' as const,
      itemCodes: ['I25.103'],
      kind: 'fact' as const,
      presence: 'present' as const,
      requireEligible: true,
    }

    const candidates: DraftedKnowledgeClaimCandidate[] = [
      // 1. Valid candidate -> passes all checks, capped at auto-verified
      {
        anchor: validAnchor,
        applicabilityCondition: baseCondition,
        associatedConceptCodes: ['coronary-artery-disease', 'syn-syndrome-dx'],
        candidateId: 'cand-valid',
        claimId: 'claim-valid-des',
        packId: 'synthetic-test-syndrome',
        statementZh: '拟行 PCI 的患者优先使用药物洗脱支架（DES）而非金属裸支架（BMS）。',
        topicId: 'syn-pci-guidance-card',
      },
      // 2. Missing anchor -> CLAIM_ANCHOR_MISSING
      {
        applicabilityCondition: baseCondition,
        associatedConceptCodes: ['coronary-artery-disease'],
        candidateId: 'cand-no-anchor',
        packId: 'synthetic-test-syndrome',
        statementZh: '缺少锚点的候选主张',
        topicId: 'syn-pci-guidance-card',
      },
      // 3. Wrong sha256 -> CLAIM_SOURCE_UNVERIFIED
      {
        anchor: { ...validAnchor, sha256: 'f'.repeat(64) },
        applicabilityCondition: baseCondition,
        associatedConceptCodes: ['coronary-artery-disease'],
        candidateId: 'cand-bad-sha',
        packId: 'synthetic-test-syndrome',
        statementZh: '哈希不一致的主张',
        topicId: 'syn-pci-guidance-card',
      },
      // 4. Quote mismatch -> CLAIM_QUOTE_MISMATCH
      {
        anchor: { ...validAnchor, quoteFragment: 'FABRICATED QUOTE NEVER IN PASSAGE' },
        applicabilityCondition: baseCondition,
        associatedConceptCodes: ['coronary-artery-disease'],
        candidateId: 'cand-bad-quote',
        packId: 'synthetic-test-syndrome',
        statementZh: '引用不匹配的主张',
        topicId: 'syn-pci-guidance-card',
      },
      // 5. Ungrounded optional threshold / product quantity -> CLAIM_UNSUPPORTED_DETAIL
      {
        anchor: validAnchor,
        applicabilityCondition: baseCondition,
        associatedConceptCodes: ['coronary-artery-disease'],
        candidateId: 'cand-ungrounded-opt',
        optionalConditionsSpecified: {
          productQuantityNote: '30片/盒包装规格',
          thresholdNote: 'eGFR < 45 mL/min',
        },
        packId: 'synthetic-test-syndrome',
        statementZh: '拟行 PCI 的患者优先使用 DES。',
        topicId: 'syn-pci-guidance-card',
      },
      // 6. Ungrounded numeric threshold injected into statementZh -> CLAIM_UNSUPPORTED_DETAIL
      {
        anchor: validAnchor,
        applicabilityCondition: baseCondition,
        associatedConceptCodes: ['coronary-artery-disease'],
        candidateId: 'cand-ungrounded-num',
        packId: 'synthetic-test-syndrome',
        statementZh: '拟行 PCI 的患者需使用 15 mg 药物并观察 14 天。',
        topicId: 'syn-pci-guidance-card',
      },
      // 7. Unknown concept code -> CLAIM_CONCEPT_UNMAPPED
      {
        anchor: validAnchor,
        applicabilityCondition: baseCondition,
        associatedConceptCodes: ['unmapped-fake-concept'],
        candidateId: 'cand-unmapped-concept',
        packId: 'synthetic-test-syndrome',
        statementZh: '未映射概念编码的主张',
        topicId: 'syn-pci-guidance-card',
      },
    ]

    const stream = createDeterministicClaimDraftStream(candidates)
    const trialResult = runOfflineKnowledgeClaimPipeline({
      controlledDraftStream: stream,
      effectiveFrom: '2026-06-01T00:00:00Z',
      packId: 'synthetic-test-syndrome',
      snapshotVersion: '2026.06.v1',
      sourceDocument: v1Doc,
      topicId: 'syn-pci-guidance-card',
      version: '1.0.0',
      vocabulary: vocab,
    })

    expect(trialResult.draftedCount).toBe(7)
    expect(trialResult.modelStreamMode).toBe('controlled-deterministic')
    expect(trialResult.runtimeWriteToolsCount).toBe(0)
    expect(trialResult.acceptedClaims).toHaveLength(1)
    expect(trialResult.acceptedClaims[0]!.status).toBe('auto-verified')
    expect(trialResult.acceptedClaims[0]!.reviewerId).toBeNull()
    expect(trialResult.publishedSnapshot).toBeDefined()
    expect(trialResult.publishedSnapshot!.topics[0]!.status).toBe('auto-verified')
    expect(Object.isFrozen(trialResult.publishedSnapshot)).toBe(true)

    expect(trialResult.rejectedClaims).toEqual([
      expect.objectContaining({ candidateId: 'cand-no-anchor', code: 'CLAIM_ANCHOR_MISSING' }),
      expect.objectContaining({ candidateId: 'cand-bad-sha', code: 'CLAIM_SOURCE_UNVERIFIED' }),
      expect.objectContaining({ candidateId: 'cand-bad-quote', code: 'CLAIM_QUOTE_MISMATCH' }),
      expect.objectContaining({ candidateId: 'cand-ungrounded-opt', code: 'CLAIM_UNSUPPORTED_DETAIL' }),
      expect.objectContaining({ candidateId: 'cand-ungrounded-num', code: 'CLAIM_UNSUPPORTED_DETAIL' }),
      expect.objectContaining({ candidateId: 'cand-unmapped-concept', code: 'CLAIM_CONCEPT_UNMAPPED' }),
    ])

    // Unverified reviewer fails clinician gate (cannot advance past auto-verified)
    expect(() => runOfflineKnowledgeClaimPipeline({
      clinicianReviewer: { ...REVIEWER, licenseVerified: false as unknown as true },
      controlledDraftStream: createPassageBackedDeterministicDraftStream(),
      effectiveFrom: '2026-06-01T00:00:00Z',
      packId: 'synthetic-test-syndrome',
      snapshotVersion: '2026.06.v1',
      sourceDocument: v1Doc,
      topicId: 'syn-pci-guidance-card',
      version: '1.0.0',
      vocabulary: vocab,
    })).toThrow(KnowledgeClaimError)

    // Verified clinician reviewer advances cleanly to 'published'
    const publishedResult = runOfflineKnowledgeClaimPipeline({
      clinicianReviewer: REVIEWER,
      controlledDraftStream: createPassageBackedDeterministicDraftStream(),
      effectiveFrom: '2026-06-01T00:00:00Z',
      packId: 'synthetic-test-syndrome',
      snapshotVersion: '2026.06.v2',
      sourceDocument: v1Doc,
      topicId: 'syn-pci-guidance-card',
      version: '2.0.0',
      vocabulary: vocab,
    })
    expect(publishedResult.acceptedClaims).toHaveLength(2)
    expect(publishedResult.acceptedClaims.every(c => c.status === 'published' && c.reviewerId === REVIEWER.reviewerId)).toBe(true)
    expect(publishedResult.publishedSnapshot?.topics[0]?.status).toBe('published')

    // When all claims are rejected, publishedSnapshot stays omitted
    const emptyAccepted = runOfflineKnowledgeClaimPipeline({
      controlledDraftStream: createDeterministicClaimDraftStream([candidates[1]!]),
      effectiveFrom: '2026-06-01T00:00:00Z',
      packId: 'synthetic-test-syndrome',
      snapshotVersion: '2026.06.empty',
      sourceDocument: v1Doc,
      topicId: 'syn-pci-guidance-card',
      version: '1.0.0',
      vocabulary: vocab,
    })
    expect(emptyAccepted.acceptedClaims).toHaveLength(0)
    expect(emptyAccepted.publishedSnapshot).toBeUndefined()
  })

  it('AC34: computes guideline diff impact report and queues conflicts without altering existing claims before adjudication', () => {
    const v1Doc = makeSyntheticV1Doc()
    const v2Passages = [
      {
        conceptCodes: ['coronary-artery-disease', 'syn-syndrome-dx'],
        locator: 'PDF 物理第 35 页',
        page: 35,
        text: 'In patients undergoing PCI, new-generation DES should be preferred; BMS is restricted to rare exceptions.',
        topicIds: ['syn-pci-guidance-card'],
      },
      v1Doc.passages[1]!,
    ]
    const v2Doc: SyntheticTestGuidelineDoc = {
      disclaimerZh: SYNTHETIC_TEST_GUIDELINE_DISCLAIMER_ZH,
      passages: v2Passages,
      publisher: '合成医学指南工作组',
      sha256: sha256(JSON.stringify(v2Passages)),
      sourceId: 'syn-syndrome-guideline',
      syntheticTestMarker: SYNTHETIC_TEST_GUIDELINE_MARKER,
      title: '合成测试综合征诊疗指导意见（v2）',
      version: '2.0.0',
    }

    const effectivePack = makeSyntheticEffectivePack()
    const baselineSnapshot: KnowledgeSnapshot = {
      claims: [
        {
          anchor: {
            locator: 'PDF 物理第 35 页',
            page: 35,
            quoteFragment: 'In patients undergoing PCI, DES should be used in preference to BMS',
            sha256: v1Doc.sha256,
            sourceId: v1Doc.sourceId,
            title: v1Doc.title,
            version: v1Doc.version,
          },
          applicabilityCondition: {
            category: 'diagnosis',
            itemCodes: ['I25.103', 'SYN-DX-01'],
            kind: 'fact',
            presence: 'present',
            requireEligible: true,
          },
          associatedConceptCodes: ['coronary-artery-disease', 'syn-syndrome-dx'],
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 'syn-claim-des-preference',
          packId: 'synthetic-test-syndrome',
          reviewerId: REVIEWER.reviewerId,
          statementZh: 'v1 原主张：拟行 PCI 患者优先选择 DES 而非 BMS。',
          status: 'published',
          topicId: 'syn-pci-guidance-card',
          version: '1.0.0',
        },
        {
          anchor: {
            locator: 'PDF 物理第 36 页',
            page: 36,
            quoteFragment: 'OCT is a reasonable alternative, except in ostial left main disease',
            sha256: v1Doc.sha256,
            sourceId: v1Doc.sourceId,
            title: v1Doc.title,
            version: v1Doc.version,
          },
          applicabilityCondition: {
            category: 'diagnosis',
            itemCodes: ['I25.103'],
            kind: 'fact',
            presence: 'present',
            requireEligible: true,
          },
          associatedConceptCodes: ['coronary-artery-disease'],
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 'syn-claim-oct-unchanged',
          packId: 'synthetic-test-syndrome',
          reviewerId: null,
          statementZh: 'OCT 不适用于左主干开口病变。',
          status: 'auto-verified',
          topicId: 'syn-pci-guidance-card',
          version: '1.0.0',
        },
      ],
      effectiveFrom: '2026-06-01T00:00:00Z',
      snapshotVersion: '2026.06.v1',
      topics: [{
        effectiveFrom: '2026-06-01T00:00:00Z',
        id: 'syn-pci-guidance-card',
        limitationsZh: ['仅用于合成测试'],
        navigationZh: '合成 PCI 导航卡',
        packId: 'synthetic-test-syndrome',
        references: [{
          locator: 'PDF 物理第 35 页',
          page: 35,
          quoteFragment: 'In patients undergoing PCI, DES should be used in preference to BMS',
          sha256: v1Doc.sha256,
          sourceId: v1Doc.sourceId,
          title: v1Doc.title,
          version: v1Doc.version,
        }],
        reviewerId: REVIEWER.reviewerId,
        status: 'published',
        titleZh: '合成 PCI 指南提示卡',
        version: '1.0.0',
      }],
    }

    const v2Candidates: DraftedKnowledgeClaimCandidate[] = [
      {
        anchor: {
          locator: 'PDF 物理第 35 页',
          page: 35,
          quoteFragment: 'In patients undergoing PCI, new-generation DES should be preferred; BMS is restricted to rare exceptions.',
          sha256: v2Doc.sha256,
          sourceId: v2Doc.sourceId,
          title: v2Doc.title,
          version: v2Doc.version,
        },
        applicabilityCondition: {
          category: 'diagnosis',
          itemCodes: ['I25.103', 'SYN-DX-01'],
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        associatedConceptCodes: ['coronary-artery-disease', 'syn-syndrome-dx'],
        candidateId: 'cand-v2-des',
        claimId: 'syn-claim-des-preference-v2',
        packId: 'synthetic-test-syndrome',
        statementZh: 'v2 新主张：PCI 应首选新一代 DES，BMS 仅限极少数例外情况。',
        topicId: 'syn-pci-guidance-card',
        version: '2.0.0',
      },
    ]

    const report = buildGuidelineSourceDiffReport({
      effectivePack,
      snapshot: baselineSnapshot,
      v1Document: v1Doc,
      v2Candidates,
      v2Document: v2Doc,
    })

    expect(report.syntheticDisclaimerZh).toContain('不冒充真实临床指南')
    expect(report.changedPassages).toHaveLength(1)
    expect(report.changedPassages[0]!.changeKind).toBe('modified')
    expect(report.affectedTopicIds).toEqual(['syn-pci-guidance-card'])
    expect(report.affectedClaimIds).toEqual(['syn-claim-des-preference'])
    expect(report.unchangedExistingClaimIds).toEqual(['syn-claim-oct-unchanged'])
    expect(report.affectedRuleIds).toEqual(expect.arrayContaining([
      'trigger:synthetic-dx-or-troponin-trigger',
      'stage:baseline-assessment',
      'readiness-task:pci-preop-guideline-advice',
      'indication:creatinine-workup-indication',
    ]))
    expect(report.affectedExamCaseIds).toEqual(['syn-exam-case-1'])

    // Conflict enters expertAdjudicationQueue while existing claim stays 100% untouched!
    expect(report.expertAdjudicationQueue).toHaveLength(1)
    const conflict = report.expertAdjudicationQueue[0]!
    expect(conflict.status).toBe('pending-adjudication')
    expect(conflict.existingClaim.statementZh).toBe('v1 原主张：拟行 PCI 患者优先选择 DES 而非 BMS。')
    expect(conflict.existingClaim.status).toBe('published')
    expect(report.snapshot.claims[0]!.statementZh).toBe('v1 原主张：拟行 PCI 患者优先选择 DES 而非 BMS。')
    expect(report.snapshot.claims[0]!.status).toBe('published')

    // Unverified reviewer cannot adjudicate
    expect(() => adjudicateGuidelineClaimConflict({
      adjudication: {
        conflictId: conflict.conflictId,
        decision: 'adopt-new',
        rationaleZh: '尝试越权裁决',
        reviewer: { ...REVIEWER, licenseVerified: false as unknown as true },
      },
      report,
      snapshot: baselineSnapshot,
    })).toThrow(KnowledgeClaimError)

    // Verified clinician adjudicates keep-existing -> preserves original claim 100% untouched
    const keptExisting = adjudicateGuidelineClaimConflict({
      adjudication: {
        conflictId: conflict.conflictId,
        decision: 'keep-existing',
        rationaleZh: '保留首版既定表述',
        reviewer: REVIEWER,
      },
      nowIso: '2026-08-24T09:30:00Z',
      report,
      snapshot: baselineSnapshot,
    })
    expect(keptExisting.resolvedConflict.status).toBe('kept-existing')
    expect(keptExisting.updatedSnapshot).toEqual(baselineSnapshot)

    // Verified clinician adjudicates -> adopts new & supersedes old claim cleanly
    const adjudicated = adjudicateGuidelineClaimConflict({
      adjudication: {
        conflictId: conflict.conflictId,
        decision: 'adopt-new',
        rationaleZh: '核对 v2 原件第 35 页修订措辞后批准上线',
        reviewer: REVIEWER,
      },
      effectiveFrom: '2026-08-24T00:00:00Z',
      nowIso: '2026-08-24T10:00:00Z',
      report,
      snapshot: baselineSnapshot,
    })

    expect(adjudicated.resolvedConflict.status).toBe('adopted-new')
    expect(adjudicated.updatedSnapshot.claims.find(c => c.id === 'syn-claim-des-preference')?.status).toBe('superseded')
    expect(adjudicated.updatedSnapshot.claims.find(c => c.id === 'syn-claim-des-preference-v2')).toMatchObject({
      reviewerId: REVIEWER.reviewerId,
      status: 'published',
    })

    // Re-adjudicating an already resolved conflict fails cleanly
    expect(() => adjudicateGuidelineClaimConflict({
      adjudication: {
        conflictId: conflict.conflictId,
        decision: 'keep-existing',
        rationaleZh: '重复裁决',
        reviewer: REVIEWER,
      },
      report: adjudicated.updatedReport,
      snapshot: adjudicated.updatedSnapshot,
    })).toThrow(KnowledgePipelineError)
  })

  it('AC35: reports historical facts, rules, claims & exam cases impacted when a mapping downgrades from exact to close', () => {
    const beforePackVocab: ConceptVocabulary = {
      mappings: [
        {
          effectiveDate: '2026-01-01',
          id: 'syn-map-hs-ctni-exact',
          relation: 'exact',
          reviewStatus: 'approved',
          reviewerId: REVIEWER.reviewerId,
          sourceCode: 'SYN-HS-CTNI',
          sourceDisplay: '合成高敏肌钙蛋白 I',
          sourceSystem: 'urn:clinmesh:synthetic-pack',
          targetConceptCode: '89579-7',
          version: '1.0.0',
        },
      ],
      nodes: [],
      version: '1.0.0',
    }
    const afterPackVocab: ConceptVocabulary = {
      mappings: [
        {
          effectiveDate: '2026-01-01',
          id: 'syn-map-hs-ctni-exact',
          notesZh: '复核发现试剂校准存在偏差，降级为相近映射，退出算分与红线拦截。',
          relation: 'close',
          reviewStatus: 'approved',
          reviewerId: REVIEWER.reviewerId,
          sourceCode: 'SYN-HS-CTNI',
          sourceDisplay: '合成高敏肌钙蛋白 I',
          sourceSystem: 'urn:clinmesh:synthetic-pack',
          targetConceptCode: '89579-7',
          version: '1.1.0',
        },
      ],
      nodes: [],
      version: '1.1.0',
    }

    const beforeMerged = mergeThreeLayerConceptVocabulary({ packLayer: beforePackVocab })
    const afterMerged = mergeThreeLayerConceptVocabulary({ packLayer: afterPackVocab })
    const effectivePack = makeSyntheticEffectivePack(beforePackVocab)

    const ledger = makeLedger([
      makeFact({
        category: 'laboratory',
        factId: 'fact-syn-hs-ctni-01',
        itemCode: {
          code: 'SYN-HS-CTNI',
          display: '合成高敏肌钙蛋白 I',
          system: 'urn:clinmesh:synthetic-pack',
        },
        value: { normalizedValue: { unit: 'ng/L', value: 120 }, rawText: '120 ng/L' },
      }),
      makeFact({
        category: 'laboratory',
        factId: 'fact-creatinine-unchanged',
        itemCode: { code: '2160-0', display: '血清肌酐', system: 'http://loinc.org' },
        value: { normalizedValue: { unit: 'umol/L', value: 88 }, rawText: '88 umol/L' },
      }),
    ])

    const snapshot: KnowledgeSnapshot = {
      claims: [
        {
          anchor: {
            locator: 'PDF 物理第 35 页',
            page: 35,
            quoteFragment: 'In patients undergoing PCI',
            sha256: 'a'.repeat(64),
            sourceId: 'syn-src',
            title: '合成测试指南',
            version: '1.0.0',
          },
          applicabilityCondition: {
            category: 'laboratory',
            itemCodes: ['89579-7'],
            kind: 'fact',
            minValue: 50,
            presence: 'present',
            requireEligible: true,
          },
          associatedConceptCodes: ['89579-7'],
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 'claim-hs-ctni-threshold',
          packId: 'synthetic-test-syndrome',
          reviewerId: null,
          statementZh: '高敏肌钙蛋白升高需结合临床评估。',
          status: 'auto-verified',
          topicId: 'syn-pci-guidance-card',
          version: '1.0.0',
        },
      ],
      effectiveFrom: '2026-06-01T00:00:00Z',
      snapshotVersion: '2026.06.v1',
      topics: [{
        effectiveFrom: '2026-06-01T00:00:00Z',
        id: 'syn-pci-guidance-card',
        limitationsZh: ['合成测试'],
        navigationZh: '合成导航',
        packId: 'synthetic-test-syndrome',
        references: [{
          locator: 'PDF 物理第 35 页',
          page: 35,
          quoteFragment: 'In patients undergoing PCI',
          sha256: 'a'.repeat(64),
          sourceId: 'syn-src',
          title: '合成测试指南',
          version: '1.0.0',
        }],
        reviewerId: null,
        status: 'auto-verified',
        titleZh: '合成卡',
        version: '1.0.0',
      }],
    }

    // Before downgrade: SYN-HS-CTNI participates in scoring & triggers
    expect(resolveLedgerFactsForConcept({
      asOfDate: '2026-08-24',
      ledger,
      mode: 'scoring-or-redline',
      targetConceptCode: '89579-7',
      vocabulary: beforeMerged,
    }).facts.map(f => f.factId)).toEqual(['fact-syn-hs-ctni-01'])

    const report = buildConceptMappingImpactReport({
      afterVocabulary: afterMerged,
      asOfDate: '2026-08-24',
      beforeVocabulary: beforeMerged,
      effectivePack,
      ledger,
      snapshots: [snapshot],
    })

    expect(report.downgradedMappingIds).toEqual(['syn-map-hs-ctni-exact'])
    expect(report.changedMappings).toHaveLength(1)
    expect(report.changedMappings[0]).toMatchObject({
      eligibilityReasonCode: 'MAPPING_CLOSE_HINT_ONLY',
      fromRelation: 'exact',
      mappingId: 'syn-map-hs-ctni-exact',
      stillEligibleForScoringAndRedLine: false,
      toRelation: 'close',
      wasEligibleForScoringAndRedLine: true,
    })
    expect(report.affectedHistoricalFactIds).toEqual(['fact-syn-hs-ctni-01'])
    expect(report.affectedHistoricalFacts[0]).toMatchObject({
      factId: 'fact-syn-hs-ctni-01',
      stillEligibleForScoringAndRedLine: false,
    })
    expect(report.affectedRuleIds).toEqual(expect.arrayContaining([
      'trigger:synthetic-dx-or-troponin-trigger',
      'readiness-task:pci-preop-guideline-advice',
      'red-line:hs-ctni-red-line',
      'indication:hs-ctni-workup-indication',
    ]))
    expect(report.affectedRuleIds).not.toContain('red-line:renal-red-line')
    expect(report.affectedClaimIds).toEqual(['claim-hs-ctni-threshold'])
    expect(report.affectedExamCaseIds).toEqual(['syn-exam-case-1'])

    // Verify downgraded mapping no longer participates in scoring / red-line trigger evaluation
    expect(resolveLedgerFactsForConcept({
      asOfDate: '2026-08-24',
      ledger,
      mode: 'scoring-or-redline',
      targetConceptCode: '89579-7',
      vocabulary: afterMerged,
    }).facts).toEqual([])
    expect(evaluatePackTrigger(
      effectivePack.pack.triggers[0]!.condition,
      ledger,
      { asOf: '2026-08-24T12:00:00+08:00', vocabulary: afterMerged },
    ).matched).toBe(false)
  })

  it('AC36: resolves structured synonym expansions using only approved exact mappings', () => {
    const vocab = mergeThreeLayerConceptVocabulary({
      packLayer: {
        mappings: [
          {
            effectiveDate: '2026-01-01',
            id: 'unapproved-mi-map',
            relation: 'exact',
            reviewStatus: 'proposed',
            reviewerId: null,
            sourceCode: 'SYN-MI-PROP',
            sourceDisplay: '未审核心梗别名',
            sourceSystem: 'urn:syn',
            targetConceptCode: 'myocardial-infarction',
            version: '1.0.0',
          },
          {
            effectiveDate: '2026-01-01',
            id: 'close-mi-map',
            relation: 'close',
            reviewStatus: 'approved',
            reviewerId: REVIEWER.reviewerId,
            sourceCode: 'SYN-MI-CLOSE',
            sourceDisplay: '急性胸痛待排',
            sourceSystem: 'urn:syn',
            targetConceptCode: 'myocardial-infarction',
            version: '1.0.0',
          },
        ],
        nodes: [],
        version: '1.0.0',
      },
    })

    const resolved = resolveSearchQuerySynonymExpansions('心梗', vocab, { asOfDate: '2026-08-24' })
    expect(resolved.terms).toEqual(expect.arrayContaining(['心梗', '心肌梗死', 'myocardial-infarction', 'MI']))
    expect(resolved.terms).not.toContain('未审核心梗别名')
    expect(resolved.terms).not.toContain('急性胸痛待排')
    expect(resolved.expansions).toContainEqual({
      conceptCode: 'myocardial-infarction',
      expandedTerm: '心肌梗死',
      mappingId: 'pub-map-mi-zh-full',
      queryTerm: '心梗',
    })
    expect(resolved.expansions.some(e => e.expandedTerm === '心梗')).toBe(false)
    expect(resolved.expansions.some(e => e.expandedTerm === '未审核心梗别名' || e.expandedTerm === '急性胸痛待排')).toBe(false)

    // Non-Han substring 'examine' must not falsely trigger 'MI'
    expect(resolveSearchQuerySynonymExpansions('examine chest', PUBLIC_CONCEPT_VOCABULARY).expansions).toEqual([])
  })
})
