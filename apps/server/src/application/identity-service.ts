import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { roleCodeSchema, type SessionContext } from '@clinmesh/contracts/his'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import type { ActorContext } from './command-executor.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import * as authSchema from '../infrastructure/auth/schema.ts'

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

const selectedRoleRowSchema = z.object({
  membership_id: z.string().min(1),
  practitioner_role_id: z.string().min(1),
})

const membershipGrantRowSchema = selectedRoleRowSchema.pick({ membership_id: true })

type ResolvedSessionContext = Omit<SessionContext, 'actor'> & { actor: ActorContext }

export class IdentityError extends Error {
  readonly code: 'AUTHENTICATION_REQUIRED' | 'CSRF_REJECTED' | 'ROLE_NOT_ALLOWED'
  readonly status: 401 | 403

  constructor(
    code: 'AUTHENTICATION_REQUIRED' | 'CSRF_REJECTED' | 'ROLE_NOT_ALLOWED',
    message: string,
  ) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
    this.status = code === 'AUTHENTICATION_REQUIRED' ? 401 : 403
  }
}

function createAuth(database: ClinMeshDatabase, options: IdentityServiceOptions) {
  const orm = drizzle(database.driver, { schema: authSchema })
  return betterAuth({
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
  readonly #database: ClinMeshDatabase
  readonly #trustedOrigin: string
  readonly #trustedOrigins: Set<string>

  constructor(database: ClinMeshDatabase, options: IdentityServiceOptions) {
    this.#database = database
    this.#trustedOrigin = options.trustedOrigins[0] ?? new URL(options.authBaseUrl).origin
    this.#trustedOrigins = new Set(options.trustedOrigins)
    this.auth = createAuth(database, options)
  }

  handle(request: Request): Promise<Response> {
    return this.auth.handler(request)
  }

  assertTrustedMutation(headers: Headers): void {
    const origin = headers.get('origin')
    if (origin === null || !this.#trustedOrigins.has(origin)) {
      throw new IdentityError('CSRF_REJECTED', 'The request origin is not trusted')
    }
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
