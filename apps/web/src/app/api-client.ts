import {
  apiErrorSchema,
  askConsultationQuestionResponseSchema,
  billingQueueSchema,
  clinicalSignPreviewResponseSchema,
  clinicalSignResponseSchema,
  createPatientResponseSchema,
  clinicalCatalogSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  firstVisitDraftResponseSchema,
  laboratoryOrderResponseSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  pharmacyQueueSchema,
  prescriptionReviewResponseSchema,
  dispenseResponseSchema,
  patientSearchSchema,
  registrationCatalogSchema,
  registrationQueueSchema,
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
  type ScenarioState,
  type SessionContext,
} from '@clinmesh/contracts/his'
import { z } from 'zod'

export const sessionQueryKey = ['session-context'] as const

export class ApiClientError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
  }
}

async function parseResponse<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const body: unknown = await response.json()
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body)
    throw new ApiClientError(
      response.status,
      parsed.success ? parsed.data.error.code : 'UNEXPECTED_RESPONSE',
      parsed.success ? parsed.data.error.message : `Request failed with status ${response.status}`,
    )
  }
  return schema.parse(body)
}

export async function apiGet<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  signal?: AbortSignal,
): Promise<z.infer<Schema>> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  return parseResponse(response, schema)
}

export async function apiMutation<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  body?: unknown,
  options: { idempotencyKey?: string; method?: 'POST' | 'PUT' } = {},
): Promise<z.infer<Schema>> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  }
  if (options.idempotencyKey !== undefined) {
    headers['idempotency-key'] = options.idempotencyKey
  }
  const response = await fetch(path, {
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
    headers,
    method: options.method ?? 'POST',
  })
  return parseResponse(response, schema)
}

export function getSession(signal?: AbortSignal): Promise<SessionContext> {
  return apiGet('/api/auth/context', sessionContextSchema, signal)
}

export async function signIn(email: string, password: string): Promise<void> {
  await apiMutation(
    '/api/auth/sign-in/email',
    z.object({ user: z.object({ id: z.string().min(1) }).loose() }).loose(),
    { email, password },
  )
}

export async function signOut(): Promise<void> {
  await apiMutation('/api/auth/sign-out', z.object({}).loose())
}

export function selectRole(practitionerRoleId: string): Promise<SessionContext> {
  return apiMutation(
    '/api/auth/role',
    sessionContextSchema,
    { practitionerRoleId },
  )
}

export function getCurrentScenario(signal?: AbortSignal): Promise<ScenarioState> {
  return apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal)
}

export function installScenario(
  kind: 'candidate' | 'density',
  idempotencyKey: string,
) {
  return apiMutation(
    '/api/sim/v1/scenarios/actions/install',
    scenarioCommandResponseSchema,
    { kind },
    { idempotencyKey },
  )
}

export function resetScenario(scenarioRunId: string, idempotencyKey: string) {
  return apiMutation(
    `/api/sim/v1/scenario-runs/${encodeURIComponent(scenarioRunId)}/actions/reset`,
    scenarioCommandResponseSchema,
    {},
    { idempotencyKey },
  )
}

export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID()
}

export function getRegistrationCatalog(signal?: AbortSignal) {
  return apiGet('/api/his/v1/catalogs/registration', registrationCatalogSchema, signal)
}

export function getRegistrationQueue(signal?: AbortSignal, page = 1) {
  const search = new URLSearchParams({ page: String(page), pageSize: '20' })
  return apiGet(`/api/his/v1/registrations?${search.toString()}`, registrationQueueSchema, signal)
}

export function searchPatients(query: string, signal?: AbortSignal, page = 1) {
  const search = new URLSearchParams({ page: String(page), pageSize: '20', query })
  return apiGet(`/api/his/v1/patients?${search.toString()}`, patientSearchSchema, signal)
}

export function createSyntheticPatient(input: {
  birthDate: string
  gender: 'female' | 'male' | 'other' | 'unknown'
  identifier: string
  name: string
}, idempotencyKey: string) {
  return apiMutation(
    '/api/his/v1/patients',
    createPatientResponseSchema,
    { expectedVersions: {}, input },
    { idempotencyKey },
  )
}

export function registerOutpatient(input: {
  departmentId: string
  locationId: string
  patientId: string
  patientVersion: string
  visitDate: string
  visitTypeId: string
}, idempotencyKey: string) {
  return apiMutation(
    '/api/his/v1/registrations/actions/register',
    registrationResponseSchema,
    {
      expectedVersions: { [`Patient/${input.patientId}`]: input.patientVersion },
      input: {
        departmentId: input.departmentId,
        locationId: input.locationId,
        patientId: input.patientId,
        visitDate: input.visitDate,
        visitTypeId: input.visitTypeId,
      },
    },
    { idempotencyKey },
  )
}

export function getTriageQueue(
  status: 'completed' | 'exception' | 'pending',
  signal?: AbortSignal,
  page = 1,
) {
  const search = new URLSearchParams({ page: String(page), pageSize: '20', status })
  return apiGet(`/api/his/v1/triage/queue?${search.toString()}`, triageQueueSchema, signal)
}

export function recordTriage(input: {
  acuityCode: 'level-1' | 'level-2' | 'level-3' | 'level-4'
  bloodPressure: { diastolicMmHg: number; systolicMmHg: number }
  chiefComplaint: string
  encounterId: string
  encounterVersion: string
  oxygenSaturationPct: number
  pulseBpm: number
  respirationBpm: number
  taskId: string
  taskVersion: string
  temperatureC: number
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/encounters/${encodeURIComponent(input.encounterId)}/actions/record-triage`,
    triageResponseSchema,
    {
      expectedVersions: {
        [`Encounter/${input.encounterId}`]: input.encounterVersion,
        [`Task/${input.taskId}`]: input.taskVersion,
      },
      input: {
        acuityCode: input.acuityCode,
        bloodPressure: input.bloodPressure,
        chiefComplaint: input.chiefComplaint,
        oxygenSaturationPct: input.oxygenSaturationPct,
        pulseBpm: input.pulseBpm,
        respirationBpm: input.respirationBpm,
        temperatureC: input.temperatureC,
      },
    },
    { idempotencyKey },
  )
}

export function getClinicalCatalog(signal?: AbortSignal) {
  return apiGet('/api/his/v1/catalogs/clinical', clinicalCatalogSchema, signal)
}

export function getDoctorQueue(signal?: AbortSignal, page = 1) {
  const search = new URLSearchParams({ page: String(page), pageSize: '20' })
  return apiGet(`/api/his/v1/doctor/queue?${search.toString()}`, doctorQueueSchema, signal)
}

export function getVirtualPatients(signal?: AbortSignal, page = 1) {
  const search = new URLSearchParams({ page: String(page), pageSize: '20' })
  return apiGet(`/api/his/v1/doctor/virtual-patients?${search.toString()}`, virtualPatientListSchema, signal)
}

export function startVirtualPatient(
  virtualPatientId: string,
  expectedVersion: string,
  idempotencyKey: string,
) {
  return apiMutation(
    `/api/his/v1/doctor/virtual-patients/${encodeURIComponent(virtualPatientId)}/actions/start`,
    startVirtualPatientResponseSchema,
    {
      expectedVersions: {},
      input: { expectedVersion },
    },
    { idempotencyKey },
  )
}

export function askConsultationQuestion(input: {
  encounterId: string
  encounterVersion: string
  expectedVersion: number
  questionCode: string
  taskId: string
  taskVersion: string
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/encounters/${encodeURIComponent(input.encounterId)}/actions/ask-consultation-question`,
    askConsultationQuestionResponseSchema,
    {
      expectedVersions: {
        [`Encounter/${input.encounterId}`]: input.encounterVersion,
        [`Task/${input.taskId}`]: input.taskVersion,
      },
      input: {
        expectedVersion: input.expectedVersion,
        questionCode: input.questionCode,
      },
    },
    { idempotencyKey },
  )
}

export function getDoctorCase(caseId: string, signal?: AbortSignal) {
  return apiGet(
    `/api/his/v1/doctor/cases/${encodeURIComponent(caseId)}`,
    doctorCaseDetailSchema,
    signal,
  )
}

export function startFirstVisit(input: {
  encounterId: string
  encounterVersion: string
  taskId: string
  taskVersion: string
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/encounters/${encodeURIComponent(input.encounterId)}/actions/start-first-visit`,
    startVisitResponseSchema,
    {
      expectedVersions: {
        [`Encounter/${input.encounterId}`]: input.encounterVersion,
        [`Task/${input.taskId}`]: input.taskVersion,
      },
      input: {},
    },
    { idempotencyKey },
  )
}

export function saveFirstVisitDraft(input: {
  assessment: string
  encounterId: string
  encounterVersion: string
  expectedDraftVersion: number
  historyOfPresentIllness: string
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/encounters/${encodeURIComponent(input.encounterId)}/drafts/first-visit`,
    firstVisitDraftResponseSchema,
    {
      expectedVersions: { [`Encounter/${input.encounterId}`]: input.encounterVersion },
      input: {
        assessment: input.assessment,
        expectedDraftVersion: input.expectedDraftVersion,
        historyOfPresentIllness: input.historyOfPresentIllness,
      },
    },
    { idempotencyKey, method: 'PUT' },
  )
}

export function issueLaboratoryOrder(input: {
  catalogItemId: string
  encounterId: string
  encounterVersion: string
  expectedDraftVersion: number
  indicationCode: string
  taskId: string
  taskVersion: string
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/encounters/${encodeURIComponent(input.encounterId)}/actions/issue-laboratory-order`,
    laboratoryOrderResponseSchema,
    {
      expectedVersions: {
        [`Encounter/${input.encounterId}`]: input.encounterVersion,
        [`Task/${input.taskId}`]: input.taskVersion,
      },
      input: {
        catalogItemId: input.catalogItemId,
        expectedDraftVersion: input.expectedDraftVersion,
        indicationCode: input.indicationCode,
      },
    },
    { idempotencyKey },
  )
}

export function startRevisit(input: {
  encounterId: string
  encounterVersion: string
  taskId: string
  taskVersion: string
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/encounters/${encodeURIComponent(input.encounterId)}/actions/start-revisit`,
    startVisitResponseSchema,
    {
      expectedVersions: {
        [`Encounter/${input.encounterId}`]: input.encounterVersion,
        [`Task/${input.taskId}`]: input.taskVersion,
      },
      input: {},
    },
    { idempotencyKey },
  )
}

export function saveRevisitDraft(input: {
  diagnosis: { code: string; display: string }
  document: { assessment: string; plan: string }
  draftVersions: { documentDraft: number; prescription: number; revisitDraft: number }
  encounterId: string
  expectedVersions: Record<string, string>
  medications: Array<{
    catalogItemId: string
    doseText: string
    frequencyCode: string
    quantity: number
  }>
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/encounters/${encodeURIComponent(input.encounterId)}/drafts/revisit`,
    revisitDraftResponseSchema,
    {
      expectedVersions: input.expectedVersions,
      input: {
        diagnosis: input.diagnosis,
        document: input.document,
        expectedVersions: input.draftVersions,
        medications: input.medications,
      },
    },
    { idempotencyKey, method: 'PUT' },
  )
}

export function previewClinicalSign(input: {
  draftVersions: { documentDraft: number; prescription: number; revisitDraft: number }
  encounterId: string
  expectedVersions: Record<string, string>
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/encounters/${encodeURIComponent(input.encounterId)}/actions/preview-sign`,
    clinicalSignPreviewResponseSchema,
    {
      expectedVersions: input.expectedVersions,
      input: { expectedDraftVersions: input.draftVersions },
    },
    { idempotencyKey },
  )
}

export function signClinicalDocument(input: {
  commitToken: string
  encounterId: string
  expectedVersions: Record<string, string>
  previewId: string
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/encounters/${encodeURIComponent(input.encounterId)}/actions/sign-and-complete`,
    clinicalSignResponseSchema,
    {
      expectedVersions: input.expectedVersions,
      input: {
        commitToken: input.commitToken,
        previewId: input.previewId,
      },
    },
    { idempotencyKey },
  )
}

export function getBillingQueue(
  category: 'laboratory' | 'medication',
  status: 'ambiguous' | 'declined' | 'paid' | 'pending',
  signal?: AbortSignal,
  page = 1,
) {
  const search = new URLSearchParams({ category, page: String(page), pageSize: '20', status })
  return apiGet(`/api/his/v1/billing/queue?${search.toString()}`, billingQueueSchema, signal)
}

export function previewPayment(input: {
  caseId: string
  category: 'laboratory' | 'medication'
  chargeItemId: string
  chargeVersion: number
  simulatorRule: 'ambiguous' | 'decline' | 'success'
}, idempotencyKey: string) {
  return apiMutation(
    '/api/his/v1/payments/actions/preview',
    paymentPreviewResponseSchema,
    {
      expectedVersions: { [`ChargeItem/${input.chargeItemId}`]: String(input.chargeVersion) },
      input: {
        caseId: input.caseId,
        category: input.category,
        simulatorRule: input.simulatorRule,
      },
    },
    { idempotencyKey },
  )
}

export function confirmPayment(input: {
  chargeItemId: string
  chargeVersion: number
  commitToken: string
  previewId: string
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/payments/${encodeURIComponent(input.previewId)}/actions/confirm`,
    paymentResponseSchema,
    {
      expectedVersions: { [`ChargeItem/${input.chargeItemId}`]: String(input.chargeVersion) },
      input: { commitToken: input.commitToken },
    },
    { idempotencyKey },
  )
}

export function getPharmacyQueue(
  status: 'completed' | 'exception' | 'pending',
  signal?: AbortSignal,
  page = 1,
) {
  const search = new URLSearchParams({ page: String(page), pageSize: '20', status })
  return apiGet(`/api/his/v1/pharmacy/queue?${search.toString()}`, pharmacyQueueSchema, signal)
}

export function reviewPrescription(input: {
  encounterId: string
  encounterVersion: string
  medications: Array<{
    medicationRequestId: string
    medicationRequestVersion: string
  }>
  note: string
  prescriptionId: string
  prescriptionVersion: number
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/prescriptions/${encodeURIComponent(input.prescriptionId)}/actions/review`,
    prescriptionReviewResponseSchema,
    {
      expectedVersions: Object.fromEntries([
        [`Encounter/${input.encounterId}`, input.encounterVersion],
        ...input.medications.map(medication => [
          `MedicationRequest/${medication.medicationRequestId}`,
          medication.medicationRequestVersion,
        ]),
      ]),
      input: {
        expectedPrescriptionVersion: input.prescriptionVersion,
        note: input.note,
      },
    },
    { idempotencyKey },
  )
}

export function dispensePrescription(input: {
  encounterId: string
  encounterVersion: string
  medications: Array<{
    medicationRequestId: string
    medicationRequestVersion: string
  }>
  prescriptionId: string
  prescriptionVersion: number
  lotSelections: Array<{
    expectedVersion: number
    lotId: string
    quantity: number
  }>
}, idempotencyKey: string) {
  return apiMutation(
    `/api/his/v1/prescriptions/${encodeURIComponent(input.prescriptionId)}/actions/dispense`,
    dispenseResponseSchema,
    {
      expectedVersions: Object.fromEntries([
        [`Encounter/${input.encounterId}`, input.encounterVersion],
        ...input.medications.map(medication => [
          `MedicationRequest/${medication.medicationRequestId}`,
          medication.medicationRequestVersion,
        ]),
      ]),
      input: {
        expectedPrescriptionVersion: input.prescriptionVersion,
        lotSelections: input.lotSelections,
      },
    },
    { idempotencyKey },
  )
}
