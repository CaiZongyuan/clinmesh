import { z } from 'zod'
import { modelUsageControlSchema, modelUsagePolicyConfigSchema,
  type ModelUsageControl, type ModelUsageControlUpdate, type ModelUsagePolicyConfig,
  type ModelUsageOutcome } from '@clinmesh/contracts/model-usage'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'

export class ModelUsageControlError extends Error {
  readonly status = 409
  constructor(readonly code: 'MODEL_DISABLED' | 'MODEL_REQUEST_LIMIT' | 'MODEL_RETRY_DISABLED' | 'MODEL_LEDGER_UNAVAILABLE',
    readonly scope: 'workspace' | 'deployment') {
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
  constructor(readonly code: 'ROLE_NOT_ALLOWED' | 'EXPECTED_VERSION_CONFLICT', readonly status: 403 | 409) {
    super(code === 'ROLE_NOT_ALLOWED' ? 'An administrator role is required' : 'The model policy changed; reload before saving')
  }
}
const policyRow = z.object({ scope_id: z.string(), enabled: z.number(), request_limit: z.number().nullable(),
  automatic_retries: z.number(), version: z.number(), requests_started_at: z.string().nullable(), used: z.number(), reserved: z.number() })
type PolicyRow = z.infer<typeof policyRow>

/** Persistent request budgets have a lifecycle independent of attempt retention and Epochs. */
export class ModelUsageControl {
  readonly #active = new Map<AbortController, string>()
  readonly #listeners = new Set<() => void>()
  #waitingCount: (workspaceId: string) => number = () => 0

  constructor(private readonly database: ClinMeshDatabase, private readonly commands: CommandExecutor,
    deployment: ModelUsagePolicyConfig = { enabled: true, requests: null, automaticRetries: true }) {
    this.#writePolicy('deployment', modelUsagePolicyConfigSchema.parse(deployment), false)
  }

  setWaitingCount(read: (workspaceId: string) => number): void { this.#waitingCount = read }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }

  read(workspaceId: string): ModelUsageControl {
    const workspace = this.#scope(this.#workspace(workspaceId))
    const deployment = this.#scope(this.#row('deployment'))
    const last = z.object({ code: z.string(), scope: z.string(), rejected_at: z.string() }).optional().parse(
      this.database.driver.prepare('SELECT code, scope, rejected_at FROM model_usage_control_rejection WHERE workspace_id = ?').get(workspaceId))
    const inFlight = z.object({ count: z.number() }).parse(this.database.driver.prepare(
      "SELECT COUNT(*) AS count FROM model_usage_attempt WHERE workspace_id = ? AND status = 'in-flight'").get(workspaceId)).count
    return modelUsageControlSchema.parse({ workspace, deployment,
      effective: { enabled: workspace.enabled && deployment.enabled, automaticRetries: workspace.automaticRetries && deployment.automaticRetries },
      waiting: this.#waitingCount(workspaceId), inFlight,
      lastRejection: last === undefined ? null : { code: last.code, scope: last.scope, at: last.rejected_at } })
  }

  update(context: ActorContext, input: ModelUsageControlUpdate, idempotencyKey: string): ModelUsageControl {
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

  reserve(workspaceId: string, attemptId: string, kind: string): void {
    const rows = [this.#row('deployment'), this.#workspace(workspaceId)]
    for (const [index, row] of rows.entries()) {
      const scope = index === 0 ? 'deployment' : 'workspace'
      if (!row.enabled) throw new ModelUsageControlError('MODEL_DISABLED', scope)
      if (kind !== 'initial' && !row.automatic_retries) throw new ModelUsageControlError('MODEL_RETRY_DISABLED', scope)
      if (row.request_limit !== null && row.used + row.reserved >= row.request_limit) throw new ModelUsageControlError('MODEL_REQUEST_LIMIT', scope)
    }
    for (const row of rows) {
      if (row.requests_started_at === null) continue
      this.database.driver.prepare('UPDATE model_usage_control SET reserved = reserved + 1 WHERE scope_id = ?').run(row.scope_id)
      this.database.driver.prepare("INSERT INTO model_usage_request_reservation(attempt_id, scope_id, state) VALUES (?, ?, 'reserved')").run(attemptId, row.scope_id)
    }
  }

  settle(attemptId: string, dispatch: ModelUsageOutcome['dispatch']): void {
    if (dispatch !== 'dispatched' && dispatch !== 'not-dispatched') return
    const rows = z.array(z.object({ scope_id: z.string() })).parse(this.database.driver.prepare(
      "SELECT scope_id FROM model_usage_request_reservation WHERE attempt_id = ? AND state = 'reserved'").all(attemptId))
    for (const row of rows) {
      this.database.driver.prepare('UPDATE model_usage_control SET reserved = reserved - 1, used = used + ? WHERE scope_id = ?')
        .run(dispatch === 'dispatched' ? 1 : 0, row.scope_id)
      this.database.driver.prepare('UPDATE model_usage_request_reservation SET state = ? WHERE attempt_id = ? AND scope_id = ?')
        .run(dispatch === 'dispatched' ? 'used' : 'released', attemptId, row.scope_id)
    }
  }

  reject(workspaceId: string, error: ModelUsageControlError): void {
    try { this.database.driver.prepare(`INSERT INTO model_usage_control_rejection(workspace_id, code, scope, rejected_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET code=excluded.code, scope=excluded.scope, rejected_at=excluded.rejected_at`)
      .run(workspaceId, error.code, error.scope, new Date().toISOString()) } catch { /* An unavailable ledger cannot persist its own failure. */ }
  }

  automaticRetries(workspaceId: string): boolean { return !!(this.#workspace(workspaceId).automatic_retries && this.#row('deployment').automatic_retries) }
  canDispatch(workspaceId: string): boolean {
    try {
      return this.database.driver.transaction(() => {
        this.database.driver.prepare("UPDATE model_usage_control SET version = version WHERE scope_id = 'deployment'").run()
        return [this.#workspace(workspaceId), this.#row('deployment')].every(row => row.enabled
          && (row.request_limit === null || row.used + row.reserved < row.request_limit))
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
  #row(scope: string): PolicyRow { return policyRow.parse(this.database.driver.prepare('SELECT * FROM model_usage_control WHERE scope_id = ?').get(scope)) }
  #workspace(workspaceId: string): PolicyRow {
    const scope = `workspace:${workspaceId}`
    this.database.driver.prepare('INSERT OR IGNORE INTO model_usage_control(scope_id) VALUES (?)').run(scope)
    return this.#row(scope)
  }
  #scope(row: PolicyRow) {
    return { enabled: !!row.enabled, requests: row.request_limit, automaticRetries: !!row.automatic_retries, version: row.version,
      requestsStartedAt: row.requests_started_at, used: row.used, reserved: row.reserved,
      remaining: row.request_limit === null ? null : Math.max(0, row.request_limit - row.used - row.reserved) }
  }
  #writePolicy(scope: string, input: ModelUsagePolicyConfig, bump: boolean): void {
    const current = this.#row(scope)
    const changed = !!current.enabled !== input.enabled || current.request_limit !== input.requests || !!current.automatic_retries !== input.automaticRetries
    this.database.driver.prepare(`UPDATE model_usage_control SET enabled = ?, request_limit = ?, automatic_retries = ?, version = version + ?,
      requests_started_at = CASE WHEN requests_started_at IS NULL AND ? IS NOT NULL THEN ? ELSE requests_started_at END WHERE scope_id = ?`)
      .run(input.enabled ? 1 : 0, input.requests, input.automaticRetries ? 1 : 0, bump || changed ? 1 : 0, input.requests, new Date().toISOString(), scope)
  }
}
