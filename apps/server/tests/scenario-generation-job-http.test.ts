import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandResponseSchema } from '@clinmesh/contracts/his'
import {
  scenarioGenerationJobSchema,
  scenarioGenerationRequestSchema,
  type ScenarioGenerationRequest,
  type ScenarioProviderCapabilities,
} from '@clinmesh/contracts/scenario'
import { afterEach, describe, expect, it } from 'vitest'
import {
  sourceArtifactHash,
  type ScenarioGenerationProvider,
  type SourcePatientCorpus,
} from '../src/application/scenario-data/provider.ts'
import { SyntheaProviderError } from '../src/infrastructure/scenario-generation/synthea-provider.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

const request = scenarioGenerationRequestSchema.parse({
  modules: ['fever'],
  name: 'Synthea 纵向病史',
  population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
  providerId: 'synthea',
  seeds: { clinical: 7331, population: 4242 },
  timeRange: { end: '2026-08-01', start: '2020-01-01' },
  timeZone: 'Asia/Shanghai',
})

const bundle = {
  entry: [{
    fullUrl: 'urn:uuid:patient',
    resource: {
      birthDate: '1988-03-16', gender: 'female', id: 'patient', resourceType: 'Patient',
    },
  }, {
    fullUrl: 'urn:uuid:index-encounter',
    resource: {
      id: 'index-encounter',
      period: {
        end: '2026-08-01T09:40:00+08:00', start: '2026-08-01T09:00:00+08:00',
      },
      reasonCode: [{ text: '发热' }],
      resourceType: 'Encounter',
      status: 'finished',
      subject: { reference: 'urn:uuid:patient' },
    },
  }, {
    fullUrl: 'urn:uuid:index-condition',
    resource: {
      code: { coding: [{ code: '386661006', display: 'Fever', system: 'http://snomed.info/sct' }] },
      encounter: { reference: 'urn:uuid:index-encounter' },
      id: 'index-condition',
      recordedDate: '2026-08-01T09:05:00+08:00',
      resourceType: 'Condition',
      subject: { reference: 'urn:uuid:patient' },
    },
  }],
  resourceType: 'Bundle',
  type: 'collection',
} as const

const corpus = (): SourcePatientCorpus => ({
  kind: 'synthea-r4',
  sources: [{
    format: 'fhir-r4-bundle',
    hash: sourceArtifactHash(bundle),
    patientId: 'patient',
    raw: bundle,
  }],
})

type GenerateCorpus = (
  request: ScenarioGenerationRequest,
  signal?: AbortSignal,
) => Promise<SourcePatientCorpus>

class FakeProvider implements ScenarioGenerationProvider {
  readonly #generate: GenerateCorpus

  constructor(generate: GenerateCorpus) {
    this.#generate = generate
  }

  async capabilities(): Promise<ScenarioProviderCapabilities> {
    return {
      available: true,
      maxPopulation: 10,
      modules: ['fever', 'type-2-diabetes', 'hypertension'],
      providerId: 'synthea',
      providerName: 'Synthea',
    }
  }

  generate(generationRequest: ScenarioGenerationRequest, signal?: AbortSignal) {
    return this.#generate(generationRequest, signal)
  }
}

describe('persistent Scenario generation job HTTP contract', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const directories: string[] = []

  const options = (databasePath: string, provider: ScenarioGenerationProvider) => ({
    authBaseUrl: 'http://localhost',
    authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath,
    demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply' as const,
    syntheaProvider: provider,
    trustedOrigins: ['http://localhost'],
  })

  const signIn = async (runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>) => {
    const response = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({
        email: 'admin@demo.clinmesh.local', password: 'Synthetic-Demo-Password-2026!',
      }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  }

  const submit = (
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    cookie: string,
    key = randomUUID(),
  ) => runtime.app.request('/api/sim/v1/scenario-generation-jobs', {
    body: JSON.stringify(request),
    headers: {
      'content-type': 'application/json', cookie, 'idempotency-key': key, origin: 'http://localhost',
    },
    method: 'POST',
  })

  const readJob = async (
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
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('restores a queued job after restart and succeeds with Profile and Case ids', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthea-job-http-'))
    directories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    let release: ((value: SourcePatientCorpus) => void) | undefined
    const provider = new FakeProvider(() => new Promise(resolve => { release = resolve }))
    const first = await createClinMeshRuntime(options(databasePath, provider))
    runtimes.push(first)
    const firstCookie = await signIn(first)
    const response = await submit(first, firstCookie)
    expect(response.status).toBe(200)
    const queued = commandResponseSchema(scenarioGenerationJobSchema).parse(await response.json()).data
    expect(queued).toMatchObject({ caseIds: [], profileIds: [], status: 'queued' })
    await first.close()
    runtimes.splice(runtimes.indexOf(first), 1)

    const restarted = await createClinMeshRuntime(options(databasePath, provider))
    runtimes.push(restarted)
    const cookie = await signIn(restarted)
    expect(await readJob(restarted, cookie, queued.jobId)).toMatchObject({ status: 'queued' })
    const dispatch = restarted.dispatchScenarioGenerationJobs()
    await expect.poll(async () => (await readJob(restarted, cookie, queued.jobId)).status)
      .toBe('running')
    release?.(corpus())
    await dispatch
    expect(await readJob(restarted, cookie, queued.jobId)).toMatchObject({
      caseIds: [expect.stringMatching(/^synthetic-case-/)],
      error: null,
      profileIds: [expect.stringMatching(/^synthetic-patient-profile-/)],
      status: 'succeeded',
    })
  })

  it('requires authorization and replays an idempotent submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthea-job-auth-http-'))
    directories.push(directory)
    const runtime = await createClinMeshRuntime(options(
      join(directory, 'clinmesh.sqlite'), new FakeProvider(async () => corpus()),
    ))
    runtimes.push(runtime)
    expect((await submit(runtime, '')).status).toBe(401)
    const cookie = await signIn(runtime)
    const key = randomUUID()
    const first = await submit(runtime, cookie, key)
    const replay = await submit(runtime, cookie, key)
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    const command = commandResponseSchema(scenarioGenerationJobSchema).parse(await first.json())
    expect(commandResponseSchema(scenarioGenerationJobSchema).parse(await replay.json()))
      .toEqual(command)
    expect(runtime.database.driver.prepare(
      'SELECT COUNT(*) AS count FROM scenario_generation_job',
    ).get()).toEqual({ count: 1 })
  })

  it('exposes provider errors and redacts unknown failures', async () => {
    const failures = [{
      code: 'PROVIDER_REQUEST_FAILED',
      message: 'Synthea is unreachable',
      thrown: new SyntheaProviderError('PROVIDER_REQUEST_FAILED', 'Synthea is unreachable'),
    }, {
      code: 'GENERATION_FAILED',
      message: 'Synthea patient generation failed',
      thrown: new Error('internal path /opt/provider/private-output.json'),
    }]
    for (const failure of failures) {
      const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthea-job-failure-http-'))
      directories.push(directory)
      const runtime = await createClinMeshRuntime(options(
        join(directory, 'clinmesh.sqlite'),
        new FakeProvider(async () => { throw failure.thrown }),
      ))
      runtimes.push(runtime)
      const cookie = await signIn(runtime)
      const response = await submit(runtime, cookie)
      const queued = commandResponseSchema(scenarioGenerationJobSchema)
        .parse(await response.json()).data
      await runtime.dispatchScenarioGenerationJobs()
      const failed = await readJob(runtime, cookie, queued.jobId)
      expect(failed).toMatchObject({
        caseIds: [],
        error: { code: failure.code, message: failure.message },
        profileIds: [],
        status: 'failed',
      })
      expect(JSON.stringify(failed)).not.toContain('/opt/provider/private-output.json')
    }
  })
})
