import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentPageContextBindingSchema,
  agentToolAuthorizationResponseSchema,
  agentToolCompletionResponseSchema,
  type AgentPageContextClaim,
} from '@clinmesh/contracts/agent'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'

describe('DSH Agent Page Context HTTP contract', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const directories: string[] = []

  async function setup(
    email = 'registrar@demo.clinmesh.local',
    now?: () => Date,
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-agent-context-'))
    directories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      dshBridgeSecret: 'test-dsh-bridge-secret-with-at-least-32-characters',
      migrationMode: 'apply',
      ...(now === undefined ? {} : { now }),
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const signIn = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email, password }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    expect(signIn.status).toBe(200)
    return {
      cookie: signIn.headers.get('set-cookie')?.split(';', 1)[0] ?? '',
      password,
      runtime,
    }
  }

  async function createContext(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    cookie: string,
    claim: AgentPageContextClaim | Record<string, unknown>,
  ) {
    return runtime.app.request('/api/agent/v1/page-contexts', {
      body: JSON.stringify(claim),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
  }

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('signs a role-scoped snapshot from server-owned session context', async () => {
    const { cookie, runtime } = await setup()
    const response = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-view-1',
      ui: { status: 'ready', search: '张' },
    })

    expect(response.status).toBe(201)
    const binding = agentPageContextBindingSchema.parse(await response.json())
    expect(binding.snapshot).toMatchObject({
      actor: {
        actorId: 'actor-registrar',
        practitionerRoleId: 'practitioner-role-registrar',
        roleCode: 'registrar',
      },
      claim: { viewId: 'registration' },
      workspace: {
        epoch: 'epoch-1',
        id: 'workspace-demo',
        scenarioRunId: 'scenario-run-1',
      },
    })
    expect(binding.snapshot.allowedOperationIds).toContain('registration.patient.search')
    expect(binding.snapshot.allowedOperationIds).not.toContain('outpatient.case.read')
  })

  it('rejects a role/view mismatch and arbitrary hidden state', async () => {
    const { cookie, runtime } = await setup()
    const mismatch = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'consultation',
      viewRevision: 'forged',
      ui: { status: 'ready' },
    })
    expect(mismatch.status).toBe(403)
    expect(await mismatch.json()).toMatchObject({ error: { code: 'AGENT_VIEW_NOT_ALLOWED' } })

    const hidden = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'forged',
      ui: { status: 'ready' },
      hiddenFacts: [{ diagnosis: 'secret' }],
    })
    expect(hidden.status).toBe(400)
    expect(await hidden.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })

  it('exposes no Scenario authoring operations to an administrator context', async () => {
    const { cookie, runtime } = await setup('admin@demo.clinmesh.local')
    const response = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'scenarioData',
      viewRevision: 'scenario-data-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await response.json())
    expect(binding.snapshot.allowedOperationIds).toEqual([
      'ui.context.read',
      'ui.navigate',
      'ui.panel.focus',
    ])
  })

  it('authorizes and completes one exact DSH Tool call while rejecting replay', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-view-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const proof = executionProof({
      callId: 'call-1',
      dshSessionId: 'dsh-session-1',
      scopeKey: binding.snapshot.scopeKey,
      toolName: 'clinmesh_search_patients',
    })
    const authorize = () => runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: proof,
        input: { query: '张', scopeKey: binding.snapshot.scopeKey },
        operationId: 'registration.patient.search',
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })

    const response = await authorize()
    expect(response.status).toBe(201)
    const authorized = agentToolAuthorizationResponseSchema.parse(await response.json())
    expect(authorized).toMatchObject({
      callId: 'call-1',
      dshSessionId: 'dsh-session-1',
      operationId: 'registration.patient.search',
      status: 'authorized',
    })
    const replay = await authorize()
    expect(replay.status).toBe(409)
    expect(await replay.json()).toMatchObject({ error: { code: 'AGENT_CALL_REPLAYED' } })

    const replacement = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-view-2',
      ui: { status: 'empty' },
    })
    expect(replacement.status).toBe(201)

    const complete = () => runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        ok: true,
        receiptToken: authorized.receiptToken,
        result: { count: 1 },
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect((await complete()).status).toBe(200)
    const duplicateResult = await complete()
    expect(duplicateResult.status).toBe(409)
    expect(await duplicateResult.json()).toMatchObject({ error: { code: 'AGENT_CALL_NOT_PENDING' } })
  })

  it('rejects a tampered proof and a Tool/operation mismatch', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-view-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const proof = executionProof({
      callId: 'call-2',
      dshSessionId: 'dsh-session-1',
      scopeKey: binding.snapshot.scopeKey,
      toolName: 'clinmesh_search_patients',
    })
    const request = (executionProof: string, operationId: string) => runtime.app.request(
      '/api/agent/v1/tool-calls',
      {
        body: JSON.stringify({ contextToken: binding.token, executionProof, input: {}, operationId }),
        headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
        method: 'POST',
      },
    )

    const tampered = await request(`${proof}x`, 'registration.patient.search')
    expect(tampered.status).toBe(401)
    expect(await tampered.json()).toMatchObject({ error: { code: 'AGENT_PROOF_INVALID' } })
    const mismatch = await request(proof, 'registration.patient.create.propose')
    expect(mismatch.status).toBe(403)
    expect(await mismatch.json()).toMatchObject({ error: { code: 'AGENT_OPERATION_NOT_ALLOWED' } })
  })

  it('rejects an expired Page Context before authorizing a Tool call', async () => {
    let now = new Date('2026-08-31T00:00:00.000Z')
    const { cookie, runtime } = await setup('registrar@demo.clinmesh.local', () => now)
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-expiry-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    now = new Date('2026-08-31T00:05:00.000Z')

    const response = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-expired-1',
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_read_current_context',
        }),
        input: {},
        operationId: 'ui.context.read',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'AGENT_CONTEXT_EXPIRED' } })
  })

  it('rejects a Page Context from the previous Epoch after Scenario reset', async () => {
    const { cookie, password, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-epoch-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const adminSignIn = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email: 'admin@demo.clinmesh.local', password }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    const adminCookie = adminSignIn.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    const reset = await runtime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      {
        body: '{}',
        headers: {
          'content-type': 'application/json',
          cookie: adminCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(reset.status).toBe(200)

    const response = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-old-epoch-1',
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_read_current_context',
        }),
        input: {},
        operationId: 'ui.context.read',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'AGENT_CONTEXT_INVALID' } })
  })

  it('marks a cancelled proposal stale without recording a human review decision', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-cancelled-review-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const authorize = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-cancelled-proposal-1',
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_prepare_create_patient',
        }),
        input: {},
        operationId: 'registration.patient.create.propose',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    const authorized = agentToolAuthorizationResponseSchema.parse(await authorize.json())
    const completed = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        error: 'The Surface Agent page scope changed',
        ok: false,
        receiptToken: authorized.receiptToken,
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })

    expect(completed.status).toBe(200)
    expect(agentToolCompletionResponseSchema.parse(await completed.json())).toEqual({
      status: 'failed',
    })
    expect(runtime.database.driver.prepare(
      'SELECT status FROM agent_proposal WHERE proposal_id = ?',
    ).get(authorized.proposalId)).toEqual({ status: 'stale' })
    expect(runtime.database.driver.prepare(
      'SELECT COUNT(*) AS count FROM agent_review_decision WHERE proposal_id = ?',
    ).get(authorized.proposalId)).toEqual({ count: 0 })
  })

  it('links a human-approved proposal to its Command, Audit Event, and Action Trace', async () => {
    const { cookie, runtime } = await setup()
    const contextResponse = await createContext(runtime, cookie, {
      version: 1,
      viewId: 'registration',
      viewRevision: 'registration-review-1',
      ui: { status: 'ready' },
    })
    const binding = agentPageContextBindingSchema.parse(await contextResponse.json())
    const authorize = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: executionProof({
          callId: 'call-proposal-1',
          dshSessionId: 'dsh-session-1',
          scopeKey: binding.snapshot.scopeKey,
          toolName: 'clinmesh_prepare_create_patient',
        }),
        input: {},
        operationId: 'registration.patient.create.propose',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    const authorized = agentToolAuthorizationResponseSchema.parse(await authorize.json())
    expect(authorized.proposalId).toBeDefined()

    const commandResponse = await runtime.app.request('/api/his/v1/patients', {
      body: JSON.stringify({
        expectedVersions: {},
        input: {
          birthDate: '1990-01-01',
          gender: 'male',
          identifier: 'CM-AGENT-REVIEW-001',
          name: '合成患者复核',
        },
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(commandResponse.status).toBe(200)
    const command = await commandResponse.json() as {
      auditId: string
      requestId: string
    }

    const completedResponse = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({
        ok: true,
        receiptToken: authorized.receiptToken,
        result: { approved: true, data: command },
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(completedResponse.status).toBe(200)
    expect(agentToolCompletionResponseSchema.parse(await completedResponse.json())).toEqual({
      auditId: command.auditId,
      proposalStatus: 'approved',
      requestId: command.requestId,
      status: 'completed',
      traceId: expect.any(String),
    })
  })
})

function executionProof(input: {
  callId: string
  dshSessionId: string
  scopeKey: string
  toolName: string
}): string {
  const now = new Date()
  const payload = {
    ...input,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    issuedAt: now.toISOString(),
    version: 1,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac(
    'sha256',
    'test-dsh-bridge-secret-with-at-least-32-characters',
  ).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}
