import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  patientBriefJobSchema,
  patientBriefRevisionListSchema,
  scenarioGenerationJobSchema,
  startSyntheticCaseResultSchema,
  syntheticCaseInstanceSchema,
  syntheticPatientProfileDetailSchema,
  syntheticSourceHistoryListSchema,
  syntheticSourceResourceDetailSchema,
  type ScenarioGenerationRequest,
  type ScenarioProviderCapabilities,
  type PatientBriefContent,
} from '@clinmesh/contracts/scenario'
import {
  apiErrorSchema,
  commandResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  issueLaboratoryRequestResponseSchema,
  laboratoryRequestActionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  registrationCatalogSchema,
  scenarioCommandResponseSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ScenarioGenerationProvider,
  SourcePatientCorpus,
} from '../src/application/scenario-data/provider.ts'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import type {
  JsonChatCompletionInput,
  JsonChatCompletionsProvider,
} from '../src/infrastructure/ai/openai-chat-completions.ts'

const translationWarning = {
  code: 'TRANSLATION_GAP' as const,
  gapCount: 1,
  gaps: [{
    code: 'missing-code',
    path: 'code.coding[0]',
    resourceId: 'prior-condition',
    resourceType: 'Condition',
    sourceDisplay: 'Untranslated display',
    system: 'http://snomed.info/sct',
    version: null,
  }],
  message: 'The Synthea Bundle contains untranslated clinical displays' as const,
  truncated: false,
}

function patientBundle(qualified: boolean, followUp = true) {
  const entries: Array<Record<string, unknown>> = [{
    fullUrl: 'urn:uuid:patient',
    resource: {
      birthDate: '1970-01-01',
      gender: 'female',
      id: 'patient',
      name: [{ text: '张琴' }],
      resourceType: 'Patient',
    },
  }, {
    fullUrl: 'urn:uuid:prior-encounter',
    resource: {
      id: 'prior-encounter',
      period: { end: '2025-01-10T09:30:00+08:00', start: '2025-01-10T09:00:00+08:00' },
      resourceType: 'Encounter',
      status: 'finished',
      subject: { reference: 'urn:uuid:patient' },
    },
  }, {
    fullUrl: 'urn:uuid:prior-condition',
    resource: {
      code: {
        coding: [{
          code: followUp ? '59621000' : '44054006',
          display: followUp ? '高血压（疾病）' : '2 型糖尿病',
          system: 'http://snomed.info/sct',
        }],
      },
      encounter: { reference: 'urn:uuid:prior-encounter' },
      id: 'prior-condition',
      recordedDate: '2025-01-10T09:05:00+08:00',
      resourceType: 'Condition',
      subject: { reference: 'urn:uuid:patient' },
    },
  }, {
    fullUrl: 'urn:uuid:index-encounter',
    resource: {
      id: 'index-encounter',
      period: { end: '2026-06-01T10:30:00+08:00', start: '2026-06-01T10:00:00+08:00' },
      ...(qualified ? { reasonCode: [{ text: '血压控制不佳' }] } : {}),
      resourceType: 'Encounter',
      status: 'finished',
      subject: { reference: 'urn:uuid:patient' },
    },
  }]
  if (!qualified) {
    return { entry: [entries[0]!, entries[3]!], resourceType: 'Bundle', type: 'collection' }
  }
  if (qualified) {
    entries.push({
      fullUrl: 'urn:uuid:index-condition',
      resource: {
        code: {
          coding: [{
            code: '59621000',
            display: '高血压（疾病）',
            system: 'http://snomed.info/sct',
          }],
        },
        encounter: { reference: 'urn:uuid:index-encounter' },
        id: 'index-condition',
        recordedDate: '2026-06-01T10:05:00+08:00',
        resourceType: 'Condition',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:index-observation',
      resource: {
        code: {
          coding: [{ code: '8480-6', display: '收缩压', system: 'http://loinc.org' }],
        },
        effectiveDateTime: '2026-06-01T10:10:00+08:00',
        encounter: { reference: 'urn:uuid:index-encounter' },
        id: 'index-observation',
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: 'urn:uuid:patient' },
        valueQuantity: {
          code: 'mm[Hg]',
          system: 'http://unitsofmeasure.org',
          unit: 'mmHg',
          value: 162,
        },
      },
    })
  }
  return { entry: entries, resourceType: 'Bundle', type: 'collection' }
}

async function corpusFor(
  request: ScenarioGenerationRequest,
  qualified: boolean,
  followUp = true,
): Promise<SourcePatientCorpus> {
  const bundle = patientBundle(qualified, followUp)
  return {
    kind: 'synthea-r4',
    sources: [{
      format: 'fhir-r4-bundle',
      hash: sourceArtifactHash(bundle),
      patientId: 'patient',
      raw: bundle,
      translationWarning,
    }],
  }
}

class RetryingSyntheaProvider implements ScenarioGenerationProvider {
  readonly requests: ScenarioGenerationRequest[] = []
  readonly #qualifyingAttempt: number | undefined
  readonly #followUp: boolean

  constructor(qualifyingAttempt?: number, followUp = true) {
    this.#qualifyingAttempt = qualifyingAttempt
    this.#followUp = followUp
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

  async generate(request: ScenarioGenerationRequest): Promise<SourcePatientCorpus> {
    this.requests.push(request)
    return corpusFor(request, this.requests.length === this.#qualifyingAttempt, this.#followUp)
  }
}

class ControlledBriefProvider implements JsonChatCompletionsProvider {
  readonly requests: JsonChatCompletionInput[] = []
  readonly #outputs: unknown[]

  constructor(outputs: unknown[]) {
    this.#outputs = outputs
  }

  async completeJson(input: JsonChatCompletionInput) {
    this.requests.push(input)
    const output = this.#outputs.shift()
    if (output === undefined) throw new Error('No fake Patient Brief output remains')
    return { content: JSON.stringify(output), model: 'resolved-fake-brief-model' }
  }
}

describe('Synthetic Case generation HTTP contract', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  async function createRuntime(
    provider: ScenarioGenerationProvider,
    briefProvider?: JsonChatCompletionsProvider,
    options: { databasePath?: string; migrationMode?: 'apply' | 'verify' } = {},
  ) {
    const directory = options.databasePath === undefined
      ? await mkdtemp(join(tmpdir(), 'clinmesh-synthetic-case-http-'))
      : undefined
    if (directory !== undefined) temporaryDirectories.push(directory)
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: options.databasePath ?? join(directory!, 'clinmesh.sqlite'),
      demoPassword: 'Synthetic-Demo-Password-2026!',
      migrationMode: options.migrationMode ?? 'apply',
      ...(briefProvider === undefined
        ? {}
        : {
            chatCompletionsProvider: briefProvider,
            investigationModel: 'fake-investigation-model',
            patientBriefModel: 'fake-brief-model',
          }),
      syntheaProvider: provider,
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    return runtime
  }

  async function enqueueBrief(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    cookie: string,
    caseId: string,
  ) {
    const response = await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/patient-brief-jobs`,
      {
        body: '{}',
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(response.status).toBe(200)
    return commandResponseSchema(patientBriefJobSchema).parse(await response.json()).data
  }

  async function signIn(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    email = 'admin@demo.clinmesh.local',
  ) {
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

  async function enqueue(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>, cookie: string) {
    const response = await runtime.app.request('/api/sim/v1/scenario-generation-jobs', {
      body: JSON.stringify({
        name: '全模块患者',
        population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
        providerId: 'synthea',
        seeds: { clinical: 7331, population: 4242 },
        timeRange: { end: '2026-08-01', start: '2020-01-01' },
        timeZone: 'Asia/Shanghai',
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
    return commandResponseSchema(scenarioGenerationJobSchema).parse(await response.json()).data
  }

  it('retries an unusable patient and exposes only pre-index R4 history', async () => {
    const provider = new RetryingSyntheaProvider(2)
    const runtime = await createRuntime(provider)
    const cookie = await signIn(runtime)
    const queued = await enqueue(runtime, cookie)

    expect(queued.request).toMatchObject({ moduleMode: 'all', modules: [] })
    const processed = await runtime.scenarioData.processNextGenerationJob()

    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[0]).toMatchObject({ moduleMode: 'all', modules: [] })
    expect(provider.requests[1]?.seeds).not.toEqual(provider.requests[0]?.seeds)
    expect(processed).toMatchObject({
      caseIds: [expect.stringMatching(/^synthetic-case-/)],
      profileIds: [expect.stringMatching(/^synthetic-patient-profile-/)],
      status: 'succeeded',
    })
    const caseId = processed?.caseIds[0] ?? ''
    const profileId = processed?.profileIds[0] ?? ''

    const profileResponse = await runtime.app.request(
      `/api/sim/v1/synthetic-patients/${encodeURIComponent(profileId)}`,
      { headers: { cookie } },
    )
    expect(profileResponse.status).toBe(200)
    const publicProfile = syntheticPatientProfileDetailSchema.parse(await profileResponse.json())
    expect(publicProfile.case?.caseId).toBe(caseId)
    expect(publicProfile.source.translationWarning).toEqual(translationWarning)
    expect(JSON.stringify(publicProfile)).not.toMatch(
      /index-encounter|index-condition|index-observation|hiddenResourceReferences/,
    )

    const caseResponse = await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}`,
      { headers: { cookie } },
    )
    expect(caseResponse.status).toBe(200)
    const publicCase = syntheticCaseInstanceSchema.parse(await caseResponse.json())
    expect(publicCase).toMatchObject({ caseType: 'follow-up', visibleHistoryCount: 2 })
    expect(JSON.stringify(publicCase)).not.toMatch(/index-encounter|index-condition|index-observation/)

    const historyResponse = await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/history?page=1&pageSize=20`,
      { headers: { cookie } },
    )
    expect(historyResponse.status).toBe(200)
    expect(syntheticSourceHistoryListSchema.parse(await historyResponse.json()).items).toEqual([
      expect.objectContaining({ sourceReference: 'urn:uuid:prior-encounter' }),
      expect.objectContaining({ sourceReference: 'urn:uuid:prior-condition' }),
    ])
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const inaccessibleHistory = await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/history?page=1&pageSize=20`,
      { headers: { cookie: doctorCookie } },
    )
    expect(inaccessibleHistory.status).toBe(404)

    const visibleResponse = await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/history/detail?sourceReference=${encodeURIComponent('urn:uuid:prior-condition')}`,
      { headers: { cookie } },
    )
    expect(visibleResponse.status).toBe(200)
    expect(syntheticSourceResourceDetailSchema.parse(await visibleResponse.json())).toMatchObject({
      resource: { resourceType: 'Condition' },
      sourceKind: 'synthea-r4-external',
    })
    for (const hiddenReference of ['urn:uuid:index-condition', 'Condition/index-condition']) {
      const hiddenResponse = await runtime.app.request(
        `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/history/detail?sourceReference=${encodeURIComponent(hiddenReference)}`,
        { headers: { cookie } },
      )
      expect(hiddenResponse.status).toBe(404)
    }
  })

  it('fails after ten unusable attempts without leaving partial Profiles or Cases', async () => {
    const provider = new RetryingSyntheaProvider()
    const runtime = await createRuntime(provider)
    const cookie = await signIn(runtime)
    await enqueue(runtime, cookie)

    const processed = await runtime.scenarioData.processNextGenerationJob()

    expect(provider.requests).toHaveLength(10)
    expect(processed).toMatchObject({
      caseIds: [],
      error: { code: 'INDEX_ENCOUNTER_NOT_FOUND' },
      profileIds: [],
      status: 'failed',
    })
    for (const table of [
      'synthetic_patient_profile',
      'synthetic_case_instance',
      'synthetic_case_truth',
    ]) {
      expect(runtime.database.driver.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
        .toEqual({ count: 0 })
    }
  })

  it('keeps successful Brief revisions immutable and rejects hidden diagnosis leakage', async () => {
    const safeBrief: PatientBriefContent = {
      chiefComplaint: '反复头晕一周',
      knownHistorySummary: '既往有 2 型糖尿病病史。',
      openingStatement: '医生您好，我最近一周经常头晕。',
      symptomTopics: [{
        answerPoints: ['一周前开始。', '起身时更明显。'],
        id: 'dizziness-onset',
        name: '头晕经过',
      }],
    }
    const leakingBrief: PatientBriefContent = {
      ...safeBrief,
      knownHistorySummary: '本次诊断是高血压（疾病）。',
    }
    const secondBrief: PatientBriefContent = {
      ...safeBrief,
      chiefComplaint: '头晕伴乏力一周',
      openingStatement: '医生您好，我头晕之外还有些乏力。',
    }
    const briefProvider = new ControlledBriefProvider([
      safeBrief,
      leakingBrief,
      secondBrief,
      { conclusion: 'C 反应蛋白升高。', interpretation: 'normal', value: 24 },
      { conclusion: 'C 反应蛋白升高。', interpretation: 'high', value: 24 },
    ])
    const runtime = await createRuntime(
      new RetryingSyntheaProvider(1, false),
      briefProvider,
    )
    const cookie = await signIn(runtime)
    await enqueue(runtime, cookie)
    const generation = await runtime.scenarioData.processNextGenerationJob()
    const caseId = generation?.caseIds[0] ?? ''
    expect(generation).toMatchObject({ status: 'succeeded' })
    const registrationCatalog = registrationCatalogSchema.parse(await (await runtime.app.request(
      '/api/his/v1/catalogs/registration',
      { headers: { cookie } },
    )).json())
    const startBody = (expectedCaseRevision: number, activeBriefRevision: number) => ({
      activeBriefRevision,
      departmentId: registrationCatalog.departments[0]!.id,
      expectedCaseRevision,
      locationId: registrationCatalog.locations[0]!.id,
      visitDate: registrationCatalog.virtualDate,
      visitTypeId: registrationCatalog.visitTypes[0]!.id,
    })
    const beforeBriefStart = await runtime.app.request(
      `/api/his/v1/synthetic-cases/${encodeURIComponent(caseId)}/actions/start-outpatient-visit`,
      {
        body: JSON.stringify(startBody(1, 1)),
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(beforeBriefStart.status).toBe(409)
    expect(apiErrorSchema.parse(await beforeBriefStart.json())).toMatchObject({
      error: { code: 'BRIEF_NOT_READY' },
    })

    const firstJob = await enqueueBrief(runtime, cookie, caseId)
    expect(await runtime.patientBrief.processNext()).toMatchObject({
      jobId: firstJob.jobId,
      resultRevision: 1,
      status: 'succeeded',
    })
    const firstRevisionsResponse = await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/patient-brief-revisions`,
      { headers: { cookie } },
    )
    expect(firstRevisionsResponse.status).toBe(200)
    const firstRevisions = patientBriefRevisionListSchema.parse(
      await firstRevisionsResponse.json(),
    )
    expect(firstRevisions).toMatchObject({
      activeRevision: 1,
      items: [{
        content: safeBrief,
        model: 'resolved-fake-brief-model',
        promptVersion: 'patient-brief-v1',
        revision: 1,
      }],
    })
    expect(firstRevisions.items[0]).toMatchObject({
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })

    const leakingJob = await enqueueBrief(runtime, cookie, caseId)
    expect(await runtime.patientBrief.processNext()).toMatchObject({
      error: { code: 'BRIEF_DIAGNOSIS_LEAK' },
      jobId: leakingJob.jobId,
      resultRevision: null,
      status: 'failed',
    })
    const afterLeak = patientBriefRevisionListSchema.parse(await (await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/patient-brief-revisions`,
      { headers: { cookie } },
    )).json())
    expect(afterLeak).toEqual(firstRevisions)

    const secondJob = await enqueueBrief(runtime, cookie, caseId)
    expect(await runtime.patientBrief.processNext()).toMatchObject({
      jobId: secondJob.jobId,
      resultRevision: 2,
      status: 'succeeded',
    })
    const beforeSelection = patientBriefRevisionListSchema.parse(await (await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/patient-brief-revisions`,
      { headers: { cookie } },
    )).json())
    expect(beforeSelection).toMatchObject({
      activeRevision: 1,
      items: [{ revision: 2 }, { revision: 1 }],
    })
    const caseBeforeSelection = syntheticCaseInstanceSchema.parse(await (await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}`,
      { headers: { cookie } },
    )).json())
    const selectResponse = await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/patient-brief-revisions/active`,
      {
        body: JSON.stringify({
          briefRevision: 2,
          expectedCaseRevision: caseBeforeSelection.revision,
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
    expect(selectResponse.status).toBe(200)
    const selectedCase = commandResponseSchema(syntheticCaseInstanceSchema)
      .parse(await selectResponse.json()).data
    expect(selectedCase).toMatchObject({ activeBriefRevision: 2, status: 'brief-ready' })

    const registrarCookie = await signIn(runtime, 'registrar@demo.clinmesh.local')
    const startIdempotencyKey = randomUUID()
    const startCase = () => runtime.app.request(
      `/api/his/v1/synthetic-cases/${encodeURIComponent(caseId)}/actions/start-outpatient-visit`,
      {
        body: JSON.stringify(startBody(selectedCase.revision, 2)),
        headers: {
          'content-type': 'application/json',
          cookie: registrarCookie,
          'idempotency-key': startIdempotencyKey,
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    const startedResponse = await startCase()
    expect(startedResponse.status).toBe(200)
    const startedCommand = commandResponseSchema(startSyntheticCaseResultSchema)
      .parse(await startedResponse.json())
    expect(startedCommand.data).toMatchObject({
      status: 'awaiting-triage',
      syntheticCaseId: caseId,
    })
    const replayedStart = await startCase()
    expect(replayedStart.status).toBe(200)
    expect(commandResponseSchema(startSyntheticCaseResultSchema).parse(await replayedStart.json()))
      .toEqual(startedCommand)
    const duplicateStart = await runtime.app.request(
      `/api/his/v1/synthetic-cases/${encodeURIComponent(caseId)}/actions/start-outpatient-visit`,
      {
        body: JSON.stringify(startBody(selectedCase.revision, 2)),
        headers: {
          'content-type': 'application/json',
          cookie: registrarCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(duplicateStart.status).toBe(409)

    for (const resourceType of ['Condition', 'Observation'] as const) {
      const response = await runtime.app.request(
        `/fhir/R5/${resourceType}?patient=${encodeURIComponent(`Patient/${startedCommand.data.patientId}`)}`,
        { headers: { cookie } },
      )
      expect(response.status).toBe(200)
      expect(fhirBundleSchema.parse(await response.json()).entry ?? []).toEqual([])
    }
    expect(runtime.database.driver.prepare(`
      SELECT case_id, brief_revision, patient_id, encounter_id
      FROM synthetic_case_materialization
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get('workspace-demo', 'epoch-1', caseId)).toMatchObject({
      brief_revision: 2,
      case_id: caseId,
      encounter_id: startedCommand.data.encounterId,
      patient_id: startedCommand.data.patientId,
    })
    const materializedHistory = await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/history?page=1&pageSize=20`,
      { headers: { cookie: registrarCookie } },
    )
    expect(materializedHistory.status).toBe(200)

    const triageCookie = await signIn(runtime, 'triage@demo.clinmesh.local')
    const triageResponse = await runtime.app.request(
      `/api/his/v1/encounters/${startedCommand.data.encounterId}/actions/record-triage`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${startedCommand.data.encounterId}`]: '1',
            [`Task/${startedCommand.data.queueTaskId}`]: '1',
          },
          input: {
            acuityCode: 'level-3',
            bloodPressure: { diastolicMmHg: 96, systolicMmHg: 162 },
            chiefComplaint: safeBrief.chiefComplaint,
            oxygenSaturationPct: 98,
            pulseBpm: 86,
            respirationBpm: 18,
            temperatureC: 36.7,
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
    const triage = triageResponseSchema.parse(await triageResponse.json()).data
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const doctorQueue = doctorQueueSchema.parse(await (await runtime.app.request(
      '/api/his/v1/doctor/queue?page=1&pageSize=20',
      { headers: { cookie: doctorCookie } },
    )).json())
    expect(doctorQueue.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ encounterId: startedCommand.data.encounterId }),
    ]))

    const startVisit = await runtime.app.request(
      `/api/his/v1/encounters/${startedCommand.data.encounterId}/actions/start-first-visit`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${startedCommand.data.encounterId}`]: '2',
            [`Task/${triage.doctorTaskId}`]: '1',
          },
          input: {},
        }),
        headers: {
          'content-type': 'application/json',
          cookie: doctorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(startVisit.status).toBe(200)
    startVisitResponseSchema.parse(await startVisit.json())
    const encounterReference = `Encounter/${startedCommand.data.encounterId}`
    const commandHeaders = () => ({
      'content-type': 'application/json',
      cookie: doctorCookie,
      'idempotency-key': randomUUID(),
      origin: 'http://localhost',
    })
    const exactConcept = {
      code: '8480-6',
      display: '收缩压',
      id: 'laboratory:synthetic-systolic-pressure',
      laboratory: {
        category: 'vital-sign',
        referenceRange: { high: 140, low: 90, text: '90-140 mmHg' },
        resultType: 'quantity',
        specimen: 'body',
        unit: {
          code: 'mm[Hg]',
          display: 'mmHg',
          system: 'http://unitsofmeasure.org',
        },
      },
      sourceLocator: 'synthetic:test:systolic-pressure',
      system: 'http://loinc.org',
      version: '2.83',
    } as const
    const agentConcept = {
      code: '1988-5',
      display: 'C 反应蛋白',
      id: 'laboratory:synthetic-crp',
      laboratory: {
        category: 'chemistry',
        referenceRange: { high: 10, low: 0, text: '0-10 mg/L' },
        resultType: 'quantity',
        specimen: 'blood',
        unit: {
          code: 'mg/L',
          display: 'mg/L',
          system: 'http://unitsofmeasure.org',
        },
      },
      sourceLocator: 'synthetic:test:crp',
      system: 'http://loinc.org',
      version: '2.83',
    } as const
    const profiledAgentConcept = {
      code: '8310-5',
      display: '体温',
      id: 'laboratory:synthetic-body-temperature',
      laboratory: {
        category: 'vital-sign',
        resultType: 'quantity',
        specimen: 'body',
        unit: {
          code: 'Cel',
          display: 'Cel',
          system: 'http://unitsofmeasure.org',
        },
      },
      sourceLocator: 'synthetic:test:body-temperature',
      system: 'http://loinc.org',
      version: '2.83',
    } as const
    const unsupportedAgentConcept = {
      code: '785-6',
      display: '平均红细胞血红蛋白量',
      id: 'laboratory:synthetic-mean-corpuscular-hemoglobin',
      laboratory: {
        category: 'hematology',
        resultType: 'quantity',
        specimen: 'blood',
        unit: {
          code: 'pg',
          display: 'pg',
          system: 'http://unitsofmeasure.org',
        },
      },
      sourceLocator: 'synthetic:test:mean-corpuscular-hemoglobin',
      system: 'http://loinc.org',
      version: '2.83',
    } as const
    expect(runtime.investigation.generationCapabilityForCase(
      'workspace-demo',
      'epoch-1',
      startedCommand.data.outpatientCaseId,
      exactConcept,
    )).toEqual({ source: 'synthea-exact', supported: true })
    expect(runtime.investigation.generationCapabilityForCase(
      'workspace-demo',
      'epoch-1',
      startedCommand.data.outpatientCaseId,
      agentConcept,
    )).toEqual({ source: 'investigation-agent', supported: true })
    expect(runtime.investigation.generationCapabilityForCase(
      'workspace-demo',
      'epoch-1',
      startedCommand.data.outpatientCaseId,
      profiledAgentConcept,
    )).toEqual({ source: 'investigation-agent', supported: true })
    expect(runtime.investigation.generationCapabilityForCase(
      'workspace-demo',
      'epoch-1',
      startedCommand.data.outpatientCaseId,
      unsupportedAgentConcept,
    )).toEqual({ reason: 'metadata-incomplete', supported: false })
    const updateLaboratoryCatalog = runtime.database.driver.prepare(`
      UPDATE outpatient_catalog SET config_json = ?
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND kind = 'laboratory' AND item_id = ?
    `)
    updateLaboratoryCatalog.run(JSON.stringify({
      allowedIndicationCodes: ['clinical-evaluation'],
      contraindicatedAllergyCodes: [],
      referenceConcept: exactConcept,
    }), 'lab-cbc')
    updateLaboratoryCatalog.run(JSON.stringify({
      allowedIndicationCodes: ['clinical-evaluation'],
      contraindicatedAllergyCodes: [],
      referenceConcept: agentConcept,
    }), 'lab-crp')
    updateLaboratoryCatalog.run(JSON.stringify({
      allowedIndicationCodes: ['clinical-evaluation'],
      contraindicatedAllergyCodes: [],
      referenceConcept: unsupportedAgentConcept,
    }), 'lab-fever-panel')
    const saveLaboratoryDraft = async (catalogItemId: string, expectedDraftVersion: number) => {
      const response = await runtime.app.request(
        `/api/his/v1/encounters/${startedCommand.data.encounterId}/laboratory-request/draft`,
        {
          body: JSON.stringify({
            expectedVersions: { [encounterReference]: '3' },
            input: {
              catalogItemId,
              expectedDraftVersion,
              indicationCode: 'clinical-evaluation',
            },
          }),
          headers: commandHeaders(),
          method: 'PUT',
        },
      )
      expect(response.status).toBe(200)
      return laboratoryRequestDraftResponseSchema.parse(await response.json()).data
    }
    const issueLaboratory = async (expectedDraftVersion: number) => {
      const response = await runtime.app.request(
        `/api/his/v1/encounters/${startedCommand.data.encounterId}/laboratory-request/actions/issue`,
        {
          body: JSON.stringify({
            expectedVersions: { [encounterReference]: '3' },
            input: { expectedDraftVersion },
          }),
          headers: commandHeaders(),
          method: 'POST',
        },
      )
      expect(response.status).toBe(200)
      return issueLaboratoryRequestResponseSchema.parse(await response.json()).data
    }

    const exactDraft = await saveLaboratoryDraft('lab-cbc', 0)
    const exactRequest = (await issueLaboratory(exactDraft.draftVersion)).request
    await runtime.dispatchPending()
    let detail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${startedCommand.data.outpatientCaseId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    const exactReported = detail.laboratoryRequests?.requests.find(item => (
      item.id === exactRequest.id
    ))
    expect(exactReported).toMatchObject({
      report: {
        results: [{ code: '8480-6', interpretation: 'high', value: 162 }],
      },
      status: 'reported',
    })
    expect(briefProvider.requests).toHaveLength(3)
    expect(runtime.database.driver.prepare(`
      SELECT source FROM investigation_result_snapshot
      WHERE workspace_id = ? AND case_id = ? AND catalog_item_id = 'lab-cbc'
    `).get('workspace-demo', caseId)).toEqual({ source: 'synthea-exact' })

    const insertVisibleResource = runtime.database.driver.prepare(`
      INSERT INTO synthetic_case_visible_resource (
        workspace_id, case_id, source_reference, resource_type, resource_json
      ) VALUES (?, ?, ?, 'Procedure', ?)
    `)
    const insertVisibleHistory = runtime.database.driver.prepare(`
      INSERT INTO synthetic_case_visible_history (
        workspace_id, case_id, sequence, source_reference,
        resource_type, clinical_date, title
      ) VALUES (?, ?, ?, ?, 'Procedure', ?, ?)
    `)
    for (let index = 0; index < 30; index += 1) {
      const sourceReference = `urn:uuid:agent-context-${index}`
      insertVisibleResource.run(
        'workspace-demo',
        caseId,
        sourceReference,
        JSON.stringify({ id: `agent-context-${index}`, resourceType: 'Procedure', status: 'completed' }),
      )
      insertVisibleHistory.run(
        'workspace-demo',
        caseId,
        100 + index,
        sourceReference,
        `2025-01-${String(index + 1).padStart(2, '0')}T09:00:00+08:00`,
        `既往处置 ${index + 1}`,
      )
    }

    const agentDraft = await saveLaboratoryDraft('lab-crp', 2)
    const agentRequest = (await issueLaboratory(agentDraft.draftVersion)).request
    await runtime.dispatchPending()
    detail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${startedCommand.data.outpatientCaseId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    const failedRequest = detail.laboratoryRequests?.requests.find(item => (
      item.id === agentRequest.id
    ))
    expect(failedRequest).toMatchObject({
      generationError: { code: 'INVESTIGATION_OUTPUT_INVALID' },
      status: 'generation-failed',
    })
    expect(failedRequest?.report).toBeUndefined()
    expect(runtime.database.driver.prepare(`
      SELECT COUNT(*) AS count FROM investigation_result_snapshot
      WHERE workspace_id = ? AND case_id = ? AND catalog_item_id = 'lab-crp'
    `).get('workspace-demo', caseId)).toEqual({ count: 0 })
    expect(briefProvider.requests).toHaveLength(4)
    const firstAgentPayload = briefProvider.requests.at(-1)?.userPayload as {
      privateCaseEvidence: unknown[]
      visibleHistory: unknown[]
    }
    expect(firstAgentPayload.privateCaseEvidence.length).toBeLessThanOrEqual(20)
    expect(firstAgentPayload.visibleHistory.length).toBeLessThanOrEqual(20)

    runtime.database.driver.prepare(`
      UPDATE laboratory_request SET reference_json = ?
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
    `).run(
      JSON.stringify(unsupportedAgentConcept),
      'workspace-demo',
      'epoch-1',
      agentRequest.id,
    )
    const unsupportedRetryResponse = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${agentRequest.id}/actions/retry-generation`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Task/${agentRequest.taskId}`]: '4' },
          input: { expectedRequestVersion: 4 },
        }),
        headers: commandHeaders(),
        method: 'POST',
      },
    )
    expect(unsupportedRetryResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await unsupportedRetryResponse.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT' },
    })
    runtime.database.driver.prepare(`
      UPDATE laboratory_request SET reference_json = ?
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
    `).run(
      JSON.stringify(agentConcept),
      'workspace-demo',
      'epoch-1',
      agentRequest.id,
    )
    const cancelFailedResponse = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${agentRequest.id}/actions/cancel`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`ServiceRequest/${agentRequest.serviceRequestId}`]: failedRequest?.serviceRequestVersion,
            [`Task/${agentRequest.taskId}`]: failedRequest?.taskVersion,
          },
          input: {
            expectedRequestVersion: failedRequest?.version,
            reasonCode: 'no-longer-needed',
          },
        }),
        headers: commandHeaders(),
        method: 'POST',
      },
    )
    expect(cancelFailedResponse.status).toBe(200)
    expect(laboratoryRequestActionResponseSchema.parse(
      await cancelFailedResponse.json(),
    ).data.request).toMatchObject({ status: 'cancelled' })

    const secondAgentDraft = await saveLaboratoryDraft('lab-crp', 4)
    const secondAgentRequest = (await issueLaboratory(secondAgentDraft.draftVersion)).request
    await runtime.dispatchPending()
    detail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${startedCommand.data.outpatientCaseId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    const agentReported = detail.laboratoryRequests?.requests.find(item => (
      item.id === secondAgentRequest.id
    ))
    expect(agentReported).toMatchObject({
      report: {
        results: [{ code: '1988-5', interpretation: 'high', value: 24 }],
      },
      status: 'reported',
    })
    const agentDiagnosticReportResponse = await runtime.app.request(
      `/fhir/R5/DiagnosticReport/${encodeURIComponent(agentReported!.report!.diagnosticReportId)}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(agentDiagnosticReportResponse.status).toBe(200)
    expect(fhirResourceSchema.parse(await agentDiagnosticReportResponse.json())).toMatchObject({
      code: {
        coding: [{ code: '1988-5', display: 'C 反应蛋白', system: 'http://loinc.org', version: '2.83' }],
      },
      resourceType: 'DiagnosticReport',
    })
    expect(briefProvider.requests).toHaveLength(5)
    expect(runtime.database.driver.prepare(`
      SELECT source, model_id FROM investigation_result_snapshot
      WHERE workspace_id = ? AND case_id = ? AND catalog_item_id = 'lab-crp'
    `).get('workspace-demo', caseId)).toEqual({
      model_id: 'resolved-fake-brief-model',
      source: 'investigation-agent',
    })
    await expect(runtime.investigation.resolveForRequest(
      'workspace-demo',
      'epoch-1',
      secondAgentRequest.id,
    )).resolves.toMatchObject({ source: 'investigation-agent' })
    expect(briefProvider.requests).toHaveLength(5)

    const unsupportedDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${startedCommand.data.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: '3' },
          input: {
            catalogItemId: 'lab-fever-panel',
            expectedDraftVersion: 6,
            indicationCode: 'clinical-evaluation',
          },
        }),
        headers: commandHeaders(),
        method: 'PUT',
      },
    )
    expect(unsupportedDraftResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await unsupportedDraftResponse.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT' },
    })
    expect(briefProvider.requests).toHaveLength(5)

    const snapshotBeforeReset = runtime.database.driver.prepare(`
      SELECT * FROM investigation_result_snapshot
      WHERE workspace_id = ? AND case_id = ? AND catalog_item_id = 'lab-crp'
    `).get('workspace-demo', caseId)
    const resetResponse = await runtime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      {
        body: '{}',
        headers: {
          'content-type': 'application/json',
          cookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(resetResponse.status).toBe(200)
    expect(scenarioCommandResponseSchema.parse(await resetResponse.json()).data).toMatchObject({
      epoch: 'epoch-2',
      scenarioRunId: 'scenario-run-2',
    })
    const materializations = runtime.database.driver.prepare(`
      SELECT epoch, case_revision, brief_revision, patient_id, outpatient_case_id,
        registration_id, encounter_id, queue_task_id
      FROM synthetic_case_materialization
      WHERE workspace_id = ? AND case_id = ?
      ORDER BY epoch
    `).all('workspace-demo', caseId) as Array<{
      brief_revision: number
      case_revision: number
      encounter_id: string
      epoch: string
      outpatient_case_id: string
      patient_id: string
      queue_task_id: string
      registration_id: string
    }>
    expect(materializations).toHaveLength(2)
    expect(materializations.map(item => ({
      briefRevision: item.brief_revision,
      caseRevision: item.case_revision,
      epoch: item.epoch,
    }))).toEqual([
      { briefRevision: 2, caseRevision: selectedCase.revision, epoch: 'epoch-1' },
      { briefRevision: 2, caseRevision: selectedCase.revision, epoch: 'epoch-2' },
    ])
    const replayed = materializations[1]!
    expect(replayed.patient_id).not.toBe(startedCommand.data.patientId)
    expect(replayed.encounter_id).not.toBe(startedCommand.data.encounterId)
    expect(runtime.database.driver.prepare(`
      SELECT * FROM investigation_result_snapshot
      WHERE workspace_id = ? AND case_id = ? AND catalog_item_id = 'lab-crp'
    `).get('workspace-demo', caseId)).toEqual(snapshotBeforeReset)
    expect(briefProvider.requests).toHaveLength(5)

    const replayTriageResponse = await runtime.app.request(
      `/api/his/v1/encounters/${replayed.encounter_id}/actions/record-triage`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${replayed.encounter_id}`]: '1',
            [`Task/${replayed.queue_task_id}`]: '1',
          },
          input: {
            acuityCode: 'level-3',
            bloodPressure: { diastolicMmHg: 96, systolicMmHg: 162 },
            chiefComplaint: safeBrief.chiefComplaint,
            oxygenSaturationPct: 98,
            pulseBpm: 86,
            respirationBpm: 18,
            temperatureC: 36.7,
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
    expect(replayTriageResponse.status).toBe(200)
    const replayTriage = triageResponseSchema.parse(await replayTriageResponse.json()).data
    const replayStartResponse = await runtime.app.request(
      `/api/his/v1/encounters/${replayed.encounter_id}/actions/start-first-visit`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${replayed.encounter_id}`]: '2',
            [`Task/${replayTriage.doctorTaskId}`]: '1',
          },
          input: {},
        }),
        headers: {
          'content-type': 'application/json',
          cookie: doctorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(replayStartResponse.status).toBe(200)
    startVisitResponseSchema.parse(await replayStartResponse.json())
    runtime.database.driver.prepare(`
      UPDATE outpatient_catalog SET config_json = ?
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-2'
        AND kind = 'laboratory' AND item_id = 'lab-crp'
    `).run(JSON.stringify({
      allowedIndicationCodes: ['clinical-evaluation'],
      contraindicatedAllergyCodes: [],
      referenceConcept: agentConcept,
    }))
    const replayEncounterReference = `Encounter/${replayed.encounter_id}`
    const replayDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${replayed.encounter_id}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [replayEncounterReference]: '3' },
          input: {
            catalogItemId: 'lab-crp',
            expectedDraftVersion: 0,
            indicationCode: 'clinical-evaluation',
          },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: doctorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'PUT',
      },
    )
    expect(replayDraftResponse.status).toBe(200)
    const replayDraft = laboratoryRequestDraftResponseSchema.parse(
      await replayDraftResponse.json(),
    ).data
    const replayIssueResponse = await runtime.app.request(
      `/api/his/v1/encounters/${replayed.encounter_id}/laboratory-request/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [replayEncounterReference]: '3' },
          input: { expectedDraftVersion: replayDraft.draftVersion },
        }),
        headers: {
          'content-type': 'application/json',
          cookie: doctorCookie,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(replayIssueResponse.status).toBe(200)
    const replayRequest = issueLaboratoryRequestResponseSchema.parse(
      await replayIssueResponse.json(),
    ).data.request
    await runtime.dispatchPending()
    const replayDetail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${replayed.outpatient_case_id}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    expect(replayDetail.laboratoryRequests?.requests.find(item => (
      item.id === replayRequest.id
    ))).toMatchObject({
      report: { results: [{ code: '1988-5', interpretation: 'high', value: 24 }] },
      status: 'reported',
    })
    expect(briefProvider.requests).toHaveLength(5)

    const publicArtifacts = JSON.stringify({ beforeSelection, firstJob, leakingJob, secondJob })
    expect(publicArtifacts).not.toMatch(/privateEpisodeEvidence|index-condition|hiddenResourceReferences/)
  })

  it('requeues an interrupted Patient Brief job after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-patient-brief-recovery-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    const provider = new RetryingSyntheaProvider(1, false)
    const briefProvider = new ControlledBriefProvider([])
    const first = await createRuntime(provider, briefProvider, { databasePath })
    const cookie = await signIn(first)
    await enqueue(first, cookie)
    const generation = await first.scenarioData.processNextGenerationJob()
    const caseId = generation?.caseIds[0] ?? ''
    const job = await enqueueBrief(first, cookie, caseId)
    first.database.driver.prepare(`
      UPDATE patient_brief_job
      SET status = 'running', started_at = updated_at
      WHERE workspace_id = ? AND job_id = ?
    `).run(job.workspaceId, job.jobId)
    await first.close()
    runtimes.splice(runtimes.indexOf(first), 1)

    const restarted = await createRuntime(provider, briefProvider, {
      databasePath,
      migrationMode: 'verify',
    })
    const restartedCookie = await signIn(restarted)
    const recovered = patientBriefJobSchema.parse(await (await restarted.app.request(
      `/api/sim/v1/patient-brief-jobs/${encodeURIComponent(job.jobId)}`,
      { headers: { cookie: restartedCookie } },
    )).json())
    expect(recovered).toMatchObject({ startedAt: null, status: 'queued' })
    expect(restarted.database.driver.prepare(`
      SELECT COUNT(*) AS count FROM patient_brief_revision WHERE case_id = ?
    `).get(caseId)).toEqual({ count: 0 })
  })
})
