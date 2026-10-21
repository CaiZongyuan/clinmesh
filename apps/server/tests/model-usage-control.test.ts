import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { signIn } from './fixtures/consultation.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { modelUsageControlSchema, modelUsageListSchema, modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close() })

async function setup(extra: Partial<Parameters<typeof createClinMeshRuntime>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-model-control-'))
  dispose.push(() => rm(directory, { recursive: true, force: true }))
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    databasePath: join(directory, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'], ...extra,
  }
  let runtime = await createClinMeshRuntime(options)
  dispose.push(() => runtime.close())
  return { get runtime() { return runtime }, restart: async () => {
    await runtime.close(); runtime = await createClinMeshRuntime(options)
  } }
}

async function control(fixture: Awaited<ReturnType<typeof setup>>, input?: { enabled?: boolean; requests?: number | null; automaticRetries?: boolean }) {
  const cookie = await signIn(fixture.runtime, 'admin@demo.clinmesh.local')
  const current = modelUsageControlSchema.parse(await (await fixture.runtime.app.request('/api/model-usage/control', { headers: { cookie } })).json())
  if (input === undefined) return current
  const response = await fixture.runtime.app.request('/api/model-usage/control', { method: 'PUT',
    headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersion: current.workspace.version, enabled: current.workspace.enabled,
      requests: current.workspace.requests, automaticRetries: current.workspace.automaticRetries, ...input }) })
  expect(response.status).toBe(200)
  return modelUsageControlSchema.parse(await response.json())
}

it.each(['limit', 'retry'] as const)('checks %s again before a direct format repair without dispatching another request', async reason => {
  let dispatched = 0
  const fixture = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { dispatched++; return Response.json({ choices: [{ message: { content: '{}' } }] }) } }),
  })
  await control(fixture, reason === 'limit' ? { requests: 1 } : { automaticRetries: false })
  await expect(startConsultationCase(fixture.runtime)).rejects.toThrow('Persona generation failed')
  expect(dispatched).toBe(1)
  const state = await control(fixture)
  expect(state.lastRejection).toMatchObject({ code: reason === 'limit' ? 'MODEL_REQUEST_LIMIT' : 'MODEL_RETRY_DISABLED', scope: 'workspace' })
  if (reason === 'limit') expect(state.workspace).toMatchObject({ used: 1, reserved: 0, remaining: 0 })
  const cookie = await signIn(fixture.runtime, 'admin@demo.clinmesh.local')
  const requests = modelUsageListSchema.parse(await (await fixture.runtime.app.request('/api/model-usage/requests', { headers: { cookie } })).json())
  expect(requests.total).toBe(1)
})

it('cancels an in-flight direct request on disable and preserves its unknown reservation across restart', async () => {
  let dispatched = 0
  let started!: () => void
  const barrier = new Promise<void>(resolve => { started = resolve })
  const fixture = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async (_input, init) => { dispatched++; started(); await new Promise<void>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      }); return Response.json({ choices: [{ message: { content: JSON.stringify(persona) } }] }) } }),
  })
  await control(fixture, { requests: 1 })
  const running = startConsultationCase(fixture.runtime)
  const finished = expect(running).rejects.toThrow('Persona generation failed')
  await barrier
  await control(fixture, { enabled: false })
  await finished
  expect(dispatched).toBe(1)
  expect((await control(fixture)).workspace).toMatchObject({ enabled: false, used: 0, reserved: 1, remaining: 0 })
  const registrar = await signIn(fixture.runtime, 'registrar@demo.clinmesh.local')
  expect((await fixture.runtime.app.request('/api/his/v1/catalogs/registration', { headers: { cookie: registrar } })).status).toBe(200)
  await fixture.restart()
  expect((await control(fixture)).workspace).toMatchObject({ enabled: false, used: 0, reserved: 1, remaining: 0 })
  await control(fixture, { enabled: true, requests: 2 })
  expect(dispatched).toBe(1)
})

it('persists administrator control with versioned idempotent writes and keeps member access read only', async () => {
  const fixture = await setup()
  const admin = await signIn(fixture.runtime, 'admin@demo.clinmesh.local')
  const doctor = await signIn(fixture.runtime, 'doctor@demo.clinmesh.local')
  const read = async (cookie = admin) => fixture.runtime.app.request('/api/model-usage/control', { headers: { cookie } })
  const write = (cookie: string, body: unknown, key = randomUUID()) => fixture.runtime.app.request('/api/model-usage/control', {
    method: 'PUT', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  })
  expect((await read('')).status).toBe(401)
  const initial = await read(doctor)
  expect(initial.status).toBe(200)
  expect(await initial.json()).toMatchObject({
    workspace: { enabled: true, requests: null, automaticRetries: true, version: 1, requestsStartedAt: null, used: 0, reserved: 0, remaining: null },
    deployment: null,
    effective: { enabled: true, automaticRetries: true }, waiting: 0, inFlight: 0, lastRejection: null,
  })
  const input = { expectedVersion: 1, enabled: false, requests: 0, automaticRetries: false }
  expect((await write(doctor, input)).status).toBe(403)
  const key = randomUUID()
  const changed = await write(admin, input, key)
  expect(changed.status).toBe(200)
  expect(await changed.json()).toMatchObject({ workspace: { enabled: false, requests: 0, automaticRetries: false, version: 2, remaining: 0 }, effective: { enabled: false, automaticRetries: false } })
  expect((await write(admin, input, key)).status).toBe(200)
  expect((await write(admin, { ...input, requests: 5 }, key)).status).toBe(409)
  expect((await write(admin, { ...input, requests: 5 })).status).toBe(409)
  expect((await write(admin, { ...input, expectedVersion: 2, requests: -1 })).status).toBe(400)
  expect((await write(admin, { ...input, expectedVersion: 2, workspaceId: 'workspace-other' })).status).toBe(400)
  await fixture.restart()
  expect(await (await read()).json()).toMatchObject({ workspace: { enabled: false, requests: 0, automaticRetries: false, version: 2, used: 0 } })
})

it('hides deployment ceilings and aggregate counters from members in control and overview responses', async () => {
  const fixture = await setup({ modelUsageControl: { enabled: true, requests: 7, automaticRetries: false } })
  await control(fixture, { requests: 20 })
  fixture.runtime.database.driver.exec("UPDATE model_usage_control SET used = 3, reserved = 1 WHERE scope_id = 'deployment'")
  for (const account of ['doctor@demo.clinmesh.local', 'registrar@demo.clinmesh.local']) {
    const cookie = await signIn(fixture.runtime, account)
    const response = await fixture.runtime.app.request('/api/model-usage/control', { headers: { cookie } })
    expect(response.status).toBe(200)
    const state = modelUsageControlSchema.parse(await response.json())
    expect(state.deployment).toBeNull()
    expect(state.workspace).toMatchObject({ requests: 20, used: 0, reserved: 0 })
    expect(state.effective).toEqual({ enabled: true, automaticRetries: false })
    const overview = modelUsageOverviewSchema.parse(await (await fixture.runtime.app.request('/api/model-usage/overview', { headers: { cookie } })).json())
    expect(overview.policy.requests).toBe(20)
  }
  expect((await control(fixture)).deployment).toMatchObject({ requests: 7, used: 3, reserved: 1, remaining: 3 })
})

it('refuses dispatch when persisted request counters are invalid even with unlimited policy', async () => {
  let dispatched = 0
  const fixture = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { dispatched++; return Response.json({ choices: [{ message: { content: JSON.stringify(persona) } }] }) } }),
  })
  await control(fixture)
  fixture.runtime.database.driver.exec("UPDATE model_usage_control SET used = 0.5 WHERE scope_id = 'workspace:workspace-demo'")
  await expect(startConsultationCase(fixture.runtime)).rejects.toThrow('Persona generation failed')
  expect(dispatched).toBe(0)
  fixture.runtime.database.driver.exec("UPDATE model_usage_control SET used = 0 WHERE scope_id = 'workspace:workspace-demo'")
  expect((await control(fixture)).lastRejection).toMatchObject({ code: 'MODEL_LEDGER_UNAVAILABLE', scope: 'workspace' })
})
