import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { patientPersonaJobSchema } from '@clinmesh/contracts/scenario'
import { encodeModelRoute } from '@clinmesh/contracts/model-bridge'
import { modelUsageListSchema, unknownModelTokenUsage } from '@clinmesh/contracts/model-usage'
import { clinicalDocumentQualityControlStateSchema, doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { DshModelProvider } from '../src/infrastructure/ai/dsh-model-provider.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import { setModelControl } from './fixtures/model-control.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.each(['tokens', 'cny'] as const)('计量条件未变化时不反复领取 %s 受限的人设待办，解除后恢复原任务', async dimension => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-dimensional-recovery-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let sent = 0
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { sent++; return Response.json({ choices: [{ message: { content: JSON.stringify(persona) } }] }) } }),
  })
  cleanup.push(() => runtime.close())
  const cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
  await setModelControl(runtime, cookie, { enabled: true, requests: null, automaticRetries: true, [dimension]: 100 })
  const headers = () => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
  expect((await runtime.app.request('/api/sim/v1/scenario-generation-jobs', { method: 'POST', headers: headers(),
    body: JSON.stringify({ name: '合成额度待办患者', population: { count: 1, age: { minimum: 18, maximum: 65 }, gender: 'any' },
      providerId: 'synthea', seeds: { clinical: 7331, population: 4242 }, timeRange: { start: '2020-01-01', end: '2026-08-01' }, timeZone: 'Asia/Shanghai' }) })).status).toBe(200)
  const scenario = await runtime.scenarioData.processNextGenerationJob()
  const queued = await runtime.app.request(`/api/sim/v1/synthetic-cases/${scenario!.caseIds[0]!}/patient-persona-jobs`, {
    method: 'POST', headers: headers(), body: '{}' })
  expect(queued.status).toBe(200)
  const { data: { jobId } } = z.object({ data: z.object({ jobId: z.string() }) }).parse(await queued.json())
  expect(await runtime.patientPersona.processNext()).toMatchObject({ jobId, status: 'queued' })
  expect(await runtime.patientPersona.processNext()).toBeUndefined()
  expect(await runtime.patientPersona.processNext()).toBeUndefined()
  expect(sent).toBe(0)
  await setModelControl(runtime, cookie, { enabled: true, requests: null, automaticRetries: true, [dimension]: null })
  await expect.poll(async () => patientPersonaJobSchema.parse(await (await runtime.app.request(
    `/api/sim/v1/patient-persona-jobs/${jobId}`, { headers: { cookie } })).json()).status).toBe('succeeded')
  expect(sent).toBe(1)
})

it.each([408, 504])('does not automatically resend a quality request after HTTP %s or restart', async status => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-gateway-timeout-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let qualityRequests = 0
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const,
    trustedOrigins: ['http://localhost'], syntheaProvider: new StubSyntheaProvider(),
    patientPersonaModel: 'synthetic', consultationModel: 'synthetic', outboxRetryDelayMs: 0,
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
      fetch: async (_url, init) => {
        const request = z.object({ response_format: z.object({ json_schema: z.object({ name: z.string() }) }) })
          .parse(JSON.parse(String(init?.body)))
        if (request.response_format.json_schema.name === 'patient_persona') {
          return Response.json({ choices: [{ message: { content: JSON.stringify(persona) } }] })
        }
        qualityRequests++
        return Response.json({ error: { code: 'synthetic_gateway_timeout' }, usage: { prompt_tokens: 3 } }, { status })
      } }),
  }
  let runtime = await createClinMeshRuntime(options)
  cleanup.push(() => runtime.close())
  const started = await startConsultationCase(runtime)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const headers = () => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
  const claimed = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ expectedVersions: {
      [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
    }, input: {} }),
  })
  expect(claimed.status).toBe(200)
  const detail = doctorCaseDetailSchema.parse(await (await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`,
    { headers: { cookie } })).json())
  const path = `/api/his/v1/doctor/cases/${started.outpatientCaseId}/document-quality-control`
  const checked = await runtime.app.request(`${path}/actions/check`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: detail.encounter.versionId },
      input: { expectedDraftVersion: 0 } }),
  })
  expect(checked.status).toBe(200)
  const read = async () => clinicalDocumentQualityControlStateSchema.parse(await (await runtime.app.request(path, { headers: { cookie } })).json())
  await runtime.dispatchPending()
  expect(qualityRequests).toBe(1)
  expect(await read()).toMatchObject({ status: 'incomplete', errorCode: 'MODEL_TIMEOUT', failure: { reason: 'timeout' } })
  await runtime.close()
  runtime = await createClinMeshRuntime(options)
  const admin = await signIn(runtime, 'admin@demo.clinmesh.local')
  await setModelControl(runtime, admin, { enabled: true, requests: null, automaticRetries: true })
  await runtime.dispatchPending()
  expect(qualityRequests).toBe(1)
  expect(await read()).toMatchObject({ status: 'incomplete', errorCode: 'MODEL_TIMEOUT' })
  const attempts = modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests?feature=clinical_document_quality',
    { headers: { cookie: admin } })).json())
  expect(attempts.total).toBe(1)
  expect(attempts.items).toMatchObject([{ status: 'unknown', dispatch: 'dispatched', httpStatus: status,
    usage: { inputTokens: 3, outputTokens: null, totalTokens: null } }])
})

it('runs an independent persona job while an earlier repair waits, then resumes the original job', async () => {
  class DistinctPatients extends StubSyntheaProvider {
    count = 0
    override async generate() {
      const result = await super.generate()
      const patientId = `synthetic-${++this.count}`
      const source = result.sources[0]!
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(source.raw)
      raw.entry[0]!.resource.id = patientId
      return { ...result, sources: [{ ...source, patientId, raw, hash: sourceArtifactHash(raw) }] }
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-persona-queue-recovery-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let sent = 0
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    syntheaProvider: new DistinctPatients(), patientPersonaModel: 'synthetic',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { sent++; return Response.json({ choices: [{ message: { content: JSON.stringify(sent === 1 ? {} : persona) } }] }) } }),
  })
  cleanup.push(() => runtime.close())
  const cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
  await setModelControl(runtime, cookie, { enabled: true, requests: null, automaticRetries: false })
  const headers = () => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
  const jobs: string[] = []
  for (let index = 0; index < 2; index++) {
    const generated = await runtime.app.request('/api/sim/v1/scenario-generation-jobs', { method: 'POST', headers: headers(),
      body: JSON.stringify({ name: `合成队列${index}`, population: { count: 1, age: { minimum: 18, maximum: 65 }, gender: 'any' },
        providerId: 'synthea', seeds: { clinical: 7331 + index, population: 4242 + index },
        timeRange: { start: '2020-01-01', end: '2026-08-01' }, timeZone: 'Asia/Shanghai' }) })
    expect(generated.status).toBe(200)
    const scenario = await runtime.scenarioData.processNextGenerationJob()
    const queued = await runtime.app.request(`/api/sim/v1/synthetic-cases/${scenario!.caseIds[0]!}/patient-persona-jobs`, {
      method: 'POST', headers: headers(), body: '{}' })
    expect(queued.status).toBe(200)
    jobs.push(z.object({ data: z.object({ jobId: z.string() }) }).parse(await queued.json()).data.jobId)
  }
  const read = async (jobId: string) => patientPersonaJobSchema.parse(await (await runtime.app.request(
    `/api/sim/v1/patient-persona-jobs/${jobId}`, { headers: { cookie } })).json())
  await runtime.patientPersona.processNext()
  expect(await read(jobs[0]!)).toMatchObject({ status: 'queued', resultRevision: null })
  expect(sent).toBe(1)
  await runtime.patientPersona.processNext()
  expect(await read(jobs[1]!)).toMatchObject({ status: 'succeeded', resultRevision: 1 })
  expect(await read(jobs[0]!)).toMatchObject({ status: 'queued' })
  expect(sent).toBe(2)
  await setModelControl(runtime, cookie, { enabled: true, requests: null, automaticRetries: true })
  await expect.poll(async () => (await read(jobs[0]!)).status).toBe('succeeded')
  expect(await read(jobs[0]!)).toMatchObject({ jobId: jobs[0], resultRevision: 1 })
  expect(sent).toBe(3)
})

it.each(['usage-ledger', 'task-journal', 'result-checkpoint', 'usage-settlement', 'bridge-usage-settlement'])('recovers only safely undispatched persona work across a %s failure and restart', async failure => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-control-recovery-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let sent = 0
  const settlementFailure = failure === 'usage-settlement' || failure === 'bridge-usage-settlement'
  const model = failure === 'bridge-usage-settlement' ? encodeModelRoute({ provider: 'synthetic', model: 'synthetic' }) : 'synthetic'
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const,
    trustedOrigins: ['http://localhost'], syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: model,
    chatCompletionsProvider: failure === 'bridge-usage-settlement'
      ? new DshModelProvider({ origin: 'http://127.0.0.1:12345', secret: 'synthetic', timeoutMs: 2000, maxResponseBytes: 16_384,
        fetch: async (_url, init) => {
          sent++
          const { attemptId } = z.object({ attemptId: z.uuid() }).parse(JSON.parse(String(init?.body)))
          return Response.json({ model, content: JSON.stringify(persona), accounting: { attemptId,
            status: 'succeeded', dispatch: 'dispatched', usage: { ...unknownModelTokenUsage,
              inputTokens: 3, outputTokens: 2, totalTokens: 5, mapping: 'dsh-v1' } } })
        } })
      : new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { sent++; return Response.json({ choices: [{ message: { content: JSON.stringify(persona) } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) } }),
  }
  let runtime = await createClinMeshRuntime(options)
  cleanup.push(() => runtime.close())
  const cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
  if (settlementFailure) {
    await setModelControl(runtime, cookie, { enabled: true, requests: null, automaticRetries: true, tokens: 100 })
    await setModelControl(runtime, cookie, { enabled: true, requests: null, automaticRetries: true, tokens: null })
  }
  const headers = { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }
  const generated = await runtime.app.request('/api/sim/v1/scenario-generation-jobs', { method: 'POST', headers,
    body: JSON.stringify({ name: '控制恢复合成患者', population: { count: 1, age: { minimum: 18, maximum: 65 }, gender: 'any' },
      providerId: 'synthea', seeds: { clinical: 7331, population: 4242 },
      timeRange: { start: '2020-01-01', end: '2026-08-01' }, timeZone: 'Asia/Shanghai' }) })
  expect(generated.status).toBe(200)
  const scenario = await runtime.scenarioData.processNextGenerationJob()
  const caseId = scenario!.caseIds[0]!
  const queued = await runtime.app.request(`/api/sim/v1/synthetic-cases/${caseId}/patient-persona-jobs`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() }, body: '{}' })
  expect(queued.status).toBe(200)
  const body = await queued.json() as { data: { jobId: string } }
  const read = () => runtime.app.request(`/api/sim/v1/patient-persona-jobs/${body.data.jobId}`, { headers: { cookie } })
  const dispatched = failure === 'result-checkpoint' || settlementFailure
  runtime.database.driver.exec(settlementFailure
    ? `CREATE TRIGGER synthetic_ledger_unavailable BEFORE UPDATE ON model_usage_dimension WHEN NEW.used > OLD.used
      BEGIN SELECT RAISE(ABORT, 'synthetic unavailable'); END`
    : failure === 'result-checkpoint'
    ? `CREATE TRIGGER synthetic_ledger_unavailable BEFORE UPDATE ON model_task_step WHEN NEW.status = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'synthetic unavailable'); END`
    : `CREATE TRIGGER synthetic_ledger_unavailable BEFORE INSERT ON ${failure === 'usage-ledger' ? 'model_usage_attempt' : 'model_task_step'}
      BEGIN SELECT RAISE(ABORT, 'synthetic unavailable'); END`)
  await runtime.patientPersona.processNext()
  expect(sent).toBe(dispatched ? 1 : 0)
  expect(await (await read()).json()).toMatchObject(dispatched
    ? { status: 'failed', error: { code: 'MODEL_OUTCOME_UNKNOWN' } } : { status: 'queued' })
  if (settlementFailure) {
    runtime.database.driver.exec('DROP TRIGGER synthetic_ledger_unavailable')
    await runtime.dispatchPending()
    await runtime.patientPersona.processNext()
    expect(sent).toBe(1)
  }
  await runtime.close()
  runtime = await createClinMeshRuntime(options)
  if (!settlementFailure) runtime.database.driver.exec('DROP TRIGGER synthetic_ledger_unavailable')
  await runtime.dispatchPending()
  await runtime.patientPersona.processNext()
  expect(await (await read()).json()).toMatchObject(dispatched
    ? { status: 'failed', error: { code: 'MODEL_OUTCOME_UNKNOWN' } } : { status: 'succeeded', resultRevision: 1 })
  expect(sent).toBe(1)
  if (settlementFailure) {
    const attempts = modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests', { headers: { cookie } })).json())
    expect(attempts.items).toMatchObject([{ status: 'unknown' }])
    expect(attempts.total).toBe(1)
  }
})

it.each(['missing-error', 'missing-success', 'malformed', 'unknown-dispatch'])('stops automatic resend when DSH accounting is %s, including after restart', async accounting => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-bridge-recovery-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let sent = 0
  const model = encodeModelRoute({ provider: 'synthetic', model: 'synthetic' })
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const,
    trustedOrigins: ['http://localhost'], syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: model,
    chatCompletionsProvider: new DshModelProvider({ origin: 'http://127.0.0.1:12345', secret: 'synthetic', timeoutMs: 2000, maxResponseBytes: 16_384,
      fetch: async (_url, init) => {
        sent++
        const { attemptId } = z.object({ attemptId: z.uuid() }).parse(JSON.parse(String(init?.body)))
        return accounting === 'missing-success' ? Response.json({ model, content: JSON.stringify(persona) })
          : Response.json({ error: 'MODEL_UNAVAILABLE', ...(accounting === 'malformed' ? { accounting: { attemptId, usage: {} } }
            : accounting === 'unknown-dispatch' ? { accounting: { attemptId, status: 'failed', dispatch: 'unknown', usage: unknownModelTokenUsage } } : {}) }, { status: 503 })
      } }),
  }
  let runtime = await createClinMeshRuntime(options)
  cleanup.push(() => runtime.close())
  const cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
  const headers = { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }
  const generated = await runtime.app.request('/api/sim/v1/scenario-generation-jobs', { method: 'POST', headers,
    body: JSON.stringify({ name: '桥接核算合成患者', population: { count: 1, age: { minimum: 18, maximum: 65 }, gender: 'any' },
      providerId: 'synthea', seeds: { clinical: 7331, population: 4242 },
      timeRange: { start: '2020-01-01', end: '2026-08-01' }, timeZone: 'Asia/Shanghai' }) })
  expect(generated.status).toBe(200)
  const scenario = await runtime.scenarioData.processNextGenerationJob()
  const queued = await runtime.app.request(`/api/sim/v1/synthetic-cases/${scenario!.caseIds[0]!}/patient-persona-jobs`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() }, body: '{}' })
  expect(queued.status).toBe(200)
  const { data: { jobId } } = z.object({ data: z.object({ jobId: z.string() }) }).parse(await queued.json())
  await runtime.patientPersona.processNext()
  const read = async () => patientPersonaJobSchema.parse(await (await runtime.app.request(
    `/api/sim/v1/patient-persona-jobs/${jobId}`, { headers: { cookie } })).json())
  expect(await read()).toMatchObject({ status: 'failed', error: { code: 'MODEL_OUTCOME_UNKNOWN' }, resultRevision: null })
  await runtime.close()
  runtime = await createClinMeshRuntime(options)
  await setModelControl(runtime, cookie, { enabled: true, requests: 10, automaticRetries: true })
  await runtime.dispatchPending()
  await runtime.patientPersona.processNext()
  expect(sent).toBe(1)
  expect(await read()).toMatchObject({ status: 'failed', error: { code: 'MODEL_OUTCOME_UNKNOWN' }, resultRevision: null })
  const attempts = modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests', { headers: { cookie } })).json())
  expect(attempts.total).toBe(1)
  expect(attempts.items).toMatchObject([{ status: 'unknown', dispatch: 'unknown', usage: unknownModelTokenUsage }])
})
