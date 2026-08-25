import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fhirBundleSchema,
  fhirDocumentBundleSchema,
  fhirResourceSchema,
} from '@clinmesh/contracts/fhir'
import {
  acknowledgeLaboratoryReportResponseSchema,
  apiErrorSchema,
  askConsultationQuestionResponseSchema,
  billingQueueSchema,
  cancelLaboratoryRequestRequestSchema,
  clinicalCatalogSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentRevisionResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  clinicalSignPreviewResponseSchema,
  clinicalSignResponseSchema,
  confirmDiagnosisResponseSchema,
  confirmNoMedicationResponseSchema,
  correctLaboratoryReportResponseSchema,
  createPatientResponseSchema,
  deleteLaboratoryRequestDraftRequestSchema,
  deletePrescriptionDraftRequestSchema,
  diagnosisDraftResponseSchema,
  dispenseResponseSchema,
  doctorCompletedCaseDetailSchema,
  doctorCompletedCaseListSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  firstVisitDraftResponseSchema,
  issueLaboratoryRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryRequestActionResponseSchema,
  laboratoryOrderResponseSchema,
  laboratoryRequestDraftResponseSchema,
  patientSearchSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  pharmacyQueueSchema,
  prescriptionDraftResponseSchema,
  prescriptionReviewResponseSchema,
  registrationQueueSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  revisitDraftResponseSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
  sessionContextSchema,
  startVirtualPatientResponseSchema,
  startVisitResponseSchema,
  triageQueueSchema,
  triageResponseSchema,
  virtualPatientListSchema,
  withdrawPrescriptionResponseSchema,
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

const structuredClinicalDocument = {
  assessment: '考虑急性上呼吸道感染，需结合检验结果进一步判断。',
  chiefComplaint: '发热伴咽痛一天。',
  disposition: '门诊观察，完善血常规和 C 反应蛋白检查。',
  followUp: '持续高热、气促或精神状态变差时立即复诊。',
  historyOfPresentIllness: '昨晚开始发热，最高体温 38.7 摄氏度，伴吞咽时咽痛，无气促。',
  physicalExamination: '神志清楚，咽部充血，双肺呼吸音清，未闻及干湿啰音。',
}

const revisedStructuredClinicalDocument = {
  ...structuredClinicalDocument,
  assessment: '复核检验结果后考虑甲型流感，当前生命体征稳定。',
  disposition: '继续门诊治疗，按医嘱口服抗病毒药物并充分休息。',
  followUp: '三天后复诊；持续高热或出现呼吸困难时立即就医。',
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

async function expectCommandAudit(
  runtime: TestRuntime,
  cookie: string,
  auditId: string,
  operation: string,
): Promise<void> {
  const response = await runtime.app.request(`/fhir/R5/AuditEvent/${auditId}`, {
    headers: { cookie },
  })
  expect(response.status).toBe(200)
  expect(fhirResourceSchema.parse(await response.json())).toMatchObject({
    code: { text: operation },
    outcome: { code: { code: '0' } },
  })
}

function expectCommandAuditOutcomes(
  runtime: TestRuntime,
  operation: string,
  outcomes: Array<'failed' | 'success'>,
): void {
  expect(new AuditQuery(runtime.database).list({
    epoch: 'epoch-1',
    workspaceId: 'workspace-demo',
  }).filter(event => event.operation === operation).map(event => event.outcome)).toEqual(outcomes)
}

function useLegacyMedicationCatalog(runtime: TestRuntime): void {
  const updateMedicationConfig = runtime.database.driver.prepare(`
    UPDATE outpatient_catalog SET config_json = ?
    WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
      AND kind = 'medication' AND item_id = ?
  `)
  updateMedicationConfig.run(
    '{"dose":"75 mg","frequency":"BID","allowedDoseTexts":["75 mg"],"allowedFrequencyCodes":["BID"],"allowedCombinationIds":["medication-acetaminophen"]}',
    'medication-oseltamivir',
  )
  updateMedicationConfig.run(
    '{"dose":"0.5 g","frequency":"PRN","allowedDoseTexts":["0.5 g"],"allowedFrequencyCodes":["PRN"],"allowedCombinationIds":["medication-oseltamivir"]}',
    'medication-acetaminophen',
  )
}

async function startVirtualPatientConsultation(runtime: TestRuntime, password: string) {
  const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
  const candidatesResponse = await runtime.app.request('/api/his/v1/doctor/virtual-patients', {
    headers: { cookie: doctorCookie },
  })
  const candidate = virtualPatientListSchema.parse(await candidatesResponse.json()).items[0]
  if (candidate === undefined) throw new Error('Candidate Virtual Patient was not seeded')
  const startResponse = await runtime.app.request(
    `/api/his/v1/doctor/virtual-patients/${candidate.id}/actions/start`, {
      body: JSON.stringify({
        expectedVersions: {},
        input: { expectedVersion: candidate.version },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'POST',
    },
  )
  const started = startVirtualPatientResponseSchema.parse(await startResponse.json()).data
  return { doctorCookie, started }
}

async function createIndependentReportedLaboratoryRequest(
  runtime: TestRuntime,
  password: string,
) {
  const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
  const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
  const draftResponse = await runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
    {
      body: JSON.stringify({
        expectedVersions,
        input: {
          catalogItemId: 'lab-cbc',
          expectedDraftVersion: 0,
          indicationCode: 'fever',
        },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'PUT',
    },
  )
  const draft = laboratoryRequestDraftResponseSchema.parse(await draftResponse.json()).data
  const issueResponse = await runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
    {
      body: JSON.stringify({
        expectedVersions,
        input: { expectedDraftVersion: draft.draftVersion },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'POST',
    },
  )
  const issued = issueLaboratoryRequestResponseSchema.parse(await issueResponse.json()).data.request
  for (const kind of [
    'laboratory.accept-request',
    'laboratory.start-request',
    'laboratory.report-request',
  ]) {
    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({ kind, status: 'completed' })
  }
  const detailResponse = await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.caseId}`,
    { headers: { cookie: doctorCookie } },
  )
  const request = doctorCaseDetailSchema.parse(
    await detailResponse.json(),
  ).laboratoryRequests?.requests.find(candidate => candidate.id === issued.id)
  if (request?.report === undefined) throw new Error('Independent laboratory report was not created')
  return { doctorCookie, request: { ...request, report: request.report }, started }
}

async function createSignedStructuredClinicalDocument(runtime: TestRuntime, password: string) {
  const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
  const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
  const draftResponse = await runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`,
    {
      body: JSON.stringify({
        expectedVersions,
        input: { document: structuredClinicalDocument, expectedDraftVersion: 0 },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'PUT',
    },
  )
  clinicalDocumentDraftResponseSchema.parse(await draftResponse.json())
  const previewResponse = await runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/preview-sign`,
    {
      body: JSON.stringify({
        expectedVersions,
        input: { expectedDraftVersion: 1 },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'POST',
    },
  )
  const preview = clinicalDocumentSignPreviewResponseSchema.parse(await previewResponse.json()).data
  const signResponse = await runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/sign`,
    {
      body: JSON.stringify({
        expectedVersions,
        input: {
          commitToken: preview.commitToken,
          previewId: preview.previewId,
        },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'POST',
    },
  )
  const signed = clinicalDocumentSignResponseSchema.parse(await signResponse.json()).data
  return { doctorCookie, expectedVersions, signed, started }
}

async function createCompletionReadyConsultation(
  runtime: TestRuntime,
  password: string,
  options: {
    diagnosis?: boolean | 'draft'
    diagnosisCatalogItemId?: 'diagnosis-acute-upper-respiratory-infection' | 'diagnosis-influenza'
    document?: boolean | 'draft'
    laboratory?: 'acknowledged' | 'reported'
    medication?: boolean | 'draft' | 'prescription' | 'withdrawn-prescription'
    pendingLaboratoryDraft?: boolean
  } = {},
) {
  const diagnosisMode = options.diagnosis ?? true
  const documentMode = options.document ?? true
  const medicationMode = options.medication ?? true
  const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
  const encounterReference = `Encounter/${started.encounterId}`
  let encounterVersion = '1'
  if (documentMode !== false) {
    const expectedVersions = { [encounterReference]: encounterVersion }
    const documentDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { document: structuredClinicalDocument, expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    const documentDraft = clinicalDocumentDraftResponseSchema.parse(
      await documentDraftResponse.json(),
    ).data
    if (documentMode !== 'draft') {
      const documentPreviewResponse = await runtime.app.request(
        `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/preview-sign`,
        {
          body: JSON.stringify({
            expectedVersions,
            input: { expectedDraftVersion: documentDraft.draftVersion },
          }),
          headers: commandHeaders(doctorCookie),
          method: 'POST',
        },
      )
      const documentPreview = clinicalDocumentSignPreviewResponseSchema.parse(
        await documentPreviewResponse.json(),
      ).data
      const documentSignResponse = await runtime.app.request(
        `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/sign`,
        {
          body: JSON.stringify({
            expectedVersions,
            input: {
              commitToken: documentPreview.commitToken,
              previewId: documentPreview.previewId,
            },
          }),
          headers: commandHeaders(doctorCookie),
          method: 'POST',
        },
      )
      clinicalDocumentSignResponseSchema.parse(await documentSignResponse.json())
    }
  }
  if (diagnosisMode !== false) {
    const expectedVersions = { [encounterReference]: encounterVersion }
    const diagnosisDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            entries: [{
              catalogItemId: options.diagnosisCatalogItemId ?? 'diagnosis-influenza',
              role: 'primary',
            }],
            expectedDraftVersion: 0,
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    const diagnosisDraft = diagnosisDraftResponseSchema.parse(
      await diagnosisDraftResponse.json(),
    ).data
    if (diagnosisMode !== 'draft') {
      const diagnosisResponse = await runtime.app.request(
        `/api/his/v1/encounters/${started.encounterId}/diagnosis/actions/confirm`,
        {
          body: JSON.stringify({
            expectedVersions,
            input: { expectedDraftVersion: diagnosisDraft.draftVersion },
          }),
          headers: commandHeaders(doctorCookie),
          method: 'POST',
        },
      )
      encounterVersion = confirmDiagnosisResponseSchema.parse(
        await diagnosisResponse.json(),
      ).data.encounterVersion
    }
  }
  if (
    medicationMode === 'draft'
    || medicationMode === 'prescription'
    || medicationMode === 'withdrawn-prescription'
  ) {
    const prescriptionDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: encounterVersion },
          input: {
            expectedDraftVersion: 0,
            items: [{
              catalogItemId: 'medication-oseltamivir',
              courseDays: 5,
              doseText: '75 mg',
              frequencyCode: 'BID',
              quantity: 10,
            }],
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    const prescriptionDraft = prescriptionDraftResponseSchema.parse(
      await prescriptionDraftResponse.json(),
    ).data
    if (medicationMode !== 'draft') {
      const issueResponse = await runtime.app.request(
        `/api/his/v1/encounters/${started.encounterId}/prescription/actions/issue`,
        {
          body: JSON.stringify({
            expectedVersions: { [encounterReference]: encounterVersion },
            input: { expectedDraftVersion: prescriptionDraft.draftVersion },
          }),
          headers: commandHeaders(doctorCookie),
          method: 'POST',
        },
      )
      const prescription = issuePrescriptionResponseSchema.parse(
        await issueResponse.json(),
      ).data.prescription
      if (medicationMode === 'withdrawn-prescription') {
        const withdrawResponse = await runtime.app.request(
          `/api/his/v1/prescriptions/${prescription.id}/actions/withdraw`,
          {
            body: JSON.stringify({
              expectedVersions: Object.fromEntries(prescription.items.map(item => [
                `MedicationRequest/${item.medicationRequestId}`,
                item.medicationRequestVersion,
              ])),
              input: { expectedPrescriptionVersion: prescription.version },
            }),
            headers: commandHeaders(doctorCookie),
            method: 'POST',
          },
        )
        withdrawPrescriptionResponseSchema.parse(await withdrawResponse.json())
      }
    }
  } else if (medicationMode) {
    const noMedicationResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/medication-conclusion/actions/confirm-no-medication`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: encounterVersion },
          input: { expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    confirmNoMedicationResponseSchema.parse(await noMedicationResponse.json())
  }
  let laboratoryDraftVersion = 0
  if (options.laboratory !== undefined) {
    const laboratoryDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: encounterVersion },
          input: {
            catalogItemId: 'lab-cbc',
            expectedDraftVersion: laboratoryDraftVersion,
            indicationCode: 'fever',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    laboratoryDraftVersion = laboratoryRequestDraftResponseSchema.parse(
      await laboratoryDraftResponse.json(),
    ).data.draftVersion
    const issueResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: encounterVersion },
          input: { expectedDraftVersion: laboratoryDraftVersion },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    const issued = issueLaboratoryRequestResponseSchema.parse(await issueResponse.json()).data
    laboratoryDraftVersion = issued.draftVersion
    for (const kind of [
      'laboratory.accept-request',
      'laboratory.start-request',
      'laboratory.report-request',
    ]) {
      expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({ kind, status: 'completed' })
    }
    if (options.laboratory === 'acknowledged') {
      const detailResponse = await runtime.app.request(
        `/api/his/v1/doctor/cases/${started.caseId}`,
        { headers: { cookie: doctorCookie } },
      )
      const request = doctorCaseDetailSchema.parse(
        await detailResponse.json(),
      ).laboratoryRequests?.requests.find(candidate => candidate.id === issued.request.id)
      if (request?.report === undefined) throw new Error('Completion test report was not created')
      const acknowledgeResponse = await runtime.app.request(
        `/api/his/v1/laboratory-requests/${request.id}/reports/${request.report.diagnosticReportId}/actions/acknowledge`,
        {
          body: JSON.stringify({
            expectedVersions: {
              [`DiagnosticReport/${request.report.diagnosticReportId}`]: request.report.diagnosticReportVersion,
            },
            input: { expectedRequestVersion: request.version },
          }),
          headers: commandHeaders(doctorCookie),
          method: 'POST',
        },
      )
      acknowledgeLaboratoryReportResponseSchema.parse(await acknowledgeResponse.json())
    }
  }
  if (options.pendingLaboratoryDraft === true) {
    const laboratoryDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [encounterReference]: encounterVersion },
          input: {
            catalogItemId: options.laboratory === undefined ? 'lab-cbc' : 'lab-crp',
            expectedDraftVersion: laboratoryDraftVersion,
            indicationCode: 'fever',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    laboratoryRequestDraftResponseSchema.parse(await laboratoryDraftResponse.json())
  }
  return {
    doctorCookie,
    encounterVersion,
    started,
  }
}

function seedAdditionalVirtualPatient(
  runtime: TestRuntime,
  input: { id: string; name: string; patientId: string },
): void {
  const repositoryContext = { epoch: 'epoch-1', workspaceId: 'workspace-demo' }
  runtime.fhir.create(repositoryContext, {
    resourceType: 'Patient',
    id: input.patientId,
    active: true,
    birthDate: '1990-06-15',
    gender: 'female',
    identifier: [{
      system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/synthetic-patient',
      value: `CM-SYN-${input.patientId.toUpperCase()}`,
    }],
    name: [{ text: input.name }],
  })
  runtime.database.driver.prepare(`
    INSERT INTO virtual_patient (
      workspace_id, epoch, virtual_patient_id, version, patient_id,
      clinical_summary_json, available
    ) VALUES ('workspace-demo', 'epoch-1', ?, 1, ?, ?, 1)
  `).run(input.id, input.patientId, JSON.stringify({
    chiefComplaint: '反复发热伴明显咽痛两天。',
    summary: '合成患者出现发热与咽部不适，需门诊评估。',
    vitalSigns: {
      bloodPressure: { diastolicMmHg: 78, systolicMmHg: 120 },
      oxygenSaturationPct: 98,
      pulseBpm: 94,
      respirationBpm: 19,
      temperatureC: 38.4,
    },
  }))
}

async function selectAdditionalDoctorRole(
  runtime: TestRuntime,
  password: string,
): Promise<string> {
  const repositoryContext = { epoch: 'epoch-1', workspaceId: 'workspace-demo' }
  runtime.fhir.create(repositoryContext, {
    resourceType: 'Practitioner',
    id: 'practitioner-library-doctor',
    active: true,
    name: [{ text: '合成病例库医生' }],
  })
  runtime.fhir.create(repositoryContext, {
    resourceType: 'PractitionerRole',
    id: 'practitioner-role-library-doctor',
    active: true,
    practitioner: { reference: 'Practitioner/practitioner-library-doctor' },
    organization: { reference: 'Organization/organization-clinmesh' },
    code: [{ text: 'outpatient-doctor' }],
    location: [{ reference: 'Location/location-outpatient-doctor' }],
  })
  runtime.database.driver.prepare(`
    INSERT INTO practitioner_role_binding (
      workspace_id, practitioner_role_id, practitioner_id, role_code,
      organization_id, location_id, active
    ) VALUES (?, ?, ?, 'outpatient-doctor', ?, ?, 1)
  `).run(
    'workspace-demo',
    'practitioner-role-library-doctor',
    'practitioner-library-doctor',
    'organization-clinmesh',
    'location-outpatient-doctor',
  )
  runtime.database.driver.prepare(`
    INSERT INTO membership_practitioner_role (
      membership_id, workspace_id, practitioner_role_id
    ) VALUES ('membership-administrator', ?, ?)
  `).run('workspace-demo', 'practitioner-role-library-doctor')
  const administratorCookie = await signIn(runtime, 'admin@demo.clinmesh.local', password)
  const selectRoleResponse = await runtime.app.request('/api/auth/role', {
    body: JSON.stringify({ practitionerRoleId: 'practitioner-role-library-doctor' }),
    headers: commandHeaders(administratorCookie),
    method: 'POST',
  })
  expect(selectRoleResponse.status).toBe(200)
  return administratorCookie
}

async function createIssuedIndependentPrescription(runtime: TestRuntime, password: string) {
  const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
  const diagnosisDraftResponse = await runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/diagnosis/draft`,
    {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
        input: {
          entries: [{ catalogItemId: 'diagnosis-influenza', role: 'primary' }],
          expectedDraftVersion: 0,
        },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'PUT',
    },
  )
  const diagnosisDraft = diagnosisDraftResponseSchema.parse(
    await diagnosisDraftResponse.json(),
  ).data
  const confirmDiagnosisResponse = await runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/diagnosis/actions/confirm`,
    {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
        input: { expectedDraftVersion: diagnosisDraft.draftVersion },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'POST',
    },
  )
  const encounterVersion = confirmDiagnosisResponseSchema.parse(
    await confirmDiagnosisResponse.json(),
  ).data.encounterVersion
  const draft = {
    items: [{
      catalogItemId: 'medication-oseltamivir',
      courseDays: 5,
      doseText: '75 mg',
      frequencyCode: 'BID',
      quantity: 10,
    }],
  }
  const prescriptionDraftResponse = await runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/prescription/draft`,
    {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: encounterVersion },
        input: { ...draft, expectedDraftVersion: 0 },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'PUT',
    },
  )
  const draftVersion = prescriptionDraftResponseSchema.parse(
    await prescriptionDraftResponse.json(),
  ).data.draftVersion
  const issueResponse = await runtime.app.request(
    `/api/his/v1/encounters/${started.encounterId}/prescription/actions/issue`,
    {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: encounterVersion },
        input: { expectedDraftVersion: draftVersion },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'POST',
    },
  )
  const issued = issuePrescriptionResponseSchema.parse(await issueResponse.json()).data
  return { doctorCookie, draft, encounterVersion, issued, started }
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

  it('returns formal facts from a completed sign-and-complete case', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-case-legacy-facts-http-'))
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

    const response = await runtime.app.request(
      `/api/his/v1/doctor/completed-cases/${testCase.caseId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )

    const responseBody: unknown = await response.json()
    expect(response.status, JSON.stringify(responseBody)).toBe(200)
    const detail = doctorCompletedCaseDetailSchema.parse(responseBody)
    expect(detail.clinicalDocuments).toEqual([
      expect.objectContaining({
        compositionId: testCase.signed.compositionId,
        content: {
          assessment: '甲型流感，生命体征稳定。',
          plan: '口服抗病毒药物，对症处理，必要时复诊。',
        },
        correctionSupported: false,
      }),
    ])
    expect(detail.diagnosis?.entries).toEqual([
      expect.objectContaining({
        code: 'J10.1',
        conditionId: testCase.draft.conditionId,
        role: 'primary',
      }),
    ])
    expect(detail.laboratoryRequests).toEqual([
      expect.objectContaining({
        correctionSupported: false,
        report: expect.objectContaining({
          diagnosticReportId: testCase.report.diagnosticReportId,
          results: expect.arrayContaining([
            expect.objectContaining({ code: '80382-5', value: true }),
            expect.objectContaining({ code: '6690-2', value: 6.8 }),
          ]),
        }),
        serviceRequestId: testCase.order.serviceRequestId,
      }),
    ])
    expect(detail.medicationConclusion?.prescription).toEqual(expect.objectContaining({
      id: testCase.draft.prescriptionId,
      items: [expect.objectContaining({
        medicationRequestId: testCase.draft.medicationRequestIds[0],
      })],
    }))
    expect(detail.timeline.map(event => event.reference)).toEqual(expect.arrayContaining([
      `ServiceRequest/${testCase.order.serviceRequestId}`,
      `DiagnosticReport/${testCase.report.diagnosticReportId}`,
      `Condition/${testCase.draft.conditionId}`,
      `Composition/${testCase.signed.compositionId}`,
      `Prescription/${testCase.draft.prescriptionId}`,
      `Encounter/${testCase.registration.encounterId}`,
    ]))

    const filteredResponse = await runtime.app.request(
      '/api/his/v1/doctor/completed-cases?diagnosisCatalogItemId=diagnosis-influenza&pageSize=20',
      { headers: { cookie: testCase.doctorCookie } },
    )

    expect(filteredResponse.status).toBe(200)
    expect(doctorCompletedCaseListSchema.parse(await filteredResponse.json())).toMatchObject({
      items: [{
        caseId: testCase.caseId,
        primaryDiagnosis: {
          catalogItemId: 'diagnosis-influenza',
          code: 'J10.1',
        },
      }],
      total: 1,
    })
  })

  it('rejects a malformed completed-case logical ID at the HTTP boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-case-invalid-id-http-'))
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

    const response = await runtime.app.request(
      '/api/his/v1/doctor/completed-cases/invalid%20case',
      { headers: { cookie: doctorCookie } },
    )

    expect(response.status).toBe(400)
    expect(apiErrorSchema.parse(await response.json())).toEqual({
      error: {
        code: 'INVALID_INPUT',
        message: 'The request is invalid',
      },
    })
  })

  it('lists a completed Encounter only for its responsible doctor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-case-library-http-'))
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
    const { doctorCookie, encounterVersion, started } = await createCompletionReadyConsultation(
      runtime,
      password,
    )
    const completedCaseLibrary = (cookie: string) => runtime.app.request(
      '/api/his/v1/doctor/completed-cases?pageSize=20',
      { headers: { cookie } },
    )

    const beforeCompletion = await completedCaseLibrary(doctorCookie)
    expect(beforeCompletion.status).toBe(200)
    expect(doctorCompletedCaseListSchema.parse(await beforeCompletion.json())).toEqual({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    })

    const completionResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/actions/complete`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: encounterVersion },
          input: {},
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    const completion = encounterCompletionResponseSchema.parse(await completionResponse.json())

    const responsibleDoctorLibrary = await completedCaseLibrary(doctorCookie)
    expect(responsibleDoctorLibrary.status).toBe(200)
    expect(doctorCompletedCaseListSchema.parse(
      await responsibleDoctorLibrary.json(),
    )).toMatchObject({
      items: [{
        caseId: started.caseId,
        completedAt: completion.data.completedAt,
        encounterId: started.encounterId,
        encounterVersion: completion.data.encounterVersion,
        patient: { id: started.patientId },
        primaryDiagnosis: {
          catalogItemId: 'diagnosis-influenza',
          code: 'J10.1',
          role: 'primary',
        },
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    })

    const administratorCookie = await selectAdditionalDoctorRole(runtime, password)

    const otherDoctorLibrary = await completedCaseLibrary(administratorCookie)
    expect(otherDoctorLibrary.status).toBe(200)
    expect(doctorCompletedCaseListSchema.parse(await otherDoctorLibrary.json())).toEqual({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    })
  })

  it('filters completed cases by the controlled Patient logical ID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-case-patient-filter-http-'))
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
    seedAdditionalVirtualPatient(runtime, {
      id: 'virtual-patient-fever-002',
      name: '合成患者林晓雨',
      patientId: 'candidate-patient-002',
    })
    const complete = async (candidate: Awaited<ReturnType<typeof createCompletionReadyConsultation>>) => {
      const response = await runtime.app.request(
        `/api/his/v1/encounters/${candidate.started.encounterId}/actions/complete`,
        {
          body: JSON.stringify({
            expectedVersions: {
              [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
            },
            input: {},
          }),
          headers: commandHeaders(candidate.doctorCookie),
          method: 'POST',
        },
      )
      expect(response.status).toBe(200)
      encounterCompletionResponseSchema.parse(await response.json())
    }
    const first = await createCompletionReadyConsultation(runtime, password)
    await complete(first)
    runtime.database.driver.prepare(`
      UPDATE scenario_epoch_state SET virtual_time = ?
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
    `).run('2026-08-24T10:00:00+08:00')
    const second = await createCompletionReadyConsultation(runtime, password)
    await complete(second)

    const response = await runtime.app.request(
      `/api/his/v1/doctor/completed-cases?patientId=${second.started.patientId}&pageSize=20`,
      { headers: { cookie: second.doctorCookie } },
    )

    expect(response.status).toBe(200)
    expect(doctorCompletedCaseListSchema.parse(await response.json())).toMatchObject({
      items: [{
        caseId: second.started.caseId,
        patient: {
          id: 'candidate-patient-002',
          name: '合成患者林晓雨',
        },
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    })
  })

  it('filters completed cases by an inclusive completion business-date range', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-case-date-filter-http-'))
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
    seedAdditionalVirtualPatient(runtime, {
      id: 'virtual-patient-fever-002',
      name: '合成患者林晓雨',
      patientId: 'candidate-patient-002',
    })
    const complete = async (candidate: Awaited<ReturnType<typeof createCompletionReadyConsultation>>) => {
      const response = await runtime.app.request(
        `/api/his/v1/encounters/${candidate.started.encounterId}/actions/complete`,
        {
          body: JSON.stringify({
            expectedVersions: {
              [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
            },
            input: {},
          }),
          headers: commandHeaders(candidate.doctorCookie),
          method: 'POST',
        },
      )
      return encounterCompletionResponseSchema.parse(await response.json())
    }
    const first = await createCompletionReadyConsultation(runtime, password)
    await complete(first)
    runtime.database.driver.prepare(`
      UPDATE scenario_epoch_state SET virtual_time = ?
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
    `).run('2026-08-25T08:30:00+08:00')
    const second = await createCompletionReadyConsultation(runtime, password)
    const secondCompletion = await complete(second)

    const response = await runtime.app.request(
      '/api/his/v1/doctor/completed-cases?completedFrom=2026-08-25&completedTo=2026-08-25&pageSize=20',
      { headers: { cookie: second.doctorCookie } },
    )

    expect(response.status).toBe(200)
    expect(doctorCompletedCaseListSchema.parse(await response.json())).toMatchObject({
      items: [{
        caseId: second.started.caseId,
        completedAt: secondCompletion.data.completedAt,
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    })
  })

  it('filters completed cases by a controlled diagnosis catalog item', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-case-diagnosis-filter-http-'))
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
    seedAdditionalVirtualPatient(runtime, {
      id: 'virtual-patient-fever-002',
      name: '合成患者林晓雨',
      patientId: 'candidate-patient-002',
    })
    const complete = async (candidate: Awaited<ReturnType<typeof createCompletionReadyConsultation>>) => {
      const response = await runtime.app.request(
        `/api/his/v1/encounters/${candidate.started.encounterId}/actions/complete`,
        {
          body: JSON.stringify({
            expectedVersions: {
              [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
            },
            input: {},
          }),
          headers: commandHeaders(candidate.doctorCookie),
          method: 'POST',
        },
      )
      expect(response.status).toBe(200)
      encounterCompletionResponseSchema.parse(await response.json())
    }
    const influenza = await createCompletionReadyConsultation(runtime, password)
    await complete(influenza)
    const upperRespiratoryInfection = await createCompletionReadyConsultation(runtime, password, {
      diagnosisCatalogItemId: 'diagnosis-acute-upper-respiratory-infection',
    })
    await complete(upperRespiratoryInfection)

    const response = await runtime.app.request(
      '/api/his/v1/doctor/completed-cases?diagnosisCatalogItemId=diagnosis-acute-upper-respiratory-infection&pageSize=20',
      { headers: { cookie: upperRespiratoryInfection.doctorCookie } },
    )

    expect(response.status).toBe(200)
    expect(doctorCompletedCaseListSchema.parse(await response.json())).toMatchObject({
      items: [{
        caseId: upperRespiratoryInfection.started.caseId,
        primaryDiagnosis: {
          catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
          code: 'J06.9',
        },
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    })
  })

  it('orders and paginates completed cases with a stable newest-first contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-case-order-http-'))
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
    seedAdditionalVirtualPatient(runtime, {
      id: 'virtual-patient-fever-002',
      name: '合成患者林晓雨',
      patientId: 'candidate-patient-002',
    })
    seedAdditionalVirtualPatient(runtime, {
      id: 'virtual-patient-fever-003',
      name: '合成患者周清和',
      patientId: 'candidate-patient-003',
    })
    const complete = async (candidate: Awaited<ReturnType<typeof createCompletionReadyConsultation>>) => {
      const response = await runtime.app.request(
        `/api/his/v1/encounters/${candidate.started.encounterId}/actions/complete`,
        {
          body: JSON.stringify({
            expectedVersions: {
              [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
            },
            input: {},
          }),
          headers: commandHeaders(candidate.doctorCookie),
          method: 'POST',
        },
      )
      expect(response.status).toBe(200)
    }
    const oldest = await createCompletionReadyConsultation(runtime, password)
    await complete(oldest)
    runtime.database.driver.prepare(`
      UPDATE scenario_epoch_state SET virtual_time = ?
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
    `).run('2026-08-24T10:00:00+08:00')
    const tiedFirst = await createCompletionReadyConsultation(runtime, password)
    await complete(tiedFirst)
    const tiedSecond = await createCompletionReadyConsultation(runtime, password)
    await complete(tiedSecond)
    const tiedCaseIds = [tiedFirst.started.caseId, tiedSecond.started.caseId].sort()

    const firstPageResponse = await runtime.app.request(
      '/api/his/v1/doctor/completed-cases?page=1&pageSize=2',
      { headers: { cookie: tiedSecond.doctorCookie } },
    )
    const secondPageResponse = await runtime.app.request(
      '/api/his/v1/doctor/completed-cases?page=2&pageSize=2',
      { headers: { cookie: tiedSecond.doctorCookie } },
    )

    expect(firstPageResponse.status).toBe(200)
    expect(doctorCompletedCaseListSchema.parse(await firstPageResponse.json())).toMatchObject({
      items: tiedCaseIds.map(caseId => ({ caseId, completedAt: '2026-08-24T10:00:00+08:00' })),
      page: 1,
      pageSize: 2,
      total: 3,
    })
    expect(secondPageResponse.status).toBe(200)
    expect(doctorCompletedCaseListSchema.parse(await secondPageResponse.json())).toMatchObject({
      items: [{ caseId: oldest.started.caseId, completedAt: '2026-08-24T09:00:00+08:00' }],
      page: 2,
      pageSize: 2,
      total: 3,
    })
  })

  it('protects completed case detail and revision with the responsible doctor assignment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-case-detail-http-'))
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
    const candidate = await createCompletionReadyConsultation(runtime, password)
    const detail = (cookie: string) => runtime.app.request(
      `/api/his/v1/doctor/completed-cases/${candidate.started.caseId}`,
      { headers: { cookie } },
    )

    const beforeCompletion = await detail(candidate.doctorCookie)
    expect(beforeCompletion.status).toBe(409)
    expect(apiErrorSchema.parse(await beforeCompletion.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })

    const completionResponse = await runtime.app.request(
      `/api/his/v1/encounters/${candidate.started.encounterId}/actions/complete`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
          },
          input: {},
        }),
        headers: commandHeaders(candidate.doctorCookie),
        method: 'POST',
      },
    )
    const completion = encounterCompletionResponseSchema.parse(await completionResponse.json())

    const ownerResponse = await detail(candidate.doctorCookie)
    expect(ownerResponse.status).toBe(200)
    const ownerDetail = doctorCompletedCaseDetailSchema.parse(await ownerResponse.json())
    expect(ownerDetail).toMatchObject({
      caseId: candidate.started.caseId,
      clinicalDocuments: [{
        content: structuredClinicalDocument,
        correctionSupported: true,
        revisionNumber: 1,
      }],
      completedAt: completion.data.completedAt,
      encounter: {
        id: candidate.started.encounterId,
        status: 'completed',
        versionId: completion.data.encounterVersion,
      },
      patient: { id: candidate.started.patientId },
    })
    expect(ownerDetail).not.toHaveProperty('drafts')

    const otherDoctorCookie = await selectAdditionalDoctorRole(runtime, password)
    const otherDoctorResponse = await detail(otherDoctorCookie)
    expect(otherDoctorResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await otherDoctorResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })

    const signedDocument = ownerDetail.clinicalDocuments.at(-1)
    if (signedDocument === undefined) throw new Error('Completion test document was not signed')
    const unauthorizedRevisionResponse = await runtime.app.request(
      `/api/his/v1/clinical-documents/${signedDocument.compositionId}/actions/revise`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Composition/${signedDocument.compositionId}`]: signedDocument.compositionVersion,
            [`Encounter/${ownerDetail.encounter.id}`]: ownerDetail.encounter.versionId,
          },
          input: {
            document: structuredClinicalDocument,
            reason: '非责任医生不应提交此项更正。',
          },
        }),
        headers: commandHeaders(otherDoctorCookie),
        method: 'POST',
      },
    )
    expect(unauthorizedRevisionResponse.status).toBe(403)
    expect(apiErrorSchema.parse(await unauthorizedRevisionResponse.json())).toMatchObject({
      error: { code: 'ROLE_NOT_ALLOWED' },
    })

    const unchangedOwnerResponse = await detail(candidate.doctorCookie)
    expect(unchangedOwnerResponse.status).toBe(200)
    expect(doctorCompletedCaseDetailSchema.parse(
      await unchangedOwnerResponse.json(),
    ).clinicalDocuments).toHaveLength(1)
  })

  it('returns completed case facts from each clinical owner without drafts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-case-owner-facts-http-'))
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
    const candidate = await createCompletionReadyConsultation(runtime, password, {
      laboratory: 'acknowledged',
      medication: 'prescription',
    })
    const questionResponse = await runtime.app.request(
      `/api/his/v1/encounters/${candidate.started.encounterId}/actions/ask-consultation-question`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
            [`Task/${candidate.started.queueTaskId}`]: '1',
          },
          input: { expectedVersion: 1, questionCode: 'symptom-onset' },
        }),
        headers: commandHeaders(candidate.doctorCookie),
        method: 'POST',
      },
    )
    const consultationRecord = askConsultationQuestionResponseSchema.parse(
      await questionResponse.json(),
    ).data.record
    const completionResponse = await runtime.app.request(
      `/api/his/v1/encounters/${candidate.started.encounterId}/actions/complete`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
          },
          input: {},
        }),
        headers: commandHeaders(candidate.doctorCookie),
        method: 'POST',
      },
    )
    expect(completionResponse.status).toBe(200)
    encounterCompletionResponseSchema.parse(await completionResponse.json())

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/completed-cases/${candidate.started.caseId}`,
      { headers: { cookie: candidate.doctorCookie } },
    )

    expect(detailResponse.status).toBe(200)
    const detail = doctorCompletedCaseDetailSchema.parse(await detailResponse.json())
    expect(detail).toMatchObject({
      consultation: {
        records: [{
          answer: consultationRecord.answer,
          id: consultationRecord.id,
          question: consultationRecord.question,
          sequence: 1,
        }],
        version: 2,
      },
      diagnosis: {
        entries: [{
          catalogItemId: 'diagnosis-influenza',
          code: 'J10.1',
          role: 'primary',
        }],
      },
      laboratoryRequests: [{
        catalogItemId: 'lab-cbc',
        correctionSupported: true,
        report: { acknowledgement: { id: expect.any(String) } },
        status: 'acknowledged',
      }],
      medicationConclusion: {
        prescription: {
          items: [{ catalogItemId: 'medication-oseltamivir' }],
          status: 'signed',
        },
      },
    })
    expect(JSON.stringify(detail)).not.toMatch(/"draft(?:Version)?"/)
  })

  it('preserves clinical version chains in a stable completed-case timeline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-completed-case-timeline-http-'))
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
    const candidate = await createCompletionReadyConsultation(runtime, password, {
      laboratory: 'acknowledged',
      medication: 'prescription',
    })
    const activeDetailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${candidate.started.caseId}`,
      { headers: { cookie: candidate.doctorCookie } },
    )
    const activeDetail = doctorCaseDetailSchema.parse(await activeDetailResponse.json())
    const originalDocument = activeDetail.clinicalDocument?.signed[0]
    const originalRequest = activeDetail.laboratoryRequests?.requests[0]
    const laboratoryDraftVersion = activeDetail.laboratoryRequests?.draftVersion
    if (
      originalDocument === undefined
      || originalRequest?.report === undefined
      || laboratoryDraftVersion === undefined
    ) {
      throw new Error('Completed-case timeline fixture is missing signed owner facts')
    }
    const setVirtualTime = (value: string) => runtime.database.driver.prepare(`
      UPDATE scenario_epoch_state SET virtual_time = ?
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
    `).run(value)

    setVirtualTime('2026-08-24T09:30:00+08:00')
    const cancellationDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${candidate.started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
          },
          input: {
            catalogItemId: 'lab-crp',
            expectedDraftVersion: laboratoryDraftVersion,
            indicationCode: 'fever',
          },
        }),
        headers: commandHeaders(candidate.doctorCookie),
        method: 'PUT',
      },
    )
    const cancellationDraft = laboratoryRequestDraftResponseSchema.parse(
      await cancellationDraftResponse.json(),
    ).data
    const cancellationIssueResponse = await runtime.app.request(
      `/api/his/v1/encounters/${candidate.started.encounterId}/laboratory-request/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
          },
          input: { expectedDraftVersion: cancellationDraft.draftVersion },
        }),
        headers: commandHeaders(candidate.doctorCookie),
        method: 'POST',
      },
    )
    const requestToCancel = issueLaboratoryRequestResponseSchema.parse(
      await cancellationIssueResponse.json(),
    ).data.request
    const cancellationResponse = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${requestToCancel.id}/actions/cancel`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`ServiceRequest/${requestToCancel.serviceRequestId}`]
              : requestToCancel.serviceRequestVersion,
            [`Task/${requestToCancel.taskId}`]: requestToCancel.taskVersion,
          },
          input: {
            expectedRequestVersion: requestToCancel.version,
            reasonCode: 'no-longer-needed',
          },
        }),
        headers: commandHeaders(candidate.doctorCookie),
        method: 'POST',
      },
    )
    expect(cancellationResponse.status).toBe(200)
    laboratoryRequestActionResponseSchema.parse(await cancellationResponse.json())

    setVirtualTime('2026-08-24T10:00:00+08:00')
    const revisionResponse = await runtime.app.request(
      `/api/his/v1/clinical-documents/${originalDocument.compositionId}/actions/revise`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Composition/${originalDocument.compositionId}`]: originalDocument.compositionVersion,
            [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
          },
          input: {
            document: revisedStructuredClinicalDocument,
            reason: '复核检验结果后更正评估、处置和随访。',
          },
        }),
        headers: commandHeaders(candidate.doctorCookie),
        method: 'POST',
      },
    )
    const revision = clinicalDocumentRevisionResponseSchema.parse(await revisionResponse.json()).data

    setVirtualTime('2026-08-24T11:00:00+08:00')
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
    expect(sessionContextSchema.parse(await actingDoctorResponse.json()).actor).toMatchObject({
      actorId: 'actor-administrator',
      roleCode: 'outpatient-doctor',
    })
    const correctionResponse = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${originalRequest.id}/reports/${originalRequest.report.diagnosticReportId}/actions/correct`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`DiagnosticReport/${originalRequest.report.diagnosticReportId}`]: originalRequest.report.diagnosticReportVersion,
          },
          input: {
            conclusion: '复核后白细胞计数位于参考范围内。',
            expectedRequestVersion: originalRequest.version,
            reason: '复核仪器原始数据后更正白细胞计数。',
            results: originalRequest.report.results.map(result => ({
              code: result.code,
              value: result.code === '6690-2' ? 9.4 : result.value,
            })),
          },
        }),
        headers: commandHeaders(administratorCookie),
        method: 'POST',
      },
    )
    const correction = correctLaboratoryReportResponseSchema.parse(
      await correctionResponse.json(),
    ).data

    setVirtualTime('2026-08-24T12:00:00+08:00')
    const correctedDetailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${candidate.started.caseId}`,
      { headers: { cookie: candidate.doctorCookie } },
    )
    const correctedRequest = doctorCaseDetailSchema.parse(
      await correctedDetailResponse.json(),
    ).laboratoryRequests?.requests[0]
    if (correctedRequest?.report === undefined) {
      throw new Error('Corrected laboratory report was not available for acknowledgement')
    }
    const acknowledgementResponse = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${correctedRequest.id}/reports/${correctedRequest.report.diagnosticReportId}/actions/acknowledge`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`DiagnosticReport/${correctedRequest.report.diagnosticReportId}`]: correctedRequest.report.diagnosticReportVersion,
          },
          input: { expectedRequestVersion: correctedRequest.version },
        }),
        headers: commandHeaders(candidate.doctorCookie),
        method: 'POST',
      },
    )
    const acknowledgement = acknowledgeLaboratoryReportResponseSchema.parse(
      await acknowledgementResponse.json(),
    ).data

    setVirtualTime('2026-08-24T13:00:00+08:00')
    const completionResponse = await runtime.app.request(
      `/api/his/v1/encounters/${candidate.started.encounterId}/actions/complete`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
          },
          input: {},
        }),
        headers: commandHeaders(candidate.doctorCookie),
        method: 'POST',
      },
    )
    expect(completionResponse.status).toBe(200)
    encounterCompletionResponseSchema.parse(await completionResponse.json())

    const libraryDetailResponse = await runtime.app.request(
      `/api/his/v1/doctor/completed-cases/${candidate.started.caseId}`,
      { headers: { cookie: candidate.doctorCookie } },
    )

    expect(libraryDetailResponse.status).toBe(200)
    const libraryDetail = doctorCompletedCaseDetailSchema.parse(await libraryDetailResponse.json())
    expect(libraryDetail.clinicalDocuments).toMatchObject([
      { compositionId: originalDocument.compositionId, revisionNumber: 1 },
      {
        compositionId: revision.compositionId,
        revisionNumber: 2,
        revisionOfCompositionId: originalDocument.compositionId,
      },
    ])
    expect(libraryDetail.laboratoryRequests.find(
      request => request.id === originalRequest.id,
    )).toMatchObject({
      previousReports: [{
        diagnosticReportId: originalRequest.report.diagnosticReportId,
        revisionNumber: 1,
      }],
      report: {
        acknowledgement: { id: acknowledgement.acknowledgementId },
        diagnosticReportId: correction.diagnosticReportId,
        revisionNumber: 2,
        revisionOfDiagnosticReportId: originalRequest.report.diagnosticReportId,
      },
    })
    expect(libraryDetail.laboratoryRequests.find(
      request => request.id === requestToCancel.id,
    )).toMatchObject({ id: requestToCancel.id, status: 'cancelled' })
    expect(libraryDetail.timeline).toContainEqual(expect.objectContaining({
      kind: 'laboratory-request-cancelled',
      occurredAt: '2026-08-24T09:30:00+08:00',
      reference: `LaboratoryRequest/${requestToCancel.id}`,
      relatedReferences: [
        `ServiceRequest/${requestToCancel.serviceRequestId}`,
        `Task/${requestToCancel.taskId}`,
      ],
    }))
    expect(libraryDetail.timeline.slice(-4)).toEqual([
      expect.objectContaining({
        kind: 'clinical-document-revised',
        occurredAt: '2026-08-24T10:00:00+08:00',
        reference: `Composition/${revision.compositionId}`,
      }),
      expect.objectContaining({
        kind: 'laboratory-report-revised',
        occurredAt: '2026-08-24T11:00:00+08:00',
        reference: `DiagnosticReport/${correction.diagnosticReportId}`,
      }),
      expect.objectContaining({
        kind: 'laboratory-report-acknowledged',
        occurredAt: '2026-08-24T12:00:00+08:00',
        reference: `ReportAcknowledgement/${acknowledgement.acknowledgementId}`,
      }),
      expect.objectContaining({
        kind: 'encounter-completed',
        occurredAt: '2026-08-24T13:00:00+08:00',
        reference: `Encounter/${candidate.started.encounterId}`,
      }),
    ])
  })

  it('previews every Encounter completion condition from formal owner facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-encounter-completion-preview-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)

    const response = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/completion`,
      { headers: { cookie: doctorCookie } },
    )

    expect(response.status).toBe(200)
    expect(encounterCompletionPreviewSchema.parse(await response.json())).toEqual({
      canComplete: false,
      encounterId: started.encounterId,
      encounterVersion: '1',
      items: [
        {
          code: 'primary-diagnosis-confirmed',
          status: 'incomplete',
          statusText: '待确认主诊断',
          target: 'diagnosis',
        },
        {
          code: 'clinical-document-signed',
          status: 'incomplete',
          statusText: '待签署结构化病历',
          target: 'clinical-document',
        },
        {
          code: 'required-reports-acknowledged',
          status: 'complete',
          statusText: '必要报告已全部确认已阅',
          target: 'laboratory',
        },
        {
          code: 'medication-conclusion-recorded',
          status: 'incomplete',
          statusText: '待记录用药结论',
          target: 'medication-conclusion',
        },
        {
          code: 'no-pending-drafts',
          status: 'complete',
          statusText: '无未处理临床草稿',
          target: 'clinical-document',
        },
        {
          code: 'disposition-complete',
          status: 'incomplete',
          statusText: '待完善处置',
          target: 'clinical-document',
        },
        {
          code: 'follow-up-complete',
          status: 'incomplete',
          statusText: '待完善随访安排',
          target: 'clinical-document',
        },
      ],
    })
  })

  it('checks Encounter completion authorization before resource versions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-encounter-completion-role-http-'))
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
    const { started } = await startVirtualPatientConsultation(runtime, password)
    const cashierCookie = await signIn(runtime, 'cashier@demo.clinmesh.local', password)

    const response = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/actions/complete`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '999' },
          input: {},
        }),
        headers: commandHeaders(cashierCookie),
        method: 'POST',
      },
    )

    expect(response.status).toBe(403)
    expect(apiErrorSchema.parse(await response.json())).toEqual({
      error: {
        code: 'ROLE_NOT_ALLOWED',
        message: 'The active Practitioner Role cannot perform this action',
      },
    })
  })

  it('binds the completion expected version to the target Encounter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-encounter-completion-binding-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)

    const response = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/actions/complete`,
      {
        body: JSON.stringify({
          expectedVersions: { 'Encounter/another-encounter': '1' },
          input: {},
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    expect(response.status).toBe(409)
    expect(apiErrorSchema.parse(await response.json())).toEqual({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: `Expected versions must contain only Encounter/${started.encounterId}`,
      },
    })
  })

  it('completes only the Encounter and replays the successful completion receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-encounter-completion-http-'))
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
    const downstreamCase = await createPaidMedicationCase(runtime, password)
    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({
      kind: 'pharmacy.ready',
      status: 'completed',
    })
    const { doctorCookie, encounterVersion, started } = await createCompletionReadyConsultation(
      runtime,
      password,
      { laboratory: 'acknowledged', medication: 'prescription' },
    )
    const previewResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/completion`,
      { headers: { cookie: doctorCookie } },
    )
    expect(encounterCompletionPreviewSchema.parse(await previewResponse.json())).toMatchObject({
      canComplete: true,
      encounterVersion,
      items: expect.arrayContaining([
        expect.objectContaining({ code: 'required-reports-acknowledged', status: 'complete' }),
        expect.objectContaining({ code: 'medication-conclusion-recorded', status: 'complete' }),
        expect.objectContaining({ code: 'no-pending-drafts', status: 'complete' }),
      ]),
    })
    const caseBefore = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    const taskBefore = fhirResourceSchema.parse(await (await runtime.app.request(
      `/fhir/R5/Task/${started.queueTaskId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    const registrationBefore = runtime.database.driver.prepare(`
      SELECT * FROM registration
      WHERE workspace_id = ? AND epoch = ? AND registration_id = ?
    `).get('workspace-demo', 'epoch-1', started.registrationId)
    const chargeItemBefore = fhirResourceSchema.parse(await (await runtime.app.request(
      `/fhir/R5/ChargeItem/${downstreamCase.signed.chargeItemId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    const billingBefore = billingQueueSchema.parse(await (await runtime.app.request(
      '/api/his/v1/billing/queue?category=medication&status=paid&pageSize=20',
      { headers: { cookie: downstreamCase.cashierCookie } },
    )).json())
    expect(billingBefore).toMatchObject({
      items: [{ caseId: downstreamCase.caseId, status: 'paid' }],
      total: 1,
    })
    const pharmacyBefore = pharmacyQueueSchema.parse(await (await runtime.app.request(
      '/api/his/v1/pharmacy/queue?status=pending&pageSize=20',
      { headers: { cookie: downstreamCase.pharmacistCookie } },
    )).json())
    expect(pharmacyBefore).toMatchObject({
      items: [{ caseId: downstreamCase.caseId, status: 'awaiting-dispense' }],
      total: 1,
    })
    const scenarioBefore = scenarioStateSchema.parse(await (await runtime.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie: doctorCookie } },
    )).json())
    const idempotencyKey = randomUUID()
    const complete = () => runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/actions/complete`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: encounterVersion },
          input: {},
        }),
        headers: commandHeaders(doctorCookie, idempotencyKey),
        method: 'POST',
      },
    )

    const response = await complete()

    expect(response.status).toBe(200)
    const completed = encounterCompletionResponseSchema.parse(await response.json())
    expect(completed).toMatchObject({
      data: {
        completedAt: expect.any(String),
        encounterId: started.encounterId,
        encounterVersion: '3',
        status: 'completed',
      },
      effects: [{
        kind: 'updated',
        reference: `Encounter/${started.encounterId}`,
        versionId: '3',
      }],
    })
    const replay = await complete()
    expect(replay.status).toBe(200)
    expect(encounterCompletionResponseSchema.parse(await replay.json())).toEqual(completed)
    const encounter = fhirResourceSchema.parse(await (await runtime.app.request(
      `/fhir/R5/Encounter/${started.encounterId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    expect(encounter).toMatchObject({
      actualPeriod: { end: completed.data.completedAt },
      meta: { versionId: '3' },
      status: 'completed',
    })
    expect(fhirResourceSchema.parse(await (await runtime.app.request(
      `/fhir/R5/Task/${started.queueTaskId}`,
      { headers: { cookie: doctorCookie } },
    )).json())).toEqual(taskBefore)
    expect(scenarioStateSchema.parse(await (await runtime.app.request(
      '/api/sim/v1/scenario-runs/current',
      { headers: { cookie: doctorCookie } },
    )).json())).toEqual(scenarioBefore)
    expect(doctorQueueSchema.parse(await (await runtime.app.request(
      '/api/his/v1/doctor/queue?pageSize=20',
      { headers: { cookie: doctorCookie } },
    )).json())).toMatchObject({ items: [], total: 0 })
    const caseAfter = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )).json())
    expect(caseAfter).toEqual({
      ...caseBefore,
      encounter: {
        ...caseBefore.encounter,
        status: 'completed',
        versionId: '3',
      },
    })
    expect(runtime.database.driver.prepare(`
      SELECT * FROM registration
      WHERE workspace_id = ? AND epoch = ? AND registration_id = ?
    `).get('workspace-demo', 'epoch-1', started.registrationId)).toEqual(registrationBefore)
    expect(pharmacyQueueSchema.parse(await (await runtime.app.request(
      '/api/his/v1/pharmacy/queue?status=pending&pageSize=20',
      { headers: { cookie: downstreamCase.pharmacistCookie } },
    )).json())).toEqual(pharmacyBefore)
    expect(billingQueueSchema.parse(await (await runtime.app.request(
      '/api/his/v1/billing/queue?category=medication&status=paid&pageSize=20',
      { headers: { cookie: downstreamCase.cashierCookie } },
    )).json())).toEqual(billingBefore)
    expect(fhirResourceSchema.parse(await (await runtime.app.request(
      `/fhir/R5/ChargeItem/${downstreamCase.signed.chargeItemId}`,
      { headers: { cookie: doctorCookie } },
    )).json())).toEqual(chargeItemBefore)
    expect(fhirResourceSchema.parse(await (await runtime.app.request(
      `/fhir/R5/AuditEvent/${completed.auditId}`,
      { headers: { cookie: doctorCookie } },
    )).json())).toMatchObject({
      code: { coding: [expect.objectContaining({ code: 'encounter.complete' })] },
      outcome: { code: expect.objectContaining({ code: '0' }) },
    })
  })

  it('atomically rejects each independently observable Encounter completion blocker', async () => {
    const cases: Array<{
      expectedCodes: string[]
      expectedPendingDraftTarget?: string
      expectedStatusTexts: string[]
      options: Parameters<typeof createCompletionReadyConsultation>[2]
    }> = [
      {
        expectedCodes: ['primary-diagnosis-confirmed'],
        expectedStatusTexts: ['待确认主诊断'],
        options: { diagnosis: false },
      },
      // A signed document always has valid disposition and follow-up fields by contract.
      {
        expectedCodes: [
          'clinical-document-signed',
          'disposition-complete',
          'follow-up-complete',
        ],
        expectedStatusTexts: ['待签署结构化病历', '待完善处置', '待完善随访安排'],
        options: { document: false },
      },
      {
        expectedCodes: [
          'clinical-document-signed',
          'no-pending-drafts',
          'disposition-complete',
          'follow-up-complete',
        ],
        expectedPendingDraftTarget: 'clinical-document',
        expectedStatusTexts: [
          '待签署结构化病历',
          '存在未处理临床草稿',
          '待完善处置',
          '待完善随访安排',
        ],
        options: { document: 'draft' },
      },
      {
        expectedCodes: ['primary-diagnosis-confirmed', 'no-pending-drafts'],
        expectedPendingDraftTarget: 'diagnosis',
        expectedStatusTexts: ['待确认主诊断', '存在未处理临床草稿'],
        options: { diagnosis: 'draft' },
      },
      {
        expectedCodes: ['medication-conclusion-recorded'],
        expectedStatusTexts: ['待记录用药结论'],
        options: { medication: false },
      },
      {
        expectedCodes: ['medication-conclusion-recorded'],
        expectedStatusTexts: ['待记录用药结论'],
        options: { medication: 'withdrawn-prescription' },
      },
      {
        expectedCodes: ['medication-conclusion-recorded', 'no-pending-drafts'],
        expectedPendingDraftTarget: 'medication-conclusion',
        expectedStatusTexts: ['待记录用药结论', '存在未处理临床草稿'],
        options: { medication: 'draft' },
      },
      {
        expectedCodes: ['required-reports-acknowledged'],
        expectedStatusTexts: ['待确认必要报告已阅'],
        options: { laboratory: 'reported' },
      },
      {
        expectedCodes: ['no-pending-drafts'],
        expectedPendingDraftTarget: 'laboratory',
        expectedStatusTexts: ['存在未处理临床草稿'],
        options: { pendingLaboratoryDraft: true },
      },
    ]
    for (const testCase of cases) {
      const directory = await mkdtemp(join(tmpdir(), 'clinmesh-encounter-completion-blocker-http-'))
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
      const candidate = await createCompletionReadyConsultation(
        runtime,
        password,
        testCase.options,
      )
      const encounterBefore = fhirResourceSchema.parse(await (await runtime.app.request(
        `/fhir/R5/Encounter/${candidate.started.encounterId}`,
        { headers: { cookie: candidate.doctorCookie } },
      )).json())
      const preview = encounterCompletionPreviewSchema.parse(await (await runtime.app.request(
        `/api/his/v1/encounters/${candidate.started.encounterId}/completion`,
        { headers: { cookie: candidate.doctorCookie } },
      )).json())
      expect(preview.canComplete).toBe(false)
      expect(preview.items.filter(item => item.status === 'incomplete').map(item => item.code)).toEqual(
        testCase.expectedCodes,
      )
      if (testCase.expectedPendingDraftTarget !== undefined) {
        expect(preview.items.find(item => item.code === 'no-pending-drafts')?.target).toBe(
          testCase.expectedPendingDraftTarget,
        )
      }

      const response = await runtime.app.request(
        `/api/his/v1/encounters/${candidate.started.encounterId}/actions/complete`,
        {
          body: JSON.stringify({
            expectedVersions: {
              [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
            },
            input: {},
          }),
          headers: commandHeaders(candidate.doctorCookie),
          method: 'POST',
        },
      )

      expect(response.status).toBe(409)
      expect(apiErrorSchema.parse(await response.json())).toEqual({
        error: {
          code: 'ENCOUNTER_COMPLETION_BLOCKED',
          message: `完诊条件未满足：${testCase.expectedStatusTexts.join('；')}`,
        },
      })
      expect(fhirResourceSchema.parse(await (await runtime.app.request(
        `/fhir/R5/Encounter/${candidate.started.encounterId}`,
        { headers: { cookie: candidate.doctorCookie } },
      )).json())).toEqual(encounterBefore)
      expect(doctorQueueSchema.parse(await (await runtime.app.request(
        '/api/his/v1/doctor/queue?pageSize=20',
        { headers: { cookie: candidate.doctorCookie } },
      )).json())).toMatchObject({ total: 1 })
      expect(new AuditQuery(runtime.database).list({
        epoch: 'epoch-1',
        workspaceId: 'workspace-demo',
      })).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'encounter.complete', outcome: 'failed' }),
      ]))
    }
  })

  it('allows only one completion command for the same expected Encounter version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-encounter-completion-cas-http-'))
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
    const candidate = await createCompletionReadyConsultation(runtime, password)
    const complete = () => runtime.app.request(
      `/api/his/v1/encounters/${candidate.started.encounterId}/actions/complete`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${candidate.started.encounterId}`]: candidate.encounterVersion,
          },
          input: {},
        }),
        headers: commandHeaders(candidate.doctorCookie),
        method: 'POST',
      },
    )

    const responses = await Promise.all([complete(), complete()])

    expect(responses.map(response => response.status).toSorted()).toEqual([200, 409])
    const successful = responses.find(response => response.status === 200)
    const rejected = responses.find(response => response.status === 409)
    if (successful === undefined || rejected === undefined) {
      throw new Error('Encounter completion race did not produce one winner')
    }
    expect(encounterCompletionResponseSchema.parse(await successful.json())).toMatchObject({
      data: { encounterVersion: '3', status: 'completed' },
    })
    expect(apiErrorSchema.parse(await rejected.json())).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_REUSED' },
    })
    expect(fhirResourceSchema.parse(await (await runtime.app.request(
      `/fhir/R5/Encounter/${candidate.started.encounterId}`,
      { headers: { cookie: candidate.doctorCookie } },
    )).json())).toMatchObject({ meta: { versionId: '3' }, status: 'completed' })
    expect(new AuditQuery(runtime.database).list({
      epoch: 'epoch-1',
      workspaceId: 'workspace-demo',
    }).filter(event => event.operation === 'encounter.complete').map(event => event.outcome).toSorted()).toEqual([
      'failed',
      'success',
    ])
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
    runtime.fhir.create(
      { epoch: 'epoch-1', workspaceId: 'workspace-demo' },
      {
        resourceType: 'Practitioner',
        id: 'practitioner-direct-intake-doctor',
        active: true,
        name: [{ text: '合成直达接诊医生' }],
      },
    )
    runtime.fhir.create(
      { epoch: 'epoch-1', workspaceId: 'workspace-demo' },
      {
        resourceType: 'PractitionerRole',
        id: 'practitioner-role-direct-intake-doctor',
        active: true,
        code: [{ text: 'outpatient-doctor' }],
        practitioner: { reference: 'Practitioner/practitioner-direct-intake-doctor' },
      },
    )
    runtime.database.driver.prepare(`
      INSERT INTO practitioner_role_binding (
        workspace_id, practitioner_role_id, practitioner_id, role_code,
        organization_id, location_id, active
      ) VALUES (
        'workspace-demo', 'practitioner-role-direct-intake-doctor',
        'practitioner-direct-intake-doctor', 'outpatient-doctor',
        'organization-clinmesh', 'location-outpatient-doctor', 1
      )
    `).run()
    runtime.database.driver.prepare(`
      INSERT INTO membership_practitioner_role (
        membership_id, workspace_id, practitioner_role_id
      ) VALUES (
        'membership-administrator', 'workspace-demo',
        'practitioner-role-direct-intake-doctor'
      )
    `).run()
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
    expect((await selectRole('practitioner-role-direct-intake-doctor')).status).toBe(200)
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
        ...(resourceType === 'Task'
          ? { owner: { reference: 'PractitionerRole/practitioner-role-direct-intake-doctor' } }
          : {}),
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
          who: { identifier: expect.objectContaining({ value: 'practitioner-direct-intake-doctor' }) },
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

  it('appends one deterministic Consultation Record and restores it separately from clinical drafts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-consultation-record-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const initialDetailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await initialDetailResponse.json())).toMatchObject({
      consultation: {
        questions: expect.arrayContaining([expect.objectContaining({
          code: 'symptom-onset',
          text: '什么时候开始发热？',
        })]),
        records: [],
        version: 1,
      },
    })

    const askResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${started.encounterId}`]: '1',
            [`Task/${started.queueTaskId}`]: '1',
          },
          input: {
            expectedVersion: 1,
            questionCode: 'symptom-onset',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    expect(askResponse.status).toBe(200)
    expect(await askResponse.json()).toMatchObject({
      data: {
        caseId: started.caseId,
        consultationVersion: 2,
        record: {
          answer: '昨天傍晚开始发热，最高量到 38.7 °C。',
          question: {
            code: 'symptom-onset',
            text: '什么时候开始发热？',
          },
          recordedAt: '2026-08-24T09:00:00+08:00',
          sequence: 1,
        },
      },
    })
    const restoredDoctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const restoredDetailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: restoredDoctorCookie } },
    )
    const restoredDetail = doctorCaseDetailSchema.parse(await restoredDetailResponse.json())
    expect(restoredDetail).toMatchObject({
      consultation: {
        records: [{
          answer: '昨天傍晚开始发热，最高量到 38.7 °C。',
          question: {
            code: 'symptom-onset',
            text: '什么时候开始发热？',
          },
          recordedAt: '2026-08-24T09:00:00+08:00',
          sequence: 1,
        }],
        version: 2,
      },
    })
    expect(restoredDetail.drafts).toBeUndefined()
  })

  it('restores the structured Clinical Document draft and rejects a stale version without overwriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-clinical-document-draft-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const saveDraft = (document: typeof structuredClinicalDocument, expectedDraftVersion: number) => (
      runtime.app.request(
        `/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`,
        {
          body: JSON.stringify({
            expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
            input: { document, expectedDraftVersion },
          }),
          headers: commandHeaders(doctorCookie),
          method: 'PUT',
        },
      )
    )

    const incompleteResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
          input: {
            document: { ...structuredClinicalDocument, followUp: undefined },
            expectedDraftVersion: 0,
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(incompleteResponse.status).toBe(400)
    expect(apiErrorSchema.parse(await incompleteResponse.json())).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })

    const savedResponse = await saveDraft(structuredClinicalDocument, 0)
    expect(savedResponse.status).toBe(200)
    expect(clinicalDocumentDraftResponseSchema.parse(await savedResponse.json()).data).toEqual({
      caseId: started.caseId,
      draftVersion: 1,
    })

    const staleResponse = await saveDraft({
      ...structuredClinicalDocument,
      assessment: '这一份旧编辑不能覆盖已保存内容。',
    }, 0)
    expect(staleResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleResponse.json())).toEqual({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The Clinical Document draft version has changed',
      },
    })

    const restoredDoctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: restoredDoctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      clinicalDocument: {
        draft: {
          ...structuredClinicalDocument,
          updatedAt: '2026-08-24T09:00:00+08:00',
          version: 1,
        },
        signed: [],
      },
    })
  })

  it('previews and signs an immutable structured Clinical Document without completing the Encounter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-clinical-document-sign-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { document: structuredClinicalDocument, expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    clinicalDocumentDraftResponseSchema.parse(await draftResponse.json())

    const previewResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/preview-sign`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(previewResponse.status).toBe(200)
    const preview = clinicalDocumentSignPreviewResponseSchema.parse(await previewResponse.json())
    expect(preview.data.document.content).toEqual(structuredClinicalDocument)

    const updatedDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { document: revisedStructuredClinicalDocument, expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(updatedDraftResponse.status).toBe(200)
    expect(clinicalDocumentDraftResponseSchema.parse(
      await updatedDraftResponse.json(),
    ).data.draftVersion).toBe(2)

    const staleSignResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/sign`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            commitToken: preview.data.commitToken,
            previewId: preview.data.previewId,
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(staleSignResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleSignResponse.json())).toMatchObject({
      error: { message: 'The Clinical Document draft version has changed' },
    })

    const currentPreviewResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/preview-sign`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 2 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(currentPreviewResponse.status).toBe(200)
    const currentPreview = clinicalDocumentSignPreviewResponseSchema.parse(
      await currentPreviewResponse.json(),
    )
    expect(currentPreview.data.document.content).toEqual(revisedStructuredClinicalDocument)

    const signIdempotencyKey = randomUUID()
    const sign = () => runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/sign`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            commitToken: currentPreview.data.commitToken,
            previewId: currentPreview.data.previewId,
          },
        }),
        headers: commandHeaders(doctorCookie, signIdempotencyKey),
        method: 'POST',
      },
    )
    const signedResponse = await sign()
    expect(signedResponse.status).toBe(200)
    const signed = clinicalDocumentSignResponseSchema.parse(await signedResponse.json())
    expect(clinicalDocumentSignResponseSchema.parse(await (await sign()).json())).toEqual(signed)

    const compositionResponse = await runtime.app.request(
      `/fhir/R5/Composition/${signed.data.compositionId}`,
      { headers: { cookie: doctorCookie } },
    )
    const composition = fhirResourceSchema.parse(await compositionResponse.json())
    expect(composition).toMatchObject({
      encounter: { reference: `Encounter/${started.encounterId}` },
      meta: { versionId: '1' },
      status: 'final',
      title: '门诊结构化病历',
    })
    expect(composition.section).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: expect.objectContaining({
          coding: expect.arrayContaining([expect.objectContaining({ code: 'chief-complaint' })]),
        }),
        title: '主诉',
      }),
      expect.objectContaining({
        code: expect.objectContaining({
          coding: expect.arrayContaining([expect.objectContaining({ code: 'follow-up' })]),
        }),
        title: '随访',
      }),
    ]))
    const bundleResponse = await runtime.app.request(
      `/fhir/R5/Bundle/${signed.data.bundleId}`,
      { headers: { cookie: doctorCookie } },
    )
    const documentBundle = fhirDocumentBundleSchema.parse(await bundleResponse.json())
    expect(documentBundle).toMatchObject({
      identifier: {
        system: 'https://caizongyuan.github.io/clinmesh/fhir/identifier/clinical-document-bundle',
        value: signed.data.bundleId,
      },
      type: 'document',
    })
    const documentEntries = documentBundle.entry
    expect(documentEntries[0]?.resource).toMatchObject({
      id: signed.data.compositionId,
      resourceType: 'Composition',
    })
    expect(documentEntries.map(entry => (
      `${entry.resource.resourceType}/${entry.resource.id}`
    )).toSorted()).toEqual([
      `Composition/${signed.data.compositionId}`,
      `Encounter/${started.encounterId}`,
      'Location/location-outpatient',
      'Location/location-outpatient-doctor',
      'Organization/organization-clinmesh',
      `Patient/${started.patientId}`,
      'Practitioner/practitioner-outpatient-doctor',
      'PractitionerRole/practitioner-role-outpatient-doctor',
    ].toSorted())
    const provenanceResponse = await runtime.app.request(
      `/fhir/R5/Provenance/${signed.data.provenanceId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await provenanceResponse.json())).toMatchObject({
      target: [
        { reference: `Composition/${signed.data.compositionId}` },
        { reference: `Bundle/${signed.data.bundleId}` },
      ],
    })
    const encounterResponse = await runtime.app.request(
      `/fhir/R5/Encounter/${started.encounterId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await encounterResponse.json())).toMatchObject({
      meta: { versionId: '1' },
      status: 'in-progress',
    })

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      clinicalDocument: {
        signed: [{
          bundleId: signed.data.bundleId,
          compositionId: signed.data.compositionId,
          compositionVersion: '1',
          content: revisedStructuredClinicalDocument,
          documentId: signed.data.documentId,
          provenanceId: signed.data.provenanceId,
          revisionNumber: 1,
          signedAt: '2026-08-24T09:00:00+08:00',
        }],
      },
    })

    const overwriteResponse = await runtime.app.request(
      `/fhir/R5/Composition/${signed.data.compositionId}`,
      {
        body: JSON.stringify({ resourceType: 'Composition', id: signed.data.compositionId }),
        headers: {
          'content-type': 'application/fhir+json',
          cookie: doctorCookie,
          'if-match': 'W/"1"',
        },
        method: 'PUT',
      },
    )
    expect(overwriteResponse.status).toBe(405)
  })

  it('rejects a structured Clinical Document preview after the Encounter version changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-clinical-document-encounter-preview-http-'))
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
    const encounterId = testCase.registration.encounterId
    const previewExpectedVersions = { [`Encounter/${encounterId}`]: '2' }

    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/clinical-document/draft`,
      {
        body: JSON.stringify({
          expectedVersions: previewExpectedVersions,
          input: { document: structuredClinicalDocument, expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'PUT',
      },
    )
    expect(clinicalDocumentDraftResponseSchema.parse(await draftResponse.json()).data.draftVersion).toBe(1)
    const previewResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/clinical-document/actions/preview-sign`,
      {
        body: JSON.stringify({
          expectedVersions: previewExpectedVersions,
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    const preview = clinicalDocumentSignPreviewResponseSchema.parse(await previewResponse.json()).data
    const startResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/actions/start-first-visit`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${encounterId}`]: '2',
            [`Task/${testCase.triage.doctorTaskId}`]: '1',
          },
          input: {},
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    expect(startVisitResponseSchema.parse(await startResponse.json()).data.encounterVersion).toBe('3')

    const signResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/clinical-document/actions/sign`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${encounterId}`]: '3' },
          input: {
            commitToken: preview.commitToken,
            previewId: preview.previewId,
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    expect(signResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await signResponse.json())).toEqual({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The Clinical Document signing preview context has changed',
      },
    })
  })

  it('rejects a structured Clinical Document preview in a different Actor context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-clinical-document-actor-preview-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { document: structuredClinicalDocument, expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    clinicalDocumentDraftResponseSchema.parse(await draftResponse.json())
    const previewResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/preview-sign`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    const preview = clinicalDocumentSignPreviewResponseSchema.parse(await previewResponse.json()).data
    const administratorCookie = await signIn(runtime, 'admin@demo.clinmesh.local', password)
    const roleResponse = await runtime.app.request('/api/auth/role', {
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-outpatient-doctor' }),
      headers: {
        'content-type': 'application/json',
        cookie: administratorCookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(sessionContextSchema.parse(await roleResponse.json()).actor.actorId).toBe('actor-administrator')

    const signResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/sign`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            commitToken: preview.commitToken,
            previewId: preview.previewId,
          },
        }),
        headers: commandHeaders(administratorCookie),
        method: 'POST',
      },
    )
    expect(signResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await signResponse.json())).toEqual({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The Clinical Document signing preview context has changed',
      },
    })
  })

  it('expires a structured Clinical Document preview on real time while Virtual Time is frozen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-clinical-document-preview-expiry-http-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    let securityTime = new Date('2026-08-25T00:00:00.000Z')
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      now: () => securityTime,
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { document: structuredClinicalDocument, expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    clinicalDocumentDraftResponseSchema.parse(await draftResponse.json())
    const previewResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/preview-sign`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    const preview = clinicalDocumentSignPreviewResponseSchema.parse(await previewResponse.json()).data
    expect(preview.expiresAt).toBe('2026-08-25T00:05:00.000Z')
    securityTime = new Date('2026-08-25T00:05:00.001Z')

    const signResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/actions/sign`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            commitToken: preview.commitToken,
            previewId: preview.previewId,
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(signResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await signResponse.json())).toEqual({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The Clinical Document signing preview is unavailable',
      },
    })
  })

  it('rejects the legacy combined signing flow after a structured Clinical Document is signed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-mixed-clinical-sign-http-'))
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
    const encounterId = testCase.registration.encounterId
    const encounterVersions = { [`Encounter/${encounterId}`]: '6' }
    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/clinical-document/draft`,
      {
        body: JSON.stringify({
          expectedVersions: encounterVersions,
          input: { document: structuredClinicalDocument, expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'PUT',
      },
    )
    clinicalDocumentDraftResponseSchema.parse(await draftResponse.json())
    const structuredPreviewResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/clinical-document/actions/preview-sign`,
      {
        body: JSON.stringify({
          expectedVersions: encounterVersions,
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    const structuredPreview = clinicalDocumentSignPreviewResponseSchema.parse(
      await structuredPreviewResponse.json(),
    ).data
    const structuredSignResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/clinical-document/actions/sign`,
      {
        body: JSON.stringify({
          expectedVersions: encounterVersions,
          input: {
            commitToken: structuredPreview.commitToken,
            previewId: structuredPreview.previewId,
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    expect(structuredSignResponse.status).toBe(200)
    clinicalDocumentSignResponseSchema.parse(await structuredSignResponse.json())

    const combinedPreviewResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/actions/preview-sign`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Condition/${testCase.draft.conditionId}`]: '1',
            [`Encounter/${encounterId}`]: '6',
            [`MedicationRequest/${testCase.draft.medicationRequestIds[0]}`]: '1',
            [`Task/${testCase.report.taskId}`]: '2',
          },
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
    expect(combinedPreviewResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await combinedPreviewResponse.json())).toEqual({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The Clinical Document is already signed',
      },
    })
  })

  it('revises only the latest signed Clinical Document and preserves the immutable version history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-clinical-document-revision-http-'))
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
    const { doctorCookie, expectedVersions, signed, started } = await createSignedStructuredClinicalDocument(
      runtime,
      password,
    )

    const ordinarySaveResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { document: revisedStructuredClinicalDocument, expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(ordinarySaveResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await ordinarySaveResponse.json())).toMatchObject({
      error: { message: 'The signed Clinical Document requires a revision' },
    })

    const revisionIdempotencyKey = randomUUID()
    const revise = () => runtime.app.request(
      `/api/his/v1/clinical-documents/${signed.compositionId}/actions/revise`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Composition/${signed.compositionId}`]: signed.compositionVersion,
            ...expectedVersions,
          },
          input: {
            document: revisedStructuredClinicalDocument,
            reason: '复核检验结果后更正评估、处置和随访。',
          },
        }),
        headers: commandHeaders(doctorCookie, revisionIdempotencyKey),
        method: 'POST',
      },
    )
    const revisionResponse = await revise()
    expect(revisionResponse.status).toBe(200)
    const revision = clinicalDocumentRevisionResponseSchema.parse(await revisionResponse.json())
    expect(revision.data).toMatchObject({
      compositionVersion: '1',
      revisionNumber: 2,
      revisionOfCompositionId: signed.compositionId,
    })
    await expectCommandAudit(
      runtime,
      doctorCookie,
      revision.auditId,
      'clinical-document.revise',
    )
    expect(clinicalDocumentRevisionResponseSchema.parse(await (await revise()).json())).toEqual(revision)

    const originalResponse = await runtime.app.request(
      `/fhir/R5/Composition/${signed.compositionId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await originalResponse.json())).toMatchObject({
      meta: { versionId: '1' },
      status: 'final',
    })
    const revisedResponse = await runtime.app.request(
      `/fhir/R5/Composition/${revision.data.compositionId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await revisedResponse.json())).toMatchObject({
      meta: { versionId: '1' },
      relatesTo: [{
        resourceReference: { reference: `Composition/${signed.compositionId}` },
        type: 'replaces',
      }],
      status: 'amended',
      title: '门诊结构化病历修订',
    })
    const revisedBundleResponse = await runtime.app.request(
      `/fhir/R5/Bundle/${revision.data.bundleId}`,
      { headers: { cookie: doctorCookie } },
    )
    const revisedBundle = fhirDocumentBundleSchema.parse(await revisedBundleResponse.json())
    expect(revisedBundle.entry[0]?.resource).toMatchObject({
      id: revision.data.compositionId,
      resourceType: 'Composition',
    })
    expect(revisedBundle.entry.map(entry => (
      `${entry.resource.resourceType}/${entry.resource.id}`
    ))).toEqual(expect.arrayContaining([
      `Composition/${revision.data.compositionId}`,
      `Composition/${signed.compositionId}`,
    ]))

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      clinicalDocument: {
        signed: [
          expect.objectContaining({
            compositionId: signed.compositionId,
            content: structuredClinicalDocument,
            revisionNumber: 1,
          }),
          expect.objectContaining({
            compositionId: revision.data.compositionId,
            content: revisedStructuredClinicalDocument,
            revisionNumber: 2,
            revisionOfCompositionId: signed.compositionId,
            revisionReason: '复核检验结果后更正评估、处置和随访。',
          }),
        ],
      },
    })

    const forkResponse = await runtime.app.request(
      `/api/his/v1/clinical-documents/${signed.compositionId}/actions/revise`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Composition/${signed.compositionId}`]: signed.compositionVersion,
            ...expectedVersions,
          },
          input: {
            document: revisedStructuredClinicalDocument,
            reason: '这次旧根分叉应被拒绝。',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(forkResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await forkResponse.json())).toMatchObject({
      error: {
        message: 'The Clinical Document is superseded; only the latest version can be revised',
      },
    })
    expectCommandAuditOutcomes(runtime, 'clinical-document.revise', ['success', 'failed'])
  })

  it('rejects legacy revision content for a structured Clinical Document without hiding its history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-structured-clinical-document-legacy-revision-http-'))
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
    const { doctorCookie, expectedVersions, signed, started } = await createSignedStructuredClinicalDocument(
      runtime,
      password,
    )

    const response = await runtime.app.request(
      `/api/his/v1/clinical-documents/${signed.compositionId}/actions/revise`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Composition/${signed.compositionId}`]: signed.compositionVersion,
            ...expectedVersions,
          },
          input: {
            assessment: '旧版两字段评估不应改写六字段病历。',
            plan: '旧版两字段计划不应成为结构化修订。',
            reason: '验证修订合同边界。',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    expect(response.status).toBe(409)
    expect(apiErrorSchema.parse(await response.json())).toEqual({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The structured Clinical Document requires structured revision content',
      },
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json()).clinicalDocument?.signed).toHaveLength(1)
  })

  it('orders Consultation Records and rejects a stale aggregate version without duplication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-consultation-order-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const ask = (questionCode: string, expectedVersion: number, idempotencyKey = randomUUID()) => (
      runtime.app.request(
        `/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
          body: JSON.stringify({
            expectedVersions: {
              [`Encounter/${started.encounterId}`]: '1',
              [`Task/${started.queueTaskId}`]: '1',
            },
            input: { expectedVersion, questionCode },
          }),
          headers: commandHeaders(doctorCookie, idempotencyKey),
          method: 'POST',
        },
      )
    )
    const firstIdempotencyKey = randomUUID()
    const firstResponse = await ask('symptom-onset', 1, firstIdempotencyKey)
    const first = askConsultationQuestionResponseSchema.parse(await firstResponse.json())

    const replayResponse = await ask('symptom-onset', 1, firstIdempotencyKey)
    expect(askConsultationQuestionResponseSchema.parse(await replayResponse.json())).toEqual(first)
    const secondResponse = await ask('associated-symptoms', 2)

    expect(secondResponse.status).toBe(200)
    expect(askConsultationQuestionResponseSchema.parse(await secondResponse.json())).toMatchObject({
      data: {
        consultationVersion: 3,
        record: {
          answer: '咽痛，吞咽时更明显，没有气促。',
          question: { code: 'associated-symptoms' },
          sequence: 2,
        },
      },
    })
    const staleResponse = await ask('symptom-onset', 2)
    expect(staleResponse.status).toBe(409)
    expect(await staleResponse.json()).toEqual({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The Consultation Record version has changed',
      },
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      consultation: {
        records: [
          expect.objectContaining({
            question: { code: 'symptom-onset', text: '什么时候开始发热？' },
            sequence: 1,
          }),
          expect.objectContaining({
            question: { code: 'associated-symptoms', text: '除了发热，还有哪里不舒服？' },
            sequence: 2,
          }),
        ],
        version: 3,
      },
    })
  })

  it('keeps a Hidden Fact-backed answer concealed without a matching consultation Reveal Policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-consultation-reveal-policy-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)

    const askResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${started.encounterId}`]: '1',
            [`Task/${started.queueTaskId}`]: '1',
          },
          input: {
            expectedVersion: 1,
            questionCode: 'infection-cause',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    expect(askResponse.status).toBe(200)
    const answer = askConsultationQuestionResponseSchema.parse(await askResponse.json())
    expect(answer.data.record).toMatchObject({
      answer: '目前还不知道，需要等检查结果。',
      question: {
        code: 'infection-cause',
        text: '知道是什么感染引起的吗？',
      },
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    const publicDetail = await detailResponse.json()
    expect(doctorCaseDetailSchema.parse(publicDetail)).toMatchObject({
      consultation: {
        records: [expect.objectContaining({ answer: '目前还不知道，需要等检查结果。' })],
      },
    })
    expect(JSON.stringify({ answer, publicDetail })).not.toMatch(
      /influenza|respiratory-pathogen|paid-lis-report|hidden.?fact/i,
    )
  })

  it('rejects a Consultation Record command from a non-doctor role', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-consultation-role-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const registrarCookie = await signIn(runtime, 'registrar@demo.clinmesh.local', password)

    const forbiddenResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${started.encounterId}`]: '1',
            [`Task/${started.queueTaskId}`]: '1',
          },
          input: {
            expectedVersion: 1,
            questionCode: 'symptom-onset',
          },
        }),
        headers: commandHeaders(registrarCookie),
        method: 'POST',
      },
    )

    expect(forbiddenResponse.status).toBe(403)
    expect(await forbiddenResponse.json()).toEqual({
      error: {
        code: 'ROLE_NOT_ALLOWED',
        message: 'The active Practitioner Role cannot perform this action',
      },
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      consultation: { records: [], version: 1 },
    })
  })

  it('rejects a Consultation Record after the Encounter is completed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-consultation-completed-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const repositoryContext = { epoch: 'epoch-1', workspaceId: 'workspace-demo' }

    // The signing workflow's state transition is covered separately; this isolates the ask guard.
    const encounter = runtime.fhir.read(repositoryContext, 'Encounter', started.encounterId)
    const completedEncounter = runtime.fhir.update(repositoryContext, {
      ...encounter,
      status: 'completed',
    }, encounter.meta?.versionId ?? '1')
    const task = runtime.fhir.read(repositoryContext, 'Task', started.queueTaskId)
    const completedTask = runtime.fhir.update(repositoryContext, {
      ...task,
      status: 'completed',
    }, task.meta?.versionId ?? '1')
    runtime.database.driver.prepare(`
      UPDATE outpatient_case SET status = 'awaiting-medication-payment'
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).run(repositoryContext.workspaceId, repositoryContext.epoch, started.caseId)

    const response = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${started.encounterId}`]: completedEncounter.meta?.versionId,
            [`Task/${started.queueTaskId}`]: completedTask.meta?.versionId,
          },
          input: {
            expectedVersion: 1,
            questionCode: 'symptom-onset',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The Encounter is not available for consultation',
      },
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      consultation: { records: [], version: 1 },
    })
  })

  it('saves a versioned laboratory request draft without creating formal FHIR resources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-request-draft-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const fhirTotal = async (resourceType: string) => {
      const response = await runtime.app.request(`/fhir/R5/${resourceType}?_total=accurate`, {
        headers: { cookie: doctorCookie },
      })
      return fhirBundleSchema.parse(await response.json()).total
    }
    const resourcesBeforeDraft = {
      serviceRequests: await fhirTotal('ServiceRequest'),
      tasks: await fhirTotal('Task'),
    }

    const response = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
          input: {
            catalogItemId: 'lab-cbc',
            expectedDraftVersion: 0,
            indicationCode: 'fever',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )

    expect(response.status).toBe(200)
    expect(laboratoryRequestDraftResponseSchema.parse(await response.json())).toMatchObject({
      data: { caseId: started.caseId, draftVersion: 1 },
      effects: [],
    })
    expect({
      serviceRequests: await fhirTotal('ServiceRequest'),
      tasks: await fhirTotal('Task'),
    }).toEqual(resourcesBeforeDraft)

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      laboratoryRequests: {
        draft: { catalogItemId: 'lab-cbc', indicationCode: 'fever' },
        draftVersion: 1,
        requests: [],
      },
    })
  })

  it('lets only the responsible doctor delete the current laboratory request draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-request-draft-cas-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const save = (
      catalogItemId: 'lab-cbc' | 'lab-crp',
      indicationCode: string,
      expectedDraftVersion: number,
    ) => runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { catalogItemId, expectedDraftVersion, indicationCode },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    const initialResponse = await save('lab-cbc', 'fever', 0)
    expect(initialResponse.status).toBe(200)

    const staleResponse = await save('lab-crp', 'fever', 0)
    expect(staleResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleResponse.json())).toMatchObject({
      error: { code: 'LABORATORY_REQUEST_VERSION_CONFLICT' },
    })
    const invalidIndicationResponse = await save('lab-cbc', 'screening', 1)
    expect(invalidIndicationResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await invalidIndicationResponse.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT' },
    })

    const idempotencyKey = randomUUID()
    const otherDoctorCookie = await selectAdditionalDoctorRole(runtime, password)
    const unauthorizedDeleteResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 1 },
        } satisfies typeof deleteLaboratoryRequestDraftRequestSchema._output),
        headers: commandHeaders(otherDoctorCookie),
        method: 'DELETE',
      },
    )
    expect(unauthorizedDeleteResponse.status).toBe(403)
    expect(apiErrorSchema.parse(await unauthorizedDeleteResponse.json())).toMatchObject({
      error: {
        code: 'ROLE_NOT_ALLOWED',
        message: 'The outpatient case belongs to another doctor',
      },
    })
    const remove = () => runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 1 },
        } satisfies typeof deleteLaboratoryRequestDraftRequestSchema._output),
        headers: commandHeaders(doctorCookie, idempotencyKey),
        method: 'DELETE',
      },
    )
    const deleteResponse = await remove()
    expect(deleteResponse.status).toBe(200)
    const deleted = laboratoryRequestDraftResponseSchema.parse(await deleteResponse.json())
    expect(deleted).toMatchObject({ data: { draftVersion: 2 }, effects: [] })
    await expectCommandAudit(
      runtime,
      doctorCookie,
      deleted.auditId,
      'laboratory-request.delete-draft',
    )
    expect(laboratoryRequestDraftResponseSchema.parse(await (await remove()).json())).toEqual(deleted)
    const staleDeleteResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 1 },
        } satisfies typeof deleteLaboratoryRequestDraftRequestSchema._output),
        headers: commandHeaders(doctorCookie),
        method: 'DELETE',
      },
    )
    expect(staleDeleteResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleDeleteResponse.json())).toMatchObject({
      error: {
        code: 'LABORATORY_REQUEST_VERSION_CONFLICT',
        message: 'The laboratory request draft is empty at version 2',
      },
    })
    expectCommandAuditOutcomes(runtime, 'laboratory-request.delete-draft', [
      'failed',
      'success',
      'failed',
    ])

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    const detail = doctorCaseDetailSchema.parse(await detailResponse.json())
    expect(detail).toMatchObject({
      laboratoryRequests: { draftVersion: 2, requests: [] },
    })
    expect(detail.laboratoryRequests?.draft).toBeUndefined()
  })

  it('issues one formal laboratory request and execution Task exactly once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-request-issue-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            catalogItemId: 'lab-cbc',
            expectedDraftVersion: 0,
            indicationCode: 'fever',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    laboratoryRequestDraftResponseSchema.parse(await draftResponse.json())
    const idempotencyKey = randomUUID()
    const issue = () => runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(doctorCookie, idempotencyKey),
        method: 'POST',
      },
    )

    const response = await issue()

    expect(response.status).toBe(200)
    const issued = issueLaboratoryRequestResponseSchema.parse(await response.json())
    expect(issued).toMatchObject({
      data: {
        caseId: started.caseId,
        draftVersion: 2,
        request: {
          catalogItemId: 'lab-cbc',
          indicationCode: 'fever',
          serviceRequestVersion: '1',
          status: 'issued',
          taskVersion: '1',
          version: 1,
        },
      },
      effects: [
        { kind: 'created', reference: `ServiceRequest/${issued.data.request.serviceRequestId}` },
        { kind: 'created', reference: `Task/${issued.data.request.taskId}` },
      ],
    })
    const { previousReports, ...legacyRequest } = issued.data.request
    expect(previousReports).toEqual([])
    const receiptUpdate = runtime.database.driver.prepare(`
      UPDATE command_receipt
      SET response_json = ?
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND operation = 'laboratory-request.issue' AND idempotency_key = ?
    `).run(
      JSON.stringify({
        ...issued,
        data: { ...issued.data, request: legacyRequest },
      }),
      idempotencyKey,
    )
    expect(receiptUpdate.changes).toBe(1)
    const replayResponse = await issue()
    expect(replayResponse.status).toBe(200)
    expect(issueLaboratoryRequestResponseSchema.parse(await replayResponse.json())).toEqual(issued)

    const serviceRequestResponse = await runtime.app.request(
      `/fhir/R5/ServiceRequest/${issued.data.request.serviceRequestId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await serviceRequestResponse.json())).toMatchObject({
      code: { concept: { coding: [{ code: 'CBC' }], text: '血常规' } },
      encounter: { reference: `Encounter/${started.encounterId}` },
      id: issued.data.request.serviceRequestId,
      intent: 'order',
      resourceType: 'ServiceRequest',
      status: 'active',
      subject: { reference: `Patient/${started.patientId}` },
    })
    const taskResponse = await runtime.app.request(
      `/fhir/R5/Task/${issued.data.request.taskId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await taskResponse.json())).toMatchObject({
      encounter: { reference: `Encounter/${started.encounterId}` },
      focus: { reference: `ServiceRequest/${issued.data.request.serviceRequestId}` },
      for: { reference: `Patient/${started.patientId}` },
      id: issued.data.request.taskId,
      intent: 'order',
      resourceType: 'Task',
      status: 'requested',
    })
    const serviceRequestSearch = await runtime.app.request(
      `/fhir/R5/ServiceRequest?encounter=Encounter/${started.encounterId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await serviceRequestSearch.json())).toMatchObject({ total: 1 })
    const taskSearch = await runtime.app.request(
      `/fhir/R5/Task?focus=ServiceRequest/${issued.data.request.serviceRequestId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await taskSearch.json())).toMatchObject({ total: 1 })

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      encounter: { versionId: '1' },
      laboratoryRequests: {
        draftVersion: 2,
        requests: [issued.data.request],
      },
      status: 'first-visit',
    })
    const chargeSearch = await runtime.app.request('/fhir/R5/ChargeItem?_total=accurate', {
      headers: { cookie: doctorCookie },
    })
    expect(fhirBundleSchema.parse(await chargeSearch.json())).toMatchObject({ total: 0 })
  })

  it('rejects stale, duplicate, and legacy-panel independent laboratory requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-request-guards-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const save = (
      catalogItemId: string,
      expectedDraftVersion: number,
    ) => runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { catalogItemId, expectedDraftVersion, indicationCode: 'fever' },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    const issue = (expectedDraftVersion: number) => runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
      {
        body: JSON.stringify({ expectedVersions, input: { expectedDraftVersion } }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    const legacyPanelResponse = await save('lab-fever-panel', 0)
    expect(legacyPanelResponse.status).toBe(400)
    expect(apiErrorSchema.parse(await legacyPanelResponse.json())).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })

    const firstDraft = laboratoryRequestDraftResponseSchema.parse(
      await (await save('lab-cbc', 0)).json(),
    ).data
    const currentDraft = laboratoryRequestDraftResponseSchema.parse(
      await (await save('lab-cbc', firstDraft.draftVersion)).json(),
    ).data
    const staleIssueResponse = await issue(firstDraft.draftVersion)
    expect(staleIssueResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleIssueResponse.json())).toMatchObject({
      error: { code: 'LABORATORY_REQUEST_VERSION_CONFLICT' },
    })

    const issued = issueLaboratoryRequestResponseSchema.parse(
      await (await issue(currentDraft.draftVersion)).json(),
    ).data
    const duplicateDraft = laboratoryRequestDraftResponseSchema.parse(
      await (await save('lab-cbc', issued.draftVersion)).json(),
    ).data
    const duplicateResponse = await issue(duplicateDraft.draftVersion)
    expect(duplicateResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await duplicateResponse.json())).toMatchObject({
      error: { code: 'LABORATORY_REQUEST_DUPLICATE' },
    })

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      laboratoryRequests: {
        draft: { catalogItemId: 'lab-cbc', indicationCode: 'fever' },
        draftVersion: duplicateDraft.draftVersion,
        requests: [{ id: issued.request.id }],
      },
    })
    const serviceRequestsResponse = await runtime.app.request(
      '/fhir/R5/ServiceRequest?_total=accurate',
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await serviceRequestsResponse.json())).toMatchObject({ total: 1 })
    const executionTasksResponse = await runtime.app.request(
      `/fhir/R5/Task?focus=ServiceRequest/${issued.request.serviceRequestId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await executionTasksResponse.json())).toMatchObject({ total: 1 })
  })

  it('cancels only an issued laboratory request and never revives it from a late event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-request-cancel-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedEncounter = { [`Encounter/${started.encounterId}`]: '1' }
    const saveAndIssue = async (
      catalogItemId: 'lab-cbc' | 'lab-crp',
      expectedDraftVersion: number,
    ) => {
      const draftResponse = await runtime.app.request(
        `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
        {
          body: JSON.stringify({
            expectedVersions: expectedEncounter,
            input: { catalogItemId, expectedDraftVersion, indicationCode: 'fever' },
          }),
          headers: commandHeaders(doctorCookie),
          method: 'PUT',
        },
      )
      const draft = laboratoryRequestDraftResponseSchema.parse(await draftResponse.json()).data
      const issueResponse = await runtime.app.request(
        `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
        {
          body: JSON.stringify({
            expectedVersions: expectedEncounter,
            input: { expectedDraftVersion: draft.draftVersion },
          }),
          headers: commandHeaders(doctorCookie),
          method: 'POST',
        },
      )
      return issueLaboratoryRequestResponseSchema.parse(await issueResponse.json()).data
    }
    const cancel = (request: {
      id: string
      serviceRequestId: string
      serviceRequestVersion: string
      taskId: string
      taskVersion: string
      version: number
    }, idempotencyKey = randomUUID()) => runtime.app.request(
      `/api/his/v1/laboratory-requests/${request.id}/actions/cancel`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`ServiceRequest/${request.serviceRequestId}`]: request.serviceRequestVersion,
            [`Task/${request.taskId}`]: request.taskVersion,
          },
          input: {
            expectedRequestVersion: request.version,
            reasonCode: 'no-longer-needed',
          },
        } satisfies typeof cancelLaboratoryRequestRequestSchema._output),
        headers: commandHeaders(doctorCookie, idempotencyKey),
        method: 'POST',
      },
    )
    const cancellable = await saveAndIssue('lab-crp', 0)
    const cancelIdempotencyKey = randomUUID()

    const cancelResponse = await cancel(cancellable.request, cancelIdempotencyKey)

    expect(cancelResponse.status).toBe(200)
    const cancelled = laboratoryRequestActionResponseSchema.parse(await cancelResponse.json())
    expect(cancelled.data.request).toMatchObject({
      id: cancellable.request.id,
      serviceRequestVersion: '2',
      status: 'cancelled',
      taskVersion: '2',
      version: 2,
    })
    await expectCommandAudit(
      runtime,
      doctorCookie,
      cancelled.auditId,
      'laboratory-request.cancel',
    )
    expect(laboratoryRequestActionResponseSchema.parse(
      await (await cancel(cancellable.request, cancelIdempotencyKey)).json(),
    )).toEqual(cancelled)
    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({
      kind: 'laboratory.accept-request',
      status: 'completed',
    })

    const active = await saveAndIssue('lab-cbc', cancellable.draftVersion)
    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({
      kind: 'laboratory.accept-request',
      status: 'completed',
    })
    const staleAcceptedCancelResponse = await cancel(active.request)
    expect(staleAcceptedCancelResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleAcceptedCancelResponse.json())).toMatchObject({
      error: { code: 'LABORATORY_REQUEST_VERSION_CONFLICT' },
    })
    const acceptedDetailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    const accepted = doctorCaseDetailSchema.parse(
      await acceptedDetailResponse.json(),
    ).laboratoryRequests?.requests.find(request => request.id === active.request.id)
    expect(accepted).toMatchObject({ status: 'accepted', taskVersion: '2', version: 2 })
    if (accepted === undefined) throw new Error('Accepted laboratory request was not projected')
    const acceptedCancelResponse = await cancel(accepted)
    expect(acceptedCancelResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await acceptedCancelResponse.json())).toMatchObject({
      error: {
        code: 'LABORATORY_REQUEST_NOT_CANCELLABLE',
        message: 'The laboratory request cannot be cancelled from status "accepted"',
      },
    })

    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({
      kind: 'laboratory.start-request',
      status: 'completed',
    })
    const staleInProgressCancelResponse = await cancel(active.request)
    expect(staleInProgressCancelResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleInProgressCancelResponse.json())).toMatchObject({
      error: {
        code: 'LABORATORY_REQUEST_VERSION_CONFLICT',
        message: 'The laboratory request is "in-progress" at version 3; a related resource version has changed',
      },
    })
    const inProgressDetailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    const inProgress = doctorCaseDetailSchema.parse(
      await inProgressDetailResponse.json(),
    ).laboratoryRequests?.requests.find(request => request.id === active.request.id)
    expect(inProgress).toMatchObject({ status: 'in-progress', taskVersion: '3', version: 3 })
    if (inProgress === undefined) throw new Error('In-progress laboratory request was not projected')
    const inProgressCancelResponse = await cancel(inProgress)
    expect(inProgressCancelResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await inProgressCancelResponse.json())).toMatchObject({
      error: {
        code: 'LABORATORY_REQUEST_NOT_CANCELLABLE',
        message: 'The laboratory request cannot be cancelled from status "in-progress"',
      },
    })
    expectCommandAuditOutcomes(runtime, 'laboratory-request.cancel', [
      'success',
      'failed',
      'failed',
      'failed',
      'failed',
    ])

    const cancelledServiceRequest = await runtime.app.request(
      `/fhir/R5/ServiceRequest/${cancelled.data.request.serviceRequestId}`,
      { headers: { cookie: doctorCookie } },
    )
    const cancelledServiceRequestResource = fhirResourceSchema.parse(
      await cancelledServiceRequest.json(),
    )
    expect(cancelledServiceRequestResource).toMatchObject({ status: 'revoked' })
    expect(cancelledServiceRequestResource).not.toHaveProperty('statusReason')
    const cancelledTask = await runtime.app.request(
      `/fhir/R5/Task/${cancelled.data.request.taskId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await cancelledTask.json())).toMatchObject({
      status: 'cancelled',
      statusReason: { concept: { coding: [{ code: 'no-longer-needed' }] } },
    })
  })

  it('does not advertise report delivery when the Scenario has no laboratory result facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-report-capability-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
          input: {
            catalogItemId: 'lab-cbc',
            expectedDraftVersion: 0,
            indicationCode: 'fever',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(draftResponse.status).toBe(200)
    runtime.database.driver.prepare(`
      DELETE FROM scenario_hidden_fact
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND fact_code = 'laboratory-results'
    `).run()

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )

    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      laboratoryRequests: { reportingSupported: false },
    })
  })

  it('persists an idempotent doctor acknowledgement without changing the signed report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-acknowledgement-http-'))
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
    const { doctorCookie, request, started } = await createIndependentReportedLaboratoryRequest(
      runtime,
      password,
    )
    const body = {
      expectedVersions: {
        [`DiagnosticReport/${request.report.diagnosticReportId}`]: '1',
      },
      input: { expectedRequestVersion: request.version },
    }
    const acknowledge = () => runtime.app.request(
      `/api/his/v1/laboratory-requests/${request.id}/reports/${request.report?.diagnosticReportId}/actions/acknowledge`,
      {
        body: JSON.stringify(body),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    const response = await acknowledge()
    expect(response.status).toBe(200)
    const first = acknowledgeLaboratoryReportResponseSchema.parse(await response.json())
    expect(first.data).toMatchObject({
      diagnosticReportId: request.report.diagnosticReportId,
      requestId: request.id,
      requestVersion: request.version + 1,
      status: 'acknowledged',
    })
    expect(first.effects).toEqual([{
      kind: 'created',
      reference: `ReportAcknowledgement/${first.data.acknowledgementId}`,
      versionId: '1',
    }])

    const duplicate = await acknowledge()
    expect(duplicate.status).toBe(200)
    const replay = acknowledgeLaboratoryReportResponseSchema.parse(await duplicate.json())
    expect(replay.data).toEqual(first.data)
    expect(replay.effects).toEqual([])

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      laboratoryRequests: {
        requests: [expect.objectContaining({
          id: request.id,
          report: expect.objectContaining({
            acknowledgement: expect.objectContaining({
              acknowledgedAt: first.data.acknowledgedAt,
              id: first.data.acknowledgementId,
            }),
            diagnosticReportId: request.report.diagnosticReportId,
            status: 'final',
          }),
          status: 'acknowledged',
          version: request.version + 1,
        })],
      },
    })
    const reportResponse = await runtime.app.request(
      `/fhir/R5/DiagnosticReport/${request.report.diagnosticReportId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await reportResponse.json())).toMatchObject({
      meta: { versionId: '1' },
      status: 'final',
    })
  })

  it('rejects acknowledgement while the laboratory report is not signed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-unsigned-laboratory-report-http-'))
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
    const { doctorCookie, request } = await createIndependentReportedLaboratoryRequest(
      runtime,
      password,
    )
    const report = runtime.fhir.read(
      { epoch: 'epoch-1', workspaceId: 'workspace-demo' },
      'DiagnosticReport',
      request.report.diagnosticReportId,
    )
    runtime.fhir.update(
      { epoch: 'epoch-1', workspaceId: 'workspace-demo' },
      { ...report, status: 'preliminary' },
      '1',
    )

    const response = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${request.id}/reports/${request.report.diagnosticReportId}/actions/acknowledge`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`DiagnosticReport/${request.report.diagnosticReportId}`]: '2',
          },
          input: { expectedRequestVersion: request.version },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    expect(response.status).toBe(409)
    expect(apiErrorSchema.parse(await response.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
  })

  it('rejects acknowledgement by a doctor who did not author the laboratory request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-report-owner-http-'))
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
    const { doctorCookie, request } = await createIndependentReportedLaboratoryRequest(
      runtime,
      password,
    )
    runtime.fhir.create(
      { epoch: 'epoch-1', workspaceId: 'workspace-demo' },
      {
        resourceType: 'Practitioner',
        id: 'practitioner-other-outpatient-doctor',
        active: true,
        name: [{ text: '合成第二门诊医生' }],
      },
    )
    runtime.database.driver.prepare(`
      UPDATE practitioner_role_binding
      SET practitioner_id = 'practitioner-other-outpatient-doctor'
      WHERE workspace_id = 'workspace-demo'
        AND practitioner_role_id = 'practitioner-role-outpatient-doctor'
    `).run()

    const response = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${request.id}/reports/${request.report.diagnosticReportId}/actions/acknowledge`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`DiagnosticReport/${request.report.diagnosticReportId}`]: '1',
          },
          input: { expectedRequestVersion: request.version },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    expect(response.status).toBe(403)
    expect(apiErrorSchema.parse(await response.json())).toMatchObject({
      error: { code: 'ROLE_NOT_ALLOWED' },
    })
  })

  it('creates a new immutable report chain while preserving the acknowledged report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-report-correction-http-'))
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
    const { doctorCookie, request, started } = await createIndependentReportedLaboratoryRequest(
      runtime,
      password,
    )
    const acknowledgementResponse = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${request.id}/reports/${request.report.diagnosticReportId}/actions/acknowledge`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`DiagnosticReport/${request.report.diagnosticReportId}`]: '1',
          },
          input: { expectedRequestVersion: request.version },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(acknowledgementResponse.status).toBe(200)
    const acknowledgement = acknowledgeLaboratoryReportResponseSchema.parse(
      await acknowledgementResponse.json(),
    )
    const correctedWhiteCellValue = 9.4
    const correctionBody = {
      expectedVersions: {
        [`DiagnosticReport/${request.report.diagnosticReportId}`]: '1',
      },
      input: {
        conclusion: '复核后白细胞计数位于参考范围内。',
        expectedRequestVersion: acknowledgement.data.requestVersion,
        reason: '复核仪器原始数据后更正白细胞计数。',
        results: request.report.results.map(result => ({
          code: result.code,
          value: result.code === '6690-2' ? correctedWhiteCellValue : result.value,
        })),
      },
    }
    const unauthorizedCorrectionResponse = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${request.id}/reports/${request.report.diagnosticReportId}/actions/correct`,
      {
        body: JSON.stringify(correctionBody),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(unauthorizedCorrectionResponse.status).toBe(403)
    expect(apiErrorSchema.parse(await unauthorizedCorrectionResponse.json())).toMatchObject({
      error: { code: 'ROLE_NOT_ALLOWED' },
    })

    const administratorCookie = await signIn(runtime, 'admin@demo.clinmesh.local', password)
    const correctionResponse = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${request.id}/reports/${request.report.diagnosticReportId}/actions/correct`,
      {
        body: JSON.stringify(correctionBody),
        headers: commandHeaders(administratorCookie),
        method: 'POST',
      },
    )

    expect(correctionResponse.status).toBe(200)
    const correction = correctLaboratoryReportResponseSchema.parse(await correctionResponse.json())
    expect(correction.data).toMatchObject({
      previousDiagnosticReportId: request.report.diagnosticReportId,
      requestVersion: acknowledgement.data.requestVersion + 1,
      status: 'reported',
    })
    expect(correction.data.diagnosticReportId).not.toBe(request.report.diagnosticReportId)
    await expectCommandAudit(
      runtime,
      administratorCookie,
      correction.auditId,
      'laboratory-report.correct',
    )
    expectCommandAuditOutcomes(runtime, 'laboratory-report.correct', ['success'])

    const repeatedAcknowledgementResponse = await runtime.app.request(
      `/api/his/v1/laboratory-requests/${request.id}/reports/${request.report.diagnosticReportId}/actions/acknowledge`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`DiagnosticReport/${request.report.diagnosticReportId}`]: '1',
          },
          input: { expectedRequestVersion: request.version },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(repeatedAcknowledgementResponse.status).toBe(200)
    expect(acknowledgeLaboratoryReportResponseSchema.parse(
      await repeatedAcknowledgementResponse.json(),
    ).data).toMatchObject({
      acknowledgementId: acknowledgement.data.acknowledgementId,
      requestVersion: acknowledgement.data.requestVersion,
    })

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    const detail = doctorCaseDetailSchema.parse(await detailResponse.json())
    const correctedRequest = detail.laboratoryRequests?.requests.find(item => item.id === request.id)
    expect(correctedRequest).toMatchObject({
      previousReports: [{
        acknowledgement: { id: acknowledgement.data.acknowledgementId },
        diagnosticReportId: request.report.diagnosticReportId,
        revisionNumber: 1,
      }],
      report: {
        diagnosticReportId: correction.data.diagnosticReportId,
        revisionNumber: 2,
        revisionOfDiagnosticReportId: request.report.diagnosticReportId,
        revisionReason: '复核仪器原始数据后更正白细胞计数。',
      },
      status: 'reported',
    })
    expect(correctedRequest?.report?.acknowledgement).toBeUndefined()
    expect(correctedRequest?.report?.results.find(result => result.code === '6690-2')).toMatchObject({
      value: correctedWhiteCellValue,
    })
    expect(correctedRequest?.previousReports[0]?.results.find(
      result => result.code === '6690-2',
    )).toMatchObject({ value: 11.2 })

    const oldReportResponse = await runtime.app.request(
      `/fhir/R5/DiagnosticReport/${request.report.diagnosticReportId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await oldReportResponse.json())).toMatchObject({
      meta: { versionId: '1' },
      status: 'final',
    })
    const reportSearchResponse = await runtime.app.request(
      `/fhir/R5/DiagnosticReport?encounter=Encounter/${started.encounterId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await reportSearchResponse.json())).toMatchObject({ total: 2 })
    const provenanceResponse = await runtime.app.request(
      `/fhir/R5/Provenance/${correction.data.provenanceId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await provenanceResponse.json())).toMatchObject({
      entity: expect.arrayContaining([{
        role: 'revision',
        what: { reference: `DiagnosticReport/${request.report.diagnosticReportId}` },
      }]),
      target: expect.arrayContaining([{
        reference: `DiagnosticReport/${correction.data.diagnosticReportId}`,
      }]),
    })
  })

  it('allows only one concurrent correction of the latest laboratory report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-report-correction-cas-http-'))
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
    const { request } = await createIndependentReportedLaboratoryRequest(runtime, password)
    const administratorCookie = await signIn(runtime, 'admin@demo.clinmesh.local', password)
    const correct = (value: number) => runtime.app.request(
      `/api/his/v1/laboratory-requests/${request.id}/reports/${request.report.diagnosticReportId}/actions/correct`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`DiagnosticReport/${request.report.diagnosticReportId}`]: '1',
          },
          input: {
            conclusion: `并发复核结果 ${value}。`,
            expectedRequestVersion: request.version,
            reason: `并发更正值 ${value}。`,
            results: request.report.results.map(result => ({
              code: result.code,
              value: result.code === '6690-2' ? value : result.value,
            })),
          },
        }),
        headers: commandHeaders(administratorCookie),
        method: 'POST',
      },
    )

    const responses = await Promise.all([correct(9.3), correct(9.4)])
    expect(responses.map(response => response.status).toSorted()).toEqual([200, 409])
    const rejected = responses.find(response => response.status === 409)
    if (rejected === undefined) throw new Error('A stale correction was not rejected')
    expect(apiErrorSchema.parse(await rejected.json())).toMatchObject({
      error: {
        code: 'LABORATORY_REQUEST_VERSION_CONFLICT',
        message: `The laboratory request is "reported" at version ${request.version + 1}; expected version ${request.version}`,
      },
    })
    const accepted = responses.find(response => response.status === 200)
    if (accepted === undefined) throw new Error('A current correction was not accepted')
    const correction = correctLaboratoryReportResponseSchema.parse(await accepted.json())
    await expectCommandAudit(
      runtime,
      administratorCookie,
      correction.auditId,
      'laboratory-report.correct',
    )
    expectCommandAuditOutcomes(runtime, 'laboratory-report.correct', ['success', 'failed'])
  })

  it('recovers an independent laboratory report after restart and creates its FHIR results once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-report-restart-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(initialRuntime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const draftResponse = await initialRuntime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            catalogItemId: 'lab-cbc',
            expectedDraftVersion: 0,
            indicationCode: 'fever',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    const draft = laboratoryRequestDraftResponseSchema.parse(await draftResponse.json()).data
    const issueResponse = await initialRuntime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: draft.draftVersion },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    const issued = issueLaboratoryRequestResponseSchema.parse(await issueResponse.json()).data.request
    expect(await initialRuntime.dispatcher.dispatchOnce()).toMatchObject({
      kind: 'laboratory.accept-request',
      status: 'completed',
    })
    expect(await initialRuntime.dispatcher.dispatchOnce()).toMatchObject({
      kind: 'laboratory.start-request',
      status: 'completed',
    })
    expect(initialRuntime.database.driver.prepare(`
      SELECT kind, status FROM outbox_event
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND kind = 'laboratory.report-request'
    `).get()).toEqual({ kind: 'laboratory.report-request', status: 'queued' })
    await initialRuntime.close()

    const restartedRuntime = await createClinMeshRuntime(runtimeOptions)
    runtimes.push(restartedRuntime)
    expect(await restartedRuntime.dispatcher.dispatchOnce()).toMatchObject({
      kind: 'laboratory.report-request',
      status: 'completed',
    })
    expect(await restartedRuntime.dispatcher.dispatchOnce()).toBeUndefined()

    const restartedDoctorCookie = await signIn(
      restartedRuntime,
      'doctor@demo.clinmesh.local',
      password,
    )
    const detailResponse = await restartedRuntime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: restartedDoctorCookie } },
    )
    const detail = doctorCaseDetailSchema.parse(await detailResponse.json())
    expect(detail.laboratoryRequests?.reportingSupported).toBe(true)
    const reported = detail.laboratoryRequests?.requests.find(request => request.id === issued.id)
    expect(reported).toMatchObject({
      report: {
        conclusion: '白细胞计数升高，其余血常规指标在参考范围内。',
        issuedAt: '2026-08-24T09:00:00+08:00',
        results: [{
          code: '6690-2',
          display: '白细胞计数',
          interpretation: 'high',
          referenceRange: { high: 9.5, low: 3.5, text: '3.5-9.5 x10^9/L' },
          unit: {
            code: '10*9/L',
            display: '10^9/L',
            system: 'http://unitsofmeasure.org',
          },
          value: 11.2,
        }, {
          code: '718-7',
          display: '血红蛋白',
          interpretation: 'normal',
          referenceRange: { high: 150, low: 115, text: '115-150 g/L' },
          unit: {
            code: 'g/L',
            display: 'g/L',
            system: 'http://unitsofmeasure.org',
          },
          value: 135,
        }, {
          code: '777-3',
          display: '血小板计数',
          interpretation: 'normal',
          referenceRange: { high: 350, low: 125, text: '125-350 x10^9/L' },
          unit: {
            code: '10*9/L',
            display: '10^9/L',
            system: 'http://unitsofmeasure.org',
          },
          value: 210,
        }],
        status: 'final',
      },
      serviceRequestVersion: '2',
      status: 'reported',
      taskVersion: '4',
      version: 4,
    })
    if (reported?.report === undefined) throw new Error('Laboratory report was not projected')

    const serviceRequestResponse = await restartedRuntime.app.request(
      `/fhir/R5/ServiceRequest/${reported.serviceRequestId}`,
      { headers: { cookie: restartedDoctorCookie } },
    )
    expect(fhirResourceSchema.parse(await serviceRequestResponse.json())).toMatchObject({
      encounter: { reference: `Encounter/${started.encounterId}` },
      meta: { versionId: '2' },
      status: 'completed',
      subject: { reference: `Patient/${started.patientId}` },
    })
    const taskResponse = await restartedRuntime.app.request(
      `/fhir/R5/Task/${reported.taskId}`,
      { headers: { cookie: restartedDoctorCookie } },
    )
    expect(fhirResourceSchema.parse(await taskResponse.json())).toMatchObject({
      focus: { reference: `ServiceRequest/${reported.serviceRequestId}` },
      meta: { versionId: '4' },
      status: 'completed',
    })
    const reportResponse = await restartedRuntime.app.request(
      `/fhir/R5/DiagnosticReport/${reported.report.diagnosticReportId}`,
      { headers: { cookie: restartedDoctorCookie } },
    )
    const report = fhirResourceSchema.parse(await reportResponse.json())
    const observationReferences = reported.report.results.map(
      result => `Observation/${result.observationId}`,
    )
    expect(report).toMatchObject({
      basedOn: [{ reference: `ServiceRequest/${reported.serviceRequestId}` }],
      encounter: { reference: `Encounter/${started.encounterId}` },
      issued: '2026-08-24T09:00:00+08:00',
      result: observationReferences.map(reference => ({ reference })),
      specimen: [{ reference: `Specimen/${reported.report.specimenId}` }],
      status: 'final',
      subject: { reference: `Patient/${started.patientId}` },
    })
    for (const result of reported.report.results) {
      const observationResponse = await restartedRuntime.app.request(
        `/fhir/R5/Observation/${result.observationId}`,
        { headers: { cookie: restartedDoctorCookie } },
      )
      expect(fhirResourceSchema.parse(await observationResponse.json())).toMatchObject({
        basedOn: [{ reference: `ServiceRequest/${reported.serviceRequestId}` }],
        encounter: { reference: `Encounter/${started.encounterId}` },
        interpretation: [{ coding: [{
          code: result.interpretation === 'normal'
            ? 'N'
            : result.interpretation === 'high' ? 'H' : 'L',
        }] }],
        referenceRange: [{
          high: { value: result.referenceRange.high },
          low: { value: result.referenceRange.low },
          text: result.referenceRange.text,
        }],
        specimen: { reference: `Specimen/${reported.report.specimenId}` },
        status: 'final',
        subject: { reference: `Patient/${started.patientId}` },
        valueQuantity: {
          code: result.unit.code,
          system: result.unit.system,
          unit: result.unit.display,
          value: result.value,
        },
      })
    }

    const reportSearch = await restartedRuntime.app.request(
      `/fhir/R5/DiagnosticReport?encounter=Encounter/${started.encounterId}&_total=accurate`,
      { headers: { cookie: restartedDoctorCookie } },
    )
    expect(fhirBundleSchema.parse(await reportSearch.json())).toMatchObject({
      entry: [{ resource: { id: reported.report.diagnosticReportId } }],
      total: 1,
    })
    const provenanceSearch = await restartedRuntime.app.request(
      `/fhir/R5/Provenance?target=Specimen/${reported.report.specimenId}&_total=accurate`,
      { headers: { cookie: restartedDoctorCookie } },
    )
    expect(fhirBundleSchema.parse(await provenanceSearch.json())).toMatchObject({
      entry: [{
        resource: {
          target: expect.arrayContaining([{
            reference: `Specimen/${reported.report.specimenId}`,
          }]),
        },
      }],
      total: 1,
    })
    const observationSearch = await restartedRuntime.app.request(
      `/fhir/R5/Observation?encounter=Encounter/${started.encounterId}&_count=100&_total=accurate`,
      { headers: { cookie: restartedDoctorCookie } },
    )
    const observationBundle = fhirBundleSchema.parse(await observationSearch.json())
    expect(observationBundle.entry?.map(entry => entry.resource?.id)).toEqual(
      expect.arrayContaining(reported.report.results.map(result => result.observationId)),
    )
    const serviceRequestHistory = await restartedRuntime.app.request(
      `/fhir/R5/ServiceRequest/${reported.serviceRequestId}/_history`,
      { headers: { cookie: restartedDoctorCookie } },
    )
    expect(fhirBundleSchema.parse(await serviceRequestHistory.json())).toMatchObject({
      entry: [
        { resource: { meta: { versionId: '2' }, status: 'completed' } },
        { resource: { meta: { versionId: '1' }, status: 'active' } },
      ],
      total: 2,
      type: 'history',
    })

    const duplicate = restartedRuntime.workflow.reportLaboratoryRequest({
      context: {
        actorId: 'actor-lis-system',
        epoch: 'epoch-1',
        organizationId: 'organization-clinmesh',
        roleCode: 'lis-system',
        scenarioRunId: 'scenario-run-1',
        workspaceId: 'workspace-demo',
      },
      eventId: randomUUID(),
      requestId: reported.id,
    })
    expect(duplicate).toMatchObject({
      data: {
        diagnosticReportId: reported.report.diagnosticReportId,
        requestId: reported.id,
        status: 'reported',
      },
      effects: [],
    })
    const reportsAfterDuplicate = await restartedRuntime.app.request(
      `/fhir/R5/DiagnosticReport?encounter=Encounter/${started.encounterId}&_total=accurate`,
      { headers: { cookie: restartedDoctorCookie } },
    )
    expect(fhirBundleSchema.parse(await reportsAfterDuplicate.json())).toMatchObject({ total: 1 })
    expect(reported).not.toHaveProperty('acknowledgement')
    expect(restartedRuntime.database.driver.prepare(`
      SELECT status, acknowledged_at FROM laboratory_request
      WHERE workspace_id = ? AND epoch = ? AND request_id = ?
    `).get('workspace-demo', 'epoch-1', reported.id)).toEqual({
      acknowledged_at: null,
      status: 'reported',
    })
  })

  it('reports only an in-progress formal request and deduplicates a different delivery event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-report-guards-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            catalogItemId: 'lab-crp',
            expectedDraftVersion: 0,
            indicationCode: 'fever',
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    const draft = laboratoryRequestDraftResponseSchema.parse(await draftResponse.json()).data
    const issueResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/laboratory-request/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: draft.draftVersion },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    const issued = issueLaboratoryRequestResponseSchema.parse(await issueResponse.json()).data.request
    const systemContext = {
      actorId: 'actor-lis-system',
      epoch: 'epoch-1',
      organizationId: 'organization-clinmesh',
      roleCode: 'lis-system',
      scenarioRunId: 'scenario-run-1',
      workspaceId: 'workspace-demo',
    }
    const report = () => runtime.workflow.reportLaboratoryRequest({
      context: systemContext,
      eventId: randomUUID(),
      requestId: issued.id,
    })

    expect(report).toThrow('Only an in-progress laboratory request can be reported')
    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({
      kind: 'laboratory.accept-request',
      status: 'completed',
    })
    expect(report).toThrow('Only an in-progress laboratory request can be reported')
    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({
      kind: 'laboratory.start-request',
      status: 'completed',
    })

    const firstReport = report()
    expect(firstReport).toMatchObject({
      data: { requestId: issued.id, status: 'reported' },
      effects: expect.arrayContaining([
        expect.objectContaining({
          kind: 'created',
          reference: expect.stringMatching(/^Observation\//),
        }),
        expect.objectContaining({
          kind: 'created',
          reference: expect.stringMatching(/^DiagnosticReport\//),
        }),
        expect.objectContaining({
          kind: 'updated',
          reference: `ServiceRequest/${issued.serviceRequestId}`,
        }),
        expect.objectContaining({
          kind: 'updated',
          reference: `Task/${issued.taskId}`,
        }),
      ]),
    })
    expect(await runtime.dispatcher.dispatchOnce()).toMatchObject({
      kind: 'laboratory.report-request',
      status: 'completed',
    })
    expect(await runtime.dispatcher.dispatchOnce()).toBeUndefined()

    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    const detail = doctorCaseDetailSchema.parse(await detailResponse.json())
    expect(detail.laboratoryRequests?.requests).toContainEqual(expect.objectContaining({
      id: issued.id,
      report: expect.objectContaining({
        conclusion: 'C 反应蛋白升高。',
        results: [expect.objectContaining({
          code: '1988-5',
          interpretation: 'high',
          referenceRange: { high: 8, low: 0, text: '0-8 mg/L' },
          unit: {
            code: 'mg/L',
            display: 'mg/L',
            system: 'http://unitsofmeasure.org',
          },
          value: 18.6,
        })],
      }),
      status: 'reported',
      version: 4,
    }))
    const reports = await runtime.app.request(
      `/fhir/R5/DiagnosticReport?encounter=Encounter/${started.encounterId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    const observations = await runtime.app.request(
      `/fhir/R5/Observation?encounter=Encounter/${started.encounterId}&_count=100&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await reports.json())).toMatchObject({ total: 1 })
    expect(fhirBundleSchema.parse(await observations.json())).toMatchObject({ total: 1 })
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
        contraindicatedAllergyCodes: [],
        id: 'lab-cbc',
        nameEn: 'Complete blood count',
        nameZh: '血常规',
        priceFen: 2500,
        version: 1,
      }, {
        allowedIndicationCodes: ['fever'],
        contraindicatedAllergyCodes: [],
        id: 'lab-crp',
        nameEn: 'C-reactive protein',
        nameZh: 'C 反应蛋白',
        priceFen: 4300,
        version: 1,
      }, {
        allowedIndicationCodes: ['fever'],
        contraindicatedAllergyCodes: [],
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
      prescriptionConclusionSupported: true,
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

  it('serves a legacy medication catalog without advertising independent prescription support', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-legacy-medication-catalog-http-'))
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
    useLegacyMedicationCatalog(runtime)

    const response = await runtime.app.request('/api/his/v1/catalogs/clinical', {
      headers: { cookie: doctorCookie },
    })

    expect(response.status).toBe(200)
    const catalog = clinicalCatalogSchema.parse(await response.json())
    expect(catalog).toMatchObject({
      medications: expect.arrayContaining([
        expect.objectContaining({
          allowedDoseTexts: ['75 mg'],
          allowedFrequencyCodes: ['BID'],
          defaultDoseText: '75 mg',
          defaultFrequencyCode: 'BID',
          id: 'medication-oseltamivir',
        }),
      ]),
      prescriptionConclusionSupported: false,
    })
    expect(catalog.medications[0]).not.toHaveProperty('allowedCourseDays')
  })

  it('rejects independent medication conclusion commands for a legacy medication catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-legacy-medication-command-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    useLegacyMedicationCatalog(runtime)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            expectedDraftVersion: 0,
            items: [{
              catalogItemId: 'medication-oseltamivir',
              courseDays: 5,
              doseText: '75 mg',
              frequencyCode: 'BID',
              quantity: 10,
            }],
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    const noMedicationResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/medication-conclusion/actions/confirm-no-medication`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    expect([draftResponse.status, noMedicationResponse.status]).toEqual([409, 409])
    expect([
      apiErrorSchema.parse(await draftResponse.json()).error.code,
      apiErrorSchema.parse(await noMedicationResponse.json()).error.code,
    ]).toEqual(['CATALOG_CONFLICT', 'CATALOG_CONFLICT'])
  })

  it('persists a controlled diagnosis draft without creating formal FHIR Conditions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-diagnosis-draft-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)

    const catalogResponse = await runtime.app.request('/api/his/v1/catalogs/clinical', {
      headers: { cookie: doctorCookie },
    })
    expect(catalogResponse.status).toBe(200)
    expect(clinicalCatalogSchema.parse(await catalogResponse.json())).toMatchObject({
      diagnoses: expect.arrayContaining([
        expect.objectContaining({
          code: 'J10.1',
          id: 'diagnosis-influenza',
          nameZh: '流感伴其他呼吸道表现，季节性流感病毒已标明',
          system: 'http://hl7.org/fhir/sid/icd-10',
          version: 1,
        }),
        expect.objectContaining({
          code: 'J06.9',
          id: 'diagnosis-acute-upper-respiratory-infection',
          version: 1,
        }),
      ]),
    })
    const conditionSearchPath
      = `/fhir/R5/Condition?patient=Patient/${started.patientId}&_total=accurate`
    const conditionCountBefore = fhirBundleSchema.parse(await (
      await runtime.app.request(conditionSearchPath, { headers: { cookie: doctorCookie } })
    ).json()).total

    const saveResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
          input: {
            entries: [{
              catalogItemId: 'diagnosis-influenza',
              note: '结合发热与甲型流感抗原结果。',
              role: 'primary',
            }, {
              catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
              role: 'secondary',
            }],
            expectedDraftVersion: 0,
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )

    expect(saveResponse.status).toBe(200)
    expect(diagnosisDraftResponseSchema.parse(await saveResponse.json())).toMatchObject({
      data: { draftVersion: 1 },
      effects: [{
        kind: 'created',
        reference: expect.stringMatching(/^DiagnosisDraft\//),
        versionId: '1',
      }],
    })
    const restoredDetailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(restoredDetailResponse.status).toBe(200)
    expect(doctorCaseDetailSchema.parse(await restoredDetailResponse.json())).toMatchObject({
      diagnosis: {
        draft: {
          entries: [{
            catalogItemId: 'diagnosis-influenza',
            note: '结合发热与甲型流感抗原结果。',
            role: 'primary',
          }, {
            catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
            role: 'secondary',
          }],
        },
        draftVersion: 1,
      },
    })
    const conditionCountAfter = fhirBundleSchema.parse(await (
      await runtime.app.request(conditionSearchPath, { headers: { cookie: doctorCookie } })
    ).json()).total
    expect(conditionCountAfter).toBe(conditionCountBefore)
  })

  it('rejects a stale diagnosis draft version without overwriting the current draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-diagnosis-draft-cas-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const endpoint = `/api/his/v1/encounters/${started.encounterId}/diagnosis/draft`
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const saveDraft = (catalogItemId: string, note: string, expectedDraftVersion: number) => (
      runtime.app.request(endpoint, {
        body: JSON.stringify({
          expectedVersions,
          input: {
            entries: [{ catalogItemId, note, role: 'primary' }],
            expectedDraftVersion,
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      })
    )

    const initialResponse = await saveDraft(
      'diagnosis-influenza',
      '初始诊断草稿。',
      0,
    )
    expect(initialResponse.status).toBe(200)
    expect(diagnosisDraftResponseSchema.parse(await initialResponse.json())).toMatchObject({
      data: { draftVersion: 1 },
    })
    const currentResponse = await saveDraft(
      'diagnosis-acute-upper-respiratory-infection',
      '较新诊断草稿。',
      1,
    )
    expect(currentResponse.status).toBe(200)
    expect(diagnosisDraftResponseSchema.parse(await currentResponse.json())).toMatchObject({
      data: { draftVersion: 2 },
    })

    const staleResponse = await saveDraft(
      'diagnosis-fever',
      '过期客户端不应覆盖此内容。',
      1,
    )
    expect(staleResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleResponse.json())).toMatchObject({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The diagnosis draft version has changed',
      },
    })

    const restoredDetail = doctorCaseDetailSchema.parse(await (
      await runtime.app.request(`/api/his/v1/doctor/cases/${started.caseId}`, {
        headers: { cookie: doctorCookie },
      })
    ).json())
    expect(restoredDetail.diagnosis).toEqual({
      draft: {
        entries: [{
          catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
          note: '较新诊断草稿。',
          role: 'primary',
        }],
      },
      draftVersion: 2,
    })
  })

  it('rejects diagnosis confirmation unless exactly one draft entry is primary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-diagnosis-primary-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const saveResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            entries: [{
              catalogItemId: 'diagnosis-influenza',
              role: 'primary',
            }, {
              catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
              role: 'primary',
            }],
            expectedDraftVersion: 0,
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(saveResponse.status).toBe(200)
    expect(diagnosisDraftResponseSchema.parse(await saveResponse.json())).toMatchObject({
      data: { draftVersion: 1 },
    })
    const conditionSearchPath
      = `/fhir/R5/Condition?patient=Patient/${started.patientId}&_total=accurate`
    const conditionCountBefore = fhirBundleSchema.parse(await (
      await runtime.app.request(conditionSearchPath, { headers: { cookie: doctorCookie } })
    ).json()).total

    const confirmResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    expect(confirmResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await confirmResponse.json())).toEqual({
      error: {
        code: 'DIAGNOSIS_PRIMARY_REQUIRED',
        message: 'Exactly one primary diagnosis is required',
      },
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      diagnosis: {
        draft: {
          entries: [
            expect.objectContaining({ role: 'primary' }),
            expect.objectContaining({ role: 'primary' }),
          ],
        },
        draftVersion: 1,
      },
      encounter: { versionId: '1' },
    })
    const conditionCountAfter = fhirBundleSchema.parse(await (
      await runtime.app.request(conditionSearchPath, { headers: { cookie: doctorCookie } })
    ).json()).total
    expect(conditionCountAfter).toBe(conditionCountBefore)
  })

  it('confirms one primary and secondary diagnoses once with FHIR Conditions and Provenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-diagnosis-confirm-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const initialDetail = doctorCaseDetailSchema.parse(await (
      await runtime.app.request(`/api/his/v1/doctor/cases/${started.caseId}`, {
        headers: { cookie: doctorCookie },
      })
    ).json())
    const saveResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            entries: [{
              catalogItemId: 'diagnosis-influenza',
              note: '结合发热与甲型流感抗原结果。',
              role: 'primary',
            }, {
              catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
              role: 'secondary',
            }],
            expectedDraftVersion: 0,
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(saveResponse.status).toBe(200)
    expect(diagnosisDraftResponseSchema.parse(await saveResponse.json())).toMatchObject({
      data: { draftVersion: 1 },
    })
    const confirm = (idempotencyKey: ReturnType<typeof randomUUID>) => runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(doctorCookie, idempotencyKey),
        method: 'POST',
      },
    )

    const responses = await Promise.all([
      confirm(randomUUID()),
      confirm(randomUUID()),
    ])
    expect(responses.map(response => response.status).toSorted()).toEqual([200, 409])
    const successfulResponse = responses.find(response => response.status === 200)
    if (successfulResponse === undefined) throw new Error('Diagnosis confirmation did not succeed')
    const confirmed = confirmDiagnosisResponseSchema.parse(await successfulResponse.json()).data
    expect(confirmed).toMatchObject({
      confirmation: {
        confirmedAt: '2026-08-24T09:00:00+08:00',
        entries: [{
          catalogItemId: 'diagnosis-influenza',
          code: 'J10.1',
          conditionVersion: '1',
          display: '流感伴其他呼吸道表现，季节性流感病毒已标明',
          note: '结合发热与甲型流感抗原结果。',
          role: 'primary',
          system: 'http://hl7.org/fhir/sid/icd-10',
        }, {
          catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
          code: 'J06.9',
          conditionVersion: '1',
          display: '急性上呼吸道感染，未特指',
          role: 'secondary',
          system: 'http://hl7.org/fhir/sid/icd-10',
        }],
      },
      diagnosisVersion: 2,
      encounterId: started.encounterId,
      encounterVersion: '2',
    })
    const conditionIds = confirmed.confirmation.entries.map(entry => entry.conditionId)
    const conditionSearchResponse = await runtime.app.request(
      `/fhir/R5/Condition?patient=Patient/${started.patientId}&encounter=Encounter/${started.encounterId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(conditionSearchResponse.status).toBe(200)
    const conditions = fhirBundleSchema.parse(await conditionSearchResponse.json())
    expect(conditions).toMatchObject({ total: 2 })
    expect(conditions.entry?.map(entry => entry.resource)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: [expect.objectContaining({
          coding: [expect.objectContaining({ code: 'encounter-diagnosis' })],
        })],
        code: expect.objectContaining({ coding: [expect.objectContaining({ code: 'J10.1' })] }),
        encounter: { reference: `Encounter/${started.encounterId}` },
        id: conditionIds[0],
        note: [{ text: '结合发热与甲型流感抗原结果。' }],
        resourceType: 'Condition',
        subject: { reference: `Patient/${started.patientId}` },
        verificationStatus: expect.objectContaining({
          coding: [expect.objectContaining({ code: 'confirmed' })],
        }),
      }),
      expect.objectContaining({
        code: expect.objectContaining({ coding: [expect.objectContaining({ code: 'J06.9' })] }),
        id: conditionIds[1],
        resourceType: 'Condition',
      }),
    ]))
    const encounter = fhirResourceSchema.parse(await (
      await runtime.app.request(`/fhir/R5/Encounter/${started.encounterId}`, {
        headers: { cookie: doctorCookie },
      })
    ).json())
    expect(encounter).toMatchObject({
      diagnosis: [{
        condition: [{ reference: { reference: `Condition/${conditionIds[0]}` } }],
        use: [{ coding: [expect.objectContaining({ code: 'primary' })] }],
      }, {
        condition: [{ reference: { reference: `Condition/${conditionIds[1]}` } }],
        use: [{ coding: [expect.objectContaining({ code: 'secondary' })] }],
      }],
      meta: { versionId: '2' },
    })
    const provenanceSearchResponse = await runtime.app.request(
      `/fhir/R5/Provenance?target=Condition/${conditionIds[0]}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(provenanceSearchResponse.status).toBe(200)
    const provenance = fhirBundleSchema.parse(await provenanceSearchResponse.json())
    expect(provenance).toMatchObject({
      entry: [{ resource: {
        activity: { text: 'Encounter diagnosis confirmation' },
        id: confirmed.confirmation.provenanceId,
        target: expect.arrayContaining([
          { reference: `Condition/${conditionIds[0]}` },
          { reference: `Condition/${conditionIds[1]}` },
          { reference: `Encounter/${started.encounterId}` },
        ]),
      } }],
      total: 1,
    })
    const restoredDetail = doctorCaseDetailSchema.parse(await (
      await runtime.app.request(`/api/his/v1/doctor/cases/${started.caseId}`, {
        headers: { cookie: doctorCookie },
      })
    ).json())
    expect(restoredDetail.diagnosis).toEqual({
      confirmation: confirmed.confirmation,
      draftVersion: 2,
    })
    expect(restoredDetail.priorFacts).toEqual(initialDetail.priorFacts)
    expect(restoredDetail.priorFacts.map(fact => fact.id)).not.toEqual(
      expect.arrayContaining(conditionIds),
    )
  })

  it('keeps independent and legacy diagnosis drafts mutually exclusive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-diagnosis-owner-http-'))
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
    const encounterId = testCase.registration.encounterId
    const startResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/actions/start-revisit`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${encounterId}`]: '5',
            [`Task/${testCase.report.taskId}`]: '1',
          },
          input: {},
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    expect(startVisitResponseSchema.parse(await startResponse.json())).toMatchObject({
      data: { encounterVersion: '6', status: 'revisit-draft' },
    })
    const saveDiagnosisResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/diagnosis/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${encounterId}`]: '6' },
          input: {
            entries: [{ catalogItemId: 'diagnosis-influenza', role: 'primary' }],
            expectedDraftVersion: 0,
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'PUT',
      },
    )
    expect(diagnosisDraftResponseSchema.parse(await saveDiagnosisResponse.json())).toMatchObject({
      data: { draftVersion: 1 },
    })

    const legacyDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/drafts/revisit`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${encounterId}`]: '6' },
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
    expect(legacyDraftResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await legacyDraftResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    expect(runtime.database.driver.prepare(`
      SELECT 1 FROM clinical_draft
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND draft_kind = 'revisit'
    `).get('workspace-demo', 'epoch-1', testCase.caseId)).toBeUndefined()

    runtime.database.driver.prepare(`
      INSERT INTO clinical_draft (
        workspace_id, epoch, case_id, draft_kind, version,
        content_json, updated_by, updated_at
      ) VALUES (?, ?, ?, 'revisit', 1, ?, ?, ?)
    `).run(
      'workspace-demo',
      'epoch-1',
      testCase.caseId,
      JSON.stringify({
        conditionId: 'legacy-condition-owner',
        diagnosis: { code: 'J10.1', display: '甲型流感' },
      }),
      'actor-legacy-doctor',
      '2026-08-24T09:00:00+08:00',
    )
    const confirmResponse = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/diagnosis/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${encounterId}`]: '6' },
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    expect(confirmResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await confirmResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    const conditionSearchResponse = await runtime.app.request(
      `/fhir/R5/Condition?encounter=Encounter/${encounterId}&_total=accurate`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await conditionSearchResponse.json()).total).toBe(0)
  })

  it('persists a controlled prescription draft without creating formal MedicationRequests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-prescription-draft-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const catalogResponse = await runtime.app.request('/api/his/v1/catalogs/clinical', {
      headers: { cookie: doctorCookie },
    })
    const catalog = clinicalCatalogSchema.parse(await catalogResponse.json())
    expect(catalog.medications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        allowedCourseDays: [5],
        allowedQuantities: [10],
        defaultCourseDays: 5,
        defaultQuantity: 10,
        id: 'medication-oseltamivir',
      }),
    ]))
    const medicationSearchPath
      = `/fhir/R5/MedicationRequest?encounter=Encounter/${started.encounterId}&_total=accurate`
    const medicationCountBefore = fhirBundleSchema.parse(await (
      await runtime.app.request(medicationSearchPath, { headers: { cookie: doctorCookie } })
    ).json()).total
    const draft = {
      items: [{
        catalogItemId: 'medication-oseltamivir',
        courseDays: 5,
        doseText: '75 mg',
        frequencyCode: 'BID',
        quantity: 10,
      }],
    }

    const saveResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
          input: { ...draft, expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )

    expect(saveResponse.status).toBe(200)
    expect(prescriptionDraftResponseSchema.parse(await saveResponse.json())).toMatchObject({
      data: { draftVersion: 1 },
      effects: [{
        kind: 'created',
        reference: expect.stringMatching(/^PrescriptionDraft\//),
        versionId: '1',
      }],
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      medicationConclusion: { draft, draftVersion: 1 },
    })
    const medicationCountAfter = fhirBundleSchema.parse(await (
      await runtime.app.request(medicationSearchPath, { headers: { cookie: doctorCookie } })
    ).json()).total
    expect(medicationCountAfter).toBe(medicationCountBefore)
  })

  it('issues a controlled prescription once with a formal FHIR MedicationRequest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-prescription-issue-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const saveDiagnosisResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
          input: {
            entries: [{ catalogItemId: 'diagnosis-influenza', role: 'primary' }],
            expectedDraftVersion: 0,
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(diagnosisDraftResponseSchema.parse(await saveDiagnosisResponse.json())).toMatchObject({
      data: { draftVersion: 1 },
    })
    const confirmDiagnosisResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(confirmDiagnosisResponseSchema.parse(await confirmDiagnosisResponse.json())).toMatchObject({
      data: { encounterVersion: '2' },
    })
    const draft = {
      items: [{
        catalogItemId: 'medication-oseltamivir',
        courseDays: 5,
        doseText: '75 mg',
        frequencyCode: 'BID',
        quantity: 10,
      }],
    }
    const savePrescriptionResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '2' },
          input: { ...draft, expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(prescriptionDraftResponseSchema.parse(await savePrescriptionResponse.json())).toMatchObject({
      data: { draftVersion: 1 },
    })
    const endpoint
      = `/api/his/v1/encounters/${started.encounterId}/prescription/actions/issue`
    const issue = () => runtime.app.request(endpoint, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: '2' },
        input: { expectedDraftVersion: 1 },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'POST',
    })

    const issueResponse = await issue()

    expect(issueResponse.status).toBe(200)
    const issued = issuePrescriptionResponseSchema.parse(await issueResponse.json()).data
    expect(issued).toMatchObject({
      draftVersion: 2,
      prescription: {
        authoredAt: '2026-08-24T09:00:00+08:00',
        authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
        items: [{
          ...draft.items[0],
          display: '磷酸奥司他韦胶囊',
          medicationRequestVersion: '1',
        }],
        status: 'signed',
        version: 1,
      },
    })
    const medicationRequestId = issued.prescription.items[0]?.medicationRequestId
    if (medicationRequestId === undefined) throw new Error('Prescription has no MedicationRequest')
    const medicationRequest = fhirResourceSchema.parse(await (
      await runtime.app.request(`/fhir/R5/MedicationRequest/${medicationRequestId}`, {
        headers: { cookie: doctorCookie },
      })
    ).json())
    expect(medicationRequest).toMatchObject({
      authoredOn: '2026-08-24T09:00:00+08:00',
      dispenseRequest: { quantity: { value: 10 } },
      dosageInstruction: [{
        text: '75 mg BID for 5 days',
        timing: { repeat: { boundsDuration: { code: 'd', value: 5 } } },
      }],
      encounter: { reference: `Encounter/${started.encounterId}` },
      groupIdentifier: { value: issued.prescription.number },
      intent: 'order',
      medication: { reference: {
        display: '磷酸奥司他韦胶囊',
        reference: 'Medication/medication-oseltamivir',
      } },
      requester: { reference: 'PractitionerRole/practitioner-role-outpatient-doctor' },
      status: 'active',
      subject: { reference: `Patient/${started.patientId}` },
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      medicationConclusion: {
        draftVersion: 2,
        prescription: issued.prescription,
      },
    })
    const duplicateResponse = await issue()
    expect(duplicateResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await duplicateResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    const medicationSearchResponse = await runtime.app.request(
      `/fhir/R5/MedicationRequest?encounter=Encounter/${started.encounterId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await medicationSearchResponse.json()).total).toBe(1)
  })

  it('keeps the prescription draft when diagnosis or allergy validation rejects issuing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-prescription-safety-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const diagnosisDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
          input: {
            entries: [{
              catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
              role: 'primary',
            }],
            expectedDraftVersion: 0,
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(diagnosisDraftResponse.status).toBe(200)
    const diagnosisDraft = diagnosisDraftResponseSchema.parse(
      await diagnosisDraftResponse.json(),
    ).data
    const confirmDiagnosisResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
          input: { expectedDraftVersion: diagnosisDraft.draftVersion },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(confirmDiagnosisResponse.status).toBe(200)
    const encounterVersion = confirmDiagnosisResponseSchema.parse(
      await confirmDiagnosisResponse.json(),
    ).data.encounterVersion
    const draft = {
      items: [{
        catalogItemId: 'medication-oseltamivir',
        courseDays: 5,
        doseText: '75 mg',
        frequencyCode: 'BID',
        quantity: 10,
      }],
    }
    const prescriptionDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: encounterVersion },
          input: { ...draft, expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(prescriptionDraftResponse.status).toBe(200)
    const prescriptionDraftVersion = prescriptionDraftResponseSchema.parse(
      await prescriptionDraftResponse.json(),
    ).data.draftVersion
    const issue = () => runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: encounterVersion },
          input: { expectedDraftVersion: prescriptionDraftVersion },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )

    const diagnosisRejected = await issue()

    expect(diagnosisRejected.status).toBe(409)
    expect(apiErrorSchema.parse(await diagnosisRejected.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT' },
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
      criticality: 'high',
      code: {
        coding: [{
          code: 'OSELTAMIVIR',
          display: '磷酸奥司他韦',
          system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/synthetic-medication',
        }],
        text: '磷酸奥司他韦过敏',
      },
      patient: { reference: `Patient/${started.patientId}` },
      recordedDate: '2026-08-24T08:30:00+08:00',
    })

    const allergyRejected = await issue()

    expect(allergyRejected.status).toBe(409)
    expect(apiErrorSchema.parse(await allergyRejected.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      medicationConclusion: {
        draft,
        draftVersion: prescriptionDraftVersion,
      },
    })
    const medicationSearchResponse = await runtime.app.request(
      `/fhir/R5/MedicationRequest?encounter=Encounter/${started.encounterId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await medicationSearchResponse.json()).total).toBe(0)
  })

  it('records a responsible no-medication conclusion and locks prescription editing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-no-medication-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const endpoint
      = `/api/his/v1/encounters/${started.encounterId}/medication-conclusion/actions/confirm-no-medication`

    const response = await runtime.app.request(endpoint, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
        input: { expectedDraftVersion: 0 },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'POST',
    })

    expect(response.status).toBe(200)
    const conclusion = confirmNoMedicationResponseSchema.parse(await response.json()).data
    expect(conclusion).toMatchObject({
      draftVersion: 1,
      noMedication: {
        authoredAt: '2026-08-24T09:00:00+08:00',
        authoredByActorId: 'actor-outpatient-doctor',
        authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
        version: 1,
      },
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      medicationConclusion: {
        draftVersion: 1,
        noMedication: conclusion.noMedication,
      },
    })
    const medicationSearchResponse = await runtime.app.request(
      `/fhir/R5/MedicationRequest?encounter=Encounter/${started.encounterId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await medicationSearchResponse.json()).total).toBe(0)
    const saveDraftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
          input: {
            expectedDraftVersion: 1,
            items: [{
              catalogItemId: 'medication-acetaminophen',
              courseDays: 3,
              doseText: '0.5 g',
              frequencyCode: 'PRN',
              quantity: 6,
            }],
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(saveDraftResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await saveDraftResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    const duplicateResponse = await runtime.app.request(endpoint, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: '1' },
        input: { expectedDraftVersion: 1 },
      }),
      headers: commandHeaders(doctorCookie),
      method: 'POST',
    })
    expect(duplicateResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await duplicateResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
  })

  it('lets only the responsible doctor withdraw an undispensed prescription', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-prescription-withdrawal-http-'))
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
    const medicationRequestId = testCase.draft.medicationRequestIds[0]
    if (medicationRequestId === undefined) throw new Error('Signed prescription has no medication')
    const endpoint
      = `/api/his/v1/prescriptions/${testCase.draft.prescriptionId}/actions/withdraw`

    const otherDoctorCookie = await selectAdditionalDoctorRole(runtime, password)
    const unauthorizedResponse = await runtime.app.request(endpoint, {
      body: JSON.stringify({
        expectedVersions: { [`MedicationRequest/${medicationRequestId}`]: '2' },
        input: { expectedPrescriptionVersion: 2 },
      }),
      headers: commandHeaders(otherDoctorCookie),
      method: 'POST',
    })
    expect(unauthorizedResponse.status).toBe(403)
    expect(apiErrorSchema.parse(await unauthorizedResponse.json())).toMatchObject({
      error: {
        code: 'ROLE_NOT_ALLOWED',
        message: 'The outpatient case belongs to another doctor',
      },
    })

    const response = await runtime.app.request(endpoint, {
      body: JSON.stringify({
        expectedVersions: { [`MedicationRequest/${medicationRequestId}`]: '2' },
        input: { expectedPrescriptionVersion: 2 },
      }),
      headers: commandHeaders(testCase.doctorCookie),
      method: 'POST',
    })

    expect(response.status).toBe(200)
    const withdrawal = withdrawPrescriptionResponseSchema.parse(await response.json())
    const withdrawn = withdrawal.data
    expect(withdrawn).toMatchObject({
      medicationRequests: [{ id: medicationRequestId, version: '3' }],
      prescriptionId: testCase.draft.prescriptionId,
      prescriptionVersion: 3,
      status: 'withdrawn',
      withdrawal: {
        prescriptionId: testCase.draft.prescriptionId,
        version: 1,
        withdrawnAt: '2026-08-24T09:00:00+08:00',
        withdrawnByActorId: 'actor-outpatient-doctor',
        withdrawnByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
      },
    })
    await expectCommandAudit(
      runtime,
      testCase.doctorCookie,
      withdrawal.auditId,
      'prescription.withdraw',
    )
    const requestResponse = await runtime.app.request(
      `/fhir/R5/MedicationRequest/${medicationRequestId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await requestResponse.json())).toMatchObject({
      meta: { versionId: '3' },
      status: 'cancelled',
    })
    const historyResponse = await runtime.app.request(
      `/fhir/R5/MedicationRequest/${medicationRequestId}/_history`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    const history = fhirBundleSchema.parse(await historyResponse.json())
    expect(history.total).toBe(3)
    expect(history.entry?.map(entry => entry.resource?.status)).toEqual([
      'cancelled',
      'active',
      'draft',
    ])
    const cashierCookie = await signIn(runtime, 'cashier@demo.clinmesh.local', password)
    const billingQueueResponse = await runtime.app.request(
      '/api/his/v1/billing/queue?category=medication&status=pending&pageSize=20',
      { headers: { cookie: cashierCookie } },
    )
    expect(billingQueueSchema.parse(await billingQueueResponse.json())).toMatchObject({
      items: [],
      total: 0,
    })
    const paymentResponse = await runtime.app.request('/api/his/v1/payments/actions/preview', {
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
    expect(paymentResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await paymentResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    const duplicateResponse = await runtime.app.request(endpoint, {
      body: JSON.stringify({
        expectedVersions: { [`MedicationRequest/${medicationRequestId}`]: '3' },
        input: { expectedPrescriptionVersion: 3 },
      }),
      headers: commandHeaders(testCase.doctorCookie),
      method: 'POST',
    })
    expect(duplicateResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await duplicateResponse.json())).toMatchObject({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The prescription is already withdrawn at version 3',
      },
    })
    expectCommandAuditOutcomes(runtime, 'prescription.withdraw', ['failed', 'success', 'failed'])
  })

  it('withdraws a paid prescription without refunding it and excludes pharmacy fulfillment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-paid-prescription-withdrawal-http-'))
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
    const beforeWithdrawalResponse = await runtime.app.request(
      '/api/his/v1/pharmacy/queue?pageSize=20',
      { headers: { cookie: testCase.pharmacistCookie } },
    )
    const pendingPrescription = pharmacyQueueSchema.parse(
      await beforeWithdrawalResponse.json(),
    ).items[0]
    const pendingMedication = pendingPrescription?.medications[0]
    const pendingLot = pendingMedication?.lots[0]
    if (
      pendingPrescription === undefined
      || pendingMedication === undefined
      || pendingLot === undefined
    ) {
      throw new Error('Paid prescription did not expose dispensable inventory')
    }

    const withdrawalResponse = await runtime.app.request(
      `/api/his/v1/prescriptions/${pendingPrescription.prescriptionId}/actions/withdraw`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`MedicationRequest/${pendingMedication.medicationRequestId}`]
              : pendingMedication.medicationRequestVersion,
          },
          input: { expectedPrescriptionVersion: pendingPrescription.prescriptionVersion },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )

    expect(withdrawalResponse.status).toBe(200)
    const withdrawn = withdrawPrescriptionResponseSchema.parse(
      await withdrawalResponse.json(),
    ).data
    const paidBillingResponse = await runtime.app.request(
      '/api/his/v1/billing/queue?category=medication&status=paid&pageSize=20',
      { headers: { cookie: testCase.cashierCookie } },
    )
    expect(billingQueueSchema.parse(await paidBillingResponse.json())).toMatchObject({
      items: [{
        caseId: testCase.caseId,
        chargeItemId: testCase.signed.chargeItemId,
        status: 'paid',
      }],
      total: 1,
    })
    const pharmacyQueueResponse = await runtime.app.request(
      '/api/his/v1/pharmacy/queue?pageSize=20',
      { headers: { cookie: testCase.pharmacistCookie } },
    )
    expect(pharmacyQueueSchema.parse(await pharmacyQueueResponse.json())).toMatchObject({
      items: [],
      total: 0,
    })
    const dispenseResponse = await runtime.app.request(
      `/api/his/v1/prescriptions/${pendingPrescription.prescriptionId}/actions/dispense`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${pendingPrescription.encounterId}`]
              : pendingPrescription.encounterVersion,
            [`MedicationRequest/${pendingMedication.medicationRequestId}`]
              : withdrawn.medicationRequests[0]?.version,
          },
          input: {
            expectedPrescriptionVersion: withdrawn.prescriptionVersion,
            lotSelections: [{
              expectedVersion: pendingLot.version,
              lotId: pendingLot.id,
              quantity: pendingMedication.remainingQuantity,
            }],
          },
        }),
        headers: commandHeaders(testCase.pharmacistCookie),
        method: 'POST',
      },
    )
    expect(dispenseResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await dispenseResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
  })

  it('prevents the legacy revisit draft from taking over an independent prescription draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-prescription-owner-http-'))
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
    const startRevisitResponse = await runtime.app.request(
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
    expect(startRevisitResponse.status).toBe(200)
    const draft = {
      items: [{
        catalogItemId: 'medication-oseltamivir',
        courseDays: 5,
        doseText: '75 mg',
        frequencyCode: 'BID',
        quantity: 10,
      }],
    }
    const independentResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${testCase.registration.encounterId}`]: '6' },
          input: { ...draft, expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'PUT',
      },
    )
    expect(independentResponse.status).toBe(200)
    const independentVersion = prescriptionDraftResponseSchema.parse(
      await independentResponse.json(),
    ).data.draftVersion

    const legacyResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.registration.encounterId}/drafts/revisit`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${testCase.registration.encounterId}`]: '6' },
          input: {
            diagnosis: { code: 'J10.1', display: '甲型流感' },
            document: {
              assessment: '甲型流感，生命体征稳定。',
              plan: '继续对症治疗并观察。',
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

    expect(legacyResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await legacyResponse.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT' },
    })
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${testCase.caseId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      medicationConclusion: { draft, draftVersion: independentVersion },
    })
    const requestSearchResponse = await runtime.app.request(
      `/fhir/R5/MedicationRequest?encounter=Encounter/${testCase.registration.encounterId}&_total=accurate`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await requestSearchResponse.json()).total).toBe(0)
  })

  it('lets only the responsible doctor delete the current prescription draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-prescription-draft-delete-http-'))
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
    const { doctorCookie, started } = await startVirtualPatientConsultation(runtime, password)
    const expectedVersions = { [`Encounter/${started.encounterId}`]: '1' }
    const draftResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: {
            expectedDraftVersion: 0,
            items: [{
              catalogItemId: 'medication-acetaminophen',
              courseDays: 3,
              doseText: '0.5 g',
              frequencyCode: 'PRN',
              quantity: 6,
            }],
          },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'PUT',
      },
    )
    expect(draftResponse.status).toBe(200)
    const endpoint = `/api/his/v1/encounters/${started.encounterId}/prescription/draft`
    const idempotencyKey = randomUUID()
    const otherDoctorCookie = await selectAdditionalDoctorRole(runtime, password)
    const unauthorizedDeleteResponse = await runtime.app.request(endpoint, {
      body: JSON.stringify({
        expectedVersions,
        input: { expectedDraftVersion: 1 },
      } satisfies typeof deletePrescriptionDraftRequestSchema._output),
      headers: commandHeaders(otherDoctorCookie),
      method: 'DELETE',
    })
    expect(unauthorizedDeleteResponse.status).toBe(403)
    expect(apiErrorSchema.parse(await unauthorizedDeleteResponse.json())).toMatchObject({
      error: {
        code: 'ROLE_NOT_ALLOWED',
        message: 'The outpatient case belongs to another doctor',
      },
    })
    const remove = () => runtime.app.request(endpoint, {
      body: JSON.stringify({
        expectedVersions,
        input: { expectedDraftVersion: 1 },
      } satisfies typeof deletePrescriptionDraftRequestSchema._output),
      headers: commandHeaders(doctorCookie, idempotencyKey),
      method: 'DELETE',
    })

    const deleteResponse = await remove()

    expect(deleteResponse.status).toBe(200)
    const deleted = prescriptionDraftResponseSchema.parse(await deleteResponse.json())
    expect(deleted).toMatchObject({
      data: { draftVersion: 2 },
      effects: [{
        kind: 'updated',
        reference: `PrescriptionDraft/${started.caseId}`,
        versionId: '2',
      }],
    })
    await expectCommandAudit(
      runtime,
      doctorCookie,
      deleted.auditId,
      'encounter.delete-prescription-draft',
    )
    expect(prescriptionDraftResponseSchema.parse(await (await remove()).json())).toEqual(deleted)
    const staleResponse = await runtime.app.request(endpoint, {
      body: JSON.stringify({
        expectedVersions,
        input: { expectedDraftVersion: 1 },
      } satisfies typeof deletePrescriptionDraftRequestSchema._output),
      headers: commandHeaders(doctorCookie),
      method: 'DELETE',
    })
    expect(staleResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await staleResponse.json())).toMatchObject({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The prescription draft is empty at version 2',
      },
    })
    expectCommandAuditOutcomes(runtime, 'encounter.delete-prescription-draft', [
      'failed',
      'success',
      'failed',
    ])
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.caseId}`,
      { headers: { cookie: doctorCookie } },
    )
    const detail = doctorCaseDetailSchema.parse(await detailResponse.json())
    expect(detail).toMatchObject({ medicationConclusion: { draftVersion: 2 } })
    expect(detail.medicationConclusion?.draft).toBeUndefined()
    const issueResponse = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/prescription/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions,
          input: { expectedDraftVersion: 2 },
        }),
        headers: commandHeaders(doctorCookie),
        method: 'POST',
      },
    )
    expect(issueResponse.status).toBe(409)
    const requestSearchResponse = await runtime.app.request(
      `/fhir/R5/MedicationRequest?encounter=Encounter/${started.encounterId}&_total=accurate`,
      { headers: { cookie: doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await requestSearchResponse.json()).total).toBe(0)
  })

  it('allows no medication only after the active prescription is withdrawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-medication-conclusion-switch-http-'))
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
    const testCase = await createIssuedIndependentPrescription(runtime, password)
    const noMedicationEndpoint
      = `/api/his/v1/encounters/${testCase.started.encounterId}/medication-conclusion/actions/confirm-no-medication`
    const confirmNoMedication = (expectedDraftVersion: number) => runtime.app.request(
      noMedicationEndpoint,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${testCase.started.encounterId}`]: testCase.encounterVersion,
          },
          input: { expectedDraftVersion },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )

    const activeConclusionResponse = await confirmNoMedication(testCase.issued.draftVersion)
    expect(activeConclusionResponse.status).toBe(409)
    const editResponse = await runtime.app.request(
      `/api/his/v1/encounters/${testCase.started.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${testCase.started.encounterId}`]: testCase.encounterVersion,
          },
          input: {
            ...testCase.draft,
            expectedDraftVersion: testCase.issued.draftVersion,
          },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'PUT',
      },
    )
    expect(editResponse.status).toBe(409)
    const medicationRequest = testCase.issued.prescription.items[0]
    if (medicationRequest === undefined) throw new Error('Issued prescription has no medication')
    const withdrawalResponse = await runtime.app.request(
      `/api/his/v1/prescriptions/${testCase.issued.prescription.id}/actions/withdraw`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`MedicationRequest/${medicationRequest.medicationRequestId}`]
              : medicationRequest.medicationRequestVersion,
          },
          input: { expectedPrescriptionVersion: testCase.issued.prescription.version },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )
    expect(withdrawalResponse.status).toBe(200)

    const noMedicationResponse = await confirmNoMedication(testCase.issued.draftVersion)

    expect(noMedicationResponse.status).toBe(200)
    const noMedication = confirmNoMedicationResponseSchema.parse(
      await noMedicationResponse.json(),
    ).data
    expect(noMedication.draftVersion).toBe(testCase.issued.draftVersion + 1)
    const detailResponse = await runtime.app.request(
      `/api/his/v1/doctor/cases/${testCase.started.caseId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(doctorCaseDetailSchema.parse(await detailResponse.json())).toMatchObject({
      medicationConclusion: {
        draftVersion: noMedication.draftVersion,
        noMedication: noMedication.noMedication,
        prescription: {
          id: testCase.issued.prescription.id,
          status: 'withdrawn',
          version: 2,
        },
      },
    })
  })

  it('rejects prescription withdrawal after any quantity has been dispensed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-dispensed-withdrawal-http-'))
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
      throw new Error('Paid prescription did not expose dispensable inventory')
    }
    const dispenseResponse = await runtime.app.request(
      `/api/his/v1/prescriptions/${prescription.prescriptionId}/actions/dispense`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`Encounter/${prescription.encounterId}`]: prescription.encounterVersion,
            [`MedicationRequest/${medication.medicationRequestId}`]
              : medication.medicationRequestVersion,
          },
          input: {
            expectedPrescriptionVersion: prescription.prescriptionVersion,
            lotSelections: [{
              expectedVersion: lot.version,
              lotId: lot.id,
              quantity: 5,
            }],
          },
        }),
        headers: commandHeaders(testCase.pharmacistCookie),
        method: 'POST',
      },
    )
    expect(dispenseResponse.status).toBe(200)
    const dispensed = dispenseResponseSchema.parse(await dispenseResponse.json()).data
    expect(dispensed).toMatchObject({ status: 'partial' })

    const withdrawalResponse = await runtime.app.request(
      `/api/his/v1/prescriptions/${prescription.prescriptionId}/actions/withdraw`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [`MedicationRequest/${medication.medicationRequestId}`]
              : medication.medicationRequestVersion,
          },
          input: { expectedPrescriptionVersion: dispensed.prescriptionVersion },
        }),
        headers: commandHeaders(testCase.doctorCookie),
        method: 'POST',
      },
    )

    expect(withdrawalResponse.status).toBe(409)
    expect(apiErrorSchema.parse(await withdrawalResponse.json())).toMatchObject({
      error: {
        code: 'WORKFLOW_CONFLICT',
        message: 'The prescription cannot be withdrawn because its current state is "dispensing-started"',
      },
    })
    expectCommandAuditOutcomes(runtime, 'prescription.withdraw', ['failed'])
    const requestResponse = await runtime.app.request(
      `/fhir/R5/MedicationRequest/${medication.medicationRequestId}`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirResourceSchema.parse(await requestResponse.json())).toMatchObject({
      meta: { versionId: medication.medicationRequestVersion },
      status: 'active',
    })
    const dispenseSearchResponse = await runtime.app.request(
      `/fhir/R5/MedicationDispense?prescription=MedicationRequest/${medication.medicationRequestId}&_total=accurate`,
      { headers: { cookie: testCase.doctorCookie } },
    )
    expect(fhirBundleSchema.parse(await dispenseSearchResponse.json()).total).toBe(1)
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
