import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  agentExecutionProofPayloadSchema,
  agentHumanRoleCodeSchema,
  agentPageContextClaimSchema,
  agentPageContextSnapshotSchema,
  agentToolsForContext,
  agentViewsForRole,
  agentToolAuthorizationRequestSchema,
  agentToolAuthorizationResponseSchema,
  agentToolResultRequestSchema,
  agentToolCatalog,
  agentViewIdSchema,
  type AgentPageContextClaim,
  type AgentPageContextSnapshot,
} from '@clinmesh/contracts/agent'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ActorContext } from './command-executor.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'

const PAGE_CONTEXT_TTL_MS = 5 * 60_000

const tokenPayloadSchema = z.object({
  actorId: z.string().min(1),
  contextId: z.string().min(1),
  epoch: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  roleCode: agentHumanRoleCodeSchema,
  version: z.literal(1),
  workspaceId: z.string().min(1),
}).strict()

const receiptPayloadSchema = z.object({
  callId: z.string().min(1),
  contextId: z.string().min(1),
  dshSessionId: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  operationId: z.string().min(1),
  version: z.literal(1),
}).strict()

interface CreatePageContextInput {
  actor: ActorContext
  claim: AgentPageContextClaim
  userAccountId: string
}

interface AgentIntegrationServiceOptions {
  now?: () => Date
  secret: string
}

export class AgentIntegrationError extends Error {
  constructor(
    readonly code:
      | 'AGENT_CALL_NOT_PENDING'
      | 'AGENT_CALL_REPLAYED'
      | 'AGENT_CONTEXT_EXPIRED'
      | 'AGENT_CONTEXT_INVALID'
      | 'AGENT_OPERATION_NOT_ALLOWED'
      | 'AGENT_PROOF_INVALID'
      | 'AGENT_VIEW_NOT_ALLOWED',
    message: string,
    readonly status: 401 | 403 | 409,
  ) {
    super(message)
    this.name = 'AgentIntegrationError'
  }
}

export class AgentIntegrationService {
  readonly #database: ClinMeshDatabase
  readonly #now: () => Date
  readonly #secret: string

  constructor(database: ClinMeshDatabase, options: AgentIntegrationServiceOptions) {
    this.#database = database
    this.#now = options.now ?? (() => new Date())
    this.#secret = options.secret
  }

  createPageContext(input: CreatePageContextInput): {
    snapshot: AgentPageContextSnapshot
    token: string
  } {
    const claim = agentPageContextClaimSchema.parse(input.claim)
    const roleCode = agentHumanRoleCodeSchema.parse(input.actor.roleCode)
    const viewId = agentViewIdSchema.parse(claim.viewId)
    if (!agentViewsForRole(roleCode).includes(viewId)) {
      throw new AgentIntegrationError(
        'AGENT_VIEW_NOT_ALLOWED',
        'The selected Practitioner Role cannot bind this ClinMesh view',
        403,
      )
    }
    if (input.actor.practitionerRoleId === undefined) {
      throw new AgentIntegrationError(
        'AGENT_CONTEXT_INVALID',
        'A Practitioner Role is required for a DSH Agent context',
        403,
      )
    }

    const now = this.#now()
    const issuedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + PAGE_CONTEXT_TTL_MS).toISOString()
    const contextId = uuidv7()
    const scopeKey = pageScopeKey(input)
    const allowedOperationIds = agentToolsForContext(roleCode, viewId)
      .map(definition => definition.operationId)
    const snapshot = agentPageContextSnapshotSchema.parse({
      actor: {
        actorId: input.actor.actorId,
        practitionerRoleId: input.actor.practitionerRoleId,
        roleCode,
      },
      allowedOperationIds,
      claim,
      expiresAt,
      id: contextId,
      issuedAt,
      scopeKey,
      version: 1,
      workspace: {
        epoch: input.actor.epoch,
        id: input.actor.workspaceId,
        scenarioRunId: input.actor.scenarioRunId,
      },
    })

    this.#database.driver.transaction(() => {
      this.#database.driver.prepare(`
        UPDATE agent_page_context
        SET status = 'revoked'
        WHERE workspace_id = ? AND epoch = ? AND user_account_id = ?
          AND practitioner_role_id = ? AND status = 'active'
      `).run(
        input.actor.workspaceId,
        input.actor.epoch,
        input.userAccountId,
        input.actor.practitionerRoleId,
      )
      this.#database.driver.prepare(`
        INSERT INTO agent_page_context (
          context_id, scope_key, workspace_id, epoch, scenario_run_id, user_account_id,
          actor_id, practitioner_role_id, role_code, view_id, view_revision,
          claim_json, allowed_operation_ids_json, status, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        contextId,
        scopeKey,
        input.actor.workspaceId,
        input.actor.epoch,
        input.actor.scenarioRunId,
        input.userAccountId,
        input.actor.actorId,
        input.actor.practitionerRoleId,
        roleCode,
        viewId,
        claim.viewRevision,
        JSON.stringify(claim),
        JSON.stringify(allowedOperationIds),
        issuedAt,
        expiresAt,
      )
    })()

    return { snapshot, token: this.#sign({
      actorId: input.actor.actorId,
      contextId,
      epoch: input.actor.epoch,
      expiresAt,
      roleCode,
      version: 1,
      workspaceId: input.actor.workspaceId,
    }) }
  }

  verifyPageContextToken(token: string): AgentPageContextSnapshot {
    const [encodedPayload, encodedSignature, extra] = token.split('.')
    if (encodedPayload === undefined || encodedSignature === undefined || extra !== undefined) {
      throw this.#invalidToken()
    }
    const expected = this.#signature(encodedPayload)
    const actual = Buffer.from(encodedSignature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw this.#invalidToken()
    }
    let payload: z.infer<typeof tokenPayloadSchema>
    try {
      payload = tokenPayloadSchema.parse(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()))
    } catch {
      throw this.#invalidToken()
    }
    const row = this.#database.driver.prepare(`
      SELECT agent_page_context.claim_json,
        agent_page_context.allowed_operation_ids_json,
        agent_page_context.scope_key,
        agent_page_context.actor_id,
        agent_page_context.practitioner_role_id,
        agent_page_context.role_code,
        agent_page_context.workspace_id,
        agent_page_context.epoch,
        agent_page_context.scenario_run_id,
        agent_page_context.issued_at,
        agent_page_context.expires_at,
        agent_page_context.status
      FROM agent_page_context
      JOIN workspace ON workspace.workspace_id = agent_page_context.workspace_id
      WHERE agent_page_context.context_id = ?
        AND workspace.active_epoch = agent_page_context.epoch
    `).get(payload.contextId) as {
      actor_id: string
      allowed_operation_ids_json: string
      claim_json: string
      epoch: string
      expires_at: string
      issued_at: string
      practitioner_role_id: string
      role_code: string
      scenario_run_id: string
      scope_key: string
      status: string
      workspace_id: string
    } | undefined
    if (
      row === undefined
      || row.status !== 'active'
      || row.actor_id !== payload.actorId
      || row.workspace_id !== payload.workspaceId
      || row.epoch !== payload.epoch
      || row.role_code !== payload.roleCode
    ) throw this.#invalidToken()
    if (Date.parse(row.expires_at) <= this.#now().getTime()) {
      this.#database.driver.prepare(`
        UPDATE agent_page_context SET status = 'expired'
        WHERE context_id = ? AND status = 'active'
      `).run(payload.contextId)
      throw new AgentIntegrationError(
        'AGENT_CONTEXT_EXPIRED',
        'The DSH Agent Page Context has expired',
        401,
      )
    }
    return agentPageContextSnapshotSchema.parse({
      actor: {
        actorId: row.actor_id,
        practitionerRoleId: row.practitioner_role_id,
        roleCode: row.role_code,
      },
      allowedOperationIds: JSON.parse(row.allowed_operation_ids_json),
      claim: JSON.parse(row.claim_json),
      expiresAt: row.expires_at,
      id: payload.contextId,
      issuedAt: row.issued_at,
      scopeKey: row.scope_key,
      version: 1,
      workspace: {
        epoch: row.epoch,
        id: row.workspace_id,
        scenarioRunId: row.scenario_run_id,
      },
    })
  }

  authorizeToolCall(input: {
    actor: ActorContext
    request: z.infer<typeof agentToolAuthorizationRequestSchema>
    userAccountId: string
  }): z.infer<typeof agentToolAuthorizationResponseSchema> {
    const request = agentToolAuthorizationRequestSchema.parse(input.request)
    const context = this.verifyPageContextToken(request.contextToken)
    this.#assertCurrentCaller(context, input.actor, input.userAccountId)
    const proof = this.#parseExecutionProof(request.executionProof)
    const definition = agentToolCatalog.find(candidate => candidate.operationId === request.operationId)
    if (
      definition === undefined
      || definition.toolName !== proof.toolName
      || proof.scopeKey !== context.scopeKey
      || !context.allowedOperationIds.includes(definition.operationId)
    ) {
      throw new AgentIntegrationError(
        'AGENT_OPERATION_NOT_ALLOWED',
        'The DSH Tool call does not match this Page Context capability',
        403,
      )
    }

    const startedAt = this.#now().toISOString()
    const proposalId = definition.mode === 'proposal' ? uuidv7() : undefined
    this.#database.driver.transaction(() => {
      const inserted = this.#database.driver.prepare(`
        INSERT OR IGNORE INTO agent_tool_call (
          dsh_session_id, call_id, context_id, operation_id, proposal_id,
          status, input_hash, started_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        proof.dshSessionId,
        proof.callId,
        context.id,
        definition.operationId,
        proposalId ?? null,
        hashJson(request.input),
        startedAt,
      )
      if (inserted.changes !== 1) {
        throw new AgentIntegrationError(
          'AGENT_CALL_REPLAYED',
          'The DSH Tool call was already authorized',
          409,
        )
      }
      if (proposalId !== undefined) {
        this.#database.driver.prepare(`
          INSERT INTO agent_proposal (
            proposal_id, context_id, dsh_session_id, call_id, operation_id,
            plan_hash, proposal_json, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          proposalId,
          context.id,
          proof.dshSessionId,
          proof.callId,
          definition.operationId,
          hashJson({ operationId: definition.operationId, input: request.input }),
          JSON.stringify({ input: request.input }),
          startedAt,
        )
      }
    })()
    const expiresAt = new Date(Math.min(
      Date.parse(context.expiresAt),
      this.#now().getTime() + PAGE_CONTEXT_TTL_MS,
    )).toISOString()
    return agentToolAuthorizationResponseSchema.parse({
      callId: proof.callId,
      context,
      dshSessionId: proof.dshSessionId,
      operationId: definition.operationId,
      ...(proposalId === undefined ? {} : { proposalId }),
      receiptToken: this.#signReceipt({
        callId: proof.callId,
        contextId: context.id,
        dshSessionId: proof.dshSessionId,
        expiresAt,
        operationId: definition.operationId,
        version: 1,
      }),
      status: 'authorized',
    })
  }

  completeToolCall(input: {
    actor: ActorContext
    request: z.infer<typeof agentToolResultRequestSchema>
    userAccountId: string
  }): {
    auditId?: string
    proposalStatus?: 'approved' | 'rejected'
    requestId?: string
    status: 'completed' | 'failed'
    traceId?: string
  } {
    const request = agentToolResultRequestSchema.parse(input.request)
    const receipt = this.#parseReceipt(request.receiptToken)
    const row = this.#database.driver.prepare(`
      SELECT context_id, proposal_id FROM agent_tool_call
      WHERE dsh_session_id = ? AND call_id = ? AND operation_id = ?
    `).get(receipt.dshSessionId, receipt.callId, receipt.operationId) as {
      context_id: string
      proposal_id: string | null
    } | undefined
    if (row === undefined || row.context_id !== receipt.contextId) {
      throw this.#callNotPending()
    }
    const context = this.#contextById(receipt.contextId)
    this.#assertCurrentCaller(context, input.actor, input.userAccountId)
    const resultJson = JSON.stringify(request.ok
      ? { result: request.result ?? null }
      : { error: request.error ?? 'Tool execution failed' })
    if (Buffer.byteLength(resultJson) > 128 * 1024) {
      throw new AgentIntegrationError(
        'AGENT_OPERATION_NOT_ALLOWED',
        'The DSH Tool result exceeds its size limit',
        403,
      )
    }
    const status = request.ok ? 'completed' : 'failed'
    const completedAt = this.#now().toISOString()
    const review = row.proposal_id === null || !request.ok
      ? undefined
      : reviewResult(request.result)
    const commandLink = review?.approved === true
      ? this.#verifiedCommandLink(context, input.actor, review.command)
      : undefined
    this.#database.driver.transaction(() => {
      const updated = this.#database.driver.prepare(`
        UPDATE agent_tool_call
        SET status = ?, result_json = ?, completed_at = ?, request_id = ?,
          audit_id = ?, trace_id = ?
        WHERE dsh_session_id = ? AND call_id = ? AND operation_id = ?
          AND context_id = ? AND status = 'pending'
      `).run(
        status,
        resultJson,
        completedAt,
        commandLink?.requestId ?? null,
        commandLink?.auditId ?? null,
        commandLink?.traceId ?? null,
        receipt.dshSessionId,
        receipt.callId,
        receipt.operationId,
        receipt.contextId,
      )
      if (updated.changes !== 1) throw this.#callNotPending()
      if (row.proposal_id !== null && !request.ok) {
        this.#database.driver.prepare(`
          UPDATE agent_proposal SET status = 'stale'
          WHERE proposal_id = ? AND status = 'pending'
        `).run(row.proposal_id)
      } else if (row.proposal_id !== null && review !== undefined) {
        const proposalStatus = review.approved ? 'approved' : 'rejected'
        this.#database.driver.prepare(`
          UPDATE agent_proposal SET status = ?
          WHERE proposal_id = ? AND status = 'pending'
        `).run(proposalStatus, row.proposal_id)
        this.#database.driver.prepare(`
          INSERT INTO agent_review_decision (
            decision_id, proposal_id, human_actor_id, decision,
            command_request_id, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          uuidv7(),
          row.proposal_id,
          input.actor.actorId,
          proposalStatus,
          commandLink?.requestId ?? null,
          completedAt,
        )
      }
    })()
    return {
      ...(commandLink === undefined ? {} : commandLink),
      ...(review === undefined ? {} : {
        proposalStatus: review.approved ? 'approved' as const : 'rejected' as const,
      }),
      status,
    }
  }

  #sign(payload: z.infer<typeof tokenPayloadSchema>): string {
    const encoded = Buffer.from(JSON.stringify(tokenPayloadSchema.parse(payload))).toString('base64url')
    return `${encoded}.${this.#signature(encoded).toString('base64url')}`
  }

  #signature(encodedPayload: string): Buffer {
    return createHmac('sha256', this.#secret).update(encodedPayload).digest()
  }

  #parseExecutionProof(token: string): z.infer<typeof agentExecutionProofPayloadSchema> {
    const payload = this.#verifySignedToken(token, agentExecutionProofPayloadSchema)
    if (Date.parse(payload.expiresAt) <= this.#now().getTime()) {
      throw new AgentIntegrationError(
        'AGENT_PROOF_INVALID',
        'The DSH Agent execution proof has expired',
        401,
      )
    }
    return payload
  }

  #signReceipt(payload: z.infer<typeof receiptPayloadSchema>): string {
    const encoded = Buffer.from(JSON.stringify(receiptPayloadSchema.parse(payload))).toString('base64url')
    return `${encoded}.${this.#signature(encoded).toString('base64url')}`
  }

  #parseReceipt(token: string): z.infer<typeof receiptPayloadSchema> {
    const payload = this.#verifySignedToken(token, receiptPayloadSchema)
    if (Date.parse(payload.expiresAt) <= this.#now().getTime()) throw this.#callNotPending()
    return payload
  }

  #verifySignedToken<Schema extends z.ZodType>(
    token: string,
    schema: Schema,
  ): z.infer<Schema> {
    const [encodedPayload, encodedSignature, extra] = token.split('.')
    if (encodedPayload === undefined || encodedSignature === undefined || extra !== undefined) {
      throw this.#invalidProof()
    }
    const expected = this.#signature(encodedPayload)
    const actual = Buffer.from(encodedSignature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw this.#invalidProof()
    }
    try {
      return schema.parse(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()))
    } catch {
      throw this.#invalidProof()
    }
  }

  #contextById(contextId: string): AgentPageContextSnapshot {
    const row = this.#database.driver.prepare(`
      SELECT claim_json, allowed_operation_ids_json, actor_id, practitioner_role_id,
        role_code, scope_key, workspace_id, epoch, scenario_run_id, issued_at, expires_at
      FROM agent_page_context WHERE context_id = ?
    `).get(contextId) as {
      actor_id: string
      allowed_operation_ids_json: string
      claim_json: string
      epoch: string
      expires_at: string
      issued_at: string
      practitioner_role_id: string
      role_code: string
      scenario_run_id: string
      scope_key: string
      workspace_id: string
    } | undefined
    if (row === undefined) throw this.#invalidToken()
    return agentPageContextSnapshotSchema.parse({
      actor: {
        actorId: row.actor_id,
        practitionerRoleId: row.practitioner_role_id,
        roleCode: row.role_code,
      },
      allowedOperationIds: JSON.parse(row.allowed_operation_ids_json),
      claim: JSON.parse(row.claim_json),
      expiresAt: row.expires_at,
      id: contextId,
      issuedAt: row.issued_at,
      scopeKey: row.scope_key,
      version: 1,
      workspace: {
        epoch: row.epoch,
        id: row.workspace_id,
        scenarioRunId: row.scenario_run_id,
      },
    })
  }

  #assertCurrentCaller(
    context: AgentPageContextSnapshot,
    actor: ActorContext,
    userAccountId: string,
  ): void {
    const row = this.#database.driver.prepare(`
      SELECT user_account_id FROM agent_page_context WHERE context_id = ?
    `).get(context.id) as { user_account_id: string } | undefined
    if (
      row?.user_account_id !== userAccountId
      || context.actor.actorId !== actor.actorId
      || context.actor.practitionerRoleId !== actor.practitionerRoleId
      || context.workspace.id !== actor.workspaceId
      || context.workspace.epoch !== actor.epoch
    ) throw this.#invalidToken()
  }

  #verifiedCommandLink(
    context: AgentPageContextSnapshot,
    actor: ActorContext,
    command: { auditId: string; requestId: string } | undefined,
  ): { auditId: string; requestId: string; traceId: string } {
    if (command === undefined) {
      throw new AgentIntegrationError(
        'AGENT_OPERATION_NOT_ALLOWED',
        'An approved Agent proposal must return a Command receipt',
        403,
      )
    }
    const audit = this.#database.driver.prepare(`
      SELECT audit_id FROM audit_log
      WHERE workspace_id = ? AND epoch = ? AND audit_id = ?
        AND actor_id = ? AND outcome = 'success'
    `).get(
      context.workspace.id,
      context.workspace.epoch,
      command.auditId,
      actor.actorId,
    )
    const trace = this.#database.driver.prepare(`
      SELECT trace_id FROM action_trace
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
        AND actor_id = ? AND outcome = 'success'
    `).get(
      context.workspace.id,
      context.workspace.epoch,
      command.requestId,
      actor.actorId,
    ) as { trace_id: string } | undefined
    if (audit === undefined || trace === undefined) {
      throw new AgentIntegrationError(
        'AGENT_OPERATION_NOT_ALLOWED',
        'The reviewed Command receipt is not owned by the current human Actor',
        403,
      )
    }
    return { auditId: command.auditId, requestId: command.requestId, traceId: trace.trace_id }
  }

  #invalidProof(): AgentIntegrationError {
    return new AgentIntegrationError(
      'AGENT_PROOF_INVALID',
      'The DSH Agent execution proof is invalid',
      401,
    )
  }

  #callNotPending(): AgentIntegrationError {
    return new AgentIntegrationError(
      'AGENT_CALL_NOT_PENDING',
      'The DSH Tool call is not pending',
      409,
    )
  }

  #invalidToken(): AgentIntegrationError {
    return new AgentIntegrationError(
      'AGENT_CONTEXT_INVALID',
      'The DSH Agent Page Context token is invalid or revoked',
      401,
    )
  }
}

function pageScopeKey(input: CreatePageContextInput): string {
  return `clinmesh:${hashJson({
    actorId: input.actor.actorId,
    epoch: input.actor.epoch,
    practitionerRoleId: input.actor.practitionerRoleId,
    roleCode: input.actor.roleCode,
    scenarioRunId: input.actor.scenarioRunId,
    userAccountId: input.userAccountId,
    viewId: input.claim.viewId,
    workspaceId: input.actor.workspaceId,
  }).slice(0, 32)}`
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]))
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function reviewResult(value: unknown): {
  approved: boolean
  command?: { auditId: string; requestId: string }
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { approved: false }
  }
  const review = value as Record<string, unknown>
  if (review.approved !== true) return { approved: false }
  const data = review.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { approved: true }
  }
  const command = data as Record<string, unknown>
  return {
    approved: true,
    ...(typeof command.auditId === 'string' && typeof command.requestId === 'string'
      ? { command: { auditId: command.auditId, requestId: command.requestId } }
      : {}),
  }
}
