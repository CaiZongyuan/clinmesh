import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { agentPageContextBindingSchema } from '@clinmesh/contracts/agent'
import { modelUsageControlSchema, modelUsageListSchema, type ModelUsagePolicyConfig } from '@clinmesh/contracts/model-usage'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { isDoctorDelegation } from '../../dsh-web/src/doctor-delegation.ts'
import { syntheticRecognitionLlm } from '../../dsh-web/src/doctor-input-fixture.ts'
import { installAgentProofBridge } from '../../dsh-web/src/agent-proof-bridge.ts'
import { agentPageBindingRevision } from '@clinmesh/contracts/agent'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

const secret = 'synthetic-host-accounting-secret-at-least-32-characters'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })
function latch<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
async function fixture(account = 'doctor@demo.clinmesh.local', deployment?: ModelUsagePolicyConfig) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-host-usage-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const options = { authBaseUrl: 'http://localhost', authSecret: secret, cursorSecret: secret,
    databasePath: join(directory, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'], dshBridgeSecret: secret,
    syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic',
    chatCompletionsProvider: { completeJson: async () => ({ model: 'synthetic', content: JSON.stringify(persona) }) },
    ...(deployment === undefined ? {} : { modelUsageControl: deployment }) }
  let runtime = await createClinMeshRuntime(options)
  cleanup.push(() => runtime.close())
  const started = await startConsultationCase(runtime)
  const doctor = await signIn(runtime, account)
  const headers = { cookie: doctor, origin: 'http://localhost', 'content-type': 'application/json' }
  if (account === 'admin@demo.clinmesh.local') {
    expect((await runtime.app.request('/api/auth/role', { method: 'POST', headers,
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-outpatient-doctor' }) })).status).toBe(200)
  }
  const visit = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {
      [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
    }, input: {} }),
  })
  expect(visit.status).toBe(200)
  started.encounterVersion = (await visit.json() as { data: { encounterVersion: string } }).data.encounterVersion
  const clientId = randomUUID()
  const binding = agentPageContextBindingSchema.parse(await (await runtime.app.request('/api/agent/v1/page-contexts', {
    method: 'POST', headers, body: JSON.stringify({ client: { id: clientId, revision: 1 }, dshSessionId: 'synthetic-host-session',
      claim: { taskEpoch: randomUUID(), activeSection: 'consultation', version: 1, viewId: 'consultation',
        viewRevision: 'host-usage', ui: { status: 'ready' }, selection: { kind: 'case', id: started.outpatientCaseId, version: started.encounterVersion } } }),
  })).json())
  const permit = async () => {
    const response = await runtime.app.request('/api/agent/v1/doctor-tasks/permit', { method: 'POST', headers,
      body: JSON.stringify({ contextToken: binding.token, content: '替我问清头晕的诱因。', rpcId: randomUUID() }) })
    expect(response.status).toBe(201)
    return (await response.json() as { permit: string }).permit
  }
  const post = (path: string, body: unknown, authorization = `Bearer ${secret}`) => runtime.app.request(path, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const list = async () => modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests?feature=doctor_delegation', { headers: { cookie: doctor } })).json())
  const control = async (cookie?: string) => modelUsageControlSchema.parse(await (await runtime.app.request('/api/model-usage/control', {
    headers: { cookie: cookie ?? await signIn(runtime, 'admin@demo.clinmesh.local') } })).json())
  const policy = async (input: Partial<ModelUsagePolicyConfig>) => {
    const admin = await signIn(runtime, 'admin@demo.clinmesh.local')
    const current = (await control(admin)).workspace
    const response = await runtime.app.request('/api/model-usage/control', { method: 'PUT',
      headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ enabled: current.enabled, requests: current.requests, automaticRetries: current.automaticRetries,
        expectedVersion: current.version, ...input }) })
    expect(response.status).toBe(200)
    return modelUsageControlSchema.parse(await response.json())
  }
  let revision = 1
  const renew = (claim: Record<string, unknown> = {}, cookie = doctor) => runtime.app.request('/api/agent/v1/page-contexts', { method: 'POST', headers: { ...headers, cookie },
    body: JSON.stringify({ client: { id: clientId, revision: ++revision }, dshSessionId: binding.snapshot.dshSessionId,
      claim: { ...binding.snapshot.claim, ...claim } }) })
  return { get runtime() { return runtime }, started, binding, doctor, permit, post, list, control, policy,
    renew,
    restart: async (modelUsageControl = options.modelUsageControl) => {
      await runtime.close()
      runtime = await createClinMeshRuntime(modelUsageControl === undefined ? options : { ...options, modelUsageControl })
    } }
}

it.each([
  { enabled: false, requests: null, code: 'MODEL_DISABLED', scope: 'workspace' },
  { enabled: true, requests: 0, code: 'MODEL_REQUEST_LIMIT', scope: 'workspace' },
  { enabled: false, requests: null, code: 'MODEL_DISABLED', scope: 'deployment' },
  { enabled: true, requests: 0, code: 'MODEL_REQUEST_LIMIT', scope: 'deployment' },
] as const)('returns only the safe control code and scope when Host admission is blocked: $code', async input => {
  const f = await fixture(undefined, input.scope === 'deployment'
    ? { enabled: input.enabled, requests: input.requests, automaticRetries: true } : undefined)
  if (input.scope === 'workspace') await f.policy({ enabled: input.enabled, requests: input.requests })
  const response = await f.post('/api/model-usage/host/doctor-delegation/admit', {
    permit: await f.permit(), provider: 'synthetic', model: 'classifier' })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: { code: input.code, scope: input.scope } })
  expect((await f.list()).total).toBe(0)
  expect((await f.control()).lastRejection).toMatchObject({ code: input.code, scope: input.scope })
})

it('blocks unmetered Host streams under finite dimensions and retains their boundary in unlimited mode', async () => {
  const f = await fixture()
  let streams = 0
  const ctx = { llm: syntheticRecognitionLlm(async function* () {
    streams++
    yield { type: 'text-delta', index: 0, text: '{"intent":"discuss","evidence":""}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }) } as unknown as Parameters<typeof isDoctorDelegation>[0]
  for (const dimension of ['tokens', 'cny'] as const) {
    await f.policy({ tokens: dimension === 'tokens' ? 100 : null, cny: dimension === 'cny' ? 1 : null })
    const abort = new AbortController()
    let rejection: { status: number; body: unknown } | undefined
    await expect(isDoctorDelegation(ctx, { provider: 'synthetic', model: 'classifier' }, '替我问清头晕的诱因。',
      abort.signal, { upstreamOrigin: 'http://localhost', secret, permit: await f.permit(),
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await f.runtime.app.request(new Request(input, init))
          if (new URL(String(input)).pathname.endsWith('/admit')) {
            rejection = { status: response.status, body: await response.clone().json() }
            abort.abort()
          }
          return response
        }) as typeof fetch })).rejects.toThrow()
    expect(rejection).toMatchObject({ status: 409, body: { error: { code: 'MODEL_METERING_UNAVAILABLE', scope: 'workspace', dimension } } })
    expect(streams).toBe(0)
    expect((await f.list()).total).toBe(0)
  }
  await f.policy({ tokens: null, cny: null })
  expect(await isDoctorDelegation(ctx, { provider: 'synthetic', model: 'classifier' }, '替我问清头晕的诱因。',
    new AbortController().signal, { upstreamOrigin: 'http://localhost', secret, permit: await f.permit(),
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => f.runtime.app.request(new Request(input, init))) as typeof fetch })).toBe(false)
  expect(streams).toBe(1)
  expect((await f.list()).items[0]).toMatchObject({ reservationBoundary: {
    adapter: 'dsh-host', version: 'dsh-sdk-0.2.1-rc.2-v1', inputTokens: null, outputTokens: null,
    reason: 'adapter-metering-unavailable',
  } })
})

it('shows a valid undispatched Host wait without an attempt and removes it when the caller ends', async () => {
  const f = await fixture()
  await f.policy({ enabled: false })
  const waiting = latch<void>()
  const abort = new AbortController()
  let streams = 0
  const ctx = { llm: syntheticRecognitionLlm(async function* () { streams++; yield { type: 'finish', reason: { kind: 'stop' } } }) }
  const result = isDoctorDelegation(ctx as unknown as Parameters<typeof isDoctorDelegation>[0], { provider: 'synthetic', model: 'classifier' },
    '替我问清头晕的诱因。', abort.signal, { upstreamOrigin: 'http://localhost', secret, permit: await f.permit(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await f.runtime.app.request(new Request(input, init))
        if (new URL(String(input)).pathname.endsWith('/admit')) waiting.resolve()
        return response
      }) as typeof fetch }).then(() => 'succeeded', () => 'rejected')
  await waiting.promise
  await vi.waitFor(async () => { expect((await f.control()).waiting).toBe(1) })
  expect((await f.list()).total).toBe(0)
  expect(streams).toBe(0)
  abort.abort()
  expect(await result).toBe('rejected')
  expect((await f.control()).waiting).toBe(0)
})

it.each(['lease', 'deadline', 'expired', 'membership', 'page-left', 'admitted'] as const)('excludes a Host waiter after %s invalidation without creating a retryable attempt', async invalidation => {
  const f = await fixture()
  const permit = await f.permit()
  const wait = (phase: 'waiting' | 'finished', deadlineAt = new Date(Date.now() + 30_000).toISOString()) =>
    f.post('/api/model-usage/host/doctor-delegation/wait', { permit, phase, ...(phase === 'waiting' ? { deadlineAt } : {}) })
  expect((await wait('waiting', new Date(Date.now() + (invalidation === 'deadline' ? 500 : 30_000)).toISOString())).status).toBe(200)
  expect((await f.control()).waiting).toBe(1)
  if (invalidation === 'membership') f.runtime.database.driver.exec("UPDATE workspace_membership SET status = 'suspended' WHERE actor_id = 'actor-outpatient-doctor'")
  if (invalidation === 'page-left') expect((await f.renew({ selection: undefined, ui: { status: 'empty' }, viewRevision: 'left' })).status).toBe(201)
  if (invalidation === 'admitted') {
    expect((await f.post('/api/model-usage/host/doctor-delegation/admit', { permit, provider: 'synthetic', model: 'classifier' })).status).toBe(201)
    expect(await (await wait('waiting')).json()).toEqual({ waiting: false })
  }
  if (['lease', 'deadline', 'expired'].includes(invalidation)) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + (invalidation === 'lease' ? 1001 : invalidation === 'deadline' ? 501 : 61_000))
  }
  const admin = await signIn(f.runtime, 'admin@demo.clinmesh.local')
  expect((await f.control(admin)).waiting).toBe(0)
  expect((await wait('finished')).status).toBe(200)
})

it('binds cancellation status to its receipt and cancels a stalled Host stream when its workspace is disabled', async () => {
  const f = await fixture()
  const started = latch<{ signal: AbortSignal; grant: { attemptId: string; receipt: string } }>()
  let grant: { attemptId: string; receipt: string }
  let streams = 0
  const ctx = { llm: syntheticRecognitionLlm(async function* (request) {
    streams++
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }
    const signal = request.signal!
    started.resolve({ signal, grant })
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    signal.throwIfAborted()
  }) } as unknown as Parameters<typeof isDoctorDelegation>[0]
  const result = isDoctorDelegation(ctx, { provider: 'synthetic', model: 'classifier' }, '替我问清头晕的诱因。',
    new AbortController().signal, { upstreamOrigin: 'http://localhost', secret, permit: await f.permit(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await f.runtime.app.request(new Request(input, init))
        if (new URL(String(input)).pathname.endsWith('/admit') && response.ok) grant = await response.clone().json()
        return response
      }) as typeof fetch }).then(() => 'succeeded', () => 'rejected')
  const active = await started.promise
  const status = (receipt = active.grant.receipt) => f.post('/api/model-usage/host/doctor-delegation/status', { ...active.grant, receipt })
  expect((await status('x'.repeat(43))).status).toBe(403)
  expect((await f.post('/api/model-usage/host/doctor-delegation/status', active.grant, 'Bearer synthetic-wrong-secret')).status).toBe(403)
  expect((await f.runtime.app.request('/api/model-usage/host/doctor-delegation/status', { method: 'POST',
    headers: { origin: 'http://localhost', authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(active.grant) })).status).toBe(403)
  expect(await (await status()).json()).toEqual({ abort: false })
  await f.policy({ enabled: false })
  expect(await (await status()).json()).toEqual({ abort: true })
  expect(await result).toBe('rejected')
  expect(active.signal.aborted).toBe(true)
  expect(streams).toBe(1)
  expect((await f.list()).items[0]).toMatchObject({ status: 'unknown', dispatch: 'dispatched', usage: {
    raw: { format: 'dsh', uncachedInputTokens: 12, outputTokens: 3 }, totalTokens: null } })
  await f.policy({ enabled: true })
  expect(await (await status()).json()).toEqual({ abort: true })
})

it('admits one Host recognition per trusted doctor task and keeps unknown dispatch across restart', async () => {
  const f = await fixture()
  const permit = await f.permit()
  const body = { permit, provider: 'synthetic-host', model: 'classifier-v1' }
  const response = await f.post('/api/model-usage/host/doctor-delegation/admit', body)
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ attemptId: expect.any(String), receipt: expect.any(String) })
  expect((await f.post('/api/model-usage/host/doctor-delegation/admit', body)).status).toBe(409)
  const records = await f.list()
  expect(records.total).toBe(1)
  expect(records.items[0]).toMatchObject({ feature: 'doctor_delegation', requestedModel: 'classifier-v1',
    context: { workspaceId: 'workspace-demo', epoch: 'epoch-1', actorId: 'actor-outpatient-doctor',
      practitionerRoleId: 'practitioner-role-outpatient-doctor', caseId: f.started.outpatientCaseId,
      stage: 'doctor_delegation', trigger: 'automatic' }, dispatch: 'unknown', status: 'in-flight' })
  await f.restart()
  expect((await f.list()).items[0]).toMatchObject({ status: 'unknown', usage: { totalTokens: null } })
  expect((await f.post('/api/model-usage/host/doctor-delegation/admit', body)).status).toBe(409)
})

it('atomically grants the last Host request slot once and keeps its unknown occupancy and identity across restart', async () => {
  const f = await fixture()
  await f.policy({ requests: 1 })
  const bodies = await Promise.all([f.permit(), f.permit()].map(async permit => ({ permit: await permit, provider: 'synthetic', model: 'classifier' })))
  const responses = await Promise.all(bodies.map(body => f.post('/api/model-usage/host/doctor-delegation/admit', body)))
  expect(responses.map(response => response.status).sort()).toEqual([201, 409])
  const winner = responses.findIndex(response => response.status === 201)
  const grant = await responses[winner]!.json() as { attemptId: string; receipt: string }
  expect(await responses[1 - winner]!.json()).toEqual({ error: { code: 'MODEL_REQUEST_LIMIT', scope: 'workspace' } })
  expect((await f.control()).workspace).toMatchObject({ used: 0, reserved: 1, remaining: 0 })
  await f.restart()
  expect((await f.list()).items).toMatchObject([{ id: grant.attemptId, status: 'unknown', dispatch: 'unknown' }])
  expect((await f.control()).workspace).toMatchObject({ used: 0, reserved: 1, remaining: 0 })
  expect((await f.post('/api/model-usage/host/doctor-delegation/admit', bodies[winner])).status).toBe(409)
  expect((await f.post('/api/model-usage/host/doctor-delegation/admit', bodies[1 - winner])).status).toBe(409)
  await f.policy({ requests: 2 })
  expect((await f.post('/api/model-usage/host/doctor-delegation/admit', bodies[winner])).status).toBe(409)
  expect((await f.post('/api/model-usage/host/doctor-delegation/admit', bodies[1 - winner])).status).toBe(201)
  expect((await f.control()).workspace).toMatchObject({ used: 0, reserved: 2, remaining: 0 })
})

it('keeps independent Host quota starting points through unlimited periods and deployment restarts without allowing a workspace to loosen deployment policy', async () => {
  const f = await fixture()
  const dispatch = async () => {
    const response = await f.post('/api/model-usage/host/doctor-delegation/admit', {
      permit: await f.permit(), provider: 'synthetic', model: 'classifier' })
    expect(response.status).toBe(201)
    const grant = await response.json() as { attemptId: string; receipt: string }
    const observation = { ...grant, outcome: { status: 'succeeded', dispatch: 'dispatched', usage: {
      inputTokens: 3, outputTokens: 2, cachedInputTokens: null, reasoningOutputTokens: null,
      totalTokens: 5, mapping: 'dsh-v1' } } }
    expect((await f.post('/api/model-usage/host/doctor-delegation/observe', observation)).status).toBe(200)
    expect((await f.post('/api/model-usage/host/doctor-delegation/observe', observation)).status).toBe(200)
  }
  await dispatch()
  const workspaceStart = (await f.policy({ requests: 4 })).workspace.requestsStartedAt
  await dispatch()
  expect((await f.control()).workspace).toMatchObject({ used: 1, reserved: 0 })
  expect((await f.control()).deployment?.requestsStartedAt).toBeNull()
  await f.restart({ enabled: true, requests: 2, automaticRetries: true })
  const deploymentStart = (await f.control()).deployment?.requestsStartedAt
  expect(deploymentStart).not.toBe(workspaceStart)
  await dispatch()
  await f.policy({ requests: null })
  await dispatch()
  expect(await f.control()).toMatchObject({ workspace: { used: 3, requestsStartedAt: workspaceStart },
    deployment: { used: 2, requestsStartedAt: deploymentStart } })
  const rejected = await f.post('/api/model-usage/host/doctor-delegation/admit', {
    permit: await f.permit(), provider: 'synthetic', model: 'classifier' })
  expect(rejected.status).toBe(409)
  expect(await rejected.json()).toEqual({ error: { code: 'MODEL_REQUEST_LIMIT', scope: 'deployment' } })
  await f.restart({ enabled: true, requests: null, automaticRetries: true })
  await f.policy({ requests: 4 })
  await dispatch()
  expect(await f.control()).toMatchObject({ workspace: { used: 4, requestsStartedAt: workspaceStart, remaining: 0 },
    deployment: { used: 3, requestsStartedAt: deploymentStart, requests: null } })
  expect((await f.list()).total).toBe(5)
  const beforeReset = await f.control()
  const admin = await signIn(f.runtime, 'admin@demo.clinmesh.local')
  expect((await f.runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', { method: 'POST',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: '{}' })).status).toBe(200)
  expect(await f.control(admin)).toMatchObject({ workspace: beforeReset.workspace, deployment: beforeReset.deployment })
})

it.each(['auth', 'origin', 'membership', 'role', 'actor', 'epoch', 'case', 'ledger', 'expired', 'spoofed-context'] as const)(
  'dispatches zero classifier streams when %s invalidates admission', async failure => {
    const f = await fixture()
    let permit = await f.permit()
    if (failure === 'expired') {
      const payload = JSON.parse(Buffer.from(permit.split('.')[0]!, 'base64url').toString())
      const encoded = Buffer.from(JSON.stringify({ ...payload, expiresAt: '2020-01-01T00:00:00.000Z' })).toString('base64url')
      permit = `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`
    }
    if (failure === 'membership') f.runtime.database.driver.exec("UPDATE workspace_membership SET status = 'suspended' WHERE actor_id = 'actor-outpatient-doctor'")
    if (failure === 'role') f.runtime.database.driver.exec("UPDATE practitioner_role_binding SET active = 0 WHERE practitioner_role_id = 'practitioner-role-outpatient-doctor'")
    if (failure === 'actor') f.runtime.database.driver.exec("UPDATE workspace_actor SET status = 'disabled' WHERE actor_id = 'actor-outpatient-doctor'")
    if (failure === 'epoch') f.runtime.database.driver.exec("UPDATE workspace_epoch SET state = 'closed' WHERE epoch = 'epoch-1'")
    if (failure === 'case') f.runtime.database.driver.prepare("UPDATE outpatient_case_responsibility SET practitioner_role_id = 'practitioner-role-administrator' WHERE case_id = ?").run(f.started.outpatientCaseId)
    if (failure === 'ledger') f.runtime.database.driver.exec("CREATE TRIGGER synthetic_admission_failure BEFORE INSERT ON model_usage_attempt BEGIN SELECT RAISE(ABORT, 'unwritable'); END")
    let streams = 0
    const abort = new AbortController()
    const ctx = { llm: syntheticRecognitionLlm(async function* () { streams++; yield { type: 'finish', reason: { kind: 'stop' } } }) } as unknown as Parameters<typeof isDoctorDelegation>[0]
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (failure === 'auth') request.headers.delete('authorization')
      if (failure === 'origin') request.headers.set('origin', 'http://localhost')
      if (failure === 'spoofed-context') return f.runtime.app.request(new Request(input, { ...init,
        body: JSON.stringify({ ...JSON.parse(String(init?.body)), workspaceId: 'workspace-other' }) }))
      const response = await f.runtime.app.request(request)
      if (failure === 'ledger') abort.abort()
      return response
    }) as typeof fetch
    await expect(isDoctorDelegation(ctx, { provider: 'synthetic', model: 'classifier' }, '替我问清头晕的诱因。',
      abort.signal, { upstreamOrigin: 'http://localhost', secret, permit, fetch: transport })).rejects.toThrow()
    expect(streams).toBe(0)
  })

it('keeps the task through same-case context renewal but rejects leaving and returning', async () => {
  const f = await fixture()
  const permit = await f.permit()
  expect((await f.renew({ viewRevision: 'renewed-record', activeSection: 'record' })).status).toBe(201)
  expect((await f.post('/api/model-usage/host/doctor-delegation/admit', { permit, provider: 'synthetic', model: 'classifier' })).status).toBe(201)
  const g = await fixture()
  const stale = await g.permit()
  expect((await g.renew({ selection: undefined, ui: { status: 'empty' }, viewRevision: 'left' })).status).toBe(201)
  expect((await g.renew({ viewRevision: 'returned' })).status).toBe(201)
  expect((await g.post('/api/model-usage/host/doctor-delegation/admit', { permit: stale, provider: 'synthetic', model: 'classifier' })).status).toBe(403)
})

it.each(['identity', 'role'] as const)('rejects an old input permit after the same client changes %s', async change => {
  const f = await fixture(change === 'role' ? 'admin@demo.clinmesh.local' : undefined)
  const permit = await f.permit()
  const cookie = change === 'role' ? f.doctor : await signIn(f.runtime, 'admin@demo.clinmesh.local')
  if (change === 'role') {
    expect((await f.runtime.app.request('/api/auth/role', { method: 'POST',
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-administrator' }) })).status).toBe(200)
  }
  expect((await f.renew({ viewId: 'scenarioData', activeSection: undefined, selection: undefined }, cookie)).status).toBe(201)
  expect((await f.post('/api/model-usage/host/doctor-delegation/admit', { permit, provider: 'synthetic', model: 'classifier' })).status).toBe(401)
  expect((await f.list()).total).toBe(0)
})

it('converges a completely lost Host to unknown without restart, progress renewal or a second stream permit', async () => {
  const f = await fixture()
  const permit = await f.permit()
  const admitted = await f.post('/api/model-usage/host/doctor-delegation/admit', { permit, provider: 'synthetic', model: 'classifier' })
  const grant = await admitted.json() as { attemptId: string; receipt: string }
  const outcome = { status: 'unknown', dispatch: 'dispatched', usage: {
    inputTokens: 12, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null,
    totalTokens: null, mapping: 'dsh-v1', raw: { format: 'dsh', uncachedInputTokens: 12,
      outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: null } } }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 20_000)
  expect((await f.post('/api/model-usage/host/doctor-delegation/observe', { ...grant, phase: 'progress', outcome })).status).toBe(200)
  expect((await f.list()).items[0]).toMatchObject({ status: 'in-flight', endedAt: null })
  // The Host disappears here: no finally or terminal observation reaches the Server.
  vi.setSystemTime(Date.now() + 15_000)
  expect((await f.list()).items[0]).toMatchObject({ status: 'unknown', endedAt: expect.any(String), usage: outcome.usage })
  expect((await f.post('/api/model-usage/host/doctor-delegation/observe', { ...grant, phase: 'progress', outcome })).status).toBe(200)
  expect((await f.list()).items[0]).toMatchObject({ status: 'unknown', dispatch: 'dispatched', usage: outcome.usage })
  expect((await f.post('/api/model-usage/host/doctor-delegation/admit', { permit, provider: 'synthetic', model: 'classifier' })).status).toBe(409)
  expect((await f.post('/api/model-usage/host/doctor-delegation/observe', { ...grant, outcome: { ...outcome, status: 'succeeded' } })).status).toBe(200)
  expect((await f.list()).items[0]).toMatchObject({ status: 'succeeded', usage: outcome.usage })
})

it.each(['cancel', 'disconnect', 'terminal-write'] as const)('retains known raw usage without resending after %s', async failure => {
  const f = await fixture()
  const abort = new AbortController()
  let streams = 0
  const ctx = { llm: syntheticRecognitionLlm(async function* () {
    streams++
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }
    if (failure === 'cancel') abort.abort()
    if (failure !== 'terminal-write') throw new Error('synthetic lost Host stream')
    yield { type: 'text-delta', index: 0, text: '{"intent":"discuss","evidence":""}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }) } as unknown as Parameters<typeof isDoctorDelegation>[0]
  if (failure === 'terminal-write') f.runtime.database.driver.exec(`CREATE TRIGGER synthetic_terminal_failure BEFORE UPDATE ON model_usage_attempt
    WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'unwritable'); END`)
  const control = { upstreamOrigin: 'http://localhost', secret, permit: await f.permit(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => f.runtime.app.request(new Request(input, init))) as typeof fetch }
  const run = () => isDoctorDelegation(ctx, { provider: 'synthetic', model: 'classifier' }, '替我问清头晕的诱因。', abort.signal, control)
  await expect(run()).rejects.toThrow()
  expect((await f.list()).items[0]).toMatchObject({ status: 'unknown', dispatch: 'dispatched',
    usage: { totalTokens: null, raw: { format: 'dsh', uncachedInputTokens: 12, outputTokens: 3 } } })
  await f.restart()
  await expect(run()).rejects.toThrow()
  expect(streams).toBe(1)
  expect((await f.list()).total).toBe(1)
})

it('settles only the admitted Host attempt, retaining raw usage after a failed terminal write and duplicate reports', async () => {
  const f = await fixture()
  const response = await f.post('/api/model-usage/host/doctor-delegation/admit', {
    permit: await f.permit(), provider: 'synthetic-host', model: 'classifier-v1' })
  const grant = await response.json() as { attemptId: string; receipt: string }
  const usage = { inputTokens: 125, outputTokens: 30, cachedInputTokens: 25, reasoningOutputTokens: 10,
    totalTokens: 155, mapping: 'dsh-v1', raw: { format: 'dsh', uncachedInputTokens: 100,
      outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 10, totalTokens: 155 } }
  const report = (outcome: unknown, receipt = grant.receipt) => f.post('/api/model-usage/host/doctor-delegation/observe', { ...grant, receipt, outcome })
  expect((await report({ status: 'unknown', dispatch: 'dispatched', actualModel: 'classifier-actual', usage })).status).toBe(200)
  expect((await report({ status: 'succeeded', usage }, 'x'.repeat(43))).status).toBe(403)
  f.runtime.database.driver.exec(`CREATE TRIGGER synthetic_terminal_failure BEFORE UPDATE ON model_usage_attempt
    WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'synthetic settlement unavailable'); END`)
  expect((await report({ status: 'succeeded', dispatch: 'dispatched', usage })).status).toBe(503)
  expect((await f.list()).items[0]).toMatchObject({ id: grant.attemptId, status: 'unknown', actualModel: 'classifier-actual', usage })
  await f.restart()
  f.runtime.database.driver.exec('DROP TRIGGER synthetic_terminal_failure')
  expect((await report({ status: 'succeeded', dispatch: 'dispatched', usage })).status).toBe(200)
  expect((await report({ status: 'succeeded', dispatch: 'dispatched', usage })).status).toBe(200)
  const records = await f.list()
  expect(records.total).toBe(1)
  expect(records.items[0]).toMatchObject({ id: grant.attemptId, status: 'succeeded', usage })
})

it('requires Server admission before the real Host classifier stream and records its actual route and original usage', async () => {
  const f = await fixture()
  let streams = 0
  const ctx = { llm: syntheticRecognitionLlm(async function* () {
    streams++
    yield { type: 'text-delta', index: 0, text: '{"intent":"delegate","evidence":"替我问清头晕的诱因。"}' }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 10, totalTokens: 155 } }
    expect((await f.list()).items[0]).toMatchObject({ status: 'in-flight', usage: { totalTokens: 155 } })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }) } as unknown as Parameters<typeof isDoctorDelegation>[0]
  const control = { upstreamOrigin: 'http://localhost', secret, permit: await f.permit(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => f.runtime.app.request(new Request(input, init))) as typeof fetch }
  const run = () => isDoctorDelegation(ctx, { provider: 'synthetic-host', model: 'classifier-actual' },
    '替我问清头晕的诱因。', new AbortController().signal, control)
  expect(await run()).toBe(true)
  expect(streams).toBe(1)
  expect((await f.list()).items[0]).toMatchObject({ provider: 'synthetic-host', actualModel: 'classifier-actual',
    status: 'succeeded', dispatch: 'dispatched', outputLimit: 1024, usage: { totalTokens: 155,
      raw: { format: 'dsh', uncachedInputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5 } } })
  await expect(run()).rejects.toThrow()
  expect(streams).toBe(1)
})

it.each(['none', 'enabled', 'requests', 'ledger', 'expired', 'membership', 'task-ended'] as const)('connects the installed Host task handler and resumes valid undispatched work after %s recovery', async recovery => {
  const f = await fixture()
  const invalidated = recovery === 'expired' || recovery === 'membership' || recovery === 'task-ended'
  if (recovery === 'enabled' || invalidated) await f.policy({ enabled: false })
  if (recovery === 'requests') await f.policy({ requests: 0 })
  if (recovery === 'ledger') f.runtime.database.driver.exec("CREATE TRIGGER synthetic_admission_failure BEFORE INSERT ON model_usage_attempt BEGIN SELECT RAISE(ABORT, 'unwritable'); END")
  const blocked = latch<void>()
  const permit = await f.permit()
  const payload = JSON.parse(Buffer.from(permit.split('.')[0]!, 'base64url').toString())
  const binding = { scopeKey: f.binding.snapshot.scopeKey, pageRevision: agentPageBindingRevision(f.binding.snapshot.claim) }
  const parameters = { type: 'object', properties: { scopeKey: { type: 'string', const: binding.scopeKey },
    pageRevision: { type: 'string', const: binding.pageRevision } }, required: ['scopeKey', 'pageRevision'], additionalProperties: false }
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => Promise<void>>()
  const disposers: Array<() => void> = []
  cleanup.push(async () => { for (const dispose of disposers.reverse()) dispose() })
  let streams = 0
  installAgentProofBridge({
    on: (name: string, listener: (...args: unknown[]) => unknown) => listeners.set(name, listener),
    effect: (effect: () => (() => void)) => disposers.push(effect()),
    tools: { get: () => ({ parameters }) },
    webServer: { register: (route: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) => {
      routes.set(route.path, route.handler); return () => routes.delete(route.path)
    } },
    llm: syntheticRecognitionLlm(async function* () {
      streams++
      yield { type: 'text-delta', index: 0, text: '{"intent":"delegate","evidence":"替我问清头晕的诱因。"}' }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }),
  } as unknown as Parameters<typeof installAgentProofBridge>[0], secret, { upstreamOrigin: 'http://localhost',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await f.runtime.app.request(new Request(input, init))
      if (new URL(String(input)).pathname.endsWith('/admit') && response.status === 409) blocked.resolve()
      return response
    }) as typeof fetch })
  const agent = { session: { id: payload.dshSessionId, header: {}, requestHeader: () => ({
    config: { provider: 'synthetic-host', model: 'handler-classifier' },
    tools: [{ name: 'clinmesh_select_doctor_section', parameters }, { name: 'clinmesh_ask_virtual_patient', parameters }],
  }) } }
  const emit = (name: string, ...args: unknown[]) => listeners.get(name)!(...args)
  const message = { id: 'synthetic-input', source: { kind: 'user', rpcId: payload.rpcId },
    content: [{ type: 'text', text: '替我问清头晕的诱因。' }] }
  emit('agent/inbox/inserted', { agent, message })
  emit('agent/inbox/claimed', { agent, message, turn: 1 })
  let status = 200
  const request = Object.assign(Readable.from([JSON.stringify({ permit })]), { method: 'POST',
    headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } })
  const response = { get statusCode() { return status }, set statusCode(value: number) { status = value }, setHeader() {}, end() {} }
  await routes.get('/clinmesh-doctor-task')!(request as unknown as IncomingMessage, response as unknown as ServerResponse)
  expect(status).toBe(200)
  emit('session/event', agent.session, { type: 'step/start', data: { turn: 1, step: 1 } })
  emit('session/event', agent.session, { type: 'tool/call', data: { turn: 1, step: 1,
    name: 'clinmesh_ask_virtual_patient', callId: 'synthetic-call', arguments: JSON.stringify(binding) } })
  const pending = emit('tools/pre-execute', { agent, name: 'clinmesh_ask_virtual_patient', callId: 'synthetic-call',
    arguments: binding, signal: new AbortController().signal }, async () => ({ kind: 'allow' }))
  if (recovery !== 'none') {
    await blocked.promise
    expect(streams).toBe(0)
    if (recovery === 'expired') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 61_000) }
    if (recovery === 'membership') f.runtime.database.driver.exec("UPDATE workspace_membership SET status = 'suspended' WHERE actor_id = 'actor-outpatient-doctor'")
    if (recovery === 'task-ended') emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1 } })
    if (recovery === 'enabled' || invalidated) await f.policy({ enabled: true })
    if (recovery === 'requests') await f.policy({ requests: 1 })
    if (recovery === 'ledger') f.runtime.database.driver.exec('DROP TRIGGER synthetic_admission_failure')
  }
  const result = await pending
  if (invalidated) {
    expect(result).toMatchObject({ kind: 'deny' })
    expect(streams).toBe(0)
    return
  }
  expect(result).toEqual({ kind: 'allow' })
  expect(streams).toBe(1)
  expect((await f.list()).items[0]).toMatchObject({ feature: 'doctor_delegation', status: 'succeeded', usage: { totalTokens: 7 } })
})
