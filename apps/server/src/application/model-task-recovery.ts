import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { ChatCompletionRequestControlError, ChatCompletionsError, type JsonChatCompletionInput, type JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { ModelUsageControlError, modelUsageControlFailure } from './model-usage-control.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'

const stepSchema = z.object({ status: z.enum(['pending', 'dispatching', 'blocked', 'succeeded', 'unknown']),
  request_count: z.number(), repair_count: z.number(), rate_limit_count: z.number(),
  blocked_kind: z.enum(['initial', 'format-repair', 'rate-limit-retry']).nullable(), blocked_code: z.string().nullable(), result_json: z.string().nullable() })
const resultSchema = z.object({ content: z.string(), model: z.string() }).strict()
export class ModelTaskOutcomeUnknownError extends Error {
  constructor(cause?: unknown) { super('The model task has an unresolved request', { cause }); this.name = 'ModelTaskOutcomeUnknownError' }
}
export function modelTaskOutcomeUnknown(error: unknown): boolean {
  const seen = new Set<unknown>()
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof ModelTaskOutcomeUnknownError) return true
    seen.add(error); error = error.cause
  }
  return false
}
export function modelControlWaitingCount(database: ClinMeshDatabase, workspaceId: string): number {
  return z.object({ count: z.number() }).parse(database.driver.prepare(`SELECT COUNT(*) AS count FROM (
    SELECT s.epoch, s.task_id FROM model_task_step s WHERE s.workspace_id = ? AND s.status = 'blocked'
      AND (EXISTS (SELECT 1 FROM patient_persona_job j WHERE j.workspace_id = s.workspace_id AND j.job_id = s.task_id AND j.status IN ('queued', 'running'))
        OR EXISTS (SELECT 1 FROM laboratory_service_publication_job j WHERE j.workspace_id = s.workspace_id AND j.epoch = s.epoch AND j.job_id = s.task_id AND j.status IN ('queued', 'running')))
    UNION SELECT wait.epoch, wait.event_id FROM model_task_wait wait JOIN outbox_event event
      ON event.workspace_id = wait.workspace_id AND event.epoch = wait.epoch AND event.event_id = wait.event_id
      WHERE wait.workspace_id = ? AND event.status IN ('failed', 'claimed')
    UNION SELECT epoch, attempt_id FROM model_reply_wait WHERE workspace_id = ? AND deadline_at > ?
  ) pending JOIN workspace w ON w.active_epoch = pending.epoch
    JOIN workspace_epoch e ON e.workspace_id = w.workspace_id AND e.epoch = w.active_epoch AND e.state = 'active'
    WHERE w.workspace_id = ?`).get(workspaceId, workspaceId, workspaceId, new Date().toISOString(), workspaceId)).count
}

/** Owns only private execution results; authorization and publishing stay with each business service. */
export class ModelTaskRecovery {
  constructor(private readonly database: ClinMeshDatabase, private readonly control: {
    canDispatch(workspaceId: string): boolean; automaticRetries(workspaceId: string): boolean
  }, private readonly dsh = false) {
    database.driver.prepare("UPDATE model_task_step SET status = 'unknown' WHERE status = 'dispatching'").run()
  }

  provider(provider: JsonChatCompletionsProvider): JsonChatCompletionsProvider {
    return { ...(provider.supportsRequestControl === undefined ? {} : { supportsRequestControl: provider.supportsRequestControl }),
      ...(provider.supportsUsageAccounting === undefined ? {} : { supportsUsageAccounting: provider.supportsUsageAccounting }),
      ...(provider.resolveModel === undefined ? {} : { resolveModel: (model, signal) => provider.resolveModel!(model, signal) }),
      completeJson: async input => {
        try { return await this.#complete(provider, input) }
        catch (error) {
          if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('SQLITE_')) {
            throw new ModelUsageControlError('MODEL_LEDGER_UNAVAILABLE', 'workspace')
          }
          throw error
        }
      } }
  }

  ready(workspaceId: string, taskId: string): boolean {
    if (!this.control.canDispatch(workspaceId)) return false
    const retry = this.database.driver.prepare(`SELECT 1 FROM model_task_step WHERE workspace_id = ? AND task_id = ?
      AND status = 'blocked' AND blocked_code = 'MODEL_RETRY_DISABLED'`).get(workspaceId, taskId)
    return retry === undefined || this.control.automaticRetries(workspaceId)
  }

  async #complete(provider: JsonChatCompletionsProvider, input: JsonChatCompletionInput) {
    const context = input.usageContext
    if (context === undefined) return provider.completeJson(input)
    const key = [context.workspaceId, context.epoch, context.taskId,
      canonicalJsonHash({ stage: context.stage, schema: input.schemaName, model: input.model,
        jsonSchema: input.jsonSchema, systemPrompt: input.systemPrompt, userPayload: input.userPayload })] as const
    this.database.driver.prepare(`INSERT OR IGNORE INTO model_task_step(workspace_id, epoch, task_id, step_key, status)
      VALUES (?, ?, ?, ?, 'pending')`).run(...key)
    const read = () => stepSchema.parse(this.database.driver.prepare(`SELECT * FROM model_task_step
      WHERE workspace_id = ? AND epoch = ? AND task_id = ? AND step_key = ?`).get(...key))
    const previous = read()
    if (previous.status === 'succeeded') return resultSchema.parse(JSON.parse(previous.result_json!))
    if (previous.status === 'unknown' || previous.status === 'dispatching') throw new ModelTaskOutcomeUnknownError()
    let outstanding = false
    let checkpointPending = false
    let attemptedKind = previous.blocked_kind ?? input.usageKind ?? 'initial'
    const request = { ...input,
      usageKind: attemptedKind,
      onBeforeUsageRequest: (metadata: { kind: 'initial' | 'format-repair' | 'rate-limit-retry' }) => {
        attemptedKind = metadata.kind
        input.onBeforeUsageRequest?.(metadata)
      },
      onBeforeRequest: () => {
        const row = read()
        if (row.request_count > 0 && !this.control.automaticRetries(context.workspaceId)) {
          throw new ModelUsageControlError('MODEL_RETRY_DISABLED', 'workspace')
        }
        const structuredLimit = input.maxAttempts ?? (this.dsh ? 2 : 3)
        if (row.request_count >= structuredLimit + (this.dsh ? 1 : 0)
          || attemptedKind === 'rate-limit-retry' && row.rate_limit_count >= 1
          || attemptedKind === 'format-repair' && row.repair_count >= structuredLimit - 1) {
          throw new ChatCompletionsError('AI_RESPONSE_INVALID', 'The original structured response attempt budget was exhausted')
        }
        input.onBeforeRequest?.()
        this.database.driver.prepare(`UPDATE model_task_step SET status = 'dispatching', request_count = request_count + 1,
          repair_count = repair_count + ?, rate_limit_count = rate_limit_count + ?, blocked_code = NULL
          WHERE workspace_id = ? AND epoch = ? AND task_id = ? AND step_key = ?`)
          .run(attemptedKind === 'format-repair' ? 1 : 0, attemptedKind === 'rate-limit-retry' ? 1 : 0, ...key)
        outstanding = true
      },
      onRequestComplete: () => {
        input.onRequestComplete?.()
        outstanding = false
        // Keep the durable dispatch marker until a result or proven refusal is saved.
        // A crash between a completed response and checkpoint persistence must remain unknown.
      },
    }
    try {
      if (provider.supportsRequestControl !== true) request.onBeforeRequest()
      const result = await provider.completeJson(request)
      if (provider.supportsRequestControl !== true) request.onRequestComplete()
      const checkpoint = resultSchema.parse(result)
      checkpointPending = true
      this.database.driver.prepare(`UPDATE model_task_step SET status = 'succeeded', result_json = ?, blocked_code = NULL
        WHERE workspace_id = ? AND epoch = ? AND task_id = ? AND step_key = ?`).run(JSON.stringify(checkpoint), ...key)
      return result
    } catch (error) {
      if (provider.supportsRequestControl !== true && error instanceof ChatCompletionsError && error.code !== 'AI_TIMEOUT'
        && (error.code !== 'AI_REQUEST_FAILED' || error.httpStatus !== undefined)) outstanding = false
      // A refusal before the next dispatch does not make an earlier incomplete request safe to repeat.
      const blocked = modelUsageControlFailure(error)
      if (error instanceof ChatCompletionRequestControlError && error.requestKind !== undefined) attemptedKind = error.requestKind
      if (outstanding || checkpointPending) {
        try {
          this.database.driver.prepare(`UPDATE model_task_step SET status = 'unknown'
            WHERE workspace_id = ? AND epoch = ? AND task_id = ? AND step_key = ?`).run(...key)
        } catch { /* The durable dispatch marker remains conservative if storage is unavailable. */ }
        throw new ModelTaskOutcomeUnknownError(error)
      }
      this.database.driver.prepare(`UPDATE model_task_step SET status = ?, blocked_kind = ?, blocked_code = ?
        WHERE workspace_id = ? AND epoch = ? AND task_id = ? AND step_key = ?`)
        .run(blocked === undefined ? 'pending' : 'blocked', attemptedKind,
          blocked?.code ?? null, ...key)
      throw error
    }
  }

  defer(event: OutboxHandlerInput, error: unknown): OutboxHandlerResult | undefined {
    if (modelTaskOutcomeUnknown(error)) return { status: 'ambiguous' }
    const failure = modelUsageControlFailure(error)
    if (failure === undefined) return undefined
    this.database.driver.prepare(`INSERT INTO model_task_wait(workspace_id, epoch, event_id, reason) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, epoch, event_id) DO UPDATE SET reason = excluded.reason`)
      .run(event.workspaceId, event.epoch, event.eventId, failure.code)
    return { status: 'model-blocked' }
  }

  wake(): void {
    const rows = z.array(z.object({ workspace_id: z.string(), epoch: z.string(), event_id: z.string(), reason: z.string() })).parse(
      this.database.driver.prepare('SELECT * FROM model_task_wait LIMIT 100').all())
    for (const row of rows) {
      if (!this.control.canDispatch(row.workspace_id)
        || row.reason === 'MODEL_RETRY_DISABLED' && !this.control.automaticRetries(row.workspace_id)) continue
      const changed = this.database.driver.prepare(`UPDATE outbox_event SET next_attempt_at = ?
        WHERE workspace_id = ? AND epoch = ? AND event_id = ? AND status = 'failed'`)
        .run(new Date().toISOString(), row.workspace_id, row.epoch, row.event_id)
      // A policy update can arrive while the refusal's outbox lease is still completing.
      if (changed.changes === 0 && this.database.driver.prepare(`SELECT 1 FROM outbox_event
        WHERE workspace_id = ? AND epoch = ? AND event_id = ? AND status = 'claimed'`)
        .get(row.workspace_id, row.epoch, row.event_id) !== undefined) continue
      this.database.driver.prepare('DELETE FROM model_task_wait WHERE workspace_id = ? AND epoch = ? AND event_id = ?')
        .run(row.workspace_id, row.epoch, row.event_id)
    }
  }
}
