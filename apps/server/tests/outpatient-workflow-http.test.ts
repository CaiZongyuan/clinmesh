import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  apiErrorSchema,
  billingQueueSchema,
  clinicalCatalogSchema,
  clinicalDocumentRevisionResponseSchema,
  clinicalSignPreviewResponseSchema,
  clinicalSignResponseSchema,
  createPatientResponseSchema,
  dispenseResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  firstVisitDraftResponseSchema,
  laboratoryOrderResponseSchema,
  patientSearchSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  pharmacyQueueSchema,
  prescriptionReviewResponseSchema,
  registrationQueueSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  revisitDraftResponseSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
  startVirtualPatientResponseSchema,
  startVisitResponseSchema,
  triageQueueSchema,
  triageResponseSchema,
  virtualPatientListSchema,
} from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditQuery } from '../src/application/audit-query.ts'
import { WorkspaceContextError } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

type TestRuntime = Awaited<ReturnType<typeof createClinMeshRuntime>>
type RevisitMedicationDraft = {
  catalogItemId: string
  doseText: string
  frequencyCode: string
  quantity: number
}

async function signIn(runtime: TestRuntime, email: string, password: string): Promise<string> {
  const response = await runtime.app.request('/api/auth/sign-in/email', {
    body: JSON.stringify({ email, password }),
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
    },
    method: 'POST',
  })
  if (!response.ok) throw new Error(`Test sign-in failed for ${email}`)
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
}

function commandHeaders(cookie: string, idempotencyKey = randomUUID()) {
  return {
    'content-type': 'application/json',
    cookie,
    'idempotency-key': idempotencyKey,
    origin: 'http://localhost',
  }
}

async function createRegisteredCase(runtime: TestRuntime, password: string) {
  const registrarCookie = await signIn(runtime, 'registrar@demo.clinmesh.local', password)
  const patientResponse = await runtime.app.request('/api/his/v1/patients', {
    body: JSON.stringify({
      expectedVersions: {},
      input: {
        birthDate: '1990-05-10',
        gender: 'male',
        identifier: `CM-SYN-${randomUUID()}`,
        name: '合成患者周明',
      },
    }),
    headers: commandHeaders(registrarCookie),
    method: 'POST',
  })
  const patient = createPatientResponseSchema.parse(await patientResponse.json()).data.patient
  const registrationResponse = await runtime.app.request('/api/his/v1/registrations/actions/register', {
    body: JSON.stringify({
      expectedVersions: { [`Patient/${patient.id}`]: patient.versionId },
      input: {
        departmentId: 'department-general-medicine',
        locationId: 'location-outpatient',
        patientId: patient.id,
        visitDate: '2026-08-24',
        visitTypeId: 'visit-general',
      },
    }),
    headers: commandHeaders(registrarCookie),
    method: 'POST',
  })
  const registration = registrationResponseSchema.parse(await registrationResponse.json()).data
  return { patient, registrarCookie, registration }
}

async function createTriagedCase(runtime: TestRuntime, password: string) {
  const registered = await createRegisteredCase(runtime, password)
  const triageCookie = await signIn(runtime, 'triage@demo.clinmesh.local', password)
  const triageResponse = await runtime.app.request(
    `/api/his/v1/encounters/${registered.registration.encounterId}/actions/record-triage`,
    {
      body: JSON.stringify({
        expectedVersions: {
          [`Encounter/${registered.registration.encounterId}`]: '1',
          [`Task/${registered.registration.queueTaskId}`]: '1',
        },
        input: {
          acuityCode: 'level-3',
          bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
          chiefComplaint: '发热伴咽痛两天',
          oxygenSaturationPct: 98,
          pulseBpm: 102,
          respirationBpm: 20,
          temperatureC: 38.6,
        },
      }),
      headers: commandHeaders(triageCookie),
      method: 'POST',
    },
  )
  const triage = triageResponseSchema.parse(await triageResponse.json()).data
  const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
  const queue = await runtime.app.request('/api/his/v1/doctor/queue?pageSize=20', {
    headers: { cookie: doctorCookie },
  })
  const queueItem = doctorQueueSchema.parse(await queue.json()).items[0]
  if (queueItem === undefined) throw new Error('Triaged test case did not reach the doctor queue')
  return { ...registered, caseId: queueItem.caseId, doctorCookie, triage }
}

async function createLabOrderedCase(runtime: TestRuntime, password: string) {
  const testCase = await createTriagedCase(runtime, password)
  await runtime.app.request(
    `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/start-first-visit`,
    {
      body: JSON.stringify({
        expectedVersions: {
          [`Encounter/${testCase.registration.encounterId}`]: '2',
          [`Task/${testCase.triage.doctorTaskId}`]: '1',
        },
        input: {},
      }),
      headers: commandHeaders(testCase.doctorCookie),
      method: 'POST',
    },
  )
  await runtime.app.request(
    `/api/his/v1/encounters/${testCase.registration.encounterId}/drafts/first-visit`,
    {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${testCase.registration.encounterId}`]: '3' },
        input: {
          assessment: '急性发热，待检验明确病原',
          expectedDraftVersion: 0,
          historyOfPresentIllness: '两天前出现发热，最高体温 38.8°C，伴咽痛。',
        },
      }),
      headers: commandHeaders(testCase.doctorCookie),
      method: 'PUT',
    },
  )
  const orderResponse = await runtime.app.request(
    `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/issue-laboratory-order`,
    {
      body: JSON.stringify({
        expectedVersions: {
          [`Encounter/${testCase.registration.encounterId}`]: '3',
          [`Task/${testCase.triage.doctorTaskId}`]: '2',
        },
        input: {
          catalogItemId: 'lab-fever-panel',
          expectedDraftVersion: 1,
          indicationCode: 'fever',
        },
      }),
      headers: commandHeaders(testCase.doctorCookie),
      method: 'POST',
    },
  )
  const order = laboratoryOrderResponseSchema.parse(await orderResponse.json()).data
  return { ...testCase, order }
}

async function createPaidLabCase(runtime: TestRuntime, password: string) {
  const testCase = await createLabOrderedCase(runtime, password)
  const cashierCookie = await signIn(runtime, 'cashier@demo.clinmesh.local', password)
  const previewResponse = await runtime.app.request('/api/his/v1/payments/actions/preview', {
    body: JSON.stringify({
      expectedVersions: { [`ChargeItem/${testCase.order.chargeItemId}`]: '1' },
      input: {
        caseId: testCase.caseId,
        category: 'laboratory',
        simulatorRule: 'success',
      },
    }),
    headers: commandHeaders(cashierCookie),
    method: 'POST',
  })
  const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
  const paymentResponse = await runtime.app.request(
    `/api/his/v1/payments/${preview.previewId}/actions/confirm`,
    {
      body: JSON.stringify({
        expectedVersions: { [`ChargeItem/${testCase.order.chargeItemId}`]: '1' },
        input: { commitToken: preview.commitToken },
      }),
      headers: commandHeaders(cashierCookie),
      method: 'POST',
    },
  )
  const payment = paymentResponseSchema.parse(await paymentResponse.json()).data
  return { ...testCase, cashierCookie, payment }
}

async function createReportedCase(runtime: TestRuntime, password: string) {
  const testCase = await createPaidLabCase(runtime, password)
  const dispatch = await runtime.dispatcher.dispatchOnce()
  if (dispatch?.status !== 'completed') throw new Error('Test LIS dispatch did not complete')
  const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
  const queueResponse = await runtime.app.request('/api/his/v1/doctor/queue?pageSize=20', {
    headers: { cookie: doctorCookie },
  })
  const queueItem = doctorQueueSchema.parse(await queueResponse.json()).items[0]
  if (queueItem === undefined) throw new Error('Reported test case did not reach revisit')
  return { ...testCase, doctorCookie, report: queueItem }
}

async function createRevisitDraftCase(
  runtime: TestRuntime,
  password: string,
  medications: RevisitMedicationDraft[] = [{
    catalogItemId: 'medication-oseltamivir',
    doseText: '75 mg',
    frequencyCode: 'BID',
    quantity: 10,
  }],
) {
  const testCase = await createReportedCase(runtime, password)
  await runtime.app.request(
    `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/start-revisit`,
    {
      body: JSON.stringify({
        expectedVersions: {
          [`Encounter/${testCase.registration.encounterId}`]: '5',
          [`Task/${testCase.report.taskId}`]: '1',
        },
        input: {},
      }),
      headers: commandHeaders(testCase.doctorCookie),
      method: 'POST',
    },
  )
  const draftResponse = await runtime.app.request(
    `/api/his/v1/encounters/${testCase.registration.encounterId}/drafts/revisit`,
    {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${testCase.registration.encounterId}`]: '6' },
        input: {
          diagnosis: {
            code: 'J10.1',
            display: '流感伴其他呼吸道表现，季节性流感病毒已标明',
          },
          document: {
            assessment: '甲型流感，生命体征稳定。',
            plan: '口服抗病毒药物，对症处理，必要时复诊。',
          },
          expectedVersions: {
            documentDraft: 0,
            prescription: 0,
            revisitDraft: 0,
          },
          medications,
        },
      }),
      headers: commandHeaders(testCase.doctorCookie),
      method: 'PUT',
    },
  )
  const draft = revisitDraftResponseSchema.parse(await draftResponse.json()).data
  return { ...testCase, draft }
}

async function createSignedCase(
  runtime: TestRuntime,
  password: string,
  medications?: RevisitMedicationDraft[],
) {
  const testCase = await createRevisitDraftCase(runtime, password, medications)
  const expectedVersions = {
    [`Condition/${testCase.draft.conditionId}`]: '1',
    [`Encounter/${testCase.registration.encounterId}`]: '6',
    [`Task/${testCase.report.taskId}`]: '2',
    ...Object.fromEntries(testCase.draft.medicationRequestIds.map(
      medicationRequestId => [`MedicationRequest/${medicationRequestId}`, '1'],
    )),
  }
  const previewResponse = await runtime.app.request(
    `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/preview-sign`,
    {
      body: JSON.stringify({
        expectedVersions,
        input: {
          expectedDraftVersions: {
            documentDraft: 1,
            prescription: 1,
            revisitDraft: 1,
          },
        },
      }),
      headers: commandHeaders(testCase.doctorCookie),
      method: 'POST',
    },
  )
  const preview = clinicalSignPreviewResponseSchema.parse(await previewResponse.json()).data
  const signResponse = await runtime.app.request(
    `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/sign-and-complete`,
    {
      body: JSON.stringify({
        expectedVersions,
        input: preview,
      }),
      headers: commandHeaders(testCase.doctorCookie),
      method: 'POST',
    },
  )
  const signed = clinicalSignResponseSchema.parse(await signResponse.json()).data
  return { ...testCase, signed }
}

async function createPaidMedicationCase(
  runtime: TestRuntime,
  password: string,
  medications?: RevisitMedicationDraft[],
) {
  const testCase = await createSignedCase(runtime, password, medications)
  const cashierCookie = await signIn(runtime, 'cashier@demo.clinmesh.local', password)
  const previewResponse = await runtime.app.request('/api/his/v1/payments/actions/preview', {
    body: JSON.stringify({
      expectedVersions: { [`ChargeItem/${testCase.signed.chargeItemId}`]: '1' },
      input: {
        caseId: testCase.caseId,
        category: 'medication',
        simulatorRule: 'success',
      },
    }),
    headers: commandHeaders(cashierCookie),
    method: 'POST',
  })
  const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
  const paymentResponse = await runtime.app.request(
    `/api/his/v1/payments/${preview.previewId}/actions/confirm`,
    {
      body: JSON.stringify({
        expectedVersions: { [`ChargeItem/${testCase.signed.chargeItemId}`]: '1' },
        input: { commitToken: preview.commitToken },
      }),
      headers: commandHeaders(cashierCookie),
      method: 'POST',
    },
  )
  const payment = paymentResponseSchema.parse(await paymentResponse.json()).data
  const pharmacistCookie = await signIn(runtime, 'pharmacist@demo.clinmesh.local', password)
  const reviewResponse = await runtime.app.request(
    `/api/his/v1/prescriptions/${testCase.draft.prescriptionId}/actions/review`,
    {
      body: JSON.stringify({
        expectedVersions: {
          [`Encounter/${testCase.registration.encounterId}`]: '7',
          ...Object.fromEntries(testCase.draft.medicationRequestIds.map(
            medicationRequestId => [`MedicationRequest/${medicationRequestId}`, '2'],
          )),
        },
        input: {
          expectedPrescriptionVersion: 3,
          note: '合成处方审核通过。',
        },
      }),
      headers: commandHeaders(pharmacistCookie),
      method: 'POST',
    },
  )
  if (!reviewResponse.ok) throw new Error('Test prescription review did not complete')
  prescriptionReviewResponseSchema.parse(await reviewResponse.json())
  return { ...testCase, cashierCookie, payment, pharmacistCookie }
}

describe('outpatient workflow HTTP contract', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
  })

  it('lists only the clinically visible Virtual Patient summary for the doctor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-virtual-patient-list-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)

    const response = await runtime.app.request('/api/his/v1/doctor/virtual-patients', {
      headers: { cookie: doctorCookie },
    })

    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    const candidates = virtualPatientListSchema.parse(body)
    expect(candidates).toEqual({
      items: [{
        birthDate: '1988-03-16',
        gender: 'female',
        id: 'virtual-patient-fever-001',
        name: '合成候选患者林晓',
        presentation: {
          chiefComplaint: '发热、咽痛 1 天。',
          summary: '昨日傍晚开始发热，最高 38.7 °C，伴咽痛。',
          vitalSigns: {
            bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
            oxygenSaturationPct: 98,
            pulseBpm: 96,
            respirationBpm: 20,
            temperatureC: 38.6,
          },
        },
        version: expect.any(String),
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    })
    expect(candidates.items[0]?.version.length).toBeGreaterThanOrEqual(32)
    expect(JSON.stringify(body)).not.toMatch(/scenario|hidden|influenza|candidate-patient-001/i)

    const secondPageResponse = await runtime.app.request(
      '/api/his/v1/doctor/virtual-patients?page=2&pageSize=1',
      { headers: { cookie: doctorCookie } },
    )
    expect(await secondPageResponse.json()).toEqual({
      items: [],
      page: 2,
      pageSize: 1,
      total: 1,
    })
  })

  it('atomically starts one persistent doctor case and replays the same command receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-virtual-patient-start-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const administratorCookie = await signIn(runtime, 'admin@demo.clinmesh.local', password)
    const selectRole = (practitionerRoleId: string) => runtime.app.request('/api/auth/role', {
      body: JSON.stringify({ practitionerRoleId }),
      headers: {
        'content-type': 'application/json',
        cookie: administratorCookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect((await selectRole('practitioner-role-outpatient-doctor')).status).toBe(200)
    const candidatesResponse = await runtime.app.request('/api/his/v1/doctor/virtual-patients', {
      headers: { cookie: administratorCookie },
    })
    const candidate = virtualPatientListSchema.parse(await candidatesResponse.json()).items[0]
    if (candidate === undefined) throw new Error('Candidate Virtual Patient was not seeded')
    const idempotencyKey = randomUUID()
    const start = () => runtime.app.request(
      `/api/his/v1/doctor/virtual-patients/${candidate.id}/actions/start`,
      {
        body: JSON.stringify({
          expectedVersions: {},
          input: { expectedVersion: candidate.version },
        }),
        headers: commandHeaders(administratorCookie, idempotencyKey),
        method: 'POST',
      },
    )

    const firstResponse = await start()
    expect(firstResponse.status).toBe(200)
    const first = startVirtualPatientResponseSchema.parse(await firstResponse.json())
    expect(first.data).toMatchObject({
      patientId: 'candidate-patient-001',
      status: 'first-visit',
      virtualPatientId: candidate.id,
    })
    expect(startVirtualPatientResponseSchema.parse(await (await start()).json())).toEqual(first)

    for (const [resourceType, resourceId] of [
      ['Patient', first.data.patientId],
      ['Encounter', first.data.encounterId],
      ['Task', first.data.queueTaskId],
    ] as const) {
      const resourceResponse = await runtime.app.request(`/fhir/R5/${resourceType}/${resourceId}`, {
        headers: { cookie: administratorCookie },
      })
      expect(resourceResponse.status).toBe(200)
      expect(fhirResourceSchema.parse(await resourceResponse.json())).toMatchObject({
        id: resourceId,
        resourceType,
      })
    }
    const encounterSearchResponse = await runtime.app.request(
      `/fhir/R5/Encounter?patient=Patient/${first.data.patientId}&_total=accurate`,
      { headers: { cookie: administratorCookie } },
    )
    expect(fhirBundleSchema.parse(await encounterSearchResponse.json())).toMatchObject({ total: 1 })

    const auditResponse = await runtime.app.request(`/fhir/R5/AuditEvent/${first.auditId}`, {
      headers: { cookie: administratorCookie },
    })
    expect(fhirResourceSchema.parse(await auditResponse.json())).toMatchObject({
      agent: expect.arrayContaining([
        expect.objectContaining({
          requestor: true,
          who: { identifier: expect.objectContaining({ value: 'actor-administrator' }) },
        }),
        expect.objectContaining({
          requestor: false,
          who: { identifier: expect.objectContaining({ value: 'practitioner-outpatient-doctor' }) },
        }),
      ]),
      code: { text: 'virtual-patient.start-consultation' },
    })

    expect((await selectRole('practitioner-role-registrar')).status).toBe(200)
    const registrationsResponse = await runtime.app.request('/api/his/v1/registrations?pageSize=20', {
      headers: { cookie: administratorCookie },
    })
    expect(registrationQueueSchema.parse(await registrationsResponse.json())).toMatchObject({
      items: [expect.objectContaining({
        caseId: first.data.caseId,
        encounterId: first.data.encounterId,
        registrationId: first.data.registrationId,
        registrationStatus: 'in-progress',
        status: 'first-visit',
      })],
      total: 1,
    })

    const restoredDoctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const queueResponse = await runtime.app.request('/api/his/v1/doctor/queue?pageSize=20', {
      headers: { cookie: restoredDoctorCookie },
    })
    expect(doctorQueueSchema.parse(await queueResponse.json())).toMatchObject({
      items: [expect.objectContaining({
        caseId: first.data.caseId,
        encounterId: first.data.encounterId,
        status: 'first-visit',
        taskId: first.data.queueTaskId,
      })],
      total: 1,
    })
  })

  it('reuses an existing registration when the doctor starts its Virtual Patient', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-virtual-patient-registered-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const staleCandidatesResponse = await runtime.app.request('/api/his/v1/doctor/virtual-patients', {
      headers: { cookie: doctorCookie },
    })
    const staleCandidate = virtualPatientListSchema.parse(await staleCandidatesResponse.json()).items[0]
    if (staleCandidate === undefined) throw new Error('Candidate Virtual Patient was not seeded')
    const registrarCookie = await signIn(runtime, 'registrar@demo.clinmesh.local', password)
    const patientResponse = await runtime.app.request(
      '/api/his/v1/patients?query=CM-CANDIDATE-001&pageSize=20',
      { headers: { cookie: registrarCookie } },
    )
    const patient = patientSearchSchema.parse(await patientResponse.json()).items[0]
    if (patient === undefined) throw new Error('Candidate Patient was not seeded')
    const registrationResponse = await runtime.app.request('/api/his/v1/registrations/actions/register', {
      body: JSON.stringify({
        expectedVersions: { [`Patient/${patient.id}`]: patient.versionId },
        input: {
          departmentId: 'department-general-medicine',
          locationId: 'location-outpatient',
          patientId: patient.id,
          visitDate: '2026-08-24',
          visitTypeId: 'visit-general',
        },
      }),
      headers: commandHeaders(registrarCookie),
      method: 'POST',
    })
    const registration = registrationResponseSchema.parse(await registrationResponse.json()).data
    const start = (candidate: typeof staleCandidate) => runtime.app.request(
      `/api/his/v1/doctor/virtual-patients/${candidate.id}/actions/start`, {
        body: JSON.stringify({
          expectedVersions: {},
          input: { expectedVersion: candidate.version },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    const staleResponse = await start(staleCandidate)
    expect(staleResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })

    const candidatesResponse = await runtime.app.request('/api/his/v1/doctor/virtual-patients', {
      headers: { cookie: doctorCookie },
    })
    const candidate = virtualPatientListSchema.parse(await candidatesResponse.json()).items[0]
    if (candidate === undefined) throw new Error('Candidate Virtual Patient was not seeded')
    expect(candidate.version).toHaveLength(staleCandidate.version.length)
    const decodedTokenSegments = candidate.version
      .split('.')
      .map(segment => Buffer.from(segment, 'base64url').toString())
      .join('')
    expect(decodedTokenSegments).not.toContain(registration.encounterId)
    expect(decodedTokenSegments).not.toContain(registration.queueTaskId)
    const startResponse = await start(candidate)

    expect(startResponse.status).toBe(200)
    const started = startVirtualPatientResponseSchema.parse(await startResponse.json()).data
    expect(started).toMatchObject({
      encounterId: registration.encounterId,
      patientId: patient.id,
      queueTaskId: registration.queueTaskId,
      registrationId: registration.registrationId,
      status: 'first-visit',
      virtualPatientId: candidate.id,
    })
    const encounterSearchResponse = await runtime.app.request(
      `/fhir/R5/Encounter?patient=Patient/${patient.id}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await encounterSearchResponse.json())).toMatchObject({ total: 1 })
    const [encounterResponse, taskResponse] = await Promise.all([
      runtime.app.request(`/fhir/R5/Encounter/${registration.encounterId}`, {
        headers: { cookie: doctorCookie },
      }),
      runtime.app.request(`/fhir/R5/Task/${registration.queueTaskId}`, {
        headers: { cookie: doctorCookie },
      }),
    ])
    expect(fhirResourceSchema.parse(await encounterResponse.json())).toMatchObject({
      extension: expect.arrayContaining([{
        url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/workflow-phase',
        valueCode: 'first-visit',
      }]),
      status: 'in-progress',
    })
    expect(fhirResourceSchema.parse(await taskResponse.json())).toMatchObject({
      code: { text: 'Outpatient consultation' },
      owner: { reference: 'PractitionerRole/practitioner-role-outpatient-doctor' },
      status: 'in-progress',
    })
    const queueResponse = await runtime.app.request('/api/his/v1/doctor/queue?pageSize=20', {
      headers: { cookie: doctorCookie },
    })
    const queue = doctorQueueSchema.parse(await queueResponse.json())
    expect(queue).toMatchObject({
      items: [expect.objectContaining({
        caseId: started.caseId,
        encounterId: registration.encounterId,
        status: 'first-visit',
        taskId: registration.queueTaskId,
      })],
      total: 1,
    })
    expect(queue.items[0]?.triage).toBeUndefined()
  })

  it('redacts stale dependency details from an opaque Virtual Patient conflict', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-virtual-patient-dependency-conflict-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const registrarCookie = await signIn(runtime, 'registrar@demo.clinmesh.local', password)
    const patientResponse = await runtime.app.request(
      '/api/his/v1/patients?query=CM-CANDIDATE-001&pageSize=20',
      { headers: { cookie: registrarCookie } },
    )
    const patient = patientSearchSchema.parse(await patientResponse.json()).items[0]
    if (patient === undefined) throw new Error('Candidate Patient was not seeded')
    const registrationResponse = await runtime.app.request('/api/his/v1/registrations/actions/register', {
      body: JSON.stringify({
        expectedVersions: { [`Patient/${patient.id}`]: patient.versionId },
        input: {
          departmentId: 'department-general-medicine',
          locationId: 'location-outpatient',
          patientId: patient.id,
          visitDate: '2026-08-24',
          visitTypeId: 'visit-general',
        },
      }),
      headers: commandHeaders(registrarCookie),
      method: 'POST',
    })
    const registration = registrationResponseSchema.parse(await registrationResponse.json()).data
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const candidatesResponse = await runtime.app.request('/api/his/v1/doctor/virtual-patients', {
      headers: { cookie: doctorCookie },
    })
    const candidate = virtualPatientListSchema.parse(await candidatesResponse.json()).items[0]
    if (candidate === undefined) throw new Error('Candidate Virtual Patient was not seeded')

    const triageCookie = await signIn(runtime, 'triage@demo.clinmesh.local', password)
    const triageResponse = await runtime.app.request(
      `/api/his/v1/encounters/${registration.encounterId}/actions/record-triage`, {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${registration.encounterId}`]: '1',
            [`Task/${registration.queueTaskId}`]: '1',
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
        headers: commandHeaders(triageCookie),
        method: 'POST',
      },
    )
    expect(triageResponse.status).toBe(200)

    const conflictResponse = await runtime.app.request(
      `/api/his/v1/doctor/virtual-patients/${candidate.id}/actions/start`, {
        body: JSON.stringify({
          expectedVersions: {},
          input: { expectedVersion: candidate.version },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    expect(conflictResponse.status).toBe(409)
    expect(await conflictResponse.json()).toEqual({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The Virtual Patient version has changed',
      },
    })
    const encounterSearchResponse = await runtime.app.request(
      `/fhir/R5/Encounter?patient=Patient/${patient.id}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await encounterSearchResponse.json())).toMatchObject({ total: 1 })
  })

  it('rejects a stale opaque Virtual Patient version without creating a second doctor case', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-virtual-patient-conflict-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const candidatesResponse = await runtime.app.request('/api/his/v1/doctor/virtual-patients', {
      headers: { cookie: doctorCookie },
    })
    const candidate = virtualPatientListSchema.parse(await candidatesResponse.json()).items[0]
    if (candidate === undefined) throw new Error('Candidate Virtual Patient was not seeded')
    const start = (expectedVersion = candidate.version) => runtime.app.request(
      `/api/his/v1/doctor/virtual-patients/${candidate.id}/actions/start`, {
        body: JSON.stringify({
          expectedVersions: {},
          input: { expectedVersion },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    const tamperIndex = Math.floor(candidate.version.length / 2)
    const tamperedVersion = [
      candidate.version.slice(0, tamperIndex),
      candidate.version[tamperIndex] === 'A' ? 'B' : 'A',
      candidate.version.slice(tamperIndex + 1),
    ].join('')
    const tamperedResponse = await start(tamperedVersion)
    expect(tamperedResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await tamperedResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    const startedResponse = await start()
    expect(startedResponse.status).toBe(200)
    const started = startVirtualPatientResponseSchema.parse(await startedResponse.json()).data

    const conflictResponse = await start()

    expect(conflictResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await conflictResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    const refreshedCandidatesResponse = await runtime.app.request('/api/his/v1/doctor/virtual-patients', {
      headers: { cookie: doctorCookie },
    })
    expect(virtualPatientListSchema.parse(await refreshedCandidatesResponse.json())).toMatchObject({
      items: [],
      total: 0,
    })
    const queueResponse = await runtime.app.request('/api/his/v1/doctor/queue?pageSize=20', {
      headers: { cookie: doctorCookie },
    })
    expect(doctorQueueSchema.parse(await queueResponse.json())).toMatchObject({ total: 1 })
    const encounterSearchResponse = await runtime.app.request(
      `/fhir/R5/Encounter?patient=Patient/${started.patientId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await encounterSearchResponse.json())).toMatchObject({ total: 1 })
  })

  it('creates a synthetic patient and atomically hands one registration to the triage queue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-registration-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply' as const,
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)

    const signIn = async (email: string): Promise<string> => {
      const response = await runtime.app.request('/api/auth/sign-in/email', {
        body: JSON.stringify({ email, password }),
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        method: 'POST',
      })
      expect(response.status).toBe(200)
      return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    }
    const commandHeaders = (cookie: string, idempotencyKey = randomUUID()) => ({
      'content-type': 'application/json',
      cookie,
      'idempotency-key': idempotencyKey,
      origin: 'http://localhost',
    })

    const registrarCookie = await signIn('registrar@demo.clinmesh.local')
    const malformedPatientResponse = await runtime.app.request('/api/his/v1/patients', {
      body: '{',
      headers: commandHeaders(registrarCookie),
      method: 'POST',
    })
    expect(malformedPatientResponse.status).toBe(400)
    expect(apiErrorSchema.parse(await malformedPatientResponse.json())).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })

    const catalogResponse = await runtime.app.request('/api/his/v1/catalogs/registration', {
      headers: { cookie: registrarCookie },
    })
    expect(catalogResponse.status).toBe(200)
    expect(registrationCatalogSchema.parse(await catalogResponse.json())).toMatchObject({
      departments: [{ id: 'department-general-medicine' }],
      locations: [{ id: 'location-outpatient' }],
      visitTypes: [{ id: 'visit-general', priceFen: 2000 }],
      virtualDate: '2026-08-24',
    })

    const candidatePatientResponse = await runtime.app.request(
      '/api/his/v1/patients?query=CM-CANDIDATE-001&pageSize=20',
      { headers: { cookie: registrarCookie } },
    )
    expect(patientSearchSchema.parse(await candidatePatientResponse.json())).toMatchObject({
      items: [{ identifier: 'CM-CANDIDATE-001', synthetic: true }],
      total: 1,
    })

    const patientIdempotencyKey = randomUUID()
    const createPatient = () => runtime.app.request('/api/his/v1/patients', {
      body: JSON.stringify({
        expectedVersions: {},
        input: {
          birthDate: '1990-05-10',
          gender: 'male',
          identifier: 'CM-SYN-1001',
          name: '合成患者周明',
        },
      }),
      headers: commandHeaders(registrarCookie, patientIdempotencyKey),
      method: 'POST',
    })
    const patientResponse = await createPatient()
    expect(patientResponse.status).toBe(200)
    const patientResult = createPatientResponseSchema.parse(await patientResponse.json())
    expect(patientResult.data.patient).toMatchObject({
      identifier: 'CM-SYN-1001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    })
    expect(createPatientResponseSchema.parse(await (await createPatient()).json())).toEqual(patientResult)

    const searchResponse = await runtime.app.request(
      '/api/his/v1/patients?query=CM-SYN-1001&pageSize=20',
      { headers: { cookie: registrarCookie } },
    )
    expect(searchResponse.status).toBe(200)
    expect(patientSearchSchema.parse(await searchResponse.json())).toMatchObject({
      items: [{ id: patientResult.data.patient.id, name: '合成患者周明' }],
      total: 1,
    })

    const missingExpectedVersionResponse = await runtime.app.request(
      '/api/his/v1/registrations/actions/register',
      {
        body: JSON.stringify({
          expectedVersions: {},
          input: {
            departmentId: 'department-general-medicine',
            locationId: 'location-outpatient',
            patientId: patientResult.data.patient.id,
            visitDate: '2026-08-24',
            visitTypeId: 'visit-general',
          },
        }),
        headers: commandHeaders(registrarCookie),
        method: 'POST',
      },
    )
    expect(missingExpectedVersionResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await missingExpectedVersionResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })

    const registrationIdempotencyKey = randomUUID()
    const register = () => runtime.app.request('/api/his/v1/registrations/actions/register', {
      body: JSON.stringify({
        expectedVersions: {
          [`Patient/${patientResult.data.patient.id}`]: '1',
        },
        input: {
          departmentId: 'department-general-medicine',
          locationId: 'location-outpatient',
          patientId: patientResult.data.patient.id,
          visitDate: '2026-08-24',
          visitTypeId: 'visit-general',
        },
      }),
      headers: commandHeaders(registrarCookie, registrationIdempotencyKey),
      method: 'POST',
    })
    const registrationResponse = await register()
    expect(registrationResponse.status).toBe(200)
    const registrationResult = registrationResponseSchema.parse(await registrationResponse.json())
    expect(registrationResult.data).toMatchObject({
      patientId: patientResult.data.patient.id,
      status: 'awaiting-triage',
      totalFen: 2000,
    })
    expect(registrationResponseSchema.parse(await (await register()).json())).toEqual(registrationResult)

    const registrationsResponse = await runtime.app.request(
      '/api/his/v1/registrations?pageSize=20',
      { headers: { cookie: registrarCookie } },
    )
    expect(registrationsResponse.status).toBe(200)
    const registrations = registrationQueueSchema.parse(await registrationsResponse.json())
    expect(registrations).toMatchObject({
      items: [{
        caseId: expect.any(String),
        encounterId: registrationResult.data.encounterId,
        encounterVersion: '1',
        patient: { id: patientResult.data.patient.id },
        registrationId: registrationResult.data.registrationId,
        status: 'awaiting-triage',
        taskId: registrationResult.data.queueTaskId,
        taskVersion: '1',
      }],
      total: 1,
    })
    const registrationNumber = registrations.items[0]?.registrationNumber
    if (registrationNumber === undefined) throw new Error('Registration number was not returned')
    const visitNumberSearch = await runtime.app.request(
      `/api/his/v1/patients?query=${encodeURIComponent(registrationNumber)}&pageSize=20`,
      { headers: { cookie: registrarCookie } },
    )
    expect(patientSearchSchema.parse(await visitNumberSearch.json())).toMatchObject({
      items: [{ id: patientResult.data.patient.id }],
      total: 1,
    })

    runtime.fhir.create({ epoch: 'epoch-1', workspaceId: 'workspace-demo' }, {
      resourceType: 'AllergyIntolerance',
      id: `allergy-${randomUUID()}`,
      clinicalStatus: {
        coding: [{
          code: 'active',
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
        }],
      },
      verificationStatus: {
        coding: [{
          code: 'confirmed',
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
        }],
      },
      category: ['medication'],
      code: {
        coding: [{ code: 'PENICILLIN', display: '青霉素' }],
        text: '青霉素过敏',
      },
      patient: { reference: `Patient/${patientResult.data.patient.id}` },
    })

    const triageCookie = await signIn('triage@demo.clinmesh.local')
    const queueResponse = await runtime.app.request('/api/his/v1/triage/queue?pageSize=20', {
      headers: { cookie: triageCookie },
    })
    expect(queueResponse.status).toBe(200)
    expect(triageQueueSchema.parse(await queueResponse.json())).toMatchObject({
      items: [{
        arrivedAt: '2026-08-24T09:00:00+08:00',
        department: {
          id: 'department-general-medicine',
          nameEn: 'General Medicine',
          nameZh: '全科医学科',
        },
        encounterId: registrationResult.data.encounterId,
        location: {
          id: 'location-outpatient',
          nameEn: 'Outpatient clinic',
          nameZh: '门诊诊疗区',
        },
        patient: {
          id: patientResult.data.patient.id,
          name: '合成患者周明',
        },
        riskFlags: [{ code: 'PENICILLIN', display: '青霉素过敏' }],
        status: 'awaiting-triage',
        visitType: {
          id: 'visit-general',
          nameEn: 'General outpatient registration',
          nameZh: '普通门诊挂号费',
        },
      }],
      total: 1,
    })

    for (const [resourceType, resourceId] of [
      ['Encounter', registrationResult.data.encounterId],
      ['Task', registrationResult.data.queueTaskId],
      ['Account', registrationResult.data.accountId],
      ['ChargeItem', registrationResult.data.chargeItemId],
    ]) {
      const response = await runtime.app.request(`/fhir/R5/${resourceType}/${resourceId}`, {
        headers: { cookie: triageCookie },
      })
      expect(response.status).toBe(200)
      expect(fhirResourceSchema.parse(await response.json())).toMatchObject({
        id: resourceId,
        resourceType,
      })
    }
  })

  it('records structured triage on the same Encounter and hands it to the doctor queue once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-triage-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const { patient, registration } = await createRegisteredCase(runtime, password)
    const triageCookie = await signIn(runtime, 'triage@demo.clinmesh.local', password)
    const idempotencyKey = randomUUID()
    const triage = (expectedEncounterVersion = '1', key = idempotencyKey) => runtime.app.request(
      `/api/his/v1/encounters/${registration.encounterId}/actions/record-triage`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${registration.encounterId}`]: expectedEncounterVersion,
            [`Task/${registration.queueTaskId}`]: '1',
          },
          input: {
            acuityCode: 'level-3',
            bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
            chiefComplaint: '发热伴咽痛两天',
            oxygenSaturationPct: 98,
            pulseBpm: 102,
            respirationBpm: 20,
            temperatureC: 38.6,
          },
        }),
        headers: commandHeaders(triageCookie, key),
        method: 'POST',
      },
    )

    const missingVersionsResponse = await runtime.app.request(
      `/api/his/v1/encounters/${registration.encounterId}/actions/record-triage`,
      {
        body: JSON.stringify({
          expectedVersions: {},
          input: {
            acuityCode: 'level-3',
            bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
            chiefComplaint: '发热伴咽痛两天',
            oxygenSaturationPct: 98,
            pulseBpm: 102,
            respirationBpm: 20,
            temperatureC: 38.6,
          },
        }),
        headers: commandHeaders(triageCookie),
        method: 'POST',
      },
    )
    expect(missingVersionsResponse.status).toBe(409)

    const triageResponse = await triage()
    expect(triageResponse.status).toBe(200)
    const triageResult = triageResponseSchema.parse(await triageResponse.json())
    expect(triageResult.data).toMatchObject({
      encounterId: registration.encounterId,
      encounterVersion: '2',
      status: 'awaiting-doctor',
    })
    expect(triageResponseSchema.parse(await (await triage()).json())).toEqual(triageResult)

    const completedQueue = await runtime.app.request(
      '/api/his/v1/triage/queue?status=completed&pageSize=20',
      { headers: { cookie: triageCookie } },
    )
    expect(triageQueueSchema.parse(await completedQueue.json())).toMatchObject({
      items: [{
        encounterId: registration.encounterId,
        encounterVersion: '2',
        patient: { id: patient.id },
        status: 'awaiting-doctor',
        taskVersion: '2',
      }],
      total: 1,
    })
    const exceptionQueue = await runtime.app.request(
      '/api/his/v1/triage/queue?status=exception&pageSize=20',
      { headers: { cookie: triageCookie } },
    )
    expect(triageQueueSchema.parse(await exceptionQueue.json())).toMatchObject({ items: [], total: 0 })

    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const doctorQueue = await runtime.app.request('/api/his/v1/doctor/queue?pageSize=20', {
      headers: { cookie: doctorCookie },
    })
    expect(doctorQueue.status).toBe(200)
    expect(doctorQueueSchema.parse(await doctorQueue.json())).toMatchObject({
      items: [{
        encounterId: registration.encounterId,
        encounterVersion: '2',
        patient: { id: patient.id },
        status: 'awaiting-doctor',
        taskVersion: '1',
        triage: {
          acuityCode: 'level-3',
          chiefComplaint: '发热伴咽痛两天',
          temperatureC: 38.6,
        },
      }],
      total: 1,
    })

    const staleResponse = await triage('1', randomUUID())
    expect(staleResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleResponse.json())).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_REUSED' },
    })
    const observationSearch = await runtime.app.request('/fhir/R5/Observation?_total=accurate', {
      headers: { cookie: doctorCookie },
    })
    expect(fhirBundleSchema.parse(await observationSearch.json())).toMatchObject({ total: 1 })
  })

  it('starts the first visit, saves a CAS draft, and issues one laboratory request with one charge', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-first-visit-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createTriagedCase(runtime, password)

    const catalogResponse = await runtime.app.request('/api/his/v1/catalogs/clinical', {
      headers: { cookie: testCase.doctorCookie },
    })
    expect(catalogResponse.status).toBe(200)
    expect(clinicalCatalogSchema.parse(await catalogResponse.json())).toMatchObject({
      laboratory: [{
        allowedIndicationCodes: ['fever'],
        id: 'lab-fever-panel',
        nameEn: 'Fever laboratory panel',
        nameZh: '发热检验组合',
        priceFen: 6800,
        version: 1,
      }],
      medications: [
        expect.objectContaining({
          allowedDoseTexts: ['0.5 g'],
          allowedFrequencyCodes: ['PRN'],
          defaultDoseText: '0.5 g',
          defaultFrequencyCode: 'PRN',
          id: 'medication-acetaminophen',
        }),
        expect.objectContaining({
          allowedDoseTexts: ['75 mg'],
          allowedFrequencyCodes: ['BID'],
          defaultDoseText: '75 mg',
          defaultFrequencyCode: 'BID',
          id: 'medication-oseltamivir',
        }),
      ],
    })

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${testCase.caseId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(detailResponse.status).toBe(200)
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      caseId: testCase.caseId,
      encounter: { id: testCase.registration.encounterId, status: 'in-progress', versionId: '2' },
      patient: { id: testCase.patient.id },
      taskId: testCase.triage.doctorTaskId,
      taskVersion: '1',
      triage: {
        bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
        chiefComplaint: '发热伴咽痛两天',
        oxygenSaturationPct: 98,
        pulseBpm: 102,
        respirationBpm: 20,
        temperatureC: 38.6,
      },
    })

    const startResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/start-first-visit`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${testCase.registration.encounterId}`]: '2',
            [`Task/${testCase.triage.doctorTaskId}`]: '1',
          },
          input: {},
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    expect(startResponse.status).toBe(200)
    expect(startVisitResponseSchema.parse(await startResponse.json())).toMatchObject({
      data: { encounterVersion: '3', status: 'first-visit', taskVersion: '2' },
    })

    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/drafts/first-visit`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${testCase.registration.encounterId}`]: '3' },
          input: {
            assessment: '急性发热，待检验明确病原',
            expectedDraftVersion: 0,
            historyOfPresentIllness: '两天前出现发热，最高体温 38.8°C，伴咽痛。',
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'PUT',
      },
    )
    expect(draftResponse.status).toBe(200)
    expect(firstVisitDraftResponseSchema.parse(await draftResponse.json())).toMatchObject({
      data: { draftVersion: 1 },
    })

    const orderIdempotencyKey = randomUUID()
    const invalidIndicationResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/issue-laboratory-order`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${testCase.registration.encounterId}`]: '3',
            [`Task/${testCase.triage.doctorTaskId}`]: '2',
          },
          input: {
            catalogItemId: 'lab-fever-panel',
            expectedDraftVersion: 1,
            indicationCode: 'screening',
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    expect(invalidIndicationResponse.status).toBe(409)
    const issueOrder = () => runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/issue-laboratory-order`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${testCase.registration.encounterId}`]: '3',
            [`Task/${testCase.triage.doctorTaskId}`]: '2',
          },
          input: {
            catalogItemId: 'lab-fever-panel',
            expectedDraftVersion: 1,
            indicationCode: 'fever',
          },
        }),
        headers: commandHeaders(testCase.doctorCookie, orderIdempotencyKey),
        method: 'POST',
      },
    )
    const orderResponse = await issueOrder()
    expect(orderResponse.status).toBe(200)
    const order = laboratoryOrderResponseSchema.parse(await orderResponse.json())
    expect(order.data).toMatchObject({
      encounterId: testCase.registration.encounterId,
      encounterVersion: '4',
      status: 'awaiting-lab-payment',
      totalFen: 6800,
    })
    expect(laboratoryOrderResponseSchema.parse(await (await issueOrder()).json())).toEqual(order)

    const encounterResponse = await runtime.app.request(
      `/fhir/R5/Encounter/${testCase.registration.encounterId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await encounterResponse.json())).toMatchObject({
      id: testCase.registration.encounterId,
      status: 'in-progress',
    })
    for (const resourceType of ['ServiceRequest', 'ChargeItem']) {
      const search = await runtime.app.request(`/fhir/R5/${resourceType}?_total=accurate`, {
        headers: { cookie: testCase.doctorCookie },
      })
      expect(fhirBundleSchema.parse(await search.json())).toMatchObject({
        total: resourceType === 'ChargeItem' ? 2 : 1,
      })
    }
  })

  it('previews the authoritative laboratory amount and confirms one successful payment for LIS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-lab-payment-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createLabOrderedCase(runtime, password)
    const cashierCookie = await signIn(runtime, 'cashier@demo.clinmesh.local', password)

    const queueResponse = await runtime.app.request(
      '/api/his/v1/billing/queue?category=laboratory&status=pending&pageSize=20',
      { headers: { cookie: cashierCookie } },
    )
    expect(queueResponse.status).toBe(200)
    expect(billingQueueSchema.parse(await queueResponse.json())).toMatchObject({
      items: [{
        accountId: expect.any(String),
        amountFen: 6800,
        caseId: testCase.caseId,
        category: 'laboratory',
        chargeItemId: testCase.order.chargeItemId,
        patient: { id: testCase.patient.id },
        status: 'billable',
      }],
      total: 1,
    })

    const previewResponse = await runtime.app.request('/api/his/v1/payments/actions/preview', {
      body: JSON.stringify({
        expectedVersions: { [`ChargeItem/${testCase.order.chargeItemId}`]: '1' },
        input: {
          caseId: testCase.caseId,
          category: 'laboratory',
          simulatorRule: 'success',
        },
      }),
      headers: commandHeaders(cashierCookie),
      method: 'POST',
    })
    expect(previewResponse.status).toBe(200)
    const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
    expect(preview).toMatchObject({
      amountFen: 6800,
      chargeItemId: testCase.order.chargeItemId,
      chargeVersion: 1,
      expectedOutcome: 'success',
    })

    const paymentIdempotencyKey = randomUUID()
    const confirm = () => runtime.app.request(
      `/api/his/v1/payments/${preview.previewId}/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions: { [`ChargeItem/${testCase.order.chargeItemId}`]: '1' },
          input: { commitToken: preview.commitToken },
        }),
        headers: commandHeaders(cashierCookie, paymentIdempotencyKey),
        method: 'POST',
      },
    )
    const paymentResponse = await confirm()
    expect(paymentResponse.status).toBe(200)
    const payment = paymentResponseSchema.parse(await paymentResponse.json())
    expect(payment.data).toMatchObject({
      amountFen: 6800,
      outcome: 'success',
      status: 'awaiting-lis',
    })
    expect(paymentResponseSchema.parse(await (await confirm()).json())).toEqual(payment)

    const chargeResponse = await runtime.app.request(
      `/fhir/R5/ChargeItem/${testCase.order.chargeItemId}`,
      { headers: { cookie: cashierCookie } },
    )
    expect(fhirResourceSchema.parse(await chargeResponse.json())).toMatchObject({
      id: testCase.order.chargeItemId,
      meta: { versionId: '2' },
      status: 'billed',
    })
    const encounterResponse = await runtime.app.request(
      `/fhir/R5/Encounter/${testCase.registration.encounterId}`,
      { headers: { cookie: cashierCookie } },
    )
    expect(fhirResourceSchema.parse(await encounterResponse.json())).toMatchObject({ status: 'in-progress' })

  })

  it('keeps declined and ambiguous laboratory payments in distinct queues without releasing LIS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-payment-outcomes-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const declinedCase = await createLabOrderedCase(runtime, password)
    const ambiguousCase = await createLabOrderedCase(runtime, password)
    const cashierCookie = await signIn(runtime, 'cashier@demo.clinmesh.local', password)

    const confirmOutcome = async (
      testCase: Awaited<ReturnType<typeof createLabOrderedCase>>,
      simulatorRule: 'ambiguous' | 'decline',
    ) => {
      const previewResponse = await runtime.app.request('/api/his/v1/payments/actions/preview', {
        body: JSON.stringify({
          expectedVersions: { [`ChargeItem/${testCase.order.chargeItemId}`]: '1' },
          input: { caseId: testCase.caseId, category: 'laboratory', simulatorRule },
        }),
        headers: commandHeaders(cashierCookie),
        method: 'POST',
      })
      const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
      const response = await runtime.app.request(
        `/api/his/v1/payments/${preview.previewId}/actions/confirm`,
        {
          body: JSON.stringify({
            expectedVersions: { [`ChargeItem/${testCase.order.chargeItemId}`]: '1' },
            input: { commitToken: preview.commitToken },
          }),
          headers: commandHeaders(cashierCookie),
          method: 'POST',
        },
      )
      expect(response.status).toBe(200)
    }

    await confirmOutcome(declinedCase, 'decline')
    await confirmOutcome(ambiguousCase, 'ambiguous')

    const queue = async (status: 'ambiguous' | 'declined' | 'paid' | 'pending') => {
      const response = await runtime.app.request(
        `/api/his/v1/billing/queue?category=laboratory&status=${status}&pageSize=20`,
        { headers: { cookie: cashierCookie } },
      )
      expect(response.status).toBe(200)
      return billingQueueSchema.parse(await response.json())
    }
    expect(await queue('pending')).toMatchObject({ items: [], total: 0 })
    expect(await queue('paid')).toMatchObject({ items: [], total: 0 })
    expect(await queue('declined')).toMatchObject({
      items: [{ caseId: declinedCase.caseId, chargeVersion: 2, status: 'declined' }],
      total: 1,
    })
    expect(await queue('ambiguous')).toMatchObject({
      items: [{ caseId: ambiguousCase.caseId, chargeVersion: 2, status: 'ambiguous' }],
      total: 1,
    })

    const retryPreview = await runtime.app.request('/api/his/v1/payments/actions/preview', {
      body: JSON.stringify({
        expectedVersions: { [`ChargeItem/${declinedCase.order.chargeItemId}`]: '2' },
        input: {
          caseId: declinedCase.caseId,
          category: 'laboratory',
          simulatorRule: 'success',
        },
      }),
      headers: commandHeaders(cashierCookie),
      method: 'POST',
    })
    expect(retryPreview.status).toBe(200)
    expect(await runtime.dispatcher.dispatchOnce()).toBeUndefined()
  })

  it('recovers a paid LIS task after restart and creates one final structured report for revisit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-lis-restart-http-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'clinmesh.sqlite')
    const password = `Test-${randomUUID()}-Aa1!`
    const runtimeOptions = {
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath,
      demoPassword: password,
      migrationMode: 'apply' as const,
      trustedOrigins: ['http://localhost'],
    }
    const initialRuntime = await createClinMeshRuntime(runtimeOptions)
    const paidCase = await createPaidLabCase(initialRuntime, password)
    await initialRuntime.close()

    const restartedRuntime = await createClinMeshRuntime(runtimeOptions)
    runtimes.push(restartedRuntime)
    const dispatchResult = await restartedRuntime.dispatcher.dispatchOnce()
    expect(dispatchResult).toMatchObject({ kind: 'lis.process-order', status: 'completed' })
    expect(await restartedRuntime.dispatcher.dispatchOnce()).toBeUndefined()

    const doctorCookie = await signIn(restartedRuntime, 'doctor@demo.clinmesh.local', password)
    const queueResponse = await restartedRuntime.app.request('/api/his/v1/doctor/queue?pageSize=20', {
      headers: { cookie: doctorCookie },
    })
    expect(queueResponse.status).toBe(200)
    const queue = doctorQueueSchema.parse(await queueResponse.json())
    expect(queue.items).toEqual([expect.objectContaining({
      caseId: paidCase.caseId,
      encounterId: paidCase.registration.encounterId,
      status: 'awaiting-revisit',
    })])

    const reportResponse = await restartedRuntime.app.request(
      `/fhir/R5/DiagnosticReport/${queue.items[0]?.diagnosticReportId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(reportResponse.status).toBe(200)
    expect(fhirResourceSchema.parse(await reportResponse.json())).toMatchObject({
      encounter: { reference: `Encounter/${paidCase.registration.encounterId}` },
      result: [expect.any(Object), expect.any(Object)],
      status: 'final',
      subject: { reference: `Patient/${paidCase.patient.id}` },
    })

    for (const [resourceType, total] of [
      ['Specimen', 1],
      ['Observation', 3],
      ['DiagnosticReport', 1],
    ] as const) {
      const response = await restartedRuntime.app.request(
        `/fhir/R5/${resourceType}?_total=accurate`,
        { headers: { cookie: doctorCookie } },
      )
      expect(fhirBundleSchema.parse(await response.json())).toMatchObject({ total })
    }

    const duplicate = restartedRuntime.workflow.processLisOrder({
      context: {
        actorId: 'actor-lis-system',
        epoch: 'epoch-1',
        organizationId: 'organization-clinmesh',
        roleCode: 'lis-system',
        scenarioRunId: 'scenario-run-1',
        workspaceId: 'workspace-demo',
      },
      eventId: randomUUID(),
      payload: {
        caseId: paidCase.caseId,
        encounterId: paidCase.registration.encounterId,
        patientId: paidCase.patient.id,
        serviceRequestId: paidCase.order.serviceRequestId,
      },
    })
    expect(duplicate.data).toMatchObject({
      diagnosticReportId: queue.items[0]?.diagnosticReportId,
      status: 'awaiting-revisit',
    })
    expect(duplicate.effects).toEqual([])
    for (const [resourceType, total] of [
      ['Specimen', 1],
      ['Observation', 3],
      ['DiagnosticReport', 1],
    ] as const) {
      const response = await restartedRuntime.app.request(
        `/fhir/R5/${resourceType}?_total=accurate`,
        { headers: { cookie: doctorCookie } },
      )
      expect(fhirBundleSchema.parse(await response.json())).toMatchObject({ total })
    }
  })

  it('rejects an unpaid LIS result without leaving partial report facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-unpaid-lis-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createLabOrderedCase(runtime, password)

    expect(() => runtime.workflow.processLisOrder({
      context: {
        actorId: 'actor-lis-system',
        epoch: 'epoch-1',
        organizationId: 'organization-clinmesh',
        roleCode: 'lis-system',
        scenarioRunId: 'scenario-run-1',
        workspaceId: 'workspace-demo',
      },
      eventId: randomUUID(),
      payload: {
        caseId: testCase.caseId,
        encounterId: testCase.registration.encounterId,
        patientId: testCase.patient.id,
        serviceRequestId: testCase.order.serviceRequestId,
      },
    })).toThrow('paid laboratory request is not available')
    const reports = await runtime.app.request('/fhir/R5/DiagnosticReport?_total=accurate', {
      headers: { cookie: testCase.doctorCookie },
    })
    const specimens = await runtime.app.request('/fhir/R5/Specimen?_total=accurate', {
      headers: { cookie: testCase.doctorCookie },
    })
    expect(fhirBundleSchema.parse(await reports.json())).toMatchObject({ total: 0 })
    expect(fhirBundleSchema.parse(await specimens.json())).toMatchObject({ total: 0 })
  })

  it('retries the real LIS handler after a persisted transient failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-lis-retry-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createPaidLabCase(runtime, password)
    const processLisOrder = runtime.workflow.processLisOrder.bind(runtime.workflow)
    const handler = vi.spyOn(runtime.workflow, 'processLisOrder')
      .mockImplementationOnce(() => { throw new Error('injected transient LIS failure') })
      .mockImplementation(processLisOrder)

    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({
      attempt: 1,
      kind: 'lis.process-order',
      status: 'failed',
    })
    runtime.database.driver.prepare(`
      UPDATE outbox_event SET next_attempt_at = '1970-01-01T00:00:00.000Z'
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND kind = 'lis.process-order' AND status = 'failed'
    `).run()
    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({
      attempt: 2,
      kind: 'lis.process-order',
      status: 'completed',
    })
    handler.mockRestore()
    const reportResponse = await runtime.app.request('/fhir/R5/DiagnosticReport?_total=accurate', {
      headers: { cookie: testCase.doctorCookie },
    })
    expect(fhirBundleSchema.parse(await reportResponse.json())).toMatchObject({ total: 1 })
  })

  it('isolates a claimed LIS result that arrives after an Epoch reset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-lis-old-epoch-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    await createPaidLabCase(runtime, password)
    const claim = runtime.dispatcher.claimNext()
    if (claim === undefined) throw new Error('Paid laboratory order did not create an LIS event')

    const adminCookie = await signIn(runtime, 'admin@demo.clinmesh.local', password)
    const resetResponse = await runtime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      {
        body: '{}',
        headers: commandHeaders(adminCookie),
        method: 'POST',
      },
    )
    expect(resetResponse.status).toBe(200)
    expect(scenarioCommandResponseSchema.parse(await resetResponse.json())).toMatchObject({
      data: { epoch: 'epoch-2', scenarioRunId: 'scenario-run-2' },
    })

    const payload = claim.payload as {
      caseId: string
      encounterId: string
      patientId: string
      serviceRequestId: string
    }
    expect(() => runtime.workflow.processLisOrder({
      context: {
        actorId: 'actor-lis-system',
        epoch: claim.epoch,
        organizationId: 'organization-clinmesh',
        roleCode: 'lis-system',
        scenarioRunId: claim.scenarioRunId,
        workspaceId: claim.workspaceId,
      },
      eventId: claim.eventId,
      payload,
    })).toThrowError(WorkspaceContextError)

    const oldContext = { epoch: claim.epoch, workspaceId: claim.workspaceId }
    expect(runtime.fhir.search(
      oldContext,
      'DiagnosticReport',
      new URLSearchParams('_total=accurate'),
    )).toMatchObject({ total: 0 })
    expect(new AuditQuery(runtime.database).list(oldContext)).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'lis.process-order', outcome: 'failed' }),
    ]))
    expect(runtime.database.driver.prepare(`
      SELECT status FROM outbox_event
      WHERE workspace_id = ? AND epoch = ? AND event_id = ?
    `).get(claim.workspaceId, claim.epoch, claim.eventId)).toEqual({ status: 'abandoned' })
    expect(fhirBundleSchema.parse(await (await runtime.app.request('/fhir/R5/DiagnosticReport?_total=accurate', {
      headers: { cookie: adminCookie },
    })).json())).toMatchObject({ total: 0 })
    expect(fhirBundleSchema.parse(await (await runtime.app.request('/fhir/R5/AuditEvent?_total=accurate', {
      headers: { cookie: adminCookie },
    })).json())).toMatchObject({ total: 0 })
  })

  it('runs the persistent LIS dispatcher from the live runtime without a manual test hook', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-live-dispatch-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      autoDispatchIntervalMs: 10,
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createPaidLabCase(runtime, password)
    const deadline = Date.now() + 2_000
    let queueItem: { caseId: string; status: string } | undefined
    while (queueItem === undefined && Date.now() < deadline) {
      const response = await runtime.app.request('/api/his/v1/doctor/queue?pageSize=20', {
        headers: { cookie: testCase.doctorCookie },
      })
      queueItem = doctorQueueSchema.parse(await response.json()).items
        .find(item => item.caseId === testCase.caseId && item.status === 'awaiting-revisit')
      if (queueItem === undefined) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(queueItem).toMatchObject({ caseId: testCase.caseId, status: 'awaiting-revisit' })
  })

  it('starts revisit and saves versioned diagnosis, prescription, and document drafts without charging', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-revisit-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createReportedCase(runtime, password)

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${testCase.caseId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(detailResponse.status).toBe(200)
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      report: {
        id: testCase.report.diagnosticReportId,
        results: [
          expect.objectContaining({ code: '80382-5', value: true }),
          expect.objectContaining({ code: '6690-2', value: 6.8 }),
        ],
        status: 'final',
      },
    })

    const startResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/start-revisit`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${testCase.registration.encounterId}`]: '5',
            [`Task/${testCase.report.taskId}`]: '1',
          },
          input: {},
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    expect(startResponse.status).toBe(200)
    expect(startVisitResponseSchema.parse(await startResponse.json())).toMatchObject({
      data: { encounterVersion: '6', status: 'revisit-draft', taskVersion: '2' },
    })

    const invalidDoseResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/drafts/revisit`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${testCase.registration.encounterId}`]: '6' },
          input: {
            diagnosis: { code: 'J10.1', display: '甲型流感' },
            document: { assessment: '甲型流感。', plan: '抗病毒治疗。' },
            expectedVersions: { documentDraft: 0, prescription: 0, revisitDraft: 0 },
            medications: [{
              catalogItemId: 'medication-oseltamivir',
              doseText: '150 mg',
              frequencyCode: 'BID',
              quantity: 10,
            }],
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'PUT',
      },
    )
    expect(invalidDoseResponse.status).toBe(409)

    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/drafts/revisit`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${testCase.registration.encounterId}`]: '6' },
          input: {
            diagnosis: {
              code: 'J10.1',
              display: '流感伴其他呼吸道表现，季节性流感病毒已标明',
            },
            document: {
              assessment: '甲型流感，生命体征稳定。',
              plan: '口服抗病毒药物，对症处理，必要时复诊。',
            },
            expectedVersions: {
              documentDraft: 0,
              prescription: 0,
              revisitDraft: 0,
            },
            medications: [{
              catalogItemId: 'medication-oseltamivir',
              doseText: '75 mg',
              frequencyCode: 'BID',
              quantity: 10,
            }],
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'PUT',
      },
    )
    expect(draftResponse.status).toBe(200)
    const draft = revisitDraftResponseSchema.parse(await draftResponse.json()).data
    expect(draft).toMatchObject({
      documentDraftVersion: 1,
      prescriptionVersion: 1,
      revisitDraftVersion: 1,
    })
    expect(draft.medicationRequestIds).toHaveLength(1)

    const medicationRequest = await runtime.app.request(
      `/fhir/R5/MedicationRequest/${draft.medicationRequestIds[0]}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await medicationRequest.json())).toMatchObject({
      status: 'draft',
      subject: { reference: `Patient/${testCase.patient.id}` },
    })
    const cashierCookie = await signIn(runtime, 'cashier@demo.clinmesh.local', password)
    const billingResponse = await runtime.app.request(
      '/api/his/v1/billing/queue?category=medication&status=pending&pageSize=20',
      { headers: { cookie: cashierCookie } },
    )
    expect(billingQueueSchema.parse(await billingResponse.json())).toMatchObject({ items: [], total: 0 })
    const encounterResponse = await runtime.app.request(
      `/fhir/R5/Encounter/${testCase.registration.encounterId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await encounterResponse.json())).toMatchObject({ status: 'in-progress' })
    const savedDetailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${testCase.caseId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await savedDetailResponse.json())).toMatchObject({
      drafts: {
        document: {
          composition: {
            encounter: { reference: `Encounter/${testCase.registration.encounterId}` },
            resourceType: 'Composition',
            status: 'preliminary',
            subject: [{ reference: `Patient/${testCase.patient.id}` }],
          },
          version: 1,
        },
        prescription: {
          id: draft.prescriptionId,
          items: [{ medicationRequestId: draft.medicationRequestIds[0], versionId: '1' }],
          version: 1,
        },
        revisit: { conditionId: draft.conditionId, conditionVersion: '1', version: 1 },
      },
    })

    const revisedDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/drafts/revisit`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Condition/${draft.conditionId}`]: '1',
            [`Encounter/${testCase.registration.encounterId}`]: '6',
            [`MedicationRequest/${draft.medicationRequestIds[0]}`]: '1',
          },
          input: {
            diagnosis: {
              code: 'J10.1',
              display: '流感伴其他呼吸道表现，季节性流感病毒已标明',
            },
            document: {
              assessment: '甲型流感，生命体征稳定，无重症危险征象。',
              plan: '口服抗病毒药物五日，对症处理，必要时复诊。',
            },
            expectedVersions: {
              documentDraft: 1,
              prescription: 1,
              revisitDraft: 1,
            },
            medications: [{
              catalogItemId: 'medication-oseltamivir',
              doseText: '75 mg',
              frequencyCode: 'BID',
              quantity: 20,
            }],
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'PUT',
      },
    )
    expect(revisedDraftResponse.status).toBe(200)
    const revisedDraft = revisitDraftResponseSchema.parse(await revisedDraftResponse.json()).data
    expect(revisedDraft).toMatchObject({
      conditionId: draft.conditionId,
      documentDraftVersion: 2,
      medicationRequestIds: draft.medicationRequestIds,
      prescriptionId: draft.prescriptionId,
      prescriptionNumber: draft.prescriptionNumber,
      prescriptionVersion: 2,
      revisitDraftVersion: 2,
    })
    const revisedDetailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${testCase.caseId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await revisedDetailResponse.json())).toMatchObject({
      drafts: {
        document: { plan: '口服抗病毒药物五日，对症处理，必要时复诊。', version: 2 },
        prescription: {
          id: draft.prescriptionId,
          items: [{ medicationRequestId: draft.medicationRequestIds[0], quantity: 20, versionId: '2' }],
          version: 2,
        },
        revisit: { conditionId: draft.conditionId, conditionVersion: '2', version: 2 },
      },
    })
  })

  it('shows active medication allergies and rejects a contraindicated revisit draft atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-allergy-rule-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createReportedCase(runtime, password)
    runtime.fhir.create({ epoch: 'epoch-1', workspaceId: 'workspace-demo' }, {
      resourceType: 'AllergyIntolerance',
      id: `allergy-${randomUUID()}`,
      clinicalStatus: {
        coding: [{
          code: 'active',
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
        }],
      },
      verificationStatus: {
        coding: [{
          code: 'confirmed',
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
        }],
      },
      category: ['medication'],
      criticality: 'high',
      code: {
        coding: [{
          code: 'OSELTAMIVIR',
          display: '磷酸奥司他韦',
          system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/synthetic-medication',
        }],
        text: '磷酸奥司他韦过敏',
      },
      patient: { reference: `Patient/${testCase.patient.id}` },
      recordedDate: '2026-08-24T08:30:00+08:00',
    })
    runtime.fhir.create({ epoch: 'epoch-1', workspaceId: 'workspace-demo' }, {
      resourceType: 'Condition',
      id: 'synthetic-prior-condition',
      clinicalStatus: {
        coding: [{
          code: 'resolved',
          system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
        }],
      },
      code: { text: '既往上呼吸道感染（合成）' },
      subject: { reference: `Patient/${testCase.patient.id}` },
      recordedDate: '2025-11-08',
    })

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${testCase.caseId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      allergies: [{
        code: 'OSELTAMIVIR',
        display: '磷酸奥司他韦过敏',
      }],
      priorFacts: [{
        clinicalStatus: 'resolved',
        code: '',
        display: '既往上呼吸道感染（合成）',
        id: 'synthetic-prior-condition',
        recordedDate: '2025-11-08',
      }],
    })

    await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/start-revisit`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${testCase.registration.encounterId}`]: '5',
            [`Task/${testCase.report.taskId}`]: '1',
          },
          input: {},
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/drafts/revisit`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${testCase.registration.encounterId}`]: '6' },
          input: {
            diagnosis: { code: 'J10.1', display: '甲型流感' },
            document: {
              assessment: '甲型流感，生命体征稳定。',
              plan: '选择无过敏风险的替代药物。',
            },
            expectedVersions: { documentDraft: 0, prescription: 0, revisitDraft: 0 },
            medications: [{
              catalogItemId: 'medication-oseltamivir',
              doseText: '75 mg',
              frequencyCode: 'BID',
              quantity: 10,
            }],
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'PUT',
      },
    )
    expect(draftResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await draftResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    for (const [resourceType, expectedTotal] of [
      ['Condition', 2],
      ['MedicationRequest', 0],
    ] as const) {
      const response = await runtime.app.request(`/fhir/R5/${resourceType}?_total=accurate`, {
        headers: { cookie: testCase.doctorCookie },
      })
      expect(fhirBundleSchema.parse(await response.json())).toMatchObject({ total: expectedTotal })
    }
  })

  it('revalidates medication catalog rules when committing a clinical signature', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-sign-catalog-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createRevisitDraftCase(runtime, password)
    const expectedVersions = {
      [`Condition/${testCase.draft.conditionId}`]: '1',
      [`Encounter/${testCase.registration.encounterId}`]: '6',
      [`MedicationRequest/${testCase.draft.medicationRequestIds[0]}`]: '1',
      [`Task/${testCase.report.taskId}`]: '2',
    }
    const previewResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/preview-sign`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            expectedDraftVersions: {
              documentDraft: 1,
              prescription: 1,
              revisitDraft: 1,
            },
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    const preview = clinicalSignPreviewResponseSchema.parse(await previewResponse.json()).data
    const originalConfig = (runtime.database.driver.prepare(`
      SELECT config_json FROM outpatient_catalog
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND item_id = 'medication-oseltamivir'
    `).get() as { config_json: string }).config_json
    runtime.database.driver.prepare(`
      UPDATE outpatient_catalog
      SET config_json = json_set(config_json, '$.allowedFrequencyCodes', json('["TID"]'))
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND item_id = 'medication-oseltamivir'
    `).run()

    const sign = () => runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/sign-and-complete`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { commitToken: preview.commitToken, previewId: preview.previewId },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    const rejected = await sign()
    expect(rejected.status).toBe(409)
    expect(apiErrorSchema.parse(await rejected.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT' },
    })
    const unchangedEncounter = await runtime.app.request(
      `/fhir/R5/Encounter/${testCase.registration.encounterId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await unchangedEncounter.json())).toMatchObject({
      meta: { versionId: '6' },
      status: 'in-progress',
    })

    runtime.database.driver.prepare(`
      UPDATE outpatient_catalog SET config_json = ?
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND item_id = 'medication-oseltamivir'
    `).run(originalConfig)
    expect((await sign()).status).toBe(200)
  })

  it('signs immutable clinical facts, completes the Encounter, and opens only medication billing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-sign-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createRevisitDraftCase(runtime, password)
    const administratorCookie = await signIn(runtime, 'admin@demo.clinmesh.local', password)
    const actingDoctorResponse = await runtime.app.request('/api/auth/role', {
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-outpatient-doctor' }),
      headers: {
        'content-type': 'application/json',
        cookie: administratorCookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(actingDoctorResponse.status).toBe(200)
    const clinicalExpectedVersions = {
      [`Condition/${testCase.draft.conditionId}`]: '1',
      [`Encounter/${testCase.registration.encounterId}`]: '6',
      [`MedicationRequest/${testCase.draft.medicationRequestIds[0]}`]: '1',
      [`Task/${testCase.report.taskId}`]: '2',
    }

    const previewResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/preview-sign`,
      {
        body: JSON.stringify({
          expectedVersions: clinicalExpectedVersions,
          input: {
            expectedDraftVersions: {
              documentDraft: 1,
              prescription: 1,
              revisitDraft: 1,
            },
          },
        }),
        headers: commandHeaders(administratorCookie),
        method: 'POST',
      },
    )
    expect(previewResponse.status).toBe(200)
    const preview = clinicalSignPreviewResponseSchema.parse(await previewResponse.json()).data
    expect(preview).toMatchObject({
      medicationTotalFen: 7600,
      summary: {
        diagnosis: { code: 'J10.1', display: expect.stringContaining('流感') },
        document: {
          assessment: '甲型流感，生命体征稳定。',
          plan: '口服抗病毒药物，对症处理，必要时复诊。',
        },
        medications: [{
          medicationId: 'medication-oseltamivir',
          quantity: 10,
          subtotalFen: 7600,
          unitPriceFen: 760,
        }],
      },
    })

    const beforeSign = await runtime.app.request(
      `/fhir/R5/Encounter/${testCase.registration.encounterId}`,
      { headers: { cookie: administratorCookie } },
    )
    expect(fhirResourceSchema.parse(await beforeSign.json())).toMatchObject({ status: 'in-progress' })

    const signIdempotencyKey = randomUUID()
    const sign = () => runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/actions/sign-and-complete`,
      {
        body: JSON.stringify({
          expectedVersions: clinicalExpectedVersions,
          input: {
            commitToken: preview.commitToken,
            previewId: preview.previewId,
          },
        }),
        headers: commandHeaders(administratorCookie, signIdempotencyKey),
        method: 'POST',
      },
    )
    const signResponse = await sign()
    expect(signResponse.status).toBe(200)
    const signed = clinicalSignResponseSchema.parse(await signResponse.json())
    expect(signed.data).toMatchObject({
      encounterId: testCase.registration.encounterId,
      encounterVersion: '7',
      status: 'awaiting-medication-payment',
    })
    expect(clinicalSignResponseSchema.parse(await (await sign()).json())).toEqual(signed)

    const provenanceResponse = await runtime.app.request(
      `/fhir/R5/Provenance/${signed.data.provenanceId}`,
      { headers: { cookie: administratorCookie } },
    )
    expect(provenanceResponse.status).toBe(200)
    expect(fhirResourceSchema.parse(await provenanceResponse.json())).toMatchObject({
      agent: expect.arrayContaining([
        expect.objectContaining({
          type: { text: 'Authenticated actor' },
          who: {
            identifier: {
              system: 'https://caizongyuan.github.io/clinmesh/identifier/actor',
              value: 'actor-administrator',
            },
          },
        }),
        expect.objectContaining({
          role: expect.arrayContaining([
            expect.objectContaining({
              coding: [{
                code: 'practitioner-role-outpatient-doctor',
                display: 'outpatient-doctor',
                system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/practitioner-role',
              }],
            }),
            { text: 'Author and signer' },
          ]),
          type: { text: 'Acting practitioner' },
          who: { reference: 'Practitioner/practitioner-outpatient-doctor' },
        }),
      ]),
    })

    const medicationCharge = await runtime.app.request(
      `/fhir/R5/ChargeItem/${signed.data.chargeItemId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await medicationCharge.json())).toMatchObject({
      quantity: { value: 10 },
      unitPriceComponent: { amount: { currency: 'CNY', value: 7.6 } },
    })

    const encounterResponse = await runtime.app.request(
      `/fhir/R5/Encounter/${testCase.registration.encounterId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await encounterResponse.json())).toMatchObject({
      id: testCase.registration.encounterId,
      status: 'completed',
    })
    for (const [resourceType, resourceId] of [
      ['Composition', signed.data.compositionId],
      ['Bundle', signed.data.bundleId],
      ['Provenance', signed.data.provenanceId],
    ]) {
      const response = await runtime.app.request(`/fhir/R5/${resourceType}/${resourceId}`, {
        headers: { cookie: testCase.doctorCookie },
      })
      expect(response.status).toBe(200)
    }
    const overwriteResponse = await runtime.app.request(
      `/fhir/R5/Composition/${signed.data.compositionId}`,
      {
        body: JSON.stringify({ resourceType: 'Composition', id: signed.data.compositionId }),
        headers: {
          'content-type': 'application/fhir+json',
          cookie: testCase.doctorCookie,
          'if-match': 'W/"1"',
        },
        method: 'PUT',
      },
    )
    expect(overwriteResponse.status).toBe(405)

    const revisionIdempotencyKey = randomUUID()
    const revise = () => runtime.app.request(
      `/api/his/v1/clinical-documents/${signed.data.compositionId}/actions/revise`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Composition/${signed.data.compositionId}`]: '1',
            [`Encounter/${testCase.registration.encounterId}`]: '7',
          },
          input: {
            assessment: '甲型流感，复核后补充居家监测说明。',
            plan: '继续抗病毒治疗；持续高热或呼吸困难时复诊。',
            reason: '补充复诊警示信息',
          },
        }),
        headers: commandHeaders(testCase.doctorCookie, revisionIdempotencyKey),
        method: 'POST',
      },
    )
    const revisionResponse = await revise()
    expect(revisionResponse.status).toBe(200)
    const revision = clinicalDocumentRevisionResponseSchema.parse(await revisionResponse.json())
    expect(clinicalDocumentRevisionResponseSchema.parse(await (await revise()).json())).toEqual(revision)
    const originalComposition = await runtime.app.request(
      `/fhir/R5/Composition/${signed.data.compositionId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await originalComposition.json())).toMatchObject({
      id: signed.data.compositionId,
      meta: { versionId: '1' },
      status: 'final',
    })
    const revisedComposition = await runtime.app.request(
      `/fhir/R5/Composition/${revision.data.compositionId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await revisedComposition.json())).toMatchObject({
      encounter: { reference: `Encounter/${testCase.registration.encounterId}` },
      relatesTo: [{
        resourceReference: { reference: `Composition/${signed.data.compositionId}` },
        type: 'replaces',
      }],
      status: 'amended',
      title: '门诊病历更正',
    })
    for (const [resourceType, total] of [
      ['Composition', 2],
      ['Bundle', 2],
      ['Provenance', 2],
    ] as const) {
      const response = await runtime.app.request(
        `/fhir/R5/${resourceType}?_total=accurate`,
        { headers: { cookie: testCase.doctorCookie } },
      )
      expect(fhirBundleSchema.parse(await response.json())).toMatchObject({ total })
    }
    const unchangedEncounter = await runtime.app.request(
      `/fhir/R5/Encounter/${testCase.registration.encounterId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await unchangedEncounter.json())).toMatchObject({
      meta: { versionId: '7' },
      status: 'completed',
    })

    const cashierCookie = await signIn(runtime, 'cashier@demo.clinmesh.local', password)
    const billingResponse = await runtime.app.request(
      '/api/his/v1/billing/queue?category=medication&status=pending&pageSize=20',
      { headers: { cookie: cashierCookie } },
    )
    expect(billingQueueSchema.parse(await billingResponse.json())).toMatchObject({
      items: [{
        amountFen: 7600,
        chargeItemId: signed.data.chargeItemId,
        lines: [{
          descriptionZh: '磷酸奥司他韦胶囊',
          quantity: 10,
          subtotalFen: 7600,
          unitPriceFen: 760,
        }],
      }],
      total: 1,
    })
    const scenarioResponse = await runtime.app.request('/api/sim/v1/scenario-runs/current', {
      headers: { cookie: testCase.doctorCookie },
    })
    expect(scenarioStateSchema.parse(await scenarioResponse.json())).toMatchObject({ status: 'active' })
  })

  it('pays the signed medication charge once and hands the prescription to pharmacy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-medication-payment-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createSignedCase(runtime, password)
    const cashierCookie = await signIn(runtime, 'cashier@demo.clinmesh.local', password)

    const queueResponse = await runtime.app.request(
      '/api/his/v1/billing/queue?category=medication&status=pending&pageSize=20',
      { headers: { cookie: cashierCookie } },
    )
    expect(queueResponse.status).toBe(200)
    expect(billingQueueSchema.parse(await queueResponse.json())).toMatchObject({
      items: [{
        amountFen: 7600,
        category: 'medication',
        chargeItemId: testCase.signed.chargeItemId,
        chargeVersion: 1,
      }],
      total: 1,
    })

    const previewResponse = await runtime.app.request('/api/his/v1/payments/actions/preview', {
      body: JSON.stringify({
        expectedVersions: { [`ChargeItem/${testCase.signed.chargeItemId}`]: '1' },
        input: {
          caseId: testCase.caseId,
          category: 'medication',
          simulatorRule: 'success',
        },
      }),
      headers: commandHeaders(cashierCookie),
      method: 'POST',
    })
    expect(previewResponse.status).toBe(200)
    const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
    expect(preview).toMatchObject({
      allocations: [{
        amountFen: 7600,
        chargeItemId: testCase.signed.chargeItemId,
      }],
      amountFen: 7600,
      channel: 'synthetic-payment',
    })

    const paymentIdempotencyKey = randomUUID()
    const confirm = () => runtime.app.request(
      `/api/his/v1/payments/${preview.previewId}/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions: { [`ChargeItem/${testCase.signed.chargeItemId}`]: '1' },
          input: { commitToken: preview.commitToken },
        }),
        headers: commandHeaders(cashierCookie, paymentIdempotencyKey),
        method: 'POST',
      },
    )
    const paymentResponse = await confirm()
    expect(paymentResponse.status).toBe(200)
    const payment = paymentResponseSchema.parse(await paymentResponse.json())
    expect(payment.data).toMatchObject({
      amountFen: 7600,
      outcome: 'success',
      status: 'awaiting-dispense',
    })
    expect(paymentResponseSchema.parse(await (await confirm()).json())).toEqual(payment)

    const pharmacistCookie = await signIn(runtime, 'pharmacist@demo.clinmesh.local', password)
    const pharmacyQueue = await runtime.app.request('/api/his/v1/pharmacy/queue?pageSize=20', {
      headers: { cookie: pharmacistCookie },
    })
    expect(pharmacyQueue.status).toBe(200)
    const pharmacyBody = pharmacyQueueSchema.parse(await pharmacyQueue.json())
    expect(pharmacyBody).toMatchObject({
      items: [{
        caseId: testCase.caseId,
        encounterId: testCase.registration.encounterId,
        prescriptionId: testCase.draft.prescriptionId,
        status: 'awaiting-review',
      }],
      total: 1,
    })
    const pendingPrescription = pharmacyBody.items[0]
    const pendingMedication = pendingPrescription?.medications[0]
    const pendingLot = pendingMedication?.lots[0]
    if (
      pendingPrescription === undefined
      || pendingMedication === undefined
      || pendingLot === undefined
    ) {
      throw new Error('Paid prescription did not expose the pending review details')
    }
    const beforeReview = await runtime.app.request(
      `/api/his/v1/prescriptions/${testCase.draft.prescriptionId}/actions/dispense`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${testCase.registration.encounterId}`]: pendingPrescription.encounterVersion,
            [`MedicationRequest/${pendingMedication.medicationRequestId}`]: pendingMedication.medicationRequestVersion,
          },
          input: {
            expectedPrescriptionVersion: pendingPrescription.prescriptionVersion,
            lotSelections: [{
              expectedVersion: pendingLot.version,
              lotId: pendingLot.id,
              quantity: 10,
            }],
          },
        }),
        headers: commandHeaders(pharmacistCookie),
        method: 'POST',
      },
    )
    expect(beforeReview.status).toBe(409)

    const reviewResponse = await runtime.app.request(
      `/api/his/v1/prescriptions/${testCase.draft.prescriptionId}/actions/review`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${testCase.registration.encounterId}`]: '7',
            [`MedicationRequest/${testCase.draft.medicationRequestIds[0]}`]: '2',
          },
          input: {
            expectedPrescriptionVersion: 3,
            note: '处方适应证、剂量、频次和过敏信息审核通过。',
          },
        }),
        headers: commandHeaders(pharmacistCookie),
        method: 'POST',
      },
    )
    expect(reviewResponse.status).toBe(200)
    expect(prescriptionReviewResponseSchema.parse(await reviewResponse.json())).toMatchObject({
      data: {
        prescriptionId: testCase.draft.prescriptionId,
        prescriptionVersion: 4,
        status: 'awaiting-dispense',
      },
    })
    const reviewedQueue = await runtime.app.request('/api/his/v1/pharmacy/queue?pageSize=20', {
      headers: { cookie: pharmacistCookie },
    })
    expect(pharmacyQueueSchema.parse(await reviewedQueue.json())).toMatchObject({
      items: [{
        prescriptionId: testCase.draft.prescriptionId,
        prescriptionVersion: 4,
        review: { note: expect.stringContaining('审核通过') },
        status: 'awaiting-dispense',
      }],
    })

    const encounterResponse = await runtime.app.request(
      `/fhir/R5/Encounter/${testCase.registration.encounterId}`,
      { headers: { cookie: cashierCookie } },
    )
    expect(fhirResourceSchema.parse(await encounterResponse.json())).toMatchObject({ status: 'completed' })
    const scenarioResponse = await runtime.app.request('/api/sim/v1/scenario-runs/current', {
      headers: { cookie: cashierCookie },
    })
    expect(scenarioStateSchema.parse(await scenarioResponse.json())).toMatchObject({ status: 'active' })
  })

  it('rejects the dispensing fault matrix without any partial inventory effect', async () => {
    const password = `Test-${randomUUID()}-Aa1!`
    const createRuntime = async () => {
      const directory = await mkdtemp(join(tmpdir(), 'clinmesh-dispense-faults-http-'))
      temporaryDirectories.push(directory)
      const runtime = await createClinMeshRuntime({
        authBaseUrl: 'http://localhost',
        authSecret: 'test-auth-secret-with-at-least-32-characters',
        cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
        databasePath: join(directory, 'clinmesh.sqlite'),
        demoPassword: password,
        migrationMode: 'apply',
        trustedOrigins: ['http://localhost'],
      })
      runtimes.push(runtime)
      return runtime
    }
    const [paidSetup, unpaidSetup, unsignedSetup] = await Promise.all([
      (async () => {
        const runtime = await createRuntime()
        return { runtime, testCase: await createPaidMedicationCase(runtime, password) }
      })(),
      (async () => {
        const runtime = await createRuntime()
        const testCase = await createSignedCase(runtime, password)
        const pharmacistCookie = await signIn(
          runtime,
          'pharmacist@demo.clinmesh.local',
          password,
        )
        return { pharmacistCookie, runtime, testCase }
      })(),
      (async () => {
        const runtime = await createRuntime()
        const testCase = await createRevisitDraftCase(runtime, password)
        const pharmacistCookie = await signIn(
          runtime,
          'pharmacist@demo.clinmesh.local',
          password,
        )
        return { pharmacistCookie, runtime, testCase }
      })(),
    ])
    const { runtime, testCase: paid } = paidSetup
    const {
      pharmacistCookie: unpaidPharmacistCookie,
      runtime: unpaidRuntime,
      testCase: unpaid,
    } = unpaidSetup
    const {
      pharmacistCookie: unsignedPharmacistCookie,
      runtime: unsignedRuntime,
      testCase: unsigned,
    } = unsignedSetup
    const pharmacistCookie = paid.pharmacistCookie
    const lotId = 'lot-oseltamivir-202608'
    const submit = (input: {
      cookie?: string
      encounterId: string
      encounterVersion: string
      expectedLotVersion?: number
      expectedPrescriptionVersion: number
      medicationRequestId: string
      medicationRequestVersion: string
      prescriptionId: string
      quantity?: number
    }, targetRuntime = runtime, defaultCookie = pharmacistCookie) => targetRuntime.app.request(
      `/api/his/v1/prescriptions/${input.prescriptionId}/actions/dispense`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${input.encounterId}`]: input.encounterVersion,
            [`MedicationRequest/${input.medicationRequestId}`]: input.medicationRequestVersion,
          },
          input: {
            expectedPrescriptionVersion: input.expectedPrescriptionVersion,
            lotSelections: [{
              expectedVersion: input.expectedLotVersion ?? 1,
              lotId,
              quantity: input.quantity ?? 10,
            }],
          },
        }),
        headers: commandHeaders(input.cookie ?? defaultCookie),
        method: 'POST',
      },
    )

    expect((await submit({
      encounterId: unsigned.registration.encounterId,
      encounterVersion: '6',
      expectedPrescriptionVersion: 1,
      medicationRequestId: unsigned.draft.medicationRequestIds[0] ?? '',
      medicationRequestVersion: '1',
      prescriptionId: unsigned.draft.prescriptionId,
    }, unsignedRuntime, unsignedPharmacistCookie)).status).toBe(409)
    expect((await submit({
      encounterId: unpaid.registration.encounterId,
      encounterVersion: '7',
      expectedPrescriptionVersion: 2,
      medicationRequestId: unpaid.draft.medicationRequestIds[0] ?? '',
      medicationRequestVersion: '2',
      prescriptionId: unpaid.draft.prescriptionId,
    }, unpaidRuntime, unpaidPharmacistCookie)).status).toBe(409)
    const queueResponse = await runtime.app.request('/api/his/v1/pharmacy/queue?pageSize=20', {
      headers: { cookie: pharmacistCookie },
    })
    const queueItem = pharmacyQueueSchema.parse(await queueResponse.json()).items
      .find(item => item.prescriptionId === paid.draft.prescriptionId)
    const medication = queueItem?.medications[0]
    if (queueItem === undefined || medication === undefined) {
      throw new Error('Paid prescription was missing from the dispensing fault matrix')
    }
    const valid = {
      encounterId: queueItem.encounterId,
      encounterVersion: queueItem.encounterVersion,
      expectedPrescriptionVersion: queueItem.prescriptionVersion,
      medicationRequestId: medication.medicationRequestId,
      medicationRequestVersion: medication.medicationRequestVersion,
      prescriptionId: queueItem.prescriptionId,
    }
    for (const attempt of [
      { ...valid, encounterVersion: '6' },
      { ...valid, medicationRequestVersion: '1' },
      { ...valid, expectedPrescriptionVersion: valid.expectedPrescriptionVersion - 1 },
      { ...valid, expectedLotVersion: 2 },
      { ...valid, quantity: 1001 },
      { ...valid, cookie: paid.cashierCookie },
    ]) {
      const response = await submit(attempt)
      expect([403, 409]).toContain(response.status)
    }
    runtime.database.driver.prepare(`
      UPDATE inventory_lot SET expires_on = '2026-08-23'
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND lot_id = ?
    `).run(lotId)
    expect((await submit(valid)).status).toBe(409)
    runtime.database.driver.prepare(`
      UPDATE inventory_lot SET expires_on = '2027-12-31', location_id = 'location-outpatient'
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND lot_id = ?
    `).run(lotId)
    expect((await submit(valid)).status).toBe(409)
    runtime.database.driver.prepare(`
      UPDATE inventory_lot SET location_id = 'location-pharmacist'
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND lot_id = ?
    `).run(lotId)

    const inventoryBefore = await runtime.app.request(`/fhir/R5/InventoryItem/${lotId}`, {
      headers: { cookie: pharmacistCookie },
    })
    expect(fhirResourceSchema.parse(await inventoryBefore.json())).toMatchObject({
      meta: { versionId: '1' },
      netContent: { value: 1000 },
    })
    expect(runtime.database.driver.prepare(`
      SELECT COUNT(*) AS count FROM inventory_movement
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
    `).get()).toEqual({ count: 0 })
    expect(fhirBundleSchema.parse(await (await runtime.app.request('/fhir/R5/MedicationDispense?_total=accurate', {
      headers: { cookie: pharmacistCookie },
    })).json())).toMatchObject({ total: 0 })

    const competing = await Promise.all([submit(valid), submit(valid)])
    expect(competing.map(response => response.status).toSorted()).toEqual([200, 409])
    const afterCompetition = await runtime.app.request(`/fhir/R5/InventoryItem/${lotId}`, {
      headers: { cookie: pharmacistCookie },
    })
    expect(fhirResourceSchema.parse(await afterCompetition.json())).toMatchObject({
      meta: { versionId: '2' },
      netContent: { value: 990 },
    })
    expect(runtime.database.driver.prepare(`
      SELECT COUNT(*) AS count FROM inventory_movement
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
    `).get()).toEqual({ count: 1 })
    expect((await submit({
      ...valid,
      expectedLotVersion: 2,
      expectedPrescriptionVersion: valid.expectedPrescriptionVersion + 1,
    })).status).toBe(409)
    expect(fhirBundleSchema.parse(await (await runtime.app.request('/fhir/R5/MedicationDispense?_total=accurate', {
      headers: { cookie: pharmacistCookie },
    })).json())).toMatchObject({ total: 1 })
  })

  it('keeps the Scenario Run active across a partial dispense and completes it after the remainder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-partial-dispense-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    await createPaidMedicationCase(runtime, password)
    const pharmacistCookie = await signIn(runtime, 'pharmacist@demo.clinmesh.local', password)
    const initialQueue = await runtime.app.request('/api/his/v1/pharmacy/queue?pageSize=20', {
      headers: { cookie: pharmacistCookie },
    })
    const initial = pharmacyQueueSchema.parse(await initialQueue.json()).items[0]
    const medication = initial?.medications[0]
    const lot = medication?.lots[0]
    if (initial === undefined || medication === undefined || lot === undefined) {
      throw new Error('Paid prescription did not expose its initial dispensing state')
    }

    const submitDispense = (input: {
      expectedLotVersion: number
      expectedPrescriptionVersion: number
      idempotencyKey: ReturnType<typeof randomUUID>
      quantity: number
    }) => runtime.app.request(
      `/api/his/v1/prescriptions/${initial.prescriptionId}/actions/dispense`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${initial.encounterId}`]: initial.encounterVersion,
            [`MedicationRequest/${medication.medicationRequestId}`]: medication.medicationRequestVersion,
          },
          input: {
            expectedPrescriptionVersion: input.expectedPrescriptionVersion,
            lotSelections: [{
              expectedVersion: input.expectedLotVersion,
              lotId: lot.id,
              quantity: input.quantity,
            }],
          },
        }),
        headers: commandHeaders(pharmacistCookie, input.idempotencyKey),
        method: 'POST',
      },
    )

    const firstResponse = await submitDispense({
      expectedLotVersion: lot.version,
      expectedPrescriptionVersion: initial.prescriptionVersion,
      idempotencyKey: randomUUID(),
      quantity: 4,
    })
    expect(firstResponse.status).toBe(200)
    const first = dispenseResponseSchema.parse(await firstResponse.json())
    expect(first.data).toMatchObject({
      prescriptionVersion: 5,
      scenarioStatus: 'active',
      status: 'partial',
    })
    const firstDispense = await runtime.app.request(
      `/fhir/R5/MedicationDispense/${first.data.medicationDispenseIds[0]}`,
      { headers: { cookie: pharmacistCookie } },
    )
    expect(fhirResourceSchema.parse(await firstDispense.json())).toMatchObject({
      quantity: { value: 4 },
      status: 'completed',
    })
    const partialQueue = await runtime.app.request('/api/his/v1/pharmacy/queue?pageSize=20', {
      headers: { cookie: pharmacistCookie },
    })
    expect(pharmacyQueueSchema.parse(await partialQueue.json())).toMatchObject({
      items: [{
        medications: [{
          dispensedQuantity: 4,
          lots: [{ id: lot.id, quantityOnHand: 996, version: 2 }],
          remainingQuantity: 6,
        }],
        prescriptionVersion: 5,
        status: 'partially-dispensed',
      }],
      total: 1,
    })
    const activeScenario = await runtime.app.request('/api/sim/v1/scenario-runs/current', {
      headers: { cookie: pharmacistCookie },
    })
    expect(scenarioStateSchema.parse(await activeScenario.json())).toMatchObject({ status: 'active' })

    const secondResponse = await submitDispense({
      expectedLotVersion: 2,
      expectedPrescriptionVersion: 5,
      idempotencyKey: randomUUID(),
      quantity: 6,
    })
    expect(secondResponse.status).toBe(200)
    expect(dispenseResponseSchema.parse(await secondResponse.json())).toMatchObject({
      data: {
        prescriptionVersion: 6,
        scenarioStatus: 'completed',
        status: 'completed',
      },
    })
    const dispenseSearch = await runtime.app.request(
      '/fhir/R5/MedicationDispense?_total=accurate',
      { headers: { cookie: pharmacistCookie } },
    )
    expect(fhirBundleSchema.parse(await dispenseSearch.json())).toMatchObject({ total: 2 })
    const finalInventory = await runtime.app.request(`/fhir/R5/InventoryItem/${lot.id}`, {
      headers: { cookie: pharmacistCookie },
    })
    expect(fhirResourceSchema.parse(await finalInventory.json())).toMatchObject({
      meta: { versionId: '3' },
      netContent: { value: 990 },
    })
  })

  it.each([
    {
      action: 'install',
      body: { kind: 'candidate' },
      path: '/api/sim/v1/scenarios/actions/install',
    },
    {
      action: 'reset',
      body: {},
      path: '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
    },
  ] as const)('starts a new Scenario with $action after dispensing completes the current Scenario Run', async ({ body, path }) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-reinstall-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createPaidMedicationCase(runtime, password)
    const queueResponse = await runtime.app.request('/api/his/v1/pharmacy/queue?pageSize=20', {
      headers: { cookie: testCase.pharmacistCookie },
    })
    const prescription = pharmacyQueueSchema.parse(await queueResponse.json()).items[0]
    const medication = prescription?.medications[0]
    const lot = medication?.lots[0]
    if (prescription === undefined || medication === undefined || lot === undefined) {
      throw new Error('Paid prescription did not expose a dispensable synthetic lot')
    }

    const dispenseResponse = await runtime.app.request(
      `/api/his/v1/prescriptions/${prescription.prescriptionId}/actions/dispense`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${prescription.encounterId}`]: prescription.encounterVersion,
            [`MedicationRequest/${medication.medicationRequestId}`]: medication.medicationRequestVersion,
          },
          input: {
            expectedPrescriptionVersion: prescription.prescriptionVersion,
            lotSelections: [{
              expectedVersion: lot.version,
              lotId: lot.id,
              quantity: medication.quantity,
            }],
          },
        }),
        headers: commandHeaders(testCase.pharmacistCookie),
        method: 'POST',
      },
    )
    expect(dispenseResponse.status).toBe(200)
    expect(dispenseResponseSchema.parse(await dispenseResponse.json()).data).toMatchObject({
      scenarioStatus: 'completed',
      status: 'completed',
    })
    const readInitialRun = () => runtime.database.driver.prepare(`
      SELECT status, completed_at
      FROM scenario_run
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
    `).get('workspace-demo', 'epoch-1', 'scenario-run-1') as {
      completed_at: string | null
      status: string
    } | undefined
    const completedRun = readInitialRun()
    expect(completedRun).toEqual({
      completed_at: expect.any(String),
      status: 'completed',
    })

    const adminCookie = await signIn(runtime, 'admin@demo.clinmesh.local', password)
    const installResponse = await runtime.app.request(path, {
      body: JSON.stringify(body),
      headers: commandHeaders(adminCookie),
      method: 'POST',
    })
    expect(installResponse.status).toBe(200)
    expect(scenarioCommandResponseSchema.parse(await installResponse.json()).data).toMatchObject({
      epoch: 'epoch-2',
      kind: 'candidate',
      scenarioRunId: 'scenario-run-2',
    })
    expect(readInitialRun()).toEqual(completedRun)
  })

  it('creates one accurately referenced MedicationDispense for each dispensed prescription line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-multi-medication-dispense-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createPaidMedicationCase(runtime, password, [
      {
        catalogItemId: 'medication-oseltamivir',
        doseText: '75 mg',
        frequencyCode: 'BID',
        quantity: 10,
      },
      {
        catalogItemId: 'medication-acetaminophen',
        doseText: '0.5 g',
        frequencyCode: 'PRN',
        quantity: 6,
      },
    ])
    const queueResponse = await runtime.app.request('/api/his/v1/pharmacy/queue?pageSize=20', {
      headers: { cookie: testCase.pharmacistCookie },
    })
    const prescription = pharmacyQueueSchema.parse(await queueResponse.json()).items[0]
    if (prescription === undefined || prescription.medications.length !== 2) {
      throw new Error('The two-line prescription was not available for dispensing')
    }
    const lotSelections = prescription.medications.map(medication => {
      const lot = medication.lots[0]
      if (lot === undefined) throw new Error(`No inventory lot for ${medication.medicationId}`)
      return {
        expectedVersion: lot.version,
        lotId: lot.id,
        quantity: medication.remainingQuantity,
      }
    })
    const dispenseIdempotencyKey = randomUUID()
    const dispense = () => runtime.app.request(
      `/api/his/v1/prescriptions/${prescription.prescriptionId}/actions/dispense`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${prescription.encounterId}`]: prescription.encounterVersion,
            ...Object.fromEntries(prescription.medications.map(medication => [
              `MedicationRequest/${medication.medicationRequestId}`,
              medication.medicationRequestVersion,
            ])),
          },
          input: {
            expectedPrescriptionVersion: prescription.prescriptionVersion,
            lotSelections,
          },
        }),
        headers: commandHeaders(testCase.pharmacistCookie, dispenseIdempotencyKey),
        method: 'POST',
      },
    )
    const dispenseResponse = await dispense()
    expect(dispenseResponse.status).toBe(200)
    const result = dispenseResponseSchema.parse(await dispenseResponse.json())
    expect(result.data).toMatchObject({
      prescriptionId: prescription.prescriptionId,
      scenarioStatus: 'completed',
      status: 'completed',
    })
    expect(result.data.medicationDispenseIds).toHaveLength(2)
    expect(dispenseResponseSchema.parse(await (await dispense()).json())).toEqual(result)

    const medicationDispenses = await Promise.all(result.data.medicationDispenseIds.map(async id => {
      const response = await runtime.app.request(`/fhir/R5/MedicationDispense/${id}`, {
        headers: { cookie: testCase.pharmacistCookie },
      })
      expect(response.status).toBe(200)
      return fhirResourceSchema.parse(await response.json())
    }))
    expect(medicationDispenses).toEqual(expect.arrayContaining(
      prescription.medications.map(medication => expect.objectContaining({
        authorizingPrescription: [{
          reference: `MedicationRequest/${medication.medicationRequestId}`,
        }],
        medication: {
          reference: { reference: `Medication/${medication.medicationId}` },
        },
        quantity: { value: medication.quantity },
      })),
    ))
    const dispenseSearch = await runtime.app.request(
      '/fhir/R5/MedicationDispense?_total=accurate',
      { headers: { cookie: testCase.pharmacistCookie } },
    )
    expect(fhirBundleSchema.parse(await dispenseSearch.json())).toMatchObject({ total: 2 })
  })

  it('dispenses a paid prescription once, decrements the selected lot, and completes only the Scenario Run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-dispense-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const testCase = await createPaidMedicationCase(runtime, password)
    const pharmacistCookie = await signIn(runtime, 'pharmacist@demo.clinmesh.local', password)
    const queueResponse = await runtime.app.request('/api/his/v1/pharmacy/queue?pageSize=20', {
      headers: { cookie: pharmacistCookie },
    })
    expect(queueResponse.status).toBe(200)
    const queue = pharmacyQueueSchema.parse(await queueResponse.json())
    const prescription = queue.items[0]
    const medication = prescription?.medications[0]
    const lot = medication?.lots[0]
    expect({ prescription, medication, lot }).toMatchObject({
      lot: { quantityOnHand: 1000, version: 1 },
      medication: { quantity: 10 },
      prescription: {
        prescriptionId: testCase.draft.prescriptionId,
        prescriptionVersion: 4,
      },
    })
    if (prescription === undefined || medication === undefined || lot === undefined) {
      throw new Error('Paid prescription did not expose a dispensable synthetic lot')
    }

    const inventoryBefore = await runtime.app.request(
      `/fhir/R5/InventoryItem/${lot.id}`,
      { headers: { cookie: pharmacistCookie } },
    )
    expect(inventoryBefore.status).toBe(200)
    expect(inventoryBefore.headers.get('etag')).toBe('W/"1"')
    expect(fhirResourceSchema.parse(await inventoryBefore.json())).toMatchObject({
      id: lot.id,
      instance: {
        expiry: '2027-12-31',
        location: { reference: 'Location/location-pharmacist' },
        lotNumber: 'SYN-OSE-202608',
      },
      meta: { versionId: '1' },
      netContent: { value: 1000 },
      productReference: { reference: 'Medication/medication-oseltamivir' },
      resourceType: 'InventoryItem',
      status: 'active',
    })

    const dispenseIdempotencyKey = randomUUID()
    const dispense = () => runtime.app.request(
      `/api/his/v1/prescriptions/${prescription.prescriptionId}/actions/dispense`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${testCase.registration.encounterId}`]: '7',
            [`MedicationRequest/${medication.medicationRequestId}`]: '2',
          },
          input: {
            expectedPrescriptionVersion: prescription.prescriptionVersion,
            lotSelections: [{
              expectedVersion: lot.version,
              lotId: lot.id,
              quantity: medication.quantity,
            }],
          },
        }),
        headers: commandHeaders(pharmacistCookie, dispenseIdempotencyKey),
        method: 'POST',
      },
    )
    const dispenseResponse = await dispense()
    expect(dispenseResponse.status).toBe(200)
    const result = dispenseResponseSchema.parse(await dispenseResponse.json())
    expect(result.data).toMatchObject({
      prescriptionId: prescription.prescriptionId,
      prescriptionVersion: 5,
      scenarioStatus: 'completed',
      status: 'completed',
    })
    expect(dispenseResponseSchema.parse(await (await dispense()).json())).toEqual(result)

    const medicationDispense = await runtime.app.request(
      `/fhir/R5/MedicationDispense/${result.data.medicationDispenseIds[0]}`,
      { headers: { cookie: pharmacistCookie } },
    )
    expect(medicationDispense.status).toBe(200)
    expect(fhirResourceSchema.parse(await medicationDispense.json())).toMatchObject({
      authorizingPrescription: [{ reference: `MedicationRequest/${medication.medicationRequestId}` }],
      encounter: { reference: `Encounter/${testCase.registration.encounterId}` },
      status: 'completed',
    })
    const completedQueue = await runtime.app.request(
      '/api/his/v1/pharmacy/queue?status=completed&pageSize=20',
      { headers: { cookie: pharmacistCookie } },
    )
    expect(pharmacyQueueSchema.parse(await completedQueue.json())).toMatchObject({
      items: [{
        medications: [{ lots: [{ id: lot.id, quantityOnHand: 990, version: 2 }] }],
        prescriptionId: prescription.prescriptionId,
        prescriptionVersion: 5,
        status: 'completed',
      }],
      total: 1,
    })
    const inventoryAfter = await runtime.app.request(
      `/fhir/R5/InventoryItem/${lot.id}`,
      { headers: { cookie: pharmacistCookie } },
    )
    expect(inventoryAfter.status).toBe(200)
    expect(inventoryAfter.headers.get('etag')).toBe('W/"2"')
    expect(fhirResourceSchema.parse(await inventoryAfter.json())).toMatchObject({
      meta: { versionId: '2' },
      netContent: { value: 990 },
    })
    const inventoryHistory = await runtime.app.request(
      `/fhir/R5/InventoryItem/${lot.id}/_history`,
      { headers: { cookie: pharmacistCookie } },
    )
    expect(inventoryHistory.status).toBe(200)
    expect(fhirBundleSchema.parse(await inventoryHistory.json())).toMatchObject({
      entry: [
        { resource: { meta: { versionId: '2' }, netContent: { value: 990 } } },
        { resource: { meta: { versionId: '1' }, netContent: { value: 1000 } } },
      ],
      total: 2,
      type: 'history',
    })
    const encounterResponse = await runtime.app.request(
      `/fhir/R5/Encounter/${testCase.registration.encounterId}`,
      { headers: { cookie: pharmacistCookie } },
    )
    expect(fhirResourceSchema.parse(await encounterResponse.json())).toMatchObject({
      meta: { versionId: '7' },
      status: 'completed',
    })
    const scenarioResponse = await runtime.app.request('/api/sim/v1/scenario-runs/current', {
      headers: { cookie: pharmacistCookie },
    })
    expect(scenarioStateSchema.parse(await scenarioResponse.json())).toMatchObject({ status: 'completed' })
  })
})
