import { describe, expect, it } from 'vitest'
import { diseasePackExamCaseSchema, diseasePackSchema } from '@clinmesh/contracts/disease-pack'
import {
  EXAM_CATEGORIES,
  EXAM_FAILURE_LAYERS,
  EXAM_PUBLIC_TRAP_KINDS,
  adminDiseasePackActivateInputSchema,
  adminDiseasePackExamRunInputSchema,
  diseasePackActivationGateResponseSchema,
  dsapExamRunResponseSchema,
  dsapStandardizedReportSchema,
  examCaseResultSchema,
  examCategorySchema,
  examFailureLayerSchema,
  examPublicTrapKindSchema,
  packExamRunResultSchema,
} from '@clinmesh/contracts/disease-pack-exam'
import { getHisOperation } from '@clinmesh/contracts/his-operations'

describe('Disease Pack Exam & Standardized Report Contracts', () => {
  it('defines all 5 failure layers, 7 exam categories, and 7 public traps', () => {
    expect(EXAM_FAILURE_LAYERS).toEqual([
      'data-normalization',
      'terminology-mapping',
      'knowledge',
      'agent-safety',
      'workflow',
    ])
    expect(EXAM_CATEGORIES).toEqual([
      'standard-mild',
      'inpatient-severe',
      'missing-critical-data',
      'red-line-violation',
      'multi-disease-conflict',
      'over-testing-mild',
      'public-trap',
    ])
    expect(EXAM_PUBLIC_TRAP_KINDS).toEqual([
      'same-name-different-person',
      'amended-report-stale',
      'retracted-guideline',
      'prompt-injection-in-note',
      'missing-critical-lab',
      'external-spoof-as-internal',
      'inapplicable-population',
    ])
    for (const layer of EXAM_FAILURE_LAYERS) {
      expect(examFailureLayerSchema.parse(layer)).toBe(layer)
    }
    for (const category of EXAM_CATEGORIES) {
      expect(examCategorySchema.parse(category)).toBe(category)
    }
    for (const trap of EXAM_PUBLIC_TRAP_KINDS) {
      expect(examPublicTrapKindSchema.parse(trap)).toBe(trap)
    }
  })

  it('extends diseasePackExamCaseSchema backwards-compatibly with optional category, layer, and clinical expectations', () => {
    const legacy = diseasePackExamCaseSchema.parse({
      caseId: 'legacy-case-1',
      expectedActive: true,
      expectedBlockedTaskIds: ['pci-preop-guideline-advice'],
      expectedStageId: 'pci-preop',
      titleZh: '兼容旧版考卷用例',
    })
    expect(legacy.caseId).toBe('legacy-case-1')

    const extended = diseasePackExamCaseSchema.parse({
      caseId: 'extended-case-1',
      category: 'over-testing-mild',
      expectedActive: false,
      expectedExited: true,
      expectedInapplicable: false,
      expectedKnowledgeClaimValid: true,
      expectedReadyTaskIds: ['followup-review'],
      expectedRedLineCodes: ['RENAL_CONTRAINDICATED_MEDICATION'],
      expectedRuleOutActive: true,
      expectedScoreFormulaIds: ['grace-acs'],
      expectedUnnecessaryOrderCodes: ['CT-CORONARY-CTA'],
      layer: 'workflow',
      publicTrapKind: 'missing-critical-lab',
      titleZh: '扩展考卷用例',
    })
    expect(extended.category).toBe('over-testing-mild')
    expect(extended.expectedUnnecessaryOrderCodes).toEqual(['CT-CORONARY-CTA'])

    const badPack = diseasePackSchema.safeParse({
      examSuite: {
        cases: [{ caseId: 'x', expectedActive: true, titleZh: 'x', unknownField: 1 }],
        passThreshold: 0.85,
      },
    })
    expect(badPack.success).toBe(false)
  })

  it('validates exam case results, pack run results, standardized reports, and admin gate payloads', () => {
    const caseResult = examCaseResultSchema.parse({
      attributedLayer: null,
      caseId: 'case-1',
      category: 'standard-mild',
      declaredLayer: 'workflow',
      failureReasonZh: null,
      missedChecks: [],
      packId: 'sample-pack',
      passed: true,
      score: 1,
      titleZh: '标准轻症用例',
      unnecessaryOrderPenalties: [],
    })
    const layerCounts = {
      'agent-safety': 0,
      'data-normalization': 0,
      knowledge: 0,
      'terminology-mapping': 0,
      workflow: 0,
    }
    const packRun = packExamRunResultSchema.parse({
      caseResults: [caseResult],
      categoriesCovered: ['standard-mild'],
      failedCases: 0,
      layerFailures: layerCounts,
      llmInvocationCount: 0,
      packId: 'sample-pack',
      packStatus: 'draft',
      packType: 'full',
      packVersion: '1.0.0',
      passRate: 1,
      passThreshold: 0.85,
      passed: true,
      passedCases: 1,
      publicTrapsPassed: true,
      totalCases: 1,
    })
    const emptyLayerSummary = (layer: typeof EXAM_FAILURE_LAYERS[number]) => ({
      failureCount: 0,
      failingCases: [],
      layer,
    })
    const report = dsapStandardizedReportSchema.parse({
      activationGateSummary: {
        blockedPacks: [],
        eligiblePacks: ['sample-pack'],
        llmInvocationCount: 0,
      },
      coronaryRegressionPassed: true,
      failureSummaryByLayer: {
        'agent-safety': emptyLayerSummary('agent-safety'),
        'data-normalization': emptyLayerSummary('data-normalization'),
        knowledge: emptyLayerSummary('knowledge'),
        'terminology-mapping': emptyLayerSummary('terminology-mapping'),
        workflow: emptyLayerSummary('workflow'),
      },
      generatedAt: '2026-11-26T09:00:00+08:00',
      llmInvocationCount: 0,
      migrationDiffCount: 0,
      migrationDiffDetails: [],
      packAdditionAudit: {
        addedEntriesCount: { examCases: 1, knowledgeClaims: 2, mappings: 3, questionnaireItems: 1 },
        contractChangedFiles: [],
        platformChangesZero: true,
        platformCodeChangedFiles: [],
        reuseRatio: 1,
      },
      packRuns: [packRun],
      publicTrapRun: {
        caseResults: [],
        failedTraps: 0,
        layerFailures: layerCounts,
        llmInvocationCount: 0,
        passed: true,
        passedTraps: 0,
        totalTraps: 0,
      },
      sourceSystemAgnostic: {
        concluded: true,
        inspectedSourceSystems: ['clinmesh-his-fhir', 'clinmesh-lis-v2'],
        summaryZh: '平台引擎仅消费临床事实总账标准结构，不绑定具体来源系统。',
      },
    })
    expect(dsapExamRunResponseSchema.parse({ llmInvocationCount: 0, passed: true, report }).passed).toBe(true)

    const gateRes = diseasePackActivationGateResponseSchema.parse({
      activated: true,
      blocksActivation: false,
      gateDecision: 'approved',
      llmInvocationCount: 0,
      packId: 'sample-pack',
      packRun,
      previousStatus: 'draft',
      publicTrapRun: report.publicTrapRun,
      regressionChecks: [],
      status: 'active',
    })
    expect(gateRes.activated).toBe(true)
  })

  it('registers admin.disease-packs.exam.run and admin.disease-packs.activate strictly under clinmesh-administrator without z.union', () => {
    expect(adminDiseasePackExamRunInputSchema.parse({})).toEqual({
      includePublicTraps: true,
      injectFault: 'none',
    })
    expect(adminDiseasePackActivateInputSchema.parse({ packId: 'sample-pack' })).toEqual({
      packId: 'sample-pack',
    })

    const examRunOp = getHisOperation('admin.disease-packs.exam.run')
    expect(examRunOp.cliPath).toEqual(['admin', 'disease-packs', 'exam-run'])
    expect(examRunOp.roles).toEqual(['administrator'])
    expect(examRunOp.skill).toBe('clinmesh-administrator')

    const activateOp = getHisOperation('admin.disease-packs.activate')
    expect(activateOp.cliPath).toEqual(['admin', 'disease-packs', 'activate'])
    expect(activateOp.roles).toEqual(['administrator'])
    expect(activateOp.skill).toBe('clinmesh-administrator')
    expect(activateOp.requirements).toEqual({ expectedVersions: false, idempotency: 'required' })
  })
})
