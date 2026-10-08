import { apiErrorSchema, createPatientResponseSchema, doctorCaseDetailSchema, doctorQueueSchema, registrationResponseSchema, startVisitResponseSchema, triageResponseSchema } from '@clinmesh/contracts/his'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { signIn } from './fixtures/consultation.ts'

it('rejects backfill without a Consultation as a workflow conflict without creating recording state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-recording-control-'))
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
  })
  const headers = (cookie: string) => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
  try {
    const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
    const patientResponse = await runtime.app.request('/api/his/v1/patients', {
      method: 'POST', headers: headers(registrar), body: JSON.stringify({ expectedVersions: {}, input: {
        birthDate: '1990-05-10', gender: 'male', identifier: `CM-SYN-${randomUUID()}`, name: '合成补录验证患者',
      } }),
    })
    expect(patientResponse.status).toBe(200)
    const patient = createPatientResponseSchema.parse(await patientResponse.json()).data.patient
    const registered = await runtime.app.request('/api/his/v1/registrations/actions/register', {
      method: 'POST', headers: headers(registrar), body: JSON.stringify({ expectedVersions: { [`Patient/${patient.id}`]: patient.versionId }, input: {
        departmentId: 'department-general-medicine', locationId: 'location-outpatient', patientId: patient.id, visitDate: '2026-08-24', visitTypeId: 'visit-general',
      } }),
    })
    expect(registered.status).toBe(200)
    const registration = registrationResponseSchema.parse(await registered.json()).data
    const nurse = await signIn(runtime, 'triage@demo.clinmesh.local')
    const triaged = await runtime.app.request(`/api/his/v1/encounters/${registration.encounterId}/actions/record-triage`, {
      method: 'POST', headers: headers(nurse), body: JSON.stringify({ expectedVersions: {
        [`Encounter/${registration.encounterId}`]: '1', [`Task/${registration.queueTaskId}`]: '1',
      }, input: { acuityCode: 'level-3', bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, chiefComplaint: '发热伴咽痛两天',
        oxygenSaturationPct: 98, pulseBpm: 102, respirationBpm: 20, temperatureC: 38.6 } }),
    })
    expect(triaged.status).toBe(200)
    const triage = triageResponseSchema.parse(await triaged.json()).data
    const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const started = await runtime.app.request(`/api/his/v1/encounters/${registration.encounterId}/actions/start-first-visit`, {
      method: 'POST', headers: headers(doctor), body: JSON.stringify({ expectedVersions: {
        [`Encounter/${registration.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1',
      }, input: {} }),
    })
    expect(started.status).toBe(200)
    const visit = startVisitResponseSchema.parse(await started.json()).data
    const queue = doctorQueueSchema.parse(await (await runtime.app.request('/api/his/v1/doctor/queue', { headers: { cookie: doctor } })).json())
    const caseId = queue.items.find(item => item.encounterId === registration.encounterId)!.caseId
    const read = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${caseId}`, { headers: { cookie: doctor } },
    )).json())
    const before = await read()
    expect(before.consultation).toBeUndefined()
    expect(before.consultationRecording).toBeUndefined()
    const control = await runtime.app.request(`/api/his/v1/encounters/${registration.encounterId}/consultation-recording/actions/control`, {
      method: 'POST', headers: headers(doctor), body: JSON.stringify({ expectedVersions: { [`Encounter/${registration.encounterId}`]: visit.encounterVersion },
        input: { action: 'backfill', expectedRecordingVersion: 0 } }),
    })
    const error = apiErrorSchema.parse(await control.json())
    expect(control.status).toBe(409)
    expect(error.error.code).toBe('WORKFLOW_CONFLICT')
    expect(await read()).toEqual(before)
    expect(runtime.database.driver.prepare('SELECT count(*) AS count FROM consultation_recording_job').get()).toMatchObject({ count: 0 })
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
