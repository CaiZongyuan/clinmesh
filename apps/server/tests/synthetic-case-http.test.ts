import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  patientBriefJobSchema,
  patientBriefRevisionListSchema,
  scenarioGenerationJobSchema,
  syntheticCaseInstanceSchema,
  syntheticPatientProfileDetailSchema,
  syntheticSourceHistoryListSchema,
  syntheticSourceResourceDetailSchema,
  type ScenarioGenerationRequest,
  type ScenarioProviderCapabilities,
  type PatientBriefContent,
} from '@clinmesh/contracts/scenario'
import { commandResponseSchema } from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import type {
  ScenarioGenerationProvider,
  SourcePatientCorpus,
} from '../src/application/scenario-data/provider.ts'
import { compileSyntheaR4Bundle } from '../src/application/scenario-data/synthea-case-truth-compiler.ts'
import { BuiltInScenarioGenerationProvider } from '../src/infrastructure/scenario-generation/builtin-provider.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import type {
  JsonChatCompletionInput,
  JsonChatCompletionsProvider,
} from '../src/infrastructure/ai/openai-chat-completions.ts'

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
  const compatibilityRequest: ScenarioGenerationRequest = {
    ...request,
    moduleMode: 'filter',
    modules: ['hypertension'],
  }
  const base = await new BuiltInScenarioGenerationProvider().generate(compatibilityRequest)
  const bundle = patientBundle(qualified, followUp)
  const patient = compileSyntheaR4Bundle({ bundle, ordinal: 0, request: compatibilityRequest })
  return {
    content: {
      ...base.content,
      hiddenFacts: [],
      patients: [patient],
      revealPolicies: [],
    },
    kind: 'case-truth',
    sources: [{
      format: 'fhir-r4-bundle',
      hash: canonicalJsonHash(bundle),
      patientId: patient.id,
      raw: bundle,
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
  readonly #outputs: PatientBriefContent[]

  constructor(outputs: PatientBriefContent[]) {
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
        : { chatCompletionsProvider: briefProvider, patientBriefModel: 'fake-brief-model' }),
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

  async function signIn(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>) {
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
    expect(commandResponseSchema(syntheticCaseInstanceSchema).parse(await selectResponse.json()).data)
      .toMatchObject({ activeBriefRevision: 2, status: 'brief-ready' })

    expect(briefProvider.requests).toHaveLength(3)
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
