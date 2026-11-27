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
      subjectKind: 'inpatient',
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
          matchedInapplicables: [],
          matchedTriggers: [],
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
          matchedInapplicables: [],
          matchedTriggers: [],
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
      subjectKind: 'outpatient',
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
          matchedInapplicables: [],
          matchedTriggers: [],
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

  it('tracks dynamic rule-out missing checks, exit summary silencing, and point-scale skip-test guidance (AC18)', () => {
    const pack = makeEffectivePack('synthetic-ruleout-pack', {
      exitCriteria: [
        {
          condition: {
            kind: 'allOf',
            nodes: [
              {
                abnormal: false,
                category: 'examination',
                itemCodes: ['11524-6'],
                kind: 'fact',
                minCount: 1,
                presence: 'present',
                requireEligible: true,
              },
              {
                abnormal: false,
                category: 'laboratory',
                itemCodes: ['89579-7'],
                kind: 'fact',
                minCount: 2,
                presence: 'present',
                requireEligible: true,
              },
            ],
          },
          descriptionZh: '完成心电图及至少 2 次连续正常高敏肌钙蛋白排查后自动退出',
          id: 'exit-normal-serial',
        },
      ],
      pointScales: [
        {
          criteria: [
            {
              condition: {
                category: 'laboratory',
                itemCodes: ['2160-0'],
                kind: 'fact',
                minValue: 133,
                presence: 'present',
                requireEligible: true,
              },
              id: 'high-cr',
              labelZh: '血清肌酐 >= 133 umol/L',
              points: 2,
            },
          ],
          guidelineCitation: {
            locator: '表 3 第 18 页',
            sourceTitle: '合成低危胸痛风险分层共识',
            version: '2026.1',
          },
          id: 'low-risk-ruleout-scale',
          riskBands: [
            {
              guidanceZh: '低危评分（0 分）可跳过非必要 D-二聚体检查并建议门急诊留观复评',
              labelZh: '低风险',
              maxScore: 0,
              minScore: 0,
              skipTests: true,
            },
            {
              labelZh: '高风险',
              maxScore: null,
              minScore: 1,
            },
          ],
          titleZh: '合成胸痛低危筛查量表',
        },
      ],
      ruleOutChecklist: [
        {
          actionHintZh: '依次完成心电图与两次动态高敏肌钙蛋白 I',
          checkItems: [
            {
              condition: {
                category: 'examination',
                itemCodes: ['11524-6'],
                kind: 'fact',
                minCount: 1,
                presence: 'present',
                requireEligible: true,
              },
              id: 'check-ecg',
              labelZh: '12 导联心电图',
              purposeZh: '排查心梗',
            },
            {
              condition: {
                category: 'laboratory',
                itemCodes: ['89579-7'],
                kind: 'fact',
                minCount: 2,
                presence: 'present',
                requireEligible: true,
              },
              id: 'check-serial-tni',
              labelZh: '连续 ≥ 2 次高敏心肌肌钙蛋白 I',
              purposeZh: '排查心肌损伤',
            },
          ],
          id: 'high-risk-chest-pain-ruleout',
          requiredTestCodes: ['11524-6', '89579-7'],
          targetConditionCodes: ['I21.4', 'I26.9', 'I71.0'],
          titleZh: '急性上腹痛/胸痛三大高危病因排查清单',
          trigger: {
            category: 'diagnosis',
            itemCodes: ['R10.1'],
            kind: 'fact',
            presence: 'present',
            requireEligible: true,
          },
        },
      ],
      triggers: [
        {
          condition: {
            category: 'diagnosis',
            itemCodes: ['R10.1'],
            kind: 'fact',
            presence: 'present',
            requireEligible: true,
          },
          descriptionZh: 'R10.1 trigger',
          id: 'trigger-r10',
        },
      ],
    })

    const dxFact = makeFact({
      itemCode: { code: 'R10.1', display: '上腹痛', system: 'http://hl7.org/fhir/sid/icd-10' },
      value: { normalizedValue: 'R10.1', rawText: '上腹痛' },
    })
    const normalEcg = makeFact({
      abnormal: false,
      category: 'examination',
      factId: 'fact:local:DiagnosticReport:ecg-1:1',
      itemCode: { code: '11524-6', display: '12 导联心电图', system: 'http://loinc.org' },
      provenance: { recordId: 'ecg-1', recordType: 'DiagnosticReport', recordVersion: '1', sourceSystemId: 'ris' },
      value: { normalizedValue: 'normal', rawText: '窦性心律正常' },
    })
    const normalTni1 = makeFact({
      abnormal: false,
      category: 'laboratory',
      factId: 'fact:local:Observation:tni-1:1',
      itemCode: { code: '89579-7', display: '高敏心肌肌钙蛋白 I', system: 'http://loinc.org' },
      provenance: { recordId: 'tni-1', recordType: 'Observation', recordVersion: '1', sourceSystemId: 'lis' },
      value: { normalizedValue: { unit: 'ng/L', value: 4 }, rawText: '4 ng/L' },
    })
    const normalTni2 = makeFact({
      abnormal: false,
      category: 'laboratory',
      effectiveAt: '2026-08-24T11:00:00Z',
      factId: 'fact:local:Observation:tni-2:1',
      itemCode: { code: '89579-7', display: '高敏心肌肌钙蛋白 I', system: 'http://loinc.org' },
      provenance: { recordId: 'tni-2', recordType: 'Observation', recordVersion: '1', sourceSystemId: 'lis' },
      reportedAt: '2026-08-24T11:00:00Z',
      value: { normalizedValue: { unit: 'ng/L', value: 5 }, rawText: '5 ng/L' },
    })

    const activeEntry = {
      activationReason: 'trigger-matched' as const,
      activationStatus: 'active' as const,
      allowedTools: [],
      currentStageId: 'acute-stage',
      forbiddenActions: [],
      localizations: {},
      manualOverride: null,
      manualOverrideVersion: 0,
      matchedInapplicableIds: [],
      matchedInapplicables: [],
      matchedTriggers: [],
      matchedTriggerIds: ['trigger-r10'],
      packId: 'synthetic-ruleout-pack',
      packType: 'full' as const,
      readinessTasks: [],
      recognitionCard: null,
      specialty: 'synthetic',
      stages: [],
      status: 'active' as const,
      titleEn: 'Synthetic Ruleout Pack',
      titleZh: '合成高危排查包',
      version: '1.0.0',
    }

    // 1. Before ECG & troponin: both checks missing + point scale low-risk skip guidance emitted
    const builtInitial = buildTimingPromptCards({
      subjectKind: 'outpatient',
      asOf: '2026-08-24T09:00:00Z',
      evaluatedPacks: [{ effective: pack, entry: activeEntry, vocabulary: PUBLIC_CONCEPT_VOCABULARY }],
      ledger: makeLedger([dxFact]),
      timing: 'encounter-open',
    })
    const checklistInitial = builtInitial.cards.find(c => c.category === 'rule-out-checklist')
    expect(checklistInitial?.detail).toContain('I21.4')
    expect(checklistInitial?.detail).toContain('I26.9')
    expect(checklistInitial?.detail).toContain('I71.0')
    expect(checklistInitial?.detail).toContain('12 导联心电图')
    expect(checklistInitial?.detail).toContain('连续 ≥ 2 次高敏心肌肌钙蛋白 I')

    expect(checklistInitial?.ruleOutItems).toEqual([
      { basedOnFactVersions: [], id: 'check-ecg', itemCodes: ['11524-6'], labelZh: '12 导联心电图', purposeZh: '排查心梗', status: 'not-ordered' },
      { basedOnFactVersions: [], id: 'check-serial-tni', itemCodes: ['89579-7'], labelZh: '连续 ≥ 2 次高敏心肌肌钙蛋白 I', purposeZh: '排查心肌损伤', status: 'not-ordered' },
    ])

    const pointScaleCard = builtInitial.cards.find(c => c.cardId.includes('point-scale:'))
    expect(pointScaleCard?.category).toBe('recommendation')
    expect(pointScaleCard?.detail).toContain('合成低危胸痛风险分层共识')
    expect(pointScaleCard?.detail).toContain('表 3 第 18 页')
    expect(pointScaleCard?.detail).toContain('D-二聚体')
    expect(pointScaleCard?.detail).toContain('低危评分')
    const filteredInitial = filterPromptCardsBeforeDisplay({
      allergyCodes: new Set(),
      cards: builtInitial.cards,
      effectivePacks: [pack],
      ledger: makeLedger([dxFact]),
      renal: { status: 'creatinine-missing' },
    })
    expect(filteredInitial.visibleCards.some(c => c.cardId === pointScaleCard?.cardId)).toBe(true)

    // 2. After ECG + 1st troponin: ECG done, serial >=2 troponin still missing
    const builtOneTrop = buildTimingPromptCards({
      subjectKind: 'outpatient',
      asOf: '2026-08-24T10:00:00Z',
      evaluatedPacks: [{ effective: pack, entry: activeEntry, vocabulary: PUBLIC_CONCEPT_VOCABULARY }],
      ledger: makeLedger([dxFact, normalEcg, normalTni1]),
      timing: 'encounter-open',
    })
    const checklistOneTrop = builtOneTrop.cards.find(c => c.category === 'rule-out-checklist')
    expect(checklistOneTrop?.detail).not.toContain('尚缺检查/项目：12 导联心电图')
    expect(checklistOneTrop?.detail).toContain('连续 ≥ 2 次高敏心肌肌钙蛋白 I')
    const [ecgItem, tniItem] = checklistOneTrop!.ruleOutItems
    expect(ecgItem).toMatchObject({ id: 'check-ecg', resultText: '12 导联心电图：窦性心律正常', status: 'resulted' })
    expect(ecgItem?.basedOnFactVersions.map(ref => ref.recordId)).toEqual(['ecg-1'])
    expect(tniItem?.status).toBe('not-ordered')

    // 已开立但未出结果的申请（总账中的 ServiceRequest 事实）显示为已开立
    const orderedTni = makeFact({
      category: 'laboratory',
      eligibleForScoringAndRedLine: false,
      factId: 'fact:local:ServiceRequest:sr-tni-2:1',
      itemCode: { code: '89579-7', display: '高敏心肌肌钙蛋白 I', system: 'http://loinc.org' },
      provenance: { recordId: 'sr-tni-2', recordType: 'ServiceRequest', recordVersion: '1', sourceSystemId: 'clinmesh-his-fhir' },
      value: { normalizedValue: null, rawText: '已开立高敏心肌肌钙蛋白 I' },
      verificationStatus: 'provisional',
    })
    const builtOrdered = buildTimingPromptCards({
      asOf: '2026-08-24T10:30:00Z',
      evaluatedPacks: [{ effective: pack, entry: activeEntry, vocabulary: PUBLIC_CONCEPT_VOCABULARY }],
      ledger: makeLedger([dxFact, normalEcg, normalTni1, orderedTni]),
      subjectKind: 'outpatient',
      timing: 'encounter-open',
    })
    const orderedItems = builtOrdered.cards.find(c => c.category === 'rule-out-checklist')!.ruleOutItems
    expect(orderedItems.map(item => item.status)).toEqual(['resulted', 'ordered'])

    // 3. Exited pack emits ONE exit-summary card first, then is completely silent across subsequent timings
    const exitedLedger = makeLedger([dxFact, normalEcg, normalTni1, normalTni2])
    const exitedEntry = {
      ...activeEntry,
      activationReason: 'pack-exited' as const,
      activationStatus: 'inactive' as const,
      exited: true,
      exitReasonZh: '完成心电图及至少 2 次连续正常高敏肌钙蛋白排查后自动退出',
      matchedTriggerIds: [],
    }
    const builtExitedFirst = buildTimingPromptCards({
      subjectKind: 'outpatient',
      asOf: '2026-08-24T11:30:00Z',
      evaluatedPacks: [{ effective: pack, entry: exitedEntry, exitSummaryAlreadyEmitted: false, vocabulary: PUBLIC_CONCEPT_VOCABULARY }],
      ledger: exitedLedger,
      timing: 'report-arrived',
    })
    expect(builtExitedFirst.cards).toHaveLength(1)
    expect(builtExitedFirst.cards[0]?.category).toBe('exit-summary')
    expect(builtExitedFirst.cards[0]?.detail).toContain('完成心电图及至少 2 次连续正常高敏肌钙蛋白排查后自动退出')

    const builtExitedLater = buildTimingPromptCards({
      subjectKind: 'outpatient',
      asOf: '2026-08-24T12:00:00Z',
      evaluatedPacks: [{ effective: pack, entry: exitedEntry, exitSummaryAlreadyEmitted: true, vocabulary: PUBLIC_CONCEPT_VOCABULARY }],
      ledger: exitedLedger,
      timing: 'encounter-open',
    })
    expect(builtExitedLater.cards).toEqual([])
  })

  it('suppresses treatment cards from mutually-confusable packs and emits one merged differential card (AC19)', () => {
    const packA = makeEffectivePack('confusable-pack-a', {
      confusablePacks: [{ differentialHintZh: '鉴别急性肺栓塞或大血管夹层', packId: 'confusable-pack-b' }],
      orderSets: [
        {
          id: 'order-set-a',
          items: [
            { channel: 'laboratory', key: 'lab-cr', kind: 'laboratory', panelServiceCodes: ['2160-0'], titleZh: '血清肌酐' },
          ],
          scopes: ['outpatient'],
          titleZh: '包 A 组套',
        },
      ],
      ruleOutChecklist: [
        {
          actionHintZh: '优先查心电图、hs-cTnI 与 D-二聚体',
          id: 'ruleout-a',
          requiredTestCodes: ['11524-6', '89579-7'],
          targetConditionCodes: ['I21.4'],
          titleZh: '包 A 排查',
          trigger: { category: 'diagnosis', itemCodes: ['R07.4'], kind: 'fact', presence: 'present', requireEligible: true },
        },
      ],
      triggers: [
        {
          condition: { category: 'diagnosis', itemCodes: ['R07.4'], kind: 'fact', presence: 'present', requireEligible: true },
          descriptionZh: 'Chest pain',
          id: 'trigger-a',
        },
      ],
    })
    const packB = makeEffectivePack('confusable-pack-b', {
      confusablePacks: [{ differentialHintZh: '鉴别非 ST 段抬高型心肌梗死', packId: 'confusable-pack-a' }],
      ruleOutChecklist: [
        {
          actionHintZh: '优先查 D-二聚体与 CTPA',
          id: 'ruleout-b',
          requiredTestCodes: ['48065-7'],
          targetConditionCodes: ['I26.9'],
          titleZh: '包 B 排查',
          trigger: { category: 'diagnosis', itemCodes: ['R07.4'], kind: 'fact', presence: 'present', requireEligible: true },
        },
      ],
      triggers: [
        {
          condition: { category: 'diagnosis', itemCodes: ['R07.4'], kind: 'fact', presence: 'present', requireEligible: true },
          descriptionZh: 'Chest pain',
          id: 'trigger-b',
        },
      ],
    })

    const ledger = makeLedger([
      makeFact({
        itemCode: { code: 'R07.4', display: '胸痛', system: 'http://hl7.org/fhir/sid/icd-10' },
        value: { normalizedValue: 'R07.4', rawText: '胸痛' },
      }),
    ])

    const makeActiveEntry = (id: string, titleZh: string, triggerId: string) => ({
      activationReason: 'trigger-matched' as const,
      activationStatus: 'active' as const,
      allowedTools: [],
      currentStageId: 'acute-stage',
      forbiddenActions: [],
      localizations: {},
      manualOverride: null,
      manualOverrideVersion: 0,
      matchedInapplicableIds: [],
      matchedInapplicables: [],
      matchedTriggers: [],
      matchedTriggerIds: [triggerId],
      packId: id,
      packType: 'full' as const,
      readinessTasks: [],
      recognitionCard: null,
      specialty: 'synthetic',
      stages: [],
      status: 'active' as const,
      titleEn: id,
      titleZh,
      version: '1.0.0',
    })

    const built = buildTimingPromptCards({
      subjectKind: 'outpatient',
      asOf: '2026-08-24T09:00:00Z',
      evaluatedPacks: [
        { effective: packA, entry: makeActiveEntry('confusable-pack-a', '专病包甲', 'trigger-a'), vocabulary: PUBLIC_CONCEPT_VOCABULARY },
        { effective: packB, entry: makeActiveEntry('confusable-pack-b', '专病包乙', 'trigger-b'), vocabulary: PUBLIC_CONCEPT_VOCABULARY },
      ],
      ledger,
      timing: 'encounter-open',
    })

    // No order-set / treatment recommendation / individual guideline claim cards from confusable packs
    expect(built.cards.some(c => c.category === 'order-set-risk' || c.category === 'quality-gate' || c.category === 'guideline-advice')).toBe(false)
    const differentialCards = built.cards.filter(c => c.cardId.includes(':confusable-differential:'))
    expect(differentialCards).toHaveLength(1)
    expect(differentialCards[0]?.category).toBe('rule-out-checklist')
    expect(differentialCards[0]?.detail).toContain('confusable-pack-a')
    expect(differentialCards[0]?.detail).toContain('confusable-pack-b')
    expect(differentialCards[0]?.detail).toContain('鉴别急性肺栓塞或大血管夹层')
    expect(differentialCards[0]?.detail).toContain('鉴别非 ST 段抬高型心肌梗死')

    const filtered = filterPromptCardsBeforeDisplay({
      allergyCodes: new Set(),
      cards: built.cards,
      effectivePacks: [packA, packB],
      ledger,
      renal: { status: 'creatinine-missing' },
    })
    expect(filtered.visibleCards.some(c => c.cardId === differentialCards[0]?.cardId)).toBe(true)
  })

  it('emits boundary prompt, preserves rule-out checklist and missing bedside items, and blocks treatments on inapplicable population (AC24)', () => {
    const pack = makeEffectivePack('synthetic-inapplicable-pack', {
      ruleOutChecklist: [
        {
          actionHintZh: '妊娠期胸痛仍需核查心电图、高敏肌钙蛋白与主动脉夹层高危线索',
          id: 'preg-ruleout',
          requiredTestCodes: ['11524-6'],
          targetConditionCodes: ['I21.4', 'I26.9', 'I71.0'],
          titleZh: '胸痛高危病因排查',
          trigger: { category: 'diagnosis', itemCodes: ['R07.4'], kind: 'fact', presence: 'present', requireEligible: true },
        },
      ],
    })
    const ledger = makeLedger([
      makeFact({
        itemCode: { code: 'O99.8', display: '妊娠状态', system: 'http://hl7.org/fhir/sid/icd-10' },
        value: { normalizedValue: 'O99.8', rawText: '妊娠状态' },
      }),
      makeFact({
        factId: 'fact:local:Condition:cond-2:1',
        itemCode: { code: 'R07.4', display: '胸痛', system: 'http://hl7.org/fhir/sid/icd-10' },
        provenance: { recordId: 'cond-2', recordType: 'Condition', recordVersion: '1', sourceSystemId: 'local-his' },
        value: { normalizedValue: 'R07.4', rawText: '胸痛' },
      }),
    ])
    const inapplicableEntry = {
      activationReason: 'inapplicable-population' as const,
      activationStatus: 'inapplicable' as const,
      allowedTools: [],
      currentStageId: null,
      forbiddenActions: [],
      localizations: {},
      manualOverride: null,
      manualOverrideVersion: 0,
      matchedInapplicableIds: ['pregnancy-excluded'],
      matchedInapplicables: [],
      matchedTriggers: [],
      matchedTriggerIds: [],
      packId: 'synthetic-inapplicable-pack',
      packType: 'full' as const,
      readinessTasks: [],
      recognitionCard: null,
      specialty: 'synthetic',
      stages: [],
      status: 'active' as const,
      titleEn: 'Pack Inapplicable',
      titleZh: '合成包',
      version: '1.0.0',
    }

    const built = buildTimingPromptCards({
      subjectKind: 'outpatient',
      asOf: '2026-08-24T09:00:00Z',
      evaluatedPacks: [{ effective: pack, entry: inapplicableEntry, vocabulary: PUBLIC_CONCEPT_VOCABULARY }],
      ledger,
      timing: 'encounter-open',
    })

    const boundaryCard = built.cards.find(c => c.category === 'inapplicable-population')
    expect(boundaryCard).toBeDefined()
    expect(boundaryCard?.summary).toContain('超出本包范围，请医生自行决策')
    expect(boundaryCard?.detail).toContain('妊娠合并症不适用本常规路径')

    expect(built.cards.some(c => c.category === 'rule-out-checklist')).toBe(true)
    // 床旁缺项只在住院提示，门诊不出缺项卡
    expect(built.cards.some(c => c.category === 'missing-fact')).toBe(false)
    const inpatientBuilt = buildTimingPromptCards({
      asOf: '2026-08-24T09:00:00Z',
      evaluatedPacks: [{ effective: pack, entry: inapplicableEntry, vocabulary: PUBLIC_CONCEPT_VOCABULARY }],
      ledger,
      subjectKind: 'inpatient',
      timing: 'encounter-open',
    })
    const missingCards = inpatientBuilt.cards.filter(c => c.category === 'missing-fact')
    expect(missingCards.length).toBeGreaterThan(0)
    const satisfiedCodes = missingCards.flatMap(c => c.suggestions.flatMap(s => s.itemCodes)).filter((code): code is string => code !== undefined)
    const satisfied = buildTimingPromptCards({
      asOf: '2026-08-24T09:00:00Z',
      evaluatedPacks: [{ effective: pack, entry: inapplicableEntry, vocabulary: PUBLIC_CONCEPT_VOCABULARY }],
      ledger,
      satisfiedBedsideCodes: satisfiedCodes,
      subjectKind: 'inpatient',
      timing: 'encounter-open',
    })
    expect(satisfied.cards.some(c => c.category === 'missing-fact')).toBe(false)
    expect(built.cards.some(c => ['recommendation', 'order-set-risk', 'medication-safety', 'guideline-advice'].includes(c.category))).toBe(false)
  })

  it('emits recognition prompt card when an active recognition pack is triggered', () => {
    const recPackRaw = validateAndParseDiseasePack({
      examSuite: { cases: [{ caseId: 'rec-1', expectedActive: true, titleZh: '识别测试' }], passThreshold: 0.8 },
      formulaRefs: [],
      inapplicablePopulations: [],
      manifest: {
        dependencies: [],
        fingerprint: SHA_A,
        id: 'synthetic-recognition',
        packType: 'recognition',
        specialty: 'synthetic',
        status: 'active',
        supportedTasks: ['early-triage-recognition'],
        titleEn: 'Synthetic Recognition',
        titleZh: '合成识别专病包',
        version: '1.0.0',
      },
      recognitionCard: {
        differentialPackIds: ['synthetic-pack-a'],
        escalationGuidanceZh: '提示急诊科进一步检查排除高危病变',
        id: 'red-flag-card',
        summaryZh: '高危胸痛症状群识别卡',
        titleZh: '快速识别提示卡',
      },
      toolPolicy: { allowedTools: [], forbiddenActions: [] },
      triggers: [
        {
          condition: { category: 'diagnosis', itemCodes: ['R07.4'], kind: 'fact', presence: 'present', requireEligible: true },
          descriptionZh: 'Chest pain',
          id: 'rec-trigger',
        },
      ],
    })
    const recEffective: EffectiveDiseasePack = {
      effectiveAllowedTools: [],
      effectiveExamPassThreshold: 0.8,
      effectiveForbiddenActions: [],
      effectiveRedLines: [],
      effectiveValidityDaysByItemCode: {},
      localizations: {},
      pack: recPackRaw,
    }
    const ledger = makeLedger([
      makeFact({
        itemCode: { code: 'R07.4', display: '胸痛', system: 'http://hl7.org/fhir/sid/icd-10' },
        value: { normalizedValue: 'R07.4', rawText: '胸痛' },
      }),
    ])
    const built = buildTimingPromptCards({
      subjectKind: 'outpatient',
      asOf: '2026-08-24T09:00:00Z',
      evaluatedPacks: [{
        effective: recEffective,
        entry: {
          activationReason: 'trigger-matched',
          activationStatus: 'active',
          allowedTools: [],
          currentStageId: null,
          forbiddenActions: [],
          localizations: {},
          manualOverride: null,
          manualOverrideVersion: 0,
          matchedInapplicableIds: [],
          matchedInapplicables: [],
          matchedTriggers: [],
          matchedTriggerIds: ['rec-trigger'],
          packId: 'synthetic-recognition',
          packType: 'recognition',
          readinessTasks: [],
          recognitionCard: recPackRaw.recognitionCard!,
          specialty: 'synthetic',
          stages: [],
          status: 'active',
          titleEn: 'Synthetic Recognition',
          titleZh: '合成识别专病包',
          version: '1.0.0',
        },
        vocabulary: PUBLIC_CONCEPT_VOCABULARY,
      }],
      ledger,
      timing: 'encounter-open',
    })

    const recCard = built.cards.find(c => c.category === 'recognition')
    expect(recCard?.summary).toContain('快速识别提示卡')
    expect(recCard?.detail).toContain('提示急诊科进一步检查排除高危病变')
    const filtered = filterPromptCardsBeforeDisplay({
      allergyCodes: new Set(),
      cards: built.cards,
      effectivePacks: [recEffective],
      ledger,
      renal: { status: 'creatinine-missing' },
    })
    expect(filtered.visibleCards.some(c => c.category === 'recognition')).toBe(true)
  })
})
