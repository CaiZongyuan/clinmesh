import { afterEach, expect, it } from 'vitest'
import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { mutation } from './fixtures/imaging-scenario.ts'
import { createPathologyReadingScenario } from './fixtures/pathology-reading-scenario.ts'

type Scenario = Awaited<ReturnType<typeof createPathologyReadingScenario>>
const scenarios: Scenario[] = []
afterEach(async () => { for (const scenario of scenarios.splice(0)) await scenario.close() })
async function setup() { const scenario = await createPathologyReadingScenario(); scenarios.push(scenario); return scenario }

async function sessionContext(scenario: Scenario) {
  const response = await scenario.runtime.app.request('/api/auth/context', { headers: { cookie: scenario.visit.doctor } })
  expect(response.status).toBe(200)
  return sessionContextSchema.parse(await response.json())
}

/** 持久化身份 fixture：同一账号在另一工作区拥有同编号岗位，切换与授权均通过公开 HTTP 观察。 */
function addEarlierWorkspaceRole(scenario: Scenario, current: SessionContext) {
  const workspaceId = 'workspace-alternate', membershipId = 'membership-alternate-doctor'
  const { database } = scenario.runtime, actor = current.actor
  new WorkspaceRepository(database).install({ workspaceId, epoch: actor.epoch, scenarioId: 'synthetic-reading-scenario',
    scenarioRunId: 'synthetic-alternate-run', workspaceName: '合成另一工作区' })
  database.driver.prepare(`INSERT INTO practitioner_role_binding
    (workspace_id,practitioner_role_id,practitioner_id,role_code,organization_id,location_id,active)
    SELECT ?,practitioner_role_id,practitioner_id,role_code,organization_id,location_id,active
    FROM practitioner_role_binding WHERE workspace_id=? AND practitioner_role_id=?`)
    .run(workspaceId, actor.workspaceId, actor.practitionerRoleId)
  database.driver.prepare(`INSERT INTO fhir_resource
    (workspace_id,epoch,resource_type,resource_id,version_id,last_updated,deleted,owner_kind,content_json,content_hash)
    SELECT ?,epoch,resource_type,resource_id,version_id,last_updated,deleted,owner_kind,content_json,content_hash
    FROM fhir_resource WHERE workspace_id=? AND epoch=?
      AND ((resource_type='PractitionerRole' AND resource_id=?) OR (resource_type='Practitioner' AND resource_id=?))`)
    .run(workspaceId, actor.workspaceId, actor.epoch, actor.practitionerRoleId, actor.practitionerId)
  database.driver.prepare(`INSERT INTO workspace_membership
    (membership_id,workspace_id,user_id,actor_id,status,created_at) VALUES (?,?,?,?,'active',?)`)
    .run(membershipId, workspaceId, current.user.id, actor.actorId, new Date().toISOString())
  database.driver.prepare('INSERT INTO membership_practitioner_role (membership_id,workspace_id,practitioner_role_id) VALUES (?,?,?)')
    .run(membershipId, workspaceId, actor.practitionerRoleId)
}

for (const selection of ['explicit', 'default'] as const) it(`同编号岗位跨工作区${selection === 'explicit' ? '显式切换' : '默认选择变化'}后撤销原阅片会话`, async () => {
  const s = await setup(), before = await sessionContext(s)
  if (selection === 'explicit') {
    const selected = await s.runtime.app.request('/api/auth/role', mutation(s.visit.doctor, { practitionerRoleId: before.actor.practitionerRoleId }))
    expect(selected.status).toBe(200)
  }
  const opened = await s.session()
  const bindingId = [...s.remote.bindings.keys()][0]!
  expect(await (await s.callback(opened.sessionId, { event: 'authorize', bindingId, revision: 0 })).json())
    .toEqual({ active: true, writable: true })
  addEarlierWorkspaceRole(s, before)
  if (selection === 'explicit') {
    const switched = await s.runtime.app.request('/api/auth/role', mutation(s.visit.doctor, { practitionerRoleId: before.actor.practitionerRoleId }))
    expect(switched.status).toBe(200)
  }
  const after = await sessionContext(s)
  expect(after.actor).toMatchObject({ workspaceId: 'workspace-alternate', practitionerRoleId: before.actor.practitionerRoleId })
  expect(await (await s.callback(opened.sessionId, { event: 'authorize', bindingId, revision: 0, intentId: 'after-workspace-switch' })).json())
    .toEqual({ active: false, writable: false })
})

for (const invalidation of ['deleted', 'inactive', 'binding-inactive'] as const) it(`当前岗位${invalidation}后原阅片回调失活，公开身份入口也拒绝该岗位`, async () => {
  const s = await setup(), opened = await s.session(), current = await sessionContext(s)
  const bindingId = [...s.remote.bindings.keys()][0]!, actor = current.actor
  if (invalidation === 'deleted') {
    s.runtime.database.driver.prepare(`UPDATE fhir_resource SET deleted=1
      WHERE workspace_id=? AND epoch=? AND resource_type='PractitionerRole' AND resource_id=?`)
      .run(actor.workspaceId, actor.epoch, actor.practitionerRoleId)
  } else if (invalidation === 'inactive') {
    const role = s.runtime.fhir.read(actor, 'PractitionerRole', actor.practitionerRoleId!)
    s.runtime.fhir.update(actor, { ...role, active: false }, role.meta!.versionId!)
  } else {
    s.runtime.database.driver.prepare('UPDATE practitioner_role_binding SET active=0 WHERE workspace_id=? AND practitioner_role_id=?')
      .run(actor.workspaceId, actor.practitionerRoleId)
  }
  expect(await (await s.callback(opened.sessionId, { event: 'authorize', bindingId, revision: 0, intentId: 'after-role-invalidated' })).json())
    .toEqual({ active: false, writable: false })
  const denied = await s.runtime.app.request('/api/auth/context', { headers: { cookie: s.visit.doctor } })
  expect(denied.status).toBe(403)
  const selected = await s.runtime.app.request('/api/auth/role', mutation(s.visit.doctor, { practitionerRoleId: actor.practitionerRoleId }))
  expect(selected.status).toBe(403)
})
