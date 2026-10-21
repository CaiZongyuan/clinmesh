import { z } from 'zod'
import { modelPricingDecimalMicro } from '@clinmesh/contracts/model-pricing'
import { modelUsageControlSchema, modelUsagePolicyConfigSchema, type modelUsageControlCodeSchema,
  type ModelUsageControlUpdate, type ModelUsagePolicyConfig,
  type ModelUsageOutcome } from '@clinmesh/contracts/model-usage'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'

export class ModelUsageControlError extends Error {
  readonly status = 409
  constructor(readonly code: z.infer<typeof modelUsageControlCodeSchema>,
    readonly scope: 'workspace' | 'deployment', readonly dimension: 'requests' | 'tokens' | 'cny' | null = null,
    readonly remaining: number | null = null, readonly required: number | null = null) {
    super('The model request is waiting for its execution policy')
    this.name = 'ModelUsageControlError'
  }
}
export function modelUsageControlFailure(error: unknown): ModelUsageControlError | undefined {
  const seen = new Set<unknown>()
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof ModelUsageControlError) return error
    seen.add(error); error = error.cause
  }
  return undefined
}
export class ModelUsagePolicyError extends Error {
  constructor(readonly code: 'ROLE_NOT_ALLOWED' | 'EXPECTED_VERSION_CONFLICT' | 'NOT_FOUND' | 'MODEL_USAGE_CORRECTION_INVALID', readonly status: 403 | 404 | 409) {
    super(code === 'ROLE_NOT_ALLOWED' ? 'An administrator role is required' : 'The model policy changed; reload before saving')
  }
}
const persistedCount = z.number().int().nonnegative().safe()
const policyRow = z.object({ scope_id: z.string(), enabled: z.union([z.literal(0), z.literal(1)]), request_limit: persistedCount.nullable(),
  automatic_retries: z.union([z.literal(0), z.literal(1)]), version: z.number().int().positive().safe(),
  requests_started_at: z.iso.datetime().nullable(), used: persistedCount, reserved: persistedCount })
type PolicyRow = z.infer<typeof policyRow>
const internalControlSchema = modelUsageControlSchema.extend({ deployment: modelUsageControlSchema.shape.workspace })
const dimensionSchema = z.enum(['tokens', 'cny'])
type Dimension = z.infer<typeof dimensionSchema>
const dimensionRow = z.object({ scope_id: z.string(), dimension: dimensionSchema,
  limit_value: persistedCount.nullable(), started_at: z.iso.datetime().nullable(), used: persistedCount })
type DimensionRow = z.infer<typeof dimensionRow>
const dimensionReservation = z.object({ attempt_id: z.string(), scope_id: z.string(), dimension: dimensionSchema,
  amount: persistedCount.nullable(), state: z.enum(['reserved', 'used', 'released']) })
type DimensionValues = { tokens: number | null; cny: number | null }
const dimensionValues = z.object({ tokens: persistedCount.nullable(), cny: persistedCount.nullable() }).strict()
const dimensions = ['tokens', 'cny'] as const
const maximumCount = BigInt(Number.MAX_SAFE_INTEGER)
const externalValue = (dimension: Dimension, value: number | null) => value === null ? null : dimension === 'cny' ? value / 1_000_000 : value

/** Persistent budgets have a lifecycle independent of attempt retention and Epochs. */
export class ModelUsageControl {
  readonly #active = new Map<AbortController, string>()
  readonly #listeners = new Set<() => void>()
  #waitingCount: (workspaceId: string) => number = () => 0

  constructor(private readonly database: ClinMeshDatabase, private readonly commands: CommandExecutor,
    deployment: ModelUsagePolicyConfig = { enabled: true, requests: null, automaticRetries: true }) {
    const config = modelUsagePolicyConfigSchema.parse(deployment)
    this.#atomic('deployment', () => this.#writePolicy('deployment', { ...config, tokens: config.tokens ?? null, cny: config.cny ?? null }, false))
  }

  setWaitingCount(read: (workspaceId: string) => number): void { this.#waitingCount = read }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }

  read(workspaceId: string) {
    return this.#atomic('workspace', () => {
    const workspace = this.#scope(this.#workspace(workspaceId))
    const deployment = this.#scope(this.#row('deployment'))
    const last = z.object({ code: z.string(), scope: z.string(), rejected_at: z.string(), dimension: z.enum(['requests', 'tokens', 'cny']).nullable(),
      remaining: z.number().finite().nonnegative().nullable(), required: z.number().finite().nonnegative().nullable() }).optional().parse(
      this.database.driver.prepare('SELECT code, scope, rejected_at, dimension, remaining, required FROM model_usage_control_rejection WHERE workspace_id = ?').get(workspaceId))
    const inFlight = z.object({ count: z.number() }).parse(this.database.driver.prepare(
      "SELECT COUNT(*) AS count FROM model_usage_attempt WHERE workspace_id = ? AND status = 'in-flight'").get(workspaceId)).count
    return internalControlSchema.parse({ workspace, deployment,
      effective: { enabled: workspace.enabled && deployment.enabled, automaticRetries: workspace.automaticRetries && deployment.automaticRetries },
      waiting: this.#waitingCount(workspaceId), inFlight,
      lastRejection: last === undefined ? null : { code: last.code, scope: last.scope, at: last.rejected_at,
        dimension: last.dimension, remaining: last.remaining, required: last.required } })
    })
  }

  update(context: ActorContext, input: ModelUsageControlUpdate, idempotencyKey: string) {
    if (context.roleCode !== 'administrator') throw new ModelUsagePolicyError('ROLE_NOT_ALLOWED', 403)
    const result = this.commands.execute({ context, contextRequirement: 'current', idempotencyScope: 'workspace',
      dataSchema: modelUsageControlSchema, expectedVersions: {}, idempotencyKey, input, operation: 'model-usage.control.update' }, () => {
      const current = this.#workspace(context.workspaceId)
      if (current.version !== input.expectedVersion) throw new ModelUsagePolicyError('EXPECTED_VERSION_CONFLICT', 409)
      this.#writePolicy(current.scope_id, input, true)
      return { data: this.read(context.workspaceId), effects: [] }
    }).data
    this.#cancelDisabled()
    for (const listener of this.#listeners) { try { listener() } catch { /* Durable waiters are also polled. */ } }
    return result
  }

  reserve(workspaceId: string, attemptId: string, kind: string, bounds: DimensionValues = { tokens: null, cny: null }): void {
    this.#atomic('workspace', () => {
    dimensionValues.parse(bounds)
    const rows = [this.#row('deployment'), this.#workspace(workspaceId)]
    for (const [index, row] of rows.entries()) {
      const scope = index === 0 ? 'deployment' : 'workspace'
      if (!row.enabled) throw new ModelUsageControlError('MODEL_DISABLED', scope)
      if (kind !== 'initial' && !row.automatic_retries) throw new ModelUsageControlError('MODEL_RETRY_DISABLED', scope)
      const occupied = this.#sum(row.used, row.reserved)
      if (row.request_limit !== null && occupied >= row.request_limit) throw new ModelUsageControlError('MODEL_REQUEST_LIMIT', scope, 'requests', Math.max(0, row.request_limit - occupied), 1)
      for (const dimension of this.#dimensions(row.scope_id)) {
        const summary = this.#dimensionSummary(dimension)
        const bound = bounds[dimension.dimension]
        if (dimension.limit_value !== null) {
          const remaining = Math.max(0, dimension.limit_value - this.#sum(dimension.used, summary.reserved))
          if (bound === null || summary.unknown > 0) throw new ModelUsageControlError('MODEL_METERING_UNAVAILABLE', scope,
            dimension.dimension, externalValue(dimension.dimension, remaining), externalValue(dimension.dimension, bound))
          if (bound > remaining) throw new ModelUsageControlError(dimension.dimension === 'tokens' ? 'MODEL_TOKEN_LIMIT' : 'MODEL_CNY_LIMIT',
            scope, dimension.dimension, externalValue(dimension.dimension, remaining), externalValue(dimension.dimension, bound))
        }
        if (dimension.started_at !== null && bound !== null) this.#sum(dimension.used, summary.reserved, bound)
      }
    }
    for (const row of rows) {
      if (row.requests_started_at !== null) {
        this.#sum(row.used, row.reserved, 1)
        this.database.driver.prepare('UPDATE model_usage_control SET reserved = reserved + 1 WHERE scope_id = ?').run(row.scope_id)
        this.database.driver.prepare("INSERT INTO model_usage_request_reservation(attempt_id, scope_id, state) VALUES (?, ?, 'reserved')").run(attemptId, row.scope_id)
      }
      for (const dimension of this.#dimensions(row.scope_id)) {
        if (dimension.started_at === null) continue
        this.database.driver.prepare(`INSERT INTO model_usage_dimension_reservation(attempt_id, scope_id, dimension, amount, state)
          VALUES (?, ?, ?, ?, 'reserved')`).run(attemptId, row.scope_id, dimension.dimension, bounds[dimension.dimension])
      }
    }
    })
  }

  settle(attemptId: string, dispatch: ModelUsageOutcome['dispatch']): void {
    if (dispatch !== 'dispatched' && dispatch !== 'not-dispatched') return
    this.#atomic('workspace', () => {
    const rows = z.array(z.object({ scope_id: z.string() })).parse(this.database.driver.prepare(
      "SELECT scope_id FROM model_usage_request_reservation WHERE attempt_id = ? AND state = 'reserved'").all(attemptId))
    for (const row of rows) {
      const policy = this.#row(row.scope_id)
      if (policy.reserved === 0) throw new ModelUsageControlError('MODEL_LEDGER_UNAVAILABLE', row.scope_id === 'deployment' ? 'deployment' : 'workspace')
      this.#sum(policy.used, dispatch === 'dispatched' ? 1 : 0)
      this.database.driver.prepare('UPDATE model_usage_control SET reserved = reserved - 1, used = used + ? WHERE scope_id = ?')
        .run(dispatch === 'dispatched' ? 1 : 0, row.scope_id)
      this.database.driver.prepare('UPDATE model_usage_request_reservation SET state = ? WHERE attempt_id = ? AND scope_id = ?')
        .run(dispatch === 'dispatched' ? 'used' : 'released', attemptId, row.scope_id)
    }
    })
  }

  settleDimensions(attemptId: string, values: DimensionValues, notDispatched: boolean): void {
    this.#atomic('workspace', () => {
      dimensionValues.parse(values)
      const reservations = z.array(dimensionReservation).parse(this.database.driver.prepare(
        'SELECT * FROM model_usage_dimension_reservation WHERE attempt_id = ?').all(attemptId))
      for (const reservation of reservations) {
        const value = values[reservation.dimension]
        if (reservation.state === 'used') {
          if (notDispatched || value !== null && value !== reservation.amount) throw new ModelUsagePolicyError('MODEL_USAGE_CORRECTION_INVALID', 409)
          continue
        }
        if (reservation.state === 'released') {
          if (!notDispatched && value !== null && value !== 0) throw new ModelUsagePolicyError('MODEL_USAGE_CORRECTION_INVALID', 409)
          continue
        }
        if (notDispatched) {
          this.database.driver.prepare(`UPDATE model_usage_dimension_reservation SET state = 'released'
            WHERE attempt_id = ? AND scope_id = ? AND dimension = ?`).run(attemptId, reservation.scope_id, reservation.dimension)
        } else if (value !== null) {
          const dimension = this.#dimensions(reservation.scope_id).find(row => row.dimension === reservation.dimension)!
          const used = this.#sum(dimension.used, value)
          this.database.driver.prepare('UPDATE model_usage_dimension SET used = ? WHERE scope_id = ? AND dimension = ?')
            .run(used, reservation.scope_id, reservation.dimension)
          this.database.driver.prepare(`UPDATE model_usage_dimension_reservation SET state = 'used', amount = ?
            WHERE attempt_id = ? AND scope_id = ? AND dimension = ?`).run(value, attemptId, reservation.scope_id, reservation.dimension)
        }
      }
    })
  }

  reject(workspaceId: string, error: ModelUsageControlError): void {
    try { this.database.driver.prepare(`INSERT INTO model_usage_control_rejection(workspace_id, code, scope, rejected_at, dimension, remaining, required) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET code=excluded.code, scope=excluded.scope, rejected_at=excluded.rejected_at,
        dimension=excluded.dimension, remaining=excluded.remaining, required=excluded.required`)
      .run(workspaceId, error.code, error.scope, new Date().toISOString(), error.dimension, error.remaining, error.required) } catch { /* An unavailable ledger cannot persist its own failure. */ }
  }

  automaticRetries(workspaceId: string): boolean {
    return this.#atomic('workspace', () => !!(this.#workspace(workspaceId).automatic_retries && this.#row('deployment').automatic_retries))
  }
  canDispatch(workspaceId: string): boolean {
    try {
      return this.database.driver.transaction(() => {
        this.database.driver.prepare("UPDATE model_usage_control SET version = version WHERE scope_id = 'deployment'").run()
        return [this.#workspace(workspaceId), this.#row('deployment')].every(row => row.enabled
          && (row.request_limit === null || this.#sum(row.used, row.reserved) < row.request_limit))
      })()
    } catch { return false }
  }

  async run<T>(workspaceId: string, signal: AbortSignal | undefined, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    this.#active.set(controller, workspaceId)
    try { return await invoke(signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])) }
    finally { this.#active.delete(controller) }
  }

  #cancelDisabled(): void {
    for (const [controller, workspaceId] of this.#active) {
      if (!this.#workspace(workspaceId).enabled || !this.#row('deployment').enabled) controller.abort(new ModelUsageControlError('MODEL_DISABLED', 'workspace'))
    }
  }
  #row(scope: string): PolicyRow {
    const parsed = policyRow.safeParse(this.database.driver.prepare('SELECT * FROM model_usage_control WHERE scope_id = ?').get(scope))
    if (!parsed.success) throw new ModelUsageControlError('MODEL_LEDGER_UNAVAILABLE', scope === 'deployment' ? 'deployment' : 'workspace')
    return parsed.data
  }
  #workspace(workspaceId: string): PolicyRow {
    const scope = `workspace:${workspaceId}`
    const created = this.database.driver.prepare('INSERT OR IGNORE INTO model_usage_control(scope_id) VALUES (?)').run(scope)
    if (created.changes > 0) for (const dimension of dimensions) {
      this.database.driver.prepare('INSERT INTO model_usage_dimension(scope_id, dimension) VALUES (?, ?)').run(scope, dimension)
    }
    return this.#row(scope)
  }
  #scope(row: PolicyRow) {
    const [tokens, cny] = dimensions.map(name => {
      const dimension = this.#dimensions(row.scope_id).find(entry => entry.dimension === name)!
      const summary = this.#dimensionSummary(dimension)
      return { limit: externalValue(name, dimension.limit_value), startedAt: dimension.started_at, used: externalValue(name, dimension.used)!,
        reserved: externalValue(name, summary.reserved)!, unknown: summary.unknown,
        remaining: dimension.limit_value === null || summary.unknown > 0 ? null
          : externalValue(name, Math.max(0, dimension.limit_value - this.#sum(dimension.used, summary.reserved))) }
    })
    return { enabled: !!row.enabled, requests: row.request_limit, automaticRetries: !!row.automatic_retries, version: row.version,
      requestsStartedAt: row.requests_started_at, used: row.used, reserved: row.reserved,
      remaining: row.request_limit === null ? null : Math.max(0, row.request_limit - this.#sum(row.used, row.reserved)),
      tokens: tokens!.limit, tokensStartedAt: tokens!.startedAt, tokensUsed: tokens!.used, tokensReserved: tokens!.reserved,
      tokensRemaining: tokens!.remaining, tokensUnknownReservations: tokens!.unknown,
      cny: cny!.limit, cnyStartedAt: cny!.startedAt, cnyUsed: cny!.used, cnyReserved: cny!.reserved,
      cnyRemaining: cny!.remaining, cnyUnknownReservations: cny!.unknown }
  }
  #writePolicy(scope: string, input: ModelUsagePolicyConfig, bump: boolean): void {
    const current = this.#row(scope)
    let changed = !!current.enabled !== input.enabled || current.request_limit !== input.requests || !!current.automatic_retries !== input.automaticRetries
    for (const dimension of this.#dimensions(scope)) {
      const value = input[dimension.dimension]
      if (value === undefined) continue
      const limit = value === null ? null : dimension.dimension === 'cny' ? Number(modelPricingDecimalMicro(value)) : value
      persistedCount.nullable().parse(limit)
      changed ||= dimension.limit_value !== limit
      this.database.driver.prepare(`UPDATE model_usage_dimension SET limit_value = ?,
        started_at = CASE WHEN started_at IS NULL AND ? IS NOT NULL THEN ? ELSE started_at END WHERE scope_id = ? AND dimension = ?`)
        .run(limit, limit, new Date().toISOString(), scope, dimension.dimension)
    }
    const nextVersion = this.#sum(current.version, bump || changed ? 1 : 0)
    this.database.driver.prepare(`UPDATE model_usage_control SET enabled = ?, request_limit = ?, automatic_retries = ?, version = ?,
      requests_started_at = CASE WHEN requests_started_at IS NULL AND ? IS NOT NULL THEN ? ELSE requests_started_at END WHERE scope_id = ?`)
      .run(input.enabled ? 1 : 0, input.requests, input.automaticRetries ? 1 : 0, nextVersion, input.requests, new Date().toISOString(), scope)
  }

  #dimensions(scope: string): DimensionRow[] {
    const rows = z.array(dimensionRow).parse(this.database.driver.prepare('SELECT * FROM model_usage_dimension WHERE scope_id = ?').all(scope))
    if (rows.length !== 2 || dimensions.some(name => !rows.some(row => row.dimension === name))
      || rows.some(row => row.started_at === null && (row.limit_value !== null || row.used !== 0))) {
      throw new ModelUsageControlError('MODEL_LEDGER_UNAVAILABLE', scope === 'deployment' ? 'deployment' : 'workspace')
    }
    return rows
  }

  #dimensionSummary(row: DimensionRow): { reserved: number; unknown: number } {
    const reservations = z.array(dimensionReservation).parse(this.database.driver.prepare(`SELECT * FROM model_usage_dimension_reservation
      WHERE scope_id = ? AND dimension = ? AND state = 'reserved'`).all(row.scope_id, row.dimension))
    return { reserved: reservations.reduce((reserved, reservation) => this.#sum(reserved, reservation.amount ?? 0), 0),
      unknown: reservations.filter(reservation => reservation.amount === null).length }
  }

  #sum(...values: number[]): number {
    const sum = values.reduce((total, value) => total + BigInt(persistedCount.parse(value)), 0n)
    if (sum > maximumCount) throw new ModelUsageControlError('MODEL_LEDGER_UNAVAILABLE', 'workspace')
    return Number(sum)
  }

  #atomic<T>(scope: 'workspace' | 'deployment', work: () => T): T {
    try { return this.database.driver.transaction(work)() }
    catch (error) {
      if (error instanceof ModelUsageControlError || error instanceof ModelUsagePolicyError) throw error
      throw new ModelUsageControlError('MODEL_LEDGER_UNAVAILABLE', scope)
    }
  }
}
