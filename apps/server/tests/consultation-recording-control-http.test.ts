import { apiErrorSchema, clinicalDocumentSignPreviewResponseSchema, createPatientResponseSchema, doctorCaseDetailSchema, doctorQueueSchema, registrationResponseSchema, startVisitResponseSchema, triageResponseSchema } from '@clinmesh/contracts/his'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { signIn } from './fixtures/consultation.ts'

it('activates a new case without consultation and signs doctor-only recording without source acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-recording-control-'))
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    chatCompletionsProvider: { async completeJson(input) {
      const payload = input.userPayload as { turns: Array<{ sentences: Array<{ id: string }> }>; additions?: unknown[] }
      if (input.schemaName === 'consultation_history_verification') return { model: 'synthetic', content: JSON.stringify({
        additions: payload.additions!.map((_, index) => ({ index, faithful: true, complete: true, relationValid: true })),
      }) }
      const source = payload.turns.at(-1)!
      return { model: 'synthetic', content: JSON.stringify({ additions: [{ field: 'assessment', relation: 'addition',
        facts: [{ text: '医生考虑急性上呼吸道感染', sourceIds: [source.sentences[0]!.id] }],
      }] }) }
    } },
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
    const activated = await runtime.app.request(`/api/his/v1/encounters/${registration.encounterId}/consultation-recording/actions/control`, {
      method: 'POST', headers: headers(doctor), body: JSON.stringify({ expectedVersions: { [`Encounter/${registration.encounterId}`]: visit.encounterVersion },
        input: { action: 'activate', expectedRecordingVersion: 0 } }),
    })
    expect(activated.status).toBe(200)
    expect((await read()).consultationRecording).toMatchObject({ status: 'idle', version: 1, sources: [] })
    const context = await runtime.identity.resolveActorContext(new Headers({ cookie: doctor }), 'encounter.consultation.recording.control')
    const supplement = { context, encounterId: registration.encounterId, sourceId: 'doctor-only-source',
      content: '我考虑急性上呼吸道感染。', sessionId: 'synthetic-session', rpcId: 'synthetic-rpc', messageId: 'synthetic-message',
      recordedAt: '2026-10-14T01:00:00.000Z', expectedVersions: { [`Encounter/${registration.encounterId}`]: visit.encounterVersion }, idempotencyKey: randomUUID() }
    runtime.workflow.consultationRecording.recordDoctorSupplement(supplement)
    await runtime.dispatchPending()
    const recorded = await read()
    expect(recorded.consultation).toBeUndefined()
    expect(recorded.clinicalDocument!.draft).toMatchObject({ assessment: '医生考虑急性上呼吸道感染' })
    expect(recorded.consultationRecording!.sources).toMatchObject([{ kind: 'doctor', id: 'doctor-only-source' }])
    const document = { chiefComplaint: '发热伴咽痛两天。', historyOfPresentIllness: '合成患者自诉发热咽痛。',
      physicalExamination: '医生查体咽部充血。', assessment: recorded.clinicalDocument!.draft!.assessment,
      disposition: '医生决定门诊观察。', followUp: '医生安排三日后复诊。' }
    const saved = await runtime.app.request(`/api/his/v1/encounters/${registration.encounterId}/clinical-document/draft`, {
      method: 'PUT', headers: headers(doctor), body: JSON.stringify({ expectedVersions: { [`Encounter/${registration.encounterId}`]: visit.encounterVersion },
        input: { expectedDraftVersion: recorded.clinicalDocument!.draft!.version, document } }),
    })
    expect(saved.status).toBe(200)
    const preview = await runtime.app.request(`/api/his/v1/encounters/${registration.encounterId}/clinical-document/actions/preview-sign`, {
      method: 'POST', headers: headers(doctor), body: JSON.stringify({ expectedVersions: { [`Encounter/${registration.encounterId}`]: visit.encounterVersion },
        input: { expectedDraftVersion: (await read()).clinicalDocument!.draft!.version } }),
    })
    expect(preview.status).toBe(200)
    const prepared = clinicalDocumentSignPreviewResponseSchema.parse(await preview.json()).data
    expect(prepared).not.toHaveProperty('consultationReview')
    const signed = await runtime.app.request(`/api/his/v1/encounters/${registration.encounterId}/clinical-document/actions/sign`, {
      method: 'POST', headers: headers(doctor), body: JSON.stringify({ expectedVersions: { [`Encounter/${registration.encounterId}`]: visit.encounterVersion },
        input: { previewId: prepared.previewId, commitToken: prepared.commitToken } }),
    })
    expect(signed.status).toBe(200)
    expect(() => runtime.workflow.consultationRecording.recordDoctorSupplement(supplement)).toThrow('not editable')
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
