import { inpatientDrgReviewBasisSchema } from '@clinmesh/contracts/inpatient-drg-review'
import type { ModelUsageContext } from '@clinmesh/contracts/model-usage'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientDrgAgentSchema, inpatientDrgAgentAnalysisSchema, inpatientDrgAgentGenerationSchema,
  inpatientDrgAgentVerificationSchema, inpatientDrgAgentStageSchema, inpatientDrgAgentConfirmInputSchema,
  inpatientDrgAgentPlanSchema, inpatientDrgAgentPostGenerationSchema, inpatientDrgAgentPostVerificationSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { CommandTransaction, type ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import type { GenerationModelBinding } from './generation-model-binding.ts'
import type { ModelTaskRecovery } from './model-task-recovery.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'
import type { JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'
import { ModelUsageControlError, modelUsageControlFailure } from './model-usage-control.ts'
import { modelTaskOutcomeUnknown } from './model-task-recovery.ts'

const inputSchema = z.object({
  selection: inpatientPciSelectionSchema.omit({ history: true }),
  surgery: inpatientSurgerySchema.omit({ virtualTime: true, encounterVersion: true }),
  rulesFingerprint: z.string(), stage: inpatientDrgAgentStageSchema,
  review: inpatientDrgReviewBasisSchema.optional(),
  remaining: z.array(z.object({ materialId: z.string(), quantity: z.number().int().nonnegative() }).strict()),
}).strict()
const rowSchema = z.object({ workspace_id: z.string(), epoch: z.string(), analysis_id: z.string(), task_id: z.string(),
  admission_id: z.string(), revision: z.number(), task_version: z.number(), basis_fingerprint: z.string(),
  stage: inpatientDrgAgentStageSchema, status: z.enum(['queued', 'running', 'succeeded', 'stale', 'blocked', 'unknown', 'failed']),
  input_json: z.string(), result_json: z.string().nullable(), error_code: z.string().nullable(), created_at: z.string() })
const eventSchema = z.object({ analysisId: z.string(), taskId: z.string() }).strict()
const generationPrompt = '你是住院 PCI 耗材建议助手，只消费本次医生确认的参数、具体产品版本及合成依据。仅在给定 valid 候选内选择，不改变治疗方向；每项引用其 evidence.id，数量严格使用 remaining 中尚待使用的数量，完整覆盖正余量候选，零余量不再建议；全部已用时 items 为空。已发生事实保留在 surgery 中，不再计入后续用量或费用。优先比较相同临床要求下预计收费较低的已认可方案，价格不等于成本或利润。不从目录或费用反推患者信息，不把合成协议称为真实临床金标准。只返回 items，不提交任何正式业务。'
const verificationPrompt = '独立逐项核对建议与给定本次住院参数、具体产品版本、数量来源和兼容依据。核验全部建议且不增项；适用、兼容、数量及引用任一不成立即返回 false。未知不视为通过，合成依据仅适用于明确的合成范围。'

export class InpatientDrgAgent {
  readonly #unsubscribe: () => void
  constructor(private readonly owner: InpatientService) {
    this.#unsubscribe = owner.commands.subscribe((context, effects) => {
      if (effects.length > 0) this.refreshPending(context.workspaceId, context.epoch)
    })
  }
  close() { this.#unsubscribe() }

  plans(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    return z.array(z.object({ plan_json: z.string() })).parse(this.owner.database.driver.prepare(`SELECT plan_json
      FROM inpatient_drg_agent_plan WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY revision DESC`)
      .all(context.workspaceId, context.epoch, admissionId)).map(row => inpatientDrgAgentPlanSchema.parse(JSON.parse(row.plan_json)))
  }

  prePlanForRequest(context: ActorContext, admissionId: string, requestId: string) {
    const confirmations = this.owner.pciSelection.read(context, admissionId).history
    return this.plans(context, admissionId).find(plan => plan.stage === 'preoperative' && confirmations.some(confirmation =>
      confirmation.id === plan.sources.selectionConfirmationId && confirmation.version === plan.sources.selectionVersion
        && confirmation.parameters.requestId === requestId))
  }

  confirm(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientDrgAgentConfirmInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.drg.agent.confirm',
      expectedVersions: {}, dataSchema: inpatientDrgAgentSchema,
      authorize: () => { this.owner.assertRole(context, ['inpatient-doctor']); this.owner.admissionBinding(context, input.admissionId) },
    }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      const state = this.read(context, input.admissionId), analysis = state.analysis
      if (state.status !== 'succeeded' || !analysis || analysis.id !== input.analysisId
        || state.basisFingerprint !== input.expectedBasisFingerprint || analysis.basisFingerprint !== state.basisFingerprint)
        throw new InpatientError('INPATIENT_DRG_AGENT_STALE', '建议或依据已变化，请核对最新参数与建议')
      if ((state.confirmedPlan?.revision ?? 0) !== input.expectedRevision)
        throw new InpatientError('INPATIENT_DRG_PLAN_CONFLICT', '已确认计划版本发生变化，请刷新后审阅')
      const selection = this.owner.pciSelection.read(context, input.admissionId)
      const items = input.items.map(item => {
        const candidate = selection.candidates.find(candidate => candidate.materialId === item.materialId && candidate.materialVersion === item.catalogVersion)
        if (!candidate?.item || candidate.eligibility !== 'valid' || candidate.expectedQuantity !== item.quantity)
          throw new InpatientError('INPATIENT_DRG_PLAN_UNSUPPORTED', '修改后的产品或数量缺少适用依据；请先更新并确认选型参数')
        return { ...item, display: candidate.item.display, unit: candidate.item.chargeDefinition.unit,
          unitPriceFen: candidate.item.chargeDefinition.priceFen, estimatedFen: candidate.expectedAmountFen!, evidenceIds: [candidate.evidence.id],
          quantityBasis: selection.confirmation!.parameters.plannedQuantities.find(plan => plan.category === candidate.category)!.basis }
      })
      const plan = inpatientDrgAgentPlanSchema.parse({ revision: input.expectedRevision + 1, analysisId: input.analysisId,
        basisFingerprint: input.expectedBasisFingerprint, stage: analysis.stage, sources: analysis.sources,
        items, confirmedBy: context.actorId, confirmedAt: this.owner.virtualTime(context), note: input.note })
      this.owner.database.driver.prepare('INSERT INTO inpatient_drg_agent_plan VALUES(?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, input.admissionId, plan.revision, JSON.stringify(plan))
      return { data: this.read(context, input.admissionId), effects: [{ kind: 'created' as const,
        reference: `InpatientDrgPlan/${input.admissionId}`, versionId: String(plan.revision) }] }
    })
  }

  private basis(taskId: string) {
    const current = this.owner.followup.current(taskId)
    const selected = this.owner.pciSelection.read(current.context, current.task.admissionId)
    const surgery = this.owner.surgery.read(current.context, current.task.admissionId)
    const { history: _history, ...selection } = selected
    const approvedMaterialIds = selection.confirmation?.parameters.approvedMaterialIds ?? []
    const candidates = selection.candidates.filter(candidate => approvedMaterialIds.includes(candidate.materialId))
    const { virtualTime: _time, encounterVersion: _version, ...facts } = surgery
    const requestId = selection.confirmation?.parameters.requestId
    const completed = facts.executions.find(item => item.requestId === requestId)
    const ongoing = facts.inProgress.find(item => item.requestId === requestId)
    const stage = completed ? 'postoperative' : ongoing ? 'intraoperative' : 'preoperative'
    const frozenPlan = requestId === undefined ? undefined : this.prePlanForRequest(current.context, current.task.admissionId, requestId)
    const plan = frozenPlan?.sources.selectionConfirmationId === selection.confirmation?.id
      && frozenPlan?.sources.selectionVersion === selection.confirmation?.version ? frozenPlan : undefined
    const remaining = candidates.map(candidate => {
      const planned = plan ? plan.items.find(item => item.materialId === candidate.materialId)?.quantity ?? 0 : candidate.expectedQuantity ?? 0
      const used = (completed ?? ongoing)?.materials.filter(item => item.item.id === candidate.materialId).reduce((sum, item) => sum + item.quantity, 0) ?? 0
      return { materialId: candidate.materialId, quantity: completed ? 0 : Math.max(0, planned - used) }
    })
    const review = stage === 'postoperative' ? this.owner.drgReview.modelBasis(current.context, current.task.admissionId) : undefined
    const input = inputSchema.parse({ selection, surgery: facts, rulesFingerprint: current.fingerprint, stage, remaining, ...(review === undefined ? {} : { review }) })
    const missing: string[] = []
    if (selection.confirmation === null) missing.push('尚无医生确认的选型参数')
    if (approvedMaterialIds.length === 0) missing.push('尚无医生认可的具体耗材候选')
    for (const materialId of approvedMaterialIds) {
      if (!selection.candidates.some(candidate => candidate.materialId === materialId)) missing.push(`${materialId}: 不在已发布的 PCI 候选中`)
    }
    if (requestId === undefined || !facts.requests.some(item => item.id === requestId && item.status !== 'cancelled')) missing.push('尚无关联的有效 PCI 手术计划')
    if (current.errorCode !== null) missing.push(current.errorCode)
    for (const candidate of candidates) {
      if (candidate.eligibility !== 'valid') missing.push(...candidate.missing.map(reason => `${candidate.materialId}: ${reason}`))
    }
    return { ...current, input, missing, fingerprint: canonicalJsonHash(input) }
  }
  #rows(workspaceId: string, epoch: string, taskId: string) {
    return z.array(rowSchema).parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_drg_agent_analysis
      WHERE workspace_id=? AND epoch=? AND task_id=? ORDER BY revision DESC`).all(workspaceId, epoch, taskId))
  }
  read(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    const task = this.owner.followup.state(context, admissionId).task
    const rows = task === null ? [] : this.#rows(context.workspaceId, context.epoch, task.id)
    let basis: ReturnType<InpatientDrgAgent['basis']> | undefined
    if (task?.status === 'active') {
      try { basis = this.basis(task.id) } catch (error) { if (!(error instanceof InpatientError)) throw error }
    }
    const current = rows.find(row => row.basis_fingerprint === basis?.fingerprint), latest = current ?? rows[0]
    const analysis = latest?.result_json ? inpatientDrgAgentAnalysisSchema.parse(JSON.parse(latest.result_json)) : null
    const lastPublished = rows.find(row => row.result_json !== null)
    const lastAnalysis = lastPublished?.result_json ? inpatientDrgAgentAnalysisSchema.parse(JSON.parse(lastPublished.result_json)) : null
    const planHistory = this.plans(context, admissionId)
    return inpatientDrgAgentSchema.parse({ admissionId, taskId: task?.id ?? null,
      status: basis === undefined ? 'inactive' : basis.missing.length > 0 ? 'incomplete' : current?.status ?? (latest ? 'stale' : 'queued'),
      basisFingerprint: basis?.fingerprint ?? null, stage: basis?.input.stage ?? latest?.stage ?? null,
      missing: basis?.missing ?? [], failureCode: (current ?? latest)?.error_code ?? null, analysis, lastAnalysis, lastStatus: latest?.status ?? null, confirmedPlan: planHistory[0] ?? null, planHistory })
  }

  refreshPending(workspaceId?: string, epoch?: string) {
    const tasks = z.array(z.object({ task_id: z.string() })).parse(this.owner.database.driver.prepare(`SELECT task_id FROM inpatient_drg_followup
      WHERE status='active' ${workspaceId === undefined ? '' : 'AND workspace_id=? AND epoch=?'}`)
      .all(...(workspaceId === undefined ? [] : [workspaceId, epoch ?? ''])))
    for (const { task_id: taskId } of tasks) {
      let basis: ReturnType<InpatientDrgAgent['basis']>
      try { basis = this.basis(taskId) } catch (error) { if (error instanceof InpatientError) continue; throw error }
      if (basis.missing.length > 0) continue
      const rows = this.#rows(basis.context.workspaceId, basis.context.epoch, taskId)
      const existing = rows.find(row => row.basis_fingerprint === basis.fingerprint)
      if (existing) {
        // 在途终态由原 worker 写入，提前换授权版本会吞掉 unknown；成功步骤随后安全接续。
        if (existing.status === 'succeeded' || existing.status === 'unknown' || existing.status === 'running') continue
        const renewed = existing.task_version !== basis.task.version
        if (renewed || existing.status === 'queued') this.owner.database.driver.transaction(() => {
          if (renewed) this.owner.database.driver.prepare(`UPDATE inpatient_drg_agent_analysis SET task_version=?,status='queued',error_code=NULL
            WHERE workspace_id=? AND epoch=? AND analysis_id=? AND task_version=? AND status NOT IN ('succeeded','unknown')`)
            .run(basis.task.version, basis.context.workspaceId, basis.context.epoch, existing.analysis_id, existing.task_version)
          this.owner.database.driver.prepare(`UPDATE outbox_event SET status='queued',next_attempt_at=?
            WHERE workspace_id=? AND epoch=? AND kind='inpatient.drg.agent.analyze' AND dedup_key=? AND status IN ('completed','failed')`)
            .run(new Date().toISOString(), basis.context.workspaceId, basis.context.epoch, `${taskId}:${basis.fingerprint}`)
        })()
        continue
      }
      this.owner.database.driver.transaction(() => {
        const analysisId = uuidv7(), revision = (rows[0]?.revision ?? 0) + 1, createdAt = this.owner.virtualTime(basis.context)
        this.owner.database.driver.prepare(`INSERT INTO inpatient_drg_agent_analysis
          (workspace_id,epoch,analysis_id,task_id,admission_id,revision,task_version,basis_fingerprint,stage,status,input_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(basis.context.workspaceId, basis.context.epoch, analysisId, taskId,
          basis.task.admissionId, revision, basis.task.version, basis.fingerprint, basis.input.stage, JSON.stringify(basis.input), createdAt)
        new CommandTransaction(this.owner.database, this.owner.fhir, basis.context, () => new Date()).enqueue({
          kind: 'inpatient.drg.agent.analyze', dedupKey: `${taskId}:${basis.fingerprint}`, payload: { taskId, analysisId } })
      })()
    }
  }

  async process(event: OutboxHandlerInput, options: { models: GenerationModelBinding; recovery: ModelTaskRecovery;
    provider?: JsonChatCompletionsProvider; model?: string; signal: AbortSignal }): Promise<OutboxHandlerResult> {
    const payload = eventSchema.parse(event.payload)
    const row = rowSchema.optional().parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_drg_agent_analysis
      WHERE workspace_id=? AND epoch=? AND analysis_id=? AND task_id=?`).get(event.workspaceId, event.epoch, payload.analysisId, payload.taskId))
    if (!row || row.status === 'succeeded' || row.status === 'unknown' || row.status === 'stale') return { status: 'completed' }
    const update = (status: z.infer<typeof rowSchema>['status'], errorCode: string | null) => this.owner.database.driver.prepare(`
      UPDATE inpatient_drg_agent_analysis SET status=?,error_code=? WHERE workspace_id=? AND epoch=? AND analysis_id=? AND task_version=?`)
      .run(status, errorCode, event.workspaceId, event.epoch, row.analysis_id, row.task_version)
    const assertCurrent = () => {
      if (options.signal.aborted) throw options.signal.reason
      const basis = this.basis(row.task_id)
      if (basis.task.version !== row.task_version || basis.fingerprint !== row.basis_fingerprint || basis.missing.length > 0)
        throw new InpatientError('INPATIENT_DRG_AGENT_STALE', '建议依据或后台授权已变化')
      return basis
    }
    try {
      const basis = assertCurrent()
      if (!options.provider || !options.model || options.provider.supportsUsageAccounting !== true) {
        throw new ModelUsageControlError('MODEL_METERING_UNAVAILABLE', 'workspace')
      }
      update('running', null)
      const input = inputSchema.parse(JSON.parse(row.input_json)), model = await options.models.bind(event.workspaceId, row.task_id, options.model, options.signal)
      const previous = this.#rows(event.workspaceId, event.epoch, row.task_id).find(item => item.revision < row.revision)
      const before = previous ? inputSchema.parse(JSON.parse(previous.input_json)) : undefined
      const selectionRef = `InpatientPciSelection/${input.selection.confirmation!.id}/version/${input.selection.confirmation!.version}`
      const sources: ModelUsageContext['sources'] = [{ kind: 'job', id: event.eventId, relationship: before ? 'evidence' : 'trigger' }]
      sources.push({ kind: 'document', id: selectionRef,
        relationship: before && canonicalJsonHash(before.selection.confirmation) !== canonicalJsonHash(input.selection.confirmation) ? 'trigger' : 'evidence' })
      const previousExecutions = [...(before?.surgery.executions ?? []), ...(before?.surgery.inProgress ?? [])]
      for (const execution of [...input.surgery.executions, ...input.surgery.inProgress]) {
        const old = previousExecutions.find(item => item.id === execution.id)
        sources.push({ kind: 'document', id: `Procedure/${execution.id}`, relationship: before && (!old || canonicalJsonHash(old) !== canonicalJsonHash(execution)) ? 'trigger' : 'evidence' })
        for (const use of execution.materialHistory) {
          const oldUse = old?.materialHistory.find(item => item.id === use.id)
          sources.push({ kind: 'document', id: `InpatientSurgeryMaterial/${use.id}`, relationship: before && !oldUse ? 'trigger' : 'evidence' })
          if (use.correction) sources.push({ kind: 'document', id: `InpatientSurgeryMaterialCorrection/${use.correction.id}`,
            relationship: before && !oldUse?.correction ? 'trigger' : 'evidence' })
        }
      }
      sources.push({ kind: 'document', id: `DrgBasis/${input.rulesFingerprint}`, relationship: before && before.rulesFingerprint !== input.rulesFingerprint ? 'trigger' : 'evidence' })
      if (before && input.review && before.review?.fingerprint !== input.review.fingerprint && !sources.some(source => source.relationship === 'trigger'))
        sources.push({ kind: 'document', id: `InpatientDrgReview/${input.review.fingerprint}`, relationship: 'trigger' })
      const usageContext = { workspaceId: event.workspaceId, epoch: event.epoch, taskId: row.task_id,
        actorId: basis.context.actorId, ...(basis.context.practitionerRoleId === undefined ? {} : { practitionerRoleId: basis.context.practitionerRoleId }),
        caseId: row.admission_id, encounterId: row.admission_id, trigger: 'automatic' as const,
        sources }
      const postoperative = row.stage === 'postoperative'
      const generationSchema = postoperative ? inpatientDrgAgentPostGenerationSchema : inpatientDrgAgentGenerationSchema
      const verificationSchema = postoperative ? inpatientDrgAgentPostVerificationSchema : inpatientDrgAgentVerificationSchema
      const parseGeneration = (raw: unknown) => postoperative ? inpatientDrgAgentPostGenerationSchema.parse(raw)
        : { ...inpatientDrgAgentGenerationSchema.parse(raw), observations: [] }
      const parseVerification = (raw: unknown) => postoperative ? inpatientDrgAgentPostVerificationSchema.parse(raw)
        : { ...inpatientDrgAgentVerificationSchema.parse(raw), observations: [] }
      const normalize = (raw: unknown) => {
        const generated = parseGeneration(raw), { observations } = generated
        if (postoperative && (observations.length !== (input.review?.issues.length ?? 0) || observations.some(observation => {
          const issue = input.review?.issues.find(item => item.key === observation.key)
          return !issue || observation.evidenceIds.length !== issue.evidence.length || new Set(observation.evidenceIds).size !== issue.evidence.length
            || observation.evidenceIds.some(id => !issue.evidence.includes(id))
        }))) throw new InpatientError('INPATIENT_DRG_AGENT_INVALID', '术后解释缺少逐项问题或来源引用')
        const candidates = input.selection.candidates.filter(candidate => candidate.eligibility === 'valid')
        const remaining = input.remaining.filter(item => item.quantity > 0)
        if (generated.items.length !== remaining.length) throw new InpatientError('INPATIENT_DRG_AGENT_INVALID', '模型未完整核对剩余耗材候选')
        const items = generated.items.map(item => {
          const candidate = candidates.find(candidate => candidate.materialId === item.materialId && candidate.materialVersion === item.catalogVersion)
          if (!candidate?.item || remaining.find(value => value.materialId === item.materialId)?.quantity !== item.quantity
            || item.evidenceIds.length !== 1 || item.evidenceIds[0] !== candidate.evidence.id)
            throw new InpatientError('INPATIENT_DRG_AGENT_INVALID', '模型候选、数量或引用超出已核验的本次依据')
          return { ...item, display: candidate.item.display, unit: candidate.item.chargeDefinition.unit,
            unitPriceFen: candidate.item.chargeDefinition.priceFen, estimatedFen: candidate.item.chargeDefinition.priceFen * item.quantity,
            quantityBasis: input.selection.confirmation!.parameters.plannedQuantities.find(plan => plan.category === candidate.category)!.basis }
        }).sort((a, b) => a.estimatedFen - b.estimatedFen || a.materialId.localeCompare(b.materialId))
        return { items, observations }
      }
      const generated = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_recommendation',
        jsonSchema: z.toJSONSchema(generationSchema), systemPrompt: postoperative ? `${generationPrompt.replace('只返回 items', '返回 items 和 observations')} 术后另外逐项解释 review.issues，observations 每项保留原 key，evidenceIds 必须完整引用该问题给出的 evidence。说明额外、未使用、替换或记录计费疑点；无依据的用途保留待核实，不自行关闭待办，不改变诊断、治疗或病组。` : generationPrompt, userPayload: input,
        usageContext: { ...usageContext, stage: `${row.stage}-generation` }, signal: options.signal, maxAttempts: 2,
        onBeforeRequest: () => { assertCurrent() }, validate: value => { normalize(value); return true } })
      const { items, observations } = normalize(JSON.parse(generated.content))
      assertCurrent()
      const completeVerification = (result: ReturnType<typeof parseVerification>) => {
        const checks = result.observations
        return result.items.length === items.length && items.every(item => result.items.some(check => check.materialId === item.materialId))
          && (!postoperative || checks.length === observations.length && observations.every(item => checks.some(check => check.key === item.key)))
      }
      const verificationShape = (raw: unknown) => completeVerification(parseVerification(raw))
      const validateVerification = (raw: unknown) => {
        const result = parseVerification(raw)
        return completeVerification(result) && result.items.every(check => check.applicable && check.compatible && check.quantitySupported && check.evidenceSupported)
          && result.observations.every(check => check.supported)
      }
      const verified = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_verification',
        jsonSchema: z.toJSONSchema(verificationSchema), systemPrompt: postoperative ? `${verificationPrompt} 同时核验 observations 的每个原问题 key、差异解释和引用是否由 review 的正式事实支持；不能把关闭提示或模型自述当作业务已解决。` : verificationPrompt, userPayload: { ...input, proposed: items, ...(postoperative ? { observations } : {}) },
        usageContext: { ...usageContext, stage: `${row.stage}-verification` }, signal: options.signal, maxAttempts: 2,
        onBeforeRequest: () => { assertCurrent() }, validate: verificationShape })
      if (!validateVerification(JSON.parse(verified.content))) throw new InpatientError('INPATIENT_DRG_AGENT_INVALID', '独立核验未通过')
      assertCurrent()
      const result = inpatientDrgAgentAnalysisSchema.parse({ id: row.analysis_id, revision: row.revision, basisFingerprint: row.basis_fingerprint,
        stage: row.stage, createdAt: row.created_at, model, items, observations,
        sources: { selectionConfirmationId: input.selection.confirmation!.id, selectionVersion: input.selection.confirmation!.version,
          evidencePackageId: input.selection.evidencePackage.id, evidencePackageVersion: input.selection.evidencePackage.version,
          materialEvidence: input.selection.candidates.map(candidate => candidate.evidence) } })
      this.owner.database.driver.prepare(`UPDATE inpatient_drg_agent_analysis SET status='succeeded',result_json=?,error_code=NULL
        WHERE workspace_id=? AND epoch=? AND analysis_id=? AND task_version=?`).run(JSON.stringify(result), event.workspaceId, event.epoch, row.analysis_id, row.task_version)
      return { status: 'completed' }
    } catch (error) {
      if (error instanceof InpatientError && ['INPATIENT_DRG_AGENT_STALE', 'INPATIENT_DRG_FOLLOWUP_INACTIVE'].includes(error.code)) {
        update('stale', error.code); return { status: 'completed' }
      }
      const failure = modelUsageControlFailure(error), unknown = modelTaskOutcomeUnknown(error)
      update(unknown ? 'unknown' : failure ? 'blocked' : 'failed', unknown ? 'MODEL_OUTCOME_UNKNOWN' : failure?.code ?? 'INPATIENT_DRG_AGENT_FAILED')
      return options.recovery.defer(event, error) ?? { status: 'completed' }
    }
  }
}
