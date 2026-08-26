import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scenarioDatasetSchema,
  scenarioGenerationJobSchema,
  scenarioGenerationRequestSchema,
  type ScenarioGenerationRequest,
  type ScenarioProviderCapabilities,
} from '@clinmesh/contracts/scenario'
import { apiErrorSchema, commandResponseSchema, scenarioStateSchema } from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ScenarioGenerationProvider,
  SourcePatientCorpus,
} from '../src/application/scenario-data/provider.ts'
import { BuiltInScenarioGenerationProvider } from '../src/infrastructure/scenario-generation/builtin-provider.ts'
import { SyntheaProviderError } from '../src/infrastructure/scenario-generation/synthea-provider.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

const generationRequest = scenarioGenerationRequestSchema.parse({
  modules: ['fever'],
  name: 'Synthea 纵向病史',
  population: {
    age: { maximum: 65, minimum: 18 },
    count: 1,
    gender: 'any',
  },
  providerId: 'synthea',
  seeds: { clinical: 7331, population: 4242 },
  timeRange: { end: '2026-08-01', start: '2020-01-01' },
  timeZone: 'Asia/Shanghai',
})

class ControlledSyntheaProvider implements ScenarioGenerationProvider {
  readonly #generate: (request: ScenarioGenerationRequest, signal?: AbortSignal) => Promise<SourcePatientCorpus>

  constructor(
    generate: (request: ScenarioGenerationRequest, signal?: AbortSignal) => Promise<SourcePatientCorpus>,
  ) {
    this.#generate = generate
  }

  async capabilities(): Promise<ScenarioProviderCapabilities> {
    return {
      available: true as const,
      maxPopulation: 50,
      modules: ['fever', 'type-2-diabetes'],
      providerId: 'synthea' as const,
      providerName: 'Synthea',
    }
  }

  generate(request: ScenarioGenerationRequest, signal?: AbortSignal) {
    return this.#generate(request, signal)
  }
}

describe('persistent Scenario generation job HTTP contract', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const temporaryDirectories: string[] = []

  const runtimeOptions = (databasePath: string, provider: ScenarioGenerationProvider) => ({
    authBaseUrl: 'http://localhost',
    authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath,
    demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply' as const,
    syntheaProvider: provider,
    trustedOrigins: ['http://localhost'],
  })

  const signIn = async (
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
  ): Promise<string> => {
    const response = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({
        email: 'admin@demo.clinmesh.local',
        password: 'Synthetic-Demo-Password-2026!',
      }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  }

  const submitJob = async (
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    cookie: string,
  ) => {
    const response = await runtime.app.request('/api/sim/v1/scenario-generation-jobs', {
      body: JSON.stringify(generationRequest),
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    return commandResponseSchema(scenarioGenerationJobSchema).parse(await response.json()).data
  }

  const getJob = async (
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    cookie: string,
    jobId: string,
  ) => {
    const response = await runtime.app.request(
      `/api/sim/v1/scenario-generation-jobs/${encodeURIComponent(jobId)}`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(200)
    return scenarioGenerationJobSchema.parse(await response.json())
  }

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('restores a queued job after restart and exposes running through succeeded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthea-job-http-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    let releaseGeneration: ((corpus: SourcePatientCorpus) => void) | undefined
    const provider = new ControlledSyntheaProvider(() => new Promise((resolve) => {
      releaseGeneration = resolve
    }))
    const firstRuntime = await createClinMeshRuntime(runtimeOptions(databasePath, provider))
    runtimes.push(firstRuntime)
    const firstCookie = await signIn(firstRuntime)
    const before = scenarioStateSchema.parse(await (await firstRuntime.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie: firstCookie } },
    )).json())
    const queued = await submitJob(firstRuntime, firstCookie)
    expect(queued).toMatchObject({ datasetId: null, status: 'queued' })
    await firstRuntime.close()
    runtimes.splice(runtimes.indexOf(firstRuntime), 1)

    const restartedRuntime = await createClinMeshRuntime(runtimeOptions(databasePath, provider))
    runtimes.push(restartedRuntime)
    const cookie = await signIn(restartedRuntime)
    expect(await getJob(restartedRuntime, cookie, queued.jobId)).toMatchObject({ status: 'queued' })

    const dispatch = restartedRuntime.dispatchScenarioGenerationJobs()
    await expect.poll(async () => (await getJob(
      restartedRuntime,
      cookie,
      queued.jobId,
    )).status).toBe('running')
    const corpus = await new BuiltInScenarioGenerationProvider().generate(generationRequest)
    releaseGeneration?.(corpus)
    await dispatch

    const succeeded = await getJob(restartedRuntime, cookie, queued.jobId)
    expect(succeeded).toMatchObject({
      datasetId: expect.stringMatching(/^scenario-dataset-/),
      error: null,
      status: 'succeeded',
    })
    expect(restartedRuntime.database.driver.prepare(`
      SELECT actor_id, operation, outcome
      FROM audit_log
      WHERE workspace_id = ? AND operation = ?
    `).get('workspace-demo', 'scenario-generation-job.complete')).toEqual({
      actor_id: 'actor-administrator',
      operation: 'scenario-generation-job.complete',
      outcome: 'success',
    })
    const datasetResponse = await restartedRuntime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(succeeded.datasetId ?? '')}`,
      { headers: { cookie } },
    )
    expect(datasetResponse.status).toBe(200)
    expect(scenarioDatasetSchema.parse(await datasetResponse.json())).toMatchObject({
      name: generationRequest.name,
      providerId: 'synthea',
    })
    const deleteResponse = await restartedRuntime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(succeeded.datasetId ?? '')}`,
      {
        body: JSON.stringify({ expectedVersion: 1 }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'DELETE',
      },
    )
    expect(deleteResponse.status).toBe(200)
    expect(await getJob(restartedRuntime, cookie, queued.jobId)).toMatchObject({
      datasetId: succeeded.datasetId,
      status: 'succeeded',
    })
    expect((await restartedRuntime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(succeeded.datasetId ?? '')}`,
      { headers: { cookie } },
    )).status).toBe(404)
    const after = scenarioStateSchema.parse(await (await restartedRuntime.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie } },
    )).json())
    expect(after).toEqual(before)
  })

  it('contains a Provider failure and keeps the built-in generator available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthea-failed-job-http-'))
    temporaryDirectories.push(directory)
    const provider = new ControlledSyntheaProvider(async () => {
      throw new SyntheaProviderError('PROVIDER_REQUEST_FAILED', 'Synthea is unreachable')
    })
    const runtime = await createClinMeshRuntime(runtimeOptions(
      join(directory, 'clinmesh.sqlite'),
      provider,
    ))
    runtimes.push(runtime)
    const cookie = await signIn(runtime)
    const before = scenarioStateSchema.parse(await (await runtime.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie } },
    )).json())
    const queued = await submitJob(runtime, cookie)

    await runtime.dispatchScenarioGenerationJobs()

    expect(await getJob(runtime, cookie, queued.jobId)).toMatchObject({
      datasetId: null,
      error: {
        code: 'PROVIDER_REQUEST_FAILED',
        message: 'Synthea is unreachable',
      },
      status: 'failed',
    })
    expect(runtime.database.driver.prepare(`
      SELECT actor_id, operation, outcome
      FROM audit_log
      WHERE workspace_id = ? AND operation = ?
    `).get('workspace-demo', 'scenario-generation-job.fail')).toEqual({
      actor_id: 'actor-administrator',
      operation: 'scenario-generation-job.fail',
      outcome: 'success',
    })
    const after = scenarioStateSchema.parse(await (await runtime.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie } },
    )).json())
    expect(after).toEqual(before)

    const builtInResponse = await runtime.app.request(
      '/api/sim/v1/scenario-datasets/actions/generate',
      {
        body: JSON.stringify({ ...generationRequest, providerId: 'builtin' }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(builtInResponse.status).toBe(200)
    expect(commandResponseSchema(scenarioDatasetSchema).parse(await builtInResponse.json()).data)
      .toMatchObject({ providerId: 'builtin' })
  })

  it('requires external Providers to use persistent jobs and redacts unknown failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthea-job-boundary-http-'))
    temporaryDirectories.push(directory)
    const provider = new ControlledSyntheaProvider(async () => {
      throw new Error('internal path /opt/provider/private-output.json')
    })
    const runtime = await createClinMeshRuntime(runtimeOptions(
      join(directory, 'clinmesh.sqlite'),
      provider,
    ))
    runtimes.push(runtime)
    const cookie = await signIn(runtime)

    const synchronousResponse = await runtime.app.request(
      '/api/sim/v1/scenario-datasets/actions/generate',
      {
        body: JSON.stringify(generationRequest),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(synchronousResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await synchronousResponse.json())).toMatchObject({
      error: {
        code: 'DATASET_INVALID',
        message: 'External Scenario Providers must use persistent generation jobs',
      },
    })

    const queued = await submitJob(runtime, cookie)
    await runtime.dispatchScenarioGenerationJobs()

    expect(await getJob(runtime, cookie, queued.jobId)).toMatchObject({
      error: {
        code: 'GENERATION_FAILED',
        message: 'Scenario generation failed',
      },
      status: 'failed',
    })
  })
})
