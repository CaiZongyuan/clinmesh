import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { isSupportedResourceType } from '../fhir/capabilities.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import {
  type FhirRepository,
  FhirRepositoryError,
  type RepositoryContext,
} from '../infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../infrastructure/sqlite/workspace-repository.ts'

export interface ActorContext extends RepositoryContext {
  actorId: string
  locationId?: string
  organizationId?: string
  practitionerId?: string
  practitionerRoleId?: string
  roleCode: string
  scenarioRunId: string
}

export interface CommandEffect {
  kind: 'created' | 'updated'
  reference: string
  versionId: string
}

export interface CommandHandlerResult<Data> {
  data: Data
  effects: CommandEffect[]
  warnings?: string[]
}

export interface CommandResponse<Data> extends CommandHandlerResult<Data> {
  auditId: string
  requestId: string
  warnings: string[]
}

export interface CommandInvocation<Input, Data> {
  context: ActorContext
  dataSchema: z.ZodType<Data>
  expectedVersions: Record<string, string>
  idempotencyScope?: 'epoch' | 'workspace'
  idempotencyKey: string
  input: Input
  operation: string
}

interface EnqueueInput {
  dedupKey: string
  kind: string
  payload: unknown
}

interface CommandExecutorOptions {
  now?: () => Date
}

interface ReceiptRow {
  request_hash: string
  response_json: string | null
  status: string
}

const storedCommandResponseSchema = z.object({
  auditId: z.string().min(1),
  data: z.unknown(),
  effects: z.array(z.object({
    kind: z.enum(['created', 'updated']),
    reference: z.string().min(1),
    versionId: z.string().min(1),
  })),
  requestId: z.string().min(1),
  warnings: z.array(z.string()),
})

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

export class CommandConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED'
}

export class CommandTransaction {
  readonly fhir: FhirRepository
  readonly #context: ActorContext
  readonly #database: ClinMeshDatabase
  readonly #now: () => Date

  constructor(
    database: ClinMeshDatabase,
    fhir: FhirRepository,
    context: ActorContext,
    now: () => Date,
  ) {
    this.#database = database
    this.fhir = fhir
    this.#context = context
    this.#now = now
  }

  enqueue(input: EnqueueInput): void {
    const now = this.#now().toISOString()
    const payload = JSON.stringify(canonicalize(input.payload))
    this.#database.driver.prepare(`
      INSERT INTO outbox_event (
        workspace_id, epoch, event_id, scenario_run_id, kind, dedup_key,
        payload_json, payload_hash, status, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      this.#context.workspaceId,
      this.#context.epoch,
      uuidv7(),
      this.#context.scenarioRunId,
      input.kind,
      input.dedupKey,
      payload,
      hashJson(input.payload),
      now,
      now,
      now,
    )
  }
}

export class CommandExecutor {
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository
  readonly #now: () => Date
  readonly #workspaces: WorkspaceRepository

  constructor(
    database: ClinMeshDatabase,
    fhir: FhirRepository,
    options: CommandExecutorOptions = {},
  ) {
    this.#database = database
    this.#fhir = fhir
    this.#now = options.now ?? (() => new Date())
    this.#workspaces = new WorkspaceRepository(database)
  }

  execute<Input, Data>(
    invocation: CommandInvocation<Input, Data>,
    handler: (transaction: CommandTransaction) => CommandHandlerResult<Data>,
  ): CommandResponse<Data> {
    const { context } = invocation
    const requestHash = hashJson({
      expectedVersions: invocation.expectedVersions,
      input: invocation.input,
      operation: invocation.operation,
    })
    const receiptKey = [
      context.workspaceId,
      context.epoch,
      context.actorId,
      invocation.operation,
      invocation.idempotencyKey,
    ] as const
    const now = this.#now().toISOString()

    this.#database.driver.exec('BEGIN IMMEDIATE')
    try {
      const existing = invocation.idempotencyScope === 'workspace'
        ? this.#database.driver.prepare(`
            SELECT request_hash, response_json, status
            FROM command_receipt
            WHERE workspace_id = ? AND actor_id = ?
              AND operation = ? AND idempotency_key = ?
            ORDER BY updated_at DESC
            LIMIT 1
          `).get(
            context.workspaceId,
            context.actorId,
            invocation.operation,
            invocation.idempotencyKey,
          ) as ReceiptRow | undefined
        : this.#database.driver.prepare(`
            SELECT request_hash, response_json, status
            FROM command_receipt
            WHERE workspace_id = ? AND epoch = ? AND actor_id = ?
              AND operation = ? AND idempotency_key = ?
          `).get(...receiptKey) as ReceiptRow | undefined
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash) {
          throw new CommandConflictError('The idempotency key was already used with a different payload')
        }
        if (existing.status !== 'completed' || existing.response_json === null) {
          throw new CommandConflictError('The idempotent command has not reached a replayable result')
        }
        const response = storedCommandResponseSchema.extend({
          data: invocation.dataSchema,
        }).parse(JSON.parse(existing.response_json))
        this.#database.driver.exec('COMMIT')
        return response
      }

      this.#workspaces.assertActive(context, context.scenarioRunId)

      this.#checkExpectedVersions(context, invocation.expectedVersions)
      this.#database.driver.prepare(`
        INSERT INTO command_receipt (
          workspace_id, epoch, actor_id, operation, idempotency_key,
          request_hash, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'executing', ?, ?)
      `).run(...receiptKey, requestHash, now, now)

      const result = handler(new CommandTransaction(this.#database, this.#fhir, context, this.#now))
      const auditId = uuidv7()
      const requestId = uuidv7()
      const response: CommandResponse<Data> = {
        ...result,
        auditId,
        requestId,
        warnings: result.warnings ?? [],
      }
      this.#appendAudit(
        context,
        invocation.operation,
        requestHash,
        auditId,
        now,
        'success',
        result.effects,
      )
      this.#appendTrace(context, invocation.operation, result.effects, now, 'success')
      const insertEffect = this.#database.driver.prepare(`
        INSERT INTO command_effect (
          workspace_id, epoch, actor_id, operation, idempotency_key,
          effect_index, kind, reference, version_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      result.effects.forEach((effect, index) => {
        insertEffect.run(...receiptKey, index, effect.kind, effect.reference, effect.versionId)
      })
      this.#database.driver.prepare(`
        UPDATE command_receipt
        SET status = 'completed', response_json = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND actor_id = ?
          AND operation = ? AND idempotency_key = ?
      `).run(JSON.stringify(response), now, ...receiptKey)
      this.#database.driver.exec('COMMIT')
      return response
    } catch (error) {
      if (this.#database.driver.inTransaction) this.#database.driver.exec('ROLLBACK')
      this.#recordFailedAttempt(context, invocation.operation, requestHash, now)
      throw error
    }
  }

  #checkExpectedVersions(context: RepositoryContext, expectedVersions: Record<string, string>): void {
    for (const [reference, expectedVersion] of Object.entries(expectedVersions)) {
      const match = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9.-]{1,64})$/.exec(reference)
      if (match === null) throw new CommandConflictError(`Expected version reference is invalid: ${reference}`)
      const [, resourceType = '', resourceId = ''] = match
      try {
        const resource = this.#fhir.read(context, resourceType, resourceId)
        if (resource.meta?.versionId !== expectedVersion) {
          throw new CommandConflictError(`Expected ${reference} version ${expectedVersion}`)
        }
      } catch (error) {
        if (error instanceof CommandConflictError) throw error
        if (error instanceof FhirRepositoryError) {
          throw new CommandConflictError(`Expected resource is unavailable: ${reference}`)
        }
        throw error
      }
    }
  }

  #appendAudit(
    context: ActorContext,
    operation: string,
    requestHash: string,
    auditId: string,
    timestamp: string,
    outcome: 'failed' | 'success',
    effects: CommandEffect[],
  ): void {
    const head = this.#database.driver.prepare(`
      SELECT sequence, hash FROM audit_head WHERE workspace_id = ? AND epoch = ?
    `).get(context.workspaceId, context.epoch) as { hash: string; sequence: number }
    const sequence = head.sequence + 1
    const currentHash = hashJson({
      actorId: context.actorId,
      auditId,
      operation,
      previousHash: head.hash,
      requestHash,
      sequence,
      timestamp,
    })
    this.#database.driver.prepare(`
      INSERT INTO audit_log (
        workspace_id, epoch, audit_id, sequence, previous_hash, current_hash,
        real_timestamp, actor_id, practitioner_id, practitioner_role_id,
        role_code, scenario_run_id, operation, outcome, request_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      auditId,
      sequence,
      head.hash,
      currentHash,
      timestamp,
      context.actorId,
      context.practitionerId ?? null,
      context.practitionerRoleId ?? null,
      context.roleCode,
      context.scenarioRunId,
      operation,
      outcome,
      requestHash,
    )
    const update = this.#database.driver.prepare(`
      UPDATE audit_head SET sequence = ?, hash = ?
      WHERE workspace_id = ? AND epoch = ? AND sequence = ? AND hash = ?
    `).run(sequence, currentHash, context.workspaceId, context.epoch, head.sequence, head.hash)
    if (update.changes !== 1) throw new CommandConflictError('The audit chain advanced concurrently')
    this.#fhir.createProjection(context, {
      resourceType: 'AuditEvent',
      id: auditId,
      code: {
        coding: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/audit-operation',
          code: operation,
        }],
        text: operation,
      },
      action: 'E',
      severity: outcome === 'success' ? 'notice' : 'error',
      recorded: timestamp,
      outcome: {
        code: {
          system: 'http://terminology.hl7.org/CodeSystem/audit-event-outcome',
          code: outcome === 'success' ? '0' : '8',
          display: outcome === 'success' ? 'Success' : 'Serious failure',
        },
      },
      agent: [{
        type: { text: context.roleCode },
        who: {
          identifier: {
            system: context.practitionerId === undefined
              ? 'https://caizongyuan.github.io/clinmesh/identifier/actor'
              : 'https://caizongyuan.github.io/clinmesh/identifier/practitioner',
            value: context.practitionerId ?? context.actorId,
          },
        },
        requestor: true,
      }],
      source: {
        observer: {
          identifier: {
            system: 'https://caizongyuan.github.io/clinmesh/identifier/organization',
            value: context.organizationId ?? 'organization-clinmesh',
          },
        },
      },
      entity: effects.map(effect => ({
        role: { text: effect.kind },
        what: isSupportedResourceType(effect.reference.split('/', 1)[0] ?? '')
          ? { reference: effect.reference }
          : {
              identifier: {
                system: 'https://caizongyuan.github.io/clinmesh/identifier/command-effect-reference',
                value: effect.reference,
              },
            },
      })),
    })
  }

  #appendTrace(
    context: ActorContext,
    operation: string,
    effects: CommandEffect[],
    timestamp: string,
    outcome: 'failed' | 'success',
  ): void {
    const row = this.#database.driver.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM action_trace
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
    `).get(context.workspaceId, context.epoch, context.scenarioRunId) as { sequence: number }
    this.#database.driver.prepare(`
      INSERT INTO action_trace (
        workspace_id, epoch, scenario_run_id, trace_id, sequence,
        actor_id, operation, outcome, effect_json, virtual_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      context.scenarioRunId,
      uuidv7(),
      row.sequence + 1,
      context.actorId,
      operation,
      outcome,
      JSON.stringify(effects),
      timestamp,
    )
  }

  #recordFailedAttempt(
    context: ActorContext,
    operation: string,
    requestHash: string,
    timestamp: string,
  ): void {
    this.#database.driver.exec('BEGIN IMMEDIATE')
    try {
      this.#workspaces.assertKnown(context, context.scenarioRunId)
      this.#appendAudit(context, operation, requestHash, uuidv7(), timestamp, 'failed', [])
      this.#appendTrace(context, operation, [], timestamp, 'failed')
      this.#database.driver.exec('COMMIT')
    } catch (auditError) {
      if (this.#database.driver.inTransaction) this.#database.driver.exec('ROLLBACK')
      throw new Error('The command failed and its audit attempt could not be persisted', {
        cause: auditError,
      })
    }
  }
}
