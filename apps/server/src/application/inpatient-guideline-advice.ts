import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import {
  clinicalRiskAssessmentRecordSchema,
  clinicalScoreResultSchema,
  inpatientVitalSignsRecordSchema,
} from '@clinmesh/contracts/clinical-scores'
import { guidelineTopicIdSchema, type GuidelineTopicBundle, type GuidelineTopicId } from '@clinmesh/contracts/guideline-topics'
import { inpatientAngiographyReportSchema } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientDiagnosisSchema, inpatientOrderSchema } from '@clinmesh/contracts/inpatient-clinical'
import {
  inpatientGuidelineAdviceConclusionSchema,
  inpatientGuidelineAdviceEvidenceSchema,
  inpatientGuidelineAdviceRequestInputSchema,
  inpatientGuidelineAdviceResultSchema,
  inpatientGuidelineAdviceSchema,
  type InpatientGuidelineAdvice as Advice,
} from '@clinmesh/contracts/inpatient-guideline-advice'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { pciMeasurementSchema, pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'
import type { GuidelineCorpus } from '../infrastructure/sqlite/guideline-corpus.ts'
import { WorkspaceContextError } from '../infrastructure/sqlite/workspace-repository.ts'
import type { ActorContext, CommandTransaction } from './command-executor.ts'
import type { GenerationModelBinding } from './generation-model-binding.ts'
import {
  buildSynchronousTopicBundle,
  clampTopicMissingList,
  collectPciSelectionMissingItems,
  evaluateTopicPatientIndicators,
  extractSupplementaryIndicators,
  getGuidelineTopicDefinition,
  readGuidelineTopicSource,
} from './guideline-topic-registry.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { modelTaskOutcomeUnknown, type ModelTaskRecovery } from './model-task-recovery.ts'
import { ModelUsageControlError, modelUsageControlFailure } from './model-usage-control.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'
import { resolvePatientGuidelinePopulation } from './patient-age.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const contextSchema = z.object({
  workspaceId: z.string(),
  epoch: z.string(),
  scenarioRunId: z.string(),
  actorId: z.string(),
  practitionerId: z.string(),
  practitionerRoleId: z.string(),
  roleCode: z.literal('inpatient-doctor'),
  organizationId: z.string(),
  locationId: z.string(),
  agentGrantId: z.string().optional(),
}).strict().transform(({ agentGrantId, ...context }) => ({
  ...context,
  ...(agentGrantId === undefined ? {} : { agentGrantId }),
}))

const rowSchema = z.object({
  workspace_id: z.string(),
  epoch: z.string(),
  task_id: z.string(),
  admission_id: z.string(),
  topic_id: guidelineTopicIdSchema,
  request_id: z.string().nullable(),
  version: z.number().int().positive(),
  context_json: z.string(),
  basis_json: z.string(),
  basis_fingerprint: z.string(),
  trigger: z.enum(['automatic', 'manual']),
  cancelled: z.union([z.literal(0), z.literal(1)]),
  frozen_readable: z.union([z.literal(0), z.literal(1)]),
  status: z.enum(['queued', 'running', 'succeeded', 'no-evidence', 'blocked', 'unknown', 'rejected', 'failed', 'stale']),
  error_code: z.string().nullable(),
  result_json: z.string().nullable(),
  created_at: z.string(),
})
type Row = z.infer<typeof rowSchema>

const authorizationOperations = {
  automatic: 'inpatient.surgery.request',
  manual: 'inpatient.guideline-advice.request',
} as const

const pciRequestFactsSchema = z.object({
  request: inpatientSurgeryRequestSchema.pick({ id: true, plannedProcedure: true, plannedFor: true }),
  diagnosis: inpatientDiagnosisSchema,
  investigations: inpatientInvestigationsSchema,
  measurements: z.array(pciMeasurementSchema).max(3),
  targetSite: z.string().nullable(),
}).strict()

const supplementaryIndicatorsSchema = z.object({
  acsEligibility: z.object({
    sourceReference: z.string(),
    valueText: z.string(),
    versionId: z.string(),
  }).strict().nullable().optional(),
  angiographySummary: z.object({
    missingFfrMessages: z.array(z.string()),
    sourceReference: z.string(),
    summaryText: z.string(),
    versionId: z.string(),
  }).strict().nullable(),
  ecgSummary: z.object({
    conclusion: z.string(),
    sourceReference: z.string(),
    versionId: z.string(),
  }).strict().nullable(),
  hba1c: z.object({
    sourceReference: z.string(),
    valueText: z.string(),
    versionId: z.string(),
  }).strict().nullable(),
  pciPlanSummary: z.object({
    hasValidCandidate: z.boolean(),
    measurements: z.array(pciMeasurementSchema),
    missingItems: z.array(z.string()),
    selectionVersion: z.number().int().nonnegative(),
    sourceReference: z.string(),
    targetSite: z.string().nullable(),
    versionId: z.string(),
  }).strict().nullable(),
  cadEligibility: z.object({
    sourceReference: z.string(),
    valueText: z.string(),
    versionId: z.string(),
  }).strict().nullable().optional(),
  contrastProcedureEligibility: z.object({
    sourceReference: z.string(),
    valueText: z.string(),
    versionId: z.string(),
  }).strict().nullable().optional(),
  t2dmDiagnosis: z.object({
    sourceReference: z.string(),
    valueText: z.string(),
    versionId: z.string(),
  }).strict().nullable().optional(),
  troponinSeries: z.object({
    anyElevated: z.boolean(),
    count: z.number().int().positive(),
    latestReference: z.string(),
    missingMessage: z.string().nullable(),
    observations: z.array(z.object({
      elevated: z.boolean(),
      itemText: z.string(),
      reference: z.string(),
      timestampMs: z.number().finite().nullable(),
      versionId: z.string(),
    }).strict()),
    serialComplete: z.boolean(),
    summaryText: z.string(),
    versionId: z.string(),
  }).strict().nullable().optional(),
  tteLvef: z.object({
    lvefPct: z.number().finite(),
    sourceReference: z.string(),
    versionId: z.string(),
  }).strict().nullable(),
}).strict()

const admissionTopicFactsSchema = z.object({
  request: z.null(),
  diagnosis: inpatientDiagnosisSchema,
  investigations: inpatientInvestigationsSchema,
  angiographyReports: z.array(inpatientAngiographyReportSchema),
  scores: z.array(clinicalScoreResultSchema),
  riskAssessment: clinicalRiskAssessmentRecordSchema,
  supplementaryIndicators: supplementaryIndicatorsSchema,
  activeMedicationOrders: z.array(inpatientOrderSchema.pick({
    id: true,
    catalogItemId: true,
    display: true,
    doseText: true,
    frequencyCode: true,
    duration: true,
    state: true,
  })),
  latestVitalSigns: inpatientVitalSignsRecordSchema.nullable(),
}).strict()

const basisSchema = z.object({
  topic: z.object({
    id: guidelineTopicIdSchema,
    version: z.string(),
    navigation: z.string(),
    limitations: z.array(z.string()),
  }).strict(),
  guidelines: z.array(inpatientGuidelineAdviceEvidenceSchema).max(7),
  missing: z.array(z.string()),
  sourceStatus: z.enum(['available', 'unavailable', 'read-failed']),
  dependencyFingerprint: z.string(),
  clinicalFacts: z.union([pciRequestFactsSchema, admissionTopicFactsSchema]),
}).strict()
type BasisInput = z.infer<typeof basisSchema>

const messages: Record<Advice['status'], string> = {
  idle: '尚未准备本专题的指南参考意见。',
  queued: '正在准备指南参考意见。',
  running: '正在根据原文起草并独立核验指南参考意见。',
  succeeded: '指南参考意见已准备，请结合原文和本次患者资料审阅。',
  incomplete: '指南参考意见已准备；患者资料仍有缺项，仅供有条件核对。',
  'no-evidence': '本专题暂无可用指南原文，不能提供指南参考意见。',
  blocked: '模型暂不可用或用量控制未就绪，指南参考意见尚未生成。',
  unknown: '原模型请求结果未知，请先核查原尝试；不会自动重新发送。',
  rejected: '指南参考意见未通过独立核验，内容不予展示。',
  failed: '指南参考意见准备失败，可核查后显式重新评估。',
  cancelled: '手术计划已取消，指南参考意见停止准备。',
  stale: '患者资料、计划、目录或指南依据已变化，请显式重新评估。',
  frozen: '治疗阶段已结束或病案已归档，指南参考意见保留历史只读。',
}

function topicGenerationSchema(topicId: GuidelineTopicId) {
  const kinds = getGuidelineTopicDefinition(topicId).conclusionKinds
  const kindEnum = z.enum(kinds)
  return z.object({
    conclusions: z.array(inpatientGuidelineAdviceConclusionSchema.extend({ kind: kindEnum })).length(3)
      .refine(items => new Set(items.map(item => item.kind)).size === items.length, '指南类别结论不得重复'),
  }).strict()
}

function topicVerificationSchema(topicId: GuidelineTopicId) {
  const kinds = getGuidelineTopicDefinition(topicId).conclusionKinds
  const kindEnum = z.enum(kinds)
  return z.object({
    conclusions: z.array(z.object({
      kind: kindEnum,
      supported: z.boolean(),
      populationPreserved: z.boolean(),
      conditionsPreserved: z.boolean(),
      strengthPreserved: z.boolean(),
      noInventedMeasurements: z.boolean(),
      noProductOrQuantity: z.boolean(),
      reason: z.string().trim().min(1).max(4000),
    }).strict()).length(3)
      .refine(items => new Set(items.map(item => item.kind)).size === items.length, '指南核验类别不得重复'),
  }).strict()
}

/** Read-only clinical advice shares the model execution and accounting boundary, never the material confirmation. */
export class InpatientGuidelineAdvice {
  constructor(
    readonly owner: InpatientService,
    readonly options: {
      guidelines?: GuidelineCorpus
      contextStatus: (context: ActorContext, operations: readonly string[]) => 'active' | 'inactive' | 'superseded'
    },
  ) {}

  #row(
    context: Pick<ActorContext, 'workspaceId' | 'epoch'>,
    admissionId: string,
    topicId: GuidelineTopicId,
    requestId: string | null,
  ) {
    if (requestId === null) {
      return rowSchema.optional().parse(
        this.owner.database.driver.prepare(`
          SELECT * FROM inpatient_guideline_advice
          WHERE workspace_id=? AND epoch=? AND admission_id=? AND topic_id=? AND request_id IS NULL
          ORDER BY version DESC LIMIT 1
        `).get(context.workspaceId, context.epoch, admissionId, topicId),
      )
    }
    return rowSchema.optional().parse(
      this.owner.database.driver.prepare(`
        SELECT * FROM inpatient_guideline_advice
        WHERE workspace_id=? AND epoch=? AND admission_id=? AND topic_id=? AND request_id=?
        ORDER BY version DESC LIMIT 1
      `).get(context.workspaceId, context.epoch, admissionId, topicId, requestId),
    )
  }

  #authorize(context: ActorContext, admissionId: string, trigger: Row['trigger']) {
    this.owner.assertRole(context, ['inpatient-doctor'])
    this.owner.assertNotArchived(context, admissionId)
    this.owner.orders.assertAdmitted(context, admissionId)
    if (this.options.contextStatus(context, [authorizationOperations[trigger]]) !== 'active') {
      throw new InpatientError('INPATIENT_GUIDELINE_FORBIDDEN', '原准备岗位授权已失效，请由当前主管医生重新评估', 403)
    }
  }

  #population(context: ActorContext, admissionId: string) {
    const binding = this.owner.readAdmissionBinding(context, admissionId)
    const patient = z.object({ birthDate: z.string().optional() }).parse(this.owner.fhir.read(context, 'Patient', binding.patientId))
    const departedAt = this.owner.discharge.activeDeparture(context, admissionId)?.virtualTime
    const population = resolvePatientGuidelinePopulation(
      patient.birthDate,
      departedAt ?? this.owner.virtualTime(context),
    )
    return { binding, patientBirthDate: patient.birthDate, population, referenceIso: departedAt ?? this.owner.virtualTime(context) }
  }

  #basis(
    context: ActorContext,
    admissionId: string,
    topicId: GuidelineTopicId,
    requestId: string | null,
  ) {
    const { binding, population, referenceIso } = this.#population(context, admissionId)
    const definition = getGuidelineTopicDefinition(topicId)
    const sourceRead = readGuidelineTopicSource(topicId, this.options.guidelines, { population })

    if (requestId !== null) {
      if (topicId !== 'pci-stent') {
        throw new InpatientError('INPATIENT_GUIDELINE_INVALID', '手术申请单绑定仅用于 pci-stent 支架选型专题', 400)
      }
      const surgery = this.owner.surgery.read(context, admissionId)
      const request = surgery.requests.find(item => item.id === requestId)
      if (!request || !pciSelectionProcedureCodes.includes(request.plannedProcedure.coding.code)) {
        throw new InpatientError('INPATIENT_GUIDELINE_PLAN_REQUIRED', '未找到本次住院有效的PCI计划', 404)
      }
      const selection = this.owner.pciSelection.read(context, admissionId, requestId)
      const parameters = selection.drafts?.find(item => item.requestId === requestId)?.parameters
        ?? (selection.confirmation?.parameters.requestId === requestId ? selection.confirmation.parameters : undefined)
      const measurements = parameters?.measurements ?? []
      const missing = collectPciSelectionMissingItems({
        hasValidCandidate: selection.candidates.some(item => item.eligibility === 'valid'),
        measurements,
        targetSite: parameters?.targetSite,
      })
      const input: BasisInput = {
        topic: sourceRead.topic,
        guidelines: sourceRead.guidelines,
        missing: clampTopicMissingList([...new Set([...missing, ...sourceRead.missing])]),
        sourceStatus: sourceRead.sourceStatus,
        dependencyFingerprint: canonicalJsonHash({
          candidates: selection.candidates,
          parameters,
          population,
          topic: definition.fingerprint,
        }),
        clinicalFacts: {
          request: { id: request.id, plannedProcedure: request.plannedProcedure, plannedFor: request.plannedFor },
          diagnosis: this.owner.orders.diagnosis(context, admissionId),
          investigations: this.owner.investigations.readSnapshot(context, admissionId),
          measurements,
          targetSite: parameters?.targetSite ?? null,
        },
      }
      return {
        binding,
        fingerprint: canonicalJsonHash(input),
        frozen: surgery.inProgress.some(item => item.requestId === requestId)
          || surgery.executions.some(item => item.requestId === requestId),
        input,
        requestStatus: request.status,
      }
    }

    const diagnosis = this.owner.orders.diagnosis(context, admissionId)
    const orders = this.owner.orders.facts(context, admissionId).orders
    const latestVitalSigns = this.owner.workflow.clinicalScores.latestInpatientVitalSigns(context, admissionId) ?? null
    const scores = this.owner.workflow.clinicalScores.inpatientSnapshot(this.owner, context, admissionId, referenceIso)
    const supplementary = extractSupplementaryIndicators({
      caseId: admissionId,
      context,
      database: this.owner.database,
      encounterId: admissionId,
      fhir: this.owner.fhir,
      inpatient: { actor: context, service: this.owner },
      patientId: binding.patientId,
    })
    const { missingPatientInputs } = evaluateTopicPatientIndicators(topicId, scores, supplementary)
    const supplementaryIndicators = {
      acsEligibility: supplementary.acsEligibility ?? null,
      angiographySummary: supplementary.angiographySummary ?? null,
      cadEligibility: supplementary.cadEligibility ?? null,
      contrastProcedureEligibility: supplementary.contrastProcedureEligibility ?? null,
      ecgSummary: supplementary.ecgSummary ?? null,
      hba1c: supplementary.hba1c ?? null,
      pciPlanSummary: supplementary.pciPlanSummary ?? null,
      t2dmDiagnosis: supplementary.t2dmDiagnosis ?? null,
      troponinSeries: supplementary.troponinSeries ?? null,
      tteLvef: supplementary.tteLvef ?? null,
    }
    const angiographyReports = this.owner.angiography.reports(context, admissionId)
      .filter(report => report.status === 'final' || report.status === 'partial')
    const activeMedicationOrders = orders
      .filter(
        order =>
          order.kind === 'medication'
          && (order.state === 'signed' || order.state === 'verified' || order.state === 'stop-requested'),
      )
      .map(order => ({
        catalogItemId: order.catalogItemId,
        display: order.display,
        doseText: order.doseText,
        duration: order.duration,
        frequencyCode: order.frequencyCode,
        id: order.id,
        state: order.state,
      }))

    const input: BasisInput = {
      topic: sourceRead.topic,
      guidelines: sourceRead.guidelines,
      missing: clampTopicMissingList([...new Set([...missingPatientInputs, ...sourceRead.missing])]),
      sourceStatus: sourceRead.sourceStatus,
      dependencyFingerprint: canonicalJsonHash({
        activeMedicationOrders,
        angiographyReports: angiographyReports.map(r => ({ id: r.id, version: r.version })),
        diagnosisRevision: diagnosis.revision,
        population,
        scores: scores.scores,
        supplementaryIndicators,
        topic: definition.fingerprint,
      }),
      clinicalFacts: {
        request: null,
        diagnosis,
        investigations: this.owner.investigations.readSnapshot(context, admissionId),
        angiographyReports,
        scores: scores.scores,
        riskAssessment: scores.riskAssessment,
        supplementaryIndicators,
        activeMedicationOrders,
        latestVitalSigns,
      },
    }
    return {
      binding,
      fingerprint: canonicalJsonHash(input),
      frozen: binding.status !== 'admitted',
      input,
      requestStatus: null as 'requested' | 'cancelled' | null,
    }
  }

  #state(
    context: ActorContext,
    admissionId: string,
    topicId: GuidelineTopicId,
    requestId: string | null,
  ): Advice {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    const basis = this.#basis(context, admissionId, topicId, requestId)
    const row = this.#row(context, admissionId, topicId, requestId)
    let authorized = true
    if (row) {
      try {
        const original = contextSchema.parse(JSON.parse(row.context_json))
        this.owner.assertReadRole(original, ['inpatient-doctor'])
        this.owner.readAdmissionBinding(original, admissionId)
        authorized = this.options.contextStatus(original, [authorizationOperations[row.trigger]]) === 'active'
      } catch (error) {
        if (error instanceof InpatientError || error instanceof WorkspaceContextError) authorized = false
        else throw error
      }
    }
    const isLifecycleFrozen = basis.frozen || basis.binding.row.record_status === 'archived'
    const persistedBasis = row ? basisSchema.safeParse(JSON.parse(row.basis_json)) : undefined
    const frozenEvidenceIntact =
      persistedBasis?.success === true
      && canonicalJsonHash(persistedBasis.data.guidelines) === canonicalJsonHash(basis.input.guidelines)
      && canonicalJsonHash(persistedBasis.data.topic) === canonicalJsonHash(basis.input.topic)
    const unchanged = row?.basis_fingerprint === basis.fingerprint
    const readableSnapshot = unchanged || (isLifecycleFrozen && row?.frozen_readable === 1 && frozenEvidenceIntact)
    let status: Advice['status'] = row?.status ?? 'idle'
    if (row && (!unchanged || !authorized)) status = 'stale'
    if (isLifecycleFrozen) status = 'frozen'
    if (row?.cancelled === 1) status = row.status === 'succeeded' ? 'frozen' : 'cancelled'
    if (basis.input.sourceStatus !== 'available' || (isLifecycleFrozen && row?.status === 'succeeded' && !frozenEvidenceIntact)) {
      status = 'no-evidence'
    }
    if (basis.requestStatus === 'cancelled') status = 'cancelled'
    if (row?.status === 'unknown') status = 'unknown'
    const result =
      authorized
      && readableSnapshot
      && basis.input.sourceStatus === 'available'
      && row?.status === 'succeeded'
      && row.result_json
      && status !== 'cancelled'
      && status !== 'no-evidence'
        ? inpatientGuidelineAdviceResultSchema.parse(JSON.parse(row.result_json))
        : null
    if (status === 'succeeded' && basis.input.missing.length > 0) status = 'incomplete'
    const effectiveMissing =
      status === 'frozen' && result !== null && persistedBasis?.success === true
        ? clampTopicMissingList(persistedBasis.data.missing)
        : basis.input.missing
    const effectiveFingerprint =
      isLifecycleFrozen && result !== null && row !== undefined
        ? row.basis_fingerprint
        : basis.fingerprint

    const idleMessage = requestId !== null ? '尚未准备本计划的指南参考意见。' : messages.idle
    const frozenMessage = requestId !== null ? '手术已开始、完成或病案已归档，指南参考意见保留历史只读。' : messages.frozen
    return {
      admissionId,
      topicId,
      requestId,
      taskId: row?.task_id ?? null,
      version: row?.version ?? 0,
      fingerprint: effectiveFingerprint,
      status,
      message: row?.cancelled === 1 && status !== 'unknown'
        ? row.status === 'succeeded'
          ? '本次单次准备已取消，已发布的指南意见保留历史只读；可显式重新评估。'
          : '本次单次准备已取消，指南意见停止准备；可显式重新评估。'
        : basis.input.sourceStatus === 'read-failed'
          ? '指南原文读取失败，请核查指南库后显式重新评估。'
          : status === 'idle'
            ? idleMessage
            : status === 'frozen'
              ? frozenMessage
              : messages[status],
      missing: effectiveMissing,
      failureCode: row?.error_code ?? null,
      result,
    }
  }

  read(context: ActorContext, admissionId: string, requestId: string) {
    try {
      const state = this.#state(context, admissionId, 'pci-stent', requestId)
      this.owner.commands.auditRead(context, 'inpatient.guideline-advice.read', { admissionId, requestId }, 'success')
      return state
    } catch (error) {
      try { this.owner.commands.auditRead(context, 'inpatient.guideline-advice.read', { admissionId, requestId }, 'failed') } catch { /* Preserve the original error. */ }
      throw error
    }
  }

  list(context: ActorContext, admissionId: string, topicId?: GuidelineTopicId) {
    try {
      this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
      const pciRequests = this.owner.surgery.read(context, admissionId).requests
        .filter(item => pciSelectionProcedureCodes.includes(item.plannedProcedure.coding.code))

      let advice: Advice[]
      if (topicId !== undefined) {
        advice = [
          this.#state(context, admissionId, topicId, null),
          ...(topicId === 'pci-stent' ? pciRequests.map(item => this.#state(context, admissionId, 'pci-stent', item.id)) : []),
        ]
      } else {
        const persistedTopics = z.array(z.object({ topic_id: guidelineTopicIdSchema })).parse(
          this.owner.database.driver.prepare(`
            SELECT DISTINCT topic_id FROM inpatient_guideline_advice
            WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id IS NULL
            ORDER BY topic_id
          `).all(context.workspaceId, context.epoch, admissionId),
        )
        advice = [
          ...pciRequests.map(item => this.#state(context, admissionId, 'pci-stent', item.id)),
          ...persistedTopics.map(row => this.#state(context, admissionId, row.topic_id, null)),
        ]
      }
      const result = { admissionId, advice }
      this.owner.commands.auditRead(
        context,
        'inpatient.guideline-advice.list',
        topicId === undefined ? { admissionId } : { admissionId, topicId },
        'success',
      )
      return result
    } catch (error) {
      try {
        this.owner.commands.auditRead(
          context,
          'inpatient.guideline-advice.list',
          topicId === undefined ? { admissionId } : { admissionId, topicId },
          'failed',
        )
      } catch { /* Preserve the original error. */ }
      throw error
    }
  }

  readTopics(context: ActorContext, admissionId: string, topicId?: GuidelineTopicId): GuidelineTopicBundle {
    try {
      this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
      const { binding, patientBirthDate, referenceIso } = this.#population(context, admissionId)
      const scores = this.owner.workflow.clinicalScores.inpatientSnapshot(this.owner, context, admissionId, referenceIso)
      const bundle = buildSynchronousTopicBundle({
        caseId: admissionId,
        context,
        corpus: this.options.guidelines,
        database: this.owner.database,
        encounterId: admissionId,
        evaluatedAt: this.owner.virtualTime(context),
        fhir: this.owner.fhir,
        inpatient: { actor: context, service: this.owner },
        patientBirthDate,
        patientId: binding.patientId,
        populationReferenceIso: referenceIso,
        scores,
        topicId,
      })
      this.owner.commands.auditRead(
        context,
        'inpatient.guideline-topics.read',
        topicId === undefined ? { admissionId } : { admissionId, topicId },
        'success',
      )
      return bundle
    } catch (error) {
      try {
        this.owner.commands.auditRead(
          context,
          'inpatient.guideline-topics.read',
          topicId === undefined ? { admissionId } : { admissionId, topicId },
          'failed',
        )
      } catch { /* Preserve the original error. */ }
      throw error
    }
  }

  #create(
    context: ActorContext,
    admissionId: string,
    topicId: GuidelineTopicId,
    requestId: string | null,
    version: number,
    trigger: Row['trigger'],
    transaction: CommandTransaction,
  ) {
    const basis = this.#basis(context, admissionId, topicId, requestId)
    const previous = this.#row(context, admissionId, topicId, requestId)
    const taskId = previous?.task_id ?? uuidv7()
    const available = basis.input.sourceStatus === 'available'
    this.owner.database.driver.prepare(`
      INSERT INTO inpatient_guideline_advice (
        workspace_id, epoch, task_id, admission_id, topic_id, request_id, version,
        context_json, basis_json, basis_fingerprint, trigger, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      taskId,
      admissionId,
      topicId,
      requestId,
      version,
      JSON.stringify(contextSchema.parse(context)),
      JSON.stringify(basis.input),
      basis.fingerprint,
      trigger,
      available ? 'queued' : 'no-evidence',
      this.owner.virtualTime(context),
    )
    if (available) {
      transaction.enqueue({
        kind: 'inpatient.guideline-advice.prepare',
        dedupKey: `${taskId}:${version}:${basis.fingerprint}`,
        payload: { taskId, version },
      })
    }
    return this.#state(context, admissionId, topicId, requestId)
  }

  automatic(context: ActorContext, admissionId: string, requestId: string, transaction: CommandTransaction) {
    const request = this.owner.surgery.read(context, admissionId).requests.find(item => item.id === requestId)
    if (!request || !pciSelectionProcedureCodes.includes(request.plannedProcedure.coding.code) || this.#row(context, admissionId, 'pci-stent', requestId)) {
      return
    }
    this.#create(context, admissionId, 'pci-stent', requestId, 1, 'automatic', transaction)
  }

  /** Captures which admission-level advice rows were current right before transitioning from admitted to discharge-pending. */
  captureDischargeFreeze(context: ActorContext, admissionId: string) {
    const topics = z.array(z.object({ topic_id: guidelineTopicIdSchema })).parse(
      this.owner.database.driver.prepare(`
        SELECT DISTINCT topic_id FROM inpatient_guideline_advice
        WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id IS NULL
      `).all(context.workspaceId, context.epoch, admissionId),
    )
    for (const { topic_id: topicId } of topics) {
      const row = this.#row(context, admissionId, topicId, null)
      if (!row) continue
      const liveState = this.#state(context, admissionId, topicId, null)
      const readable = liveState.status === 'succeeded' || liveState.status === 'incomplete' ? 1 : 0
      this.owner.database.driver.prepare(`
        UPDATE inpatient_guideline_advice SET frozen_readable=?
        WHERE workspace_id=? AND epoch=? AND task_id=? AND version=?
      `).run(readable, context.workspaceId, context.epoch, row.task_id, row.version)
    }
  }

  clearDischargeFreeze(context: ActorContext, admissionId: string) {
    this.owner.database.driver.prepare(`
      UPDATE inpatient_guideline_advice SET frozen_readable=0
      WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id IS NULL
    `).run(context.workspaceId, context.epoch, admissionId)
  }

  /** The caller owns the already-authorized material-estimate cancellation transaction. */
  cancel(context: ActorContext, admissionId: string, requestId: string) {
    this.owner.database.driver.prepare(`
      UPDATE inpatient_guideline_advice SET cancelled=1
      WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?
    `).run(context.workspaceId, context.epoch, admissionId, requestId)
  }

  request(context: ActorContext, raw: unknown, key: string) {
    const input = inpatientGuidelineAdviceRequestInputSchema.parse(raw)
    const requestId = input.requestId ?? null
    const topicId: GuidelineTopicId | undefined = input.topicId ?? (requestId !== null ? 'pci-stent' : undefined)
    if (topicId === undefined) {
      throw new InpatientError('INPATIENT_GUIDELINE_TOPIC_REQUIRED', '无手术申请单时必须显式指定指南专题 topicId', 400)
    }
    const receipt = this.owner.commands.execute(
      {
        context,
        input,
        idempotencyKey: key,
        operation: 'inpatient.guideline-advice.request',
        expectedVersions: {},
        dataSchema: inpatientGuidelineAdviceSchema,
        authorize: () => this.#authorize(context, input.admissionId, 'manual'),
        storedResponse: response => ({ ...response, data: { ...response.data, result: null } }),
      },
      transaction => {
        const state = this.#state(context, input.admissionId, topicId, requestId)
        if (state.version !== input.expectedVersion || state.fingerprint !== input.expectedFingerprint) {
          throw new InpatientError('INPATIENT_GUIDELINE_CONFLICT', '计划、正式资料或指南依据已变化，请刷新后核实')
        }
        if (
          state.status === 'unknown'
          || (state.taskId && this.owner.database.driver.prepare(`
            SELECT 1 FROM model_task_step
            WHERE workspace_id=? AND epoch=? AND task_id=? AND status IN ('unknown','dispatching') LIMIT 1
          `).get(context.workspaceId, context.epoch, state.taskId))
        ) {
          throw new InpatientError('MODEL_OUTCOME_UNKNOWN', '原模型请求结果未知，请先核查原尝试；不会重新派发')
        }
        const basis = this.#basis(context, input.admissionId, topicId, requestId)
        if (basis.requestStatus === 'cancelled' || basis.frozen) {
          throw new InpatientError('INPATIENT_GUIDELINE_STALE', messages[state.status])
        }
        if (['queued', 'running', 'succeeded', 'incomplete', 'blocked'].includes(state.status)) {
          return { data: state, effects: [] }
        }
        const data = this.#create(context, input.admissionId, topicId, requestId, state.version + 1, 'manual', transaction)
        return {
          data,
          effects: [{ kind: 'updated' as const, reference: `InpatientGuidelineAdvice/${data.taskId}`, versionId: String(data.version) }],
        }
      },
    )
    // Replayed receipts must not return original text after a source restriction or withdrawal.
    return { ...receipt, data: this.#state(context, input.admissionId, topicId, requestId) }
  }

  async process(
    event: OutboxHandlerInput,
    options: {
      models: GenerationModelBinding
      recovery: ModelTaskRecovery
      provider?: JsonChatCompletionsProvider
      model?: string
      signal: AbortSignal
    },
  ): Promise<OutboxHandlerResult> {
    const payload = z.object({ taskId: z.string(), version: z.number().int().positive() }).strict().parse(event.payload)
    const row = rowSchema.optional().parse(
      this.owner.database.driver.prepare(`
        SELECT * FROM inpatient_guideline_advice
        WHERE workspace_id=? AND epoch=? AND task_id=? AND version=?
      `).get(event.workspaceId, event.epoch, payload.taskId, payload.version),
    )
    if (!row || ['succeeded', 'unknown', 'stale', 'no-evidence', 'rejected', 'failed'].includes(row.status)) {
      return { status: 'completed' }
    }
    const update = (status: Row['status'], code: string | null, result: string | null = null) =>
      this.owner.database.driver.prepare(`
        UPDATE inpatient_guideline_advice
        SET status=?, error_code=?, result_json=?
        WHERE workspace_id=? AND epoch=? AND task_id=? AND version=?
      `).run(status, code, result, row.workspace_id, row.epoch, row.task_id, row.version)

    const assertCurrent = () => {
      if (options.signal.aborted) throw options.signal.reason
      const context = contextSchema.parse(JSON.parse(row.context_json))
      this.#authorize(context, row.admission_id, row.trigger)
      const latest = this.#row(context, row.admission_id, row.topic_id, row.request_id)
      const basis = this.#basis(context, row.admission_id, row.topic_id, row.request_id)
      if (
        latest?.version !== row.version
        || latest.cancelled === 1
        || basis.fingerprint !== row.basis_fingerprint
        || basis.input.sourceStatus !== 'available'
        || basis.requestStatus === 'cancelled'
        || basis.frozen
      ) {
        throw new InpatientError('INPATIENT_GUIDELINE_STALE', '计划、正式资料或指南依据已变化')
      }
      return context
    }

    let waitUntil: 'runtime-restart' | undefined
    try {
      const context = assertCurrent()
      if (!options.provider || !options.model || options.provider.supportsUsageAccounting !== true) {
        waitUntil = 'runtime-restart'
        throw new ModelUsageControlError('MODEL_METERING_UNAVAILABLE', 'workspace')
      }
      update('running', null)
      const input = basisSchema.parse(JSON.parse(row.basis_json))
      const definition = getGuidelineTopicDefinition(row.topic_id)
      const genSchema = topicGenerationSchema(row.topic_id)
      const verSchema = topicVerificationSchema(row.topic_id)
      const model = await options.models.bind(event.workspaceId, row.task_id, options.model, options.signal)
      const usageContext = {
        workspaceId: event.workspaceId,
        epoch: event.epoch,
        taskId: row.task_id,
        actorId: context.actorId,
        practitionerRoleId: context.practitionerRoleId!,
        caseId: row.admission_id,
        encounterId: row.admission_id,
        trigger: row.trigger,
        sources: [
          { kind: 'job' as const, id: event.eventId, relationship: 'trigger' as const },
          ...input.guidelines.map(item => ({ kind: 'document' as const, id: item.id, relationship: 'evidence' as const })),
        ],
      }
      const normalize = (raw: unknown) => {
        const generated = genSchema.parse(raw)
        if (
          generated.conclusions.some(item =>
            (input.missing.length > 0 && item.applicability !== 'conditional')
            || item.citations.some(citation =>
              !input.guidelines.some(evidence => evidence.id === citation.evidenceId && evidence.text.includes(citation.quote))))
        ) {
          throw new InpatientError('INPATIENT_GUIDELINE_INVALID', '结论没有引用实际读取的原句，或把资料缺项当作已确认适用')
        }
        return generated
      }
      const generated = await options.provider.completeJson({
        model,
        schemaName: 'inpatient_drg_recommendation',
        jsonSchema: z.toJSONSchema(genSchema),
        systemPrompt: `${definition.generationRule} 不产生清单、诊断、手术、预留或收费。`,
        userPayload: input,
        usageContext: { ...usageContext, stage: `guideline-${row.version}-generation` },
        signal: options.signal,
        maxAttempts: 2,
        onBeforeRequest: assertCurrent,
        validate: raw => { normalize(raw); return true },
      })
      const proposed = normalize(JSON.parse(generated.content))
      assertCurrent()
      const verified = await options.provider.completeJson({
        model,
        schemaName: 'inpatient_drg_verification',
        jsonSchema: z.toJSONSchema(verSchema),
        systemPrompt: '独立核验proposed三类结论是否由同组guidelines实际原文与clinicalFacts支持。topic是导航不能作证据。分别核验人群、条件、例外、推荐强度、未知测量及无固定产品和数量；资料不足只能发布conditional意见，原句必须实际存在。逐项返回原kind及所有核验标志与理由，未知不得判支持。',
        userPayload: { ...input, proposed },
        usageContext: { ...usageContext, stage: `guideline-${row.version}-verification` },
        signal: options.signal,
        maxAttempts: 2,
        onBeforeRequest: assertCurrent,
        validate: raw => verSchema.safeParse(raw).success,
      })
      const verification = verSchema.parse(JSON.parse(verified.content))
      if (
        verification.conclusions.some(item =>
          !item.supported
          || !item.populationPreserved
          || !item.conditionsPreserved
          || !item.strengthPreserved
          || !item.noInventedMeasurements
          || !item.noProductOrQuantity)
      ) {
        throw new InpatientError('INPATIENT_GUIDELINE_REJECTED', '指南意见未通过独立核验')
      }
      this.owner.database.driver.transaction(() => {
        assertCurrent()
        update('succeeded', null, JSON.stringify(inpatientGuidelineAdviceResultSchema.parse({
          id: uuidv7(),
          fingerprint: row.basis_fingerprint,
          model,
          createdAt: this.owner.virtualTime(context),
          topic: { id: input.topic.id, version: input.topic.version, fingerprint: definition.fingerprint },
          guidelines: input.guidelines,
          conclusions: proposed.conclusions,
          limitations: input.topic.limitations,
        })))
      })()
      return { status: 'completed' }
    } catch (error) {
      if (error instanceof InpatientError || error instanceof WorkspaceContextError) {
        if (error instanceof InpatientError && error.code === 'INPATIENT_GUIDELINE_REJECTED') {
          update('rejected', error.code)
          return { status: 'completed' }
        }
        if (!(error instanceof InpatientError) || error.code !== 'INPATIENT_GUIDELINE_INVALID') {
          update('stale', 'INPATIENT_GUIDELINE_STALE')
          return { status: 'completed' }
        }
      }
      const unknown = modelTaskOutcomeUnknown(error)
      const failure = modelUsageControlFailure(error)
      update(
        unknown ? 'unknown' : failure ? 'blocked' : 'failed',
        unknown ? 'MODEL_OUTCOME_UNKNOWN' : failure?.code ?? 'INPATIENT_GUIDELINE_FAILED',
      )
      return options.recovery.defer(event, error, waitUntil) ?? { status: 'completed' }
    }
  }
}
