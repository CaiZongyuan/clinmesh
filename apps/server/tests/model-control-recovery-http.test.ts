import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { patientPersonaJobSchema } from '@clinmesh/contracts/scenario'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, StubSyntheaProvider } from './fixtures/consultation.ts'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import { setModelControl } from './fixtures/model-control.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

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

it.each(['usage-ledger', 'task-journal', 'result-checkpoint'])('recovers only safely undispatched persona work across a %s failure and restart', async failure => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-control-recovery-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let sent = 0
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const,
    trustedOrigins: ['http://localhost'], syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { sent++; return Response.json({ choices: [{ message: { content: JSON.stringify(persona) } }] }) } }),
  }
  let runtime = await createClinMeshRuntime(options)
  cleanup.push(() => runtime.close())
  const cookie = await signIn(runtime, 'admin@demo.clinmesh.local')
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
  runtime.database.driver.exec(failure === 'result-checkpoint'
    ? `CREATE TRIGGER synthetic_ledger_unavailable BEFORE UPDATE ON model_task_step WHEN NEW.status = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'synthetic unavailable'); END`
    : `CREATE TRIGGER synthetic_ledger_unavailable BEFORE INSERT ON ${failure === 'usage-ledger' ? 'model_usage_attempt' : 'model_task_step'}
      BEGIN SELECT RAISE(ABORT, 'synthetic unavailable'); END`)
  await runtime.patientPersona.processNext()
  expect(sent).toBe(failure === 'result-checkpoint' ? 1 : 0)
  expect(await (await read()).json()).toMatchObject(failure === 'result-checkpoint'
    ? { status: 'failed', error: { code: 'MODEL_OUTCOME_UNKNOWN' } } : { status: 'queued' })
  await runtime.close()
  runtime = await createClinMeshRuntime(options)
  runtime.database.driver.exec('DROP TRIGGER synthetic_ledger_unavailable')
  await runtime.dispatchPending()
  await runtime.patientPersona.processNext()
  expect(await (await read()).json()).toMatchObject(failure === 'result-checkpoint'
    ? { status: 'failed', error: { code: 'MODEL_OUTCOME_UNKNOWN' } } : { status: 'succeeded', resultRevision: 1 })
  expect(sent).toBe(1)
})
