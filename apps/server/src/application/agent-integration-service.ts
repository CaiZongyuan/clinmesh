import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  agentExecutionProofPayloadSchema,
  agentHumanRoleCodeSchema,
  agentPageContextRequestSchema,
  agentPageContextSnapshotSchema,
  agentViewsForRole,
  agentReviewDecisionRequestSchema,
  agentReviewDecisionResponseSchema,
  isAgentOperationId,
  agentToolAuthorizationRequestSchema,
  agentToolAuthorizationResponseSchema,
  agentToolResultRequestSchema,
  agentToolCatalog,
  agentViewIdSchema,
  type AgentPageContextRequest,
  type AgentPageContextSnapshot,
} from '@clinmesh/contracts/agent'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ActorContext } from './command-executor.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import {
  proposalCommandOperations,
  resolveAgentPageContext,
  validateAgentToolInputForContext,
} from './agent-context-policy.ts'

const PAGE_CONTEXT_TTL_MS = 5 * 60_000

const tokenPayloadSchema = z.object({
  actorId: z.string().min(1),
  contextId: z.string().min(1),
  epoch: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  dshSessionId: z.string().min(1),
  roleCode: agentHumanRoleCodeSchema,
  version: z.literal(1),
  workspaceId: z.string().min(1),
}).strict()

const receiptPayloadSchema = z.object({
  callId: z.string().min(1),
  contextId: z.string().min(1),
  dshSessionId: z.string().min(1),
  epoch: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  operationId: z.string().min(1),
  version: z.literal(1),
  workspaceId: z.string().min(1),
}).strict()

const commandLinkResponseSchema = z.object({
  auditId: z.string().min(1),
  data: z.json(),
  effects: z.array(z.object({
    kind: z.enum(['created', 'updated']),
    reference: z.string().min(1),
    versionId: z.string().min(1),
  }).strict()),
  requestId: z.string().min(1),
  warnings: z.array(z.string()),
}).strict()

interface CreatePageContextInput {
  actor: ActorContext
  request: AgentPageContextRequest
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
      | 'AGENT_CONTEXT_STALE'
      | 'AGENT_CONTEXT_SUPERSEDED'
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
    const request = agentPageContextRequestSchema.parse(input.request)
    const claim = request.claim
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
    const snapshot = this.#database.driver.transaction(() => {
      const resolved = resolveAgentPageContext(
        this.#database,
        input.actor,
        input.userAccountId,
        claim,
      )
      if (resolved === undefined) throw this.#staleContext()
      const latest = this.#database.driver.prepare(`
        SELECT MAX(client_revision) AS revision
        FROM agent_page_context
        WHERE workspace_id = ? AND epoch = ? AND user_account_id = ?
          AND practitioner_role_id = ? AND client_id = ?
      `).get(
        input.actor.workspaceId,
        input.actor.epoch,
        input.userAccountId,
        input.actor.practitionerRoleId,
        request.client.id,
      ) as { revision: number | null }
      if (latest.revision !== null && latest.revision >= request.client.revision) {
        throw new AgentIntegrationError(
          'AGENT_CONTEXT_SUPERSEDED',
          'A newer ClinMesh Agent Page Context revision already exists',
          409,
        )
      }
      this.#database.driver.prepare(`
        UPDATE agent_page_context
        SET status = 'revoked'
        WHERE workspace_id = ? AND epoch = ? AND user_account_id = ?
          AND practitioner_role_id = ? AND client_id = ? AND status = 'active'
      `).run(
        input.actor.workspaceId,
        input.actor.epoch,
        input.userAccountId,
        input.actor.practitionerRoleId,
        request.client.id,
      )
      this.#database.driver.prepare(`
        INSERT INTO agent_page_context (
          workspace_id, epoch, context_id, scope_key, scenario_run_id, user_account_id,
          actor_id, practitioner_role_id, role_code, dsh_session_id, client_id,
          client_revision, view_id, view_revision,
          claim_json, allowed_operation_ids_json, status, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        input.actor.workspaceId,
        input.actor.epoch,
        contextId,
        scopeKey,
        input.actor.scenarioRunId,
        input.userAccountId,
        input.actor.actorId,
        input.actor.practitionerRoleId,
        roleCode,
        request.dshSessionId,
        request.client.id,
        request.client.revision,
        viewId,
        claim.viewRevision,
        JSON.stringify(claim),
        JSON.stringify(resolved.allowedOperationIds),
        issuedAt,
        expiresAt,
      )
      return agentPageContextSnapshotSchema.parse({
        actor: {
          actorId: input.actor.actorId,
          practitionerRoleId: input.actor.practitionerRoleId,
          roleCode,
        },
        allowedOperationIds: resolved.allowedOperationIds,
        claim,
        dshSessionId: request.dshSessionId,
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
    })()

    return { snapshot, token: this.#sign({
      actorId: input.actor.actorId,
      contextId,
      dshSessionId: request.dshSessionId,
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
        agent_page_context.dsh_session_id,
        agent_page_context.workspace_id,
        agent_page_context.epoch,
        agent_page_context.scenario_run_id,
        agent_page_context.issued_at,
        agent_page_context.expires_at,
        agent_page_context.status
      FROM agent_page_context
      JOIN workspace ON workspace.workspace_id = agent_page_context.workspace_id
      WHERE agent_page_context.context_id = ?
        AND agent_page_context.workspace_id = ?
        AND agent_page_context.epoch = ?
        AND workspace.active_epoch = agent_page_context.epoch
    `).get(payload.contextId, payload.workspaceId, payload.epoch) as {
      actor_id: string
      allowed_operation_ids_json: string
      claim_json: string
      dsh_session_id: string
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
      || row.dsh_session_id !== payload.dshSessionId
      || row.expires_at !== payload.expiresAt
    ) throw this.#invalidToken()
    if (Date.parse(row.expires_at) <= this.#now().getTime()) {
      this.#database.driver.prepare(`
        UPDATE agent_page_context SET status = 'expired'
        WHERE workspace_id = ? AND epoch = ? AND context_id = ?
          AND status = 'active'
      `).run(payload.workspaceId, payload.epoch, payload.contextId)
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
      dshSessionId: row.dsh_session_id,
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
      || proof.contextId !== context.id
      || proof.scopeKey !== context.scopeKey
      || proof.dshSessionId !== context.dshSessionId
      || !context.allowedOperationIds.includes(definition.operationId)
    ) {
      throw new AgentIntegrationError(
        'AGENT_OPERATION_NOT_ALLOWED',
        'The DSH Tool call does not match this Page Context capability',
        403,
      )
    }
    const parsedInput = validateAgentToolInputForContext(
      this.#database,
      context,
      input.userAccountId,
      definition.operationId,
      request.input,
    )
    if (parsedInput === undefined) throw this.#staleContext()

    const startedAt = this.#now().toISOString()
    const proposalId = definition.mode === 'proposal' ? uuidv7() : undefined
    this.#database.driver.transaction(() => {
      const inserted = this.#database.driver.prepare(`
        INSERT OR IGNORE INTO agent_tool_call (
          workspace_id, epoch, dsh_session_id, call_id, context_id,
          scenario_run_id, operation_id, proposal_id, status, input_hash, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        context.workspace.id,
        context.workspace.epoch,
        proof.dshSessionId,
        proof.callId,
        context.id,
        context.workspace.scenarioRunId,
        definition.operationId,
        proposalId ?? null,
        hashJson(parsedInput),
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
            workspace_id, epoch, proposal_id, context_id, dsh_session_id,
            call_id, operation_id, plan_hash, proposal_json, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          context.workspace.id,
          context.workspace.epoch,
          proposalId,
          context.id,
          proof.dshSessionId,
          proof.callId,
          definition.operationId,
          hashJson({
            claim: context.claim,
            input: parsedInput,
            operationId: definition.operationId,
          }),
          JSON.stringify({
            claim: context.claim,
            input: parsedInput,
            operationId: definition.operationId,
          }),
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
        epoch: context.workspace.epoch,
        expiresAt,
        operationId: definition.operationId,
        version: 1,
        workspaceId: context.workspace.id,
      }),
      status: 'authorized',
    })
  }

  reviewToolCall(input: {
    actor: ActorContext
    request: z.infer<typeof agentReviewDecisionRequestSchema>
    userAccountId: string
  }): z.infer<typeof agentReviewDecisionResponseSchema> {
    const request = agentReviewDecisionRequestSchema.parse(input.request)
    const receipt = this.#parseReceipt(request.receiptToken)
    let context: AgentPageContextSnapshot
    try {
      context = this.#contextById(
        receipt.workspaceId,
        receipt.epoch,
        receipt.contextId,
        { requireActive: true, requireCurrentEpoch: true },
      )
    } catch {
      throw this.#callNotPending()
    }
    this.#assertCurrentCaller(context, input.actor, input.userAccountId)
    if (context.dshSessionId !== receipt.dshSessionId) throw this.#callNotPending()
    const resolved = resolveAgentPageContext(
      this.#database,
      input.actor,
      input.userAccountId,
      context.claim,
    )
    if (
      resolved === undefined
      || !isAgentOperationId(receipt.operationId)
      || !resolved.allowedOperationIds.includes(receipt.operationId)
    ) throw this.#callNotPending()
    const row = this.#database.driver.prepare(`
      SELECT tool.proposal_id
      FROM agent_tool_call AS tool
      JOIN agent_proposal AS proposal
        ON proposal.workspace_id = tool.workspace_id
       AND proposal.epoch = tool.epoch
       AND proposal.proposal_id = tool.proposal_id
      WHERE tool.workspace_id = ? AND tool.epoch = ?
        AND tool.dsh_session_id = ? AND tool.call_id = ?
        AND tool.context_id = ? AND tool.operation_id = ?
        AND tool.status = 'pending' AND proposal.status = 'pending'
    `).get(
      context.workspace.id,
      context.workspace.epoch,
      receipt.dshSessionId,
      receipt.callId,
      receipt.contextId,
      receipt.operationId,
    ) as { proposal_id: string } | undefined
    if (row === undefined) throw this.#callNotPending()

    const decidedAt = this.#now().toISOString()
    this.#database.driver.transaction(() => {
      const updated = this.#database.driver.prepare(`
        UPDATE agent_proposal SET status = ?
        WHERE workspace_id = ? AND epoch = ? AND proposal_id = ? AND status = 'pending'
      `).run(
        request.decision,
        context.workspace.id,
        context.workspace.epoch,
        row.proposal_id,
      )
      if (updated.changes !== 1) throw this.#callNotPending()
      this.#database.driver.prepare(`
        INSERT INTO agent_review_decision (
          workspace_id, epoch, decision_id, proposal_id, human_actor_id,
          decision, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        context.workspace.id,
        context.workspace.epoch,
        uuidv7(),
        row.proposal_id,
        input.actor.actorId,
        request.decision,
        decidedAt,
      )
    })()
    return agentReviewDecisionResponseSchema.parse({
      decidedAt,
      decision: request.decision,
      proposalId: row.proposal_id,
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
    const receipt = this.#parseReceipt(request.receiptToken, {
      allowExpired: !request.ok,
    })
    const row = this.#database.driver.prepare(`
      SELECT tool.workspace_id, tool.epoch, tool.context_id, tool.proposal_id,
        tool.status, proposal.status AS proposal_status,
        proposal.operation_id AS proposal_operation_id
      FROM agent_tool_call AS tool
      LEFT JOIN agent_proposal AS proposal
        ON proposal.workspace_id = tool.workspace_id
       AND proposal.epoch = tool.epoch
       AND proposal.proposal_id = tool.proposal_id
      WHERE tool.workspace_id = ? AND tool.epoch = ?
        AND tool.dsh_session_id = ? AND tool.call_id = ?
        AND tool.operation_id = ? AND tool.context_id = ?
    `).get(
      receipt.workspaceId,
      receipt.epoch,
      receipt.dshSessionId,
      receipt.callId,
      receipt.operationId,
      receipt.contextId,
    ) as {
      context_id: string
      epoch: string
      proposal_id: string | null
      proposal_operation_id: string | null
      proposal_status: string | null
      status: string
      workspace_id: string
    } | undefined
    if (row === undefined || row.status !== 'pending') {
      throw this.#callNotPending()
    }
    const context = this.#contextById(
      receipt.workspaceId,
      receipt.epoch,
      receipt.contextId,
      { requireActive: false, requireCurrentEpoch: request.ok },
    )
    if (
      row.workspace_id !== context.workspace.id
      || row.epoch !== context.workspace.epoch
      || context.dshSessionId !== receipt.dshSessionId
    ) throw this.#callNotPending()
    this.#assertCurrentCaller(context, input.actor, input.userAccountId, {
      requireCurrentEpoch: request.ok,
      requirePractitionerRole: request.ok,
    })
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
    if (
      review !== undefined
      && row.proposal_status !== (review.approved ? 'approved' : 'rejected')
    ) {
      throw new AgentIntegrationError(
        'AGENT_OPERATION_NOT_ALLOWED',
        'The Tool result does not match the recorded human review decision',
        403,
      )
    }
    const commandLink = review?.approved === true && row.proposal_id !== null
      ? this.#verifiedCommandLink(
          context,
          input.actor,
          row.proposal_id,
          row.proposal_operation_id ?? '',
          review.command,
        )
      : undefined
    this.#database.driver.transaction(() => {
      const updated = this.#database.driver.prepare(`
        UPDATE agent_tool_call
        SET status = ?, result_json = ?, completed_at = ?, request_id = ?,
          audit_id = ?, trace_id = ?
        WHERE workspace_id = ? AND epoch = ? AND dsh_session_id = ?
          AND call_id = ? AND operation_id = ? AND context_id = ?
          AND status = 'pending'
      `).run(
        status,
        resultJson,
        completedAt,
        commandLink?.requestId ?? null,
        commandLink?.auditId ?? null,
        commandLink?.traceId ?? null,
        context.workspace.id,
        context.workspace.epoch,
        receipt.dshSessionId,
        receipt.callId,
        receipt.operationId,
        receipt.contextId,
      )
      if (updated.changes !== 1) throw this.#callNotPending()
      if (row.proposal_id !== null && !request.ok) {
        this.#database.driver.prepare(`
          UPDATE agent_proposal SET status = 'stale'
          WHERE workspace_id = ? AND epoch = ? AND proposal_id = ?
            AND status = 'pending'
        `).run(context.workspace.id, context.workspace.epoch, row.proposal_id)
      }
      if (row.proposal_id !== null && commandLink !== undefined) {
        this.#database.driver.prepare(`
          UPDATE agent_review_decision SET command_request_id = ?
          WHERE workspace_id = ? AND epoch = ? AND proposal_id = ?
            AND decision = 'approved' AND command_request_id IS NULL
        `).run(
          commandLink.requestId,
          context.workspace.id,
          context.workspace.epoch,
          row.proposal_id,
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

  #parseReceipt(
    token: string,
    options: { allowExpired?: boolean } = {},
  ): z.infer<typeof receiptPayloadSchema> {
    const payload = this.#verifySignedToken(token, receiptPayloadSchema)
    if (
      options.allowExpired !== true
      && Date.parse(payload.expiresAt) <= this.#now().getTime()
    ) throw this.#callNotPending()
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

  #contextById(
    workspaceId: string,
    epoch: string,
    contextId: string,
    options: { requireActive: boolean; requireCurrentEpoch: boolean },
  ): AgentPageContextSnapshot {
    const row = this.#database.driver.prepare(`
      SELECT claim_json, allowed_operation_ids_json, actor_id, practitioner_role_id,
        role_code, dsh_session_id, scope_key, agent_page_context.workspace_id,
        agent_page_context.epoch, scenario_run_id, issued_at, expires_at,
        agent_page_context.status, workspace.active_epoch
      FROM agent_page_context
      JOIN workspace ON workspace.workspace_id = agent_page_context.workspace_id
      WHERE agent_page_context.workspace_id = ?
        AND agent_page_context.epoch = ?
        AND agent_page_context.context_id = ?
    `).get(workspaceId, epoch, contextId) as {
      active_epoch: string
      actor_id: string
      allowed_operation_ids_json: string
      claim_json: string
      dsh_session_id: string
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
      || (options.requireCurrentEpoch && row.active_epoch !== row.epoch)
      || (options.requireActive && (
        row.status !== 'active' || Date.parse(row.expires_at) <= this.#now().getTime()
      ))
    ) throw this.#invalidToken()
    return agentPageContextSnapshotSchema.parse({
      actor: {
        actorId: row.actor_id,
        practitionerRoleId: row.practitioner_role_id,
        roleCode: row.role_code,
      },
      allowedOperationIds: JSON.parse(row.allowed_operation_ids_json),
      claim: JSON.parse(row.claim_json),
      dshSessionId: row.dsh_session_id,
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
    options: {
      requireCurrentEpoch?: boolean
      requirePractitionerRole?: boolean
    } = {},
  ): void {
    const row = this.#database.driver.prepare(`
      SELECT user_account_id FROM agent_page_context
      WHERE workspace_id = ? AND epoch = ? AND context_id = ?
    `).get(context.workspace.id, context.workspace.epoch, context.id) as {
      user_account_id: string
    } | undefined
    if (
      row?.user_account_id !== userAccountId
      || context.actor.actorId !== actor.actorId
      || (
        options.requirePractitionerRole !== false
        && context.actor.practitionerRoleId !== actor.practitionerRoleId
      )
      || context.workspace.id !== actor.workspaceId
      || (options.requireCurrentEpoch !== false && context.workspace.epoch !== actor.epoch)
    ) throw this.#invalidToken()
  }

  #verifiedCommandLink(
    context: AgentPageContextSnapshot,
    actor: ActorContext,
    proposalId: string,
    proposalOperationId: string,
    command: { auditId: string; requestId: string } | undefined,
  ): { auditId: string; requestId: string; traceId: string } {
    if (command === undefined) {
      throw new AgentIntegrationError(
        'AGENT_OPERATION_NOT_ALLOWED',
        'An approved Agent proposal must return a Command receipt',
        403,
      )
    }
    const expectedOperations = proposalCommandOperations[proposalOperationId]
    if (expectedOperations === undefined) {
      throw new AgentIntegrationError(
        'AGENT_OPERATION_NOT_ALLOWED',
        'The Agent proposal has no corresponding ClinMesh Command',
        403,
      )
    }
    const link = this.#database.driver.prepare(`
      SELECT receipt.operation, receipt.response_json, receipt.trace_id
      FROM command_receipt AS receipt
      JOIN audit_log AS audit
        ON audit.workspace_id = receipt.workspace_id
       AND audit.epoch = receipt.epoch
       AND audit.audit_id = receipt.audit_id
      JOIN action_trace AS trace
        ON trace.workspace_id = receipt.workspace_id
       AND trace.epoch = receipt.epoch
       AND trace.scenario_run_id = ?
       AND trace.trace_id = receipt.trace_id
       AND trace.request_id = receipt.request_id
      JOIN agent_review_decision AS decision
        ON decision.workspace_id = receipt.workspace_id
       AND decision.epoch = receipt.epoch
       AND decision.proposal_id = ?
      WHERE receipt.workspace_id = ? AND receipt.epoch = ?
        AND receipt.actor_id = ? AND receipt.status = 'completed'
        AND receipt.practitioner_role_id = ?
        AND receipt.audit_id = ? AND receipt.request_id = ?
        AND audit.actor_id = receipt.actor_id
        AND audit.practitioner_role_id = receipt.practitioner_role_id
        AND audit.operation = receipt.operation AND audit.outcome = 'success'
        AND trace.actor_id = receipt.actor_id
        AND trace.operation = receipt.operation AND trace.outcome = 'success'
        AND decision.human_actor_id = receipt.actor_id
        AND decision.decision = 'approved'
        AND audit.real_timestamp >= decision.decided_at
    `).get(
      context.workspace.scenarioRunId,
      proposalId,
      context.workspace.id,
      context.workspace.epoch,
      actor.actorId,
      context.actor.practitionerRoleId,
      command.auditId,
      command.requestId,
    ) as {
      operation: string
      response_json: string
      trace_id: string
    } | undefined
    if (link === undefined || !expectedOperations.includes(link.operation)) {
      throw new AgentIntegrationError(
        'AGENT_OPERATION_NOT_ALLOWED',
        'The reviewed Command is not the one approved for this Agent proposal',
        403,
      )
    }
    const response = commandLinkResponseSchema.parse(JSON.parse(link.response_json))
    if (response.auditId !== command.auditId || response.requestId !== command.requestId) {
      throw new AgentIntegrationError(
        'AGENT_OPERATION_NOT_ALLOWED',
        'The reviewed Command receipt identifiers do not match',
        403,
      )
    }
    return { auditId: command.auditId, requestId: command.requestId, traceId: link.trace_id }
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

  #staleContext(): AgentIntegrationError {
    return new AgentIntegrationError(
      'AGENT_CONTEXT_STALE',
      'The ClinMesh resources bound to this Agent Page Context have changed',
      409,
    )
  }
}

function pageScopeKey(input: CreatePageContextInput): string {
  const claim = input.request.claim
  return `clinmesh:${hashJson({
    activeSection: claim.activeSection,
    actorId: input.actor.actorId,
    dshSessionId: input.request.dshSessionId,
    epoch: input.actor.epoch,
    practitionerRoleId: input.actor.practitionerRoleId,
    roleCode: input.actor.roleCode,
    scenarioRunId: input.actor.scenarioRunId,
    userAccountId: input.userAccountId,
    selection: claim.selection,
    viewId: claim.viewId,
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
