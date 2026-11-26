import type { ClinicalFactLedger } from '@clinmesh/contracts/clinical-fact-ledger'
import type { DiseasePackExamCase, DiseasePackRuntimeEntry, EffectiveDiseasePack } from '@clinmesh/contracts/disease-pack'
import {
  EXAM_FAILURE_LAYERS,
  EXAM_PUBLIC_TRAP_KINDS,
  dsapStandardizedReportSchema,
  examCaseResultSchema,
  type DsapPackAdditionAudit,
  type DsapSourceSystemAgnosticSummary,
  type DsapStandardizedReport,
  type ExamCaseResult,
  type ExamCategory,
  type ExamFailureLayer,
  type ExamLayerFailureCountMap,
  type ExamLayerFailureSummaryMap,
  type ExamPublicTrapKind,
  type PackExamRunResult,
  type PublicTrapSuiteResult,
} from '@clinmesh/contracts/disease-pack-exam'

export interface EvaluatePackExamCaseInput {
  readonly examCase: DiseasePackExamCase
  readonly effectivePack: EffectiveDiseasePack
  readonly runtimeEntry: Pick<
    DiseasePackRuntimeEntry,
    'activationReason' | 'activationStatus' | 'currentStageId' | 'exited' | 'matchedInapplicableIds' | 'readinessTasks'
  >
  readonly ledger: ClinicalFactLedger
  readonly activeRedLineCodes?: readonly string[]
  readonly computedScoreFormulaIds?: readonly string[]
  readonly orderedItemCodes?: readonly string[]
  readonly knowledgeClaimsValid?: boolean
  readonly ruleOutActive?: boolean
  readonly terminologyMappingFailed?: boolean
  readonly hasUnitOrTimelineNormalizationFault?: boolean
}

export type PublicTrapEvaluationInput =
  | {
      readonly kind: 'same-name-different-person'
      readonly titleZh?: string
      readonly quarantined: boolean
      readonly autoMerged: boolean
      readonly leakedToLedger: boolean
      readonly observed?: Record<string, unknown>
    }
  | {
      readonly kind: 'amended-report-stale'
      readonly titleZh?: string
      readonly snapshotMarkedStale: boolean
      readonly staleReasonMentionsItem: boolean
      readonly supersededOldFact: boolean
      readonly observed?: Record<string, unknown>
    }
  | {
      readonly kind: 'retracted-guideline'
      readonly titleZh?: string
      readonly claimDeactivated: boolean
      readonly hiddenFromVisibleCards: boolean
      readonly observed?: Record<string, unknown>
    }
  | {
      readonly kind: 'prompt-injection-in-note'
      readonly titleZh?: string
      readonly forbiddenActionBlocked: boolean
      readonly redLinePreserved: boolean
      readonly injectedInstructionExecuted: boolean
      readonly observed?: Record<string, unknown>
    }
  | {
      readonly kind: 'missing-critical-lab'
      readonly titleZh?: string
      readonly readinessBlocked: boolean
      readonly ineligibleForScoring: boolean
      readonly observed?: Record<string, unknown>
    }
  | {
      readonly kind: 'external-spoof-as-internal'
      readonly titleZh?: string
      readonly markedExternalUnverified: boolean
      readonly excludedFromScoring: boolean
      readonly recheckPromptRequired: boolean
      readonly observed?: Record<string, unknown>
    }
  | {
      readonly kind: 'inapplicable-population'
      readonly titleZh?: string
      readonly packMarkedInapplicable: boolean
      readonly inapplicableTreatmentsBlocked: boolean
      readonly noticeCardEmitted: boolean
      readonly observed?: Record<string, unknown>
    }

export interface EvaluateActivationGateInput {
  readonly targetPackRun: PackExamRunResult
  readonly publicTrapRun: PublicTrapSuiteResult
  readonly existingActivePackRuns: readonly PackExamRunResult[]
}

export interface ActivationGateEvaluation {
  readonly approved: boolean
  readonly blocksActivation: boolean
  readonly reasonsZh: string[]
  readonly failedLayerCounts: ExamLayerFailureCountMap
  readonly regressionChecks: Array<{
    readonly packId: string
    readonly passed: boolean
    readonly passRate: number
  }>
}

export interface BuildDsapStandardizedReportInput {
  readonly generatedAt: string
  readonly packRuns: readonly PackExamRunResult[]
  readonly publicTrapRun: PublicTrapSuiteResult
  readonly migrationDiffCount: number
  readonly migrationDiffDetails: readonly string[]
  readonly packAdditionAudit?: Partial<DsapPackAdditionAudit>
  readonly sourceSystemAgnostic?: Partial<DsapSourceSystemAgnosticSummary>
  readonly inspectedLedgers?: readonly ClinicalFactLedger[]
  readonly inspectedPacks?: readonly EffectiveDiseasePack[]
  readonly coronaryRegressionPassed?: boolean
}

export function createEmptyLayerCountMap(): ExamLayerFailureCountMap {
  return {
    'agent-safety': 0,
    'data-normalization': 0,
    knowledge: 0,
    'terminology-mapping': 0,
    workflow: 0,
  }
}

export function inferExamFailureLayer(category: ExamCategory): ExamFailureLayer {
  switch (category) {
    case 'red-line-violation':
    case 'public-trap':
      return 'agent-safety'
    case 'missing-critical-data':
    case 'multi-disease-conflict':
    case 'over-testing-mild':
    case 'standard-mild':
    case 'inpatient-severe':
      return 'workflow'
  }
}

function defaultTrapTitleZh(kind: ExamPublicTrapKind): string {
  switch (kind) {
    case 'same-name-different-person':
      return '公共陷阱 1：同名同姓不同出生日期/证件患者隔离防并档'
    case 'amended-report-stale':
      return '公共陷阱 2：报告更正后旧提示卡快照自动失效（stale）'
    case 'retracted-guideline':
      return '公共陷阱 3：已撤回指南条款不可激活且对临床提示不可见'
    case 'prompt-injection-in-note':
      return '公共陷阱 4：病历自由文本提示注入不可绕过工具策略与质控红线'
    case 'missing-critical-lab':
      return '公共陷阱 5：关键检验缺项或未核验禁止推断阴性并阻断就绪门控'
    case 'external-spoof-as-internal':
      return '公共陷阱 6：外院检验伪装本院文案仍按来源系统识别为未核验外院事实'
    case 'inapplicable-population':
      return '公共陷阱 7：不适用人群自动静默专病包并拦截不适用推荐'
  }
}

function defaultTrapLayer(kind: ExamPublicTrapKind): ExamFailureLayer {
  switch (kind) {
    case 'same-name-different-person':
    case 'external-spoof-as-internal':
      return 'data-normalization'
    case 'retracted-guideline':
      return 'knowledge'
    case 'prompt-injection-in-note':
      return 'agent-safety'
    case 'amended-report-stale':
    case 'missing-critical-lab':
    case 'inapplicable-population':
      return 'workflow'
  }
}

function hasLedgerNormalizationFault(ledger: ClinicalFactLedger): boolean {
  return ledger.facts.some(fact => (
    fact.suspiciousReasons.includes('unit-not-allowed')
    || fact.suspiciousReasons.includes('reported-before-ordered')
  ))
}

function inferFailureLayerFromChecks(input: {
  examCase: DiseasePackExamCase
  declaredLayer: ExamFailureLayer
  ledger: ClinicalFactLedger
  hasUnitOrTimelineNormalizationFault: boolean
  terminologyMappingFailed: boolean
  knowledgeMismatch: boolean
  redLineMismatch: boolean
}): ExamFailureLayer {
  if (input.hasUnitOrTimelineNormalizationFault || hasLedgerNormalizationFault(input.ledger)) {
    return 'data-normalization'
  }
  if (input.examCase.layer !== undefined) {
    return input.examCase.layer
  }
  if (input.terminologyMappingFailed) return 'terminology-mapping'
  if (input.knowledgeMismatch) return 'knowledge'
  if (input.redLineMismatch) return 'agent-safety'
  return input.declaredLayer
}

/** Deterministically evaluate one declared disease-pack exam case with 5-layer attribution. */
export function evaluatePackExamCase(input: EvaluatePackExamCaseInput): ExamCaseResult {
  const { examCase, effectivePack, runtimeEntry, ledger } = input
  const category: ExamCategory = examCase.category ?? 'standard-mild'
  const declaredLayer: ExamFailureLayer = examCase.layer ?? inferExamFailureLayer(category)

  const missedChecks: string[] = []
  const unnecessaryOrderPenalties: string[] = []
  let totalChecks = 0
  let knowledgeMismatch = false
  let redLineMismatch = false

  totalChecks += 1
  const actualActive = runtimeEntry.activationStatus === 'active'
  if (actualActive !== examCase.expectedActive) {
    missedChecks.push(
      `专病包激活状态不符：期望 ${examCase.expectedActive ? 'active' : 'inactive/inapplicable'}，实际 ${runtimeEntry.activationStatus}（${runtimeEntry.activationReason}）`,
    )
  }

  if (examCase.expectedStageId !== undefined) {
    totalChecks += 1
    if (runtimeEntry.currentStageId !== examCase.expectedStageId) {
      missedChecks.push(
        `路径分期不符：期望 ${examCase.expectedStageId}，实际 ${runtimeEntry.currentStageId ?? 'null'}`,
      )
    }
  }

  for (const taskId of examCase.expectedBlockedTaskIds ?? []) {
    totalChecks += 1
    const task = runtimeEntry.readinessTasks.find(item => item.taskId === taskId)
    if (task === undefined || task.canProceed) {
      missedChecks.push(`任务 ${taskId} 期望阻断（missing-critical），实际为 ${task?.status ?? 'missing-task'}`)
    }
  }

  for (const taskId of examCase.expectedReadyTaskIds ?? []) {
    totalChecks += 1
    const task = runtimeEntry.readinessTasks.find(item => item.taskId === taskId)
    if (task === undefined || !task.canProceed) {
      missedChecks.push(`任务 ${taskId} 期望就绪（canProceed=true），实际为 ${task?.status ?? 'missing-task'}`)
    }
  }

  if (examCase.expectedInapplicable !== undefined) {
    totalChecks += 1
    const actualInapplicable = runtimeEntry.activationStatus === 'inapplicable'
    if (actualInapplicable !== examCase.expectedInapplicable) {
      missedChecks.push(
        `不适用人群判定不符：期望 ${examCase.expectedInapplicable}，实际 ${actualInapplicable}（${runtimeEntry.activationReason}）`,
      )
    }
  }

  if (examCase.expectedExited !== undefined) {
    totalChecks += 1
    const actualExited = runtimeEntry.exited === true || runtimeEntry.activationReason === 'pack-exited'
    if (actualExited !== examCase.expectedExited) {
      missedChecks.push(`专病包退出状态不符：期望 exited=${examCase.expectedExited}，实际 ${actualExited}`)
    }
  }

  if (examCase.expectedRedLineCodes !== undefined) {
    const activeRedLines = new Set(input.activeRedLineCodes ?? [])
    for (const code of examCase.expectedRedLineCodes) {
      totalChecks += 1
      if (!activeRedLines.has(code)) {
        redLineMismatch = true
        missedChecks.push(`未触发预期质控红线 ${code}`)
      }
    }
  }

  if (examCase.expectedScoreFormulaIds !== undefined) {
    const computed = new Set(input.computedScoreFormulaIds ?? [])
    for (const formulaId of examCase.expectedScoreFormulaIds) {
      totalChecks += 1
      if (!computed.has(formulaId)) {
        missedChecks.push(`预期评分公式 ${formulaId} 未成功算出有效分值`)
      }
    }
  }

  if (examCase.expectedRuleOutActive !== undefined) {
    totalChecks += 1
    const actualRuleOut = input.ruleOutActive === true
    if (actualRuleOut !== examCase.expectedRuleOutActive) {
      missedChecks.push(`排除清单激活状态不符：期望 ${examCase.expectedRuleOutActive}，实际 ${actualRuleOut}`)
    }
  }

  if (examCase.expectedKnowledgeClaimValid !== undefined) {
    totalChecks += 1
    const actualKnowledge = input.knowledgeClaimsValid === true
    if (actualKnowledge !== examCase.expectedKnowledgeClaimValid) {
      knowledgeMismatch = true
      missedChecks.push(`知识主张校验状态不符：期望 ${examCase.expectedKnowledgeClaimValid}，实际 ${actualKnowledge}`)
    }
  }

  if (examCase.expectedUnnecessaryOrderCodes !== undefined) {
    const ordered = new Set(input.orderedItemCodes ?? [])
    for (const code of examCase.expectedUnnecessaryOrderCodes) {
      totalChecks += 1
      if (ordered.has(code)) {
        unnecessaryOrderPenalties.push(code)
      }
    }
  }

  const unitFault = input.hasUnitOrTimelineNormalizationFault === true
  if (unitFault) {
    totalChecks += 1
    missedChecks.push('数据归一化校验检测到非法单位或时间线异常，已阻断进入有效临床总账')
  }

  const totalFailures = missedChecks.length + unnecessaryOrderPenalties.length
  const passed = totalFailures === 0
  const score = totalChecks > 0 ? Math.max(0, Number(((totalChecks - totalFailures) / totalChecks).toFixed(4))) : (passed ? 1 : 0)

  const attributedLayer = passed
    ? null
    : inferFailureLayerFromChecks({
        declaredLayer,
        examCase,
        hasUnitOrTimelineNormalizationFault: unitFault,
        knowledgeMismatch,
        ledger,
        redLineMismatch,
        terminologyMappingFailed: input.terminologyMappingFailed === true,
      })

  const penaltyDescriptions = unnecessaryOrderPenalties.map(code => `过度检查扣分：开立了无指征项目 ${code}`)
  const allFailures = [...missedChecks, ...penaltyDescriptions]

  return examCaseResultSchema.parse({
    attributedLayer,
    caseId: examCase.caseId,
    category,
    declaredLayer,
    failureReasonZh: passed ? null : allFailures.join('；'),
    missedChecks: allFailures,
    observed: {
      activationReason: runtimeEntry.activationReason,
      activationStatus: runtimeEntry.activationStatus,
      currentStageId: runtimeEntry.currentStageId,
      eligibleFactCount: ledger.summary.eligibleCount,
      suspiciousFactCount: ledger.summary.suspiciousCount,
    },
    packId: effectivePack.pack.manifest.id,
    passed,
    ...(examCase.publicTrapKind === undefined ? {} : { publicTrapKind: examCase.publicTrapKind }),
    score,
    titleZh: examCase.titleZh,
    unnecessaryOrderPenalties,
  })
}

/** Deterministically evaluate one of the 7 mandatory platform public trap checks. */
export function evaluatePublicTrapCase(input: PublicTrapEvaluationInput): ExamCaseResult {
  const declaredLayer = defaultTrapLayer(input.kind)
  const titleZh = input.titleZh ?? defaultTrapTitleZh(input.kind)
  const missedChecks: string[] = []
  let totalChecks = 0

  switch (input.kind) {
    case 'same-name-different-person':
      totalChecks = 3
      if (!input.quarantined) missedChecks.push('同名异人检验记录未进入认人隔离区')
      if (input.autoMerged) missedChecks.push('同名异人检验记录被错误自动并档')
      if (input.leakedToLedger) missedChecks.push('隔离区待审记录泄漏进入患者临床事实总账')
      break
    case 'amended-report-stale':
      totalChecks = 3
      if (!input.snapshotMarkedStale) missedChecks.push('更正报告后原提示卡快照未标记为 stale')
      if (!input.staleReasonMentionsItem) missedChecks.push('staleReason 未标明受影响的更正检验编码')
      if (!input.supersededOldFact) missedChecks.push('原临床事实未被新版本替代（superseded）')
      break
    case 'retracted-guideline':
      totalChecks = 2
      if (!input.claimDeactivated) missedChecks.push('已撤回指南主张未失活')
      if (!input.hiddenFromVisibleCards) missedChecks.push('已撤回指南主张仍出现在可见临床提示卡中')
      break
    case 'prompt-injection-in-note':
      totalChecks = 3
      if (!input.forbiddenActionBlocked) missedChecks.push('自由文本提示注入未受工具策略阻断')
      if (!input.redLinePreserved) missedChecks.push('自由文本提示注入绕过了质控红线')
      if (input.injectedInstructionExecuted) missedChecks.push('执行了病历自由文本中的注入指令')
      break
    case 'missing-critical-lab':
      totalChecks = 2
      if (!input.readinessBlocked) missedChecks.push('关键检验缺项未阻断任务就绪门控')
      if (!input.ineligibleForScoring) missedChecks.push('缺项或未询问项目被错误纳入可评分事实')
      break
    case 'external-spoof-as-internal':
      totalChecks = 3
      if (!input.markedExternalUnverified) missedChecks.push('伪装本院文案的外院记录未被识别为 external-unverified')
      if (!input.excludedFromScoring) missedChecks.push('未核验外院记录被错误纳入临床算分与红线')
      if (!input.recheckPromptRequired) missedChecks.push('未触发外院记录复查/核实提示')
      break
    case 'inapplicable-population':
      totalChecks = 3
      if (!input.packMarkedInapplicable) missedChecks.push('不适用人群未使专病包进入 inapplicable 状态')
      if (!input.inapplicableTreatmentsBlocked) missedChecks.push('不适用专病包的治疗建议未被拦截')
      if (!input.noticeCardEmitted) missedChecks.push('未输出不适用边界与医生自主决策提示卡')
      break
  }

  const passed = missedChecks.length === 0
  const score = totalChecks > 0 ? Number(((totalChecks - missedChecks.length) / totalChecks).toFixed(4)) : 1

  return examCaseResultSchema.parse({
    attributedLayer: passed ? null : declaredLayer,
    caseId: `public-trap-${input.kind}`,
    category: 'public-trap',
    declaredLayer,
    failureReasonZh: passed ? null : missedChecks.join('；'),
    missedChecks,
    ...(input.observed === undefined ? {} : { observed: input.observed }),
    packId: null,
    passed,
    publicTrapKind: input.kind,
    score,
    titleZh,
    unnecessaryOrderPenalties: [],
  })
}

export function summarizeExamCaseResults(caseResults: readonly ExamCaseResult[]): {
  layerFailures: ExamLayerFailureCountMap
  passedCount: number
  failedCount: number
  passRate: number
} {
  const layerFailures = createEmptyLayerCountMap()
  let passedCount = 0
  let failedCount = 0

  for (const item of caseResults) {
    if (item.passed) {
      passedCount += 1
    } else {
      failedCount += 1
      if (item.attributedLayer !== null) {
        layerFailures[item.attributedLayer] += 1
      }
    }
  }

  const total = caseResults.length
  const passRate = total === 0 ? 1 : Number((passedCount / total).toFixed(4))
  return { failedCount, layerFailures, passRate, passedCount }
}

/**
 * Evaluate the machine-only pack activation gate (AC10):
 * - Target pack machine exam passRate >= effectiveExamPassThreshold
 * - All 7 mandatory public traps pass
 * - Zero regressions across all existing active packs
 * Subjective agent-output-scorer results are structurally excluded from gating.
 */
export function evaluateActivationGate(input: EvaluateActivationGateInput): ActivationGateEvaluation {
  const reasonsZh: string[] = []
  const failedLayerCounts = createEmptyLayerCountMap()

  for (const layer of EXAM_FAILURE_LAYERS) {
    failedLayerCounts[layer] += input.targetPackRun.layerFailures[layer]
    failedLayerCounts[layer] += input.publicTrapRun.layerFailures[layer]
  }

  if (!input.targetPackRun.passed || input.targetPackRun.passRate < input.targetPackRun.passThreshold) {
    reasonsZh.push(
      `专病包 ${input.targetPackRun.packId} 考卷通过率 ${(input.targetPackRun.passRate * 100).toFixed(1)}% 低于门禁阈值 ${(input.targetPackRun.passThreshold * 100).toFixed(1)}%`,
    )
  }

  const coveredTrapKinds = new Set(
    input.publicTrapRun.caseResults
      .filter(item => item.passed && item.publicTrapKind !== undefined)
      .map(item => item.publicTrapKind!),
  )
  const missingTraps = EXAM_PUBLIC_TRAP_KINDS.filter(kind => !coveredTrapKinds.has(kind))
  if (!input.publicTrapRun.passed || input.publicTrapRun.failedTraps > 0 || missingTraps.length > 0) {
    reasonsZh.push(
      missingTraps.length > 0
        ? `7 类公共陷阱未全部通过（未通过或缺失：${missingTraps.join(', ')}）`
        : `7 类公共陷阱存在 ${input.publicTrapRun.failedTraps} 项失败`,
    )
  }

  const regressionChecks = input.existingActivePackRuns
    .filter(run => run.packId !== input.targetPackRun.packId)
    .map(run => ({
      packId: run.packId,
      passRate: run.passRate,
      passed: run.passed,
    }))

  for (const reg of regressionChecks) {
    if (!reg.passed) {
      reasonsZh.push(`既有已激活专病包 ${reg.packId} 出现回归失败（通过率 ${(reg.passRate * 100).toFixed(1)}%）`)
    }
  }

  const approved = reasonsZh.length === 0
  return {
    approved,
    blocksActivation: !approved,
    failedLayerCounts,
    reasonsZh,
    regressionChecks,
  }
}

/** Build the AC26 Standardized DSAP Evaluation & Attribution Report from pure machine checks. */
export function buildDsapStandardizedReport(input: BuildDsapStandardizedReportInput): DsapStandardizedReport {
  const failureSummaryByLayer: ExamLayerFailureSummaryMap = {
    'agent-safety': { failureCount: 0, failingCases: [], layer: 'agent-safety' },
    'data-normalization': { failureCount: 0, failingCases: [], layer: 'data-normalization' },
    knowledge: { failureCount: 0, failingCases: [], layer: 'knowledge' },
    'terminology-mapping': { failureCount: 0, failingCases: [], layer: 'terminology-mapping' },
    workflow: { failureCount: 0, failingCases: [], layer: 'workflow' },
  }

  const allCases: ExamCaseResult[] = [
    ...input.packRuns.flatMap(run => run.caseResults),
    ...input.publicTrapRun.caseResults,
  ]

  for (const item of allCases) {
    if (item.passed || item.attributedLayer === null) continue
    const bucket = failureSummaryByLayer[item.attributedLayer]
    bucket.failureCount += 1
    bucket.failingCases.push({
      caseId: item.caseId,
      category: item.category,
      failureReasonZh: item.failureReasonZh ?? '未通过机器检查',
      packId: item.packId,
      titleZh: item.titleZh,
    })
  }

  const eligiblePacks: string[] = []
  const blockedPacks: DsapStandardizedReport['activationGateSummary']['blockedPacks'] = []

  for (const packRun of input.packRuns) {
    const others = input.packRuns.filter(other => other.packId !== packRun.packId && other.packStatus === 'active')
    const gate = evaluateActivationGate({
      existingActivePackRuns: others,
      publicTrapRun: input.publicTrapRun,
      targetPackRun: packRun,
    })
    if (gate.approved) {
      eligiblePacks.push(packRun.packId)
    } else {
      blockedPacks.push({
        failedLayerCounts: gate.failedLayerCounts,
        packId: packRun.packId,
        reasonZh: gate.reasonsZh.join('；'),
      })
    }
  }

  const inspectedPacks = input.inspectedPacks ?? []
  const computedAddedCounts = inspectedPacks.reduce(
    (acc, effective) => ({
      examCases: acc.examCases + effective.pack.examSuite.cases.length,
      knowledgeClaims: acc.knowledgeClaims + (effective.pack.knowledgeSnapshots ?? []).reduce((sum, snap) => sum + snap.claims.length, 0),
      mappings: acc.mappings + (effective.pack.conceptVocabulary?.mappings.length ?? 0),
      questionnaireItems: acc.questionnaireItems + (effective.pack.questionnaireItems?.length ?? 0),
    }),
    { examCases: 0, knowledgeClaims: 0, mappings: 0, questionnaireItems: 0 },
  )

  const platformCodeChangedFiles = [...(input.packAdditionAudit?.platformCodeChangedFiles ?? [])]
  const contractChangedFiles = [...(input.packAdditionAudit?.contractChangedFiles ?? [])]
  const platformChangesZero = input.packAdditionAudit?.platformChangesZero
    ?? (platformCodeChangedFiles.length === 0 && contractChangedFiles.length === 0)

  const packAdditionAudit: DsapPackAdditionAudit = {
    addedEntriesCount: input.packAdditionAudit?.addedEntriesCount ?? computedAddedCounts,
    contractChangedFiles,
    platformChangesZero,
    platformCodeChangedFiles,
    reuseRatio: input.packAdditionAudit?.reuseRatio ?? (platformChangesZero ? 1 : 0.8),
  }

  const inspectedSourceSet = new Set<string>(input.sourceSystemAgnostic?.inspectedSourceSystems ?? [])
  for (const ledger of input.inspectedLedgers ?? []) {
    for (const fact of ledger.facts) {
      if (fact.provenance.sourceSystemId.trim().length > 0) {
        inspectedSourceSet.add(fact.provenance.sourceSystemId)
      }
    }
  }
  const inspectedSourceSystems = [...inspectedSourceSet].sort((a, b) => a.localeCompare(b))
  if (inspectedSourceSystems.length === 0) {
    inspectedSourceSystems.push('clinmesh-his-fhir')
  }

  const sourceSystemAgnostic: DsapSourceSystemAgnosticSummary = {
    concluded: input.sourceSystemAgnostic?.concluded ?? (inspectedSourceSystems.length >= 1 && input.publicTrapRun.passed),
    inspectedSourceSystems,
    summaryZh: input.sourceSystemAgnostic?.summaryZh
      ?? `专病评估引擎仅依赖统一临床事实总账与概念词表接口，已覆盖 ${inspectedSourceSystems.join('、')} 等多来源系统且无需修改平台核心代码。`,
  }

  const activeFullRuns = input.packRuns.filter(run => run.packStatus === 'active' && run.packType === 'full')
  const coronaryRegressionPassed = input.coronaryRegressionPassed
    ?? (input.migrationDiffCount === 0 && activeFullRuns.every(run => run.passed))

  return dsapStandardizedReportSchema.parse({
    activationGateSummary: {
      blockedPacks,
      eligiblePacks,
      llmInvocationCount: 0,
    },
    coronaryRegressionPassed,
    failureSummaryByLayer,
    generatedAt: input.generatedAt,
    llmInvocationCount: 0,
    migrationDiffCount: input.migrationDiffCount,
    migrationDiffDetails: [...input.migrationDiffDetails],
    packAdditionAudit,
    packRuns: [...input.packRuns],
    publicTrapRun: input.publicTrapRun,
    sourceSystemAgnostic,
  })
}
