import type { ClinMeshDatabase } from './database.ts'
import type { RepositoryContext } from './fhir-repository.ts'
import { v7 as uuidv7 } from 'uuid'

export interface OutboxEventView {
  attempt: number
  correlationId?: string
  dedupKey: string
  epoch: string
  eventId: string
  kind: string
  payload: unknown
  scenarioRunId: string
  status: 'queued' | 'claimed' | 'completed' | 'failed' | 'ambiguous' | 'abandoned'
  workspaceId: string
}

export interface OutboxClaim extends OutboxEventView {
  correlationId: string
  leaseOwner: string
  leaseVersion: number
  status: 'claimed'
}

export interface ClaimOptions {
  leaseDurationMs: number
  leaseOwner: string
  now: Date
}

export type OutboxCompletion = 'ambiguous' | 'completed' | 'retryable-failed'

interface OutboxRow {
  attempt: number
  correlation_id: string | null
  dedup_key: string
  epoch: string
  event_id: string
  kind: string
  lease_owner: string | null
  lease_version: number
  payload_json: string
  scenario_run_id: string
  status: OutboxEventView['status']
  workspace_id: string
}

function toView(row: OutboxRow): OutboxEventView {
  return {
    attempt: row.attempt,
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    dedupKey: row.dedup_key,
    epoch: row.epoch,
    eventId: row.event_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    scenarioRunId: row.scenario_run_id,
    status: row.status,
    workspaceId: row.workspace_id,
  }
}

export class OutboxRepository {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  list(context: RepositoryContext): OutboxEventView[] {
    const rows = this.#database.driver.prepare(`
      SELECT workspace_id, epoch, event_id, scenario_run_id, kind, dedup_key, payload_json, status,
        attempt, correlation_id, lease_owner, lease_version
      FROM outbox_event
      WHERE workspace_id = ? AND epoch = ?
      ORDER BY created_at, event_id
    `).all(context.workspaceId, context.epoch) as OutboxRow[]
    return rows.map(toView)
  }

  claimNext(options: ClaimOptions): OutboxClaim | undefined {
    const now = options.now.toISOString()
    const leasedUntil = new Date(options.now.getTime() + options.leaseDurationMs).toISOString()
    this.#database.driver.exec('BEGIN IMMEDIATE')
    try {
      const candidate = this.#database.driver.prepare(`
        SELECT event.*
        FROM outbox_event AS event
        JOIN workspace
          ON workspace.workspace_id = event.workspace_id
         AND workspace.active_epoch = event.epoch
        JOIN workspace_epoch AS epoch
          ON epoch.workspace_id = event.workspace_id
         AND epoch.epoch = event.epoch
         AND epoch.state = 'active'
        WHERE (
          (event.status IN ('queued', 'failed') AND event.next_attempt_at <= ?)
          OR (event.status = 'claimed' AND event.leased_until < ?)
        )
        ORDER BY event.next_attempt_at, event.created_at, event.event_id
        LIMIT 1
      `).get(now, now) as (OutboxRow & { epoch: string; workspace_id: string }) | undefined
      if (candidate === undefined) {
        this.#database.driver.exec('COMMIT')
        return undefined
      }

      const correlationId = candidate.correlation_id ?? uuidv7()
      const nextLeaseVersion = candidate.lease_version + 1
      const update = this.#database.driver.prepare(`
        UPDATE outbox_event
        SET status = 'claimed',
          attempt = attempt + 1,
          correlation_id = ?,
          lease_owner = ?,
          lease_version = ?,
          leased_until = ?,
          updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND event_id = ?
          AND lease_version = ? AND status = ?
      `).run(
        correlationId,
        options.leaseOwner,
        nextLeaseVersion,
        leasedUntil,
        now,
        candidate.workspace_id,
        candidate.epoch,
        candidate.event_id,
        candidate.lease_version,
        candidate.status,
      )
      if (update.changes !== 1) throw new Error('The outbox lease was claimed concurrently')
      this.#database.driver.exec('COMMIT')
      return {
        ...toView({
          ...candidate,
          attempt: candidate.attempt + 1,
          correlation_id: correlationId,
          lease_owner: options.leaseOwner,
          lease_version: nextLeaseVersion,
          status: 'claimed',
        }),
        correlationId,
        leaseOwner: options.leaseOwner,
        leaseVersion: nextLeaseVersion,
        status: 'claimed',
      }
    } catch (error) {
      if (this.#database.driver.inTransaction) this.#database.driver.exec('ROLLBACK')
      throw error
    }
  }

  complete(
    claim: OutboxClaim,
    completion: OutboxCompletion,
    options: { maxAttempts: number; now: Date; retryDelayMs: number },
  ): OutboxEventView {
    const now = options.now.toISOString()
    const retryable = completion === 'retryable-failed' && claim.attempt < options.maxAttempts
    const status: OutboxEventView['status'] = completion === 'completed'
      ? 'completed'
      : completion === 'ambiguous'
        ? 'ambiguous'
        : 'failed'
    const nextAttemptAt = retryable
      ? new Date(options.now.getTime() + options.retryDelayMs).toISOString()
      : '9999-12-31T23:59:59.999Z'

    this.#database.driver.exec('BEGIN IMMEDIATE')
    try {
      const active = this.#database.driver.prepare(`
        SELECT 1
        FROM workspace
        JOIN workspace_epoch AS epoch
          ON epoch.workspace_id = workspace.workspace_id
         AND epoch.epoch = workspace.active_epoch
        WHERE workspace.workspace_id = ?
          AND workspace.active_epoch = ?
          AND epoch.state = 'active'
      `).get(claim.workspaceId, claim.epoch)
      const finalStatus = active === undefined ? 'abandoned' : status
      const update = this.#database.driver.prepare(`
        UPDATE outbox_event
        SET status = ?, next_attempt_at = ?, lease_owner = NULL,
          leased_until = NULL, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND event_id = ?
          AND status = 'claimed' AND lease_owner = ? AND lease_version = ?
      `).run(
        finalStatus,
        nextAttemptAt,
        now,
        claim.workspaceId,
        claim.epoch,
        claim.eventId,
        claim.leaseOwner,
        claim.leaseVersion,
      )
      if (update.changes !== 1) {
        const current = this.#database.driver.prepare(`
          SELECT status FROM outbox_event
          WHERE workspace_id = ? AND epoch = ? AND event_id = ?
        `).get(claim.workspaceId, claim.epoch, claim.eventId) as {
          status: OutboxEventView['status']
        } | undefined
        if (current?.status === 'abandoned') {
          this.#database.driver.exec('COMMIT')
          return { ...claim, status: 'abandoned' }
        }
        throw new Error('The outbox lease is no longer owned by this dispatcher')
      }
      this.#database.driver.exec('COMMIT')
      return { ...claim, status: finalStatus }
    } catch (error) {
      if (this.#database.driver.inTransaction) this.#database.driver.exec('ROLLBACK')
      throw error
    }
  }
}
