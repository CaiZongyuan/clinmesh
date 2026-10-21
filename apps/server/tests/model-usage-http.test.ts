import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { modelUsageListSchema, modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { createModelBridgeHandler } from '../../dsh-web/src/model-bridge.ts'
import { encodeModelRoute } from '@clinmesh/contracts/model-bridge'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close() })

async function setup(extra: Partial<Parameters<typeof createClinMeshRuntime>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-model-usage-'))
  dispose.push(() => rm(directory, { recursive: true, force: true }))
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    databasePath: join(directory, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'],
    ...extra,
  }
  let runtime = await createClinMeshRuntime(options)
  dispose.push(() => runtime.close())
  return { get runtime() { return runtime }, restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

type HostContext = Parameters<typeof createModelBridgeHandler>[0]
type StreamChunk = ReturnType<HostContext['llm']['stream']> extends AsyncIterable<infer Chunk> ? Chunk : never
const bridgeSecret = 'synthetic-model-bridge-secret-at-least-32-characters'
const bridgeRoute = { provider: 'synthetic-provider', model: 'synthetic-actual' }
async function host(stream: HostContext['llm']['stream'], catalogAvailable = true) {
  const bridge = createModelBridgeHandler({
    llm: { listModels: async () => catalogAvailable ? [{ id: bridgeRoute.model }] : [], stream },
    agentDefaultModel: { currentSelection: () => bridgeRoute },
  } as unknown as HostContext, bridgeSecret, () => 'default')
  const server = createServer(bridge.handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Synthetic Host unavailable')
  dispose.push(async () => {
    bridge.dispose(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { origin: `http://127.0.0.1:${address.port}`, secret: bridgeSecret, timeoutMs: 2000, maxResponseBytes: 65536 }
}

it('opens an empty unlimited overview for members and requires authentication', async () => {
  const { runtime } = await setup()
  const anonymous = await runtime.app.request('/api/model-usage/overview')
  expect(anonymous.status).toBe(401)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const response = await runtime.app.request('/api/model-usage/overview', { headers: { cookie } })
  expect(response.status).toBe(200)
  expect(modelUsageOverviewSchema.parse(await response.json())).toMatchObject({
    coverage: 'server-direct-bridge-and-host', totals: { requests: 0, knownTokens: 0, cny: null },
    policy: { enabled: true, requests: null, tokens: null, cny: null },
  })
})

it('meters actual direct requests, keeps actual model across restart and restricts administrative details', async () => {
  let dispatched = 0
  const fixture = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'configured-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-private-key', baseUrl: 'http://[::1]:11434/v1',
      fetch: async () => { dispatched++; return Response.json({ id: 'synthetic-request-1', model: 'actual-model-v1',
        choices: [{ message: { content: JSON.stringify(persona) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 5 } },
      }) },
    }),
  })
  await startConsultationCase(fixture.runtime)
  const admin = await signIn(fixture.runtime, 'admin@demo.clinmesh.local')
  const doctor = await signIn(fixture.runtime, 'doctor@demo.clinmesh.local')
  const read = async (path: string, cookie = admin) => fixture.runtime.app.request(path, { headers: { cookie } })
  const overview = modelUsageOverviewSchema.parse(await (await read('/api/model-usage/overview', doctor)).json())
  expect(overview.totals).toMatchObject({ requests: 1, knownTokens: 120, unknownTokenRequests: 0, unpricedRequests: 1, cny: null })
  expect(dispatched).toBe(1)
  const records = modelUsageListSchema.parse(await (await read('/api/model-usage/requests')).json())
  expect(records.total).toBe(1)
  expect(records.items[0]).toMatchObject({ provider: '[::1]', actualModel: 'actual-model-v1', requestedModel: 'configured-model',
    feature: 'patient_persona', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, reasoningOutputTokens: 5, totalTokens: 120 },
    cost: { cny: null, status: 'price-not-configured' } })
  const id = records.items[0]!.id
  expect(modelUsageListSchema.parse(await (await read('/api/model-usage/requests', doctor)).json())).toEqual({ items: [], total: 0 })
  expect((await read(`/api/model-usage/requests/${id}`, doctor)).status).toBe(404)
  expect(JSON.stringify(records)).not.toContain('synthetic-private-key')
  expect(JSON.stringify(records)).not.toContain(persona.chiefComplaint)
  expect((await read('/api/model-usage/requests?limit=100000')).status).toBe(400)
  expect(modelUsageListSchema.parse(await (await read('/api/model-usage/requests?model=other-model')).json()).total).toBe(0)
  await fixture.restart()
  const recovered = modelUsageListSchema.parse(await (await read('/api/model-usage/requests')).json())
  expect(recovered.items[0]).toEqual(records.items[0])
  expect(dispatched).toBe(1)
  // Real timestamps remain UTC in storage; date filters and trend use Asia/Shanghai.
  const midnightRecord = { ...recovered.items[0]!, startedAt: '2026-10-20T16:30:00.000Z' }
  fixture.runtime.database.driver.prepare('UPDATE model_usage_attempt SET started_at = ?, record_json = ? WHERE attempt_id = ?')
    .run(midnightRecord.startedAt, JSON.stringify(midnightRecord), id)
  const localDay = modelUsageOverviewSchema.parse(await (await read('/api/model-usage/overview?from=2026-10-21&to=2026-10-21')).json())
  expect(localDay.totals.requests).toBe(1)
  expect(localDay.trend).toEqual([{ date: '2026-10-21', requests: 1, knownTokens: 120 }])
  expect(modelUsageListSchema.parse(await (await read('/api/model-usage/requests?from=2026-10-20&to=2026-10-20')).json()).total).toBe(0)
})

it('requires durable accounting before dispatch even when every limit is unlimited', async () => {
  let dispatched = 0
  const { runtime } = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { dispatched++; return Response.json({ choices: [{ message: { content: JSON.stringify(persona) } }] }) },
    }),
  })
  // Storage-boundary failure injection; no private service or request hook is replaced.
  runtime.database.driver.exec(`CREATE TRIGGER synthetic_usage_failure BEFORE INSERT ON model_usage_attempt
    BEGIN SELECT RAISE(ABORT, 'synthetic ledger unavailable'); END`)
  await expect(startConsultationCase(runtime)).rejects.toThrow('Persona generation failed')
  expect(dispatched).toBe(0)
  const admin = await signIn(runtime, 'admin@demo.clinmesh.local')
  const list = await runtime.app.request('/api/model-usage/requests', { headers: { cookie: admin } })
  expect(modelUsageListSchema.parse(await list.json())).toEqual({ items: [], total: 0 })
})

it('retains per-attempt unknown usage and cross-Epoch summaries without exposing historical details to members', async () => {
  let dispatched = 0
  const { runtime } = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { dispatched++; return Response.json({ model: 'actual-synthetic',
        choices: [{ message: { content: JSON.stringify(dispatched < 3 ? {} : persona) } }],
      }) },
    }),
  })
  await startConsultationCase(runtime)
  const admin = await signIn(runtime, 'admin@demo.clinmesh.local')
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const list = modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests', { headers: { cookie: admin } })).json())
  expect(dispatched).toBe(3)
  expect(list.total).toBe(3)
  expect(new Set(list.items.map(item => item.id)).size).toBe(3)
  expect(list.items.every(item => item.usage.totalTokens === null && item.cost.cny === null)).toBe(true)
  expect(list.items.filter(item => item.kind === 'format-repair')).toHaveLength(2)
  const reset = await runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', { method: 'POST',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}' })
  expect(reset.status, await reset.text()).toBe(200)
  const overview = modelUsageOverviewSchema.parse(await (await runtime.app.request('/api/model-usage/overview', { headers: { cookie: doctor } })).json())
  expect(overview.totals).toMatchObject({ requests: 3, unknownTokenRequests: 3, knownTokens: 0, cny: null })
  expect(modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests', { headers: { cookie: admin } })).json()).total).toBe(3)
  expect((await runtime.app.request(`/api/model-usage/requests/${list.items[0]!.id}`, { headers: { cookie: doctor } })).status).toBe(404)
})

it('uses current case responsibility for details and isolates every query from other Workspaces', async () => {
  let dispatched = 0
  const { runtime } = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model', consultationModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { dispatched++; return Response.json({ model: 'actual-synthetic',
        choices: [{ message: { content: JSON.stringify(dispatched === 1 ? persona : { reply: '站起来的时候会晕。' }) } }],
      }) },
    }),
  })
  const started = await startConsultationCase(runtime)
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const admin = await signIn(runtime, 'admin@demo.clinmesh.local')
  const ask = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
    method: 'POST', headers: { cookie: doctor, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1' },
      input: { expectedConsultationVersion: 2, message: '什么时候晕？' } }),
  })
  expect(ask.status, await ask.text()).toBe(200)
  const listFor = async (cookie: string) => modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests', { headers: { cookie } })).json())
  const clinical = await listFor(doctor)
  expect(clinical.items.map(item => item.feature)).toEqual(['patient_dialogue_reply'])
  const id = clinical.items[0]!.id
  expect((await runtime.app.request(`/api/model-usage/requests/${id}`, { headers: { cookie: doctor } })).status).toBe(200)
  runtime.database.driver.prepare('DELETE FROM outpatient_case_responsibility WHERE workspace_id = ? AND epoch = ? AND case_id = ?')
    .run('workspace-demo', 'epoch-1', started.outpatientCaseId)
  expect((await listFor(doctor)).total).toBe(0)
  expect((await runtime.app.request(`/api/model-usage/requests/${id}`, { headers: { cookie: doctor } })).status).toBe(404)

  // A foreign Workspace fixture at the database boundary must not enter either query.
  new WorkspaceRepository(runtime.database).install({ workspaceId: 'workspace-other', workspaceName: 'Synthetic other',
    epoch: 'epoch-other', scenarioId: 'synthetic-other', scenarioRunId: 'run-other' })
  const foreign = { ...clinical.items[0]!, id: randomUUID(), context: { ...clinical.items[0]!.context, workspaceId: 'workspace-other', epoch: 'epoch-other' } }
  runtime.database.driver.prepare(`INSERT INTO model_usage_attempt
    (attempt_id, workspace_id, epoch, case_id, feature, provider, requested_model, actual_model, status, started_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(foreign.id, foreign.context.workspaceId, foreign.context.epoch,
      foreign.context.caseId ?? null, foreign.feature, foreign.provider, foreign.requestedModel, foreign.actualModel, foreign.status, foreign.startedAt, JSON.stringify(foreign))
  expect((await listFor(admin)).total).toBe(2)
  const overview = modelUsageOverviewSchema.parse(await (await runtime.app.request('/api/model-usage/overview', { headers: { cookie: doctor } })).json())
  expect(overview.totals.requests).toBe(2)
  expect((await runtime.app.request(`/api/model-usage/requests/${foreign.id}`, { headers: { cookie: admin } })).status).toBe(404)
})

it('persists every DSH resend and repair through the real Host without double-counting cache or reasoning', async () => {
  let dispatched = 0
  const bridge = await host(async function *(): AsyncGenerator<StreamChunk> {
    dispatched++
    if (dispatched === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'synthetic failure', providerRetryAfterMs: 1 } } }
      return
    }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(dispatched === 2 ? {} : persona) }
    yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5,
      outputTokens: 30, reasoningTokens: 10, totalTokens: 155 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const fixture = await setup({ syntheaProvider: new StubSyntheaProvider(), dshModelBridge: bridge })
  await startConsultationCase(fixture.runtime)
  const cookie = await signIn(fixture.runtime, 'admin@demo.clinmesh.local')
  const records = modelUsageListSchema.parse(await (await fixture.runtime.app.request('/api/model-usage/requests', { headers: { cookie } })).json())
  expect(dispatched).toBe(3)
  expect(records.total).toBe(3)
  expect(new Set(records.items.map(item => item.id)).size).toBe(3)
  expect(records.items.map(item => item.kind).sort()).toEqual(['format-repair', 'initial', 'rate-limit-retry'])
  expect(records.items.every(item => item.dispatch === 'dispatched')).toBe(true)
  expect(records.items.filter(item => item.status === 'succeeded')).toHaveLength(2)
  expect(records.items.find(item => item.kind === 'format-repair')).toMatchObject({
    provider: bridgeRoute.provider, actualModel: bridgeRoute.model,
    usage: { inputTokens: 125, cachedInputTokens: 25, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 155, mapping: 'dsh-v1' },
  })
  expect(records.items.find(item => item.kind === 'format-repair')?.usage.raw).toEqual({
    format: 'dsh', uncachedInputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 10, totalTokens: 155,
  })
  const overview = modelUsageOverviewSchema.parse(await (await fixture.runtime.app.request('/api/model-usage/overview', { headers: { cookie } })).json())
  expect(overview.totals).toMatchObject({ requests: 3, knownTokens: 310, unknownTokenRequests: 1 })
  await fixture.restart()
  const recovered = modelUsageListSchema.parse(await (await fixture.runtime.app.request('/api/model-usage/requests', { headers: { cookie } })).json())
  expect(recovered).toEqual(records)
  expect(dispatched).toBe(3)
})

it('retains partial DSH input evidence and includes its known lower bound without inventing a total', async () => {
  const bridge = await host(async function *(): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: JSON.stringify(persona) }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const fixture = await setup({ syntheaProvider: new StubSyntheaProvider(), dshModelBridge: bridge })
  await startConsultationCase(fixture.runtime)
  const cookie = await signIn(fixture.runtime, 'admin@demo.clinmesh.local')
  const read = async (path: string) => fixture.runtime.app.request(path, { headers: { cookie } })
  const records = modelUsageListSchema.parse(await (await read('/api/model-usage/requests')).json())
  expect(records.items[0]?.usage).toMatchObject({ inputTokens: null, outputTokens: 3, totalTokens: null,
    raw: { format: 'dsh', uncachedInputTokens: 12, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null } })
  const overview = modelUsageOverviewSchema.parse(await (await read('/api/model-usage/overview')).json())
  expect(overview.totals).toMatchObject({ requests: 1, knownTokens: 15, unknownTokenRequests: 1 })
  await fixture.restart()
  expect(modelUsageListSchema.parse(await (await read('/api/model-usage/requests')).json())).toEqual(records)
})

it('keeps Host preflight rejection queryable without presenting it as an actual model request', async () => {
  let dispatched = 0
  const bridge = await host(async function *(): AsyncGenerator<StreamChunk> { dispatched++; yield { type: 'finish', reason: { kind: 'stop' } } }, false)
  const { runtime } = await setup({ syntheaProvider: new StubSyntheaProvider(), dshModelBridge: bridge,
    patientPersonaModel: encodeModelRoute(bridgeRoute) })
  await expect(startConsultationCase(runtime)).rejects.toThrow('Persona generation failed')
  const cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
  const records = modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests', { headers: { cookie } })).json())
  expect(dispatched).toBe(0)
  expect(records.total).toBe(1)
  expect(records.items[0]).toMatchObject({ dispatch: 'not-dispatched', status: 'failed', usage: { totalTokens: null } })
  const overview = modelUsageOverviewSchema.parse(await (await runtime.app.request('/api/model-usage/overview', { headers: { cookie } })).json())
  expect(overview.totals).toMatchObject({ requests: 0, knownTokens: 0, unknownTokenRequests: 0, unpricedRequests: 0 })
})

it('preserves known DSH usage after a severed transport and recovers abandoned attempts as unknown without dispatch', async () => {
  let dispatched = 0
  const bridge = await host(async function *(options): AsyncGenerator<StreamChunk> {
    dispatched++
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }
    await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('Synthetic disconnect')), { once: true }))
  })
  const fixture = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: encodeModelRoute(bridgeRoute),
    chatCompletionsProvider: new DshModelProvider({ ...bridge, fetch: async (url, init) => {
      const response = await fetch(url, init)
      return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { controller.enqueue(chunk); controller.terminate() },
      })), { status: response.status, headers: response.headers })
    } }),
  })
  await expect(startConsultationCase(fixture.runtime)).rejects.toThrow('Persona generation failed')
  const cookie = await signIn(fixture.runtime, 'admin@demo.clinmesh.local')
  const list = async () => modelUsageListSchema.parse(await (await fixture.runtime.app.request('/api/model-usage/requests', { headers: { cookie } })).json())
  const records = await list()
  expect(dispatched).toBe(1)
  expect(records.items[0]).toMatchObject({ status: 'unknown', usage: { totalTokens: 15, inputTokens: 12, outputTokens: 3 } })
  // Simulate the durable crash window after admission but before a terminal settlement.
  fixture.runtime.database.driver.prepare(`UPDATE model_usage_attempt SET status = 'in-flight',
    record_json = json_set(record_json, '$.status', 'in-flight', '$.endedAt', NULL) WHERE attempt_id = ?`).run(records.items[0]!.id)
  await fixture.restart()
  const recovered = await list()
  expect(recovered.items[0]).toMatchObject({ id: records.items[0]!.id, status: 'unknown', usage: { totalTokens: 15 } })
  expect(recovered.items[0]?.endedAt).not.toBeNull()
  expect(dispatched).toBe(1)
})
