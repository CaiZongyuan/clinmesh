import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  modelUsageAttemptSchema, modelUsageContextSchema, modelUsageFeatureSchema,
  modelUsageOutcomeSchema, modelUsageOverviewSchema, modelUsageListSchema,
  mergeModelTokenUsage, unknownModelTokenUsage,
  type ModelUsageAttempt, type ModelUsageFilter, type ModelUsageOutcome,
} from '@clinmesh/contracts/model-usage'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext } from './command-executor.ts'
import type { ModelUsageRecorder } from './model-usage-lifecycle.ts'

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
  constructor(private readonly database: ClinMeshDatabase) {
    // A previous writer cannot prove whether its in-flight requests reached the Provider.
    this.database.driver.prepare(`UPDATE model_usage_attempt SET status = 'unknown',
      record_json = json_set(record_json, '$.status', 'unknown', '$.endedAt', ?)
      WHERE status = 'in-flight'`).run(new Date().toISOString())
  }

  begin(input: Parameters<ModelUsageRecorder['begin']>[0], reserve?: () => void): string {
    const context = modelUsageContextSchema.parse(input.context)
    const record = modelUsageAttemptSchema.parse({
      id: randomUUID(), context, feature: modelUsageFeatureSchema.parse(input.feature),
      provider: input.provider, requestedModel: input.model, actualModel: null,
      reasoningEffort: input.reasoningEffort ?? null, outputLimit: input.outputLimit,
      kind: input.kind, status: 'in-flight', startedAt: new Date().toISOString(), endedAt: null,
      providerRequestId: null, httpStatus: null, usage: unknownModelTokenUsage,
      cost: { status: 'price-not-configured', cny: null },
    })
    return this.database.driver.transaction(() => {
      this.database.driver.prepare(`INSERT INTO model_usage_attempt
        (attempt_id, workspace_id, epoch, case_id, feature, provider, requested_model, actual_model, status, started_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'in-flight', ?, ?)`)
        .run(record.id, context.workspaceId, context.epoch, context.caseId ?? null, record.feature,
          record.provider, record.requestedModel, record.startedAt, JSON.stringify(record))
      reserve?.()
      return record.id
    })()
  }

  settle(attemptId: string, input: ModelUsageOutcome): void {
    const outcome = modelUsageOutcomeSchema.parse(input)
    this.database.driver.transaction(() => {
      const row = rowSchema.parse(this.database.driver.prepare('SELECT record_json FROM model_usage_attempt WHERE attempt_id = ?').get(attemptId))
      const previous = modelUsageAttemptSchema.parse(JSON.parse(row.record_json))
      // A completed attempt is immutable; duplicate transport delivery is harmless.
      if (previous.status !== 'in-flight' && previous.status !== 'unknown') return
      const usage = mergeModelTokenUsage(previous.usage, outcome.usage)
      const record = modelUsageAttemptSchema.parse({ ...previous, ...outcome, usage,
        actualModel: outcome.actualModel ?? previous.actualModel,
        providerRequestId: outcome.providerRequestId ?? previous.providerRequestId,
        httpStatus: outcome.httpStatus ?? previous.httpStatus, endedAt: new Date().toISOString(),
      })
      this.database.driver.prepare(`UPDATE model_usage_attempt SET actual_model = ?, status = ?, record_json = ? WHERE attempt_id = ?`)
        .run(record.actualModel, record.status, JSON.stringify(record), attemptId)
    })()
  }

  overview(context: ActorContext, filter: ModelUsageFilter) {
    const query = this.#where(context, filter, false)
    const totals = summaryRowSchema.parse(this.database.driver.prepare(`SELECT ${totalsSql} FROM model_usage_attempt a WHERE ${query.sql}`).get(...query.args))
    const trend = z.array(z.object({ date: z.string(), requests: z.number(), knownTokens: z.number() })).parse(this.database.driver.prepare(`
      SELECT date(started_at, '+8 hours') AS date, SUM(${actualRequestSql}) AS requests,
      COALESCE(SUM(${knownTokensSql}), 0) AS knownTokens
      FROM model_usage_attempt a WHERE ${query.sql} GROUP BY date(started_at, '+8 hours') ORDER BY date`).all(...query.args))
    const features = z.array(z.object({ feature: modelUsageFeatureSchema, requests: z.number(), knownTokens: z.number() })).parse(this.database.driver.prepare(`
      SELECT feature, SUM(${actualRequestSql}) AS requests, COALESCE(SUM(${knownTokensSql}), 0) AS knownTokens
      FROM model_usage_attempt a WHERE ${query.sql} GROUP BY feature ORDER BY requests DESC`).all(...query.args))
    return modelUsageOverviewSchema.parse({ totals: { ...totals, unpricedRequests: totals.requests, cny: null },
      trend, features, coverage: 'server-direct-and-bridge', policy: { enabled: true, requests: null, tokens: null, cny: null } })
  }

  list(context: ActorContext, filter: ModelUsageFilter) {
    const query = this.#where(context, filter, true)
    const total = z.object({ count: z.number() }).parse(this.database.driver.prepare(`SELECT COUNT(*) AS count FROM model_usage_attempt a WHERE ${query.sql}`).get(...query.args)).count
    const rows = z.array(rowSchema).parse(this.database.driver.prepare(`SELECT record_json FROM model_usage_attempt a WHERE ${query.sql}
      ORDER BY started_at DESC, attempt_id DESC LIMIT ? OFFSET ?`).all(...query.args, filter.limit, filter.offset))
    return modelUsageListSchema.parse({ items: rows.map(row => JSON.parse(row.record_json)), total })
  }

  detail(context: ActorContext, attemptId: string): ModelUsageAttempt | undefined {
    const query = this.#where(context, { offset: 0, limit: 1 }, true)
    const row = rowSchema.optional().parse(this.database.driver.prepare(`SELECT record_json FROM model_usage_attempt a WHERE ${query.sql} AND attempt_id = ?`).get(...query.args, attemptId))
    return row === undefined ? undefined : modelUsageAttemptSchema.parse(JSON.parse(row.record_json))
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
