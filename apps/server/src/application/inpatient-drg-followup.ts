import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientDrgFollowupSchema, inpatientDrgFollowupTaskSchema, inpatientDrgFollowupStartInputSchema,
  inpatientDrgFollowupStopInputSchema, type InpatientDrgFollowupTask } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientDrgSimulationSchema, type InpatientDrgSimulation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { CommandTransaction, type ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { OutboxHandlerInput } from './outbox-dispatcher.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const actorSchema = z.object({ workspaceId: z.string(), epoch: z.string(), scenarioRunId: z.string(), actorId: z.string(),
  practitionerId: z.string(), practitionerRoleId: z.string(), roleCode: z.string(),
  organizationId: z.string(), locationId: z.string(), agentGrantId: z.string().optional() }).strict()
  .transform(({ agentGrantId, ...context }) => ({ ...context, ...(agentGrantId === undefined ? {} : { agentGrantId }) }))
const rowSchema = z.object({ workspace_id: z.string(), epoch: z.string(), task_id: z.string(), admission_id: z.string(),
  context_json: z.string(), status: inpatientDrgFollowupTaskSchema.shape.status, version: z.number().int().positive(),
  started_at: z.string(), updated_at: z.string(), reason: z.string().nullable(), rule_status: inpatientDrgFollowupTaskSchema.shape.ruleStatus,
  target_fingerprint: z.string().nullable(), result_json: z.string().nullable(), error_code: z.string().nullable() })
type Row = z.infer<typeof rowSchema>
const eventSchema = z.object({ taskId: z.string(), fingerprint: z.string(), version: z.number().int().positive() }).strict()

/** 病例跟进拥有授权与规则结果；病历、收费、分组和模型用量保留各自 owner。 */
export class InpatientDrgFollowup {
  readonly #unsubscribe: () => void
  constructor(readonly owner: InpatientService,
    readonly contextStatus: (context: ActorContext) => 'active' | 'inactive' | 'superseded') {
    this.#unsubscribe = owner.commands.subscribe((context, effects) => {
      if (effects.length > 0) this.refreshPending(context.workspaceId, context.epoch)
    })
  }
  close() { this.#unsubscribe() }

  #row(workspaceId: string, epoch: string, admissionId: string): Row | undefined {
    return rowSchema.optional().parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_drg_followup WHERE workspace_id=? AND epoch=? AND admission_id=?').get(workspaceId, epoch, admissionId))
  }
  #dto(row: Row): InpatientDrgFollowupTask {
    const simulation = row.result_json === null ? null : inpatientDrgSimulationSchema.parse(JSON.parse(row.result_json))
    const reference = simulation?.paymentReference
    const current = row.status === 'active' && (row.rule_status === 'complete' || row.rule_status === 'incomplete')
    const exceptionAlert = !current || !reference || reference.referenceFen <= 0 ? 'unknown'
      : BigInt(simulation!.formal.chargesFen) > 3n * BigInt(reference.referenceFen) ? 'triggered' : 'below-threshold'
    return inpatientDrgFollowupTaskSchema.parse({ id: row.task_id, admissionId: row.admission_id,
      status: row.status, version: row.version, startedAt: row.started_at, updatedAt: row.updated_at,
      reason: row.reason, ruleStatus: row.rule_status, fingerprint: row.target_fingerprint,
      simulation, errorCode: row.error_code, exceptionAlert, modelRequests: 0 })
  }
  #finish(row: Row, status: 'authorization-lost' | 'archived', reason: string) {
    this.owner.database.driver.prepare(`UPDATE inpatient_drg_followup SET status=?,reason=?,version=version+1,
      rule_status=CASE WHEN ?='authorization-lost' THEN 'stale' ELSE rule_status END,updated_at=?
      WHERE workspace_id=? AND epoch=? AND task_id=? AND status='active'`)
      .run(status, reason, status, new Date().toISOString(), row.workspace_id, row.epoch, row.task_id)
  }
  #binding(row: Row): ActorContext | undefined {
    if (row.status !== 'active') return undefined
    const context = actorSchema.parse(JSON.parse(row.context_json))
    const admission = z.object({ record_status: z.string() }).optional().parse(this.owner.database.driver.prepare(
      'SELECT record_status FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND admission_id=?')
      .get(row.workspace_id, row.epoch, row.admission_id))
    if (admission?.record_status === 'archived') {
      this.#finish(row, 'archived', '病案已归档，停止新的临床分析；结果与待办保留供交接。')
      return undefined
    }
    if (this.contextStatus(context) !== 'active') {
      this.#finish(row, 'authorization-lost', '启动跟进的病例岗位授权已失效，停止新分析并保留待交接结果。')
      return undefined
    }
    try {
      this.owner.admissionBinding(context, row.admission_id)
    } catch (error) {
      if (!(error instanceof InpatientError)) throw error
      this.#finish(row, 'authorization-lost', '病例责任或所属病区已变化，停止原任务的新分析并保留待交接结果。')
      return undefined
    }
    return context
  }
  #evaluate(context: ActorContext, admissionId: string) {
    let simulation: InpatientDrgSimulation | null = null, errorCode: string | null = null
    try {
      simulation = this.owner.drg.simulate(context, admissionId, undefined)
      if (simulation.grouping.formal.status !== 'grouped') errorCode = 'DRG_GROUPING_INCOMPLETE'
      else if (!simulation.paymentReference || simulation.paymentReference.referenceFen <= 0) errorCode = 'DRG_PAYMENT_REFERENCE_MISSING'
    } catch (error) {
      if (!(error instanceof InpatientError)) throw error
      errorCode = error.code
    }
    const fingerprint = simulation?.fingerprint ?? canonicalJsonHash({ admissionId, errorCode,
      encounterVersion: this.owner.fhir.read(context, 'Encounter', admissionId).meta!.versionId })
    return { simulation, errorCode, fingerprint }
  }

  /** T3 在每次派发与发布前调用；失权、停止或归档不会返回可继续分析的绑定。 */
  current(taskId: string) {
    const row = rowSchema.optional().parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_drg_followup WHERE task_id=?').get(taskId))
    if (row === undefined) throw new InpatientError('INPATIENT_DRG_FOLLOWUP_NOT_FOUND', '未找到住院跟进任务', 404)
    const context = this.#binding(row)
    if (context === undefined) throw new InpatientError('INPATIENT_DRG_FOLLOWUP_INACTIVE', '跟进已停止、失权或归档，不能发起分析')
    const evaluation = this.#evaluate(context, row.admission_id)
    return { task: this.#dto(row), context, ...evaluation }
  }

  #snapshot(context: ActorContext, admissionId: string) {
    const row = this.#row(context.workspaceId, context.epoch, admissionId)
    return inpatientDrgFollowupSchema.parse({ admissionId,
      encounterVersion: this.owner.fhir.read(context, 'Encounter', admissionId).meta!.versionId,
      task: row ? this.#dto(row) : null })
  }
  read(context: ActorContext, admissionId: string) {
    try {
      this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
      this.owner.readAdmissionBinding(context, admissionId)
      this.refreshPending(context.workspaceId, context.epoch)
      const result = this.#snapshot(context, admissionId)
      this.owner.commands.auditRead(context, 'inpatient.drg.followup.read', { admissionId }, 'success')
      return result
    } catch (error) {
      try { this.owner.commands.auditRead(context, 'inpatient.drg.followup.read', { admissionId }, 'failed') } catch { /* Preserve the original rejection. */ }
      throw error
    }
  }
  start(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientDrgFollowupStartInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.drg.followup.start',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientDrgFollowupSchema,
      authorize: () => this.owner.assertRole(context, ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      if (this.contextStatus(context) !== 'active') throw new InpatientError('INPATIENT_DRG_FOLLOWUP_FORBIDDEN', '当前岗位授权不能开启病例跟进', 403)
      const existing = this.#row(context.workspaceId, context.epoch, input.admissionId)
      if (existing?.status === 'active') return { data: this.#snapshot(context, input.admissionId), effects: [] }
      if (input.expectedTaskVersion !== (existing?.version ?? 0)) throw new InpatientError('INPATIENT_DRG_FOLLOWUP_CONFLICT', '跟进版本已变化，请刷新后重试')
      const id = existing?.task_id ?? uuidv7(), now = new Date().toISOString()
      this.owner.database.driver.prepare(`INSERT INTO inpatient_drg_followup
        (workspace_id,epoch,task_id,admission_id,context_json,status,version,started_at,updated_at)
        VALUES(?,?,?,?,?,'active',1,?,?) ON CONFLICT(workspace_id,epoch,admission_id) DO UPDATE SET
        context_json=excluded.context_json,status='active',version=version+1,updated_at=excluded.updated_at,
        reason=NULL,rule_status='pending',target_fingerprint=NULL,error_code=NULL`)
        .run(context.workspaceId, context.epoch, id, input.admissionId, JSON.stringify(actorSchema.parse(context)), now, now)
      const row = this.#row(context.workspaceId, context.epoch, input.admissionId)!
      return { data: this.#snapshot(context, input.admissionId), effects: [{ kind: existing ? 'updated' as const : 'created' as const,
        reference: `InpatientDrgFollowup/${id}`, versionId: String(row.version) }] }
    })
  }
  stop(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientDrgFollowupStopInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.drg.followup.stop',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientDrgFollowupSchema,
      authorize: () => this.owner.assertRole(context, ['inpatient-doctor']) }, () => {
      this.owner.admissionBinding(context, input.admissionId)
      const row = this.#row(context.workspaceId, context.epoch, input.admissionId)
      if (!row) throw new InpatientError('INPATIENT_DRG_FOLLOWUP_NOT_FOUND', '未找到住院跟进任务', 404)
      if (row.version !== input.expectedTaskVersion) throw new InpatientError('INPATIENT_DRG_FOLLOWUP_CONFLICT', '跟进版本已变化，请刷新后重试')
      if (row.status !== 'active') throw new InpatientError('INPATIENT_DRG_FOLLOWUP_INACTIVE', '跟进已停止、失权或归档')
      this.owner.database.driver.prepare(`UPDATE inpatient_drg_followup SET status='stopped',reason=?,version=version+1,updated_at=?
        WHERE workspace_id=? AND epoch=? AND task_id=?`).run(input.reason, new Date().toISOString(), context.workspaceId, context.epoch, row.task_id)
      return { data: this.#snapshot(context, input.admissionId), effects: [{ kind: 'updated' as const,
        reference: `InpatientDrgFollowup/${row.task_id}`, versionId: String(row.version + 1) }] }
    })
  }

  /** 现有 pump 与公开读取恢复丢失通知；不依赖页面存在，也不新建调度器。 */
  refreshPending(workspaceId?: string, epoch?: string) {
    const rows = z.array(rowSchema).parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_drg_followup WHERE status='active'
      ${workspaceId === undefined ? '' : 'AND workspace_id=? AND epoch=?'}`).all(...(workspaceId === undefined ? [] : [workspaceId, epoch ?? ''])))
    for (const row of rows) {
      const context = this.#binding(row)
      if (!context) continue
      const evaluation = this.#evaluate(context, row.admission_id)
      if (row.target_fingerprint === evaluation.fingerprint) continue
      this.owner.database.driver.transaction(() => {
        this.owner.database.driver.prepare(`UPDATE inpatient_drg_followup SET target_fingerprint=?,rule_status=?,updated_at=?
          WHERE workspace_id=? AND epoch=? AND task_id=? AND status='active'`)
          .run(evaluation.fingerprint, row.result_json === null ? 'pending' : 'stale', new Date().toISOString(), row.workspace_id, row.epoch, row.task_id)
        new CommandTransaction(this.owner.database, this.owner.fhir, context, () => new Date()).enqueue({
          kind: 'inpatient.drg.followup', dedupKey: `${row.task_id}:${row.version}:${evaluation.fingerprint}`,
          payload: { taskId: row.task_id, fingerprint: evaluation.fingerprint, version: row.version } })
      })()
    }
  }
  async process(event: OutboxHandlerInput) {
    return this.owner.database.driver.transaction(() => {
      const input = eventSchema.parse(event.payload)
      const row = rowSchema.optional().parse(this.owner.database.driver.prepare(
        'SELECT * FROM inpatient_drg_followup WHERE workspace_id=? AND epoch=? AND task_id=?').get(event.workspaceId, event.epoch, input.taskId))
      if (!row || row.status !== 'active' || row.version !== input.version || row.target_fingerprint !== input.fingerprint) return { status: 'completed' as const }
      const context = this.#binding(row)
      if (!context) return { status: 'completed' as const }
      const evaluation = this.#evaluate(context, row.admission_id)
      if (evaluation.fingerprint !== input.fingerprint) { this.refreshPending(row.workspace_id, row.epoch); return { status: 'completed' as const } }
      this.owner.database.driver.prepare(`UPDATE inpatient_drg_followup SET result_json=?,error_code=?,rule_status=?,updated_at=?
        WHERE workspace_id=? AND epoch=? AND task_id=? AND version=? AND status='active' AND target_fingerprint=?`)
        .run(evaluation.simulation === null ? null : JSON.stringify(evaluation.simulation), evaluation.errorCode,
          evaluation.errorCode === null ? 'complete' : 'incomplete', new Date().toISOString(), row.workspace_id, row.epoch,
          row.task_id, input.version, input.fingerprint)
      return { status: 'completed' as const }
    })()
  }
}
