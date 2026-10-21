import { modelUsageRetentionSchema, type ModelUsageRetentionUpdate } from '@clinmesh/contracts/model-usage'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import { ModelUsagePolicyError } from './model-usage-control.ts'
import { liveModelUsageSql } from './model-usage-summary.ts'
import { z } from 'zod'

/** Retention settings and detail lifecycle never change budget counters. */
export class ModelUsageRetention {
  constructor(private readonly database: ClinMeshDatabase, private readonly commands: CommandExecutor) {}

  read(workspaceId: string) {
    this.database.driver.prepare('INSERT OR IGNORE INTO model_usage_retention(workspace_id) VALUES (?)').run(workspaceId)
    return modelUsageRetentionSchema.parse(this.database.driver.prepare(`SELECT days, version,
      compacted_requests AS compactedRequests, last_compacted_at AS lastCompactedAt
      FROM model_usage_retention WHERE workspace_id = ?`).get(workspaceId))
  }

  update(context: ActorContext, input: ModelUsageRetentionUpdate, key: string) {
    if (context.roleCode !== 'administrator') throw new ModelUsagePolicyError('ROLE_NOT_ALLOWED', 403)
    return this.commands.execute({ context, contextRequirement: 'current', idempotencyScope: 'workspace',
      dataSchema: modelUsageRetentionSchema, expectedVersions: {}, idempotencyKey: key, input,
      operation: 'model-usage.retention.update' }, () => {
      if (this.read(context.workspaceId).version !== input.expectedVersion) throw new ModelUsagePolicyError('EXPECTED_VERSION_CONFLICT', 409)
      this.database.driver.prepare('UPDATE model_usage_retention SET days = ?, version = version + 1 WHERE workspace_id = ?')
        .run(input.days, context.workspaceId)
      this.compact(context.workspaceId)
      return { data: this.read(context.workspaceId), effects: [] }
    }).data
  }

  compact(workspaceId: string): void {
    this.database.driver.transaction(() => {
      const policy = this.read(workspaceId)
      if (policy.days === null) return
      const now = new Date().toISOString()
      this.database.driver.exec(`CREATE TEMP TABLE IF NOT EXISTS model_usage_expired_attempt (attempt_id TEXT PRIMARY KEY);
        DELETE FROM model_usage_expired_attempt`)
      const selected = this.database.driver.prepare(`INSERT INTO model_usage_expired_attempt
        SELECT a.attempt_id FROM model_usage_attempt a WHERE a.workspace_id = ?
        AND a.started_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || ? || ' days')
        AND a.status != 'in-flight'
        AND (json_extract(a.record_json, '$.dispatch') = 'not-dispatched' OR (
          json_extract(a.record_json, '$.dispatch') = 'dispatched'
          AND COALESCE(json_extract(a.record_json, '$.accounting.totalTokens'), json_extract(a.record_json, '$.usage.totalTokens')) IS NOT NULL
          AND (COALESCE(json_extract(a.record_json, '$.effectiveCost.cnyMicro'), json_extract(a.record_json, '$.cost.cnyMicro')) IS NOT NULL
            OR COALESCE(json_extract(a.record_json, '$.effectiveCost.status'), json_extract(a.record_json, '$.cost.status'))
              IN ('price-not-configured', 'exchange-rate-not-configured'))))
        AND NOT EXISTS (SELECT 1 FROM model_usage_request_reservation r WHERE r.attempt_id = a.attempt_id AND r.state = 'reserved')
        AND NOT EXISTS (SELECT 1 FROM model_usage_dimension_reservation r WHERE r.attempt_id = a.attempt_id AND r.state = 'reserved')`)
        .run(workspaceId, now, policy.days).changes
      if (selected === 0) return
      this.database.driver.prepare(`INSERT INTO model_usage_daily
        (workspace_id, epoch, date, case_id, feature, provider, requested_model, actual_model, status,
          requests, unknown_requests, known_tokens, unknown_token_requests, cny_micro, unpriced_requests)
        SELECT workspace_id, epoch, date, COALESCE(case_id, ''), feature, provider, requested_model, COALESCE(actual_model, ''), status,
          SUM(requests), SUM(unknownRequests), SUM(knownTokens), SUM(unknownTokenRequests), SUM(cnyMicro), SUM(unpricedRequests)
        FROM (${liveModelUsageSql}) WHERE attempt_id IN (SELECT attempt_id FROM model_usage_expired_attempt)
        GROUP BY workspace_id, epoch, date, COALESCE(case_id, ''), feature, provider, requested_model, COALESCE(actual_model, ''), status
        ON CONFLICT DO UPDATE SET requests = requests + excluded.requests,
          unknown_requests = unknown_requests + excluded.unknown_requests,
          known_tokens = known_tokens + excluded.known_tokens,
          unknown_token_requests = unknown_token_requests + excluded.unknown_token_requests,
          cny_micro = CASE WHEN cny_micro IS NULL AND excluded.cny_micro IS NULL THEN NULL ELSE COALESCE(cny_micro, 0) + COALESCE(excluded.cny_micro, 0) END,
          unpriced_requests = unpriced_requests + excluded.unpriced_requests`).run()
      this.database.driver.prepare(`INSERT INTO model_usage_correction_audit(attempt_id, workspace_id, evidence_json)
        SELECT attempt_id, workspace_id, json_object('usage', json_extract(record_json, '$.usage'),
          'cost', json_extract(record_json, '$.cost'), 'priceSnapshot', json_extract(record_json, '$.priceSnapshot'),
          'corrections', json_extract(record_json, '$.corrections'))
        FROM model_usage_attempt WHERE attempt_id IN (SELECT attempt_id FROM model_usage_expired_attempt)
          AND json_array_length(record_json, '$.corrections') > 0`).run()
      // A Command receipt must not provide a second copy of expired request details.
      this.database.driver.prepare(`UPDATE command_receipt SET response_json = json_set(response_json, '$.data',
        json_object('attemptId', json_extract(response_json, '$.data.id'), 'detailExpired', json('true')))
        WHERE workspace_id = ? AND operation IN ('model-usage.reconcile', 'model-usage.reprice')
          AND json_extract(response_json, '$.data.id') IN (SELECT attempt_id FROM model_usage_expired_attempt)`).run(workspaceId)
      for (const table of ['model_usage_request_reservation', 'model_usage_dimension_reservation', 'model_usage_attempt']) {
        this.database.driver.prepare(`DELETE FROM ${table} WHERE attempt_id IN (SELECT attempt_id FROM model_usage_expired_attempt)`).run()
      }
      this.database.driver.prepare(`UPDATE model_usage_retention SET compacted_requests = compacted_requests + ?, last_compacted_at = ?
        WHERE workspace_id = ?`).run(selected, now, workspaceId)
      this.database.driver.exec('DELETE FROM model_usage_expired_attempt')
    })()
  }

  compactAll(): void {
    const workspaces = z.array(z.object({ workspace_id: z.string() })).parse(this.database.driver.prepare(
      'SELECT DISTINCT workspace_id FROM model_usage_attempt').all())
    for (const workspace of workspaces) this.compact(workspace.workspace_id)
  }
}
