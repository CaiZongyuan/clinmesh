import { describe, expect, it } from 'vitest'
import {
  SIMULATION_TRIAL_DISCLAIMER_ZH,
  type KnowledgeSnapshot,
} from '@clinmesh/contracts/knowledge-claims'
import {
  clinicalPromptCardSchema,
  type ClinicalPromptCard,
} from '@clinmesh/contracts/clinical-prompt-cards'
import type { EffectiveDiseasePack } from '@clinmesh/contracts/disease-pack'
import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import { PUBLIC_CONCEPT_VOCABULARY } from './concept-vocabulary.ts'
import {
  attachRiskTagsAndSideBySide,
  buildTimingPromptCards,
  compareKnowledgeEvaluations,
  computePromptCardKnowledgeDiff,
  filterPromptCardsBeforeDisplay,
  markStalePromptCardsForLedger,
} from './clinical-prompt-cards.ts'
import { evaluateKnowledgeSnapshotForPatient } from './knowledge-claims.ts'
import { validateAndParseDiseasePack } from './disease-pack.ts'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function makeFact(overrides: Partial<ClinicalFact> = {}): ClinicalFact {
  return {
    category: 'diagnosis',
    clinicianVerification: {
      note: null,
      verified: true,
      verifiedAt: null,
      verifiedByActorId: null,
      verifiedByPractitionerId: null,
    },
    conflictingFactIds: [],
    effectiveAt: '2026-08-24T08:00:00Z',
    eligibleForScoringAndRedLine: true,
    factId: 'fact:local:Condition:cond-1:1',
    ineligibleReasons: [],
    ingestedAt: '2026-08-24T08:00:00Z',
    institutionScope: 'local',
    isExpiredAtAsOf: false,
    itemCode: {
      code: 'I21.4',
      display: '急性非 ST 段抬高型心肌梗死',
      system: 'http://hl7.org/fhir/sid/icd-10',
    },
    mappingVersion: '1',
    method: null,
    orderedAt: '2026-08-24T08:00:00Z',
    presence: 'present',
    provenance: {
      recordId: 'cond-1',
      recordType: 'Condition',
      recordVersion: '1',
      sourceSystemId: 'local-his',
    },
    qualityFlags: [],
    recordStatus: 'final',
    relation: {
      supersededByFactId: null,
      supersedesFactId: null,
    },
    reportedAt: '2026-08-24T08:00:00Z',
    requiresRecheckPrompt: false,
    specimenOrSite: null,
    suspiciousReasons: [],
    validityDays: null,
    value: {
      normalizedValue: 'I21.4',
      rawText: '急性非 ST 段抬高型心肌梗死',
    },
    verificationStatus: 'confirmed',
    ...overrides,
  }
}

function makeLedger(facts: ClinicalFact[]): ClinicalFactLedger {
  return {
    facts,
    includeSuperseded: false,
    patientId: 'patient-1',
    subjectId: 'case-1',
    subjectKind: 'outpatient',
    summary: {
      conflictCount: 0,
      eligibleCount: facts.filter(f => f.eligibleForScoringAndRedLine).length,
      expiredCount: 0,
      externalUnverifiedCount: facts.filter(f => f.institutionScope === 'external' && !f.clinicianVerification.verified).length,
      notAskedCount: facts.filter(f => f.presence === 'not-asked').length,
      supersededCount: facts.filter(f => f.relation.supersededByFactId !== null).length,
      suspiciousCount: 0,
      totalFacts: facts.length,
      verifiedExternalCount: 0,
    },
    trace: {
      evaluatedAsOf: '2026-08-24T09:00:00Z',
      hospitalId: 'hospital-demo',
      mappingVersion: '1',
    },
  }
}

function makeEffectivePack(id: string, overrides: Record<string, unknown> = {}): EffectiveDiseasePack {
  const pack = validateAndParseDiseasePack({
    examSuite: {
      cases: [{ caseId: 'c1', expectedActive: true, titleZh: '测试用例' }],
      passThreshold: 0.8,
    },
    exitCriteria: [],
    formulaRefs: [],
    inapplicablePopulations: [
      {
        condition: {
          category: 'diagnosis',
          itemCodes: ['O99.8'],
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        descriptionZh: '妊娠合并症不适用本常规路径',
        id: 'pregnancy-excluded',
      },
    ],
    indicationRules: [],
    knowledgeSnapshots: [
      {
        claims: [
          {
            anchor: {
              locator: 'PDF 第 2 页',
              page: 2,
              quoteFragment: '10 min 内行标准 12 导联',
              sha256: SHA_B,
              sourceId: 'src-1',
              title: '合成临床指南',
              version: '2026',
            },
            applicabilityCondition: {
              category: 'diagnosis',
              itemCodePattern: '^I21',
              kind: 'fact',
              presence: 'present',
              requireEligible: true,
            },
            associatedConceptCodes: ['I21.4'],
            effectiveFrom: '2026-06-01T00:00:00Z',
            id: `${id}-claim-1`,
            packId: id,
            reviewerId: null,
            statementZh: '疑似急性冠脉综合征应尽快完成 12 导联心电图。',
            status: 'auto-verified',
            topicId: `${id}-topic-1`,
            version: '1.0.0',
          },
          {
            anchor: {
              locator: 'PDF 第 3 页',
              page: 3,
              quoteFragment: 'Old routine screening clause',
              sha256: SHA_B,
              sourceId: 'src-1',
              title: '合成临床指南',
              version: '2026',
            },
            applicabilityCondition: {
              category: 'diagnosis',
              itemCodePattern: '^I21',
              kind: 'fact',
              presence: 'present',
              requireEligible: true,
            },
            associatedConceptCodes: ['I21.4'],
            effectiveFrom: '2026-06-01T00:00:00Z',
            id: `${id}-claim-retired`,
            packId: id,
            reviewerId: null,
            statementZh: '已退役的历史条款不得继续展示。',
            status: 'retracted',
            topicId: `${id}-topic-1`,
            version: '1.0.0',
          },
        ],
        effectiveFrom: '2026-06-01T00:00:00Z',
        snapshotVersion: '2026.06.v1',
        topics: [
          {
            effectiveFrom: '2026-06-01T00:00:00Z',
            id: `${id}-topic-1`,
            limitationsZh: ['仿真核验用途'],
            navigationZh: '急性评估导航',
            packId: id,
            references: [
              {
                locator: 'PDF 第 2 页',
                page: 2,
                quoteFragment: '10 min 内行标准 12 导联',
                sha256: SHA_B,
                sourceId: 'src-1',
                title: '合成临床指南',
                version: '2026',
              },
            ],
            reviewerId: null,
            status: 'auto-verified',
            titleZh: `${id} 专题`,
            version: '1.0.0',
          },
        ],
      },
    ],
    manifest: {
      dependencies: [],
      fingerprint: SHA_A,
      id,
      packType: 'full',
      specialty: 'synthetic',
      status: 'active',
      supportedTasks: ['pci-preop-guideline-advice'],
      titleEn: `Pack ${id}`,
      titleZh: `专病包 ${id}`,
      version: '1.0.0',
    },
    orderSets: [],
    pointScales: [],
    qualityTightenings: {
      examPassThreshold: 0.85,
      redLineRules: [
        {
          conditionSummary: '须完成血清肌酐检查后再开立对比剂组套',
          id: 'creatinine-redline',
          itemCode: '2160-0',
        },
      ],
      validityOverrides: [],
    },
    questionnaireItems: [
      { code: 'killip-class', labelZh: 'Killip 心功能分级', options: ['I', 'II', 'III', 'IV'], valueType: 'enum' },
    ],
    readinessTasks: [
      { criticalItems: [], secondaryItems: [], taskId: 'pci-preop-guideline-advice', titleZh: '术前评估' },
    ],
    riskTags: [
      {
        candidateMedicationClasses: ['antiplatelet-aspirin', 'p2y12'],
        condition: {
          category: 'diagnosis',
          itemCodePattern: '^I21',
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        descriptionZh: '双联抗血小板增加出血风险，请核对出血评估',
        id: 'dapt-bleeding-risk',
        labelZh: '双联抗血小板（DAPT）出血风险警示',
        severity: 'warning',
        timing: 'order-draft-select',
      },
      {
        condition: {
          category: 'laboratory',
          itemCodes: ['89579-7'],
          kind: 'fact',
          minValue: 14,
          presence: 'present',
          requireEligible: true,
        },
        id: 'troponin-positive-risk',
        labelZh: '心肌肌钙蛋白升高警示',
        severity: 'critical',
      },
    ],
    ruleOutChecklist: [
      {
        actionHintZh: '核对 12 导联心电图及肌钙蛋白鉴别高危病因',
        id: 'chest-pain-differential',
        targetConditionCodes: ['I21.4', 'I71.0'],
        titleZh: '急性胸痛高危病因排查清单',
        trigger: {
          category: 'diagnosis',
          itemCodePattern: '^I21',
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
      },
    ],
    stages: [
      {
        entryCondition: {
          category: 'diagnosis',
          itemCodePattern: '^I21',
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        id: 'acute-stage',
        order: 1,
        orderSetIds: [],
        questionnaireItemCodes: ['killip-class'],
        taskIds: ['pci-preop-guideline-advice'],
        titleZh: '急性期',
        topicIds: [`${id}-topic-1`],
      },
    ],
    toolPolicy: {
      allowedTools: [],
      forbiddenActions: ['direct-order-execution'],
    },
    triggers: [
      {
        condition: {
          category: 'diagnosis',
          itemCodePattern: '^I21',
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        descriptionZh: 'I21 trigger',
        id: 'trigger-i21',
      },
    ],
    ...overrides,
  })
  return {
    effectiveAllowedTools: [],
    effectiveExamPassThreshold: 0.85,
    effectiveForbiddenActions: [
      'auto-prescribe-medication',
      'sign-clinical-document',
      'autonomous-treatment-decision',
      'direct-order-execution',
    ],
    effectiveRedLines: pack.qualityTightenings.redLineRules,
    effectiveValidityDaysByItemCode: {},
    localizations: {},
    pack,
  }
}

function makeCard(overrides: Partial<ClinicalPromptCard> = {}): ClinicalPromptCard {
  return clinicalPromptCardSchema.parse({
    basedOnFactVersions: [],
    blockingTier: 'none',
    cardId: 'card-1',
    category: 'recommendation',
    deliveryMode: 'display',
    detail: '推荐核对阿司匹林或常规随访方案（仅作为临床草稿参考）。',
    diffStatus: null,
    dismissal: null,
    indicator: 'info',
    knowledgeSnapshotVersion: '2026.06.v1',
    knowledgeStatus: 'published',
    longitudinalComparison: null,
    overrideReasons: ['clinical-judgement'],
    packId: 'synthetic-pack-a',
    packVersion: '1.0.0',
    riskTags: [],
    sideBySideGroupKey: null,
    source: { label: '合成指南' },
    stale: false,
    staleReason: null,
    status: 'active',
    suggestions: [],
    summary: '常规方案提示',
    timing: 'encounter-open',
    trialBadgeZh: null,
    trialDisclaimerZh: null,
    ...overrides,
  })
}

describe('ClinicalPromptCard core engine', () => {
  it('filters all 5 deterministic safety violation classes without LLM calls', () => {
    const packA = makeEffectivePack('synthetic-pack-a')
    const externalUnverified = makeFact({
      category: 'laboratory',
      clinicianVerification: {
        note: null,
        verified: false,
        verifiedAt: null,
        verifiedByActorId: null,
        verifiedByPractitionerId: null,
      },
      eligibleForScoringAndRedLine: false,
      factId: 'fact:ext:Observation:ext-cr-1:1',
      institutionScope: 'external',
      itemCode: { code: '2160-0', display: '外院血清肌酐', system: 'http://loinc.org' },
      provenance: { recordId: 'ext-cr-1', recordType: 'Observation', recordVersion: '1', sourceSystemId: 'ext' },
      qualityFlags: ['external-unverified'],
      verificationStatus: 'confirmed',
    })
    const inapplicableDx = makeFact({
      factId: 'fact:local:Condition:preg-1:1',
      itemCode: { code: 'O99.8', display: '妊娠合并症', system: 'http://hl7.org/fhir/sid/icd-10' },
      provenance: { recordId: 'preg-1', recordType: 'Condition', recordVersion: '1', sourceSystemId: 'local' },
    })
    const ledger = makeLedger([makeFact(), externalUnverified, inapplicableDx])

    const cases: Array<{ card: ClinicalPromptCard; expectedReason: string }> = [
      {
        card: makeCard({
          cardId: 'allergy-drug-card',
          suggestions: [{
            actionKind: 'draft-medication',
            candidateClasses: ['antiplatelet-aspirin'],
            catalogItemId: 'med-aspirin',
            id: 'sug-aspirin',
            isDraftOnly: true,
            itemCodes: ['ASPIRIN'],
            labelZh: '开立阿司匹林肠溶片 100 mg PO QD',
          }],
          summary: '拟建议口服阿司匹林',
        }),
        expectedReason: 'allergy-conflict',
      },
      {
        card: makeCard({
          cardId: 'renal-redline-card',
          suggestions: [{
            actionKind: 'draft-medication',
            candidateClasses: ['biguanide'],
            catalogItemId: 'med-metformin',
            id: 'sug-metformin',
            isDraftOnly: true,
            labelZh: '开立二甲双胍片 500 mg BID',
          }],
          summary: '拟建议口服二甲双胍',
        }),
        expectedReason: 'red-line-violation',
      },
      {
        card: makeCard({
          cardId: 'forbidden-card',
          suggestions: [{
            actionKind: 'draft-order',
            id: 'direct-order-execution',
            isDraftOnly: true,
            labelZh: '直接代开医嘱',
          }],
          summary: '直接执行禁止动作',
        }),
        expectedReason: 'forbidden-action',
      },
      {
        card: makeCard({
          cardId: 'retired-claim-card',
          knowledgeStatus: 'retracted',
          source: { claimId: 'synthetic-pack-a-claim-retired', label: '已撤回条款' },
          summary: '引用已退役条款',
        }),
        expectedReason: 'invalid-citation',
      },
      {
        card: makeCard({
          basedOnFactVersions: [{
            factId: externalUnverified.factId,
            itemCode: '2160-0',
            recordId: 'ext-cr-1',
            recordType: 'Observation',
            recordVersion: '1',
          }],
          cardId: 'unverified-ext-card',
          category: 'recommendation',
          summary: '基于未核实外院肌酐推荐用药',
        }),
        expectedReason: 'invalid-citation',
      },
      {
        card: makeCard({
          cardId: 'inapplicable-treatment-card',
          category: 'order-set-risk',
          packId: 'synthetic-pack-a',
          summary: '不适用人群组套治疗建议',
        }),
        expectedReason: 'inapplicable-population',
      },
    ]

    const safeRuleOutCard = makeCard({
      cardId: 'safe-rule-out',
      category: 'rule-out-checklist',
      packId: 'synthetic-pack-a',
      summary: '高危胸痛排查清单（不适用人群下仍保留）',
    })
    const safeOutpatientReminder = makeCard({
      cardId: 'safe-followup',
      packId: null,
      summary: '安全临床提示卡',
    })

    const result = filterPromptCardsBeforeDisplay({
      allergyCodes: new Set(['ASPIRIN']),
      cards: [...cases.map(c => c.card), safeRuleOutCard, safeOutpatientReminder],
      effectivePacks: [packA],
      ledger,
      renal: {
        egfr: 22,
        evidence: [{ label: '血清肌酐', reference: 'Observation/cr-1', versionId: '1' }],
        status: 'measured',
      },
    })

    expect(result.visibleCards.map(c => c.cardId)).toEqual(['safe-rule-out', 'safe-followup'])
    expect(result.blockedRecords).toHaveLength(cases.length)
    for (const testCase of cases) {
      const blocked = result.blockedRecords.find(r => r.cardId === testCase.card.cardId)
      expect(blocked?.blockedReason).toBe(testCase.expectedReason)
    }
  })

  it('builds encounter-open, order-draft-select, quality gate cards, and marks stale cards on report amendment', () => {
    const packA = makeEffectivePack('synthetic-pack-a')
    const packB = makeEffectivePack('synthetic-pack-b')
    const tropFact = makeFact({
      category: 'laboratory',
      factId: 'fact:local:Observation:obs-tni-1:1',
      itemCode: { code: '89579-7', display: 'hs-cTnI', system: 'http://loinc.org' },
      provenance: { recordId: 'obs-tni-1', recordType: 'Observation', recordVersion: '1', sourceSystemId: 'lis' },
      value: { normalizedValue: { unit: 'ng/L', value: 680 }, rawText: '680 ng/L' },
    })
    const ledger = makeLedger([makeFact(), tropFact])

    const builtOpen = buildTimingPromptCards({
      asOf: '2026-08-24T09:00:00Z',
      evaluatedPacks: [
        { effective: packA, entry: {
          activationReason: 'trigger-matched',
          activationStatus: 'active',
          allowedTools: [],
          currentStageId: 'acute-stage',
          forbiddenActions: [],
          localizations: {},
          manualOverride: null,
          manualOverrideVersion: 0,
          matchedInapplicableIds: [],
          matchedTriggerIds: ['trigger-i21'],
          packId: 'synthetic-pack-a',
          packType: 'full',
          readinessTasks: [],
          recognitionCard: null,
          specialty: 'synthetic',
          stages: [],
          status: 'active',
          titleEn: 'Pack A',
          titleZh: '专病包 A',
          version: '1.0.0',
        }, vocabulary: PUBLIC_CONCEPT_VOCABULARY },
        { effective: packB, entry: {
          activationReason: 'trigger-matched',
          activationStatus: 'active',
          allowedTools: [],
          currentStageId: 'acute-stage',
          forbiddenActions: [],
          localizations: {},
          manualOverride: null,
          manualOverrideVersion: 0,
          matchedInapplicableIds: [],
          matchedTriggerIds: ['trigger-i21'],
          packId: 'synthetic-pack-b',
          packType: 'full',
          readinessTasks: [],
          recognitionCard: null,
          specialty: 'synthetic',
          stages: [],
          status: 'active',
          titleEn: 'Pack B',
          titleZh: '专病包 B',
          version: '1.0.0',
        }, vocabulary: PUBLIC_CONCEPT_VOCABULARY },
      ],
      ledger,
      timing: 'encounter-open',
    })

    const missingKillip = builtOpen.cards.find(c => c.cardId.includes('killip-class'))
    expect(missingKillip?.summary).toBe('Killip 心功能分级：没问到')

    const autoVerifiedClaimCard = builtOpen.cards.find(c => c.source.claimId === 'synthetic-pack-a-claim-1')
    expect(autoVerifiedClaimCard?.trialBadgeZh).toBe('试用版')
    expect(autoVerifiedClaimCard?.trialDisclaimerZh).toBe(SIMULATION_TRIAL_DISCLAIMER_ZH)

    const { cards: withSideBySide, sideBySideGroups } = attachRiskTagsAndSideBySide(
      builtOpen.cards,
      builtOpen.riskTagsByPackId,
    )
    expect(sideBySideGroups.length).toBeGreaterThanOrEqual(1)
    expect(withSideBySide.every(c => c.packId === null || c.riskTags.some(t => t.id === 'troponin-positive-risk'))).toBe(true)

    // Order-draft-select with DAPT classes emits bleeding risk tag card
    const builtDraft = buildTimingPromptCards({
      asOf: '2026-08-24T09:00:00Z',
      candidateMedicationClasses: ['antiplatelet-aspirin', 'p2y12'],
      evaluatedPacks: [{
        effective: packA,
        entry: {
          activationReason: 'trigger-matched',
          activationStatus: 'active',
          allowedTools: [],
          currentStageId: 'acute-stage',
          forbiddenActions: [],
          localizations: {},
          manualOverride: null,
          manualOverrideVersion: 0,
          matchedInapplicableIds: [],
          matchedTriggerIds: ['trigger-i21'],
          packId: 'synthetic-pack-a',
          packType: 'full',
          readinessTasks: [],
          recognitionCard: null,
          specialty: 'synthetic',
          stages: [],
          status: 'active',
          titleEn: 'Pack A',
          titleZh: '专病包 A',
          version: '1.0.0',
        },
        vocabulary: PUBLIC_CONCEPT_VOCABULARY,
      }],
      ledger,
      selectedTemplateId: 'cad-pci-secondary-prevention',
      timing: 'order-draft-select',
    })
    expect(builtDraft.cards.some(c => c.riskTags.some(t => t.id === 'dapt-bleeding-risk'))).toBe(true)

    // Mark stale when referenced Observation is superseded in ledger
    const amendedLedger = makeLedger([
      makeFact(),
      {
        ...tropFact,
        relation: {
          supersededByFactId: 'fact:local:Observation:obs-tni-2:1',
          supersedesFactId: null,
        },
      },
      makeFact({
        category: 'laboratory',
        factId: 'fact:local:Observation:obs-tni-2:1',
        itemCode: { code: '89579-7', display: 'hs-cTnI', system: 'http://loinc.org' },
        provenance: { recordId: 'obs-tni-2', recordType: 'Observation', recordVersion: '1', sourceSystemId: 'lis' },
        relation: {
          supersededByFactId: null,
          supersedesFactId: tropFact.factId,
        },
      }),
    ])
    const refreshedCards = markStalePromptCardsForLedger(builtOpen.cards, amendedLedger)
    const staleRiskCard = refreshedCards.find(c => c.cardId === 'encounter-open:risk-tag:synthetic-pack-a:troponin-positive-risk')
    expect(staleRiskCard?.stale).toBe(true)
    expect(staleRiskCard?.staleReason).toBeTruthy()
  })

  it('computes historical knowledge replay diffs and hides retired claims (AC22)', () => {
    const snapshots: KnowledgeSnapshot[] = [
      {
        claims: [
          {
            anchor: { locator: 'p1', page: 1, quoteFragment: 'q1', sha256: SHA_B, sourceId: 's1', title: 'G1', version: '2026' },
            applicabilityCondition: { category: 'diagnosis', itemCodes: ['I21.4'], kind: 'fact', presence: 'present', requireEligible: true },
            associatedConceptCodes: ['I21.4'],
            effectiveFrom: '2026-06-01T00:00:00Z',
            id: 'claim-legacy',
            packId: 'synthetic-pack-a',
            reviewerId: null,
            statementZh: '旧版常规提示条款',
            status: 'auto-verified',
            topicId: 't1',
            version: '1.0.0',
          },
        ],
        effectiveFrom: '2026-06-01T00:00:00Z',
        snapshotVersion: '2026.06.v1',
        topics: [{
          effectiveFrom: '2026-06-01T00:00:00Z',
          id: 't1',
          limitationsZh: ['仿真'],
          navigationZh: '导航',
          packId: 'synthetic-pack-a',
          references: [{ locator: 'p1', page: 1, quoteFragment: 'q1', sha256: SHA_B, sourceId: 's1', title: 'G1', version: '2026' }],
          reviewerId: null,
          status: 'auto-verified',
          titleZh: '专题',
          version: '1.0.0',
        }],
      },
      {
        claims: [
          {
            anchor: { locator: 'p1', page: 1, quoteFragment: 'q1', sha256: SHA_B, sourceId: 's1', title: 'G1', version: '2026' },
            applicabilityCondition: { category: 'diagnosis', itemCodes: ['I21.4'], kind: 'fact', presence: 'present', requireEligible: true },
            associatedConceptCodes: ['I21.4'],
            effectiveFrom: '2026-08-01T00:00:00Z',
            id: 'claim-legacy',
            packId: 'synthetic-pack-a',
            reviewerId: null,
            statementZh: '旧版常规提示条款',
            status: 'superseded',
            supersededByClaimId: 'claim-v2',
            topicId: 't1',
            version: '2.0.0',
          },
          {
            anchor: { locator: 'p2', page: 2, quoteFragment: 'q2', sha256: SHA_B, sourceId: 's1', title: 'G1', version: '2026' },
            applicabilityCondition: { category: 'diagnosis', itemCodes: ['I21.4'], kind: 'fact', presence: 'present', requireEligible: true },
            associatedConceptCodes: ['I21.4'],
            effectiveFrom: '2026-08-01T00:00:00Z',
            id: 'claim-v2',
            packId: 'synthetic-pack-a',
            reviewerId: 'rev-1',
            statementZh: '新版已审定指南推荐',
            status: 'published',
            topicId: 't1',
            version: '2.0.0',
          },
        ],
        effectiveFrom: '2026-08-01T00:00:00Z',
        snapshotVersion: '2026.08.v2',
        topics: [{
          effectiveFrom: '2026-08-01T00:00:00Z',
          id: 't1',
          limitationsZh: ['仿真'],
          navigationZh: '导航',
          packId: 'synthetic-pack-a',
          references: [{ locator: 'p1', page: 1, quoteFragment: 'q1', sha256: SHA_B, sourceId: 's1', title: 'G1', version: '2026' }],
          reviewerId: 'rev-1',
          status: 'published',
          titleZh: '专题',
          version: '2.0.0',
        }],
      },
    ]
    const ledger = makeLedger([makeFact()])
    const verifier = (a: { quoteFragment: string }) => ({ passageText: a.quoteFragment, valid: true })
    const evalV1 = evaluateKnowledgeSnapshotForPatient({
      asOf: '2026-06-15T00:00:00Z',
      ledger,
      packId: 'synthetic-pack-a',
      packVersion: '1.0.0',
      snapshots,
      verifySourcePassage: verifier,
    })
    const evalV2 = evaluateKnowledgeSnapshotForPatient({
      asOf: '2026-08-15T00:00:00Z',
      ledger,
      packId: 'synthetic-pack-a',
      packVersion: '1.0.0',
      snapshots,
      verifySourcePassage: verifier,
    })
    const baselineCards = [makeCard({
      cardId: 'encounter-open:claim:synthetic-pack-a:claim-legacy',
      knowledgeSnapshotVersion: '2026.06.v1',
      knowledgeStatus: 'auto-verified',
      source: { claimId: 'claim-legacy', label: 'G1' },
      summary: '旧版常规提示条款',
      trialBadgeZh: '试用版',
      trialDisclaimerZh: SIMULATION_TRIAL_DISCLAIMER_ZH,
    })]
    const latestCards = [makeCard({
      cardId: 'encounter-open:claim:synthetic-pack-a:claim-v2',
      knowledgeSnapshotVersion: '2026.08.v2',
      knowledgeStatus: 'published',
      source: { claimId: 'claim-v2', label: 'G1' },
      summary: '新版已审定指南推荐',
    })]
    const diff = computePromptCardKnowledgeDiff(
      baselineCards,
      latestCards,
      new Map([['synthetic-pack-a', compareKnowledgeEvaluations(evalV1, evalV2)]]),
    )
    expect(diff.cards.map(c => c.cardId)).toEqual(['encounter-open:claim:synthetic-pack-a:claim-v2'])
    expect(diff.cards[0]?.diffStatus).toBe('added')
    expect(diff.retiredHiddenClaimIds).toEqual(['claim-legacy'])
    expect(diff.diffs.find(d => d.claimId === 'claim-legacy')?.diffStatus).toBe('retired-hidden')
  })
})
