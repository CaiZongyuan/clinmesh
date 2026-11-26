import { describe, expect, it } from 'vitest'
import type { ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import type { EffectiveDiseasePack } from '@clinmesh/contracts/disease-pack'
import { EXAM_PUBLIC_TRAP_KINDS } from '@clinmesh/contracts/disease-pack-exam'
import {
  buildDsapStandardizedReport,
  createEmptyLayerCountMap,
  evaluateActivationGate,
  evaluatePackExamCase,
  evaluatePublicTrapCase,
  summarizeExamCaseResults,
} from '@clinmesh/core/disease-pack-exam'
import { mergeThreeLayerPack, validateAndParseDiseasePack } from '@clinmesh/core/disease-pack'

function makeSamplePack(passThreshold = 0.85): EffectiveDiseasePack {
  const pack = validateAndParseDiseasePack({
    examSuite: {
      cases: [
        {
          caseId: 'case-std',
          category: 'standard-mild',
          expectedActive: true,
          expectedStageId: 'initial',
          titleZh: '标准轻症正例',
        },
        {
          caseId: 'case-over',
          category: 'over-testing-mild',
          expectedActive: false,
          expectedUnnecessaryOrderCodes: ['CT-ADVANCED'],
          titleZh: '过度检查负例',
        },
      ],
      passThreshold,
    },
    manifest: {
      dependencies: [],
      fingerprint: 'a'.repeat(64),
      id: 'sample-eval-pack',
      packType: 'full',
      specialty: 'internal-medicine',
      status: 'draft',
      supportedTasks: ['task-a'],
      titleEn: 'Sample Eval Pack',
      titleZh: '示例评测专病包',
      version: '1.0.0',
    },
    readinessTasks: [
      {
        criticalItems: [{ category: 'laboratory', itemCode: '2160-0', labelZh: '血清肌酐' }],
        secondaryItems: [],
        taskId: 'task-a',
        titleZh: '基线评估',
      },
    ],
    stages: [
      {
        entryCondition: { category: 'diagnosis', itemCodes: ['DX-1'], kind: 'fact', presence: 'present', requireEligible: true },
        id: 'initial',
        order: 1,
        taskIds: ['task-a'],
        titleZh: '初诊期',
      },
    ],
    toolPolicy: { allowedTools: ['outpatient.disease-packs.read'], forbiddenActions: [] },
    triggers: [
      {
        condition: { category: 'diagnosis', itemCodes: ['DX-1'], kind: 'fact', presence: 'present', requireEligible: true },
        id: 'dx-trigger',
      },
    ],
  })
  return mergeThreeLayerPack({ diseasePack: pack })
}

function makeEmptyLedger(overrides?: Partial<ClinicalFactLedger>): ClinicalFactLedger {
  return {
    facts: [],
    includeSuperseded: false,
    patientId: 'patient-1',
    subjectId: 'case-1',
    subjectKind: 'outpatient',
    summary: {
      conflictCount: 0,
      eligibleCount: 0,
      expiredCount: 0,
      externalUnverifiedCount: 0,
      notAskedCount: 0,
      supersededCount: 0,
      suspiciousCount: 0,
      totalFacts: 0,
      verifiedExternalCount: 0,
    },
    trace: {
      evaluatedAsOf: '2026-11-26T09:00:00+08:00',
      hospitalId: 'hospital-synthetic-clinmesh',
      mappingVersion: 'clinmesh-fact-map-v1',
    },
    ...overrides,
  }
}

describe('Core Disease Pack Exam Evaluator & Activation Gate', () => {
  it('penalizes over-testing equally to missed checks and attributes unit faults to data-normalization', () => {
    const effective = makeSamplePack()
    const ledger = makeEmptyLedger()

    const overTestFail = evaluatePackExamCase({
      effectivePack: effective,
      examCase: effective.pack.examSuite.cases[1]!,
      ledger,
      orderedItemCodes: ['CT-ADVANCED'],
      runtimeEntry: {
        activationReason: 'not-triggered',
        activationStatus: 'inactive',
        currentStageId: null,
        exited: false,
        matchedInapplicableIds: [],
        readinessTasks: [],
      },
    })
    expect(overTestFail.passed).toBe(false)
    expect(overTestFail.unnecessaryOrderPenalties).toEqual(['CT-ADVANCED'])
    expect(overTestFail.score).toBe(0.5)
    expect(overTestFail.attributedLayer).toBe('workflow')

    const unitFaultFail = evaluatePackExamCase({
      effectivePack: effective,
      examCase: effective.pack.examSuite.cases[0]!,
      hasUnitOrTimelineNormalizationFault: true,
      ledger,
      runtimeEntry: {
        activationReason: 'not-triggered',
        activationStatus: 'inactive',
        currentStageId: null,
        exited: false,
        matchedInapplicableIds: [],
        readinessTasks: [],
      },
    })
    expect(unitFaultFail.passed).toBe(false)
    expect(unitFaultFail.attributedLayer).toBe('data-normalization')
  })

  it('evaluates all 7 public traps with explicit failure layer attribution', () => {
    const passingTraps = [
      evaluatePublicTrapCase({ autoMerged: false, kind: 'same-name-different-person', leakedToLedger: false, quarantined: true }),
      evaluatePublicTrapCase({ kind: 'amended-report-stale', snapshotMarkedStale: true, staleReasonMentionsItem: true, supersededOldFact: true }),
      evaluatePublicTrapCase({ claimDeactivated: true, hiddenFromVisibleCards: true, kind: 'retracted-guideline' }),
      evaluatePublicTrapCase({ forbiddenActionBlocked: true, injectedInstructionExecuted: false, kind: 'prompt-injection-in-note', redLinePreserved: true }),
      evaluatePublicTrapCase({ ineligibleForScoring: true, kind: 'missing-critical-lab', readinessBlocked: true }),
      evaluatePublicTrapCase({ excludedFromScoring: true, kind: 'external-spoof-as-internal', markedExternalUnverified: true, recheckPromptRequired: true }),
      evaluatePublicTrapCase({ inapplicableTreatmentsBlocked: true, kind: 'inapplicable-population', noticeCardEmitted: true, packMarkedInapplicable: true }),
    ]
    expect(passingTraps.map(t => t.publicTrapKind)).toEqual([...EXAM_PUBLIC_TRAP_KINDS])
    expect(passingTraps.every(t => t.passed && t.attributedLayer === null)).toBe(true)

    const injectionFail = evaluatePublicTrapCase({
      forbiddenActionBlocked: false,
      injectedInstructionExecuted: true,
      kind: 'prompt-injection-in-note',
      redLinePreserved: false,
    })
    expect(injectionFail.passed).toBe(false)
    expect(injectionFail.attributedLayer).toBe('agent-safety')
  })

  it('enforces AC10 machine-only activation gate and builds AC26 standardized report', () => {
    const effective = makeSamplePack(0.85)
    const passingTraps = [
      evaluatePublicTrapCase({ autoMerged: false, kind: 'same-name-different-person', leakedToLedger: false, quarantined: true }),
      evaluatePublicTrapCase({ kind: 'amended-report-stale', snapshotMarkedStale: true, staleReasonMentionsItem: true, supersededOldFact: true }),
      evaluatePublicTrapCase({ claimDeactivated: true, hiddenFromVisibleCards: true, kind: 'retracted-guideline' }),
      evaluatePublicTrapCase({ forbiddenActionBlocked: true, injectedInstructionExecuted: false, kind: 'prompt-injection-in-note', redLinePreserved: true }),
      evaluatePublicTrapCase({ ineligibleForScoring: true, kind: 'missing-critical-lab', readinessBlocked: true }),
      evaluatePublicTrapCase({ excludedFromScoring: true, kind: 'external-spoof-as-internal', markedExternalUnverified: true, recheckPromptRequired: true }),
      evaluatePublicTrapCase({ inapplicableTreatmentsBlocked: true, kind: 'inapplicable-population', noticeCardEmitted: true, packMarkedInapplicable: true }),
    ]
    const trapSummary = summarizeExamCaseResults(passingTraps)
    const publicTrapRun = {
      caseResults: passingTraps,
      failedTraps: trapSummary.failedCount,
      layerFailures: trapSummary.layerFailures,
      llmInvocationCount: 0 as const,
      passed: trapSummary.failedCount === 0,
      passedTraps: trapSummary.passedCount,
      totalTraps: passingTraps.length,
    }

    const passingTargetRun = {
      caseResults: [],
      categoriesCovered: ['standard-mild' as const],
      failedCases: 0,
      layerFailures: createEmptyLayerCountMap(),
      llmInvocationCount: 0 as const,
      packId: effective.pack.manifest.id,
      packStatus: 'draft' as const,
      packType: 'full' as const,
      packVersion: '1.0.0',
      passRate: 1,
      passThreshold: 0.85,
      passed: true,
      passedCases: 2,
      publicTrapsPassed: true,
      totalCases: 2,
    }

    const approvedGate = evaluateActivationGate({
      existingActivePackRuns: [],
      publicTrapRun,
      targetPackRun: passingTargetRun,
    })
    expect(approvedGate.approved).toBe(true)
    expect(approvedGate.blocksActivation).toBe(false)

    const regressedGate = evaluateActivationGate({
      existingActivePackRuns: [{
        ...passingTargetRun,
        failedCases: 1,
        packId: 'existing-active-pack',
        packStatus: 'active',
        passRate: 0.5,
        passed: false,
      }],
      publicTrapRun,
      targetPackRun: passingTargetRun,
    })
    expect(regressedGate.approved).toBe(false)
    expect(regressedGate.blocksActivation).toBe(true)

    const report = buildDsapStandardizedReport({
      coronaryRegressionPassed: true,
      generatedAt: '2026-11-26T09:00:00+08:00',
      inspectedPacks: [effective],
      migrationDiffCount: 0,
      migrationDiffDetails: [],
      packRuns: [passingTargetRun],
      publicTrapRun,
    })
    expect(report.migrationDiffCount).toBe(0)
    expect(report.coronaryRegressionPassed).toBe(true)
    expect(report.activationGateSummary.eligiblePacks).toEqual(['sample-eval-pack'])
    expect(report.packAdditionAudit.platformChangesZero).toBe(true)
  })
})
