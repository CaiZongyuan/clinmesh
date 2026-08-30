import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function createRuntime(now?: () => Date) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-agent-capability-'))
  const password = 'synthetic-agent-capability-password'
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost',
    authSecret: 'synthetic-agent-capability-secret-32-bytes',
    cursorSecret: 'synthetic-agent-capability-cursor-secret',
    databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: password,
    migrationMode: 'apply',
    ...(now === undefined ? {} : { now }),
    trustedOrigins: ['http://localhost'],
  })
  cleanups.push(async () => {
    await runtime.close()
    await rm(directory, { force: true, recursive: true })
  })
  return { password, runtime }
}

async function signIn(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>, password: string) {
  const response = await runtime.app.request('/api/auth/sign-in/email', {
    body: JSON.stringify({ email: 'admin@demo.clinmesh.local', password }),
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    method: 'POST',
  })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
}

describe('Agent Capability Grant HTTP authentication', () => {
  it('lets a human administrator inspect and disable Agent credentials without returning token material', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const mutationHeaders = {
      'content-type': 'application/json',
      cookie,
      origin: 'http://localhost',
    }
    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Inspectable synthetic agent' }),
      headers: mutationHeaders,
      method: 'POST',
    })
    const client = await clientResponse.json() as { agentClientId: string }
    const grantResponse = await runtime.app.request('/api/agent/v1/grants', {
      body: JSON.stringify({
        agentClientId: client.agentClientId,
        operationIds: ['reference.diagnoses.search'],
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        ttlSeconds: 3600,
      }),
      headers: mutationHeaders,
      method: 'POST',
    })
    const grant = await grantResponse.json() as { grantId: string; token: string }

    const [clientsResponse, clientDetailResponse, grantsResponse, grantDetailResponse] = await Promise.all([
      runtime.app.request('/api/agent/v1/clients', { headers: { cookie } }),
      runtime.app.request(`/api/agent/v1/clients/${client.agentClientId}`, { headers: { cookie } }),
      runtime.app.request('/api/agent/v1/grants', { headers: { cookie } }),
      runtime.app.request(`/api/agent/v1/grants/${grant.grantId}`, { headers: { cookie } }),
    ])
    expect([
      clientsResponse.status,
      clientDetailResponse.status,
      grantsResponse.status,
      grantDetailResponse.status,
    ]).toEqual([200, 200, 200, 200])
    const clients = await clientsResponse.json() as { items: unknown[] }
    const clientDetail = await clientDetailResponse.json()
    const grants = await grantsResponse.json() as { items: unknown[] }
    const grantDetail = await grantDetailResponse.json()
    expect(clients.items).toContainEqual(expect.objectContaining({
      agentClientId: client.agentClientId,
      name: 'Inspectable synthetic agent',
      status: 'active',
    }))
    expect(clientDetail).toMatchObject({ agentClientId: client.agentClientId, status: 'active' })
    expect(grants.items).toContainEqual(expect.objectContaining({
      agentClientId: client.agentClientId,
      grantId: grant.grantId,
      operationIds: ['reference.diagnoses.search'],
      status: 'active',
    }))
    expect(grantDetail).toMatchObject({ grantId: grant.grantId, status: 'active' })
    expect(JSON.stringify({ clients, clientDetail, grants, grantDetail })).not.toContain(grant.token)

    const disabledResponse = await runtime.app.request(
      `/api/agent/v1/clients/${client.agentClientId}/actions/disable`,
      {
        body: '{}',
        headers: mutationHeaders,
        method: 'POST',
      },
    )
    expect(disabledResponse.status).toBe(200)
    await expect(disabledResponse.json()).resolves.toMatchObject({
      agentClientId: client.agentClientId,
      status: 'disabled',
    })
    const denied = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=diabetes',
      { headers: { authorization: `Bearer ${grant.token}` } },
    )
    expect(denied.status).toBe(401)
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: 'AGENT_TOKEN_INVALID' },
    })
  })

  it('stores only the token hash and enforces its role-bound operation allowlist', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const mutationHeaders = {
      'content-type': 'application/json',
      cookie,
      origin: 'http://localhost',
    }

    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Synthetic whole-HIS agent' }),
      headers: mutationHeaders,
      method: 'POST',
    })
    expect(clientResponse.status).toBe(200)
    const client = await clientResponse.json() as { agentClientId: string }

    const grantResponse = await runtime.app.request('/api/agent/v1/grants', {
      body: JSON.stringify({
        agentClientId: client.agentClientId,
        operationIds: ['reference.diagnoses.search'],
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        ttlSeconds: 3600,
      }),
      headers: mutationHeaders,
      method: 'POST',
    })
    expect(grantResponse.status).toBe(200)
    const grant = await grantResponse.json() as { grantId: string; token: string }
    expect(grant.token).toMatch(/^cma_[a-f0-9]{40}$/)

    const persisted = runtime.database.driver.prepare(
      'SELECT token_hash FROM agent_capability_grant WHERE grant_id = ?',
    ).get(grant.grantId) as { token_hash: string }
    expect(persisted.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(persisted.token_hash).not.toContain(grant.token)

    const contextResponse = await runtime.app.request('/api/agent/v1/context', {
      headers: { authorization: `Bearer ${grant.token}` },
    })
    expect(contextResponse.status).toBe(200)
    const contextBody = JSON.stringify(await contextResponse.json())
    expect(contextBody).not.toContain(grant.token)
    expect(JSON.parse(contextBody)).toMatchObject({
      actor: {
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        roleCode: 'outpatient-doctor',
        workspaceId: 'workspace-demo',
      },
      grant: {
        grantId: grant.grantId,
        operationIds: ['reference.diagnoses.search'],
      },
    })

    const allowed = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=diabetes',
      { headers: { authorization: `Bearer ${grant.token}` } },
    )
    expect(allowed.status).toBe(200)

    const denied = await runtime.app.request(
      '/api/his/v1/billing/queue?category=laboratory&status=pending&page=1&pageSize=20',
      { headers: { authorization: `Bearer ${grant.token}` } },
    )
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: 'OPERATION_NOT_ALLOWED' },
    })

    const revoked = await runtime.app.request(
      `/api/agent/v1/grants/${grant.grantId}/actions/revoke`,
      {
        body: '{}',
        headers: mutationHeaders,
        method: 'POST',
      },
    )
    expect(revoked.status).toBe(200)
    const afterRevocation = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=diabetes',
      { headers: { authorization: `Bearer ${grant.token}` } },
    )
    expect(afterRevocation.status).toBe(401)
    await expect(afterRevocation.json()).resolves.toMatchObject({
      error: { code: 'AGENT_TOKEN_INVALID' },
    })
  })

  it('does not fall back to a human Cookie when an Agent Authorization header is malformed', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const response = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=diabetes',
      {
        headers: {
          authorization: 'Bearer cma_invalid',
          cookie,
        },
      },
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AGENT_TOKEN_INVALID' },
    })
  })

  it('rejects an otherwise unchanged token immediately after its Grant expires', async () => {
    let now = new Date('2026-08-31T00:00:00.000Z')
    const { password, runtime } = await createRuntime(() => now)
    const cookie = await signIn(runtime, password)
    const headers = {
      'content-type': 'application/json',
      cookie,
      origin: 'http://localhost',
    }
    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Expiring synthetic agent' }),
      headers,
      method: 'POST',
    })
    const client = await clientResponse.json() as { agentClientId: string }
    const grantResponse = await runtime.app.request('/api/agent/v1/grants', {
      body: JSON.stringify({
        agentClientId: client.agentClientId,
        operationIds: ['reference.diagnoses.search'],
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        ttlSeconds: 60,
      }),
      headers,
      method: 'POST',
    })
    const grant = await grantResponse.json() as { token: string }
    const path = '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=diabetes'

    expect((await runtime.app.request(path, {
      headers: { authorization: `Bearer ${grant.token}` },
    })).status).toBe(200)
    now = new Date('2026-08-31T00:01:01.000Z')
    const expired = await runtime.app.request(path, {
      headers: { authorization: `Bearer ${grant.token}` },
    })
    expect(expired.status).toBe(401)
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: 'AGENT_TOKEN_INVALID' },
    })
  })

  it('ignores forged context headers and invalidates a Grant when its Epoch is reset', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const mutationHeaders = {
      'content-type': 'application/json',
      cookie,
      origin: 'http://localhost',
    }
    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Epoch-bound synthetic agent' }),
      headers: mutationHeaders,
      method: 'POST',
    })
    const client = await clientResponse.json() as { agentClientId: string }
    const grantResponse = await runtime.app.request('/api/agent/v1/grants', {
      body: JSON.stringify({
        agentClientId: client.agentClientId,
        operationIds: ['reference.diagnoses.search'],
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        ttlSeconds: 3600,
      }),
      headers: mutationHeaders,
      method: 'POST',
    })
    const grant = await grantResponse.json() as { token: string }
    const agentHeaders = {
      authorization: `Bearer ${grant.token}`,
      'x-clinmesh-epoch': 'epoch-forged',
      'x-clinmesh-practitioner-role-id': 'practitioner-role-administrator',
      'x-clinmesh-scenario-run-id': 'scenario-run-forged',
      'x-clinmesh-workspace-id': 'workspace-forged',
    }
    const contextResponse = await runtime.app.request('/api/agent/v1/context', {
      headers: agentHeaders,
    })
    expect(contextResponse.status).toBe(200)
    await expect(contextResponse.json()).resolves.toMatchObject({
      actor: {
        epoch: 'epoch-1',
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        scenarioRunId: 'scenario-run-1',
        workspaceId: 'workspace-demo',
      },
    })

    const resetResponse = await runtime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      {
        body: '{}',
        headers: {
          ...mutationHeaders,
          'idempotency-key': 'agent-grant-epoch-reset-1',
        },
        method: 'POST',
      },
    )
    expect(resetResponse.status).toBe(200)
    const afterReset = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=diabetes',
      { headers: agentHeaders },
    )
    expect(afterReset.status).toBe(401)
    await expect(afterReset.json()).resolves.toMatchObject({
      error: { code: 'AGENT_TOKEN_INVALID' },
    })
  })

  it('invalidates Grants when their Catalog hash or Workspace policy version becomes stale', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const headers = {
      'content-type': 'application/json',
      cookie,
      origin: 'http://localhost',
    }
    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Version-bound synthetic agent' }),
      headers,
      method: 'POST',
    })
    const client = await clientResponse.json() as { agentClientId: string }
    const createGrant = async () => {
      const response = await runtime.app.request('/api/agent/v1/grants', {
        body: JSON.stringify({
          agentClientId: client.agentClientId,
          operationIds: ['reference.diagnoses.search'],
          practitionerRoleId: 'practitioner-role-outpatient-doctor',
          ttlSeconds: 3600,
        }),
        headers,
        method: 'POST',
      })
      return await response.json() as { grantId: string; token: string }
    }
    const requestWith = (token: string) => runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=diabetes',
      { headers: { authorization: `Bearer ${token}` } },
    )

    const catalogGrant = await createGrant()
    runtime.database.driver.prepare(`
      UPDATE agent_capability_grant SET catalog_hash = ? WHERE grant_id = ?
    `).run('0'.repeat(64), catalogGrant.grantId)
    expect((await requestWith(catalogGrant.token)).status).toBe(401)

    const policyGrant = await createGrant()
    runtime.database.driver.prepare(`
      UPDATE workspace SET policy_version = policy_version + 1 WHERE workspace_id = ?
    `).run('workspace-demo')
    expect((await requestWith(policyGrant.token)).status).toBe(401)
  })
})
