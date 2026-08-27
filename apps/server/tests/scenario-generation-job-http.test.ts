import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  scenarioDatasetSchema,
  scenarioGenerationJobSchema,
  scenarioGenerationRequestSchema,
  startSyntheticPatientVisitsResultSchema,
  syntheticPatientMappingCatalogSchema,
  syntheticPatientProfileListSchema,
  syntheticPatientProfileSchema,
  type ScenarioGenerationRequest,
  type ScenarioProviderCapabilities,
} from '@clinmesh/contracts/scenario'
import {
  apiErrorSchema,
  commandResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  registrationCatalogSchema,
  scenarioStateSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ScenarioGenerationProvider,
  SourcePatientCorpus,
} from '../src/application/scenario-data/provider.ts'
import { compileSyntheaR4Bundle } from '../src/application/scenario-data/synthea-case-truth-compiler.ts'
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

const syntheaR4Bundle = {
  entry: [{
    fullUrl: 'urn:uuid:source-patient-1',
    resource: {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'source-patient-1',
      resourceType: 'Patient',
    },
  }, {
    resource: {
      class: { code: 'EMER' },
      id: 'source-encounter-1',
      period: {
        end: '2026-08-01T09:40:00+08:00',
        start: '2026-08-01T09:00:00+08:00',
      },
      resourceType: 'Encounter',
      status: 'finished',
      subject: { reference: 'urn:uuid:source-patient-1' },
    },
  }, {
    resource: {
      clinicalStatus: { coding: [{ code: 'active' }] },
      code: { coding: [{ code: '386661006', display: 'Fever', system: 'http://snomed.info/sct' }] },
      id: 'source-condition-1',
      onsetDateTime: '2026-08-01T08:00:00+08:00',
      recordedDate: '2026-08-01T09:05:00+08:00',
      resourceType: 'Condition',
      subject: { reference: 'urn:uuid:source-patient-1' },
    },
  }],
  resourceType: 'Bundle',
  type: 'collection',
}

async function generateSyntheaCorpus(request: ScenarioGenerationRequest): Promise<SourcePatientCorpus> {
  const corpus = await new BuiltInScenarioGenerationProvider().generate(request)
  const patient = compileSyntheaR4Bundle({
    bundle: syntheaR4Bundle,
    ordinal: 0,
    request,
  })
  return {
    content: {
      ...corpus.content,
      hiddenFacts: [{
        code: `objective-primary-diagnosis-${patient.id}`,
        patientId: patient.id,
        value: patient.diagnosisSpace.primary.display,
      }],
      patients: [patient],
      revealPolicies: [{
        code: `policy-primary-diagnosis-${patient.id}`,
        factCode: `objective-primary-diagnosis-${patient.id}`,
        patientId: patient.id,
        triggerCode: 'evaluator-only',
      }],
    },
    kind: 'case-truth',
    sources: [{
      format: 'fhir-r4-bundle',
      hash: 'a'.repeat(64),
      patientId: patient.id,
      raw: syntheaR4Bundle,
    }],
  }
}

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
      maxPopulation: 10,
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
    email = 'admin@demo.clinmesh.local',
  ): Promise<string> => {
    const response = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({
        email,
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
    expect(syntheticPatientProfileListSchema.parse(await (await restartedRuntime.app.request(
      '/api/sim/v1/synthetic-patients',
      { headers: { cookie } },
    )).json())).toMatchObject({ total: 1 })
    const after = scenarioStateSchema.parse(await (await restartedRuntime.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie } },
    )).json())
    expect(after).toEqual(before)
  })

  it('persists generated patient profiles and their raw source across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthetic-patient-library-http-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    const rawBundle = syntheaR4Bundle
    const provider = new ControlledSyntheaProvider(generateSyntheaCorpus)
    const firstRuntime = await createClinMeshRuntime(runtimeOptions(databasePath, provider))
    runtimes.push(firstRuntime)
    const firstCookie = await signIn(firstRuntime)
    const queued = await submitJob(firstRuntime, firstCookie)

    await firstRuntime.dispatchScenarioGenerationJobs()

    const listResponse = await firstRuntime.app.request('/api/sim/v1/synthetic-patients', {
      headers: { cookie: firstCookie },
    })
    expect(listResponse.status).toBe(200)
    const list = syntheticPatientProfileListSchema.parse(await listResponse.json())
    expect(list).toMatchObject({
      items: [{ batchName: generationRequest.name, name: expect.any(String), providerId: 'synthea' }],
      total: 1,
    })
    const profileId = list.items[0]?.profileId ?? ''
    const detailResponse = await firstRuntime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(profileId)}`,
      { headers: { cookie: firstCookie } },
    )
    expect(detailResponse.status).toBe(200)
    const detail = syntheticPatientProfileSchema.parse(await detailResponse.json())
    expect(detail).toMatchObject({
      profileId,
      source: { format: 'fhir-r4-bundle', hash: 'a'.repeat(64), raw: rawBundle },
    })
    const updatedIdentity = {
      ...detail.identity,
      address: '江苏省苏州市张家港市合成路 888 号（合成地址）',
      displayName: '合成患者新姓名',
      email: 'synthetic-updated@example.test',
      insuranceDisplay: '模拟城乡居民医保',
      phone: '13900008888',
    }
    const updateIdempotencyKey = randomUUID()
    const updateProfile = () => firstRuntime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(profileId)}`,
      {
        body: JSON.stringify({ expectedRevision: 1, input: updatedIdentity }),
        headers: {
          'content-type': 'application/json',
          cookie: firstCookie,
          'idempotency-key': updateIdempotencyKey,
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )
    const updateResponse = await updateProfile()
    expect(updateResponse.status).toBe(200)
    const updatedProfileResponse = commandResponseSchema(syntheticPatientProfileSchema)
      .parse(await updateResponse.json())
    expect(updatedProfileResponse).toMatchObject({
      data: {
        identity: updatedIdentity,
        patient: { longitudinalHistory: detail.patient.longitudinalHistory },
        profileId,
        revision: 2,
        source: { raw: rawBundle },
      },
    })
    expect(firstRuntime.database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM synthetic_patient_profile_revision
      WHERE workspace_id = ? AND profile_id = ?
    `).get('workspace-demo', profileId)).toEqual({ count: 2 })
    const replayedUpdate = await updateProfile()
    expect(replayedUpdate.status).toBe(200)
    expect(commandResponseSchema(syntheticPatientProfileSchema)
      .parse(await replayedUpdate.json())).toEqual(updatedProfileResponse)
    const staleResponse = await firstRuntime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(profileId)}`,
      {
        body: JSON.stringify({ expectedRevision: 1, input: updatedIdentity }),
        headers: {
          'content-type': 'application/json',
          cookie: firstCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )
    expect(staleResponse.status).toBe(409)
    const sourceResourceId = detail.patient.longitudinalHistory[0]?.sourceResourceId ?? ''
    const mappingCatalogResponse = await firstRuntime.app.request(
      '/api/sim/v1/synthetic-patient-mapping-catalog',
      { headers: { cookie: firstCookie } },
    )
    expect(mappingCatalogResponse.status).toBe(200)
    const mappingCatalog = syntheticPatientMappingCatalogSchema.parse(
      await mappingCatalogResponse.json(),
    )
    expect(mappingCatalog.items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'J06.9', sourceResourceType: 'Condition' }),
        expect.objectContaining({ code: 'AMB', sourceResourceType: 'Encounter' }),
        expect.objectContaining({ code: 'FEVER-PANEL', sourceResourceType: 'Observation' }),
      ]))
    expect(mappingCatalog.items.find(item => item.code === 'FEVER-PANEL')).not.toHaveProperty('system')
    const unsupportedMappingResponse = await firstRuntime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(profileId)}/mappings`,
      {
        body: JSON.stringify({
          expectedRevision: 2,
          input: [{
            sourceResourceId,
            target: { catalogItemId: 'unsupported-catalog-item', version: 1 },
          }],
        }),
        headers: {
          'content-type': 'application/json',
          cookie: firstCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )
    expect(unsupportedMappingResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await unsupportedMappingResponse.json())).toMatchObject({
      error: { code: 'PROFILE_MAPPING_INVALID' },
    })
    expect(firstRuntime.database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM synthetic_patient_profile_revision
      WHERE workspace_id = ? AND profile_id = ?
    `).get('workspace-demo', profileId)).toEqual({ count: 2 })
    const encounterSourceResourceId = detail.patient.longitudinalHistory.find(event => (
      event.sourceResourceType === 'Encounter'
    ))?.sourceResourceId ?? ''
    const mappingResponse = await firstRuntime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(profileId)}/mappings`,
      {
        body: JSON.stringify({
          expectedRevision: 2,
          input: [{
            sourceResourceId,
            target: {
              catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
              version: 1,
            },
          }, {
            sourceResourceId: encounterSourceResourceId,
            target: { catalogItemId: 'encounter-class-ambulatory', version: 1 },
          }],
        }),
        headers: {
          'content-type': 'application/json',
          cookie: firstCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )
    expect(mappingResponse.status).toBe(200)
    expect(commandResponseSchema(syntheticPatientProfileSchema)
      .parse(await mappingResponse.json())).toMatchObject({
      data: {
        identity: updatedIdentity,
        mappings: expect.arrayContaining([
          expect.objectContaining({
            sourceResourceId,
            target: expect.objectContaining({
              catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
              code: 'J06.9',
              system: 'http://hl7.org/fhir/sid/icd-10',
              version: 1,
            }),
          }),
          expect.objectContaining({
            sourceResourceId: encounterSourceResourceId,
            target: expect.objectContaining({
              catalogItemId: 'encounter-class-ambulatory',
              code: 'AMB',
              version: 1,
            }),
          }),
        ]),
        patient: {
          longitudinalHistory: expect.arrayContaining([
            expect.objectContaining({ mappedCode: 'J06.9', sourceResourceId }),
          ]),
        },
        revision: 3,
        source: { raw: rawBundle },
      },
    })
    expect(firstRuntime.database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM synthetic_patient_profile_revision
      WHERE workspace_id = ? AND profile_id = ?
    `).get('workspace-demo', profileId)).toEqual({ count: 3 })
    expect(await getJob(firstRuntime, firstCookie, queued.jobId)).toMatchObject({ status: 'succeeded' })
    await firstRuntime.close()
    runtimes.splice(runtimes.indexOf(firstRuntime), 1)

    const restartedRuntime = await createClinMeshRuntime(runtimeOptions(databasePath, provider))
    runtimes.push(restartedRuntime)
    const restartedCookie = await signIn(restartedRuntime)
    const restartedList = await restartedRuntime.app.request('/api/sim/v1/synthetic-patients', {
      headers: { cookie: restartedCookie },
    })
    expect(restartedList.status).toBe(200)
    expect(syntheticPatientProfileListSchema.parse(await restartedList.json())).toMatchObject({
      items: [{ name: '合成患者新姓名', revision: 3 }],
      total: 1,
    })
    const resetResponse = await restartedRuntime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      {
        body: '{}',
        headers: {
          'content-type': 'application/json',
          cookie: restartedCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(resetResponse.status).toBe(200)
    commandResponseSchema(scenarioStateSchema).parse(await resetResponse.json())
    expect(syntheticPatientProfileListSchema.parse(await (await restartedRuntime.app.request('/api/sim/v1/synthetic-patients', {
      headers: { cookie: restartedCookie },
    })).json())).toMatchObject({
      items: [{ activeVisit: false, name: '合成患者新姓名', revision: 3 }],
      total: 1,
    })
    const catalogResponse = await restartedRuntime.app.request(
      '/api/his/v1/catalogs/registration',
      { headers: { cookie: restartedCookie } },
    )
    expect(catalogResponse.status).toBe(200)
    const catalog = registrationCatalogSchema.parse(await catalogResponse.json())
    const startResponse = await restartedRuntime.app.request(
      '/api/sim/v1/synthetic-patients/actions/start-outpatient-visits',
      {
        body: JSON.stringify({
          departmentId: catalog.departments[0]?.id,
          locationId: catalog.locations[0]?.id,
          patients: [{ expectedRevision: 3, profileId }],
          visitDate: catalog.virtualDate,
          visitTypeId: catalog.visitTypes[0]?.id,
        }),
        headers: {
          'content-type': 'application/json',
          cookie: restartedCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(startResponse.status).toBe(200)
    const started = commandResponseSchema(startSyntheticPatientVisitsResultSchema)
      .parse(await startResponse.json())
    expect(started).toMatchObject({
      data: {
        items: [{ profileId, status: 'awaiting-triage' }],
      },
    })
    const materializedPatientId = started.data.items[0]?.patientId ?? ''
    const conditionsResponse = await restartedRuntime.app.request(
      `/fhir/R5/Condition?patient=${encodeURIComponent(`Patient/${materializedPatientId}`)}`,
      { headers: { cookie: restartedCookie } },
    )
    expect(conditionsResponse.status).toBe(200)
    expect(fhirBundleSchema.parse(await conditionsResponse.json())).toMatchObject({
      entry: [expect.objectContaining({
        resource: expect.objectContaining({
          code: expect.objectContaining({
            coding: [expect.objectContaining({
              code: 'J06.9',
              system: 'http://hl7.org/fhir/sid/icd-10',
            })],
          }),
          resourceType: 'Condition',
          subject: { reference: `Patient/${materializedPatientId}` },
        }),
      })],
      resourceType: 'Bundle',
    })
    const encountersResponse = await restartedRuntime.app.request(
      `/fhir/R5/Encounter?patient=${encodeURIComponent(`Patient/${materializedPatientId}`)}`,
      { headers: { cookie: restartedCookie } },
    )
    expect(encountersResponse.status).toBe(200)
    const encounters = fhirBundleSchema.parse(await encountersResponse.json())
    expect(encounters.entry?.map(entry => entry.resource)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        class: [expect.objectContaining({
          coding: [expect.objectContaining({ code: 'AMB' })],
        })],
        status: 'completed',
      }),
    ]))
    const activeListResponse = await restartedRuntime.app.request(
      '/api/sim/v1/synthetic-patients',
      { headers: { cookie: restartedCookie } },
    )
    expect(syntheticPatientProfileListSchema.parse(await activeListResponse.json())).toMatchObject({
      items: [{ activeVisit: true, profileId }],
    })
    const futureIdentity = { ...updatedIdentity, displayName: '合成患者未来姓名' }
    const futureRevision = await restartedRuntime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(profileId)}`,
      {
        body: JSON.stringify({ expectedRevision: 3, input: futureIdentity }),
        headers: {
          'content-type': 'application/json',
          cookie: restartedCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )
    expect(futureRevision.status).toBe(200)
    const secondVisit = await restartedRuntime.app.request(
      '/api/sim/v1/synthetic-patients/actions/start-outpatient-visits',
      {
        body: JSON.stringify({
          departmentId: catalog.departments[0]?.id,
          locationId: catalog.locations[0]?.id,
          patients: [{ expectedRevision: 4, profileId }],
          visitDate: catalog.virtualDate,
          visitTypeId: catalog.visitTypes[0]?.id,
        }),
        headers: {
          'content-type': 'application/json',
          cookie: restartedCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(secondVisit.status).toBe(409)
    expect(apiErrorSchema.parse(await secondVisit.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    expect(restartedRuntime.database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM synthetic_patient_materialization
      WHERE workspace_id = ? AND epoch = ? AND profile_id = ?
    `).get('workspace-demo', 'epoch-2', profileId)).toEqual({ count: 1 })
    const originalPatient = await restartedRuntime.app.request(
      `/fhir/R5/Patient/${encodeURIComponent(materializedPatientId)}`,
      { headers: { cookie: restartedCookie } },
    )
    expect(fhirResourceSchema.parse(await originalPatient.json())).toMatchObject({
      meta: { versionId: '1' },
      name: [{ text: updatedIdentity.displayName }],
    })
  })

  it('gives a generated Synthea Profile the complete doctor workflow after triage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthea-doctor-workflow-http-'))
    temporaryDirectories.push(directory)
    const provider = new ControlledSyntheaProvider(generateSyntheaCorpus)
    const runtime = await createClinMeshRuntime(runtimeOptions(
      join(directory, 'clinmesh.sqlite'),
      provider,
    ))
    runtimes.push(runtime)
    const administratorCookie = await signIn(runtime)
    await submitJob(runtime, administratorCookie)
    await runtime.dispatchScenarioGenerationJobs()
    const profilesResponse = await runtime.app.request('/api/sim/v1/synthetic-patients', {
      headers: { cookie: administratorCookie },
    })
    expect(profilesResponse.status).toBe(200)
    const profile = syntheticPatientProfileListSchema.parse(await profilesResponse.json()).items[0]
    if (profile === undefined) throw new Error('Expected a generated Synthea Profile')
    expect(profile.providerId).toBe('synthea')
    const profileResponse = await runtime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(profile.profileId)}`,
      { headers: { cookie: administratorCookie } },
    )
    expect(profileResponse.status).toBe(200)
    expect(syntheticPatientProfileSchema.parse(await profileResponse.json())).toMatchObject({
      source: { format: 'fhir-r4-bundle', raw: syntheaR4Bundle },
    })
    const catalogResponse = await runtime.app.request('/api/his/v1/catalogs/registration', {
      headers: { cookie: administratorCookie },
    })
    expect(catalogResponse.status).toBe(200)
    const catalog = registrationCatalogSchema.parse(await catalogResponse.json())
    const startResponse = await runtime.app.request(
      '/api/sim/v1/synthetic-patients/actions/start-outpatient-visits',
      {
        body: JSON.stringify({
          departmentId: catalog.departments[0]?.id,
          locationId: catalog.locations[0]?.id,
          patients: [{ expectedRevision: profile.revision, profileId: profile.profileId }],
          visitDate: catalog.virtualDate,
          visitTypeId: catalog.visitTypes[0]?.id,
        }),
        headers: {
          'content-type': 'application/json',
          cookie: administratorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(startResponse.status).toBe(200)
    const visit = commandResponseSchema(startSyntheticPatientVisitsResultSchema)
      .parse(await startResponse.json()).data.items[0]
    if (visit === undefined) throw new Error('Expected a started Synthea Profile visit')
    const triageCookie = await signIn(runtime, 'triage@demo.clinmesh.local')
    const triageResponse = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/actions/record-triage`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${visit.encounterId}`]: '1',
            [`Task/${visit.queueTaskId}`]: '1',
          },
          input: {
            acuityCode: 'level-3',
            bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
            chiefComplaint: '发热伴咽痛一天',
            oxygenSaturationPct: 98,
            pulseBpm: 96,
            respirationBpm: 20,
            temperatureC: 38.6,
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: triageCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(triageResponse.status).toBe(200)
    triageResponseSchema.parse(await triageResponse.json())
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const queueResponse = await runtime.app.request('/api/his/v1/doctor/queue?pageSize=20', {
      headers: { cookie: doctorCookie },
    })
    expect(queueResponse.status).toBe(200)
    const doctorCase = doctorQueueSchema.parse(await queueResponse.json()).items
      .find(item => item.encounterId === visit.encounterId)
    if (doctorCase === undefined) throw new Error('Expected the Synthea Profile in the doctor queue')
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${doctorCase.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(detailResponse.status).toBe(200)
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      consultation: { questions: [], records: [], version: 1 },
      encounter: { id: visit.encounterId },
      patient: { id: visit.patientId },
      status: 'awaiting-doctor',
    })
  })

  it('starts selected visits atomically and rolls back the whole batch on conflict', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthetic-patient-bulk-http-'))
    temporaryDirectories.push(directory)
    const provider = new ControlledSyntheaProvider(request => (
      new BuiltInScenarioGenerationProvider().generate(request)
    ))
    const runtime = await createClinMeshRuntime(runtimeOptions(
      join(directory, 'clinmesh.sqlite'),
      provider,
    ))
    runtimes.push(runtime)
    const cookie = await signIn(runtime)
    const generate = async (count: number, name: string, populationSeed: number) => {
      const response = await runtime.app.request('/api/sim/v1/scenario-datasets/actions/generate', {
        body: JSON.stringify({
          ...generationRequest,
          name,
          population: { ...generationRequest.population, count },
          providerId: 'builtin',
          seeds: { ...generationRequest.seeds, population: populationSeed },
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      })
      expect(response.status).toBe(200)
    }
    const listProfiles = async () => {
      const response = await runtime.app.request('/api/sim/v1/synthetic-patients', {
        headers: { cookie },
      })
      expect(response.status).toBe(200)
      return syntheticPatientProfileListSchema.parse(await response.json())
    }
    const catalog = registrationCatalogSchema.parse(await (await runtime.app.request('/api/his/v1/catalogs/registration', {
      headers: { cookie },
    })).json())
    const start = (patients: Array<{ expectedRevision: number; profileId: string }>) => (
      runtime.app.request('/api/sim/v1/synthetic-patients/actions/start-outpatient-visits', {
        body: JSON.stringify({
          departmentId: catalog.departments[0]?.id,
          locationId: catalog.locations[0]?.id,
          patients,
          visitDate: catalog.virtualDate,
          visitTypeId: catalog.visitTypes[0]?.id,
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      })
    )

    await generate(2, '首批患者', 4242)
    const firstBatch = await listProfiles()
    expect(firstBatch.total).toBe(2)
    const firstProfile = syntheticPatientProfileSchema.parse(await (await runtime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(firstBatch.items[0]?.profileId ?? '')}`,
      { headers: { cookie } },
    )).json())
    const secondProfile = syntheticPatientProfileSchema.parse(await (await runtime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(firstBatch.items[1]?.profileId ?? '')}`,
      { headers: { cookie } },
    )).json())
    const duplicateMrn = await runtime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(secondProfile.profileId)}`,
      {
        body: JSON.stringify({
          expectedRevision: secondProfile.revision,
          input: { ...secondProfile.identity, mrn: firstProfile.identity.mrn },
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )
    expect(duplicateMrn.status).toBe(409)
    expect(apiErrorSchema.parse(await duplicateMrn.json())).toMatchObject({
      error: { code: 'PROFILE_IDENTITY_CONFLICT' },
    })
    const firstStart = await start(firstBatch.items.map(item => ({
      expectedRevision: item.revision,
      profileId: item.profileId,
    })))
    expect(firstStart.status).toBe(200)
    const startedVisits = commandResponseSchema(startSyntheticPatientVisitsResultSchema)
      .parse(await firstStart.json())
    expect(startedVisits).toMatchObject({ data: { items: [{}, {}] } })

    await generate(1, '冲突回滚患者', 5252)
    const beforeConflict = await listProfiles()
    const inactive = beforeConflict.items.find(item => !item.activeVisit)
    const active = beforeConflict.items.find(item => item.activeVisit)
    if (inactive === undefined || active === undefined) throw new Error('Expected active and inactive profiles')
    const caseCountBefore = runtime.database.driver.prepare(
      'SELECT COUNT(*) AS count FROM outpatient_case WHERE workspace_id = ?',
    ).get('workspace-demo')

    const conflict = await start([{
      expectedRevision: inactive.revision,
      profileId: inactive.profileId,
    }, {
      expectedRevision: active.revision,
      profileId: active.profileId,
    }])

    expect(conflict.status).toBe(409)
    expect(runtime.database.driver.prepare(
      'SELECT COUNT(*) AS count FROM outpatient_case WHERE workspace_id = ?',
    ).get('workspace-demo')).toEqual(caseCountBefore)
    expect(runtime.database.driver.prepare(`
      SELECT patient_id
      FROM synthetic_patient_materialization
      WHERE workspace_id = ? AND profile_id = ?
    `).get('workspace-demo', inactive.profileId)).toBeUndefined()
  })

  it('backfills profiles for Dataset batches created before the patient library migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthetic-patient-backfill-http-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    const provider = new ControlledSyntheaProvider(request => (
      new BuiltInScenarioGenerationProvider().generate(request)
    ))
    const firstRuntime = await createClinMeshRuntime(runtimeOptions(databasePath, provider))
    runtimes.push(firstRuntime)
    const cookie = await signIn(firstRuntime)
    const generation = await firstRuntime.app.request('/api/sim/v1/scenario-datasets/actions/generate', {
      body: JSON.stringify({ ...generationRequest, providerId: 'builtin' }),
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(generation.status).toBe(200)
    const generatedDataset = commandResponseSchema(scenarioDatasetSchema)
      .parse(await generation.json()).data
    const repeatedGeneration = await firstRuntime.app.request(
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
    expect(repeatedGeneration.status).toBe(200)
    expect(syntheticPatientProfileListSchema.parse(await (await firstRuntime.app.request('/api/sim/v1/synthetic-patients', {
      headers: { cookie },
    })).json())).toMatchObject({ total: 1 })
    expect(firstRuntime.database.driver.prepare(`
      SELECT COUNT(*) AS count FROM synthetic_patient_profile_batch
    `).get()).toEqual({ count: 2 })
    const repeatedDataset = commandResponseSchema(scenarioDatasetSchema)
      .parse(await repeatedGeneration.json()).data
    const deleteRepeated = await firstRuntime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(repeatedDataset.datasetId)}`,
      {
        body: JSON.stringify({ expectedVersion: repeatedDataset.version }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'DELETE',
      },
    )
    expect(deleteRepeated.status).toBe(200)
    const originalPatient = generatedDataset.content.patients[0]
    if (originalPatient === undefined) throw new Error('Expected a generated patient')
    const sharedPrefix = 'synthetic-patient-with-a-shared-long-prefix-'
    const firstPatient = { ...originalPatient, id: `${sharedPrefix}alpha` }
    const secondPatient = { ...originalPatient, id: `${sharedPrefix}bravo` }
    const invalidHistoricalDataset = await firstRuntime.app.request(
      `/api/sim/v1/scenario-datasets/${encodeURIComponent(generatedDataset.datasetId)}`,
      {
        body: JSON.stringify({
          expectedVersion: generatedDataset.version,
          input: {
            content: {
              ...generatedDataset.content,
              patients: [firstPatient, secondPatient, firstPatient],
            },
            name: generatedDataset.name,
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )
    expect(invalidHistoricalDataset.status).toBe(200)
    expect(commandResponseSchema(scenarioDatasetSchema)
      .parse(await invalidHistoricalDataset.json()).data.diagnostics.length).toBeGreaterThan(0)
    firstRuntime.database.driver.exec('DROP TABLE synthetic_patient_materialization')
    firstRuntime.database.driver.exec('DROP TABLE synthetic_patient_profile_revision')
    firstRuntime.database.driver.exec('DROP TABLE synthetic_patient_profile_batch')
    firstRuntime.database.driver.exec('DROP TABLE synthetic_patient_profile')
    firstRuntime.database.driver.prepare(
      'DELETE FROM schema_migration WHERE migration_id = ?',
    ).run('0024_synthetic-patient-profile.sql')
    await firstRuntime.close()
    runtimes.splice(runtimes.indexOf(firstRuntime), 1)

    const restartedRuntime = await createClinMeshRuntime(runtimeOptions(databasePath, provider))
    runtimes.push(restartedRuntime)
    const restartedCookie = await signIn(restartedRuntime)
    const list = syntheticPatientProfileListSchema.parse(await (await restartedRuntime.app.request('/api/sim/v1/synthetic-patients', {
      headers: { cookie: restartedCookie },
    })).json())
    expect(list.total).toBe(2)
    expect(restartedRuntime.database.driver.prepare(`
      SELECT COUNT(DISTINCT mrn) AS count FROM synthetic_patient_profile
    `).get()).toEqual({ count: 2 })
    expect(restartedRuntime.database.driver.prepare(`
      SELECT COUNT(*) AS count FROM synthetic_patient_profile_batch
    `).get()).toEqual({ count: 2 })
    const profile = syntheticPatientProfileSchema.parse(await (await restartedRuntime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(list.items[0]?.profileId ?? '')}`,
      { headers: { cookie: restartedCookie } },
    )).json())
    expect(profile).toMatchObject({
      source: { format: 'legacy-compiled-profile', raw: null },
    })
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
