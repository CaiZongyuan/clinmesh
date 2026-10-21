import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import {
  modelUsageAttemptSchema, modelUsageContextSchema, modelUsageFeatureSchema,
  modelUsageOutcomeSchema, modelUsageOverviewSchema, modelUsageListSchema, modelTokenUsageSchema, modelUsageConfigurationSchema,
  hostDoctorRecognitionTimeoutMs, mergeModelTokenUsage, unknownModelTokenUsage,
  type ModelTokenUsage, type ModelUsageAttempt, type ModelUsageConfiguration, type ModelUsageFilter, type ModelUsageOutcome,
  type ModelUsagePolicyConfig, type ModelUsageControlUpdate,
} from '@clinmesh/contracts/model-usage'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { ModelUsageRecorder } from './model-usage-lifecycle.ts'
import { ModelUsageControl, ModelUsageControlError } from './model-usage-control.ts'

const rowSchema = z.object({ record_json: z.string() })
const summaryRowSchema = z.object({
  requests: z.number(), inFlight: z.number(), unknownRequests: z.number(),
  knownTokens: z.number(), unknownTokenRequests: z.number(),
})
const knownTokensSql = `COALESCE(json_extract(record_json, '$.usage.totalTokens'),
  COALESCE(json_extract(record_json, '$.usage.inputTokens'),
    CASE WHEN json_extract(record_json, '$.usage.raw.format') = 'dsh' THEN
      COALESCE(json_extract(record_json, '$.usage.raw.uncachedInputTokens'), 0)
      + COALESCE(json_extract(record_json, '$.usage.raw.cacheReadTokens'), 0)
      + COALESCE(json_extract(record_json, '$.usage.raw.cacheWriteTokens'), 0)
    ELSE json_extract(record_json, '$.usage.cachedInputTokens') END, 0)
  + COALESCE(json_extract(record_json, '$.usage.outputTokens'), json_extract(record_json, '$.usage.reasoningOutputTokens'), 0))`
const actualRequestSql = `COALESCE(json_extract(record_json, '$.dispatch'), 'unknown') != 'not-dispatched'`
const totalsSql = `COALESCE(SUM(${actualRequestSql}), 0) AS requests,
  COALESCE(SUM(status = 'in-flight'), 0) AS inFlight,
  COALESCE(SUM(status = 'unknown'), 0) AS unknownRequests,
  COALESCE(SUM(${knownTokensSql}), 0) AS knownTokens,
  COALESCE(SUM((${actualRequestSql}) AND json_extract(record_json, '$.usage.totalTokens') IS NULL), 0) AS unknownTokenRequests`

/** One writer owns attempts, task admission and settlement. Queries never expose clinical content. */
export class ModelUsageService implements ModelUsageRecorder {
  readonly #control: ModelUsageControl
  constructor(private readonly database: ClinMeshDatabase, commands: CommandExecutor, deployment?: ModelUsagePolicyConfig) {
    this.#control = new ModelUsageControl(database, commands, deployment)
    // A previous writer cannot prove whether its in-flight requests reached the Provider.
    this.database.driver.prepare(`UPDATE model_usage_attempt SET status = 'unknown',
      record_json = json_set(record_json, '$.status', 'unknown', '$.endedAt', ?)
      WHERE status = 'in-flight'`).run(new Date().toISOString())
  }

  control(workspaceId: string) { return this.#control.read(workspaceId) }
  controlFor(context: ActorContext) {
    const state = this.control(context.workspaceId)
    return { ...state, deployment: context.roleCode === 'administrator' ? state.deployment : null }
  }
  updateControl(context: ActorContext, input: ModelUsageControlUpdate, key: string) { return this.#control.update(context, input, key) }
  canDispatch(workspaceId: string) { return this.#control.canDispatch(workspaceId) }
  automaticRetries(workspaceId: string) { return this.#control.automaticRetries(workspaceId) }
  subscribe(listener: () => void) { return this.#control.subscribe(listener) }
  setWaitingCount(read: (workspaceId: string) => number) { this.#control.setWaitingCount(read) }
  run<T>(workspaceId: string, signal: AbortSignal | undefined, invoke: (signal: AbortSignal) => Promise<T>) {
    return this.#control.run(workspaceId, signal, invoke)
  }

  begin(input: Parameters<ModelUsageRecorder['begin']>[0], reserve?: () => void): string {
    const context = modelUsageContextSchema.parse(input.context)
    const record = modelUsageAttemptSchema.parse({
      id: uuidv7(), context, feature: modelUsageFeatureSchema.parse(input.feature),
      provider: input.provider, requestedModel: input.model, actualModel: null,
      reasoningEffort: input.reasoningEffort ?? null, outputLimit: input.outputLimit,
      kind: input.kind, status: 'in-flight', startedAt: new Date().toISOString(), endedAt: null,
      providerRequestId: null, httpStatus: null, usage: unknownModelTokenUsage,
      cost: { status: 'price-not-configured', cny: null },
    })
    try { return this.database.driver.transaction(() => {
      this.database.driver.prepare(`INSERT INTO model_usage_attempt
        (attempt_id, workspace_id, epoch, case_id, feature, provider, requested_model, actual_model, status, started_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'in-flight', ?, ?)`)
        .run(record.id, context.workspaceId, context.epoch, context.caseId ?? null, record.feature,
          record.provider, record.requestedModel, record.startedAt, JSON.stringify(record))
      this.#control.reserve(context.workspaceId, record.id, record.kind)
      reserve?.()
      return record.id
    })() } catch (cause) {
      const sqlite = z.object({ code: z.string().startsWith('SQLITE_') }).safeParse(cause)
      const error = sqlite.success ? new ModelUsageControlError('MODEL_LEDGER_UNAVAILABLE', 'workspace') : cause
      if (error instanceof ModelUsageControlError) this.#control.reject(context.workspaceId, error)
      throw error
    }
  }

  checkpoint(attemptId: string, usage: ModelTokenUsage, configuration?: ModelUsageConfiguration): void {
    this.#update(attemptId, { dispatch: 'dispatched', usage: modelTokenUsageSchema.parse(usage),
      ...(configuration === undefined ? {} : modelUsageConfigurationSchema.parse(configuration)) })
  }

  settle(attemptId: string, input: ModelUsageOutcome): void {
    this.#update(attemptId, modelUsageOutcomeSchema.parse(input))
  }

  #update(attemptId: string, outcome: Pick<ModelUsageOutcome, 'usage'> & Partial<ModelUsageOutcome>): void {
    this.database.driver.transaction(() => {
      const row = rowSchema.parse(this.database.driver.prepare('SELECT record_json FROM model_usage_attempt WHERE attempt_id = ?').get(attemptId))
      const previous = modelUsageAttemptSchema.parse(JSON.parse(row.record_json))
      // A completed attempt is immutable; duplicate transport delivery is harmless.
      if (previous.status !== 'in-flight' && previous.status !== 'unknown') return
      const usage = mergeModelTokenUsage(previous.usage, outcome.usage)
      const record = modelUsageAttemptSchema.parse({ ...previous, ...outcome, usage,
        dispatch: previous.dispatch === 'dispatched' ? 'dispatched' : outcome.dispatch ?? previous.dispatch,
        actualModel: outcome.actualModel ?? previous.actualModel,
        providerRequestId: outcome.providerRequestId ?? previous.providerRequestId,
        httpStatus: outcome.httpStatus ?? previous.httpStatus,
        endedAt: outcome.status === undefined ? previous.endedAt : new Date().toISOString(),
      })
      this.database.driver.prepare(`UPDATE model_usage_attempt SET actual_model = ?, status = ?, record_json = ? WHERE attempt_id = ?`)
        .run(record.actualModel, record.status, JSON.stringify(record), attemptId)
      this.#control.settle(attemptId, record.dispatch)
    })()
  }

  overview(context: ActorContext, filter: ModelUsageFilter) {
    this.#expireHostAttempts()
    const query = this.#where(context, filter, false)
    const totals = summaryRowSchema.parse(this.database.driver.prepare(`SELECT ${totalsSql} FROM model_usage_attempt a WHERE ${query.sql}`).get(...query.args))
    const trend = z.array(z.object({ date: z.string(), requests: z.number(), knownTokens: z.number() })).parse(this.database.driver.prepare(`
      SELECT date(started_at, '+8 hours') AS date, SUM(${actualRequestSql}) AS requests,
      COALESCE(SUM(${knownTokensSql}), 0) AS knownTokens
      FROM model_usage_attempt a WHERE ${query.sql} GROUP BY date(started_at, '+8 hours') ORDER BY date`).all(...query.args))
    const features = z.array(z.object({ feature: modelUsageFeatureSchema, requests: z.number(), knownTokens: z.number() })).parse(this.database.driver.prepare(`
      SELECT feature, SUM(${actualRequestSql}) AS requests, COALESCE(SUM(${knownTokensSql}), 0) AS knownTokens
      FROM model_usage_attempt a WHERE ${query.sql} GROUP BY feature ORDER BY requests DESC`).all(...query.args))
    const control = this.control(context.workspaceId)
    return modelUsageOverviewSchema.parse({ totals: { ...totals, unpricedRequests: totals.requests, cny: null },
      trend, features, coverage: 'server-direct-bridge-and-host', policy: { enabled: control.effective.enabled,
        requests: control.workspace.requests, tokens: null, cny: null } })
  }

  list(context: ActorContext, filter: ModelUsageFilter) {
    this.#expireHostAttempts()
    const query = this.#where(context, filter, true)
    const total = z.object({ count: z.number() }).parse(this.database.driver.prepare(`SELECT COUNT(*) AS count FROM model_usage_attempt a WHERE ${query.sql}`).get(...query.args)).count
    const rows = z.array(rowSchema).parse(this.database.driver.prepare(`SELECT record_json FROM model_usage_attempt a WHERE ${query.sql}
      ORDER BY started_at DESC, attempt_id DESC LIMIT ? OFFSET ?`).all(...query.args, filter.limit, filter.offset))
    return modelUsageListSchema.parse({ items: rows.map(row => JSON.parse(row.record_json)), total })
  }

  detail(context: ActorContext, attemptId: string): ModelUsageAttempt | undefined {
    this.#expireHostAttempts()
    const query = this.#where(context, { offset: 0, limit: 1 }, true)
    const row = rowSchema.optional().parse(this.database.driver.prepare(`SELECT record_json FROM model_usage_attempt a WHERE ${query.sql} AND attempt_id = ?`).get(...query.args, attemptId))
    return row === undefined ? undefined : modelUsageAttemptSchema.parse(JSON.parse(row.record_json))
  }

  admitHost(input: Parameters<ModelUsageRecorder['begin']>[0]): string | undefined {
    this.#expireHostAttempts()
    try { return this.database.driver.transaction(() => {
      const existing = this.database.driver.prepare(`SELECT 1 FROM model_usage_attempt
        WHERE workspace_id = ? AND epoch = ? AND feature = 'doctor_delegation'
          AND json_extract(record_json, '$.context.taskId') = ?`)
        .get(input.context.workspaceId, input.context.epoch, input.context.taskId)
      if (existing !== undefined) return undefined
      return this.begin(input)
    })() } catch (error) {
      // begin() runs in a nested transaction here; persist the rejection after
      // the outer admission transaction has also rolled back.
      if (error instanceof ModelUsageControlError) this.#control.reject(input.context.workspaceId, error)
      throw error
    }
  }

  observeHost(attemptId: string, outcome: ModelUsageOutcome, progress: boolean): void {
    this.#expireHostAttempts()
    const row = this.database.driver.prepare(`SELECT 1 FROM model_usage_attempt WHERE attempt_id = ? AND feature = 'doctor_delegation'`).get(attemptId)
    if (row === undefined) throw new Error('Host attempt unavailable')
    const parsed = modelUsageOutcomeSchema.parse(outcome)
    const { status: _status, ...observation } = parsed
    this.#update(attemptId, progress ? observation : parsed)
  }

  hostShouldAbort(attemptId: string): boolean {
    this.#expireHostAttempts()
    const row = rowSchema.parse(this.database.driver.prepare(
      "SELECT record_json FROM model_usage_attempt WHERE attempt_id = ? AND feature = 'doctor_delegation'").get(attemptId))
    const attempt = modelUsageAttemptSchema.parse(JSON.parse(row.record_json))
    return attempt.status !== 'in-flight' || !this.control(attempt.context.workspaceId).effective.enabled
  }

  #expireHostAttempts(): void {
    const now = new Date()
    // Reading or reporting after Host loss converges the durable attempt without
    // releasing consumption, renewing the deadline, or granting another dispatch.
    this.database.driver.prepare(`UPDATE model_usage_attempt SET status = 'unknown',
      record_json = json_set(record_json, '$.status', 'unknown', '$.endedAt', ?)
      WHERE feature = 'doctor_delegation' AND status = 'in-flight' AND started_at <= ?`)
      .run(now.toISOString(), new Date(now.getTime() - hostDoctorRecognitionTimeoutMs).toISOString())
  }

  #where(context: ActorContext, filter: ModelUsageFilter, details: boolean) {
    const clauses = ['a.workspace_id = ?']
    const args: Array<string | number> = [context.workspaceId]
    if (details && context.roleCode !== 'administrator') {
      clauses.push('a.epoch = ?')
      args.push(context.epoch)
      if (context.roleCode === 'outpatient-doctor' && context.practitionerRoleId !== undefined) {
        clauses.push(`a.feature NOT IN ('patient_persona', 'laboratory_service_enrichment') AND EXISTS (
          SELECT 1 FROM outpatient_case_responsibility r WHERE r.workspace_id = a.workspace_id
          AND r.epoch = a.epoch AND r.case_id = a.case_id AND r.practitioner_role_id = ?)`)
        args.push(context.practitionerRoleId)
      } else clauses.push('0 = 1')
    }
    if (filter.from !== undefined) { clauses.push('a.started_at >= ?'); args.push(new Date(`${filter.from}T00:00:00.000+08:00`).toISOString()) }
    if (filter.to !== undefined) { clauses.push('a.started_at <= ?'); args.push(new Date(`${filter.to}T23:59:59.999+08:00`).toISOString()) }
    for (const [key, column] of [['feature', 'feature'], ['provider', 'provider'], ['status', 'status'], ['caseId', 'case_id']] as const) {
      if (filter[key] !== undefined) { clauses.push(`a.${column} = ?`); args.push(filter[key]) }
    }
    if (filter.model !== undefined) { clauses.push('(a.actual_model = ? OR a.requested_model = ?)'); args.push(filter.model, filter.model) }
    return { sql: clauses.join(' AND '), args }
  }
}
