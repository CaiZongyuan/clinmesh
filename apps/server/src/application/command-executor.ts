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

const actorIdentifierSystem = 'https://caizongyuan.github.io/clinmesh/identifier/actor'
const practitionerIdentifierSystem = 'https://caizongyuan.github.io/clinmesh/identifier/practitioner'
const practitionerRoleSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/practitioner-role'

function authenticatedActorAgent(context: ActorContext) {
  return {
    type: { text: 'Authenticated actor' },
    who: {
      identifier: {
        system: actorIdentifierSystem,
        value: context.actorId,
      },
    },
  }
}

function actingPractitionerRole(context: ActorContext) {
  return {
    ...(context.practitionerRoleId === undefined
      ? {}
      : {
          coding: [{
            code: context.practitionerRoleId,
            display: context.roleCode,
            system: practitionerRoleSystem,
          }],
        }),
    text: context.roleCode,
  }
}

export function provenanceAgents(context: ActorContext, responsibility: string) {
  return [authenticatedActorAgent(context), ...(context.practitionerId === undefined
    ? []
    : [{
        type: { text: 'Acting practitioner' },
        role: [actingPractitionerRole(context), { text: responsibility }],
        who: { reference: `Practitioner/${context.practitionerId}` },
        ...(context.organizationId === undefined
          ? {}
          : { onBehalfOf: { reference: `Organization/${context.organizationId}` } }),
      }])]
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
  authorize?: () => void
  context: ActorContext
  contextRequirement?: 'active' | 'current' | 'known'
  dataSchema: z.ZodType<Data>
  expectedVersions: Record<string, string>
  idempotencyScope?: 'epoch' | 'workspace'
  idempotencyKey: string
  input: Input
  mapExpectedVersionConflict?: (error: ExpectedVersionConflictError) => Error
  operation: string
  replay?: 'reject' | 'return'
  storedResponse?: (response: CommandResponse<Data>) => unknown
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

export class CommandReceiptNotFoundError extends Error {
  readonly code = 'COMMAND_RECEIPT_NOT_FOUND'
  readonly status = 404
}

const virtualTimeRowSchema = z.object({
  virtual_time: z.iso.datetime({ offset: true }),
}).strict()

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

export class ExpectedVersionConflictError extends Error {
  readonly code = 'EXPECTED_VERSION_CONFLICT'
  readonly currentVersion: string | undefined
  readonly expectedVersion: string
  readonly reference: string | undefined

  constructor(
    message: string,
    details: {
      currentVersion?: string
      expectedVersion: string
      reference?: string
    },
  ) {
    super(message)
    this.name = 'ExpectedVersionConflictError'
    this.currentVersion = details.currentVersion
    this.expectedVersion = details.expectedVersion
    this.reference = details.reference
  }
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
      actingContext: {
        locationId: context.locationId,
        organizationId: context.organizationId,
        practitionerId: context.practitionerId,
        practitionerRoleId: context.practitionerRoleId,
        roleCode: context.roleCode,
      },
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
        if (invocation.replay === 'reject') {
          throw new CommandConflictError('The one-time command result cannot be replayed')
        }
        const response = storedCommandResponseSchema.extend({
          data: invocation.dataSchema,
        }).parse(JSON.parse(existing.response_json))
        this.#database.driver.exec('COMMIT')
        return response
      }

      if (invocation.contextRequirement === 'current') {
        this.#workspaces.assertCurrent(context, context.scenarioRunId)
      } else if (invocation.contextRequirement === 'known') {
        this.#workspaces.assertKnown(context, context.scenarioRunId)
      } else {
        this.#workspaces.assertActive(context, context.scenarioRunId)
      }

      invocation.authorize?.()
      this.#checkExpectedVersions(context, invocation.expectedVersions)
      this.#database.driver.prepare(`
        INSERT INTO command_receipt (
          workspace_id, epoch, actor_id, practitioner_role_id, operation, idempotency_key,
          request_hash, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'executing', ?, ?)
      `).run(
        context.workspaceId,
        context.epoch,
        context.actorId,
        context.practitionerRoleId ?? null,
        invocation.operation,
        invocation.idempotencyKey,
        requestHash,
        now,
        now,
      )

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
      const traceId = this.#appendTrace(
        context,
        invocation.operation,
        result.effects,
        now,
        'success',
        requestId,
      )
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
        SET status = 'completed', response_json = ?, request_id = ?, audit_id = ?,
          trace_id = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND actor_id = ?
          AND operation = ? AND idempotency_key = ?
      `).run(
        JSON.stringify(invocation.storedResponse?.(response) ?? response),
        requestId,
        auditId,
        traceId,
        now,
        ...receiptKey,
      )
      this.#database.driver.exec('COMMIT')
      return response
    } catch (error) {
      if (this.#database.driver.inTransaction) this.#database.driver.exec('ROLLBACK')
      this.#recordFailedAttempt(context, invocation.operation, requestHash, now)
      if (
        error instanceof ExpectedVersionConflictError
        && invocation.mapExpectedVersionConflict !== undefined
      ) {
        throw invocation.mapExpectedVersionConflict(error)
      }
      throw error
    }
  }

  readReceipt(
    context: ActorContext,
    operationId: string,
    idempotencyKey: string,
  ) {
    const row = this.#database.driver.prepare(`
      SELECT response_json, status
      FROM command_receipt
      WHERE workspace_id = ? AND epoch = ? AND actor_id = ?
        AND practitioner_role_id IS ? AND operation = ? AND idempotency_key = ?
    `).get(
      context.workspaceId,
      context.epoch,
      context.actorId,
      context.practitionerRoleId ?? null,
      operationId,
      idempotencyKey,
    ) as Pick<ReceiptRow, 'response_json' | 'status'> | undefined
    if (row === undefined) {
      throw new CommandReceiptNotFoundError('The Command receipt was not found')
    }
    return {
      idempotencyKey,
      operationId,
      ...(row.response_json === null ? {} : { response: JSON.parse(row.response_json) as unknown }),
      status: z.enum(['completed', 'executing']).parse(row.status),
    }
  }

  #checkExpectedVersions(context: RepositoryContext, expectedVersions: Record<string, string>): void {
    for (const [reference, expectedVersion] of Object.entries(expectedVersions)) {
      const match = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9.-]{1,64})$/.exec(reference)
      if (match === null) {
        throw new ExpectedVersionConflictError(
          `Expected version reference is invalid: ${reference}`,
          { expectedVersion },
        )
      }
      const [, resourceType = '', resourceId = ''] = match
      try {
        const resource = this.#fhir.read(context, resourceType, resourceId)
        if (resource.meta?.versionId !== expectedVersion) {
          throw new ExpectedVersionConflictError(
            `Expected ${reference} version ${expectedVersion}`,
            {
              ...(resource.meta?.versionId === undefined
                ? {}
                : { currentVersion: resource.meta.versionId }),
              expectedVersion,
              reference,
            },
          )
        }
      } catch (error) {
        if (error instanceof ExpectedVersionConflictError) throw error
        if (error instanceof FhirRepositoryError) {
          throw new ExpectedVersionConflictError(
            `Expected resource is unavailable: ${reference}`,
            { expectedVersion, reference },
          )
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
      practitionerId: context.practitionerId,
      practitionerRoleId: context.practitionerRoleId,
      previousHash: head.hash,
      requestHash,
      roleCode: context.roleCode,
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
        ...authenticatedActorAgent(context),
        requestor: true,
      }, ...(context.practitionerId === undefined
        ? []
        : [{
            type: { text: 'Acting practitioner' },
            role: [actingPractitionerRole(context)],
            who: {
              identifier: {
                system: practitionerIdentifierSystem,
                value: context.practitionerId,
              },
            },
            requestor: false,
          }])],
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
    requestId?: string,
  ): string {
    const virtualTime = virtualTimeRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT virtual_time FROM scenario_epoch_state
        WHERE workspace_id = ? AND epoch = ?
      `).get(context.workspaceId, context.epoch),
    )
    const virtualTimestamp = virtualTime?.virtual_time ?? timestamp
    const row = this.#database.driver.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM action_trace
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
    `).get(context.workspaceId, context.epoch, context.scenarioRunId) as { sequence: number }
    const traceId = uuidv7()
    this.#database.driver.prepare(`
      INSERT INTO action_trace (
        workspace_id, epoch, scenario_run_id, trace_id, sequence,
        actor_id, operation, outcome, effect_json, virtual_timestamp, request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      context.scenarioRunId,
      traceId,
      row.sequence + 1,
      context.actorId,
      operation,
      outcome,
      JSON.stringify(effects),
      virtualTimestamp,
      requestId ?? null,
    )
    return traceId
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
