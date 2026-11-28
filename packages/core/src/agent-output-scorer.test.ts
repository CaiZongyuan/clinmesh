import { describe, expect, it } from 'vitest'
import type { AgentScoringRubricInput } from '@clinmesh/contracts/agent-output-scorer'
import type { ConceptVocabulary } from '@clinmesh/contracts/concept-vocabulary'
import { evaluateClinicalFactLedger, transcribeLocalFhirFacts, transcribeVisibleSourceHistoryFacts } from './clinical-fact-ledger.ts'
import { mergeThreeLayerConceptVocabulary } from './concept-vocabulary.ts'
import {
  AgentOutputScorerError,
  buildTextConceptSignaturesFromVocabulary,
  computeClinicianEditMetrics,
  createUnevaluatedAgentOutputState,
  scoreAgentDraftOutput,
} from './agent-output-scorer.ts'

function buildCase1FollowupLedger(options: { includeExternalUnverifiedEcho?: boolean; includeSuspiciousPotassium?: boolean } = {}) {
  const localCandidates = transcribeLocalFhirFacts({
    conditions: [
      {
        code: { coding: [{ code: 'I21.4', display: '急性非ST段抬高型心肌梗死', system: 'http://hl7.org/fhir/sid/icd-10' }] },
        id: 'cond-nstemi',
        meta: { lastUpdated: '2026-08-24T08:10:00+08:00', versionId: '1' },
        recordedDate: '2026-08-24T08:10:00+08:00',
        verificationStatus: { coding: [{ code: 'confirmed' }] },
      },
    ],
    diagnosticReports: [
      {
        category: [{ coding: [{ code: 'ECG' }] }],
        code: { coding: [{ code: '11524-6', display: '十二导联心电图', system: 'http://loinc.org' }] },
        conclusion: '窦性心律，ST段较前恢复',
        effectiveDateTime: '2026-09-14T09:00:00+08:00',
        id: 'rep-ecg-followup',
        issued: '2026-09-14T09:05:00+08:00',
        meta: { lastUpdated: '2026-09-14T09:05:00+08:00', versionId: '1' },
        status: 'final',
      },
    ],
    medications: [
      {
        authoredOn: '2026-09-14T09:10:00+08:00',
        dosageInstruction: [{ text: '100 mg 每日一次 口服' }],
        id: 'med-aspirin',
        medicationCodeableConcept: { coding: [{ code: 'aspirin', display: '阿司匹林肠溶片' }] },
        meta: { lastUpdated: '2026-09-14T09:10:00+08:00', versionId: '1' },
        resourceType: 'MedicationRequest',
        status: 'active',
      },
      {
        authoredOn: '2026-09-14T09:10:00+08:00',
        dosageInstruction: [{ text: '90 mg 每日两次 口服' }],
        id: 'med-ticagrelor',
        medicationCodeableConcept: { coding: [{ code: 'ticagrelor', display: '替格瑞洛片' }] },
        meta: { lastUpdated: '2026-09-14T09:10:00+08:00', versionId: '1' },
        resourceType: 'MedicationRequest',
        status: 'active',
      },
      {
        authoredOn: '2026-09-14T09:10:00+08:00',
        dosageInstruction: [{ text: '20 mg 每晚一次 口服' }],
        id: 'med-atorvastatin',
        medicationCodeableConcept: { coding: [{ code: 'atorvastatin', display: '阿托伐他汀钙片' }] },
        meta: { lastUpdated: '2026-09-14T09:10:00+08:00', versionId: '1' },
        resourceType: 'MedicationRequest',
        status: 'active',
      },
    ],
    observations: [
      {
        category: [{ coding: [{ code: 'laboratory' }] }],
        code: { coding: [{ code: '13457-7', display: '低密度脂蛋白胆固醇 (LDL-C)', system: 'http://loinc.org' }] },
        effectiveDateTime: '2026-08-24T08:30:00+08:00',
        id: 'obs-ldl-baseline',
        issued: '2026-08-24T08:40:00+08:00',
        meta: { lastUpdated: '2026-08-24T08:40:00+08:00', versionId: '1' },
        status: 'final',
        valueQuantity: { unit: 'mmol/L', value: 3.6 },
      },
      {
        category: [{ coding: [{ code: 'laboratory' }] }],
        code: { coding: [{ code: '13457-7', display: '低密度脂蛋白胆固醇 (LDL-C)', system: 'http://loinc.org' }] },
        effectiveDateTime: '2026-09-14T08:30:00+08:00',
        id: 'obs-ldl-followup',
        issued: '2026-09-14T08:45:00+08:00',
        meta: { lastUpdated: '2026-09-14T08:45:00+08:00', versionId: '1' },
        status: 'final',
        valueQuantity: { unit: 'mmol/L', value: 1.25 },
      },
      {
        category: [{ coding: [{ code: 'laboratory' }] }],
        code: { coding: [{ code: '2160-0', display: '血清肌酐', system: 'http://loinc.org' }] },
        effectiveDateTime: '2026-09-14T08:30:00+08:00',
        id: 'obs-creat-followup',
        issued: '2026-09-14T08:45:00+08:00',
        meta: { lastUpdated: '2026-09-14T08:45:00+08:00', versionId: '1' },
        status: 'final',
        valueQuantity: { unit: 'umol/L', value: 112 },
      },
      {
        category: [{ coding: [{ code: 'laboratory' }] }],
        code: { coding: [{ code: '89579-7', display: '高敏肌钙蛋白I (hs-cTnI)', system: 'http://loinc.org' }] },
        effectiveDateTime: '2026-09-14T08:30:00+08:00',
        id: 'obs-hsctni-followup',
        issued: '2026-09-14T08:45:00+08:00',
        meta: { lastUpdated: '2026-09-14T08:45:00+08:00', versionId: '1' },
        status: 'final',
        valueQuantity: { unit: 'ng/mL', value: 0.012 },
      },
      ...(options.includeSuspiciousPotassium
        ? [{
            category: [{ coding: [{ code: 'laboratory' }] }],
            code: { coding: [{ code: '2823-3', display: '血清钾 (K+)', system: 'http://loinc.org' }] },
            effectiveDateTime: '2026-09-14T08:30:00+08:00',
            id: 'obs-k-suspicious',
            issued: '2026-09-14T08:45:00+08:00',
            meta: { lastUpdated: '2026-09-14T08:45:00+08:00', versionId: '1' },
            status: 'final',
            valueQuantity: { unit: 'mmol/L', value: 99 },
          }]
        : []),
    ],
  })

  const visibleCandidates = options.includeExternalUnverifiedEcho
    ? transcribeVisibleSourceHistoryFacts({
        entries: [
          {
            clinical: {
              conclusion: '外院超声心动图提示左室射血分数 LVEF 65%',
              status: 'final',
            },
            clinicalDate: '2026-09-10T10:00:00+08:00',
            entryId: 'ext-echo-1',
            resourceType: 'DiagnosticReport',
            sourceReference: 'DiagnosticReport/ext-ucg-1',
            title: '外院超声心动图',
          },
        ],
      })
    : []

  return evaluateClinicalFactLedger({
    candidates: [...localCandidates, ...visibleCandidates],
    evaluatedAsOf: '2026-09-14T10:00:00+08:00',
    patientId: 'authored-cardio-nstemi-01',
    patientSex: 'male',
    subjectId: 'case-followup-1',
    subjectKind: 'outpatient',
  })
}

const case1FollowupRubric: AgentScoringRubricInput = {
  fabricationPenaltyPoints: 5,
  items: [
    {
      expectedPatterns: ['LDL 已达标', 'LDL(?:-?C)?.*(?:已达标|达标)'],
      factVerification: {
        itemCodes: ['13457-7', '2089-1', '18262-6'],
        maxValue: 1.4,
        unit: 'mmol/L',
      },
      id: 'ldl-goal-achieved',
      labelZh: 'LDL 已达标',
      omissionPenaltyPoints: 3,
      positivePoints: 4,
      requiredWhenCondition: {
        category: 'laboratory',
        itemCodes: ['13457-7'],
        kind: 'fact',
        maxValue: 1.4,
        presence: 'present',
        requireEligible: true,
        unit: 'mmol/L',
      },
    },
    {
      expectedPatterns: ['双联抗血小板|阿司匹林.*替格瑞洛|DAPT'],
      id: 'dapt-continued',
      labelZh: '双联抗血小板治疗维持',
      omissionPenaltyPoints: 2,
      positivePoints: 3,
      requiredWhenCondition: {
        kind: 'allOf',
        nodes: [
          { category: 'medication', itemCodes: ['aspirin'], kind: 'fact', presence: 'present', requireEligible: true },
          { category: 'medication', itemCodes: ['ticagrelor'], kind: 'fact', presence: 'present', requireEligible: true },
        ],
      },
    },
    {
      expectedPatterns: ['他汀|阿托伐他汀'],
      id: 'statin-continued',
      labelZh: '他汀降脂治疗维持',
      omissionPenaltyPoints: 2,
      positivePoints: 3,
    },
    {
      expectedPatterns: ['血清肌酐|肌酐'],
      factVerification: {
        itemCodes: ['2160-0'],
        maxValue: 133,
        unit: 'umol/L',
      },
      id: 'creatinine-reviewed',
      labelZh: '血清肌酐复查结果',
      omissionPenaltyPoints: 1,
      positivePoints: 2,
    },
    {
      expectedPatterns: ['高HbA1c胰岛素调整'],
      id: 'conditional-diabetes-item',
      labelZh: '高糖化血红蛋白专项调整',
      omissionPenaltyPoints: 4,
      positivePoints: 4,
      requiredWhenCondition: {
        category: 'laboratory',
        itemCodes: ['4548-4'],
        kind: 'fact',
        minValue: 7.0,
        presence: 'present',
        requireEligible: true,
      },
    },
  ],
  packId: 'coronary-cad',
  rubricId: 'cardio-followup-v1',
  taskId: 'followup-review',
  version: '1.0.0',
}

describe('agent-output-scorer core engine', () => {
  it('exposes the default unevaluated output state helper', () => {
    expect(createUnevaluatedAgentOutputState()).toEqual({
      badge: {
        labelZh: 'Agent 输出未评测',
        status: 'unevaluated',
      },
      scoreResult: null,
    })
  })

  it('AC40 dual-draft follow-up scenario: penalizes Draft A omission, isolates Draft B fabrication, rewards Accurate Draft C', () => {
    const ledger = buildCase1FollowupLedger()

    // Draft A: accurate on DAPT/statin/creatinine, but OMITS "LDL 已达标"
    const draftA = scoreAgentDraftOutput({
      input: {
        draftFields: {
          assessment: 'NSTEMI PCI 术后随访，血清肌酐 112 umol/L 较基线稳定。',
          plan: '继续阿司匹林联合替格瑞洛双联抗血小板及阿托伐他汀钙片规律口服。',
        },
        draftText: 'NSTEMI PCI术后随访：血清肌酐 112 umol/L。继续双联抗血小板（阿司匹林+替格瑞洛）及阿托伐他汀治疗。',
        mode: 'controlled-stream',
        rubric: case1FollowupRubric,
      },
      ledger,
    })

    expect(draftA.zeroLiveModelCalls).toBe(true)
    expect(draftA.badge.status).toBe('evaluated-simulation')
    expect(draftA.omissions.map(o => o.rubricItemId)).toEqual(['ldl-goal-achieved'])
    expect(draftA.omissionPenalty).toBe(3)
    expect(draftA.fabrications).toEqual([])
    expect(draftA.fabricationPenalty).toBe(0)
    expect(draftA.keyFactCoverageRate).toBeLessThan(1)
    expect(draftA.keyFactCoverageRate).toBe(0.75) // 3 of 4 applicable items covered (5th is not-applicable)
    expect(draftA.positiveScore).toBe(8) // 3 + 3 + 2
    expect(draftA.netScore).toBe(5) // 8 - 3 - 0
    expect(draftA.coverageItems.find(c => c.rubricItemId === 'conditional-diabetes-item')?.status).toBe('not-applicable')

    // Draft B: covers all 4 key facts + fabricates nonexistent "心脏MRI未见心肌水肿，LVEF 65%"
    const draftB = scoreAgentDraftOutput({
      input: {
        draftFields: {
          assessment: 'NSTEMI PCI 术后随访，LDL-C 降至 1.25 mmol/L，LDL 已达标；血清肌酐 112 μmol/L。心脏MRI未见心肌水肿，LVEF 65%。',
          plan: '继续双联抗血小板（阿司匹林+替格瑞洛）与阿托伐他汀降脂治疗。',
        },
        draftText: 'NSTEMI PCI术后随访：LDL-C 由 3.6 降至 1.25 mmol/L，LDL 已达标；肌酐 112 μmol/L。心脏MRI未见心肌水肿，LVEF 65%。继续双联抗血小板及阿托伐他汀治疗。',
        mode: 'controlled-stream',
        rubric: case1FollowupRubric,
      },
      ledger,
    })

    expect(draftB.omissions).toEqual([])
    expect(draftB.omissionPenalty).toBe(0)
    expect(draftB.keyFactCoverageRate).toBe(1)
    expect(draftB.positiveScore).toBe(12)
    expect(draftB.fabrications).toHaveLength(1)
    expect(draftB.fabrications[0]?.reasonCode).toBe('NONEXISTENT_LAB_OR_EXAM')
    expect(draftB.fabrications[0]?.statementZh).toContain('心脏MRI')
    expect(draftB.fabricationPenalty).toBe(5)
    expect(draftB.netScore).toBe(7) // 12 - 0 - 5

    // Draft C: completely accurate, mentions historical -> current LDL, zero omissions, zero fabrications
    const draftC = scoreAgentDraftOutput({
      input: {
        draftFields: {
          assessment: 'NSTEMI PCI 术后随访，LDL-C 由基线 3.6 mmol/L 降至 1.25 mmol/L，LDL 已达标（<1.4 mmol/L）；血清肌酐 112 μmol/L，高敏肌钙蛋白I 0.012 ng/mL，十二导联心电图窦性心律。',
          plan: '继续双联抗血小板（阿司匹林+替格瑞洛）及阿托伐他汀钙片降脂治疗。',
        },
        draftText: 'NSTEMI PCI术后随访：LDL-C 由 3.6 降至 1.25 mmol/L，LDL 已达标（<1.4 mmol/L）；肌酐 112 μmol/L；hs-cTnI 0.012 ng/mL；十二导联心电图窦性心律。建议必要时完善超声心动图。继续双联抗血小板及阿托伐他汀治疗。',
        mode: 'controlled-stream',
        rubric: case1FollowupRubric,
      },
      ledger,
    })

    expect(draftC.omissions).toEqual([])
    expect(draftC.fabrications).toEqual([])
    expect(draftC.positiveScore).toBe(12)
    expect(draftC.maxPossiblePositiveScore).toBe(12)
    expect(draftC.netScore).toBe(12)
    expect(draftC.keyFactCoverageRate).toBe(1)
  })

  it('marks inaccurate numeric claim as covered-inaccurate rather than rewarding points and catches contradictions', () => {
    const ledger = buildCase1FollowupLedger()
    const ldlOnlyRubric: AgentScoringRubricInput = {
      fabricationPenaltyPoints: 5,
      items: [case1FollowupRubric.items[0]!],
      packId: 'coronary-cad',
      rubricId: 'ldl-check-v1',
      taskId: 'followup-review',
      version: '1.0.0',
    }

    const inaccurateResult = scoreAgentDraftOutput({
      input: {
        draftFields: {
          assessment: '复查 LDL-C 2.9 mmol/L，LDL 已达标。',
        },
        draftText: '复查 LDL-C 2.9 mmol/L，LDL 已达标。',
        mode: 'controlled-stream',
        rubric: ldlOnlyRubric,
      },
      ledger,
    })

    expect(inaccurateResult.coverageItems[0]?.status).toBe('covered-inaccurate')
    expect(inaccurateResult.coverageItems[0]?.pointsDelta).toBe(0)
    expect(inaccurateResult.positiveScore).toBe(0)
    expect(inaccurateResult.keyFactCoverageRate).toBe(0)
    expect(inaccurateResult.fabrications).toHaveLength(1)
    expect(inaccurateResult.fabrications[0]?.reasonCode).toBe('CONTRADICTORY_VALUE')
  })

  it('treats unverified external and suspicious ledger facts as non-backing and catches claiming them as confirmed', () => {
    const ledger = buildCase1FollowupLedger({
      includeExternalUnverifiedEcho: true,
      includeSuspiciousPotassium: true,
    })

    const result = scoreAgentDraftOutput({
      input: {
        draftFields: {
          assessment: '超声心动图 LVEF 65%；血清钾 99 mmol/L。',
        },
        draftText: '超声心动图 LVEF 65%；血清钾 99 mmol/L。',
        mode: 'controlled-stream',
        rubric: {
          fabricationPenaltyPoints: 5,
          items: [case1FollowupRubric.items[2]!], // statin item omitted here -> just check fabrications
          packId: 'coronary-cad',
          rubricId: 'unverified-check',
          taskId: 'followup-review',
          version: '1.0.0',
        },
        structuredClaims: [
          {
            category: 'examination',
            claimId: 'claim-ext-echo',
            claimedNumericValue: 65,
            claimedPresent: true,
            claimedUnit: '%',
            statementZh: '超声心动图 LVEF 65%',
          },
          {
            category: 'laboratory',
            claimId: 'claim-suspicious-k',
            claimedNumericValue: 99,
            claimedPresent: true,
            claimedUnit: 'mmol/L',
            itemCode: '2823-3',
            statementZh: '血清钾 99 mmol/L',
          },
        ],
      },
      ledger,
    })

    expect(result.fabrications).toHaveLength(2)
    expect(result.fabrications.find(f => f.claimId === 'claim-ext-echo')?.reasonCode).toBe('UNVERIFIED_EXTERNAL_USED_AS_FACT')
    expect(result.fabrications.find(f => f.claimId === 'claim-suspicious-k')?.reasonCode).toBe('CONTRADICTORY_VALUE')
    expect(result.fabricationPenalty).toBe(10)
  })

  it('computes exact clinician per-field diff edit metrics (unchanged, modified, added, deleted)', () => {
    const metrics = computeClinicianEditMetrics(
      {
        assessment: 'LDL 降至 1.25 mmol/L',
        obsoleteNote: '待删除段落',
        plan: '继续双联抗血小板治疗',
      },
      {
        assessment: 'LDL 降至 1.25 mmol/L，已达标',
        followUp: '4周后复查血脂与肝功能',
        plan: '继续双联抗血小板治疗',
      },
    )

    expect(metrics.totalFields).toBe(4)
    expect(metrics.unchangedFieldsCount).toBe(1)
    expect(metrics.modifiedFieldsCount).toBe(1)
    expect(metrics.addedFieldsCount).toBe(1)
    expect(metrics.deletedFieldsCount).toBe(1)

    const assessment = metrics.fields.find(f => f.fieldKey === 'assessment')!
    expect(assessment.status).toBe('modified')
    expect(assessment.addedChars).toBe(4) // '，已达标'
    expect(assessment.removedChars).toBe(0)

    const followUp = metrics.fields.find(f => f.fieldKey === 'followUp')!
    expect(followUp.status).toBe('added')
    expect(followUp.editRatio).toBe(1)

    const obsolete = metrics.fields.find(f => f.fieldKey === 'obsoleteNote')!
    expect(obsolete.status).toBe('deleted')
    expect(obsolete.editRatio).toBe(1)

    const plan = metrics.fields.find(f => f.fieldKey === 'plan')!
    expect(plan.status).toBe('unchanged')
    expect(plan.editRatio).toBe(0)
    expect(metrics.overallEditRatio).toBeGreaterThan(0)
    expect(metrics.overallEditRatio).toBeLessThanOrEqual(1)
  })

  it('gates live-model scoring strictly on explicit per-run permit and succeeds with zero LLM calls when permitted', () => {
    const ledger = buildCase1FollowupLedger()
    const baseInput = {
      draftFields: { plan: '继续阿托伐他汀治疗' },
      draftText: '继续阿托伐他汀治疗。',
      mode: 'live-model' as const,
      rubric: {
        fabricationPenaltyPoints: 5,
        items: [case1FollowupRubric.items[2]!],
        packId: 'coronary-cad',
        rubricId: 'live-gate-rubric',
        taskId: 'followup-review',
        version: '1.0.0',
      },
    }

    expect(() => scoreAgentDraftOutput({ input: baseInput, ledger })).toThrowError(AgentOutputScorerError)
    try {
      scoreAgentDraftOutput({ input: baseInput, ledger })
    } catch (error) {
      expect((error as AgentOutputScorerError).code).toBe('LIVE_MODEL_SCORING_PERMISSION_REQUIRED')
    }

    // Explicit false must also reject cleanly
    expect(() => scoreAgentDraftOutput({
      input: {
        ...baseInput,
        liveRunPermit: {
          authorizedAt: '2026-09-14T10:00:00+08:00',
          authorizedByActorId: 'actor-administrator',
          explicitUserPermissionGranted: false as unknown as true,
          runId: 'run-denied',
        },
      },
      ledger,
    })).toThrowError(AgentOutputScorerError)

    const permitted = scoreAgentDraftOutput({
      input: {
        ...baseInput,
        clinicianFinalFields: { plan: '继续阿托伐他汀钙片 20mg qn' },
        liveRunPermit: {
          authorizedAt: '2026-09-14T10:00:00+08:00',
          authorizedByActorId: 'actor-administrator',
          explicitUserPermissionGranted: true,
          runId: 'live-run-20260914-01',
        },
      },
      ledger,
    })

    expect(permitted.zeroLiveModelCalls).toBe(true)
    expect(permitted.badge).toEqual({
      labelZh: '真实模型本次授权已评测',
      runId: 'live-run-20260914-01',
      status: 'evaluated-live-authorized',
    })
    expect(permitted.clinicianEditMetrics?.modifiedFieldsCount).toBe(1)

    // Missing or blank runId with explicitUserPermissionGranted=true still fails with 403 gate code (never Zod 400)
    try {
      scoreAgentDraftOutput({
        input: {
          ...baseInput,
          liveRunPermit: {
            authorizedAt: '2026-09-14T10:00:00+08:00',
            authorizedByActorId: 'actor-administrator',
            explicitUserPermissionGranted: true,
            runId: '   ',
          },
        },
        ledger,
      })
      throw new Error('Expected LIVE_MODEL_SCORING_PERMISSION_REQUIRED')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentOutputScorerError)
      expect((error as AgentOutputScorerError).code).toBe('LIVE_MODEL_SCORING_PERMISSION_REQUIRED')
    }

    // Empty/whitespace field keys reject with SCORER_INVALID_INPUT instead of raw ZodError on output parse
    try {
      scoreAgentDraftOutput({
        input: {
          ...baseInput,
          draftFields: { '': 'empty key' },
          mode: 'controlled-stream',
        },
        ledger,
      })
      throw new Error('Expected SCORER_INVALID_INPUT')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentOutputScorerError)
      expect((error as AgentOutputScorerError).code).toBe('SCORER_INVALID_INPUT')
    }

    // Future-ingested ledger facts relative to evaluatedAt are excluded defensively
    const futureFactResult = scoreAgentDraftOutput({
      evaluatedAt: '2026-09-10T00:00:00+08:00',
      input: {
        draftFields: { assessment: 'LDL 已达标（1.25 mmol/L）' },
        draftText: 'LDL 已达标（1.25 mmol/L）。',
        mode: 'controlled-stream',
        rubric: {
          ...case1FollowupRubric,
          items: [case1FollowupRubric.items[0]!],
        },
      },
      ledger,
    })
    expect(futureFactResult.coverageItems[0]?.status).toBe('not-applicable')
  })

  it('derives text concept signatures purely from a custom ConceptVocabulary with zero hardcoded domain assumptions', () => {
    const customVocabulary: ConceptVocabulary = {
      mappings: [
        {
          effectiveDate: '2026-01-01',
          id: 'syn-map-tsh-exact',
          relation: 'exact',
          reviewStatus: 'approved',
          reviewerId: 'reviewer-endo-01',
          sourceCode: 'LAB-TSH-LOCAL',
          sourceDisplay: '甲功TSH',
          sourceSystem: 'urn:clinmesh:synthetic-lab',
          targetConceptCode: 'SYN-TSH',
          version: '1.0.0',
        },
        {
          effectiveDate: '2026-01-01',
          id: 'syn-map-ft4-unapproved',
          relation: 'exact',
          reviewStatus: 'proposed',
          reviewerId: null,
          sourceCode: 'LAB-FT4-PROP',
          sourceDisplay: '未审核甲功FT4',
          sourceSystem: 'urn:clinmesh:synthetic-lab',
          targetConceptCode: 'SYN-FT4',
          version: '1.0.0',
        },
        {
          effectiveDate: '2026-01-01',
          id: 'syn-map-ft4-close',
          relation: 'close',
          reviewStatus: 'approved',
          reviewerId: 'reviewer-endo-01',
          sourceCode: 'LAB-FT4-CLOSE',
          sourceDisplay: '总甲状腺素近似项',
          sourceSystem: 'urn:clinmesh:synthetic-lab',
          targetConceptCode: 'SYN-FT4',
          version: '1.0.0',
        },
        {
          effectiveDate: '2026-12-01',
          id: 'syn-map-tsh-future',
          relation: 'exact',
          reviewStatus: 'approved',
          reviewerId: 'reviewer-endo-01',
          sourceCode: 'LAB-TSH-FUTURE',
          sourceDisplay: '未来生效TSH别名',
          sourceSystem: 'urn:clinmesh:synthetic-lab',
          targetConceptCode: 'SYN-TSH',
          version: '1.0.0',
        },
      ],
      nodes: [
        {
          code: 'SYN-TSH',
          displayEn: 'Thyroid Stimulating Hormone',
          displayZh: '促甲状腺激素 (TSH)',
          domain: 'laboratory',
          layer: 'public',
          parentCode: null,
          synonyms: ['TSH', '促甲状腺素'],
        },
        {
          code: 'SYN-FT4',
          displayEn: 'Free Thyroxine',
          displayZh: '游离甲状腺素 (FT4)',
          domain: 'laboratory',
          layer: 'public',
          parentCode: null,
          synonyms: ['FT4'],
        },
        {
          code: 'SYN-THYROID-US',
          displayEn: 'Thyroid Ultrasound',
          displayZh: '甲状腺超声',
          domain: 'examination',
          layer: 'public',
          parentCode: null,
          synonyms: ['甲状腺彩超'],
        },
        {
          code: 'SYN-NODULE-DIAM',
          displayEn: 'Thyroid Nodule Maximum Diameter',
          displayZh: '甲状腺结节最大径',
          domain: 'examination',
          layer: 'public',
          parentCode: 'SYN-THYROID-US',
          synonyms: ['结节最大径'],
        },
      ],
      version: 'synthetic-1.0.0',
    }

    const builtSignatures = buildTextConceptSignaturesFromVocabulary(customVocabulary, { asOfDate: '2026-09-14' })
    const tshSig = builtSignatures.find(sig => sig.id === 'SYN-TSH')!
    expect(tshSig).toBeDefined()
    expect(tshSig.itemCodes).toEqual(['SYN-TSH', 'LAB-TSH-LOCAL'])
    expect(tshSig.ledgerKeywords).toContain('甲功TSH')
    expect(tshSig.ledgerKeywords).not.toContain('未来生效TSH别名')
    const ft4Sig = builtSignatures.find(sig => sig.id === 'SYN-FT4')!
    expect(ft4Sig.itemCodes).toEqual(['SYN-FT4'])
    expect(ft4Sig.ledgerKeywords).not.toContain('未审核甲功FT4')
    expect(ft4Sig.ledgerKeywords).not.toContain('总甲状腺素近似项')

    const ledger = evaluateClinicalFactLedger({
      candidates: transcribeLocalFhirFacts({
        observations: [
          {
            category: [{ coding: [{ code: 'laboratory' }] }],
            code: { coding: [{ code: 'LAB-TSH-LOCAL', display: '甲功TSH', system: 'urn:clinmesh:synthetic-lab' }] },
            effectiveDateTime: '2026-09-14T08:30:00+08:00',
            id: 'obs-syn-tsh',
            issued: '2026-09-14T08:45:00+08:00',
            meta: { lastUpdated: '2026-09-14T08:45:00+08:00', versionId: '1' },
            status: 'final',
            valueQuantity: { unit: 'mIU/L', value: 8.2 },
          },
        ],
      }),
      evaluatedAsOf: '2026-09-14T10:00:00+08:00',
      patientId: 'syn-endo-patient-01',
      patientSex: 'female',
      subjectId: 'case-syn-endo-01',
      subjectKind: 'outpatient',
    })

    const endoRubric: AgentScoringRubricInput = {
      fabricationPenaltyPoints: 5,
      items: [
        {
          expectedPatterns: ['促甲状腺激素|甲功TSH|TSH'],
          factVerification: {
            itemCodes: ['SYN-TSH'],
            minValue: 4.5,
            unit: 'mIU/L',
          },
          id: 'tsh-elevated',
          labelZh: '促甲状腺激素升高评估',
          omissionPenaltyPoints: 2,
          positivePoints: 4,
          requiredWhenCondition: {
            category: 'laboratory',
            itemCodes: ['SYN-TSH'],
            kind: 'fact',
            minValue: 4.5,
            presence: 'present',
            requireEligible: true,
            unit: 'mIU/L',
          },
        },
      ],
      packId: 'synthetic-endocrine-test',
      rubricId: 'syn-endo-rubric-v1',
      taskId: 'followup-review',
      version: '1.0.0',
    }

    // Accurate draft using mapped local term + uIU/mL unit equivalence (1 uIU/mL === 1 mIU/L);
    // mentioning an unconfigured non-vocabulary term ("心脏MRI") triggers zero hardcoded matches
    const accurateResult = scoreAgentDraftOutput({
      conceptVocabulary: customVocabulary,
      input: {
        draftFields: {
          assessment: '甲功TSH 8.2 uIU/mL，促甲状腺激素明显升高。',
          note: '既往心脏MRI未见心肌水肿。',
        },
        draftText: '促甲状腺激素 8.2 mIU/L 升高。',
        mode: 'controlled-stream',
        rubric: endoRubric,
      },
      ledger,
    })
    expect(accurateResult.positiveScore).toBe(4)
    expect(accurateResult.fabrications).toEqual([])

    // Fabricating missing SYN-FT4 + missing ultrasound/nodule pair + contradicting SYN-TSH
    const fabricationResult = scoreAgentDraftOutput({
      conceptVocabulary: customVocabulary,
      input: {
        draftFields: {
          assessment: 'TSH 2.1 mIU/L；游离甲状腺素 25.0 pmol/L。甲状腺超声未见结节，结节最大径 12 mm。',
        },
        draftText: 'TSH 2.1 mIU/L；游离甲状腺素 25.0 pmol/L。甲状腺超声未见结节，结节最大径 12 mm。',
        mode: 'controlled-stream',
        rubric: endoRubric,
      },
      ledger,
    })
    expect(fabricationResult.coverageItems[0]?.status).toBe('covered-inaccurate')
    expect(fabricationResult.fabrications).toHaveLength(3)
    expect(fabricationResult.fabrications.map(f => f.reasonCode)).toEqual([
      'CONTRADICTORY_VALUE',
      'NONEXISTENT_LAB_OR_EXAM',
      'NONEXISTENT_LAB_OR_EXAM',
    ])
    expect(fabricationResult.fabrications.some(f => f.statementZh.includes('甲状腺超声'))).toBe(true)
    expect(fabricationResult.fabrications.some(f => f.statementZh.includes('游离甲状腺素'))).toBe(true)
  })

  it('excludes vocabulary superstrings dynamically (糖化血红蛋白 vs 血红蛋白, 动态心电图 vs 心电图, NT-proBNP vs BNP)', () => {
    const ledger = evaluateClinicalFactLedger({
      candidates: transcribeLocalFhirFacts({
        diagnosticReports: [
          {
            category: [{ coding: [{ code: 'ECG' }] }],
            code: { coding: [{ code: '18754-2', display: '动态心电图', system: 'http://loinc.org' }] },
            conclusion: '24小时动态心电图提示窦性心律，偶发房早',
            effectiveDateTime: '2026-09-14T08:00:00+08:00',
            id: 'rep-holter-only',
            issued: '2026-09-14T08:30:00+08:00',
            meta: { lastUpdated: '2026-09-14T08:30:00+08:00', versionId: '1' },
            status: 'final',
          },
        ],
        observations: [
          {
            category: [{ coding: [{ code: 'laboratory' }] }],
            code: { coding: [{ code: '4548-4', display: '糖化血红蛋白 (HbA1c)', system: 'http://loinc.org' }] },
            effectiveDateTime: '2026-09-14T08:00:00+08:00',
            id: 'obs-hba1c-only',
            issued: '2026-09-14T08:30:00+08:00',
            meta: { lastUpdated: '2026-09-14T08:30:00+08:00', versionId: '1' },
            status: 'final',
            valueQuantity: { unit: '%', value: 7.2 },
          },
          {
            category: [{ coding: [{ code: 'laboratory' }] }],
            code: { coding: [{ code: '33762-6', display: '氨基末端脑利钠肽前体 (NT-proBNP)', system: 'http://loinc.org' }] },
            effectiveDateTime: '2026-09-14T08:00:00+08:00',
            id: 'obs-ntprobnp-only',
            issued: '2026-09-14T08:30:00+08:00',
            meta: { lastUpdated: '2026-09-14T08:30:00+08:00', versionId: '1' },
            status: 'final',
            valueQuantity: { unit: 'pg/mL', value: 1200 },
          },
        ],
      }),
      evaluatedAsOf: '2026-09-14T10:00:00+08:00',
      patientId: 'syn-superstring-01',
      patientSex: 'male',
      subjectId: 'case-superstring-01',
      subjectKind: 'outpatient',
    })

    const genericRubric: AgentScoringRubricInput = {
      fabricationPenaltyPoints: 5,
      items: [
        {
          expectedPatterns: ['糖化血红蛋白|HbA1c'],
          factVerification: { itemCodes: ['4548-4'], minValue: 7.0, unit: '%' },
          id: 'hba1c-checked',
          labelZh: '糖化血红蛋白核对',
          omissionPenaltyPoints: 2,
          positivePoints: 3,
        },
      ],
      packId: 'synthetic-superstring-test',
      rubricId: 'superstring-v1',
      taskId: 'followup-review',
      version: '1.0.0',
    }

    // Must NOT falsely trigger missing 718-7 (血红蛋白), 11524-6 (心电图), or 30934-4 (BNP)
    const cleanResult = scoreAgentDraftOutput({
      input: {
        draftFields: {
          assessment: '糖化血红蛋白 7.2%；NT-proBNP 1200 pg/mL；动态心电图提示窦性心律。',
        },
        draftText: '糖化血红蛋白 7.2%，NT-proBNP 1200 pg/mL，动态心电图窦性心律。',
        mode: 'controlled-stream',
        rubric: genericRubric,
      },
      ledger,
    })
    expect(cleanResult.positiveScore).toBe(3)
    expect(cleanResult.fabrications).toEqual([])

    // Same-clause mention of BOTH 糖化血红蛋白 and missing 血红蛋白 still detects missing 血红蛋白
    const mixedClauseResult = scoreAgentDraftOutput({
      input: {
        draftFields: {
          assessment: '糖化血红蛋白 7.2% 且血红蛋白 120 g/L。',
        },
        draftText: '糖化血红蛋白 7.2% 且血红蛋白 120 g/L。',
        mode: 'controlled-stream',
        rubric: genericRubric,
      },
      ledger,
    })
    expect(mixedClauseResult.fabrications).toHaveLength(1)
    expect(mixedClauseResult.fabrications[0]?.itemCode).toBe('718-7')
    expect(mixedClauseResult.fabrications[0]?.reasonCode).toBe('NONEXISTENT_LAB_OR_EXAM')
  })

  it('supports metadata-driven UCUM unit conversion including hospital-mapped codes', () => {
    const vocabWithHospitalCreatinine = mergeThreeLayerConceptVocabulary({
      hospitalLayer: {
        mappings: [
          {
            effectiveDate: '2026-01-01',
            hospitalId: 'hosp-alpha',
            id: 'hosp-map-scr-exact',
            relation: 'exact',
            reviewStatus: 'approved',
            reviewerId: 'rev-hosp-01',
            sourceCode: 'HOSP-SCR-01',
            sourceDisplay: '本院血肌酐',
            sourceSystem: 'urn:hosp:alpha',
            targetConceptCode: '2160-0',
            version: '1.0.0',
          },
        ],
        nodes: [],
        version: '1.0.0',
      },
    })

    const ledger = evaluateClinicalFactLedger({
      candidates: transcribeLocalFhirFacts({
        observations: [
          {
            category: [{ coding: [{ code: 'laboratory' }] }],
            code: { coding: [{ code: 'HOSP-SCR-01', display: '本院血肌酐', system: 'urn:hosp:alpha' }] },
            effectiveDateTime: '2026-09-14T08:00:00+08:00',
            id: 'obs-hosp-scr',
            issued: '2026-09-14T08:30:00+08:00',
            meta: { lastUpdated: '2026-09-14T08:30:00+08:00', versionId: '1' },
            status: 'final',
            valueQuantity: { unit: 'umol/L', value: 112 },
          },
          {
            category: [{ coding: [{ code: 'laboratory' }] }],
            code: { coding: [{ code: '718-7', display: '血红蛋白', system: 'http://loinc.org' }] },
            effectiveDateTime: '2026-09-14T08:00:00+08:00',
            id: 'obs-hb-gl',
            issued: '2026-09-14T08:30:00+08:00',
            meta: { lastUpdated: '2026-09-14T08:30:00+08:00', versionId: '1' },
            status: 'final',
            valueQuantity: { unit: 'g/L', value: 120 },
          },
        ],
      }),
      evaluatedAsOf: '2026-09-14T10:00:00+08:00',
      patientId: 'syn-unit-01',
      patientSex: 'male',
      subjectId: 'case-unit-01',
      subjectKind: 'outpatient',
    })

    const result = scoreAgentDraftOutput({
      conceptVocabulary: vocabWithHospitalCreatinine,
      input: {
        draftFields: {
          assessment: '本院血肌酐 1.27 mg/dL，血红蛋白 12 g/dL。',
        },
        draftText: '本院血肌酐 1.27 mg/dL，血红蛋白 12 g/dL。',
        mode: 'controlled-stream',
        rubric: {
          fabricationPenaltyPoints: 5,
          items: [
            {
              expectedPatterns: ['血肌酐|肌酐'],
              factVerification: { itemCodes: ['2160-0'], maxValue: 133, unit: 'umol/L' },
              id: 'hosp-scr-check',
              labelZh: '血肌酐核对',
              omissionPenaltyPoints: 1,
              positivePoints: 2,
            },
            {
              expectedPatterns: ['血红蛋白'],
              factVerification: { itemCodes: ['718-7'], minValue: 110, unit: 'g/L' },
              id: 'hb-check',
              labelZh: '血红蛋白核对',
              omissionPenaltyPoints: 1,
              positivePoints: 2,
            },
          ],
          packId: 'synthetic-unit-test',
          rubricId: 'unit-conv-v1',
          taskId: 'followup-review',
          version: '1.0.0',
        },
      },
      ledger,
    })

    expect(result.positiveScore).toBe(4)
    expect(result.fabrications).toEqual([])
  })
})
