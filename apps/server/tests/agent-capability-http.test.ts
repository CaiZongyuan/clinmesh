import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agentCapabilityContextSchema,
  agentCapabilityGrantListSchema,
  agentCapabilityGrantSchema,
  agentCapabilityGrantViewSchema,
  agentClientListSchema,
  agentClientSchema,
  revokedAgentCapabilityGrantSchema,
} from '@clinmesh/contracts/agent'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import { operationOutcomeSchema } from '@clinmesh/contracts/fhir'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { AuditQuery } from '../src/application/audit-query.ts'

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

async function parseApiError(response: Response) {
  return apiErrorSchema.parse(await response.json())
}

describe('Agent Capability Grant HTTP authentication', () => {
  it('protects FHIR metadata with authentication and the Grant operation allowlist', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const mutationHeaders = {
      'content-type': 'application/json',
      cookie,
      origin: 'http://localhost',
    }
    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Synthetic FHIR metadata agent' }),
      headers: { ...mutationHeaders, 'idempotency-key': 'fhir-metadata-client-1' },
      method: 'POST',
    })
    const client = agentClientSchema.parse(await clientResponse.json())
    const mintGrant = async (operationIds: string[], key: string) => {
      const response = await runtime.app.request('/api/agent/v1/grants', {
        body: JSON.stringify({
          agentClientId: client.agentClientId,
          operationIds,
          practitionerRoleId: 'practitioner-role-outpatient-doctor',
          ttlSeconds: 3600,
        }),
        headers: { ...mutationHeaders, 'idempotency-key': key },
        method: 'POST',
      })
      return agentCapabilityGrantSchema.parse(await response.json())
    }
    const deniedGrant = await mintGrant(['patient.search'], 'fhir-metadata-denied-grant-1')
    const allowedGrant = await mintGrant(['fhir.metadata.read'], 'fhir-metadata-allowed-grant-1')

    const [missing, invalid, denied, allowed] = await Promise.all([
      runtime.app.request('/fhir/R5/metadata'),
      runtime.app.request('/fhir/R5/metadata', {
        headers: { authorization: `Bearer cma_${'0'.repeat(40)}` },
      }),
      runtime.app.request('/fhir/R5/metadata', {
        headers: { authorization: `Bearer ${deniedGrant.token}` },
      }),
      runtime.app.request('/fhir/R5/metadata', {
        headers: { authorization: `Bearer ${allowedGrant.token}` },
      }),
    ])

    expect([missing.status, invalid.status, denied.status, allowed.status]).toEqual([401, 401, 403, 200])
    expect(operationOutcomeSchema.parse(await missing.json()).issue[0]?.code).toBe('login')
    expect(operationOutcomeSchema.parse(await invalid.json()).issue[0]?.code).toBe('login')
    expect(operationOutcomeSchema.parse(await denied.json()).issue[0]?.code).toBe('forbidden')
  })

  it('lets a human administrator inspect and disable Agent credentials without returning token material', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const mutationHeaders = {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': 'agent-inspect-control-1',
      origin: 'http://localhost',
    }
    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Inspectable synthetic agent' }),
      headers: mutationHeaders,
      method: 'POST',
    })
    const client = agentClientSchema.parse(await clientResponse.json())
    const replayedClientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Inspectable synthetic agent' }),
      headers: mutationHeaders,
      method: 'POST',
    })
    expect(agentClientSchema.parse(await replayedClientResponse.json())).toEqual(client)
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
    const grant = agentCapabilityGrantSchema.parse(await grantResponse.json())

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
    const clients = agentClientListSchema.parse(await clientsResponse.json())
    const clientDetail = agentClientSchema.parse(await clientDetailResponse.json())
    const grants = agentCapabilityGrantListSchema.parse(await grantsResponse.json())
    const grantDetail = agentCapabilityGrantViewSchema.parse(await grantDetailResponse.json())
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
    expect(agentClientSchema.parse(await disabledResponse.json())).toMatchObject({
      agentClientId: client.agentClientId,
      status: 'disabled',
    })
    const denied = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=diabetes',
      { headers: { authorization: `Bearer ${grant.token}` } },
    )
    expect(denied.status).toBe(401)
    expect(await parseApiError(denied)).toMatchObject({
      error: { code: 'AGENT_TOKEN_INVALID' },
    })
    expect(new AuditQuery(runtime.database).list({
      epoch: 'epoch-1',
      workspaceId: 'workspace-demo',
    }).filter(event => event.operation.startsWith('agent-')).map(event => event.operation)).toEqual([
      'agent-client.create',
      'agent-grant.create',
      'agent-client.disable',
    ])
  })

  it('stores only the token hash and enforces its role-bound operation allowlist', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const mutationHeaders = {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': 'agent-allowlist-control-1',
      origin: 'http://localhost',
    }

    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Synthetic whole-HIS agent' }),
      headers: mutationHeaders,
      method: 'POST',
    })
    expect(clientResponse.status).toBe(200)
    const client = agentClientSchema.parse(await clientResponse.json())

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
    const grant = agentCapabilityGrantSchema.parse(await grantResponse.json())
    expect(grant.token).toMatch(/^cma_[a-f0-9]{40}$/)

    const persisted = runtime.database.driver.prepare(
      'SELECT token_hash FROM agent_capability_grant WHERE grant_id = ?',
    ).get(grant.grantId) as { token_hash: string }
    expect(persisted.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(persisted.token_hash).not.toContain(grant.token)
    const persistedReceipt = runtime.database.driver.prepare(`
      SELECT response_json FROM command_receipt
      WHERE operation = 'agent-grant.create' AND idempotency_key = ?
    `).get('agent-allowlist-control-1') as { response_json: string }
    expect(persistedReceipt.response_json).not.toContain(grant.token)
    const replayedGrant = await runtime.app.request('/api/agent/v1/grants', {
      body: JSON.stringify({
        agentClientId: client.agentClientId,
        operationIds: ['reference.diagnoses.search'],
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        ttlSeconds: 3600,
      }),
      headers: mutationHeaders,
      method: 'POST',
    })
    expect(replayedGrant.status).toBe(409)
    expect(await parseApiError(replayedGrant)).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_REUSED' },
    })

    const contextResponse = await runtime.app.request('/api/agent/v1/context', {
      headers: { authorization: `Bearer ${grant.token}` },
    })
    expect(contextResponse.status).toBe(200)
    const contextBody = JSON.stringify(agentCapabilityContextSchema.parse(await contextResponse.json()))
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
    expect(await parseApiError(denied)).toMatchObject({
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
    revokedAgentCapabilityGrantSchema.parse(await revoked.json())
    const afterRevocation = await runtime.app.request(
      '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=diabetes',
      { headers: { authorization: `Bearer ${grant.token}` } },
    )
    expect(afterRevocation.status).toBe(401)
    expect(await parseApiError(afterRevocation)).toMatchObject({
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
    expect(await parseApiError(response)).toMatchObject({
      error: { code: 'AGENT_TOKEN_INVALID' },
    })
  })

  it('does not let a token-shaped Authorization header bypass human control-plane CSRF', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const response = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'CSRF bypass attempt' }),
      headers: {
        authorization: `Bearer cma_${'0'.repeat(40)}`,
        'content-type': 'application/json',
        cookie,
        'idempotency-key': 'csrf-bypass-attempt-1',
      },
      method: 'POST',
    })

    expect(response.status).toBe(403)
    expect(await parseApiError(response)).toMatchObject({
      error: { code: 'CSRF_REJECTED' },
    })
  })

  it('rejects an otherwise unchanged token immediately after its Grant expires', async () => {
    let now = new Date('2026-08-31T00:00:00.000Z')
    const { password, runtime } = await createRuntime(() => now)
    const cookie = await signIn(runtime, password)
    const headers = {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': 'agent-expiry-control-1',
      origin: 'http://localhost',
    }
    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Expiring synthetic agent' }),
      headers,
      method: 'POST',
    })
    const client = agentClientSchema.parse(await clientResponse.json())
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
    const grant = agentCapabilityGrantSchema.parse(await grantResponse.json())
    const path = '/api/his/v1/reference-catalogs/diagnoses?page=1&pageSize=20&query=diabetes'

    expect((await runtime.app.request(path, {
      headers: { authorization: `Bearer ${grant.token}` },
    })).status).toBe(200)
    now = new Date('2026-08-31T00:01:01.000Z')
    const expired = await runtime.app.request(path, {
      headers: { authorization: `Bearer ${grant.token}` },
    })
    expect(expired.status).toBe(401)
    expect(await parseApiError(expired)).toMatchObject({
      error: { code: 'AGENT_TOKEN_INVALID' },
    })
  })

  it('ignores forged context headers and invalidates a Grant when its Epoch is reset', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const mutationHeaders = {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': 'agent-epoch-control-1',
      origin: 'http://localhost',
    }
    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Epoch-bound synthetic agent' }),
      headers: mutationHeaders,
      method: 'POST',
    })
    const client = agentClientSchema.parse(await clientResponse.json())
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
    const grant = agentCapabilityGrantSchema.parse(await grantResponse.json())
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
    expect(agentCapabilityContextSchema.parse(await contextResponse.json())).toMatchObject({
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
    expect(await parseApiError(afterReset)).toMatchObject({
      error: { code: 'AGENT_TOKEN_INVALID' },
    })
  })

  it('invalidates Grants when their Catalog hash or Workspace policy version becomes stale', async () => {
    const { password, runtime } = await createRuntime()
    const cookie = await signIn(runtime, password)
    const headers = {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': 'agent-version-client-1',
      origin: 'http://localhost',
    }
    const clientResponse = await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Version-bound synthetic agent' }),
      headers,
      method: 'POST',
    })
    const client = agentClientSchema.parse(await clientResponse.json())
    let grantSequence = 0
    const createGrant = async () => {
      grantSequence += 1
      const response = await runtime.app.request('/api/agent/v1/grants', {
        body: JSON.stringify({
          agentClientId: client.agentClientId,
          operationIds: ['reference.diagnoses.search'],
          practitionerRoleId: 'practitioner-role-outpatient-doctor',
          ttlSeconds: 3600,
        }),
        headers: { ...headers, 'idempotency-key': `agent-version-grant-${grantSequence}` },
        method: 'POST',
      })
      return agentCapabilityGrantSchema.parse(await response.json())
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
