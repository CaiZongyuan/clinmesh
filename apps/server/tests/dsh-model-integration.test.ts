import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { encodeModelRoute, dshDefaultModel } from '@clinmesh/contracts/model-bridge'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { createModelBridgeHandler } from '../../dsh-web/src/model-bridge.ts'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'

type HostContext = Parameters<typeof createModelBridgeHandler>[0]
type GenerateOptions = Parameters<HostContext['llm']['stream']>[0]
type StreamChunk = ReturnType<HostContext['llm']['stream']> extends AsyncIterable<infer Chunk> ? Chunk : never

const secret = 'synthetic-model-bridge-secret-at-least-32-characters'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function host() {
  let route = { provider: 'synthetic-provider-a', model: 'same-model' }
  let selection = 'default'
  let answer: unknown = persona
  let fail = false
  let hold = false
  let available = true
  let authenticationFailure: 'AUTH' | 'MISSING_CREDENTIAL' | 'INVALID_CREDENTIAL' | undefined
  const calls: GenerateOptions[] = []
  const ctx = {
    agentDefaultModel: { currentSelection: () => route },
    llm: {
      listModels: async (provider: string) => {
        if (!available) throw new Error('Synthetic catalog unavailable')
        return [{ provider, id: 'same-model', name: 'Synthetic model' }]
      },
      async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        calls.push(options)
        if (hold) await new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('Synthetic cancellation')), { once: true })
        })
        if (fail) throw new Error('private-provider-error-containing-a-secret')
        if (authenticationFailure !== undefined) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: authenticationFailure, status: 403,
            message: '403 Forbidden with private-provider-credential and private-prompt' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: typeof answer === 'string' ? answer : JSON.stringify(answer) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const bridge = createModelBridgeHandler(ctx as unknown as HostContext, secret, () => selection)
  const server: Server = createServer(bridge.handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { bridge.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('Host not listening')
  const origin = `http://127.0.0.1:${address.port}`
  return { origin, calls,
    route: (provider: string) => { route = { provider, model: 'same-model' } },
    selection: (value: string) => { selection = value },
    answer: (value: unknown) => { answer = value }, fail: (value: boolean) => { fail = value },
    hold: () => { hold = true }, dispose: bridge.dispose,
    available: (value: boolean) => { available = value },
    authenticationFailure: (code: NonNullable<typeof authenticationFailure>) => { authenticationFailure = code },
  }
}

it('requires a trusted server, validates narrow requests and keeps Provider identity on a pinned auxiliary call', async () => {
  const dsh = await host()
  const endpoint = `${dsh.origin}/clinmesh-model-bridge`
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(endpoint, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
  })
  expect((await post({ operation: 'resolve' })).status).toBe(403)
  expect((await post({ operation: 'resolve' }, { authorization: `Bearer ${secret}`, origin: dsh.origin })).status).toBe(403)
  expect((await post({ operation: 'resolve', url: 'https://untrusted.example' }, { authorization: `Bearer ${secret}` })).status).toBe(503)
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  const pinned = await provider.resolveModel(dshDefaultModel)
  dsh.route('synthetic-provider-b')
  dsh.answer({ reply: '一周了。' })
  const result = await provider.completeJson({ model: pinned, schemaName: 'patient_dialogue_reply',
    jsonSchema: { type: 'object' }, systemPrompt: 'synthetic patient prompt', userPayload: { synthetic: true },
    validate: value => typeof value === 'object' && value !== null && 'reply' in value,
  })
  expect(result.model).toBe(encodeModelRoute({ provider: 'synthetic-provider-a', model: 'same-model' }))
  expect(dsh.calls[0]).toMatchObject({ provider: 'synthetic-provider-a', model: 'same-model', system: expect.stringContaining('synthetic patient prompt') })
  expect(dsh.calls[0]).not.toHaveProperty('tools')
  expect(dsh.calls[0]).not.toHaveProperty('sessionId')
  expect(dsh.calls[0]?.messages).toHaveLength(1)
  dsh.fail(true)
  const failed = await post({ operation: 'complete', model: pinned, schemaName: 'patient_dialogue_reply',
    jsonSchema: {}, systemPrompt: 'private synthetic prompt', userPayload: {} }, { authorization: `Bearer ${secret}` })
  expect(await failed.text()).toBe('{"error":"MODEL_UNAVAILABLE"}')
})

it.each(['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'] as const)('distinguishes Provider %s failures without relaying credentials or private prompts', async code => {
  const dsh = await host()
  dsh.authenticationFailure(code)
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  await expect(provider.completeJson({ model: dshDefaultModel, schemaName: 'patient_dialogue_reply',
    jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {},
  })).rejects.toMatchObject({ code: 'AI_AUTH_FAILED',
    message: 'The selected DSH Provider rejected authentication or access; check its credentials and permissions' })
  const response = await fetch(`${dsh.origin}/clinmesh-model-bridge`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ operation: 'complete', model: encodeModelRoute({ provider: 'synthetic-provider-a', model: 'same-model' }),
      schemaName: 'patient_dialogue_reply', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {} }),
  })
  expect(await response.json()).toEqual({ error: 'MODEL_AUTH_FAILED' })
})

it.each(['', 'private-provider-error', '{"error":"UNKNOWN"}',
  '{"error":"MODEL_AUTH_FAILED","message":"private-provider-credential"}'])('uses a safe fallback for an unrecognized bridge error body (%s)', async body => {
  const provider = new DshModelProvider({ origin: 'http://127.0.0.1:3080', secret, timeoutMs: 2000, maxResponseBytes: 2048,
    fetch: async () => new Response(body, { status: 503 }),
  })
  await expect(provider.resolveModel(dshDefaultModel)).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED',
    message: 'The DSH model bridge is unavailable' })
})

it('bounds and cancels non-success bridge response bodies', async () => {
  let cancelled = false
  const provider = new DshModelProvider({ origin: 'http://127.0.0.1:3080', secret, timeoutMs: 2000, maxResponseBytes: 2048,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2049)) },
      cancel() { cancelled = true },
    }), { status: 503 }),
  })
  await expect(provider.resolveModel(dshDefaultModel)).rejects.toMatchObject({ code: 'AI_RESPONSE_TOO_LARGE' })
  expect(cancelled).toBe(true)
})

it('regenerates invalid JSON on the same route and respects cancellation and response bounds', async () => {
  const dsh = await host()
  dsh.answer('invalid output')
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  const input = { model: dshDefaultModel, schemaName: 'patient_dialogue_reply', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {} }
  await expect(provider.completeJson(input)).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' })
  expect(dsh.calls).toHaveLength(2)
  expect(dsh.calls.map(call => call.provider)).toEqual(['synthetic-provider-a', 'synthetic-provider-a'])
  dsh.answer({ reply: 'x'.repeat(3000) })
  await expect(provider.completeJson(input)).rejects.toMatchObject({ code: 'AI_RESPONSE_TOO_LARGE' })
  await expect(provider.completeJson({ ...input, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
})

it('pins the configured route while its Provider is unavailable and recovers on that route', async () => {
  const dsh = await host()
  dsh.available(false)
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  const model = await provider.resolveModel(dshDefaultModel)
  const input = { model, schemaName: 'patient_dialogue_reply', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {} }
  await expect(provider.completeJson(input)).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
  dsh.route('synthetic-provider-b')
  dsh.available(true)
  dsh.answer({ reply: '一周了。' })
  await provider.completeJson(input)
  expect(dsh.calls[0]?.provider).toBe('synthetic-provider-a')
})

it('cancels an active auxiliary stream on caller disconnect or plugin unload', async () => {
  const dsh = await host()
  dsh.hold()
  const provider = new DshModelProvider({ origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 2048 })
  const input = { model: dshDefaultModel, schemaName: 'patient_dialogue_reply', jsonSchema: {}, systemPrompt: 'synthetic', userPayload: {} }
  const caller = new AbortController()
  const completion = expect(provider.completeJson({ ...input, signal: caller.signal })).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
  await expect.poll(() => dsh.calls.length).toBe(1)
  caller.abort()
  await completion
  await expect.poll(() => dsh.calls[0]?.signal?.aborted).toBe(true)
  const unloaded = expect(provider.completeJson(input)).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
  await expect.poll(() => dsh.calls.length).toBe(2)
  dsh.dispose()
  await unloaded
  expect(dsh.calls[1]?.signal?.aborted).toBe(true)
})

async function hospital(dsh: Awaited<ReturnType<typeof host>>) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-dsh-models-'))
  cleanup.push(() => rm(directory, { recursive: true }))
  const options = {
    dshModelBridge: { origin: dsh.origin, secret, timeoutMs: 2000, maxResponseBytes: 1024 * 1024 },
    databasePath: join(directory, 'clinmesh.sqlite'), authBaseUrl: 'http://localhost',
    authSecret: 'synthetic-auth-secret-with-at-least-32-characters', cursorSecret: secret,
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const,
    syntheaProvider: new StubSyntheaProvider(), trustedOrigins: ['http://localhost'],
  }
  let runtime = await createClinMeshRuntime(options)
  cleanup.push(async () => runtime.close())
  return { get runtime() { return runtime }, restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

it('pins queued personas through settings changes and a Server restart', async () => {
  const dsh = await host()
  const instance = await hospital(dsh)
  const runtime = instance.runtime
  const cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
  const headers = { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }
  const generation = await runtime.app.request('/api/sim/v1/scenario-generation-jobs', {
    method: 'POST', headers, body: JSON.stringify({ name: '模型路由演练',
      population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' }, providerId: 'synthea',
      seeds: { clinical: 7331, population: 4242 }, timeRange: { end: '2026-08-01', start: '2020-01-01' }, timeZone: 'Asia/Shanghai' }),
  })
  expect(generation.status).toBe(200)
  const generated = await runtime.scenarioData.processNextGenerationJob()
  const idempotencyKey = randomUUID()
  const context = await runtime.identity.resolveRequestActor(new Headers({ cookie }), 'GET', '/api/session')
  const queued = await runtime.app.request(`/api/sim/v1/synthetic-cases/${generated?.caseIds[0]}/patient-persona-jobs`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': idempotencyKey }, body: '{}',
  })
  expect(queued.status).toBe(200)
  dsh.route('synthetic-provider-b')
  await instance.restart()
  expect(await instance.runtime.patientPersona.processNext()).toMatchObject({ status: 'succeeded' })
  expect(dsh.calls.at(-1)?.provider).toBe('synthetic-provider-a')
  // Idempotency belongs to the actor: another administrator's new task uses the new selection.
  await instance.runtime.patientPersona.enqueue({ caseId: generated!.caseIds[0]!,
    context: { ...context, actorId: 'synthetic-second-administrator' }, idempotencyKey })
  expect(await instance.runtime.patientPersona.processNext()).toMatchObject({ status: 'succeeded' })
  expect(dsh.calls.at(-1)?.provider).toBe('synthetic-provider-b')
})

it('keeps a failed patient reply on its original route after settings change', async () => {
  const dsh = await host()
  const instance = await hospital(dsh)
  const runtime = instance.runtime
  const started = await startConsultationCase(runtime)
  const headers = (cookie: string) => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
  dsh.route('synthetic-provider-b')
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const versions = { [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1' }
  dsh.answer({ reply: '一周了，站起来就晕。' })
  dsh.fail(true)
  const asked = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
    method: 'POST', headers: headers(doctor), body: JSON.stringify({ expectedVersions: versions,
      input: { expectedConsultationVersion: 2, message: '多久了？' } }),
  })
  expect(asked.status).toBe(503)
  dsh.route('synthetic-provider-a')
  dsh.fail(false)
  const detail = doctorCaseDetailSchema.parse(await (await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie: doctor } })).json())
  const retry = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/retry-consultation-reply`, {
    method: 'POST', headers: headers(doctor), body: JSON.stringify({ expectedVersions: {}, input: { expectedConsultationVersion: detail.consultation?.version } }),
  })
  expect(retry.status).toBe(200)
  expect(dsh.calls.at(-1)?.provider).toBe('synthetic-provider-b')
})
