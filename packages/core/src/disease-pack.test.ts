import type { ClinicalFact, ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import { evaluateClinicalFactLedger } from './clinical-fact-ledger.ts'
import {
  DiseasePackValidationError,
  PLATFORM_FORMULA_REGISTRY,
  evaluatePackActivation,
  evaluatePackPointScale,
  evaluatePackStages,
  evaluatePackTrigger,
  evaluateTaskReadiness,
  filterLedgerForTaskView,
  mergeThreeLayerPack,
  validateAndParseDiseasePack,
} from './disease-pack.ts'
import { describe, expect, it } from 'vitest'

const SHA_A = 'a'.repeat(64)

function sampleFullPack(overrides: Record<string, unknown> = {}) {
  return {
    confusablePacks: [{ differentialHintZh: '需排除心外源性代谢紊乱', packId: 'synthetic-other-pack' }],
    examSuite: {
      cases: [
        {
          caseId: 'syn-case-1',
          expectedActive: true,
          expectedBlockedTaskIds: ['pci-preop-guideline-advice'],
          expectedStageId: 'acute-workup',
          titleZh: '合成测试例 1',
        },
      ],
      passThreshold: 0.8,
    },
    exitCriteria: [
      {
        condition: {
          category: 'diagnosis',
          itemCodes: ['EXCLUDED-01'],
          kind: 'fact',
          presence: 'absent',
          requireEligible: true,
        },
        descriptionZh: '排除诊断后退出路径',
        id: 'ruled-out-exit',
      },
    ],
    formulaRefs: [
      { formulaId: 'ckd-epi-2021', version: 1 },
      { formulaId: 'grace-acs', version: 1 },
    ],
    inapplicablePopulations: [
      {
        condition: {
          category: 'diagnosis',
          itemCodes: ['O99.8'],
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        descriptionZh: '妊娠期不适用当前标准专病包',
        id: 'pregnancy-excluded',
      },
    ],
    indicationRules: [
      {
        condition: {
          category: 'diagnosis',
          itemCodes: ['SYN-DX-01'],
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        id: 'ind-creatinine',
        itemCodePattern: '^2160-0$',
        orderKind: 'laboratory',
        rationaleZh: '专病术前须复查肾功能 (renal function assessment)',
      },
    ],
    manifest: {
      dependencies: [],
      fingerprint: SHA_A,
      id: 'synthetic-test-pack',
      packType: 'full',
      specialty: 'synthetic-medicine',
      status: 'active',
      supportedTasks: ['pci-preop-guideline-advice', 'followup-review'],
      titleEn: 'Synthetic Test Disease Pack',
      titleZh: '合成测试专病包',
      version: '1.0.0',
    },
    orderSets: [
      {
        id: 'synthetic-workup-set',
        items: [
          {
            activeMedicationConflictCodes: ['METFORMIN-01'],
            catalogBindingCode: 'CAT-CREAT-01',
            channel: 'laboratory',
            key: 'renal-panel',
            kind: 'laboratory',
            panelServiceCodes: ['2160-0'],
            titleZh: '肾功能检测组合',
          },
          {
            channel: 'procedure',
            key: 'pci-procedure',
            kind: 'procedure',
            procedureCode: '00.66',
            titleZh: '冠脉介入术前核查',
          },
        ],
        scopes: ['outpatient', 'inpatient'],
        titleZh: '合成专病检查组套',
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
            id: 'elevated-creatinine',
            labelZh: '血清肌酐 >= 133 umol/L',
            points: 2,
          },
          {
            condition: {
              category: 'bedside-questionnaire',
              itemCodes: ['smoking-status'],
              kind: 'fact',
              presence: 'present',
              requireEligible: true,
            },
            id: 'smoking-risk',
            labelZh: '吸烟史阳性',
            points: 1,
          },
        ],
        guidelineCitation: {
          locator: '第 12 页表 2',
          sourceTitle: '合成专病分层专家共识',
          version: '2026.1',
        },
        id: 'synthetic-risk-scale',
        riskBands: [
          { labelZh: '低风险', maxScore: 1, minScore: 0 },
          { labelZh: '高风险', maxScore: null, minScore: 2 },
        ],
        titleZh: '合成专病风险量表',
      },
    ],
    qualityTightenings: {
      examPassThreshold: 0.85,
      redLineRules: [
        {
          conditionSummary: 'eGFR < 30 禁止直接开立高肾毒或二甲双胍',
          id: 'renal-red-line',
          itemCode: '2160-0',
        },
      ],
      validityOverrides: [{ itemCode: '2160-0', maxValidityDays: 14 }],
    },
    questionnaireItems: [
      {
        code: 'smoking-status',
        labelZh: '吸烟状态',
        options: ['never', 'former', 'current'],
        valueType: 'enum',
      },
    ],
    readinessTasks: [
      {
        criticalItems: [
          { itemCode: '2160-0', labelZh: '血清肌酐 / eGFR', maxAgeDays: 14 },
        ],
        relevantCategories: ['diagnosis'],
        relevantItemCodes: ['2160-0', 'smoking-status', '89579-7'],
        secondaryItems: [
          { itemCode: 'smoking-status', labelZh: '吸烟状态' },
        ],
        taskId: 'pci-preop-guideline-advice',
        titleZh: 'PCI 术前指南参考意见',
      },
    ],
    riskTags: [
      {
        condition: {
          category: 'laboratory',
          itemCodes: ['2160-0'],
          kind: 'fact',
          minValue: 133,
          presence: 'present',
          requireEligible: true,
        },
        id: 'renal-impairment-tag',
        labelZh: '肾功能提示受损',
        severity: 'warning',
      },
    ],
    ruleOutChecklist: [
      {
        actionHintZh: '核查鉴别诊断指标',
        id: 'ruleout-differential',
        targetConditionCodes: ['SYN-DIFF-1'],
        titleZh: '鉴别诊断排查',
        trigger: {
          category: 'diagnosis',
          itemCodes: ['SYN-DX-01'],
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
          itemCodes: ['SYN-DX-01'],
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        id: 'acute-workup',
        order: 1,
        orderSetIds: ['synthetic-workup-set'],
        questionnaireItemCodes: ['smoking-status'],
        taskIds: ['pci-preop-guideline-advice'],
        titleZh: '急性评估期',
        topicIds: ['acute-chest-pain-acs'],
      },
      {
        entryCondition: {
          first: {
            category: 'laboratory',
            itemCodes: ['89579-7'],
            kind: 'fact',
            presence: 'present',
            requireEligible: true,
          },
          kind: 'sequence',
          maxGapDays: 30,
          requireDistinctEncounters: true,
          // oxlint-disable-next-line unicorn/no-thenable -- Exercise DSAP sequence TriggerNode contract ('first' -> 'then').
          then: {
            category: 'laboratory',
            itemCodes: ['2160-0'],
            kind: 'fact',
            presence: 'present',
            requireEligible: true,
          },
          timestampField: 'effectiveAt',
        },
        id: 'followup-monitoring',
        order: 2,
        orderSetIds: ['synthetic-workup-set'],
        questionnaireItemCodes: [],
        taskIds: ['followup-review'],
        titleZh: '跨就诊复查期',
        topicIds: ['pci-stent'],
      },
    ],
    toolPolicy: {
      allowedTools: [
        'inpatient.disease-packs.read',
        'inpatient.disease-pack-task-facts.read',
        'inpatient.guideline-advice.request',
        'sign-clinical-document',
      ],
      forbiddenActions: ['delete-medical-record'],
    },
    triggers: [
      {
        condition: {
          category: 'diagnosis',
          itemCodes: ['SYN-DX-01'],
          kind: 'fact',
          presence: 'present',
          requireEligible: true,
        },
        descriptionZh: '合成主诊断激活',
        id: 'dx-activation',
      },
    ],
    ...overrides,
  }
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
    patientId: 'patient-syn-1',
    subjectId: 'adm-syn-1',
    subjectKind: 'inpatient',
    summary: {
      conflictCount: facts.filter(f => f.qualityFlags.includes('conflict')).length,
      eligibleCount: facts.filter(f => f.eligibleForScoringAndRedLine).length,
      expiredCount: facts.filter(f => f.isExpiredAtAsOf).length,
      externalUnverifiedCount: facts.filter(f => f.qualityFlags.includes('external-unverified')).length,
      notAskedCount: facts.filter(f => f.presence === 'not-asked').length,
      supersededCount: 0,
      suspiciousCount: facts.filter(f => f.qualityFlags.includes('suspicious')).length,
      totalFacts: facts.length,
      verifiedExternalCount: facts.filter(f => f.institutionScope === 'external' && f.clinicianVerification.verified).length,
    },
    trace: {
      evaluatedAsOf: asOf,
      hospitalId: 'hospital-default',
      mappingVersion: '2026-11-24.r1',
    },
  }
}

describe('disease-pack contracts, validator, overlay & runtime evaluators', () => {
  it('validates a pure-JSON full pack and checks platform formula registry', () => {
    expect([...PLATFORM_FORMULA_REGISTRY.keys()]).toEqual(expect.arrayContaining([
      'ckd-epi-2021@1',
      'cockcroft-gault@1',
      'grace-acs@1',
      'timi-ua-nstemi@1',
      'precise-dapt@1',
      'ascvd-ldl-target@1',
    ]))
    const parsed = validateAndParseDiseasePack(sampleFullPack())
    expect(parsed.manifest.id).toBe('synthetic-test-pack')
  })

  it('validates a recognition-only pack without requiring stages or orderSets', () => {
    const recognition = validateAndParseDiseasePack({
      examSuite: {
        cases: [{ caseId: 'rec-1', expectedActive: true, titleZh: '识别测试 1' }],
        passThreshold: 0.9,
      },
      formulaRefs: [],
      inapplicablePopulations: [],
      manifest: {
        fingerprint: SHA_A,
        id: 'synthetic-recognition-pack',
        packType: 'recognition',
        specialty: 'cardiology',
        status: 'active',
        supportedTasks: ['early-triage-recognition'],
        titleEn: 'Synthetic Recognition Pack',
        titleZh: '合成识别专病包',
        version: '1.0.0',
      },
      recognitionCard: {
        differentialPackIds: ['synthetic-test-pack'],
        escalationGuidanceZh: '提示急诊科进一步检查排除高危病变',
        id: 'red-flag-card',
        summaryZh: '高危胸痛症状群识别卡',
        titleZh: '快速识别提示卡',
      },
      toolPolicy: {
        allowedTools: ['outpatient.disease-packs.read'],
        forbiddenActions: [],
      },
      triggers: [
        {
          condition: {
            category: 'vital-sign',
            itemCodes: ['8480-6'],
            kind: 'fact',
            maxValue: 90,
            presence: 'present',
            requireEligible: true,
          },
          id: 'hypotension-flag',
        },
      ],
    })
    expect(recognition.manifest.packType).toBe('recognition')
    expect(recognition.stages).toEqual([])
  })

  it('rejects missing required fields per packType and invalid formula versions', () => {
    expect(() => validateAndParseDiseasePack(sampleFullPack({ stages: [] }))).toThrow(DiseasePackValidationError)
    try {
      validateAndParseDiseasePack(sampleFullPack({ stages: [] }))
    } catch (err) {
      expect(err).toBeInstanceOf(DiseasePackValidationError)
      expect((err as DiseasePackValidationError).code).toBe('PACK_SCHEMA_INVALID')
    }

    try {
      validateAndParseDiseasePack(sampleFullPack({
        formulaRefs: [{ formulaId: 'ckd-epi-2021', version: 99 }],
      }))
      expect.unreachable()
    } catch (err) {
      expect((err as DiseasePackValidationError).code).toBe('PACK_FORMULA_VERSION_NOT_FOUND')
    }

    try {
      validateAndParseDiseasePack(sampleFullPack({
        triggers: [{
          condition: { category: 'laboratory', itemCodes: ['2160-0'], kind: 'fact', presence: 'present', withinDays: 7 },
          id: 'missing-ts-field',
        }],
      }))
      expect.unreachable()
    } catch (err) {
      expect((err as DiseasePackValidationError).code).toBe('PACK_SCHEMA_INVALID')
    }
  })

  it('rejects any executable code pattern or script filename with PACK_CODE_FORBIDDEN', () => {
    expect(() => validateAndParseDiseasePack(sampleFullPack(), {
      files: [{ content: '{}', filename: 'hook.ts' }],
    })).toThrow(DiseasePackValidationError)

    const codeSamples = [
      'function evil() { return 1 }',
      '() => true',
      'eval("alert(1)")',
      'new Function("return 1")',
      'import("./x.js")',
      'require("fs")',
      '<script>alert(1)</script>',
    ]
    for (const snippet of codeSamples) {
      try {
        validateAndParseDiseasePack(sampleFullPack({
          manifest: { ...sampleFullPack().manifest, titleEn: snippet },
        }))
        expect.unreachable(`Expected PACK_CODE_FORBIDDEN for: ${snippet}`)
      } catch (err) {
        expect((err as DiseasePackValidationError).code).toBe('PACK_CODE_FORBIDDEN')
      }
    }
  })

  it('merges 3 layers tightening safety rules and rejecting any hospital overlay relaxation', () => {
    const pack = validateAndParseDiseasePack(sampleFullPack())
    const merged = mergeThreeLayerPack({
      diseasePack: pack,
      hospitalOverlay: {
        hospitalId: 'hospital-alpha',
        localizations: {
          catalogBindings: { 'CAT-CREAT-01': 'LOCAL-CREAT-99' },
          codingMappings: { 'SYN-DX-01': 'I25.9' },
        },
        packId: pack.manifest.id,
        safetyAdjustments: {
          examPassThreshold: 0.92,
          forbiddenActionAdditions: ['bypass-double-check'],
          redLineAdditions: [
            { conditionSummary: '严重肝损伤额外禁忌', id: 'hepatic-red-line', itemCode: 'ALT-1' },
          ],
          validityOverrides: [{ itemCode: '2160-0', maxValidityDays: 7 }],
        },
        version: '1.0.0',
      },
    })

    expect(merged.effectiveValidityDaysByItemCode['2160-0']).toBe(7)
    expect(merged.effectiveExamPassThreshold).toBe(0.92)
    expect(merged.effectiveRedLines.map(r => r.id)).toEqual(['renal-red-line', 'hepatic-red-line'])
    expect(merged.effectiveForbiddenActions).toEqual(expect.arrayContaining([
      'auto-prescribe-medication',
      'sign-clinical-document',
      'autonomous-treatment-decision',
      'delete-medical-record',
      'bypass-double-check',
    ]))
    expect(merged.effectiveAllowedTools).not.toContain('sign-clinical-document')
    expect(merged.localizations.catalogBindings).toEqual({ 'CAT-CREAT-01': 'LOCAL-CREAT-99' })

    const weakeningCases = [
      { safetyAdjustments: { validityOverrides: [{ itemCode: '2160-0', maxValidityDays: 30 }] } },
      { safetyAdjustments: { redLineRemovals: ['renal-red-line'] } },
      { safetyAdjustments: { forbiddenActionRemovals: ['auto-prescribe-medication'] } },
      { safetyAdjustments: { examPassThreshold: 0.5 } },
    ]
    for (const bad of weakeningCases) {
      try {
        mergeThreeLayerPack({
          diseasePack: pack,
          hospitalOverlay: { hospitalId: 'hospital-alpha', packId: pack.manifest.id, ...bad },
        })
        expect.unreachable()
      } catch (err) {
        expect((err as DiseasePackValidationError).code).toBe('HOSPITAL_OVERLAY_SAFETY_RELAXATION_FORBIDDEN')
      }
    }
  })

  it('evaluates cross-time & cross-encounter sequence triggers with explicit timestampField', () => {
    const seqNode = {
      first: { category: 'laboratory' as const, itemCodes: ['89579-7'], kind: 'fact' as const, presence: 'present' as const, requireEligible: true },
      kind: 'sequence' as const,
      maxGapDays: 7,
      requireDistinctEncounters: true,
      // oxlint-disable-next-line unicorn/no-thenable -- Exercise DSAP sequence TriggerNode contract ('first' -> 'then').
      then: { category: 'laboratory' as const, itemCodes: ['2160-0'], kind: 'fact' as const, presence: 'present' as const, requireEligible: true },
      timestampField: 'effectiveAt' as const,
    }
    const f1 = makeFact({
      category: 'laboratory',
      effectiveAt: '2026-08-20T09:00:00+08:00',
      factId: 'fact-ctni-1',
      itemCode: { code: '89579-7', display: 'hs-cTnI', system: 'http://loinc.org' },
      value: { normalizedValue: { unit: 'ng/L', value: 85 }, rawText: '85 ng/L' },
    })
    const f2 = makeFact({
      category: 'laboratory',
      effectiveAt: '2026-08-22T10:00:00+08:00',
      factId: 'fact-creat-2',
      itemCode: { code: '2160-0', display: '肌酐', system: 'http://loinc.org' },
      value: { normalizedValue: { unit: 'umol/L', value: 110 }, rawText: '110 umol/L' },
    })
    const ledger = makeLedger([f1, f2])

    expect(evaluatePackTrigger(seqNode, ledger, {
      encounterIdByFactId: { 'fact-ctni-1': 'enc-1', 'fact-creat-2': 'enc-1' },
    }).matched).toBe(false)

    const crossEnc = evaluatePackTrigger(seqNode, ledger, {
      encounterIdByFactId: { 'fact-ctni-1': 'enc-1', 'fact-creat-2': 'enc-2' },
    })
    expect(crossEnc.matched).toBe(true)
    expect(crossEnc.matchedFactIds).toEqual(['fact-ctni-1', 'fact-creat-2'])

    const staleGap = makeFact({
      ...f2,
      effectiveAt: '2026-09-10T10:00:00+08:00',
      factId: 'fact-creat-late',
    })
    expect(evaluatePackTrigger(seqNode, makeLedger([f1, staleGap], '2026-09-11T12:00:00+08:00'), {
      encounterIdByFactId: { 'fact-ctni-1': 'enc-1', 'fact-creat-late': 'enc-2' },
    }).matched).toBe(false)
  })

  it('evaluates activation, inapplicable populations, stages, 3-tier readiness & task filtering', () => {
    const merged = mergeThreeLayerPack({ diseasePack: validateAndParseDiseasePack(sampleFullPack()) })

    const ledgerEvaluated = evaluateClinicalFactLedger({
      candidates: [
        {
          category: 'diagnosis',
          effectiveAt: '2026-08-24T08:00:00+08:00',
          factId: 'dx-1',
          ingestedAt: '2026-08-24T08:00:00+08:00',
          institutionScope: 'local',
          itemCode: { code: 'SYN-DX-01', display: '合成主诊断', system: 'http://hl7.org/fhir/sid/icd-10' },
          mappingVersion: '2026-11-24.r1',
          method: null,
          orderedAt: null,
          presence: 'present',
          provenance: { recordId: 'cond-1', recordType: 'Condition', recordVersion: '1', sourceSystemId: 'clinmesh-his-fhir' },
          recordStatus: 'final',
          reportedAt: '2026-08-24T08:00:00+08:00',
          specimenOrSite: null,
          supersedesFactId: null,
          value: { normalizedValue: '合成主诊断', rawText: '合成主诊断' },
          verificationStatus: 'confirmed',
        },
        {
          category: 'laboratory',
          effectiveAt: '2026-08-24T08:30:00+08:00',
          factId: 'creat-suspicious',
          ingestedAt: '2026-08-24T08:35:00+08:00',
          institutionScope: 'local',
          itemCode: { code: '2160-0', display: '血清肌酐', system: 'http://loinc.org' },
          mappingVersion: '2026-11-24.r1',
          method: null,
          orderedAt: '2026-08-24T08:20:00+08:00',
          presence: 'present',
          provenance: { recordId: 'obs-bad', recordType: 'Observation', recordVersion: '1', sourceSystemId: 'clinmesh-his-fhir' },
          recordStatus: 'final',
          reportedAt: '2026-08-24T08:35:00+08:00',
          sourceQuantityForQc: { numericValue: 999999, rawUnit: 'umol/L' },
          specimenOrSite: null,
          supersedesFactId: null,
          value: { normalizedValue: { unit: 'umol/L', value: 999999 }, rawText: '999999 umol/L' },
          verificationStatus: 'not-applicable',
        },
        {
          category: 'laboratory',
          effectiveAt: '2026-08-24T08:15:00+08:00',
          factId: 'unrelated-lab-1',
          ingestedAt: '2026-08-24T08:20:00+08:00',
          institutionScope: 'local',
          itemCode: { code: 'UNRELATED-99', display: '无关指标', system: 'http://loinc.org' },
          mappingVersion: '2026-11-24.r1',
          method: null,
          orderedAt: '2026-08-24T08:00:00+08:00',
          presence: 'present',
          provenance: { recordId: 'obs-unrel', recordType: 'Observation', recordVersion: '1', sourceSystemId: 'clinmesh-his-fhir' },
          recordStatus: 'final',
          reportedAt: '2026-08-24T08:20:00+08:00',
          specimenOrSite: null,
          supersedesFactId: null,
          value: { normalizedValue: 5, rawText: '5' },
          verificationStatus: 'not-applicable',
        },
      ],
      evaluatedAsOf: '2026-08-24T10:00:00+08:00',
      hospitalId: 'hospital-default',
      patientId: 'p-1',
      subjectId: 'adm-1',
      subjectKind: 'inpatient',
      verifications: [],
    })

    expect(evaluatePackActivation(merged, ledgerEvaluated).active).toBe(true)
    expect(evaluatePackStages(merged, ledgerEvaluated).currentStageId).toBe('acute-workup')

    // Suspicious creatinine must NOT satisfy critical requirement!
    const blocked = evaluateTaskReadiness(merged, 'pci-preop-guideline-advice', ledgerEvaluated)
    expect(blocked.status).toBe('missing-critical')
    expect(blocked.canProceed).toBe(false)
    expect(blocked.missingCriticalItems[0]?.labelZh).toBe('血清肌酐 / eGFR')
    expect(blocked.missingCriticalItems[0]?.ineligibleReasons).toContain('suspicious:out-of-plausible-range')

    // Valid creatinine + missing smoking -> missing-secondary with annotation
    const validCreatLedger = makeLedger([
      makeFact({
        category: 'diagnosis',
        factId: 'dx-1',
        itemCode: { code: 'SYN-DX-01', display: '合成主诊断', system: 'http://hl7.org/fhir/sid/icd-10' },
        value: { normalizedValue: '合成主诊断', rawText: '合成主诊断' },
      }),
      makeFact({
        category: 'laboratory',
        factId: 'creat-ok',
        itemCode: { code: '2160-0', display: '血清肌酐', system: 'http://loinc.org' },
        value: { normalizedValue: { unit: 'umol/L', value: 145 }, rawText: '145 umol/L' },
      }),
      makeFact({
        category: 'laboratory',
        factId: 'unrelated-lab-200',
        itemCode: { code: 'UNREL-LAB', display: '无关检验', system: 'http://loinc.org' },
        value: { normalizedValue: 1, rawText: '1' },
      }),
    ])
    const secondaryMissing = evaluateTaskReadiness(merged, 'pci-preop-guideline-advice', validCreatLedger)
    expect(secondaryMissing.status).toBe('missing-secondary')
    expect(secondaryMissing.canProceed).toBe(true)
    expect(secondaryMissing.annotations).toEqual(['缺吸烟状态'])

    // Add assessed never-smoking ('absent' presence, NOT 'not-asked') -> ready!
    const readyLedger = makeLedger([
      ...validCreatLedger.facts,
      makeFact({
        category: 'bedside-questionnaire',
        factId: 'smoke-never',
        itemCode: { code: 'smoking-status', display: '吸烟史', system: 'urn:clinmesh:clinical-risk-assessment' },
        presence: 'absent',
        value: { normalizedValue: 'never', rawText: 'never' },
      }),
    ])
    const ready = evaluateTaskReadiness(merged, 'pci-preop-guideline-advice', readyLedger)
    expect(ready.status).toBe('ready')
    expect(ready.canProceed).toBe(true)
    expect(ready.annotations).toEqual([])

    // AC32: Task-scoped ledger filtering excludes unrelated lab facts
    const scoped = filterLedgerForTaskView(merged, 'pci-preop-guideline-advice', readyLedger)
    expect(scoped.facts.map(f => f.factId)).toEqual(['dx-1', 'creat-ok', 'smoke-never'])
    expect(scoped.summary.totalFacts).toBe(3)

    // Inapplicable population overrides activation
    const pregLedger = makeLedger([
      ...validCreatLedger.facts,
      makeFact({
        category: 'diagnosis',
        factId: 'dx-preg',
        itemCode: { code: 'O99.8', display: '妊娠期合并症', system: 'http://hl7.org/fhir/sid/icd-10' },
        value: { normalizedValue: '妊娠期合并症', rawText: '妊娠期合并症' },
      }),
    ])
    const inapplicable = evaluatePackActivation(merged, pregLedger)
    expect(inapplicable.active).toBe(false)
    expect(inapplicable.activationStatus).toBe('inapplicable')
    expect(inapplicable.matchedInapplicableIds).toEqual(['pregnancy-excluded'])

    // Point scale evaluation
    const scaleResult = evaluatePackPointScale(merged.pack.pointScales![0]!, readyLedger)
    expect(scaleResult.score).toBe(2)
    expect(scaleResult.bandLabelZh).toBe('高风险')
  })
})
