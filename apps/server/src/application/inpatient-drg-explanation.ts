import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import {
  inpatientDrgExplanationSchema, inpatientDrgExplanationResultSchema, inpatientDrgExplainInputSchema,
  inpatientDrgExplanationGenerationSchema, inpatientDrgExplanationVerificationSchema,
} from '@clinmesh/contracts/inpatient-drg-explanation'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import type { ActorContext, CommandTransaction } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'
import type { GenerationModelBinding } from './generation-model-binding.ts'
import { type ModelTaskRecovery, modelTaskOutcomeUnknown } from './model-task-recovery.ts'
import type { JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'
import { ModelUsageControlError, modelUsageControlFailure } from './model-usage-control.ts'
import { WorkspaceContextError } from '../infrastructure/sqlite/workspace-repository.ts'

const contextSchema = z.object({ workspaceId: z.string(), epoch: z.string(), scenarioRunId: z.string(), actorId: z.string(),
  practitionerId: z.string(), practitionerRoleId: z.string(), roleCode: z.literal('inpatient-doctor'),
  organizationId: z.string(), locationId: z.string(), agentGrantId: z.string().optional() }).strict()
  .transform(({ agentGrantId, ...context }) => ({ ...context, ...(agentGrantId === undefined ? {} : { agentGrantId }) }))
const rowSchema = z.object({ workspace_id: z.string(), epoch: z.string(), task_id: z.string(), admission_id: z.string(),
  version: z.number().int().positive(), context_json: z.string(), basis_fingerprint: z.string() })
const inputSchema = z.object({ recordChecks: inpatientDrgRecordChecksSchema.omit({ simulation: true }) }).strict()
type Row = z.infer<typeof rowSchema>

/** 按需解释只拥有单次意图；分析、计量和未知结果恢复继续由住院执行器和通用模型边界负责。 */
export class InpatientDrgExplanation {
  constructor(readonly owner: InpatientService,
    readonly contextStatus: (context: ActorContext, operations: readonly string[]) => 'active' | 'inactive' | 'superseded') {}

  #row(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, admissionId: string) {
    return rowSchema.optional().parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_drg_explanation
      WHERE workspace_id=? AND epoch=? AND admission_id=?`).get(context.workspaceId, context.epoch, admissionId))
  }
  owns(workspaceId: string, epoch: string, taskId: string) {
    return this.owner.database.driver.prepare('SELECT 1 FROM inpatient_drg_explanation WHERE workspace_id=? AND epoch=? AND task_id=?')
      .get(workspaceId, epoch, taskId) !== undefined
  }
  #authorize(context: ActorContext, admissionId: string) {
    this.owner.assertRole(context, ['inpatient-doctor'])
    this.owner.admissionBinding(context, admissionId)
    this.owner.assertNotArchived(context, admissionId)
    if (this.contextStatus(context, ['inpatient.drg.record-checks.explain']) !== 'active')
      throw new InpatientError('INPATIENT_DRG_EXPLANATION_STALE', '原解释岗位授权已失效，请由当前主管医生重新展开解释', 403)
  }
  #current(row: Row) {
    const context = contextSchema.parse(JSON.parse(row.context_json))
    try { this.#authorize(context, row.admission_id) }
    catch (error) {
      if (error instanceof WorkspaceContextError) throw new InpatientError('INPATIENT_DRG_EXPLANATION_STALE', '原解释所属 Workspace/Epoch 已失效')
      throw error
    }
    const recordChecks = this.owner.drgReview.recordChecks(context, row.admission_id)
    if (recordChecks.fingerprint !== row.basis_fingerprint || recordChecks.status === 'frozen')
      throw new InpatientError('INPATIENT_DRG_EXPLANATION_STALE', '分组核对依据已变化，原解释不能继续应用')
    return { context, recordChecks }
  }
  state(context: ActorContext, admissionId: string) {
    const checks = this.owner.drgReview.recordChecks(context, admissionId), row = this.#row(context, admissionId)
    const analysis = row ? this.owner.drgAgent.analyses(context.workspaceId, context.epoch, row.task_id)
      .find(item => item.task_version === row.version) : undefined
    let authorized = true
    if (row) try { this.#current(row) } catch (error) { if (error instanceof InpatientError) authorized = false; else throw error }
    const current = authorized && row?.basis_fingerprint === checks.fingerprint && analysis?.basis_fingerprint === checks.fingerprint
    const status = checks.status === 'frozen' ? 'frozen' : analysis?.status === 'unknown' ? 'unknown'
      : !row ? 'idle' : !current ? 'stale' : analysis?.status ?? 'queued'
    return inpatientDrgExplanationSchema.parse({ admissionId, taskId: row?.task_id ?? null, version: row?.version ?? 0,
      fingerprint: checks.fingerprint, status, failureCode: status === 'stale' ? 'INPATIENT_DRG_EXPLANATION_STALE' : analysis?.error_code ?? null,
      result: current && analysis?.status === 'succeeded' && analysis.result_json
        ? inpatientDrgExplanationResultSchema.parse(JSON.parse(analysis.result_json)) : null })
  }
  read(context: ActorContext, admissionId: string) {
    try {
      const result = this.state(context, admissionId)
      this.owner.commands.auditRead(context, 'inpatient.drg.record-checks.explanation.read', { admissionId }, 'success')
      return result
    } catch (error) {
      try { this.owner.commands.auditRead(context, 'inpatient.drg.record-checks.explanation.read', { admissionId }, 'failed') } catch { /* Preserve the original error. */ }
      throw error
    }
  }
  request(context: ActorContext, raw: unknown, key: string) {
    const input = inpatientDrgExplainInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey: key, operation: 'inpatient.drg.record-checks.explain',
      expectedVersions: {}, dataSchema: inpatientDrgExplanationSchema,
      authorize: () => this.#authorize(context, input.admissionId) }, transaction => {
      const state = this.state(context, input.admissionId), checks = this.owner.drgReview.recordChecks(context, input.admissionId)
      if (state.version !== input.expectedVersion || checks.fingerprint !== input.expectedFingerprint)
        throw new InpatientError('INPATIENT_DRG_EXPLANATION_CONFLICT', '核对依据或解释版本已变化，请刷新核实')
      const row = this.#row(context, input.admissionId)
      const unresolved = row && this.owner.database.driver.prepare(`SELECT 1 FROM model_task_step WHERE workspace_id=? AND epoch=? AND task_id=?
        AND status IN ('unknown','dispatching') LIMIT 1`).get(context.workspaceId, context.epoch, row.task_id)
      if (unresolved || state.status === 'unknown')
        throw new InpatientError('MODEL_OUTCOME_UNKNOWN', '原解释请求结果未知，请先核查原尝试；不会重新派发')
      if (['succeeded', 'queued', 'running', 'blocked'].includes(state.status)) return { data: state, effects: [] }
      const taskId = row?.task_id ?? uuidv7(), version = state.version + 1
      this.owner.database.driver.prepare(`INSERT INTO inpatient_drg_explanation
        (workspace_id,epoch,task_id,admission_id,version,context_json,basis_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,epoch,admission_id) DO UPDATE SET version=excluded.version,context_json=excluded.context_json,basis_fingerprint=excluded.basis_fingerprint`)
        .run(context.workspaceId, context.epoch, taskId, input.admissionId, version, JSON.stringify(contextSchema.parse(context)), checks.fingerprint, this.owner.virtualTime(context))
      this.#enqueue(context, taskId, input.admissionId, version, checks, transaction)
      return { data: this.state(context, input.admissionId), effects: [{ kind: 'updated' as const,
        reference: `InpatientDrgExplanation/${taskId}`, versionId: String(version) }] }
    })
  }
  #enqueue(context: ActorContext, taskId: string, admissionId: string, version: number,
    checks: z.infer<typeof inpatientDrgRecordChecksSchema>, transaction: CommandTransaction) {
    const analyses = this.owner.drgAgent.analyses(context.workspaceId, context.epoch, taskId), analysisId = uuidv7()
    const { simulation: _simulation, ...recordChecks } = checks
    const previous = analyses.find(item => item.basis_fingerprint === checks.fingerprint)
    this.owner.database.driver.prepare(`INSERT INTO inpatient_drg_agent_analysis
      (workspace_id,epoch,analysis_id,task_id,admission_id,revision,task_version,basis_fingerprint,stage,status,input_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,'postoperative','queued',?,?)`).run(context.workspaceId, context.epoch, analysisId, taskId, admissionId,
        (analyses[0]?.revision ?? 0) + 1, version, checks.fingerprint,
        previous?.input_json ?? JSON.stringify(inputSchema.parse({ recordChecks })), this.owner.virtualTime(context))
    transaction.enqueue({ kind: 'inpatient.drg.agent.analyze', dedupKey: `${taskId}:${version}:${checks.fingerprint}`, payload: { taskId, analysisId } })
  }
  async process(event: OutboxHandlerInput, options: { models: GenerationModelBinding; recovery: ModelTaskRecovery;
    provider?: JsonChatCompletionsProvider; model?: string; signal: AbortSignal }): Promise<OutboxHandlerResult> {
    const payload = z.object({ taskId: z.string(), analysisId: z.string() }).strict().parse(event.payload)
    const row = rowSchema.optional().parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_drg_explanation WHERE workspace_id=? AND epoch=? AND task_id=?')
      .get(event.workspaceId, event.epoch, payload.taskId))
    const analysis = this.owner.drgAgent.analyses(event.workspaceId, event.epoch, payload.taskId).find(item => item.analysis_id === payload.analysisId)
    if (!row || !analysis || ['succeeded', 'unknown', 'stale'].includes(analysis.status)) return { status: 'completed' }
    const update = (status: typeof analysis.status, code: string | null, result: string | null = null) => this.owner.database.driver.prepare(`UPDATE inpatient_drg_agent_analysis
      SET status=?,error_code=?,result_json=? WHERE workspace_id=? AND epoch=? AND analysis_id=? AND task_version=?`)
      .run(status, code, result, event.workspaceId, event.epoch, analysis.analysis_id, analysis.task_version)
    const assertCurrent = () => {
      if (options.signal.aborted) throw options.signal.reason
      const latest = this.#row({ workspaceId: event.workspaceId, epoch: event.epoch }, row.admission_id)
      if (!latest || latest.version !== analysis.task_version || latest.basis_fingerprint !== analysis.basis_fingerprint)
        throw new InpatientError('INPATIENT_DRG_EXPLANATION_STALE', '解释意图或依据已变化')
      return this.#current(latest)
    }
    let waitUntil: 'runtime-restart' | undefined
    try {
      const { context } = assertCurrent()
      if (!options.provider || !options.model || options.provider.supportsUsageAccounting !== true) {
        waitUntil = 'runtime-restart'
        throw new ModelUsageControlError('MODEL_METERING_UNAVAILABLE', 'workspace')
      }
      update('running', null)
      const input = inputSchema.parse(JSON.parse(analysis.input_json)), issues = input.recordChecks.issues
      const model = await options.models.bind(event.workspaceId, row.task_id, options.model, options.signal)
      const usageContext = { workspaceId: event.workspaceId, epoch: event.epoch, taskId: row.task_id, actorId: context.actorId,
        practitionerRoleId: context.practitionerRoleId!, caseId: row.admission_id, encounterId: row.admission_id, trigger: 'manual' as const,
        sources: [{ kind: 'job' as const, id: event.eventId, relationship: 'trigger' as const },
          ...input.recordChecks.sources.slice(0, 255).map(source => ({ kind: 'document' as const, id: source.reference, relationship: 'evidence' as const }))] }
      const normalize = (raw: unknown) => {
        const result = inpatientDrgExplanationGenerationSchema.parse(raw)
        if (result.observations.length !== issues.length || result.observations.some(item => {
          const issue = issues.find(issue => issue.key === item.key)
          return !issue || item.evidenceIds.length !== issue.evidence.length || new Set(item.evidenceIds).size !== issue.evidence.length
            || item.evidenceIds.some(reference => !issue.evidence.includes(reference))
        })) throw new InpatientError('INPATIENT_DRG_EXPLANATION_INVALID', '解释未完整引用原核对项目及来源')
        return result
      }
      const generated = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_recommendation',
        jsonSchema: z.toJSONSchema(inpatientDrgExplanationGenerationSchema),
        systemPrompt: '只解释 recordChecks 中的确定性分组记录核对，逐项保留 issues.key 并完整引用其 evidence。实际操作、首页主操作、计划推演各有原依据，差异须回原记录核实；不直接判错或代选主操作。分组与金额缺参分别说明，不推断未提供的诊断、病组目标或患者事实，不改变诊断、报告已阅、费用、首页或分组。无差异时 observations 为空。',
        userPayload: input, usageContext: { ...usageContext, stage: 'record-check-generation' }, signal: options.signal,
        maxAttempts: 2, onBeforeRequest: assertCurrent, validate: raw => { normalize(raw); return true } })
      const result = normalize(JSON.parse(generated.content))
      assertCurrent()
      const verified = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_verification',
        jsonSchema: z.toJSONSchema(inpatientDrgExplanationVerificationSchema),
        systemPrompt: '独立核验 proposed.observations 的每一项是否受 recordChecks 的同 key 问题及原来源支持。不得增加事实、代判主操作或把模型说明视为业务更正。逐项返回原 key、supported 和理由，资料未知不能视为支持。',
        userPayload: { ...input, proposed: result }, usageContext: { ...usageContext, stage: 'record-check-verification' }, signal: options.signal,
        maxAttempts: 2, onBeforeRequest: assertCurrent, validate: raw => {
          const checked = inpatientDrgExplanationVerificationSchema.parse(raw)
          return checked.observations.length === issues.length && issues.every(issue => checked.observations.some(item => item.key === issue.key))
        } })
      if (inpatientDrgExplanationVerificationSchema.parse(JSON.parse(verified.content)).observations.some(item => !item.supported))
        throw new InpatientError('INPATIENT_DRG_EXPLANATION_INVALID', '解释未通过独立来源核验')
      this.owner.database.driver.transaction(() => {
        assertCurrent()
        update('succeeded', null, JSON.stringify(inpatientDrgExplanationResultSchema.parse({ id: analysis.analysis_id,
          fingerprint: analysis.basis_fingerprint, model, createdAt: analysis.created_at, observations: result.observations })))
      })()
      return { status: 'completed' }
    } catch (error) {
      if (error instanceof InpatientError || error instanceof WorkspaceContextError) {
        if (!(error instanceof InpatientError) || error.code !== 'INPATIENT_DRG_EXPLANATION_INVALID') {
          update('stale', 'INPATIENT_DRG_EXPLANATION_STALE'); return { status: 'completed' }
        }
      }
      const unknown = modelTaskOutcomeUnknown(error), failure = modelUsageControlFailure(error)
      update(unknown ? 'unknown' : failure ? 'blocked' : 'failed', unknown ? 'MODEL_OUTCOME_UNKNOWN' : failure?.code ?? 'INPATIENT_DRG_EXPLANATION_FAILED')
      return options.recovery.defer(event, error, waitUntil) ?? { status: 'completed' }
    }
  }
}
