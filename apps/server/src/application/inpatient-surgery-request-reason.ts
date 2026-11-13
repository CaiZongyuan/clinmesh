import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientSurgeryRequestReasonInputSchema, inpatientSurgeryRequestReasonGenerationSchema, inpatientSurgeryRequestReasonSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientDiagnosisSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientAngiographyReportSchema } from '@clinmesh/contracts/inpatient-angiography'
import type { ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'
import type { GenerationModelBinding } from './generation-model-binding.ts'
import { type ModelTaskRecovery, modelTaskOutcomeUnknown } from './model-task-recovery.ts'
import type { JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'
import { ModelUsageControlError, modelUsageControlFailure } from './model-usage-control.ts'
import { WorkspaceContextError } from '../infrastructure/sqlite/workspace-repository.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const contextSchema = z.object({ workspaceId: z.string(), epoch: z.string(), scenarioRunId: z.string(), actorId: z.string(),
  practitionerId: z.string(), practitionerRoleId: z.string(), roleCode: z.literal('inpatient-doctor'), organizationId: z.string(), locationId: z.string() }).strict()
const inputSchema = z.object({ kind: z.literal('surgery-request-reason'), context: contextSchema, followupTaskId: z.string(),
  followupVersion: z.number().int().positive(), diagnosis: inpatientDiagnosisSchema, report: inpatientAngiographyReportSchema }).strict()

/** 申请理由仅保存模型草稿；正式手术申请仍由原 request Command 拥有。 */
export class InpatientSurgeryRequestReason {
  constructor(readonly owner: InpatientService,
    readonly contextStatus: (context: ActorContext, operations: readonly string[]) => 'active' | 'inactive' | 'superseded') {}

  #authorize(context: ActorContext, admissionId: string) {
    this.owner.assertRole(context, ['inpatient-doctor'])
    if (context.agentGrantId || this.contextStatus(context, ['inpatient.surgery.request']) !== 'active')
      throw new InpatientError('INPATIENT_REQUEST_REASON_FORBIDDEN', '申请理由起草仅限当前负责医生的登录会话', 403)
    this.owner.assertNotArchived(context, admissionId)
    this.owner.orders.assertAdmitted(context, admissionId)
  }
  #basis(context: ActorContext, admissionId: string) {
    this.#authorize(context, admissionId)
    const task = this.owner.followup.state(context, admissionId).task
    const diagnosis = this.owner.orders.diagnosis(context, admissionId)
    const report = this.owner.angiography.reports(context, admissionId).filter(report => report.status === 'final')
      .sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? '') || b.id.localeCompare(a.id))[0]
    if (task?.status !== 'active' || !report || diagnosis.entries.length === 0) return null
    const input = inputSchema.parse({ kind: 'surgery-request-reason', context, followupTaskId: task.id, followupVersion: task.version, diagnosis, report })
    return { input, fingerprint: canonicalJsonHash(input) }
  }
  #row(context: ActorContext, admissionId: string) {
    const row = z.object({ task_id: z.string() }).optional().parse(this.owner.database.driver.prepare(`SELECT task_id FROM inpatient_drg_agent_analysis
      WHERE workspace_id=? AND epoch=? AND admission_id=? AND json_extract(input_json,'$.kind')='surgery-request-reason'
      AND json_extract(input_json,'$.context.actorId')=? AND json_extract(input_json,'$.context.practitionerRoleId')=? ORDER BY rowid DESC LIMIT 1`)
      .get(context.workspaceId, context.epoch, admissionId, context.actorId, context.practitionerRoleId))
    return row ? this.owner.drgAgent.analyses(context.workspaceId, context.epoch, row.task_id)[0] : undefined
  }
  state(context: ActorContext, admissionId: string) {
    const basis = this.#basis(context, admissionId), row = this.#row(context, admissionId)
    const status = !basis ? 'unavailable' : !row ? 'idle' : row.status === 'unknown' ? 'unknown' : row.basis_fingerprint !== basis.fingerprint ? 'stale' : row.status
    return inpatientSurgeryRequestReasonSchema.parse({ admissionId, taskId: row?.task_id ?? null, fingerprint: basis?.fingerprint ?? null, status,
      reason: status === 'succeeded' && row?.result_json ? inpatientSurgeryRequestReasonGenerationSchema.parse(JSON.parse(row.result_json)).reason : null,
      failureCode: status === 'stale' ? 'INPATIENT_REQUEST_REASON_STALE' : row?.error_code ?? null })
  }
  read(context: ActorContext, admissionId: string) {
    const state = this.state(context, admissionId)
    this.owner.commands.auditRead(context, 'inpatient.surgery.request-reason.read', { admissionId }, 'success')
    return state
  }
  request(context: ActorContext, raw: unknown, key: string) {
    const input = inpatientSurgeryRequestReasonInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey: key, operation: 'inpatient.surgery.request-reason', expectedVersions: {},
      dataSchema: inpatientSurgeryRequestReasonSchema, authorize: () => this.#authorize(context, input.admissionId) }, transaction => {
      const state = this.state(context, input.admissionId), basis = this.#basis(context, input.admissionId)
      if (!basis || !['idle', 'stale'].includes(state.status)) return { data: state, effects: [] }
      const taskId = uuidv7(), analysisId = uuidv7()
      this.owner.database.driver.prepare(`INSERT INTO inpatient_drg_agent_analysis
        (workspace_id,epoch,analysis_id,task_id,admission_id,revision,task_version,basis_fingerprint,stage,status,input_json,created_at)
        VALUES(?,?,?,?,?,1,1,?,'preoperative','queued',?,?)`).run(context.workspaceId, context.epoch, analysisId, taskId, input.admissionId,
          basis.fingerprint, JSON.stringify(basis.input), this.owner.virtualTime(context))
      transaction.enqueue({ kind: 'inpatient.drg.agent.analyze', dedupKey: `${taskId}:1:${basis.fingerprint}`, payload: { taskId, analysisId } })
      return { data: this.state(context, input.admissionId), effects: [{ kind: 'created' as const, reference: `InpatientSurgeryRequestReason/${taskId}`, versionId: '1' }] }
    })
  }
  owns(workspaceId: string, epoch: string, taskId: string) {
    return this.owner.database.driver.prepare(`SELECT 1 FROM inpatient_drg_agent_analysis WHERE workspace_id=? AND epoch=? AND task_id=?
      AND json_extract(input_json,'$.kind')='surgery-request-reason'`).get(workspaceId, epoch, taskId) !== undefined
  }
  async process(event: OutboxHandlerInput, options: { models: GenerationModelBinding; recovery: ModelTaskRecovery;
    provider?: JsonChatCompletionsProvider; model?: string; signal: AbortSignal }): Promise<OutboxHandlerResult> {
    const payload = z.object({ taskId: z.string(), analysisId: z.string() }).strict().parse(event.payload)
    const row = this.owner.drgAgent.analyses(event.workspaceId, event.epoch, payload.taskId).find(item => item.analysis_id === payload.analysisId)
    if (!row || ['succeeded', 'unknown', 'stale'].includes(row.status)) return { status: 'completed' }
    const input = inputSchema.parse(JSON.parse(row.input_json))
    const update = (status: typeof row.status, code: string | null, result: string | null = null) => this.owner.database.driver.prepare(`UPDATE inpatient_drg_agent_analysis
      SET status=?,error_code=?,result_json=? WHERE workspace_id=? AND epoch=? AND analysis_id=?`)
      .run(status, code, result, event.workspaceId, event.epoch, row.analysis_id)
    const assertCurrent = () => {
      if (options.signal.aborted) throw options.signal.reason
      const basis = this.#basis(input.context, row.admission_id)
      const followup = this.owner.followup.current(input.followupTaskId)
      if (!basis || basis.fingerprint !== row.basis_fingerprint || followup.task.version !== input.followupVersion)
        throw new InpatientError('INPATIENT_REQUEST_REASON_STALE', '起草依据或助手授权已变化')
    }
    let waitUntil: 'runtime-restart' | undefined
    try {
      assertCurrent()
      if (!options.provider || !options.model || options.provider.supportsUsageAccounting !== true) {
        waitUntil = 'runtime-restart'; throw new ModelUsageControlError('MODEL_METERING_UNAVAILABLE', 'workspace')
      }
      update('running', null)
      const model = await options.models.bind(event.workspaceId, row.task_id, options.model, options.signal)
      const result = await options.provider.completeJson({ model, schemaName: 'inpatient_drg_recommendation', jsonSchema: z.toJSONSchema(inpatientSurgeryRequestReasonGenerationSchema),
        systemPrompt: '根据本次住院已确认 diagnosis 与最近一份正式冠脉造影 report 起草一段手术申请理由，reason 不超过2000字。只引用提供的诊断与报告事实，不推测报告未写的狭窄、适应证或患者信息，不改变诊断或治疗方向，不声明手术已完成。文字交由医生核对修改后提交；不要输出上下文、标识符或费用建议。',
        userPayload: { kind: input.kind, diagnosis: input.diagnosis, report: input.report },
        usageContext: { workspaceId: event.workspaceId, epoch: event.epoch, taskId: row.task_id, actorId: input.context.actorId,
          practitionerRoleId: input.context.practitionerRoleId, caseId: row.admission_id, encounterId: row.admission_id, stage: 'request-reason-generation', trigger: 'automatic',
          sources: [{ kind: 'job', id: event.eventId, relationship: 'trigger' }, { kind: 'document', id: `DiagnosticReport/${input.report.id}/version/${input.report.version}`, relationship: 'evidence' },
            ...input.diagnosis.entries.map(entry => ({ kind: 'document' as const, id: `Condition/${entry.conditionId}`, relationship: 'evidence' as const }))] },
        signal: options.signal, maxAttempts: 2, onBeforeRequest: assertCurrent })
      const generated = inpatientSurgeryRequestReasonGenerationSchema.parse(JSON.parse(result.content))
      this.owner.database.driver.transaction(() => { assertCurrent(); update('succeeded', null, JSON.stringify(generated)) })()
      return { status: 'completed' }
    } catch (error) {
      if (error instanceof InpatientError || error instanceof WorkspaceContextError) { update('stale', 'INPATIENT_REQUEST_REASON_STALE'); return { status: 'completed' } }
      const unknown = modelTaskOutcomeUnknown(error), failure = modelUsageControlFailure(error)
      update(unknown ? 'unknown' : failure ? 'blocked' : 'failed', unknown ? 'MODEL_OUTCOME_UNKNOWN' : failure?.code ?? 'INPATIENT_REQUEST_REASON_FAILED')
      return options.recovery.defer(event, error, waitUntil) ?? { status: 'completed' }
    }
  }
}
