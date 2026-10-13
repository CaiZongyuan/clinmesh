import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { doctorRecommendationStateSchema, generateDoctorRecommendationsResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-recommendations-'))
  disposals.push(() => rm(directory, { recursive: true, force: true }))
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    databasePath: join(directory, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply', outboxRetryDelayMs: 0,
    consultationModel: 'synthetic', patientPersonaModel: 'synthetic', investigationModel: 'synthetic',
    chatCompletionsProvider: {
      async completeJson(input) {
        if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
        throw new Error('This read must not generate suggestions')
      },
    },
    syntheaProvider: new StubSyntheaProvider(), trustedOrigins: ['http://localhost'],
  })
  disposals.push(() => runtime.close())
  const started = await startConsultationCase(runtime)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const claimed = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: {
      [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
    }, input: {} }),
  })
  expect(claimed.status).toBe(200)
  return { runtime, started, cookie }
}

it('reads a responsible doctor’s recommendation state without generating or changing clinical drafts', async () => {
  const { runtime, started, cookie } = await setup()
  const readCase = async () => (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json()
  const before = await readCase()
  const response = await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/laboratory`, { headers: { cookie } },
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    caseId: started.outpatientCaseId, kind: 'laboratory', status: 'idle', generation: 0, items: [], stale: false,
  })
  expect(await readCase()).toEqual(before)
})

it('queues generation through an idempotent command while preserving every clinical draft', async () => {
  const { runtime, started, cookie } = await setup()
  const path = `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/laboratory`
  const read = async () => doctorRecommendationStateSchema.parse(await (await runtime.app.request(path, { headers: { cookie } })).json())
  const state = await read()
  const key = randomUUID()
  const request = () => runtime.app.request(`${path}/actions/generate`, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${state.encounterId}`]: state.encounterVersion },
      input: { expectedInputFingerprint: state.inputFingerprint, refresh: false } }),
  })
  const before = await (await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } })).json()
  const response = await request()
  expect(response.status).toBe(200)
  const queued = generateDoctorRecommendationsResponseSchema.parse(await response.json())
  expect(queued.data).toMatchObject({ status: 'pending', generation: 1, items: [] })
  const replay = generateDoctorRecommendationsResponseSchema.parse(await (await request()).json())
  expect(replay.auditId).toBe(queued.auditId)
  expect(await read()).toMatchObject({ status: 'pending', generation: 1 })
  expect(await (await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } })).json()).toEqual(before)
})
