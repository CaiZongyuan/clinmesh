import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { roleCodeSchema, type SessionContext } from '@clinmesh/contracts/his'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import type { ActorContext } from './command-executor.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import * as authSchema from '../infrastructure/auth/schema.ts'
import {
  getHisOperation,
  listHisOperations,
  matchHisOperation,
} from '@clinmesh/contracts/his-operations'
import {
  agentCapabilityContextSchema,
  agentCapabilityGrantListSchema,
  agentCapabilityGrantViewSchema,
  agentClientListSchema,
  agentClientSchema,
} from '@clinmesh/contracts/agent'

export const syntheticAccounts = [
  {
    actorId: 'actor-registrar',
    email: 'registrar@demo.clinmesh.local',
    name: '合成挂号员',
    practitionerId: 'practitioner-registrar',
    roleCode: 'registrar',
  },
  {
    actorId: 'actor-triage-nurse',
    email: 'triage@demo.clinmesh.local',
    name: '合成分诊护士',
    practitionerId: 'practitioner-triage-nurse',
    roleCode: 'triage-nurse',
  },
  {
    actorId: 'actor-outpatient-doctor',
    email: 'doctor@demo.clinmesh.local',
    name: '合成门诊医生',
    practitionerId: 'practitioner-outpatient-doctor',
    roleCode: 'outpatient-doctor',
  },
  {
    actorId: 'actor-cashier',
    email: 'cashier@demo.clinmesh.local',
    name: '合成收费员',
    practitionerId: 'practitioner-cashier',
    roleCode: 'cashier',
  },
  {
    actorId: 'actor-pharmacist',
    email: 'pharmacist@demo.clinmesh.local',
    name: '合成药师',
    practitionerId: 'practitioner-pharmacist',
    roleCode: 'pharmacist',
  },
  {
    actorId: 'actor-administrator',
    email: 'admin@demo.clinmesh.local',
    name: '合成管理员',
    practitionerId: 'practitioner-administrator',
    roleCode: 'administrator',
  },
] as const

interface IdentityServiceOptions {
  authBaseUrl: string
  authSecret: string
  now?: () => Date
  trustedOrigins: string[]
}

interface SeedSyntheticAccountsInput {
  password: string
  workspaceId: string
}

const roleRowSchema = z.object({
  actor_id: z.string().min(1),
  epoch: z.string().min(1),
  location_id: z.string().min(1),
  membership_id: z.string().min(1),
  organization_id: z.string().min(1),
  practitioner_id: z.string().min(1),
  practitioner_name: z.string().min(1),
  practitioner_role_id: z.string().min(1),
  role_code: roleCodeSchema,
  scenario_run_id: z.string().min(1),
  workspace_id: z.string().min(1),
})

type RoleRow = z.infer<typeof roleRowSchema>

const agentClientRowSchema = z.object({
  actor_id: z.string().min(1),
  agent_client_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
  name: z.string().min(1),
  status: z.enum(['active', 'disabled']),
})

type AgentClientRow = z.infer<typeof agentClientRowSchema>

const agentGrantRowSchema = z.object({
  active_epoch: z.string().min(1),
  agent_client_id: z.uuid(),
  catalog_hash: z.string().length(64),
  client_status: z.enum(['active', 'disabled']),
  created_at: z.iso.datetime({ offset: true }),
  epoch: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
  grant_id: z.uuid(),
  operation_ids_json: z.string(),
  policy_version: z.number().int().positive(),
  practitioner_role_id: z.string().min(1),
  revoked_at: z.iso.datetime({ offset: true }).nullable(),
  run_status: z.string().nullable(),
  workspace_policy_version: z.number().int().positive(),
})

type AgentGrantRow = z.infer<typeof agentGrantRowSchema>

const selectedRoleRowSchema = z.object({
  membership_id: z.string().min(1),
  practitioner_role_id: z.string().min(1),
})

const membershipGrantRowSchema = selectedRoleRowSchema.pick({ membership_id: true })

type ResolvedSessionContext = Omit<SessionContext, 'actor'> & { actor: ActorContext }

export class IdentityError extends Error {
  readonly code:
    | 'AGENT_CLIENT_NOT_FOUND'
    | 'AGENT_GRANT_NOT_FOUND'
    | 'AGENT_TOKEN_INVALID'
    | 'AUTHENTICATION_REQUIRED'
    | 'CSRF_REJECTED'
    | 'OPERATION_NOT_ALLOWED'
    | 'ROLE_NOT_ALLOWED'
  readonly status: 401 | 403 | 404

  constructor(
    code: IdentityError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
    this.status = code === 'AUTHENTICATION_REQUIRED' || code === 'AGENT_TOKEN_INVALID'
      ? 401
      : code === 'AGENT_CLIENT_NOT_FOUND' || code === 'AGENT_GRANT_NOT_FOUND'
        ? 404
        : 403
  }
}

function createAuth(database: ClinMeshDatabase, options: IdentityServiceOptions) {
  const orm = drizzle(database.driver, { schema: authSchema })
  return betterAuth({
    advanced: {
      // Better Auth otherwise skips origin validation when NODE_ENV=test.
      disableOriginCheck: false,
    },
    baseURL: options.authBaseUrl,
    database: drizzleAdapter(orm, {
      provider: 'sqlite',
      schema: authSchema,
    }),
    emailAndPassword: {
      autoSignIn: false,
      enabled: true,
    },
    secret: options.authSecret,
    trustedOrigins: options.trustedOrigins,
  })
}

export class IdentityService {
  readonly auth: ReturnType<typeof createAuth>
  readonly #catalogHash: string
  readonly #database: ClinMeshDatabase
  readonly #now: () => Date
  readonly #trustedOrigin: string
  readonly #trustedOrigins: Set<string>

  constructor(database: ClinMeshDatabase, options: IdentityServiceOptions) {
    this.#database = database
    this.#catalogHash = createHash('sha256').update(JSON.stringify(
      listHisOperations().map(operation => ({
        cliPath: operation.cliPath,
        commandOperation: operation.commandOperation,
        http: { method: operation.http.method, path: operation.http.path },
        id: operation.id,
        input: z.toJSONSchema(operation.input),
        mode: operation.mode,
        output: z.toJSONSchema(operation.output),
        requirements: operation.requirements,
        risk: operation.risk,
        roles: operation.roles,
        skill: operation.skill,
        version: operation.version,
      })),
    )).digest('hex')
    this.#now = options.now ?? (() => new Date())
    this.#trustedOrigin = options.trustedOrigins[0] ?? new URL(options.authBaseUrl).origin
    this.#trustedOrigins = new Set(options.trustedOrigins)
    this.auth = createAuth(database, options)
  }

  handle(request: Request): Promise<Response> {
    return this.auth.handler(request)
  }

  assertTrustedMutation(headers: Headers): void {
    if (this.#agentToken(headers) !== undefined) return
    const origin = headers.get('origin')
    if (origin === null || !this.#trustedOrigins.has(origin)) {
      throw new IdentityError('CSRF_REJECTED', 'The request origin is not trusted')
    }
  }

  async createAgentClient(headers: Headers, input: { name: string }) {
    const session = await this.#administratorSession(headers)
    const agentClientId = randomUUID()
    const actorId = `agent-${randomUUID()}`
    const createdAt = this.#now().toISOString()
    this.#database.driver.prepare(`
      INSERT INTO agent_client (
        agent_client_id, workspace_id, actor_id, name, status,
        created_by_actor_id, created_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(
      agentClientId,
      session.actor.workspaceId,
      actorId,
      input.name,
      session.actor.actorId,
      createdAt,
    )
    return { actorId, agentClientId, createdAt, name: input.name, status: 'active' as const }
  }

  async listAgentClients(headers: Headers) {
    const session = await this.#administratorSession(headers, false)
    const rows = z.array(agentClientRowSchema).parse(this.#database.driver.prepare(`
      SELECT actor_id, agent_client_id, created_at, name, status
      FROM agent_client
      WHERE workspace_id = ?
      ORDER BY created_at, agent_client_id
    `).all(session.actor.workspaceId))
    return agentClientListSchema.parse({ items: rows.map(row => this.#agentClient(row)) })
  }

  async getAgentClient(headers: Headers, agentClientId: string) {
    const session = await this.#administratorSession(headers, false)
    const row = agentClientRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT actor_id, agent_client_id, created_at, name, status
      FROM agent_client
      WHERE workspace_id = ? AND agent_client_id = ?
    `).get(session.actor.workspaceId, agentClientId))
    if (row === undefined) {
      throw new IdentityError('AGENT_CLIENT_NOT_FOUND', 'The Agent Client was not found')
    }
    return this.#agentClient(row)
  }

  async disableAgentClient(headers: Headers, agentClientId: string) {
    const session = await this.#administratorSession(headers)
    const result = this.#database.driver.prepare(`
      UPDATE agent_client
      SET status = 'disabled'
      WHERE workspace_id = ? AND agent_client_id = ?
    `).run(session.actor.workspaceId, agentClientId)
    if (result.changes !== 1) {
      throw new IdentityError('AGENT_CLIENT_NOT_FOUND', 'The Agent Client was not found')
    }
    const row = agentClientRowSchema.parse(this.#database.driver.prepare(`
      SELECT actor_id, agent_client_id, created_at, name, status
      FROM agent_client
      WHERE workspace_id = ? AND agent_client_id = ?
    `).get(session.actor.workspaceId, agentClientId))
    return this.#agentClient(row)
  }

  async createAgentGrant(headers: Headers, input: {
    agentClientId: string
    operationIds: string[]
    practitionerRoleId: string
    ttlSeconds: number
  }) {
    const session = await this.#administratorSession(headers)
    const client = z.object({ status: z.literal('active') }).optional().parse(
      this.#database.driver.prepare(`
        SELECT status FROM agent_client
        WHERE agent_client_id = ? AND workspace_id = ?
      `).get(input.agentClientId, session.actor.workspaceId),
    )
    if (client === undefined) {
      throw new IdentityError('AGENT_CLIENT_NOT_FOUND', 'The Agent Client was not found')
    }
    const role = session.availableRoles.find(item => item.id === input.practitionerRoleId)
    if (role === undefined) {
      throw new IdentityError('ROLE_NOT_ALLOWED', 'The Practitioner Role is not granted to this administrator')
    }
    const requestedOperations = [...new Set(input.operationIds)]
    const operationIds = [...new Set([
      ...requestedOperations,
      ...(requestedOperations.some(operationId => getHisOperation(operationId).mode !== 'query')
        ? ['command.receipt.get']
        : []),
    ])].toSorted()
    for (const operationId of operationIds) {
      const operation = getHisOperation(operationId)
      if (!operation.roles.includes(role.code)) {
        throw new IdentityError(
          'OPERATION_NOT_ALLOWED',
          `Operation ${operationId} is not available to Practitioner Role ${role.code}`,
        )
      }
    }
    const workspace = z.object({ policy_version: z.number().int().positive() }).parse(
      this.#database.driver.prepare(
        'SELECT policy_version FROM workspace WHERE workspace_id = ?',
      ).get(session.actor.workspaceId),
    )
    const token = `cma_${randomBytes(20).toString('hex')}`
    const grantId = randomUUID()
    const createdAt = this.#now().toISOString()
    const expiresAt = new Date(this.#now().getTime() + input.ttlSeconds * 1_000).toISOString()
    this.#database.driver.prepare(`
      INSERT INTO agent_capability_grant (
        grant_id, token_hash, agent_client_id, workspace_id, epoch,
        scenario_run_id, practitioner_role_id, operation_ids_json,
        catalog_hash, policy_version, expires_at, created_by_actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      grantId,
      createHash('sha256').update(token).digest('hex'),
      input.agentClientId,
      session.actor.workspaceId,
      session.actor.epoch,
      session.actor.scenarioRunId,
      input.practitionerRoleId,
      JSON.stringify(operationIds),
      this.#catalogHash,
      workspace.policy_version,
      expiresAt,
      session.actor.actorId,
      createdAt,
    )
    return {
      agentClientId: input.agentClientId,
      expiresAt,
      grantId,
      operationIds,
      practitionerRoleId: input.practitionerRoleId,
      token,
    }
  }

  async listAgentGrants(headers: Headers) {
    const session = await this.#administratorSession(headers, false)
    const rows = z.array(agentGrantRowSchema).parse(this.#database.driver.prepare(`
      SELECT grant.agent_client_id, grant.catalog_hash, grant.created_at,
        grant.epoch, grant.expires_at, grant.grant_id, grant.operation_ids_json,
        grant.policy_version, grant.practitioner_role_id, grant.revoked_at,
        client.status AS client_status, workspace.active_epoch,
        workspace.policy_version AS workspace_policy_version,
        run.status AS run_status
      FROM agent_capability_grant AS grant
      JOIN agent_client AS client
        ON client.agent_client_id = grant.agent_client_id
       AND client.workspace_id = grant.workspace_id
      JOIN workspace ON workspace.workspace_id = grant.workspace_id
      LEFT JOIN scenario_run AS run
        ON run.workspace_id = grant.workspace_id
       AND run.epoch = grant.epoch
       AND run.scenario_run_id = grant.scenario_run_id
      WHERE grant.workspace_id = ?
      ORDER BY grant.created_at DESC, grant.grant_id
    `).all(session.actor.workspaceId))
    return agentCapabilityGrantListSchema.parse({ items: rows.map(row => this.#agentGrant(row)) })
  }

  async getAgentGrant(headers: Headers, grantId: string) {
    const session = await this.#administratorSession(headers, false)
    const row = agentGrantRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT grant.agent_client_id, grant.catalog_hash, grant.created_at,
        grant.epoch, grant.expires_at, grant.grant_id, grant.operation_ids_json,
        grant.policy_version, grant.practitioner_role_id, grant.revoked_at,
        client.status AS client_status, workspace.active_epoch,
        workspace.policy_version AS workspace_policy_version,
        run.status AS run_status
      FROM agent_capability_grant AS grant
      JOIN agent_client AS client
        ON client.agent_client_id = grant.agent_client_id
       AND client.workspace_id = grant.workspace_id
      JOIN workspace ON workspace.workspace_id = grant.workspace_id
      LEFT JOIN scenario_run AS run
        ON run.workspace_id = grant.workspace_id
       AND run.epoch = grant.epoch
       AND run.scenario_run_id = grant.scenario_run_id
      WHERE grant.workspace_id = ? AND grant.grant_id = ?
    `).get(session.actor.workspaceId, grantId))
    if (row === undefined) {
      throw new IdentityError('AGENT_GRANT_NOT_FOUND', 'The Agent Capability Grant was not found')
    }
    return this.#agentGrant(row)
  }

  async resolveActorContext(headers: Headers, operationId: string): Promise<ActorContext> {
    const token = this.#agentToken(headers)
    if (token === undefined) return (await this.resolveSessionContext(headers)).actor
    const row = z.object({
      actor_id: z.string().min(1),
      active_epoch: z.string().min(1),
      catalog_hash: z.string().length(64),
      epoch: z.string().min(1),
      expires_at: z.iso.datetime({ offset: true }),
      location_id: z.string().min(1),
      operation_ids_json: z.string(),
      organization_id: z.string().min(1),
      policy_version: z.number().int().positive(),
      practitioner_id: z.string().min(1),
      practitioner_role_id: z.string().min(1),
      role_code: roleCodeSchema,
      scenario_run_id: z.string().min(1),
      status: z.literal('active'),
      workspace_id: z.string().min(1),
      workspace_policy_version: z.number().int().positive(),
    }).optional().parse(this.#database.driver.prepare(`
      SELECT client.actor_id, client.status,
        grant.workspace_id, grant.epoch, grant.scenario_run_id,
        grant.practitioner_role_id, grant.operation_ids_json,
        grant.catalog_hash, grant.policy_version, grant.expires_at,
        workspace.active_epoch, workspace.policy_version AS workspace_policy_version,
        role.practitioner_id, role.role_code, role.organization_id, role.location_id
      FROM agent_capability_grant AS grant
      JOIN agent_client AS client
        ON client.agent_client_id = grant.agent_client_id
       AND client.workspace_id = grant.workspace_id
       AND client.status = 'active'
      JOIN workspace ON workspace.workspace_id = grant.workspace_id
      JOIN practitioner_role_binding AS role
        ON role.workspace_id = grant.workspace_id
       AND role.practitioner_role_id = grant.practitioner_role_id
       AND role.active = 1
      JOIN scenario_run AS run
        ON run.workspace_id = grant.workspace_id
       AND run.epoch = grant.epoch
       AND run.scenario_run_id = grant.scenario_run_id
       AND run.status = 'active'
      WHERE grant.token_hash = ?
        AND grant.revoked_at IS NULL
    `).get(createHash('sha256').update(token).digest('hex')))
    if (
      row === undefined
      || row.expires_at <= this.#now().toISOString()
      || row.active_epoch !== row.epoch
      || row.catalog_hash !== this.#catalogHash
      || row.policy_version !== row.workspace_policy_version
    ) {
      throw new IdentityError('AGENT_TOKEN_INVALID', 'The Agent Capability Grant is invalid')
    }
    const operationIds = z.array(z.string().min(1)).parse(JSON.parse(row.operation_ids_json) as unknown)
    if (!operationIds.includes(operationId)) {
      throw new IdentityError('OPERATION_NOT_ALLOWED', `Operation ${operationId} is not allowed by this Agent Grant`)
    }
    const operation = getHisOperation(operationId)
    if (!operation.roles.includes(row.role_code)) {
      throw new IdentityError('OPERATION_NOT_ALLOWED', `Operation ${operationId} is not available to this role`)
    }
    return {
      actorId: row.actor_id,
      epoch: row.epoch,
      locationId: row.location_id,
      organizationId: row.organization_id,
      practitionerId: row.practitioner_id,
      practitionerRoleId: row.practitioner_role_id,
      roleCode: row.role_code,
      scenarioRunId: row.scenario_run_id,
      workspaceId: row.workspace_id,
    }
  }

  async resolveRequestActor(
    headers: Headers,
    method: string,
    pathname: string,
  ): Promise<ActorContext> {
    if (this.#agentToken(headers) === undefined) {
      return (await this.resolveSessionContext(headers)).actor
    }
    const operation = matchHisOperation(method, pathname)
    if (operation === undefined) {
      throw new IdentityError('OPERATION_NOT_ALLOWED', 'The request is not an allowed Agent operation')
    }
    return this.resolveActorContext(headers, operation.id)
  }

  async resolveAdministratorActor(
    headers: Headers,
    method: string,
    pathname: string,
  ): Promise<ActorContext> {
    if (this.#agentToken(headers) !== undefined) {
      const actor = await this.resolveRequestActor(headers, method, pathname)
      if (actor.roleCode !== 'administrator') {
        throw new IdentityError('ROLE_NOT_ALLOWED', 'An administrator role is required')
      }
      return actor
    }
    const session = await this.resolveSessionContext(headers)
    if (!session.availableRoles.some(role => role.code === 'administrator')) {
      throw new IdentityError('ROLE_NOT_ALLOWED', 'An administrator account is required')
    }
    return session.actor
  }

  async resolveAgentCapabilityContext(headers: Headers) {
    const token = this.#agentToken(headers)
    if (token === undefined) {
      throw new IdentityError('AGENT_TOKEN_INVALID', 'A valid Agent Capability Grant is required')
    }
    const row = z.object({
      agent_client_id: z.uuid(),
      expires_at: z.iso.datetime({ offset: true }),
      grant_id: z.uuid(),
      name: z.string().min(1),
      operation_ids_json: z.string(),
      policy_version: z.number().int().positive(),
    }).optional().parse(this.#database.driver.prepare(`
      SELECT grant.grant_id, grant.agent_client_id, grant.expires_at,
        grant.operation_ids_json, grant.policy_version, client.name
      FROM agent_capability_grant AS grant
      JOIN agent_client AS client
        ON client.agent_client_id = grant.agent_client_id
       AND client.workspace_id = grant.workspace_id
       AND client.status = 'active'
      WHERE grant.token_hash = ? AND grant.revoked_at IS NULL
    `).get(createHash('sha256').update(token).digest('hex')))
    if (row === undefined) {
      throw new IdentityError('AGENT_TOKEN_INVALID', 'The Agent Capability Grant is invalid')
    }
    const operationIds = z.array(z.string().min(1)).min(1)
      .parse(JSON.parse(row.operation_ids_json) as unknown)
    const actor = await this.resolveActorContext(headers, operationIds[0]!)
    return agentCapabilityContextSchema.parse({
      actor,
      agent: {
        agentClientId: row.agent_client_id,
        name: row.name,
      },
      grant: {
        expiresAt: row.expires_at,
        grantId: row.grant_id,
        operationIds,
        policyVersion: row.policy_version,
      },
    })
  }

  async revokeAgentGrant(headers: Headers, grantId: string) {
    const session = await this.#administratorSession(headers)
    const revokedAt = this.#now().toISOString()
    const result = this.#database.driver.prepare(`
      UPDATE agent_capability_grant
      SET revoked_at = ?
      WHERE grant_id = ? AND workspace_id = ? AND revoked_at IS NULL
    `).run(revokedAt, grantId, session.actor.workspaceId)
    if (result.changes !== 1) {
      throw new IdentityError('AGENT_TOKEN_INVALID', 'The Agent Capability Grant is not active')
    }
    return { grantId, revokedAt, status: 'revoked' as const }
  }

  async seedSyntheticAccounts(input: SeedSyntheticAccountsInput): Promise<void> {
    for (const account of syntheticAccounts) {
      const existing = this.#database.driver.prepare(
        'SELECT id FROM user WHERE email = ?',
      ).get(account.email) as { id: string } | undefined
      if (existing === undefined) {
        const response = await this.auth.handler(new Request(
          new URL('/api/auth/sign-up/email', this.#trustedOrigin),
          {
            body: JSON.stringify({
              email: account.email,
              name: account.name,
              password: input.password,
            }),
            headers: {
              'content-type': 'application/json',
              origin: this.#trustedOrigin,
            },
            method: 'POST',
          },
        ))
        if (!response.ok) throw new Error(`Synthetic account seed failed for ${account.roleCode}`)
      }

      const user = this.#database.driver.prepare(
        'SELECT id FROM user WHERE email = ?',
      ).get(account.email) as { id: string } | undefined
      if (user === undefined) throw new Error(`Synthetic account was not persisted for ${account.roleCode}`)
      const roleId = `practitioner-role-${account.roleCode}`
      const membershipId = `membership-${account.roleCode}`
      this.#database.driver.prepare(`
        INSERT OR IGNORE INTO practitioner_role_binding (
          workspace_id, practitioner_role_id, practitioner_id, role_code,
          organization_id, location_id, active
        ) VALUES (?, ?, ?, ?, 'organization-clinmesh', ?, 1)
      `).run(input.workspaceId, roleId, account.practitionerId, account.roleCode, `location-${account.roleCode}`)
      this.#database.driver.prepare(`
        INSERT OR IGNORE INTO workspace_membership (
          membership_id, workspace_id, user_id, actor_id, status, created_at
        ) VALUES (?, ?, ?, ?, 'active', ?)
      `).run(membershipId, input.workspaceId, user.id, account.actorId, new Date().toISOString())
      this.#database.driver.prepare(`
        INSERT OR IGNORE INTO membership_practitioner_role (
          membership_id, workspace_id, practitioner_role_id
        ) VALUES (?, ?, ?)
      `).run(membershipId, input.workspaceId, roleId)
    }
    this.#database.driver.prepare(`
      INSERT OR IGNORE INTO membership_practitioner_role (
        membership_id, workspace_id, practitioner_role_id
      )
      SELECT 'membership-administrator', workspace_id, practitioner_role_id
      FROM practitioner_role_binding
      WHERE workspace_id = ? AND active = 1
    `).run(input.workspaceId)
  }

  async selectRole(headers: Headers, practitionerRoleId: string): Promise<ResolvedSessionContext> {
    this.assertTrustedMutation(headers)
    const authSession = await this.auth.api.getSession({ headers })
    if (authSession === null) {
      throw new IdentityError('AUTHENTICATION_REQUIRED', 'A valid session is required')
    }
    const grant = membershipGrantRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT membership.membership_id
        FROM workspace_membership AS membership
        JOIN membership_practitioner_role AS granted
          ON granted.membership_id = membership.membership_id
         AND granted.workspace_id = membership.workspace_id
        JOIN practitioner_role_binding AS role
          ON role.workspace_id = granted.workspace_id
         AND role.practitioner_role_id = granted.practitioner_role_id
        WHERE membership.user_id = ?
          AND membership.status = 'active'
          AND granted.practitioner_role_id = ?
          AND role.active = 1
        ORDER BY membership.workspace_id
        LIMIT 1
      `).get(authSession.user.id, practitionerRoleId),
    )
    if (grant === undefined) {
      throw new IdentityError('ROLE_NOT_ALLOWED', 'The Practitioner Role is not granted to this account')
    }
    this.#database.driver.prepare(`
      INSERT INTO auth_session_context (
        session_id, membership_id, practitioner_role_id, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        membership_id = excluded.membership_id,
        practitioner_role_id = excluded.practitioner_role_id,
        updated_at = excluded.updated_at
    `).run(authSession.session.id, grant.membership_id, practitionerRoleId, new Date().toISOString())
    return this.resolveSessionContext(headers)
  }

  async resolveSessionContext(headers: Headers): Promise<ResolvedSessionContext> {
    const authSession = await this.auth.api.getSession({ headers })
    if (authSession === null) {
      throw new IdentityError('AUTHENTICATION_REQUIRED', 'A valid session is required')
    }
    const roles = z.array(roleRowSchema).parse(this.#database.driver.prepare(`
      SELECT
        membership.actor_id,
        membership.membership_id,
        membership.workspace_id,
        workspace.active_epoch AS epoch,
        role.practitioner_role_id,
        role.practitioner_id,
        json_extract(practitioner.content_json, '$.name[0].text') AS practitioner_name,
        role.role_code,
        role.organization_id,
        role.location_id,
        run.scenario_run_id
      FROM workspace_membership AS membership
      JOIN workspace ON workspace.workspace_id = membership.workspace_id
      JOIN membership_practitioner_role AS granted
        ON granted.membership_id = membership.membership_id
       AND granted.workspace_id = membership.workspace_id
      JOIN practitioner_role_binding AS role
        ON role.workspace_id = granted.workspace_id
       AND role.practitioner_role_id = granted.practitioner_role_id
      JOIN fhir_resource AS practitioner
        ON practitioner.workspace_id = role.workspace_id
       AND practitioner.epoch = workspace.active_epoch
       AND practitioner.resource_type = 'Practitioner'
       AND practitioner.resource_id = role.practitioner_id
       AND practitioner.deleted = 0
      JOIN scenario_run AS run
        ON run.workspace_id = workspace.workspace_id
       AND run.epoch = workspace.active_epoch
      WHERE membership.user_id = ?
        AND membership.status = 'active'
        AND role.active = 1
      ORDER BY membership.workspace_id, role.practitioner_role_id
    `).all(authSession.user.id))
    const selectedRole = this.#selectedRole(authSession.session.id, roles) ?? roles[0]
    if (selectedRole === undefined) {
      throw new IdentityError('ROLE_NOT_ALLOWED', 'The account has no active Workspace role')
    }

    return {
      actor: {
        actorId: selectedRole.actor_id,
        epoch: selectedRole.epoch,
        locationId: selectedRole.location_id,
        organizationId: selectedRole.organization_id,
        practitionerId: selectedRole.practitioner_id,
        practitionerRoleId: selectedRole.practitioner_role_id,
        roleCode: selectedRole.role_code,
        scenarioRunId: selectedRole.scenario_run_id,
        workspaceId: selectedRole.workspace_id,
      },
      availableRoles: roles
        .filter(role => role.workspace_id === selectedRole.workspace_id)
        .map(role => ({
          code: role.role_code,
          id: role.practitioner_role_id,
          locationId: role.location_id,
          organizationId: role.organization_id,
          practitionerId: role.practitioner_id,
          practitionerName: role.practitioner_name,
        })),
      user: {
        email: authSession.user.email,
        id: authSession.user.id,
        name: authSession.user.name,
      },
    }
  }

  #agentToken(headers: Headers): string | undefined {
    const authorization = headers.get('authorization')
    if (authorization === null) return undefined
    const match = /^Bearer (cma_[a-f0-9]{40})$/.exec(authorization)
    if (match === null) {
      throw new IdentityError('AGENT_TOKEN_INVALID', 'A valid Agent Capability Grant is required')
    }
    return match[1]
  }

  #agentClient(row: AgentClientRow) {
    return agentClientSchema.parse({
      actorId: row.actor_id,
      agentClientId: row.agent_client_id,
      createdAt: row.created_at,
      name: row.name,
      status: row.status,
    })
  }

  #agentGrant(row: AgentGrantRow) {
    let status: 'active' | 'expired' | 'invalidated' | 'revoked' = 'active'
    if (row.revoked_at !== null) {
      status = 'revoked'
    } else if (row.expires_at <= this.#now().toISOString()) {
      status = 'expired'
    } else if (
      row.client_status !== 'active'
      || row.active_epoch !== row.epoch
      || row.catalog_hash !== this.#catalogHash
      || row.policy_version !== row.workspace_policy_version
      || row.run_status !== 'active'
    ) {
      status = 'invalidated'
    }
    return agentCapabilityGrantViewSchema.parse({
      agentClientId: row.agent_client_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      grantId: row.grant_id,
      operationIds: z.array(z.string().min(1)).min(1).parse(
        JSON.parse(row.operation_ids_json) as unknown,
      ),
      practitionerRoleId: row.practitioner_role_id,
      revokedAt: row.revoked_at,
      status,
    })
  }

  async #administratorSession(
    headers: Headers,
    trustedMutation = true,
  ): Promise<ResolvedSessionContext> {
    if (trustedMutation) this.assertTrustedMutation(headers)
    const session = await this.resolveSessionContext(headers)
    if (!session.availableRoles.some(role => role.code === 'administrator')) {
      throw new IdentityError('ROLE_NOT_ALLOWED', 'An administrator account is required')
    }
    return session
  }

  #selectedRole(sessionId: string, roles: RoleRow[]): RoleRow | undefined {
    const selected = selectedRoleRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT membership_id, practitioner_role_id
      FROM auth_session_context
      WHERE session_id = ?
    `).get(sessionId))
    if (selected === undefined) return undefined
    return roles.find(role => (
      role.membership_id === selected.membership_id
      && role.practitioner_role_id === selected.practitioner_role_id
    ))
  }
}
