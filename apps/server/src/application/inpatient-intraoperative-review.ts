import { z } from 'zod'
import { inpatientPciSelectionSchema, pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialPlanSchema } from '@clinmesh/contracts/inpatient-material-plan'
import { inpatientSurgeryMaterialHistorySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientCostsSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientIntraoperativeReviewSchema, inpatientIntraoperativeGenerationSchema, inpatientIntraoperativeVerificationSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { CommandTransaction, type ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { assertInpatientCostExplanation, readInpatientCosts } from './inpatient-costs.ts'
import { ModelUsageControlError, modelUsageControlFailure } from './model-usage-control.ts'
import { modelTaskOutcomeUnknown, type ModelTaskRecovery } from './model-task-recovery.ts'
import type { GenerationModelBinding } from './generation-model-binding.ts'
import type { JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'

const inputSchema = z.object({ kind: z.literal('intraoperative-review'), followupTaskId: z.string(), followupVersion: z.number().int().positive(),
  requestId: z.string(), executionId: z.string(), plan: inpatientMaterialPlanSchema,
  selection: inpatientPciSelectionSchema.omit({ history: true }),
  deviation: z.object({ use: inpatientSurgeryMaterialHistorySchema, reasons: inpatientIntraoperativeReviewSchema.shape.reasons,
    plannedQuantity: z.number().int().nonnegative(), usedBeforeQuantity: z.number().int().nonnegative(),
    remaining: z.array(z.object({ materialId: z.string(), quantity: z.number().int().nonnegative() }).strict()) }).strict(),
  costs: inpatientCostsSchema,
}).strict()
type Input = z.infer<typeof inputSchema>
const rowSchema = z.object({ analysis_id: z.string(), task_id: z.string(), admission_id: z.string(), basis_fingerprint: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'stale', 'blocked', 'unknown', 'failed']), input_json: z.string(), result_json: z.string().nullable(), error_code: z.string().nullable() })
type Row = z.infer<typeof rowSchema>

/** 每笔偏离拥有稳定任务；普通登记和费用刷新不产生新的模型意图。 */
export class InpatientIntraoperativeReview {
  constructor(readonly owner: InpatientService) {}
  #rows(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, admissionId: string) {
    return z.array(rowSchema).parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_drg_agent_analysis
      WHERE workspace_id=? AND epoch=? AND admission_id=? AND json_extract(input_json,'$.kind')='intraoperative-review'
      ORDER BY analysis_id`).all(context.workspaceId, context.epoch, admissionId))
  }
  owns(workspaceId: string, epoch: string, taskId: string) {
    return this.owner.database.driver.prepare(`SELECT 1 FROM inpatient_drg_agent_analysis WHERE workspace_id=? AND epoch=? AND task_id=?
      AND json_extract(input_json,'$.kind')='intraoperative-review'`).get(workspaceId, epoch, taskId) !== undefined
  }
  #facts(context: ActorContext, admissionId: string) {
    const surgery = this.owner.surgery.read(context, admissionId)
    return surgery.inProgress.flatMap(execution => {
      if (!pciSelectionProcedureCodes.includes(execution.actualProcedure.coding.code)) return []
      const basis = this.owner.materialPlans.forRequest(context, admissionId, execution.requestId)
      const plan = basis.history.find(item => item.reference === basis.effectiveReference)
      const selection = this.owner.pciSelection.read(context, admissionId, execution.requestId, 'confirmation')
      if (!plan || selection.candidates.length === 0) return []
      const { history: _history, ...selected } = selection
      const active = execution.materialHistory.filter(use => !use.correction && execution.materials.some(item => item.id === use.id))
      return [{ execution, plan, selection: selected, deviations: active.flatMap((use, index) => {
        if (execution.materialHistory.some(original => original.correction?.replacementMaterialUseId === use.id)) return []
        const item = plan.items.find(item => item.materialId === use.item.id && item.catalogVersion === use.item.version)
        const before = active.slice(0, index).filter(item => item.item.id === use.item.id && item.item.version === use.item.version)
          .reduce((sum, item) => sum + item.quantity, 0)
        const reasons: Input['deviation']['reasons'] = []
        if (!item) reasons.push('unplanned')
        else if (before + use.quantity > item.quantity) reasons.push('excess')
        const candidate = [...selected.candidates, ...selected.alternatives].find(item => item.materialId === use.item.id && item.materialVersion === use.item.version)
        if (candidate?.measurementCompatible === false) reasons.push('measurement-mismatch')
        if (reasons.length === 0) return []
        return [{ use, reasons, plannedQuantity: item?.quantity ?? 0, usedBeforeQuantity: before,
          remaining: plan.items.map(item => ({ materialId: item.materialId, quantity: Math.max(0, item.quantity - active.slice(0, index + 1)
            .filter(use => use.item.id === item.materialId && use.item.version === item.catalogVersion).reduce((sum, use) => sum + use.quantity, 0)) })) }]
      }) }]
    })
  }
  read(context: ActorContext, admissionId: string) {
    const facts = this.#facts(context, admissionId), rows = this.#rows(context, admissionId)
    const task = this.owner.followup.state(context, admissionId).task
    return { intraoperativePlans: facts.map(({ plan, selection }) => ({ requestId: plan.requestId, reference: plan.reference,
      items: plan.items.map(({ specification: _specification, ...item }) => item), candidates: selection.candidates, alternatives: selection.alternatives })),
      intraoperativeReviews: facts.flatMap(fact => fact.deviations.map(deviation => {
        const row = rows.find(row => inputSchema.parse(JSON.parse(row.input_json)).deviation.use.id === deviation.use.id)
        const input = row ? inputSchema.parse(JSON.parse(row.input_json)) : undefined
        const current = task?.status === 'active' && input?.followupTaskId === task.id && input.followupVersion === task.version
          && input.plan.reference === fact.plan.reference && canonicalJsonHash(input.selection) === canonicalJsonHash(fact.selection)
        const result = current && row?.status === 'succeeded' && row.result_json
          ? inpatientIntraoperativeGenerationSchema.parse(JSON.parse(row.result_json)) : null
        return inpatientIntraoperativeReviewSchema.parse({ materialUseId: deviation.use.id, executionId: fact.execution.id, requestId: fact.plan.requestId,
          taskId: row?.task_id ?? null, reasons: deviation.reasons, status: !row ? 'unavailable' : !current ? 'stale' : row.status,
          explanation: result?.explanation ?? null, costExplanation: result?.costExplanation ?? null, failureCode: row?.error_code ?? null })
      })) }
  }
  refreshPending(workspaceId?: string, epoch?: string) {
    const tasks = z.array(z.object({ task_id: z.string() })).parse(this.owner.database.driver.prepare(`SELECT task_id FROM inpatient_drg_followup
      WHERE status='active' ${workspaceId === undefined ? '' : 'AND workspace_id=? AND epoch=?'}`).all(...(workspaceId === undefined ? [] : [workspaceId, epoch ?? ''])))
    for (const { task_id: taskId } of tasks) {
      try {
        const current = this.owner.followup.current(taskId), { context, task } = current
        const rows = this.#rows(context, task.admissionId)
        for (const fact of this.#facts(context, task.admissionId)) for (const deviation of fact.deviations) {
          if (rows.some(row => inputSchema.parse(JSON.parse(row.input_json)).deviation.use.id === deviation.use.id)) continue
          this.owner.database.driver.transaction(() => {
            // 原随机任务也按本笔身份复用；跨runtime的旧读取不能创建第二份意图。
            if (this.owner.database.driver.prepare(`SELECT 1 FROM inpatient_drg_agent_analysis
              WHERE workspace_id=? AND epoch=? AND admission_id=? AND json_extract(input_json,'$.kind')='intraoperative-review'
              AND json_extract(input_json,'$.deviation.use.id')=?`).get(context.workspaceId, context.epoch, task.admissionId, deviation.use.id)) return
            const input = inputSchema.parse({ kind: 'intraoperative-review', followupTaskId: taskId, followupVersion: task.version,
              requestId: fact.plan.requestId, executionId: fact.execution.id, plan: fact.plan, selection: fact.selection, deviation,
              costs: readInpatientCosts(this.owner, context, task.admissionId) })
            const id = `intra-${deviation.use.id}`, createdAt = this.owner.virtualTime(context)
            this.owner.database.driver.prepare(`INSERT INTO inpatient_drg_agent_analysis
              (workspace_id,epoch,analysis_id,task_id,admission_id,revision,task_version,basis_fingerprint,stage,status,input_json,created_at)
              VALUES(?,?,?,?,?,1,1,?,'intraoperative','queued',?,?)`).run(context.workspaceId, context.epoch, id, id, task.admissionId,
                canonicalJsonHash(input), JSON.stringify(input), createdAt)
            new CommandTransaction(this.owner.database, this.owner.fhir, context, () => new Date()).enqueue({
              kind: 'inpatient.drg.agent.analyze', dedupKey: `${id}:1`, payload: { taskId: id, analysisId: id } })
          }).immediate()
        }
      } catch (error) { if (!(error instanceof InpatientError)) throw error }
    }
  }
  async process(event: OutboxHandlerInput, options: { models: GenerationModelBinding; recovery: ModelTaskRecovery;
    provider?: JsonChatCompletionsProvider; model?: string; signal: AbortSignal }): Promise<OutboxHandlerResult> {
    const payload = z.object({ taskId: z.string(), analysisId: z.string() }).strict().parse(event.payload)
    const row = rowSchema.optional().parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_drg_agent_analysis
      WHERE workspace_id=? AND epoch=? AND task_id=? AND analysis_id=?`).get(event.workspaceId, event.epoch, payload.taskId, payload.analysisId))
    if (!row || ['succeeded', 'unknown', 'stale', 'failed'].includes(row.status)) return { status: 'completed' }
    const input = inputSchema.parse(JSON.parse(row.input_json))
    const update = (status: Row['status'], code: string | null, result: string | null = null) => this.owner.database.driver.prepare(`UPDATE inpatient_drg_agent_analysis
      SET status=?,error_code=?,result_json=? WHERE workspace_id=? AND epoch=? AND analysis_id=?`).run(status, code, result, event.workspaceId, event.epoch, row.analysis_id)
    const assertCurrent = () => {
      if (options.signal.aborted) throw options.signal.reason
      const current = this.owner.followup.current(input.followupTaskId)
      if (current.context.workspaceId !== event.workspaceId || current.context.epoch !== event.epoch || current.task.version !== input.followupVersion)
        throw new InpatientError('INPATIENT_DRG_AGENT_STALE', '术中核对授权已变化')
      const fact = this.#facts(current.context, row.admission_id).find(fact => fact.execution.id === input.executionId)
      const deviation = fact?.deviations.find(item => item.use.id === input.deviation.use.id)
      if (!fact || !deviation || canonicalJsonHash(deviation.use) !== canonicalJsonHash(input.deviation.use)
        || fact.plan.reference !== input.plan.reference || canonicalJsonHash(fact.selection) !== canonicalJsonHash(input.selection))
        throw new InpatientError('INPATIENT_DRG_AGENT_STALE', '原登记、选型或确认计划已变化')
      return current.context
    }
    let waitUntil: 'runtime-restart' | undefined
    try {
      const context = assertCurrent()
      if (!options.provider || !options.model || options.provider.supportsUsageAccounting !== true) {
        waitUntil = 'runtime-restart'; throw new ModelUsageControlError('MODEL_METERING_UNAVAILABLE', 'workspace')
      }
      update('running', null)
      const model = await options.models.bind(event.workspaceId, row.task_id, options.model, options.signal)
      const usageContext = { workspaceId: event.workspaceId, epoch: event.epoch, taskId: row.task_id, actorId: context.actorId,
        ...(context.practitionerRoleId === undefined ? {} : { practitionerRoleId: context.practitionerRoleId }),
        caseId: row.admission_id, encounterId: row.admission_id, trigger: 'automatic' as const,
        sources: [{ kind: 'document' as const, id: `InpatientSurgeryMaterial/${input.deviation.use.id}`, relationship: 'trigger' as const },
          { kind: 'document' as const, id: input.plan.reference, relationship: 'evidence' as const }] }
      const { kind: _kind, followupTaskId: _taskId, followupVersion: _version, ...modelInput } = input
      const validate = (raw: unknown) => {
        const result = inpatientIntraoperativeGenerationSchema.parse(raw)
        if (/[¥￥]|[0-9零〇一二三四五六七八九十百千万亿]+\s*(?:元|分|万元)/.test(result.explanation))
          throw new InpatientError('INPATIENT_DRG_AGENT_INVALID', '临床核对说明不能另写金额；金额由费用说明引用确定性依据')
        assertInpatientCostExplanation(result.costExplanation, input.costs, [{ usedFen: input.deviation.use.amountFen, additionalFen: 0 }])
        return true
      }
      const generated = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_recommendation', jsonSchema: z.toJSONSchema(inpatientIntraoperativeGenerationSchema),
        systemPrompt: '你是术中耗材核对助手。只按 deviation 的本笔实际使用、登记原因、冻结 plan、已确认 selection 及合成兼容依据说明：是否与本次选型和测量相符，以及对后续计划余量的影响。未知保持待核实；不改变医生计划或必要用量，不修改诊断、术式、主操作，不自动建议换规格。explanation 不写任何金额。costExplanation 可为空，或只逐字引用 costs 和本笔 amountFen 的金额（分或换算为元）；不得计算新金额。costs.projectionComplete=false时只说明projectionMissing，不引用部分预计总额或预计余额。只解释，不提交正式业务。',
        userPayload: modelInput, usageContext: { ...usageContext, stage: 'intraoperative-generation' }, signal: options.signal,
        maxAttempts: 2, onBeforeRequest: () => { assertCurrent() }, validate })
      const result = inpatientIntraoperativeGenerationSchema.parse(JSON.parse(generated.content)); validate(result); assertCurrent()
      const verified = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_verification', jsonSchema: z.toJSONSchema(inpatientIntraoperativeVerificationSchema),
        systemPrompt: '独立核验 proposed 说明是否仅由本笔登记、原确认计划、已确认测量和给定合成兼容依据支持，是否解释后续余量而未改变计划；未知不能当作相符。金额只能引用给定 costs 和本笔 amountFen，不得计算或改变临床选择；projectionComplete=false时没有引用部分预计总额或预计余额。supported 为整体临床说明是否有据；costExplanationSupported 在未写费用说明时为null。',
        userPayload: { ...modelInput, proposed: result }, usageContext: { ...usageContext, stage: 'intraoperative-verification' }, signal: options.signal,
        maxAttempts: 2, onBeforeRequest: () => { assertCurrent() }, validate: raw => { inpatientIntraoperativeVerificationSchema.parse(raw); return true } })
      const checked = inpatientIntraoperativeVerificationSchema.parse(JSON.parse(verified.content))
      if (!checked.supported || result.costExplanation !== null && checked.costExplanationSupported !== true)
        throw new InpatientError('INPATIENT_DRG_AGENT_INVALID', '术中核对说明未通过独立核验')
      assertCurrent(); update('succeeded', null, JSON.stringify(result))
      return { status: 'completed' }
    } catch (error) {
      if (error instanceof InpatientError && ['INPATIENT_DRG_AGENT_STALE', 'INPATIENT_DRG_FOLLOWUP_INACTIVE', 'INPATIENT_SCOPE_FORBIDDEN', 'INPATIENT_RECORD_ARCHIVED', 'INPATIENT_ROLE_FORBIDDEN'].includes(error.code)) {
        update('stale', error.code); return { status: 'completed' }
      }
      const failure = modelUsageControlFailure(error), unknown = modelTaskOutcomeUnknown(error)
      update(unknown ? 'unknown' : failure ? 'blocked' : 'failed', unknown ? 'MODEL_OUTCOME_UNKNOWN' : failure?.code ?? 'INPATIENT_DRG_AGENT_FAILED')
      return options.recovery.defer(event, error, waitUntil) ?? { status: 'completed' }
    }
  }
}
