import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientDrgAgentSchema, inpatientDrgAgentAnalysisSchema, inpatientDrgAgentGenerationSchema,
  inpatientDrgAgentVerificationSchema, inpatientDrgAgentStageSchema, inpatientDrgAgentConfirmInputSchema,
  inpatientDrgAgentPlanSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { CommandTransaction, type ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import type { GenerationModelBinding } from './generation-model-binding.ts'
import type { ModelTaskRecovery } from './model-task-recovery.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'
import type { JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'
import { modelUsageControlFailure } from './model-usage-control.ts'
import { modelTaskOutcomeUnknown } from './model-task-recovery.ts'

const inputSchema = z.object({
  selection: inpatientPciSelectionSchema.omit({ history: true }),
  surgery: inpatientSurgerySchema.omit({ virtualTime: true, encounterVersion: true }),
  rulesFingerprint: z.string(), stage: inpatientDrgAgentStageSchema,
}).strict()
const rowSchema = z.object({ workspace_id: z.string(), epoch: z.string(), analysis_id: z.string(), task_id: z.string(),
  admission_id: z.string(), revision: z.number(), task_version: z.number(), basis_fingerprint: z.string(),
  stage: inpatientDrgAgentStageSchema, status: z.enum(['queued', 'running', 'succeeded', 'stale', 'blocked', 'unknown', 'failed']),
  input_json: z.string(), result_json: z.string().nullable(), error_code: z.string().nullable(), created_at: z.string() })
const eventSchema = z.object({ analysisId: z.string(), taskId: z.string() }).strict()
const generationPrompt = '你是住院 PCI 耗材建议助手，只消费本次医生确认的参数、具体产品版本及合成依据。仅在给定 valid 候选内选择，不改变治疗方向；每项引用其 evidence.id、保留医生预计数量。优先比较相同临床要求下预计收费较低的已认可方案，价格不等于成本或利润。不从目录或费用反推患者信息，不把合成协议称为真实临床金标准。只返回 items，不提交任何正式业务。'
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
        basisFingerprint: input.expectedBasisFingerprint, items, confirmedBy: context.actorId, confirmedAt: this.owner.virtualTime(context), note: input.note })
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
    const { virtualTime: _time, encounterVersion: _version, ...facts } = surgery
    const requestId = selection.confirmation?.parameters.requestId
    const stage = requestId !== undefined && facts.executions.some(item => item.requestId === requestId) ? 'postoperative' : 'preoperative'
    const input = inputSchema.parse({ selection, surgery: facts, rulesFingerprint: current.fingerprint, stage })
    const missing: string[] = []
    if (selection.confirmation === null) missing.push('尚无医生确认的选型参数')
    if (requestId === undefined || !facts.requests.some(item => item.id === requestId && item.status !== 'cancelled')) missing.push('尚无关联的有效 PCI 手术计划')
    if (current.errorCode !== null) missing.push(current.errorCode)
    for (const candidate of selection.candidates) {
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
    const task = this.owner.followup.read(context, admissionId).task
    const rows = task === null ? [] : this.#rows(context.workspaceId, context.epoch, task.id)
    let basis: ReturnType<InpatientDrgAgent['basis']> | undefined
    if (task?.status === 'active') {
      try { basis = this.basis(task.id) } catch (error) { if (!(error instanceof InpatientError)) throw error }
    }
    const current = rows.find(row => row.basis_fingerprint === basis?.fingerprint), latest = current ?? rows[0]
    const analysis = latest?.result_json ? inpatientDrgAgentAnalysisSchema.parse(JSON.parse(latest.result_json)) : null
    const planHistory = this.plans(context, admissionId)
    return inpatientDrgAgentSchema.parse({ admissionId, taskId: task?.id ?? null,
      status: basis === undefined ? 'inactive' : basis.missing.length > 0 ? 'incomplete' : current?.status ?? (latest ? 'stale' : 'queued'),
      basisFingerprint: basis?.fingerprint ?? null, stage: basis?.input.stage ?? latest?.stage ?? null,
      missing: basis?.missing ?? [], failureCode: current?.error_code ?? null, analysis, confirmedPlan: planHistory[0] ?? null, planHistory })
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
      if (rows.some(row => row.basis_fingerprint === basis.fingerprint)) continue
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
      UPDATE inpatient_drg_agent_analysis SET status=?,error_code=? WHERE workspace_id=? AND epoch=? AND analysis_id=?`)
      .run(status, errorCode, event.workspaceId, event.epoch, row.analysis_id)
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
        update('blocked', 'MODEL_METERING_UNAVAILABLE'); return { status: 'completed' }
      }
      update('running', null)
      const input = inputSchema.parse(JSON.parse(row.input_json)), model = await options.models.bind(event.workspaceId, row.task_id, options.model, options.signal)
      const usageContext = { workspaceId: event.workspaceId, epoch: event.epoch, taskId: row.task_id,
        actorId: basis.context.actorId, ...(basis.context.practitionerRoleId === undefined ? {} : { practitionerRoleId: basis.context.practitionerRoleId }),
        caseId: row.admission_id, encounterId: row.admission_id, trigger: 'automatic' as const,
        sources: [{ kind: 'job' as const, id: event.eventId, relationship: 'trigger' as const }] }
      const normalize = (raw: unknown) => {
        const generated = inpatientDrgAgentGenerationSchema.parse(raw)
        const candidates = input.selection.candidates.filter(candidate => candidate.eligibility === 'valid')
        if (generated.items.length === 0) throw new InpatientError('INPATIENT_DRG_AGENT_INVALID', '模型未形成可核验的候选')
        return generated.items.map(item => {
          const candidate = candidates.find(candidate => candidate.materialId === item.materialId && candidate.materialVersion === item.catalogVersion)
          if (!candidate?.item || candidate.expectedQuantity !== item.quantity || item.evidenceIds.length !== 1 || item.evidenceIds[0] !== candidate.evidence.id)
            throw new InpatientError('INPATIENT_DRG_AGENT_INVALID', '模型候选、数量或引用超出已核验的本次依据')
          return { ...item, display: candidate.item.display, unit: candidate.item.chargeDefinition.unit,
            unitPriceFen: candidate.item.chargeDefinition.priceFen, estimatedFen: candidate.expectedAmountFen!,
            quantityBasis: input.selection.confirmation!.parameters.plannedQuantities.find(plan => plan.category === candidate.category)!.basis }
        }).sort((a, b) => a.estimatedFen - b.estimatedFen || a.materialId.localeCompare(b.materialId))
      }
      const generated = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_recommendation',
        jsonSchema: z.toJSONSchema(inpatientDrgAgentGenerationSchema), systemPrompt: generationPrompt, userPayload: input,
        usageContext: { ...usageContext, stage: `${row.stage}-generation` }, signal: options.signal, maxAttempts: 2,
        onBeforeRequest: () => { assertCurrent() }, validate: value => { normalize(value); return true } })
      const items = normalize(JSON.parse(generated.content))
      assertCurrent()
      const validateVerification = (raw: unknown) => {
        const result = inpatientDrgAgentVerificationSchema.parse(raw)
        return result.items.length === items.length && items.every(item => result.items.some(check => check.materialId === item.materialId
          && check.applicable && check.compatible && check.quantitySupported && check.evidenceSupported))
      }
      const verified = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_verification',
        jsonSchema: z.toJSONSchema(inpatientDrgAgentVerificationSchema), systemPrompt: verificationPrompt, userPayload: { ...input, proposed: items },
        usageContext: { ...usageContext, stage: `${row.stage}-verification` }, signal: options.signal, maxAttempts: 2,
        onBeforeRequest: () => { assertCurrent() }, validate: validateVerification })
      if (!validateVerification(JSON.parse(verified.content))) throw new InpatientError('INPATIENT_DRG_AGENT_INVALID', '独立核验未通过')
      assertCurrent()
      const result = inpatientDrgAgentAnalysisSchema.parse({ id: row.analysis_id, revision: row.revision, basisFingerprint: row.basis_fingerprint,
        stage: row.stage, createdAt: row.created_at, model, items })
      this.owner.database.driver.prepare(`UPDATE inpatient_drg_agent_analysis SET status='succeeded',result_json=?,error_code=NULL
        WHERE workspace_id=? AND epoch=? AND analysis_id=?`).run(JSON.stringify(result), event.workspaceId, event.epoch, row.analysis_id)
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
