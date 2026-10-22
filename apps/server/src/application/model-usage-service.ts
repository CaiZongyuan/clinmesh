import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import {
  modelUsageAttemptSchema, modelUsageContextSchema, modelUsageFeatureSchema,
  modelUsageOutcomeSchema, modelUsageOverviewSchema, modelUsageListSchema, modelTokenUsageSchema, modelUsageConfigurationSchema,
  hostDoctorRecognitionTimeoutMs, mergeModelTokenUsage, unknownModelTokenUsage,
  type ModelTokenUsage, type ModelUsageAttempt, type ModelUsageConfiguration, type ModelUsageFilter, type ModelUsageOutcome,
  type ModelUsagePolicyConfig, type ModelUsageControlUpdate, type ModelUsageRetentionUpdate,
  modelUsageReservationBoundarySchema, modelUsageReconcileSchema, modelUsageRepriceSchema,
} from '@clinmesh/contracts/model-usage'
import { modelPricingConfigSchema, modelPricingDecimalMicro, type ModelPricingConfig, type ModelUsageCost } from '@clinmesh/contracts/model-pricing'
import { freezeModelPrice, priceModelUsage, priceModelReservation } from './model-usage-pricing.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { ModelUsageRecorder } from './model-usage-lifecycle.ts'
import { ModelUsageControl, ModelUsageControlError, ModelUsagePolicyError } from './model-usage-control.ts'
import { ModelUsageRetention } from './model-usage-retention.ts'
import { combinedModelUsageSql, modelUsageTotalsSql } from './model-usage-summary.ts'

const rowSchema = z.object({ record_json: z.string() })
function preservesKnownNumbers(previous: object, next: object): boolean {
  const counters = new Map(Object.entries(next))
  return Object.entries(previous).every(([key, value]) => typeof value !== 'number' || counters.get(key) === value)
}
const summaryRowSchema = z.object({
  requests: z.number(), inFlight: z.number(), unknownRequests: z.number(),
  knownTokens: z.number(), unknownTokenRequests: z.number(),
  cnyMicro: z.number().int().nonnegative().safe().nullable(), unpricedRequests: z.number(),
})

/** One writer owns attempts, task admission and settlement. Queries never expose clinical content. */
export class ModelUsageService implements ModelUsageRecorder {
  readonly #control: ModelUsageControl
  readonly #pricing: ModelPricingConfig
  readonly #retention: ModelUsageRetention
  constructor(private readonly database: ClinMeshDatabase, private readonly commands: CommandExecutor, deployment?: ModelUsagePolicyConfig, pricing: ModelPricingConfig = { prices: [], exchangeRates: [] }) {
    this.#pricing = modelPricingConfigSchema.parse(pricing)
    this.#control = new ModelUsageControl(database, commands, deployment)
    this.#retention = new ModelUsageRetention(database, commands)
    // A previous writer cannot prove whether its in-flight requests reached the Provider.
    this.database.driver.prepare(`UPDATE model_usage_attempt SET status = 'unknown',
      record_json = json_set(record_json, '$.status', 'unknown', '$.endedAt', ?)
      WHERE status = 'in-flight'`).run(new Date().toISOString())
    this.compactUsage()
  }

  control(workspaceId: string) { return this.#control.read(workspaceId) }
  controlFor(context: ActorContext) {
    const state = this.control(context.workspaceId)
    return { ...state, deployment: context.roleCode === 'administrator' ? state.deployment : null }
  }
  updateControl(context: ActorContext, input: ModelUsageControlUpdate, key: string) { return this.#control.update(context, input, key) }
  pricing() { return this.#pricing }
  retention(workspaceId: string) { return this.#retention.read(workspaceId) }
  updateRetention(context: ActorContext, input: ModelUsageRetentionUpdate, key: string) { return this.#retention.update(context, input, key) }
  compactUsage() { this.#retention.compactAll() }
  canDispatch(workspaceId: string) { return this.#control.canDispatch(workspaceId) }
  automaticRetries(workspaceId: string) { return this.#control.automaticRetries(workspaceId) }
  subscribe(listener: () => void) { return this.#control.subscribe(listener) }
  setWaitingCount(read: (workspaceId: string) => number) { this.#control.setWaitingCount(read) }
  run<T>(workspaceId: string, signal: AbortSignal | undefined, invoke: (signal: AbortSignal) => Promise<T>) {
    return this.#control.run(workspaceId, signal, invoke)
  }

  begin(input: Parameters<ModelUsageRecorder['begin']>[0], reserve?: () => void): string {
    const context = modelUsageContextSchema.parse(input.context)
    const priceSnapshot = freezeModelPrice(this.#pricing, input.provider, input.model)
    const boundary = input.reservationBoundary === undefined ? null : modelUsageReservationBoundarySchema.parse(input.reservationBoundary)
    const bounds = boundary ?? { inputTokens: null, outputTokens: null }
    const reservation = priceModelReservation(priceSnapshot, bounds)
    const tokenBound = bounds.inputTokens === null || bounds.outputTokens === null ? null : bounds.inputTokens + bounds.outputTokens
    if (tokenBound !== null && !Number.isSafeInteger(tokenBound)) throw new ModelUsageControlError('MODEL_METERING_UNAVAILABLE', 'workspace', 'tokens')
    const record = modelUsageAttemptSchema.parse({
      id: uuidv7(), context, feature: modelUsageFeatureSchema.parse(input.feature),
      provider: input.provider, requestedModel: input.model, actualModel: null,
      reasoningEffort: input.reasoningEffort ?? null, outputLimit: input.outputLimit,
      kind: input.kind, status: 'in-flight', startedAt: new Date().toISOString(), endedAt: null,
      providerRequestId: null, httpStatus: null, usage: unknownModelTokenUsage,
      priceSnapshot, reservationBoundary: boundary, cost: priceModelUsage(priceSnapshot, unknownModelTokenUsage, 'unknown'),
    })
    try { return this.database.driver.transaction(() => {
      this.database.driver.prepare(`INSERT INTO model_usage_attempt
        (attempt_id, workspace_id, epoch, case_id, feature, provider, requested_model, actual_model, status, started_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'in-flight', ?, ?)`)
        .run(record.id, context.workspaceId, context.epoch, context.caseId ?? null, record.feature,
          record.provider, record.requestedModel, record.startedAt, JSON.stringify(record))
      this.#control.reserve(context.workspaceId, record.id, record.kind, { tokens: tokenBound, cny: reservation.cnyMicro },
        input.hasManualRetryAuthorization?.() === true)
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
      const terminal = previous.status !== 'in-flight' && previous.status !== 'unknown'
      if (terminal && previous.dispatch === 'not-dispatched') return
      const usage = mergeModelTokenUsage(previous.usage, outcome.usage)
      // Late evidence may fill unknown consumption, but cannot revise completed evidence.
      if (terminal && (!preservesKnownNumbers(previous.usage, usage)
        || previous.usage.mapping !== 'unknown' && previous.usage.mapping !== usage.mapping
        || previous.usage.raw !== undefined && (usage.raw === undefined || previous.usage.raw.format !== usage.raw.format
          || !preservesKnownNumbers(previous.usage.raw, usage.raw)))) return
      const dispatch = terminal
        ? previous.dispatch === 'unknown' && outcome.dispatch === 'dispatched' ? 'dispatched' : previous.dispatch
        : previous.dispatch === 'dispatched' ? 'dispatched' : outcome.dispatch ?? previous.dispatch
      const priceSnapshot = previous.priceSnapshot ?? freezeModelPrice({ prices: [], exchangeRates: [] }, previous.provider, previous.requestedModel)
      const cost = priceModelUsage(priceSnapshot, usage, dispatch)
      if (terminal && (!preservesKnownNumbers(previous.cost, cost)
        || previous.cost.currency != null && previous.cost.currency !== cost.currency)) return
      const updated = terminal ? previous : { ...previous, ...outcome,
        actualModel: outcome.actualModel ?? previous.actualModel,
        providerRequestId: outcome.providerRequestId ?? previous.providerRequestId,
        httpStatus: outcome.httpStatus ?? previous.httpStatus,
        endedAt: outcome.status === undefined ? previous.endedAt : new Date().toISOString(),
      }
      const record = modelUsageAttemptSchema.parse({ ...updated, usage, dispatch, cost, priceSnapshot })
      this.#save(this.#account(record))
    })()
  }

  overview(context: ActorContext, filter: ModelUsageFilter) {
    this.#expireHostAttempts()
    this.#retention.compact(context.workspaceId)
    const query = this.#where(context, filter, false)
    const totals = summaryRowSchema.parse(this.database.driver.prepare(`${combinedModelUsageSql} SELECT ${modelUsageTotalsSql} FROM usage a WHERE ${query.sql}`).get(...query.args))
    const trend = z.array(z.object({ date: z.string(), requests: z.number(), knownTokens: z.number() })).parse(this.database.driver.prepare(`
      ${combinedModelUsageSql} SELECT date, SUM(requests) AS requests, COALESCE(SUM(knownTokens), 0) AS knownTokens
      FROM usage a WHERE ${query.sql} GROUP BY date ORDER BY date`).all(...query.args))
    const features = z.array(z.object({ feature: modelUsageFeatureSchema, requests: z.number(), knownTokens: z.number() })).parse(this.database.driver.prepare(`
      ${combinedModelUsageSql} SELECT feature, SUM(requests) AS requests, COALESCE(SUM(knownTokens), 0) AS knownTokens
      FROM usage a WHERE ${query.sql} GROUP BY feature ORDER BY requests DESC, feature`).all(...query.args))
    const control = this.control(context.workspaceId)
    const { cnyMicro, ...visibleTotals } = totals
    return modelUsageOverviewSchema.parse({ totals: { ...visibleTotals, cny: cnyMicro === null ? null : cnyMicro / 1_000_000,
      reservedTokens: control.workspace.tokensReserved, reservedCny: control.workspace.cnyReserved,
      tokensUnknownReservations: control.workspace.tokensUnknownReservations, cnyUnknownReservations: control.workspace.cnyUnknownReservations },
      trend, features, coverage: 'server-direct-bridge-and-host', policy: { enabled: control.effective.enabled,
        requests: control.workspace.requests, tokens: control.workspace.tokens, cny: control.workspace.cny } })
  }

  list(context: ActorContext, filter: ModelUsageFilter) {
    this.#expireHostAttempts()
    this.#retention.compact(context.workspaceId)
    const query = this.#where(context, filter, true)
    const total = z.object({ count: z.number() }).parse(this.database.driver.prepare(`SELECT COUNT(*) AS count FROM model_usage_attempt a WHERE ${query.sql}`).get(...query.args)).count
    const rows = z.array(rowSchema).parse(this.database.driver.prepare(`SELECT record_json FROM model_usage_attempt a WHERE ${query.sql}
      ORDER BY started_at DESC, attempt_id DESC LIMIT ? OFFSET ?`).all(...query.args, filter.limit, filter.offset))
    return modelUsageListSchema.parse({ items: rows.map(row => JSON.parse(row.record_json)), total })
  }

  detail(context: ActorContext, attemptId: string): ModelUsageAttempt | undefined {
    this.#expireHostAttempts()
    this.#retention.compact(context.workspaceId)
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

  reconcile(context: ActorContext, attemptId: string, input: z.infer<typeof modelUsageReconcileSchema>, key: string) {
    return this.#correct(context, attemptId, modelUsageReconcileSchema.parse(input), key, false)
  }

  reprice(context: ActorContext, attemptId: string, input: z.infer<typeof modelUsageRepriceSchema>, key: string) {
    return this.#correct(context, attemptId, modelUsageRepriceSchema.parse(input), key, true)
  }

  #correct(context: ActorContext, attemptId: string,
    input: z.infer<typeof modelUsageReconcileSchema> | z.infer<typeof modelUsageRepriceSchema>, key: string, reprice: boolean) {
    if (context.roleCode !== 'administrator') throw new ModelUsagePolicyError('ROLE_NOT_ALLOWED', 403)
    // Check before Command replay as its retained receipt no longer contains expired detail.
    if (this.detail(context, attemptId) === undefined) throw new ModelUsagePolicyError('NOT_FOUND', 404)
    return this.commands.execute({ context, contextRequirement: 'current', idempotencyScope: 'workspace',
      dataSchema: modelUsageAttemptSchema, expectedVersions: {}, idempotencyKey: key, input: { attemptId, ...input },
      operation: reprice ? 'model-usage.reprice' : 'model-usage.reconcile' }, () => {
      const previous = this.detail(context, attemptId)
      if (previous === undefined) throw new ModelUsagePolicyError('NOT_FOUND', 404)
      if (previous.corrections.length !== input.expectedRevision) throw new ModelUsagePolicyError('EXPECTED_VERSION_CONFLICT', 409)
      if (previous.status === 'in-flight' || previous.dispatch === 'not-dispatched') throw new ModelUsagePolicyError('MODEL_USAGE_CORRECTION_INVALID', 409)
      const current = this.#account(previous)
      let totalTokens: number | null = null
      let cny: number | null = null
      let priceSnapshot = null
      let cost: ModelUsageCost | null = null
      if (reprice) {
        if (!['price-not-configured', 'exchange-rate-not-configured'].includes(previous.cost.status) || current.effectiveCost?.cny != null) {
          throw new ModelUsagePolicyError('MODEL_USAGE_CORRECTION_INVALID', 409)
        }
        const configured = freezeModelPrice(this.#pricing, previous.provider, previous.requestedModel)
        // A missing FX rate does not authorize changing the invocation's original unit prices.
        priceSnapshot = configured
        if (previous.priceSnapshot?.price != null) {
          const rate = this.#pricing.exchangeRates.find(rate => rate.currency === previous.priceSnapshot!.price!.currency)
          priceSnapshot = { ...previous.priceSnapshot, exchangeRate: rate === undefined ? null : { version: rate.version, cnyPerUnit: rate.cnyPerUnit } }
        }
        cost = priceModelUsage(priceSnapshot, previous.usage, previous.dispatch)
        if (cost.cny === null) throw new ModelUsagePolicyError('MODEL_USAGE_CORRECTION_INVALID', 409)
        cny = cost.cny
      } else {
        if ('totalTokens' in input && input.totalTokens !== undefined) {
          if (current.accounting?.totalTokens !== null) throw new ModelUsagePolicyError('MODEL_USAGE_CORRECTION_INVALID', 409)
          totalTokens = input.totalTokens
        }
        if ('cny' in input && input.cny !== undefined) {
          if (current.accounting?.cny !== null) throw new ModelUsagePolicyError('MODEL_USAGE_CORRECTION_INVALID', 409)
          cny = input.cny
        }
      }
      const record = modelUsageAttemptSchema.parse({ ...current, corrections: [...previous.corrections, {
        revision: previous.corrections.length + 1, at: new Date().toISOString(), actorId: context.actorId,
        evidence: input.evidence, kind: reprice ? 'reprice' : 'reconcile', totalTokens, cny, priceSnapshot, cost,
      }] })
      const saved = this.#account(record)
      this.#save(saved)
      return { data: saved, effects: [] }
    }).data
  }

  #account(record: ModelUsageAttempt): ModelUsageAttempt {
    let effectiveCost = record.cost
    let totalTokens = record.dispatch === 'not-dispatched' ? 0 : record.usage.totalTokens
    for (const correction of record.corrections) {
      if (correction.totalTokens !== null) totalTokens = correction.totalTokens
      if (correction.cost !== null) effectiveCost = correction.cost
      if (correction.cny !== null) effectiveCost = { ...effectiveCost, status: 'priced', cny: correction.cny,
        cnyMicro: Number(modelPricingDecimalMicro(correction.cny)) }
    }
    const reconciled = record.status !== 'in-flight' && totalTokens !== null && effectiveCost.cnyMicro !== null
      && record.corrections.some(correction => correction.kind === 'reconcile')
    // Full consumption reconciliation consumes one request without rewriting dispatch evidence.
    this.#control.settle(record.id, record.dispatch === 'unknown' && reconciled ? 'dispatched' : record.dispatch)
    if (record.status !== 'in-flight') this.#control.settleDimensions(record.id, { tokens: totalTokens, cny: effectiveCost.cnyMicro }, record.dispatch === 'not-dispatched')
    return { ...record, effectiveCost, accounting: { totalTokens, cny: effectiveCost.cny } }
  }

  #save(record: ModelUsageAttempt): void {
    this.database.driver.prepare('UPDATE model_usage_attempt SET actual_model = ?, status = ?, record_json = ? WHERE attempt_id = ?')
      .run(record.actualModel, record.status, JSON.stringify(record), record.id)
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
