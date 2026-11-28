import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { modelUsageListSchema } from '@clinmesh/contracts/model-usage'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, StubSyntheaProvider } from './fixtures/consultation.ts'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import { setModelControl } from './fixtures/model-control.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const adminActor = {
  actorId: 'actor-administrator',
  epoch: 'epoch-1',
  locationId: 'location-administrator',
  organizationId: 'organization-clinmesh',
  practitionerId: 'practitioner-administrator',
  practitionerRoleId: 'practitioner-role-administrator',
  roleCode: 'administrator' as const,
  scenarioRunId: 'scenario-run-1',
  workspaceId: 'workspace-demo',
}

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
  await runtime.scenarioData.enqueueGeneration({
    context: adminActor,
    idempotencyKey: randomUUID(),
    request: {
      moduleMode: 'all', modules: [],
      name: '合成额度待办患者', population: { count: 1, age: { minimum: 18, maximum: 65 }, gender: 'any' },
      providerId: 'synthea', seeds: { clinical: 7331, population: 4242 }, timeRange: { start: '2020-01-01', end: '2026-08-01' }, timeZone: 'Asia/Shanghai',
    },
  })
  const scenario = await runtime.scenarioData.processNextGenerationJob()
  const queued = await runtime.patientPersona.enqueue({ caseId: scenario!.caseIds[0]!, context: adminActor, idempotencyKey: randomUUID() })
  const jobId = queued.data.jobId
  expect(await runtime.patientPersona.processNext()).toMatchObject({ jobId, status: 'queued' })
  expect(await runtime.patientPersona.processNext()).toBeUndefined()
  expect(await runtime.patientPersona.processNext()).toBeUndefined()
  expect(sent).toBe(0)
  await setModelControl(runtime, cookie, { enabled: true, requests: null, automaticRetries: true, [dimension]: null })
  await expect.poll(() => runtime.patientPersona.getJob(adminActor, jobId).status).toBe('succeeded')
  expect(sent).toBe(1)
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
  const jobs: string[] = []
  for (let index = 0; index < 2; index++) {
    await runtime.scenarioData.enqueueGeneration({
      context: adminActor,
      idempotencyKey: randomUUID(),
      request: {
        moduleMode: 'all', modules: [],
        name: `合成队列${index}`, population: { count: 1, age: { minimum: 18, maximum: 65 }, gender: 'any' },
        providerId: 'synthea', seeds: { clinical: 7331 + index, population: 4242 + index },
        timeRange: { start: '2020-01-01', end: '2026-08-01' }, timeZone: 'Asia/Shanghai',
      },
    })
    const scenario = await runtime.scenarioData.processNextGenerationJob()
    const queued = await runtime.patientPersona.enqueue({ caseId: scenario!.caseIds[0]!, context: adminActor, idempotencyKey: randomUUID() })
    jobs.push(queued.data.jobId)
  }
  const read = (jobId: string) => runtime.patientPersona.getJob(adminActor, jobId)
  await runtime.patientPersona.processNext()
  expect(read(jobs[0]!)).toMatchObject({ status: 'queued', resultRevision: null })
  expect(sent).toBe(1)
  await runtime.patientPersona.processNext()
  expect(read(jobs[1]!)).toMatchObject({ status: 'succeeded', resultRevision: 1 })
  expect(read(jobs[0]!)).toMatchObject({ status: 'queued' })
  expect(sent).toBe(2)
  await setModelControl(runtime, cookie, { enabled: true, requests: null, automaticRetries: true })
  await expect.poll(() => read(jobs[0]!).status).toBe('succeeded')
  expect(read(jobs[0]!)).toMatchObject({ jobId: jobs[0], resultRevision: 1 })
  expect(sent).toBe(3)
})

it.each(['usage-ledger', 'task-journal', 'result-checkpoint', 'usage-settlement'])('recovers only safely undispatched persona work across a %s failure and restart', async failure => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-control-recovery-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let sent = 0
  const settlementFailure = failure === 'usage-settlement'
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'test.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const,
    trustedOrigins: ['http://localhost'], syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid',
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
  await runtime.scenarioData.enqueueGeneration({
    context: adminActor,
    idempotencyKey: randomUUID(),
    request: {
      moduleMode: 'all', modules: [],
      name: '控制恢复合成患者', population: { count: 1, age: { minimum: 18, maximum: 65 }, gender: 'any' },
      providerId: 'synthea', seeds: { clinical: 7331, population: 4242 },
      timeRange: { start: '2020-01-01', end: '2026-08-01' }, timeZone: 'Asia/Shanghai',
    },
  })
  const scenario = await runtime.scenarioData.processNextGenerationJob()
  const caseId = scenario!.caseIds[0]!
  const queued = await runtime.patientPersona.enqueue({ caseId, context: adminActor, idempotencyKey: randomUUID() })
  const jobId = queued.data.jobId
  const read = () => runtime.patientPersona.getJob(adminActor, jobId)
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
  expect(read()).toMatchObject(dispatched
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
  expect(read()).toMatchObject(dispatched
    ? { status: 'failed', error: { code: 'MODEL_OUTCOME_UNKNOWN' } } : { status: 'succeeded', resultRevision: 1 })
  expect(sent).toBe(1)
  if (settlementFailure) {
    const attempts = modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests', { headers: { cookie } })).json())
    expect(attempts.items).toMatchObject([{ status: 'unknown' }])
    expect(attempts.total).toBe(1)
  }
})
