import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import {
  apiErrorSchema,
  createPatientResponseSchema,
  patientSearchSchema,
  registrationQueueSchema,
  registrationResponseSchema,
  scenarioCommandResponseSchema,
} from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { registrationCountersHash } from '../src/infrastructure/sqlite/registration-numbering.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>
const password = 'Synthetic-Demo-Password-2026!'
const runtimes: Runtime[] = []
const directories: string[] = []

function headers(cookie: string, key = randomUUID()) {
  return { 'content-type': 'application/json', cookie, 'idempotency-key': key, origin: 'http://localhost' }
}

async function openRuntime(databasePath?: string) {
  if (databasePath === undefined) {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-registration-'))
    directories.push(directory)
    databasePath = join(directory, 'clinmesh.sqlite')
  }
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost',
    authSecret: 'registration-numbering-auth-secret-at-least-32-chars',
    cursorSecret: 'registration-numbering-cursor-secret-at-least-32-chars',
    databasePath,
    demoPassword: password,
    migrationMode: 'apply',
    syntheaProvider: new StubSyntheaProvider(),
    patientPersonaModel: 'synthetic-persona',
    chatCompletionsProvider: { completeJson: async () => ({ content: JSON.stringify(persona), model: 'synthetic-persona' }) },
    trustedOrigins: ['http://localhost'],
  })
  runtimes.push(runtime)
  const cookie = await signIn(runtime, 'registrar@demo.clinmesh.local', password)
  return { runtime, cookie, databasePath }
}

async function createPatient(runtime: Runtime, cookie: string) {
  const response = await runtime.app.request('/api/his/v1/patients', {
    body: JSON.stringify({ expectedVersions: {}, input: {
      birthDate: '1990-05-10', gender: 'male', identifier: `SYN-${randomUUID()}`, name: '合成患者周明',
    } }),
    headers: headers(cookie), method: 'POST',
  })
  expect(response.status).toBe(200)
  return createPatientResponseSchema.parse(await response.json()).data.patient
}

function register(runtime: Runtime, cookie: string, patientId: string, key = randomUUID(), visitDate = '2026-08-24') {
  return runtime.app.request('/api/his/v1/registrations/actions/register', {
    body: JSON.stringify({
      expectedVersions: { [`Patient/${patientId}`]: '1' },
      input: { departmentId: 'department-general-medicine', locationId: 'location-outpatient', patientId,
        visitDate, visitTypeId: 'visit-general' },
    }), headers: headers(cookie, key), method: 'POST',
  })
}

async function registrationNumbers(runtime: Runtime, cookie: string) {
  const response = await runtime.app.request('/api/his/v1/registrations?pageSize=100', { headers: { cookie } })
  expect(response.status).toBe(200)
  return registrationQueueSchema.parse(await response.json()).items.map(item => item.registrationNumber)
}

function setHighWater(runtime: Runtime, highWater: number) {
  runtime.database.driver.prepare('INSERT INTO registration_number_counter (visit_date, high_water) VALUES (?, ?) ON CONFLICT (visit_date) DO UPDATE SET high_water = excluded.high_water')
    .run('2026-08-24', highWater)
  runtime.database.driver.prepare('UPDATE registration_number_authority SET counters_hash = ? WHERE singleton = 1')
    .run(registrationCountersHash([{ visitDate: '2026-08-24', highWater }]))
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('durable registration numbers through HIS HTTP', () => {
  it('issues a dated six-digit number atomically with Encounter and replays the same receipt', async () => {
    const { runtime, cookie } = await openRuntime()
    const patient = await createPatient(runtime, cookie)
    const key = randomUUID()
    const response = await register(runtime, cookie, patient.id, key)
    expect(response.status).toBe(200)
    const result = registrationResponseSchema.parse(await response.json())
    expect(await registrationNumbers(runtime, cookie)).toEqual(['CM-OP-20260824-000001'])
    const encounter = await runtime.app.request(`/fhir/R5/Encounter/${result.data.encounterId}`, { headers: { cookie } })
    expect(await encounter.json()).toMatchObject({ identifier: [{ value: 'CM-OP-20260824-000001' }] })
    expect(registrationResponseSchema.parse(await (await register(runtime, cookie, patient.id, key)).json())).toEqual(result)
    expect(await registrationNumbers(runtime, cookie)).toEqual(['CM-OP-20260824-000001'])
  })

  it('never reuses deleted middle, highest or all registration rows, including after reopening', async () => {
    const first = await openRuntime()
    for (let index = 0; index < 3; index += 1) {
      const patient = await createPatient(first.runtime, first.cookie)
      expect((await register(first.runtime, first.cookie, patient.id)).status).toBe(200)
    }
    first.runtime.database.driver.exec("DELETE FROM registration WHERE registration_number IN ('CM-OP-20260824-000002', 'CM-OP-20260824-000003')")
    const fourth = await createPatient(first.runtime, first.cookie)
    expect((await register(first.runtime, first.cookie, fourth.id)).status).toBe(200)
    expect(await registrationNumbers(first.runtime, first.cookie)).toContain('CM-OP-20260824-000004')
    first.runtime.database.driver.exec('DELETE FROM registration')
    await first.runtime.close()
    runtimes.splice(runtimes.indexOf(first.runtime), 1)
    const second = await openRuntime(first.databasePath)
    const fifth = await createPatient(second.runtime, second.cookie)
    expect((await register(second.runtime, second.cookie, fifth.id)).status).toBe(200)
    expect(await registrationNumbers(second.runtime, second.cookie)).toEqual(['CM-OP-20260824-000005'])
  })

  it('uses each business date and continues its high water when Virtual Time moves back', async () => {
    const { runtime, cookie } = await openRuntime()
    const first = await createPatient(runtime, cookie)
    expect((await register(runtime, cookie, first.id)).status).toBe(200)
    runtime.database.driver.exec("UPDATE scenario_epoch_state SET virtual_time = '2026-08-25T09:00:00+08:00'")
    const nextDay = await createPatient(runtime, cookie)
    expect((await register(runtime, cookie, nextDay.id, randomUUID(), '2026-08-25')).status).toBe(200)
    runtime.database.driver.exec("UPDATE scenario_epoch_state SET virtual_time = '2026-08-24T09:00:00+08:00'")
    const previousDay = await createPatient(runtime, cookie)
    expect((await register(runtime, cookie, previousDay.id)).status).toBe(200)
    expect((await registrationNumbers(runtime, cookie)).toSorted()).toEqual([
      'CM-OP-20260824-000001', 'CM-OP-20260824-000002', 'CM-OP-20260825-000001',
    ])
  })

  it('grows beyond six digits and stops at the safe integer limit without wrapping', async () => {
    const { runtime, cookie } = await openRuntime()
    setHighWater(runtime, 999998)
    for (let index = 0; index < 2; index += 1) {
      const patient = await createPatient(runtime, cookie)
      expect((await register(runtime, cookie, patient.id)).status).toBe(200)
    }
    expect(await registrationNumbers(runtime, cookie)).toEqual(expect.arrayContaining(['CM-OP-20260824-999999', 'CM-OP-20260824-1000000']))
    setHighWater(runtime, Number.MAX_SAFE_INTEGER - 1)
    const last = await createPatient(runtime, cookie)
    expect((await register(runtime, cookie, last.id)).status).toBe(200)
    expect(await registrationNumbers(runtime, cookie)).toContain('CM-OP-20260824-9007199254740991')
    const exhausted = await createPatient(runtime, cookie)
    const response = await register(runtime, cookie, exhausted.id)
    expect(response.status).toBe(409)
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('REGISTRATION_NUMBER_EXHAUSTED')
    expect(await registrationNumbers(runtime, cookie)).toHaveLength(3)
  })

  it.each([
    'DELETE FROM registration_number_counter',
    'UPDATE registration_number_counter SET high_water = 0',
    'DELETE FROM registration_number_authority',
    'DROP TABLE registration_number_counter',
  ])('fails closed after issuance state corruption: %s', async (damage) => {
    const { runtime, cookie } = await openRuntime()
    const first = await createPatient(runtime, cookie)
    expect((await register(runtime, cookie, first.id)).status).toBe(200)
    runtime.database.driver.exec(damage)
    const second = await createPatient(runtime, cookie)
    const response = await register(runtime, cookie, second.id)
    expect(response.status).toBe(409)
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('REGISTRATION_NUMBER_STATE_INVALID')
    expect(await registrationNumbers(runtime, cookie)).toEqual(['CM-OP-20260824-000001'])
  })

  it('rolls back the number, Encounter and receipt when a later registration write fails', async () => {
    const { runtime, cookie } = await openRuntime()
    const patient = await createPatient(runtime, cookie)
    const key = randomUUID()
    const encounterIds = async () => {
      const response = await runtime.app.request('/fhir/R5/Encounter?_count=100', { headers: { cookie } })
      expect(response.status).toBe(200)
      return fhirBundleSchema.parse(await response.json()).entry?.map(entry => entry.resource?.id)
    }
    const before = await encounterIds()
    runtime.database.driver.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON registration BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
    expect((await register(runtime, cookie, patient.id, key)).status).toBe(500)
    expect(await registrationNumbers(runtime, cookie)).toEqual([])
    expect(await encounterIds()).toEqual(before)
    runtime.database.driver.exec('DROP TRIGGER fail_registration')
    expect((await register(runtime, cookie, patient.id, key)).status).toBe(200)
    expect(await registrationNumbers(runtime, cookie)).toEqual(['CM-OP-20260824-000001'])
  })

  it('shares issuance across ordinary and Synthetic Case paths, reset and repeated patients', async () => {
    const { runtime, cookie } = await openRuntime()
    const patient = await createPatient(runtime, cookie)
    expect((await register(runtime, cookie, patient.id)).status).toBe(200)
    const started = await startConsultationCase(runtime, password)
    expect(await registrationNumbers(runtime, cookie)).toEqual(expect.arrayContaining(['CM-OP-20260824-000001', 'CM-OP-20260824-000002']))
    const admin = started.adminCookie
    const reset = await runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', {
      body: '{}', headers: headers(admin), method: 'POST',
    })
    expect(reset.status).toBe(200)
    const state = scenarioCommandResponseSchema.parse(await reset.json()).data
    expect(state.epoch).not.toBe('epoch-1')
    // Reset replays the Synthetic Case with the same patient identity and a new visit number.
    expect(await registrationNumbers(runtime, cookie)).toEqual(['CM-OP-20260824-000003'])
    expect((await runtime.app.request(`/fhir/R5/Encounter/${started.encounterId}`, { headers: { cookie } })).status).toBe(404)
    const oldNumber = await runtime.app.request('/api/his/v1/patients?query=CM-OP-20260824-000002', { headers: { cookie } })
    expect(patientSearchSchema.parse(await oldNumber.json())).toMatchObject({ items: [], total: 0 })
    const nextPatient = await createPatient(runtime, cookie)
    expect((await register(runtime, cookie, nextPatient.id)).status).toBe(200)
    expect(await registrationNumbers(runtime, cookie)).toContain('CM-OP-20260824-000004')
  })

  it('shares the date sequence across Workspaces without expanding patient search permissions', async () => {
    const { runtime, cookie } = await openRuntime()
    const patient = await createPatient(runtime, cookie)
    expect((await register(runtime, cookie, patient.id)).status).toBe(200)
    const context = { ...(await runtime.identity.resolveSessionContext(new Headers({ cookie }))).actor,
      workspaceId: 'workspace-second', epoch: 'epoch-second', scenarioRunId: 'run-second' }
    new WorkspaceRepository(runtime.database).install({ ...context, scenarioId: 'candidate-fever-outpatient-v3', workspaceName: '合成第二工作区' })
    runtime.scenario.ensureInitialEpoch(context)
    const otherPatient = runtime.workflow.createPatient({ context, expectedVersions: {}, idempotencyKey: randomUUID(), patient: {
      birthDate: '1990-05-10', gender: 'male', identifier: 'SECOND-SYNTHETIC-PATIENT', name: '合成患者李明',
    } }).data.patient
    const other = runtime.workflow.register({ context, expectedVersions: { [`Patient/${otherPatient.id}`]: '1' }, idempotencyKey: randomUUID(), registration: {
      departmentId: 'department-general-medicine', locationId: 'location-outpatient', patientId: otherPatient.id, visitDate: '2026-08-24', visitTypeId: 'visit-general',
    } })
    expect(runtime.workflow.registrationQueue(context, 20).items.map(item => item.registrationNumber)).toEqual(['CM-OP-20260824-000002'])
    const search = await runtime.app.request('/api/his/v1/patients?query=CM-OP-20260824-000002', { headers: { cookie } })
    expect(patientSearchSchema.parse(await search.json())).toMatchObject({ items: [], total: 0 })
    expect((await runtime.app.request(`/fhir/R5/Encounter/${other.data.encounterId}`, { headers: { cookie } })).status).toBe(404)
    expect(await registrationNumbers(runtime, cookie)).toEqual(['CM-OP-20260824-000001'])
  })

  it('keeps the patient identifier and earlier visit number when the patient registers again', async () => {
    const { runtime, cookie } = await openRuntime()
    const patient = await createPatient(runtime, cookie)
    const firstResponse = await register(runtime, cookie, patient.id)
    expect(firstResponse.status).toBe(200)
    const first = registrationResponseSchema.parse(await firstResponse.json())
    runtime.database.driver.exec("UPDATE outpatient_case SET status = 'completed'")
    const nextResponse = await register(runtime, cookie, patient.id)
    expect(nextResponse.status).toBe(200)
    const next = registrationResponseSchema.parse(await nextResponse.json())
    expect(next.data.encounterId).not.toBe(first.data.encounterId)
    const currentPatient = await runtime.app.request(`/fhir/R5/Patient/${patient.id}`, { headers: { cookie } })
    expect(await currentPatient.json()).toMatchObject({ identifier: [{ value: patient.identifier }] })
    for (const [encounterId, value] of [[first.data.encounterId, 'CM-OP-20260824-000001'], [next.data.encounterId, 'CM-OP-20260824-000002']]) {
      const encounter = await runtime.app.request(`/fhir/R5/Encounter/${encounterId}`, { headers: { cookie } })
      expect(await encounter.json()).toMatchObject({ identifier: [{ value }] })
    }
  })

  it('serializes concurrent public requests using two real connections to the same file', async () => {
    const first = await openRuntime()
    const second = await openRuntime(first.databasePath)
    const patientA = await createPatient(first.runtime, first.cookie)
    const patientB = await createPatient(second.runtime, second.cookie)
    const responses = await Promise.all([
      register(first.runtime, first.cookie, patientA.id),
      register(second.runtime, second.cookie, patientB.id),
    ])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    for (const response of responses) registrationResponseSchema.parse(await response.json())
    expect((await registrationNumbers(second.runtime, second.cookie)).toSorted()).toEqual(['CM-OP-20260824-000001', 'CM-OP-20260824-000002'])
  })
})
