import { z } from 'zod'
import {
  capabilityStatementSchema,
  fhirResourceSchema,
  isSupportedFhirSearchParameter,
  supportedFhirResourceTypeSchema,
} from './fhir.ts'
import {
  acknowledgeLaboratoryReportRequestSchema,
  acknowledgeLaboratoryReportResponseSchema,
  askConsultationQuestionResponseSchema,
  billingQueueSchema,
  cancelLaboratoryRequestRequestSchema,
  caseLaboratoryCatalogSearchSchema,
  clinicalCatalogSchema,
  clinicalDocumentContentSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentRevisionResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  commandResponseSchema,
  completeHospitalServiceResponseSchema,
  confirmDiagnosisRequestSchema,
  confirmDiagnosisResponseSchema,
  confirmNoMedicationRequestSchema,
  confirmNoMedicationResponseSchema,
  correctLaboratoryReportRequestSchema,
  correctLaboratoryReportResponseSchema,
  createPatientResponseSchema,
  deletePrescriptionDraftRequestSchema,
  deleteLaboratoryRequestDraftRequestSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  doctorCompletedCaseDetailSchema,
  doctorCompletedCaseListSchema,
  doctorQueueSchema,
  dispenseResponseSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  issuePrescriptionRequestSchema,
  issuePrescriptionResponseSchema,
  issueLaboratoryRequestRequestSchema,
  issueLaboratoryRequestResponseSchema,
  laboratoryRequestActionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  orderHospitalServiceResponseSchema,
  patientSearchSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  pharmacyQueueSchema,
  previewClinicalDocumentSignRequestSchema,
  registrationCatalogSchema,
  registrationQueueSchema,
  registrationResponseSchema,
  roleCodeSchema,
  saveClinicalDocumentDraftRequestSchema,
  saveDiagnosisDraftRequestSchema,
  saveLaboratoryRequestDraftRequestSchema,
  savePrescriptionDraftRequestSchema,
  serviceCatalogSearchSchema,
  signClinicalDocumentRequestSchema,
  retryLaboratoryResultGenerationRequestSchema,
  triageQueueSchema,
  triageResponseSchema,
  prescriptionDraftResponseSchema,
  prescriptionReviewResponseSchema,
  withdrawPrescriptionResponseSchema,
} from './his.ts'
import {
  referenceDiagnosisCatalogSearchSchema,
  referenceLaboratoryCatalogSearchSchema,
  referenceMedicationCatalogSearchSchema,
} from './reference-data.ts'
import {
  startSyntheticCaseRequestSchema,
  startSyntheticCaseResultSchema,
} from './scenario.ts'

export const hisOperationModeSchema = z.enum(['query', 'draft', 'preview', 'command'])
export const hisOperationRiskSchema = z.enum(['read', 'write', 'high-risk-write'])
export const hisOperationIdentitySchema = z.enum(['agent', 'human'])
export const hisOperationHandlerOwnerSchema = z.enum([
  'FhirCapabilities',
  'FhirRepository',
  'InvestigationService',
  'ReferenceDataService',
  'SyntheticCaseVisitService',
  'WorkflowService',
])
export const hisOperationSkillSchema = z.enum([
  'clinmesh-billing',
  'clinmesh-doctor',
  'clinmesh-fhir',
  'clinmesh-pharmacy',
  'clinmesh-registration',
  'clinmesh-shared',
  'clinmesh-triage',
])

export const hisOperationErrorSchema = z.object({
  code: z.string().min(1),
  conflict: z.unknown().optional(),
  idempotencyKey: z.string().min(1).optional(),
  message: z.string().min(1),
  operationId: z.string().min(1).optional(),
  outcome: z.enum(['ambiguous', 'definitely_not_sent']),
  param: z.string().min(1).optional(),
  retryable: z.boolean(),
  type: z.string().min(1),
}).strict()

export interface HisOperationDefinition {
  cliPath: readonly [string, ...string[]]
  commandOperation?: string
  error: typeof hisOperationErrorSchema
  handlerOwner: z.infer<typeof hisOperationHandlerOwnerSchema>
  http: {
    encodeBody?: (input: unknown) => unknown
    encodeQuery?: (input: unknown) => Record<string, string | string[]>
    method: 'DELETE' | 'GET' | 'POST' | 'PUT'
    path: string
  }
  id: string
  identities: ReadonlyArray<z.infer<typeof hisOperationIdentitySchema>>
  input: z.ZodType
  mode: z.infer<typeof hisOperationModeSchema>
  output: z.ZodType
  previewToken: 'none' | 'required'
  requirements: {
    expectedVersions: boolean
    idempotency: 'none' | 'required'
  }
  risk: z.infer<typeof hisOperationRiskSchema>
  roles: ReadonlyArray<z.infer<typeof roleCodeSchema>>
  skill: z.infer<typeof hisOperationSkillSchema>
  summary: string
  version: number
}

type HisOperationDeclaration = Omit<
  HisOperationDefinition,
  'commandOperation' | 'error' | 'handlerOwner' | 'identities' | 'previewToken' | 'skill'
>

const clinicalDocumentOperationIds = {
  draftSet: `encounter.clinical-${'document'}.draft.set`,
  previewSign: `encounter.clinical-${'document'}.sign.preview`,
  revise: `clinical-${'document'}.revise`,
  saveDraft: `clinical-${'document'}.save-draft`,
  sign: `encounter.clinical-${'document'}.sign`,
  storedPreviewSign: `clinical-${'document'}.preview-sign`,
  storedSign: `clinical-${'document'}.sign`,
} as const

const referenceCatalogSearchInputSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(50).default(20),
  query: z.string().trim().min(3).max(100).optional(),
}).strict()

const serviceCatalogSearchInputSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(20),
  query: z.string().trim().min(1).max(200).optional(),
}).strict()

const emptyInputSchema = z.object({}).strict()

const expectedVersionsInputSchema = z.record(
  z.string().regex(/^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/),
  z.string().regex(/^\d+$/),
)

const paginationInputSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(20),
}).strict()

const patientSearchInputSchema = paginationInputSchema.extend({
  query: z.string().trim().min(1),
}).strict()

const patientCreateInputSchema = z.object({
  birthDate: z.iso.date(),
  gender: z.enum(['female', 'male', 'other', 'unknown']),
  identifier: z.string().trim().min(3).max(64),
  name: z.string().trim().min(2).max(80),
}).strict()

const registrationCreateInputSchema = z.object({
  departmentId: z.string().min(1),
  locationId: z.string().min(1),
  patientId: z.string().min(1),
  patientVersion: z.string().regex(/^\d+$/),
  visitDate: z.iso.date(),
  visitTypeId: z.string().min(1),
}).strict()

const startSyntheticCaseOperationInputSchema = startSyntheticCaseRequestSchema.extend({
  caseId: z.string().min(1).max(128),
}).strict()

const triageQueueInputSchema = paginationInputSchema.extend({
  status: z.enum(['completed', 'exception', 'pending']),
}).strict()

const triageRecordInputSchema = z.object({
  acuityCode: z.enum(['level-1', 'level-2', 'level-3', 'level-4']),
  bloodPressure: z.object({
    diastolicMmHg: z.number().positive(),
    systolicMmHg: z.number().positive(),
  }).strict(),
  chiefComplaint: z.string().trim().min(1),
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  oxygenSaturationPct: z.number().min(0).max(100),
  pulseBpm: z.number().positive(),
  respirationBpm: z.number().positive(),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
  temperatureC: z.number(),
}).strict()

const caseIdInputSchema = z.object({
  caseId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/),
}).strict()

const caseLaboratoryCatalogSearchInputSchema = referenceCatalogSearchInputSchema.extend({
  caseId: caseIdInputSchema.shape.caseId,
}).strict()

const encounterIdInputSchema = z.object({
  encounterId: z.string().min(1),
}).strict()

const doctorCompletedCasesInputSchema = paginationInputSchema.extend({
  completedFrom: z.iso.date().optional(),
  completedTo: z.iso.date().optional(),
  diagnosisCatalogItemId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/).optional(),
  patientId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/).optional(),
}).refine(value => (
  value.completedFrom === undefined
  || value.completedTo === undefined
  || value.completedFrom <= value.completedTo
), {
  message: 'completedFrom must not be after completedTo',
  path: ['completedFrom'],
})

const consultationQuestionInputSchema = z.object({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  expectedVersion: z.number().int().positive(),
  questionCode: z.string().min(1).max(64),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
}).strict()

const completeEncounterInputSchema = z.object({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const saveDiagnosisDraftOperationInputSchema = saveDiagnosisDraftRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

function encodeSaveDiagnosisDraftBody(rawInput: unknown): unknown {
  const {
    encounterId,
    encounterVersion,
    entries,
    expectedDraftVersion,
  } = saveDiagnosisDraftOperationInputSchema.parse(rawInput)
  return {
    expectedVersions: { [`Encounter/${encounterId}`]: encounterVersion },
    input: { entries, expectedDraftVersion },
  }
}

const confirmDiagnosisOperationInputSchema = confirmDiagnosisRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const savePrescriptionDraftOperationInputSchema = savePrescriptionDraftRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const deletePrescriptionDraftOperationInputSchema = deletePrescriptionDraftRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const issuePrescriptionOperationInputSchema = issuePrescriptionRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const confirmNoMedicationOperationInputSchema = confirmNoMedicationRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const withdrawPrescriptionOperationInputSchema = z.object({
  expectedPrescriptionVersion: z.number().int().positive(),
  medicationRequests: z.array(z.object({
    id: z.string().min(1),
    version: z.string().regex(/^\d+$/),
  }).strict()).min(1),
  prescriptionId: z.string().min(1),
}).strict()

const saveClinicalDocumentDraftOperationInputSchema = saveClinicalDocumentDraftRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const previewClinicalDocumentSignOperationInputSchema = previewClinicalDocumentSignRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const signClinicalDocumentOperationInputSchema = signClinicalDocumentRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const reviseClinicalDocumentOperationInputSchema = z.object({
  compositionId: z.string().min(1),
  compositionVersion: z.string().regex(/^\d+$/),
  document: clinicalDocumentContentSchema,
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  reason: z.string().trim().min(2).max(500),
}).strict()

const saveLaboratoryRequestDraftOperationInputSchema = saveLaboratoryRequestDraftRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const deleteLaboratoryRequestDraftOperationInputSchema = deleteLaboratoryRequestDraftRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const issueLaboratoryRequestOperationInputSchema = issueLaboratoryRequestRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const cancelLaboratoryRequestOperationInputSchema = cancelLaboratoryRequestRequestSchema.shape.input.extend({
  requestId: z.string().min(1),
  serviceRequestId: z.string().min(1),
  serviceRequestVersion: z.string().regex(/^\d+$/),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
}).strict()

const retryLaboratoryResultGenerationOperationInputSchema
  = retryLaboratoryResultGenerationRequestSchema.shape.input.extend({
    requestId: z.string().min(1),
    taskId: z.string().min(1),
    taskVersion: z.string().regex(/^\d+$/),
  }).strict()

const acknowledgeLaboratoryReportOperationInputSchema = acknowledgeLaboratoryReportRequestSchema.shape.input.extend({
  diagnosticReportId: z.string().min(1),
  diagnosticReportVersion: z.string().regex(/^\d+$/),
  requestId: z.string().min(1),
}).strict()

const correctLaboratoryReportOperationInputSchema = correctLaboratoryReportRequestSchema.shape.input.extend({
  diagnosticReportId: z.string().min(1),
  diagnosticReportVersion: z.string().regex(/^\d+$/),
  requestId: z.string().min(1),
}).strict()

const orderHospitalServiceOperationInputSchema = z.object({
  encounterId: z.string().min(1),
  expectedVersions: expectedVersionsInputSchema,
  serviceId: z.string().min(1),
}).strict()

const completeHospitalServiceOperationInputSchema = z.object({
  expectedVersions: expectedVersionsInputSchema,
  serviceRequestId: z.string().min(1),
}).strict()

const billingQueueInputSchema = paginationInputSchema.extend({
  category: z.enum(['laboratory', 'medication']),
  status: z.enum(['ambiguous', 'declined', 'paid', 'pending']),
}).strict()

const paymentPreviewOperationInputSchema = z.object({
  caseId: z.string().min(1),
  category: z.enum(['laboratory', 'medication']),
  chargeItemId: z.string().min(1),
  chargeVersion: z.number().int().positive(),
  simulatorRule: z.enum(['ambiguous', 'decline', 'success']),
}).strict()

const paymentConfirmOperationInputSchema = z.object({
  chargeItemId: z.string().min(1),
  chargeVersion: z.number().int().positive(),
  commitToken: z.string().min(1),
  previewId: z.string().min(1),
}).strict()

const pharmacyQueueInputSchema = paginationInputSchema.extend({
  status: z.enum(['completed', 'exception', 'pending']),
}).strict()

const medicationVersionInputSchema = z.object({
  medicationRequestId: z.string().min(1),
  medicationRequestVersion: z.string().regex(/^\d+$/),
}).strict()

const prescriptionReviewOperationInputSchema = z.object({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  medications: z.array(medicationVersionInputSchema).min(1),
  note: z.string(),
  prescriptionId: z.string().min(1),
  prescriptionVersion: z.number().int().positive(),
}).strict()

const prescriptionDispenseOperationInputSchema = prescriptionReviewOperationInputSchema.omit({
  note: true,
}).extend({
  lotSelections: z.array(z.object({
    expectedVersion: z.number().int().positive(),
    lotId: z.string().min(1),
    quantity: z.number().int().positive(),
  }).strict()).min(1),
}).strict()

const fhirResourceIdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const fhirResourceInputSchema = z.object({
  resourceId: fhirResourceIdSchema,
  resourceType: supportedFhirResourceTypeSchema,
}).strict()
const fhirVersionReadInputSchema = fhirResourceInputSchema.extend({
  versionId: z.string().regex(/^\d+$/),
}).strict()
const fhirSearchInputSchema = z.object({
  parameters: z.record(z.string().min(1), z.union([
    z.string(),
    z.array(z.string()),
  ])).default({}),
  resourceType: supportedFhirResourceTypeSchema,
}).strict().superRefine((input, context) => {
  const controlParameters = new Set(['_count', '_cursor', '_total'])
  for (const parameter of Object.keys(input.parameters)) {
    if (
      !controlParameters.has(parameter)
      && !isSupportedFhirSearchParameter(input.resourceType, parameter)
    ) {
      context.addIssue({
        code: 'custom',
        message: `Search parameter ${parameter} is not supported for ${input.resourceType}`,
        path: ['parameters', parameter],
      })
    }
  }
})
const fhirBundleSchema = z.object({
  entry: z.array(z.object({
    fullUrl: z.url(),
    resource: fhirResourceSchema,
  }).strict()),
  link: z.array(z.object({
    relation: z.string().min(1),
    url: z.url(),
  }).strict()),
  resourceType: z.literal('Bundle'),
  total: z.number().int().nonnegative().optional(),
  type: z.enum(['history', 'searchset']),
}).strict()

export const commandReceiptLookupInputSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  operationId: z.string().min(1).max(128),
}).strict()

export const commandReceiptLookupSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  operationId: z.string().min(1).max(128),
  response: z.unknown().optional(),
  status: z.enum(['completed', 'executing']),
}).strict()

function encodeFhirSearchQuery(rawInput: unknown): Record<string, string | string[]> {
  return fhirSearchInputSchema.parse(rawInput).parameters
}

function commandBody(
  expectedVersions: Record<string, string>,
  input: unknown,
): { expectedVersions: Record<string, string>; input: unknown } {
  return { expectedVersions, input }
}

const bodyEncoders = {
  'patient.create': (rawInput: unknown) => commandBody(
    {},
    patientCreateInputSchema.parse(rawInput),
  ),
  'registration.create': (rawInput: unknown) => {
    const { patientVersion, ...input } = registrationCreateInputSchema.parse(rawInput)
    return commandBody({ [`Patient/${input.patientId}`]: patientVersion }, input)
  },
  'registration.synthetic-case.start': (rawInput: unknown) => {
    const { caseId: _caseId, ...input } = startSyntheticCaseOperationInputSchema.parse(rawInput)
    return input
  },
  'triage.record': (rawInput: unknown) => {
    const {
      encounterId,
      encounterVersion,
      taskId,
      taskVersion,
      ...input
    } = triageRecordInputSchema.parse(rawInput)
    return commandBody({
      [`Encounter/${encounterId}`]: encounterVersion,
      [`Task/${taskId}`]: taskVersion,
    }, input)
  },
  'encounter.consultation.ask': (rawInput: unknown) => {
    const {
      encounterId,
      encounterVersion,
      taskId,
      taskVersion,
      ...input
    } = consultationQuestionInputSchema.parse(rawInput)
    return commandBody({
      [`Encounter/${encounterId}`]: encounterVersion,
      [`Task/${taskId}`]: taskVersion,
    }, input)
  },
  'encounter.complete': (rawInput: unknown) => {
    const { encounterId, encounterVersion } = completeEncounterInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, {})
  },
  'encounter.diagnosis.confirm': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = confirmDiagnosisOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.prescription.draft.set': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = savePrescriptionDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.prescription.draft.delete': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = deletePrescriptionDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.prescription.issue': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = issuePrescriptionOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.medication-conclusion.confirm-none': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = confirmNoMedicationOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'prescription.withdraw': (rawInput: unknown) => {
    const { expectedPrescriptionVersion, medicationRequests } = withdrawPrescriptionOperationInputSchema.parse(rawInput)
    return commandBody(
      Object.fromEntries(medicationRequests.map(request => [
        `MedicationRequest/${request.id}`,
        request.version,
      ])),
      { expectedPrescriptionVersion },
    )
  },
  [clinicalDocumentOperationIds.draftSet]: (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = saveClinicalDocumentDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  [clinicalDocumentOperationIds.previewSign]: (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input }
      = previewClinicalDocumentSignOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  [clinicalDocumentOperationIds.sign]: (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = signClinicalDocumentOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  [clinicalDocumentOperationIds.revise]: (rawInput: unknown) => {
    const {
      compositionId,
      compositionVersion,
      encounterId,
      encounterVersion,
      ...input
    } = reviseClinicalDocumentOperationInputSchema.parse(rawInput)
    return commandBody({
      [`Composition/${compositionId}`]: compositionVersion,
      [`Encounter/${encounterId}`]: encounterVersion,
    }, input)
  },
  'encounter.laboratory-request.draft.set': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input }
      = saveLaboratoryRequestDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.laboratory-request.draft.delete': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input }
      = deleteLaboratoryRequestDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.laboratory-request.issue': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input }
      = issueLaboratoryRequestOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'laboratory-request.cancel': (rawInput: unknown) => {
    const {
      requestId: _requestId,
      serviceRequestId,
      serviceRequestVersion,
      taskId,
      taskVersion,
      ...input
    } = cancelLaboratoryRequestOperationInputSchema.parse(rawInput)
    return commandBody({
      [`ServiceRequest/${serviceRequestId}`]: serviceRequestVersion,
      [`Task/${taskId}`]: taskVersion,
    }, input)
  },
  'laboratory-request.retry-generation': (rawInput: unknown) => {
    const { requestId: _requestId, taskId, taskVersion, ...input }
      = retryLaboratoryResultGenerationOperationInputSchema.parse(rawInput)
    return commandBody({ [`Task/${taskId}`]: taskVersion }, input)
  },
  'laboratory-report.acknowledge': (rawInput: unknown) => {
    const {
      diagnosticReportId: _diagnosticReportId,
      diagnosticReportVersion,
      requestId: _requestId,
      ...input
    } = acknowledgeLaboratoryReportOperationInputSchema.parse(rawInput)
    return commandBody({
      [`DiagnosticReport/${_diagnosticReportId}`]: diagnosticReportVersion,
    }, input)
  },
  'laboratory-report.correct': (rawInput: unknown) => {
    const {
      diagnosticReportId,
      diagnosticReportVersion,
      requestId: _requestId,
      ...input
    } = correctLaboratoryReportOperationInputSchema.parse(rawInput)
    return commandBody({
      [`DiagnosticReport/${diagnosticReportId}`]: diagnosticReportVersion,
    }, input)
  },
  'service.order': (rawInput: unknown) => {
    const { expectedVersions } = orderHospitalServiceOperationInputSchema.parse(rawInput)
    return commandBody(expectedVersions, {})
  },
  'service.complete': (rawInput: unknown) => {
    const { expectedVersions } = completeHospitalServiceOperationInputSchema.parse(rawInput)
    return commandBody(expectedVersions, {})
  },
  'payment.preview': (rawInput: unknown) => {
    const { chargeItemId, chargeVersion, ...input } = paymentPreviewOperationInputSchema.parse(rawInput)
    return commandBody({ [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, input)
  },
  'payment.confirm': (rawInput: unknown) => {
    const { chargeItemId, chargeVersion, commitToken } = paymentConfirmOperationInputSchema.parse(rawInput)
    return commandBody({ [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, { commitToken })
  },
  'prescription.review': (rawInput: unknown) => {
    const {
      encounterId,
      encounterVersion,
      medications,
      note,
      prescriptionVersion,
    } = prescriptionReviewOperationInputSchema.parse(rawInput)
    return commandBody(Object.fromEntries([
      [`Encounter/${encounterId}`, encounterVersion],
      ...medications.map(medication => [
        `MedicationRequest/${medication.medicationRequestId}`,
        medication.medicationRequestVersion,
      ]),
    ]), { expectedPrescriptionVersion: prescriptionVersion, note })
  },
  'prescription.dispense': (rawInput: unknown) => {
    const {
      encounterId,
      encounterVersion,
      lotSelections,
      medications,
      prescriptionVersion,
    } = prescriptionDispenseOperationInputSchema.parse(rawInput)
    return commandBody(Object.fromEntries([
      [`Encounter/${encounterId}`, encounterVersion],
      ...medications.map(medication => [
        `MedicationRequest/${medication.medicationRequestId}`,
        medication.medicationRequestVersion,
      ]),
    ]), { expectedPrescriptionVersion: prescriptionVersion, lotSelections })
  },
} satisfies Record<string, (input: unknown) => unknown>

const operationDefinitions = [
  {
    cliPath: ['reference', 'diagnoses', 'search'],
    http: {
      method: 'GET',
      path: '/api/his/v1/reference-catalogs/diagnoses',
    },
    id: 'reference.diagnoses.search',
    input: referenceCatalogSearchInputSchema,
    mode: 'query',
    output: referenceDiagnosisCatalogSearchSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['administrator', 'outpatient-doctor'],
    summary: 'Search the active diagnosis reference catalog',
    version: 1,
  },
  {
    cliPath: ['reference', 'medications', 'search'],
    http: {
      method: 'GET',
      path: '/api/his/v1/reference-catalogs/medications',
    },
    id: 'reference.medications.search',
    input: referenceCatalogSearchInputSchema,
    mode: 'query',
    output: referenceMedicationCatalogSearchSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['administrator', 'outpatient-doctor'],
    summary: 'Search the active medication reference catalog',
    version: 1,
  },
  {
    cliPath: ['reference', 'laboratory', 'search'],
    http: {
      method: 'GET',
      path: '/api/his/v1/reference-catalogs/laboratory',
    },
    id: 'reference.laboratory.search',
    input: referenceCatalogSearchInputSchema,
    mode: 'query',
    output: referenceLaboratoryCatalogSearchSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['administrator', 'outpatient-doctor'],
    summary: 'Search the active laboratory reference catalog',
    version: 1,
  },
  {
    cliPath: ['catalog', 'registration', 'get'],
    http: {
      method: 'GET',
      path: '/api/his/v1/catalogs/registration',
    },
    id: 'catalog.registration.read',
    input: emptyInputSchema,
    mode: 'query',
    output: registrationCatalogSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['administrator', 'registrar'],
    summary: 'Read the active registration catalog',
    version: 1,
  },
  {
    cliPath: ['catalog', 'clinical', 'get'],
    http: {
      method: 'GET',
      path: '/api/his/v1/catalogs/clinical',
    },
    id: 'catalog.clinical.read',
    input: emptyInputSchema,
    mode: 'query',
    output: clinicalCatalogSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['outpatient-doctor'],
    summary: 'Read the active clinical catalog',
    version: 1,
  },
  {
    cliPath: ['catalog', 'services', 'search'],
    http: {
      method: 'GET',
      path: '/api/his/v1/catalogs/services',
    },
    id: 'catalog.services.search',
    input: serviceCatalogSearchInputSchema,
    mode: 'query',
    output: serviceCatalogSearchSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['administrator', 'outpatient-doctor'],
    summary: 'Search the active hospital service catalog',
    version: 1,
  },
  {
    cliPath: ['patient', 'search'],
    http: {
      method: 'GET',
      path: '/api/his/v1/patients',
    },
    id: 'patient.search',
    input: patientSearchInputSchema,
    mode: 'query',
    output: patientSearchSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['cashier', 'outpatient-doctor', 'pharmacist', 'registrar', 'triage-nurse'],
    summary: 'Search patients by name, identifier, or registration number',
    version: 1,
  },
  {
    cliPath: ['patient', 'create'],
    http: {
      method: 'POST',
      path: '/api/his/v1/patients',
    },
    id: 'patient.create',
    input: patientCreateInputSchema,
    mode: 'command',
    output: createPatientResponseSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['registrar'],
    summary: 'Create a synthetic Patient Identity',
    version: 1,
  },
  {
    cliPath: ['registration', 'list'],
    http: {
      method: 'GET',
      path: '/api/his/v1/registrations',
    },
    id: 'registration.list',
    input: paginationInputSchema,
    mode: 'query',
    output: registrationQueueSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['registrar'],
    summary: 'List outpatient registrations',
    version: 1,
  },
  {
    cliPath: ['registration', 'create'],
    http: {
      method: 'POST',
      path: '/api/his/v1/registrations/actions/register',
    },
    id: 'registration.create',
    input: registrationCreateInputSchema,
    mode: 'command',
    output: registrationResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['registrar'],
    summary: 'Register a patient for an outpatient visit',
    version: 1,
  },
  {
    cliPath: ['registration', 'synthetic-case', 'start'],
    http: {
      method: 'POST',
      path: '/api/his/v1/synthetic-cases/:caseId/actions/start-outpatient-visit',
    },
    id: 'registration.synthetic-case.start',
    input: startSyntheticCaseOperationInputSchema,
    mode: 'command',
    output: commandResponseSchema(startSyntheticCaseResultSchema),
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['administrator', 'registrar'],
    summary: 'Start an outpatient visit from a ready Synthetic Case Instance',
    version: 1,
  },
  {
    cliPath: ['triage', 'queue', 'list'],
    http: {
      method: 'GET',
      path: '/api/his/v1/triage/queue',
    },
    id: 'triage.queue.list',
    input: triageQueueInputSchema,
    mode: 'query',
    output: triageQueueSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['triage-nurse'],
    summary: 'List the triage work queue',
    version: 1,
  },
  {
    cliPath: ['triage', 'record'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/actions/record-triage',
    },
    id: 'triage.record',
    input: triageRecordInputSchema,
    mode: 'command',
    output: triageResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['triage-nurse'],
    summary: 'Record structured triage observations and hand off to the doctor queue',
    version: 1,
  },
  {
    cliPath: ['doctor', 'queue', 'list'],
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/queue',
    },
    id: 'doctor.queue.list',
    input: paginationInputSchema,
    mode: 'query',
    output: doctorQueueSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['outpatient-doctor'],
    summary: 'List the active doctor work queue',
    version: 1,
  },
  {
    cliPath: ['doctor', 'completed-cases', 'list'],
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/completed-cases',
    },
    id: 'doctor.completed-cases.list',
    input: doctorCompletedCasesInputSchema,
    mode: 'query',
    output: doctorCompletedCaseListSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['outpatient-doctor'],
    summary: 'List completed outpatient cases owned by the acting doctor',
    version: 1,
  },
  {
    cliPath: ['doctor', 'completed-cases', 'get'],
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/completed-cases/:caseId',
    },
    id: 'doctor.completed-cases.get',
    input: caseIdInputSchema,
    mode: 'query',
    output: doctorCompletedCaseDetailSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['outpatient-doctor'],
    summary: 'Read one completed outpatient case and its clinical timeline',
    version: 1,
  },
  {
    cliPath: ['doctor', 'case', 'get'],
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/cases/:caseId',
    },
    id: 'doctor.case.get',
    input: caseIdInputSchema,
    mode: 'query',
    output: doctorCaseDetailSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['outpatient-doctor'],
    summary: 'Read the active doctor case state and available questions',
    version: 1,
  },
  {
    cliPath: ['doctor', 'case', 'laboratory-catalog', 'search'],
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/cases/:caseId/reference-catalogs/laboratory',
    },
    id: 'doctor.case.laboratory-catalog.search',
    input: caseLaboratoryCatalogSearchInputSchema,
    mode: 'query',
    output: caseLaboratoryCatalogSearchSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['outpatient-doctor'],
    summary: 'Search laboratory concepts and generation capability for one active case',
    version: 1,
  },
  {
    cliPath: ['encounter', 'consultation', 'ask'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/actions/ask-consultation-question',
    },
    id: 'encounter.consultation.ask',
    input: consultationQuestionInputSchema,
    mode: 'command',
    output: askConsultationQuestionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Ask one allowed consultation question and append the answer',
    version: 1,
  },
  {
    cliPath: ['encounter', 'completion', 'preview'],
    http: {
      method: 'GET',
      path: '/api/his/v1/encounters/:encounterId/completion',
    },
    id: 'encounter.completion.preview',
    input: encounterIdInputSchema,
    mode: 'preview',
    output: encounterCompletionPreviewSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['outpatient-doctor'],
    summary: 'Preview the current Encounter completion conditions',
    version: 1,
  },
  {
    cliPath: ['encounter', 'complete'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/actions/complete',
    },
    id: 'encounter.complete',
    input: completeEncounterInputSchema,
    mode: 'command',
    output: encounterCompletionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Complete clinical responsibility for an Encounter',
    version: 1,
  },
  {
    cliPath: ['encounter', 'diagnosis', 'draft', 'set'],
    http: {
      encodeBody: encodeSaveDiagnosisDraftBody,
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/diagnosis/draft',
    },
    id: 'encounter.diagnosis.draft.set',
    input: saveDiagnosisDraftOperationInputSchema,
    mode: 'draft',
    output: diagnosisDraftResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Save the version-protected diagnosis draft',
    version: 1,
  },
  {
    cliPath: ['encounter', 'diagnosis', 'confirm'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/diagnosis/actions/confirm',
    },
    id: 'encounter.diagnosis.confirm',
    input: confirmDiagnosisOperationInputSchema,
    mode: 'command',
    output: confirmDiagnosisResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Confirm one primary diagnosis and optional secondary diagnoses',
    version: 1,
  },
  {
    cliPath: ['encounter', 'prescription', 'draft', 'set'],
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/prescription/draft',
    },
    id: 'encounter.prescription.draft.set',
    input: savePrescriptionDraftOperationInputSchema,
    mode: 'draft',
    output: prescriptionDraftResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Save the version-protected prescription draft',
    version: 1,
  },
  {
    cliPath: ['encounter', 'prescription', 'draft', 'delete'],
    http: {
      method: 'DELETE',
      path: '/api/his/v1/encounters/:encounterId/prescription/draft',
    },
    id: 'encounter.prescription.draft.delete',
    input: deletePrescriptionDraftOperationInputSchema,
    mode: 'draft',
    output: prescriptionDraftResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Delete the current prescription draft with CAS',
    version: 1,
  },
  {
    cliPath: ['encounter', 'prescription', 'issue'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/prescription/actions/issue',
    },
    id: 'encounter.prescription.issue',
    input: issuePrescriptionOperationInputSchema,
    mode: 'command',
    output: issuePrescriptionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Issue the current prescription draft',
    version: 1,
  },
  {
    cliPath: ['encounter', 'medication-conclusion', 'confirm-none'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/medication-conclusion/actions/confirm-no-medication',
    },
    id: 'encounter.medication-conclusion.confirm-none',
    input: confirmNoMedicationOperationInputSchema,
    mode: 'command',
    output: confirmNoMedicationResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Confirm that the Encounter requires no medication',
    version: 1,
  },
  {
    cliPath: ['prescription', 'withdraw'],
    http: {
      method: 'POST',
      path: '/api/his/v1/prescriptions/:prescriptionId/actions/withdraw',
    },
    id: 'prescription.withdraw',
    input: withdrawPrescriptionOperationInputSchema,
    mode: 'command',
    output: withdrawPrescriptionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Withdraw a prescription before any dispensing starts',
    version: 1,
  },
  {
    cliPath: ['encounter', 'clinical-document', 'draft', 'set'],
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/clinical-document/draft',
    },
    id: clinicalDocumentOperationIds.draftSet,
    input: saveClinicalDocumentDraftOperationInputSchema,
    mode: 'draft',
    output: clinicalDocumentDraftResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Save the version-protected structured clinical document draft',
    version: 1,
  },
  {
    cliPath: ['encounter', 'clinical-document', 'sign', 'preview'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/clinical-document/actions/preview-sign',
    },
    id: clinicalDocumentOperationIds.previewSign,
    input: previewClinicalDocumentSignOperationInputSchema,
    mode: 'preview',
    output: clinicalDocumentSignPreviewResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Create a version-bound preview for clinical document signing',
    version: 1,
  },
  {
    cliPath: ['encounter', 'clinical-document', 'sign', 'commit'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/clinical-document/actions/sign',
    },
    id: clinicalDocumentOperationIds.sign,
    input: signClinicalDocumentOperationInputSchema,
    mode: 'command',
    output: clinicalDocumentSignResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Sign the structured clinical document from a valid preview',
    version: 1,
  },
  {
    cliPath: ['clinical-document', 'revise'],
    http: {
      method: 'POST',
      path: '/api/his/v1/clinical-documents/:compositionId/actions/revise',
    },
    id: clinicalDocumentOperationIds.revise,
    input: reviseClinicalDocumentOperationInputSchema,
    mode: 'command',
    output: clinicalDocumentRevisionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Create a new revision from the latest signed clinical document',
    version: 1,
  },
  {
    cliPath: ['encounter', 'laboratory-request', 'draft', 'set'],
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/laboratory-request/draft',
    },
    id: 'encounter.laboratory-request.draft.set',
    input: saveLaboratoryRequestDraftOperationInputSchema,
    mode: 'draft',
    output: laboratoryRequestDraftResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Save the version-protected laboratory request draft',
    version: 1,
  },
  {
    cliPath: ['encounter', 'laboratory-request', 'draft', 'delete'],
    http: {
      method: 'DELETE',
      path: '/api/his/v1/encounters/:encounterId/laboratory-request/draft',
    },
    id: 'encounter.laboratory-request.draft.delete',
    input: deleteLaboratoryRequestDraftOperationInputSchema,
    mode: 'draft',
    output: laboratoryRequestDraftResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Delete the current laboratory request draft with CAS',
    version: 1,
  },
  {
    cliPath: ['encounter', 'laboratory-request', 'issue'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/laboratory-request/actions/issue',
    },
    id: 'encounter.laboratory-request.issue',
    input: issueLaboratoryRequestOperationInputSchema,
    mode: 'command',
    output: issueLaboratoryRequestResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Issue the current laboratory request draft',
    version: 1,
  },
  {
    cliPath: ['laboratory-request', 'cancel'],
    http: {
      method: 'POST',
      path: '/api/his/v1/laboratory-requests/:requestId/actions/cancel',
    },
    id: 'laboratory-request.cancel',
    input: cancelLaboratoryRequestOperationInputSchema,
    mode: 'command',
    output: laboratoryRequestActionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Cancel an issued laboratory request before execution starts',
    version: 1,
  },
  {
    cliPath: ['laboratory-request', 'retry-generation'],
    http: {
      method: 'POST',
      path: '/api/his/v1/laboratory-requests/:requestId/actions/retry-generation',
    },
    id: 'laboratory-request.retry-generation',
    input: retryLaboratoryResultGenerationOperationInputSchema,
    mode: 'command',
    output: laboratoryRequestActionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Retry a failed Investigation result generation',
    version: 1,
  },
  {
    cliPath: ['laboratory-report', 'acknowledge'],
    http: {
      method: 'POST',
      path: '/api/his/v1/laboratory-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
    },
    id: 'laboratory-report.acknowledge',
    input: acknowledgeLaboratoryReportOperationInputSchema,
    mode: 'command',
    output: acknowledgeLaboratoryReportResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Acknowledge the latest final laboratory report',
    version: 1,
  },
  {
    cliPath: ['laboratory-report', 'correct'],
    http: {
      method: 'POST',
      path: '/api/his/v1/laboratory-requests/:requestId/reports/:diagnosticReportId/actions/correct',
    },
    id: 'laboratory-report.correct',
    input: correctLaboratoryReportOperationInputSchema,
    mode: 'command',
    output: correctLaboratoryReportResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['administrator'],
    summary: 'Correct the latest laboratory report through the controlled LIS actor',
    version: 1,
  },
  {
    cliPath: ['service', 'order'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/services/:serviceId/actions/order',
    },
    id: 'service.order',
    input: orderHospitalServiceOperationInputSchema,
    mode: 'command',
    output: orderHospitalServiceResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Order an active Hospital Service for an Encounter',
    version: 1,
  },
  {
    cliPath: ['service', 'complete'],
    http: {
      method: 'POST',
      path: '/api/his/v1/service-requests/:serviceRequestId/actions/complete',
    },
    id: 'service.complete',
    input: completeHospitalServiceOperationInputSchema,
    mode: 'command',
    output: completeHospitalServiceResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: 'Complete an ordered Hospital Service',
    version: 1,
  },
  {
    cliPath: ['billing', 'queue', 'list'],
    http: {
      method: 'GET',
      path: '/api/his/v1/billing/queue',
    },
    id: 'billing.queue.list',
    input: billingQueueInputSchema,
    mode: 'query',
    output: billingQueueSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['cashier'],
    summary: 'List billing work by category and payment state',
    version: 1,
  },
  {
    cliPath: ['payment', 'preview'],
    http: {
      method: 'POST',
      path: '/api/his/v1/payments/actions/preview',
    },
    id: 'payment.preview',
    input: paymentPreviewOperationInputSchema,
    mode: 'preview',
    output: paymentPreviewResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['cashier'],
    summary: 'Create a version-bound payment preview',
    version: 1,
  },
  {
    cliPath: ['payment', 'confirm'],
    http: {
      method: 'POST',
      path: '/api/his/v1/payments/:previewId/actions/confirm',
    },
    id: 'payment.confirm',
    input: paymentConfirmOperationInputSchema,
    mode: 'command',
    output: paymentResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['cashier'],
    summary: 'Confirm a payment from a valid preview',
    version: 1,
  },
  {
    cliPath: ['pharmacy', 'queue', 'list'],
    http: {
      method: 'GET',
      path: '/api/his/v1/pharmacy/queue',
    },
    id: 'pharmacy.queue.list',
    input: pharmacyQueueInputSchema,
    mode: 'query',
    output: pharmacyQueueSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['pharmacist'],
    summary: 'List pharmacy work by fulfillment state',
    version: 1,
  },
  {
    cliPath: ['prescription', 'review'],
    http: {
      method: 'POST',
      path: '/api/his/v1/prescriptions/:prescriptionId/actions/review',
    },
    id: 'prescription.review',
    input: prescriptionReviewOperationInputSchema,
    mode: 'command',
    output: prescriptionReviewResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['pharmacist'],
    summary: 'Review a signed and paid prescription',
    version: 1,
  },
  {
    cliPath: ['prescription', 'dispense'],
    http: {
      method: 'POST',
      path: '/api/his/v1/prescriptions/:prescriptionId/actions/dispense',
    },
    id: 'prescription.dispense',
    input: prescriptionDispenseOperationInputSchema,
    mode: 'command',
    output: dispenseResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['pharmacist'],
    summary: 'Dispense a reviewed prescription from versioned inventory lots',
    version: 1,
  },
  {
    cliPath: ['command', 'receipt', 'get'],
    http: {
      method: 'GET',
      path: '/api/his/v1/command-receipts',
    },
    id: 'command.receipt.get',
    input: commandReceiptLookupInputSchema,
    mode: 'query',
    output: commandReceiptLookupSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: roleCodeSchema.options,
    summary: 'Read this Actor\'s Command receipt by operation and idempotency key',
    version: 1,
  },
  {
    cliPath: ['fhir', 'metadata'],
    http: {
      method: 'GET',
      path: '/fhir/R5/metadata',
    },
    id: 'fhir.metadata.read',
    input: emptyInputSchema,
    mode: 'query',
    output: capabilityStatementSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: roleCodeSchema.options,
    summary: 'Read the FHIR R5 CapabilityStatement',
    version: 1,
  },
  {
    cliPath: ['fhir', 'read'],
    http: {
      method: 'GET',
      path: '/fhir/R5/:resourceType/:resourceId',
    },
    id: 'fhir.resource.read',
    input: fhirResourceInputSchema,
    mode: 'query',
    output: fhirResourceSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: roleCodeSchema.options,
    summary: 'Read the current version of one supported FHIR R5 resource',
    version: 1,
  },
  {
    cliPath: ['fhir', 'vread'],
    http: {
      method: 'GET',
      path: '/fhir/R5/:resourceType/:resourceId/_history/:versionId',
    },
    id: 'fhir.resource.vread',
    input: fhirVersionReadInputSchema,
    mode: 'query',
    output: fhirResourceSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: roleCodeSchema.options,
    summary: 'Read one historical version of a supported FHIR R5 resource',
    version: 1,
  },
  {
    cliPath: ['fhir', 'history'],
    http: {
      method: 'GET',
      path: '/fhir/R5/:resourceType/:resourceId/_history',
    },
    id: 'fhir.resource.history',
    input: fhirResourceInputSchema,
    mode: 'query',
    output: fhirBundleSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: roleCodeSchema.options,
    summary: 'Read the complete history of one supported FHIR R5 resource',
    version: 1,
  },
  {
    cliPath: ['fhir', 'search'],
    http: {
      encodeQuery: encodeFhirSearchQuery,
      method: 'GET',
      path: '/fhir/R5/:resourceType',
    },
    id: 'fhir.resource.search',
    input: fhirSearchInputSchema,
    mode: 'query',
    output: fhirBundleSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: roleCodeSchema.options,
    summary: 'Search one supported FHIR R5 resource type with declared parameters',
    version: 1,
  },
] as const satisfies readonly HisOperationDeclaration[]

const commandOperationAliases: Readonly<Record<string, string>> = {
  [clinicalDocumentOperationIds.draftSet]: clinicalDocumentOperationIds.saveDraft,
  [clinicalDocumentOperationIds.previewSign]: clinicalDocumentOperationIds.storedPreviewSign,
  [clinicalDocumentOperationIds.sign]: clinicalDocumentOperationIds.storedSign,
  'encounter.consultation.ask': 'consultation.ask-question',
  'encounter.diagnosis.confirm': 'encounter.confirm-diagnosis',
  'encounter.diagnosis.draft.set': 'encounter.save-diagnosis-draft',
  'encounter.laboratory-request.draft.delete': 'laboratory-request.delete-draft',
  'encounter.laboratory-request.draft.set': 'laboratory-request.save-draft',
  'encounter.laboratory-request.issue': 'laboratory-request.issue',
  'encounter.medication-conclusion.confirm-none': 'encounter.confirm-no-medication',
  'encounter.prescription.draft.delete': 'encounter.delete-prescription-draft',
  'encounter.prescription.draft.set': 'encounter.save-prescription-draft',
  'encounter.prescription.issue': 'encounter.issue-prescription',
  'patient.create': 'patient.create-synthetic',
  'registration.create': 'registration.register',
  'registration.synthetic-case.start': 'synthetic-case.start-outpatient-visit',
  'service.complete': 'hospital-service.complete',
  'service.order': 'hospital-service.order',
  'triage.record': 'encounter.record-triage',
}

const operationSkills: Readonly<Record<string, z.infer<typeof hisOperationSkillSchema>>> = {
  'billing.queue.list': 'clinmesh-billing',
  'catalog.clinical.read': 'clinmesh-doctor',
  'catalog.registration.read': 'clinmesh-registration',
  'catalog.services.search': 'clinmesh-doctor',
  [clinicalDocumentOperationIds.revise]: 'clinmesh-doctor',
  'command.receipt.get': 'clinmesh-shared',
  'doctor.case.get': 'clinmesh-doctor',
  'doctor.case.laboratory-catalog.search': 'clinmesh-doctor',
  'doctor.completed-cases.get': 'clinmesh-doctor',
  'doctor.completed-cases.list': 'clinmesh-doctor',
  'doctor.queue.list': 'clinmesh-doctor',
  [clinicalDocumentOperationIds.draftSet]: 'clinmesh-doctor',
  [clinicalDocumentOperationIds.previewSign]: 'clinmesh-doctor',
  [clinicalDocumentOperationIds.sign]: 'clinmesh-doctor',
  'encounter.complete': 'clinmesh-doctor',
  'encounter.completion.preview': 'clinmesh-doctor',
  'encounter.consultation.ask': 'clinmesh-doctor',
  'encounter.diagnosis.confirm': 'clinmesh-doctor',
  'encounter.diagnosis.draft.set': 'clinmesh-doctor',
  'encounter.laboratory-request.draft.delete': 'clinmesh-doctor',
  'encounter.laboratory-request.draft.set': 'clinmesh-doctor',
  'encounter.laboratory-request.issue': 'clinmesh-doctor',
  'encounter.medication-conclusion.confirm-none': 'clinmesh-doctor',
  'encounter.prescription.draft.delete': 'clinmesh-doctor',
  'encounter.prescription.draft.set': 'clinmesh-doctor',
  'encounter.prescription.issue': 'clinmesh-doctor',
  'fhir.metadata.read': 'clinmesh-fhir',
  'fhir.resource.history': 'clinmesh-fhir',
  'fhir.resource.read': 'clinmesh-fhir',
  'fhir.resource.search': 'clinmesh-fhir',
  'fhir.resource.vread': 'clinmesh-fhir',
  'laboratory-report.acknowledge': 'clinmesh-doctor',
  'laboratory-report.correct': 'clinmesh-doctor',
  'laboratory-request.cancel': 'clinmesh-doctor',
  'laboratory-request.retry-generation': 'clinmesh-doctor',
  'patient.create': 'clinmesh-registration',
  'patient.search': 'clinmesh-registration',
  'payment.confirm': 'clinmesh-billing',
  'payment.preview': 'clinmesh-billing',
  'pharmacy.queue.list': 'clinmesh-pharmacy',
  'prescription.dispense': 'clinmesh-pharmacy',
  'prescription.review': 'clinmesh-pharmacy',
  'prescription.withdraw': 'clinmesh-doctor',
  'reference.diagnoses.search': 'clinmesh-doctor',
  'reference.laboratory.search': 'clinmesh-doctor',
  'reference.medications.search': 'clinmesh-doctor',
  'registration.create': 'clinmesh-registration',
  'registration.list': 'clinmesh-registration',
  'registration.synthetic-case.start': 'clinmesh-registration',
  'service.complete': 'clinmesh-doctor',
  'service.order': 'clinmesh-doctor',
  'triage.queue.list': 'clinmesh-triage',
  'triage.record': 'clinmesh-triage',
}

function handlerOwnerFor(
  operation: HisOperationDeclaration,
): z.infer<typeof hisOperationHandlerOwnerSchema> {
  if (operation.http.path === '/fhir/R5/metadata') return 'FhirCapabilities'
  if (operation.http.path.startsWith('/fhir/R5/')) return 'FhirRepository'
  if (operation.http.path.startsWith('/api/his/v1/reference-catalogs/')) {
    return 'ReferenceDataService'
  }
  if (operation.id === 'doctor.case.laboratory-catalog.search') return 'InvestigationService'
  if (operation.id === 'registration.synthetic-case.start') return 'SyntheticCaseVisitService'
  return 'WorkflowService'
}

export const hisOperationCatalog: readonly HisOperationDefinition[] = operationDefinitions.map((operation) => {
  const commandOperation = operation.requirements.idempotency === 'required'
    ? commandOperationAliases[operation.id] ?? operation.id
    : undefined
  const skill = operationSkills[operation.id]
  if (skill === undefined) throw new Error(`HIS operation has no Agent Skill: ${operation.id}`)
  const metadata = {
    error: hisOperationErrorSchema,
    handlerOwner: handlerOwnerFor(operation),
    identities: hisOperationIdentitySchema.options,
    previewToken: operation.id === clinicalDocumentOperationIds.sign
      || operation.id === 'payment.confirm'
      ? 'required' as const
      : 'none' as const,
    skill,
  }
  if (operation.http.method === 'GET' || 'encodeBody' in operation.http) {
    return {
      ...operation,
      ...(commandOperation === undefined ? {} : { commandOperation }),
      ...metadata,
    }
  }
  const encodeBody = bodyEncoders[operation.id as keyof typeof bodyEncoders]
  return {
    ...operation,
    ...(commandOperation === undefined ? {} : { commandOperation }),
    ...metadata,
    http: {
      ...operation.http,
      ...(encodeBody === undefined ? {} : { encodeBody }),
    },
  }
})

export interface ExcludedHisRoute {
  method: HisOperationDefinition['http']['method']
  path: string
  reason: string
}

export const excludedHisRoutes = [
  {
    method: 'GET',
    path: '/api/his/v1/doctor/virtual-patients',
    reason: 'Superseded by the Synthetic Patient Library and Synthetic Case direct-start flow',
  },
  {
    method: 'POST',
    path: '/api/his/v1/doctor/virtual-patients/:virtualPatientId/actions/start',
    reason: 'Superseded by registration.synthetic-case.start',
  },
  {
    method: 'POST',
    path: '/api/his/v1/encounters/:encounterId/actions/start-first-visit',
    reason: 'Legacy first-visit compatibility entrypoint',
  },
  {
    method: 'POST',
    path: '/api/his/v1/encounters/:encounterId/actions/start-revisit',
    reason: 'Legacy revisit compatibility entrypoint',
  },
  {
    method: 'PUT',
    path: '/api/his/v1/encounters/:encounterId/drafts/first-visit',
    reason: 'Superseded by independent diagnosis, laboratory, prescription, and clinical document drafts',
  },
  {
    method: 'PUT',
    path: '/api/his/v1/encounters/:encounterId/drafts/revisit',
    reason: 'Legacy combined revisit draft',
  },
  {
    method: 'POST',
    path: '/api/his/v1/encounters/:encounterId/actions/preview-sign',
    reason: 'Legacy combined revisit signing preview',
  },
  {
    method: 'POST',
    path: '/api/his/v1/encounters/:encounterId/actions/sign-and-complete',
    reason: 'Legacy combined signing and completion command',
  },
  {
    method: 'POST',
    path: '/api/his/v1/encounters/:encounterId/actions/issue-laboratory-order',
    reason: 'Superseded by the independent laboratory request draft and issue lifecycle',
  },
] as const satisfies readonly ExcludedHisRoute[]

const operationsById = new Map(hisOperationCatalog.map(operation => [operation.id, operation]))
const operationRoutes = hisOperationCatalog.map(operation => ({
  method: operation.http.method,
  operation,
  pattern: new RegExp(`^${operation.http.path
    .split('/')
    .map(segment => segment.startsWith(':')
      ? '[^/]+'
      : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('/')}$`),
}))

export function getHisOperation(id: string): HisOperationDefinition {
  const operation = operationsById.get(id)
  if (operation === undefined) throw new Error(`Unknown HIS operation: ${id}`)
  return operation
}

export function listHisOperations(): readonly HisOperationDefinition[] {
  return hisOperationCatalog
}

export function matchHisOperation(
  method: string,
  pathname: string,
): HisOperationDefinition | undefined {
  return operationRoutes.find(route => (
    route.method === method.toUpperCase() && route.pattern.test(pathname)
  ))?.operation
}
