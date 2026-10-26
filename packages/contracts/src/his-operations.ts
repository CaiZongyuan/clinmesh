import { insuranceTargetSchema, insurancePlanCodeSchema, insurancePreviewResponseSchema, insuranceResponseSchema, insuranceStateSchema } from './insurance.ts'
import { inpatientFinancialInsuranceCancelInputSchema, inpatientFinancialInsurancePreviewInputSchema,
  inpatientFinancialInsuranceConfirmInputSchema } from './inpatient-finance.ts'
import { chargeAdjustmentInputSchema, chargeAdjustmentResponseSchema, refundCaseSchema, refundPreviewInputSchema, refundPreviewResponseSchema,
  refundConfirmInputSchema, refundRecoverInputSchema, refundResponseSchema } from './refunds.ts'
import { inpatientRecordSchema, inpatientRecordSubmitInputSchema, inpatientRecordReviewInputSchema, inpatientRecordArchiveInputSchema, inpatientRecordResponseSchema } from './inpatient-record.ts'
import { inpatientFinancialSchema, inpatientFinancialResponseSchema, inpatientFinancialAdjustmentInputSchema, inpatientFinancialRefundPreviewInputSchema, inpatientFinancialRefundPreviewResponseSchema, inpatientFinancialRefundConfirmInputSchema, inpatientFinancialRefundRecoverInputSchema, inpatientFinancialPaymentPreviewInputSchema } from './inpatient-finance.ts'
import { inpatientDischargeInputSchema, inpatientDepartInputSchema, inpatientSettleInputSchema, inpatientDischargeResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema, inpatientDischargeEventsSchema,
  inpatientPaymentsSchema, inpatientPaymentInputSchema, inpatientPaymentConfirmInputSchema, inpatientPaymentRecoverInputSchema, inpatientPaymentResponseSchema, inpatientPaymentPreviewResponseSchema,
  inpatientRefundInputSchema, inpatientRefundConfirmInputSchema, inpatientRefundRecoverInputSchema, inpatientRefundPreviewResponseSchema } from './inpatient-discharge.ts'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, inpatientSurgeryResponseSchema, inpatientSurgeryRequestInputSchema, inpatientSurgeryActionInputSchema, inpatientSurgeryExecuteInputSchema } from './inpatient-surgery.ts'
import { inpatientInvestigationCatalogSchema,inpatientInvestigationsSchema,inpatientInvestigationIssueInputSchema,inpatientInvestigationActionInputSchema,inpatientInvestigationAcknowledgeInputSchema,inpatientInvestigationResponseSchema } from './inpatient-investigations.ts'
import { inpatientTransferCatalogSchema,inpatientIncomingTransfersSchema,inpatientTransfersSchema,inpatientTransferRequestInputSchema,inpatientTransferActionInputSchema,inpatientTransferReceiveInputSchema,inpatientTransferResponseSchema } from './inpatient-transfer.ts'
import { inpatientCatalogSearchInputSchema, inpatientCatalogSearchSchema, inpatientPharmacyListSchema, inpatientPharmacySchema, inpatientPharmacyResponseSchema, inpatientChargesSchema, inpatientChargesResponseSchema, inpatientChargeReverseInputSchema, inpatientExecutionActionInputSchema, inpatientDispenseInputSchema, inpatientFullCatalogSchema, inpatientFullClinicalSchema, inpatientFullClinicalResponseSchema, inpatientOrderIssueInputSchema, inpatientOrderActionInputSchema, inpatientOrderReasonInputSchema, inpatientDiagnosisConfirmInputSchema } from './inpatient-clinical.ts'
import {
  inpatientCatalogSchema, inpatientListSchema, inpatientDetailSchema, inpatientCommandResponseSchema,
  inpatientRegistrationInputSchema, inpatientBedInputSchema, inpatientSwapInputSchema, inpatientSwapResponseSchema,
  inpatientReferralListSchema, inpatientReferralInputSchema, inpatientReferralResponseSchema,
} from './inpatient.ts'
import { inpatientDrgPregroupResultSchema } from './inpatient-drg.ts'
import { inpatientDrgSimulationSchema, inpatientDrgSimulationInputSchema, inpatientMaterialReservationListSchema,
  inpatientMaterialReservationCreateInputSchema, inpatientMaterialReservationReleaseInputSchema } from './inpatient-drg-simulation.ts'
import { inpatientDrgPayerReviewListSchema, inpatientDrgPayerReviewCreateInputSchema, inpatientDrgPayerReviewPreviewSchema } from './inpatient-drg-payer.ts'
import { inpatientPciDataSchema, inpatientPciDataPrepareRequestSchema, inpatientPciDataResponseSchema, pciCaseSourcePrepareRequestSchema, pciCaseSourceResponseSchema, startSyntheticInpatientCaseRequestSchema, startSyntheticInpatientCaseResponseSchema } from './inpatient-pci-data.ts'
import { z } from 'zod'

const inpatientDrgSimulationRequestSchema = z.object({ admissionId: z.string().min(1), draft: inpatientDrgSimulationInputSchema.optional() }).strict()
import {
  capabilityStatementSchema,
  fhirResourceSchema,
  isSupportedFhirSearchParameter,
  supportedFhirResourceTypeSchema,
} from './fhir.ts'
import {
  acknowledgeImagingReportRequestSchema,
  acknowledgeImagingReportResponseSchema,
  acknowledgePathologyReportRequestSchema,
  acknowledgePathologyReportResponseSchema,
  cancelImagingRequestRequestSchema,
  cancelPathologyRequestRequestSchema,
  caseImagingServiceCatalogSchema,
  casePathologyServiceCatalogSchema,
  correctImagingReportRequestSchema,
  correctImagingReportResponseSchema,
  correctPathologyReportRequestSchema,
  correctPathologyReportResponseSchema,
  deleteImagingRequestDraftRequestSchema,
  deletePathologyRequestDraftRequestSchema,
  imagingRequestActionResponseSchema,
  imagingRequestDraftResponseSchema,
  issueImagingRequestRequestSchema,
  issueImagingRequestResponseSchema,
  issuePathologyRequestRequestSchema,
  issuePathologyRequestResponseSchema,
  pathologyRequestActionResponseSchema,
  pathologyRequestDraftResponseSchema,
  retryImagingRequestRequestSchema,
  retryPathologyRequestRequestSchema,
  saveImagingRequestDraftRequestSchema,
  savePathologyRequestDraftRequestSchema,
  acknowledgeLaboratoryReportRequestSchema,
  acknowledgeLaboratoryReportResponseSchema,
  retryConsultationReplyResponseSchema,
  sendConsultationMessageResponseSchema,
  billingQueueSchema,
  billingCaseSchema,
  cancelLaboratoryRequestRequestSchema,
  caseLaboratoryCatalogSearchSchema,
  clinicalCatalogSchema,
  clinicalDocumentContentSchema,
  clinicalDocumentDraftResponseSchema,
  checkClinicalDocumentQualityRequestSchema,
  clinicalDocumentQualityControlStateSchema,
  clinicalDocumentQualityControlResponseSchema,
  retainClinicalDocumentQualityIssueRequestSchema,
  clinicalDocumentRevisionResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  cancelClinicalDocumentSignRequestSchema,
  cancelClinicalDocumentSignResponseSchema,
  commandResponseSchema,
  completeHospitalServiceResponseSchema,
  correlationIdSchema,
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
  doctorQueueViewSchema,
  dispenseResponseSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  issuePrescriptionRequestSchema,
  issuePrescriptionResponseSchema,
  issueLaboratoryRequestRequestSchema,
  issueLaboratoryRequestResponseSchema,
  laboratoryRequestActionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  laboratoryServiceCandidateSearchInputSchema,
  laboratoryServiceCandidateSearchSchema,
  laboratoryServicePublicationJobSchema,
  orderHospitalServiceResponseSchema,
  patientSearchSchema,
  paymentPreviewResponseSchema,
  paymentSimulatorRuleSchema,
  paymentTendersSchema,
  paymentResponseSchema,
  publishLaboratoryServicesRequestSchema,
  publishLaboratoryServicesResponseSchema,
  pharmacyQueueSchema,
  previewClinicalDocumentSignRequestSchema,
  registrationCatalogSchema,
  registrationQueueSchema,
  registrationResponseSchema,
  roleCodeSchema,
  saveClinicalDocumentDraftRequestSchema,
  controlConsultationRecordingRequestSchema,
  controlConsultationRecordingResponseSchema,
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
  referenceDataItemIdSchema,
  referenceLaboratoryCatalogSearchSchema,
  referenceMedicationCatalogSearchSchema,
} from './reference-data.ts'
import {
  startSyntheticCaseRequestSchema,
  startSyntheticCaseResultSchema,
  syntheticCaseRegistrationListSchema,
} from './scenario.ts'

export const hisOperationModeSchema = z.enum(['query', 'draft', 'preview', 'command'])
export const hisOperationRiskSchema = z.enum(['read', 'write', 'high-risk-write'])
export const hisOperationIdentitySchema = z.enum(['agent', 'human'])
export const hisOperationHandlerOwnerSchema = z.enum([
  'FhirCapabilities',
  'FhirRepository',
  'LaboratoryServicePublisher',
  'ReferenceDataService',
  'SyntheticCaseVisitService',
  'ScenarioDataService',
  'WorkflowService',
  'InsuranceService',
  'InpatientService',
])
export const hisOperationSkillSchema = z.enum([
  'clinmesh-administrator',
  'clinmesh-billing',
  'clinmesh-doctor',
  'clinmesh-fhir',
  'clinmesh-pharmacy',
  'clinmesh-registration',
  'clinmesh-shared',
  'clinmesh-inpatient',
  'clinmesh-triage',
])

export const hisOperationErrorSchema = z.object({
  code: z.string().min(1),
  conflict: z.unknown().optional(),
  correlationId: correlationIdSchema.optional(),
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
  cancelSign: `encounter.clinical-${'document'}.sign.cancel`,
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

export const syntheticCaseRegistrationListInputSchema = paginationInputSchema.extend({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().min(1).max(120).optional(),
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

const laboratoryServicePublicationJobInputSchema = z.object({
  jobId: z.string().min(1).max(128),
}).strict()

const publishLaboratoryServicesOperationInputSchema
  = publishLaboratoryServicesRequestSchema.shape.input

const encounterIdInputSchema = z.object({
  encounterId: z.string().min(1),
}).strict()

const doctorCompletedCasesInputSchema = paginationInputSchema.extend({
  completedFrom: z.iso.date().optional(),
  completedTo: z.iso.date().optional(),
  diagnosisCatalogItemId: referenceDataItemIdSchema.optional(),
  patientId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/).optional(),
}).refine(value => (
  value.completedFrom === undefined
  || value.completedTo === undefined
  || value.completedFrom <= value.completedTo
), {
  message: 'completedFrom must not be after completedTo',
  path: ['completedFrom'],
})

const consultationMessageInputSchema = z.object({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  expectedConsultationVersion: z.number().int().positive(),
  message: z.string().trim().min(1).max(2_000),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
}).strict()

const consultationRetryInputSchema = z.object({
  encounterId: z.string().min(1),
  expectedConsultationVersion: z.number().int().positive(),
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

const documentQualityCheckInputSchema = checkClinicalDocumentQualityRequestSchema.shape.input.safeExtend({
  caseId: z.string().min(1), encounterId: z.string().min(1), encounterVersion: z.string().regex(/^\d+$/),
})
const documentQualityRetainInputSchema = retainClinicalDocumentQualityIssueRequestSchema.shape.input.extend({
  caseId: z.string().min(1), encounterId: z.string().min(1), encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const previewClinicalDocumentSignOperationInputSchema = previewClinicalDocumentSignRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const signClinicalDocumentOperationInputSchema = signClinicalDocumentRequestSchema.shape.input.extend({
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict()

const cancelClinicalDocumentSignOperationInputSchema = cancelClinicalDocumentSignRequestSchema.shape.input.extend({
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

const encounterVersionInputShape = {
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}

const saveImagingRequestDraftOperationInputSchema = saveImagingRequestDraftRequestSchema.shape.input
  .extend(encounterVersionInputShape).strict()

const deleteImagingRequestDraftOperationInputSchema = deleteImagingRequestDraftRequestSchema.shape.input
  .extend(encounterVersionInputShape).strict()

const issueImagingRequestOperationInputSchema = issueImagingRequestRequestSchema.shape.input
  .extend(encounterVersionInputShape).strict()

const cancelImagingRequestOperationInputSchema = cancelImagingRequestRequestSchema.shape.input.extend({
  requestId: z.string().min(1),
  serviceRequestId: z.string().min(1),
  serviceRequestVersion: z.string().regex(/^\d+$/),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
}).strict()

const retryImagingRequestOperationInputSchema = retryImagingRequestRequestSchema.shape.input.extend({
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
}).strict()

const imagingReportVersionInputShape = {
  diagnosticReportId: z.string().min(1),
  diagnosticReportVersion: z.string().regex(/^\d+$/),
  requestId: z.string().min(1),
}

const acknowledgeImagingReportOperationInputSchema = acknowledgeImagingReportRequestSchema.shape.input
  .extend(imagingReportVersionInputShape).strict()

const correctImagingReportOperationInputSchema = correctImagingReportRequestSchema.shape.input
  .extend(imagingReportVersionInputShape).strict()

const savePathologyRequestDraftOperationInputSchema = savePathologyRequestDraftRequestSchema.shape.input
  .extend(encounterVersionInputShape).strict()

const deletePathologyRequestDraftOperationInputSchema = deletePathologyRequestDraftRequestSchema.shape.input
  .extend(encounterVersionInputShape).strict()

const issuePathologyRequestOperationInputSchema = issuePathologyRequestRequestSchema.shape.input
  .extend(encounterVersionInputShape).strict()

const cancelPathologyRequestOperationInputSchema = cancelPathologyRequestRequestSchema.shape.input.extend({
  requestId: z.string().min(1),
  serviceRequestId: z.string().min(1),
  serviceRequestVersion: z.string().regex(/^\d+$/),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
}).strict()

const retryPathologyRequestOperationInputSchema = retryPathologyRequestRequestSchema.shape.input.extend({
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
}).strict()

const acknowledgePathologyReportOperationInputSchema = acknowledgePathologyReportRequestSchema.shape.input
  .extend(imagingReportVersionInputShape).strict()

const correctPathologyReportOperationInputSchema = correctPathologyReportRequestSchema.shape.input
  .extend(imagingReportVersionInputShape).strict()

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

const billingCaseInputSchema = paginationInputSchema.extend({ caseId: z.string().min(1) }).strict()
const refundChargeVersionShape = { chargeVersion: z.number().int().positive() }
const chargeAdjustmentOperationInputSchema = chargeAdjustmentInputSchema.extend({ caseId: z.string().min(1), ...refundChargeVersionShape }).strict()
const refundPreviewOperationInputSchema = refundPreviewInputSchema.extend({ chargeItemId: z.string().min(1), ...refundChargeVersionShape }).strict()
const refundConfirmOperationInputSchema = refundConfirmInputSchema.extend({ previewId: z.string().min(1), chargeItemId: z.string().min(1), ...refundChargeVersionShape }).strict()
const refundRecoverOperationInputSchema = refundRecoverInputSchema.extend({ refundId: z.string().min(1), chargeItemId: z.string().min(1), ...refundChargeVersionShape }).strict()

const paymentPreviewOperationInputSchema = z.object({
  caseId: z.string().min(1),
  category: z.enum(['laboratory', 'medication']),
  chargeItemId: z.string().min(1),
  chargeVersion: z.number().int().positive(),
  simulatorRule: paymentSimulatorRuleSchema,
  tenders: paymentTendersSchema.optional(),
}).strict()

const paymentConfirmOperationInputSchema = z.object({
  chargeItemId: z.string().min(1),
  chargeVersion: z.number().int().positive(),
  commitToken: z.string().min(1),
  previewId: z.string().min(1),
}).strict()

const paymentRecoverOperationInputSchema = z.object({
  chargeItemId: z.string().min(1),
  chargeVersion: z.number().int().positive(),
  expectedPaymentVersion: z.number().int().positive(),
  paymentId: z.string().min(1),
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

const controlConsultationRecordingOperationInputSchema = controlConsultationRecordingRequestSchema.shape.input.extend({
  encounterId: z.string().min(1), encounterVersion: z.string().regex(/^\d+$/),
}).strict()
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
  'doctor.document-quality.check': (rawInput: unknown) => {
    const { caseId: _caseId, encounterId, encounterVersion, ...input } = documentQualityCheckInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'doctor.document-quality.retain': (rawInput: unknown) => {
    const { caseId: _caseId, encounterId, encounterVersion, ...input } = documentQualityRetainInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },

  'admin.laboratory-services.publish': (rawInput: unknown) => ({
    input: publishLaboratoryServicesOperationInputSchema.parse(rawInput),
  }),
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
    } = consultationMessageInputSchema.parse(rawInput)
    return commandBody({
      [`Encounter/${encounterId}`]: encounterVersion,
      [`Task/${taskId}`]: taskVersion,
    }, input)
  },
  'encounter.consultation.reply.retry': (rawInput: unknown) => {
    const { encounterId: _encounterId, ...input } = consultationRetryInputSchema.parse(rawInput)
    return commandBody({}, input)
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
  'encounter.consultation-recording.control': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = controlConsultationRecordingOperationInputSchema.parse(rawInput)
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
  [clinicalDocumentOperationIds.cancelSign]: (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = cancelClinicalDocumentSignOperationInputSchema.parse(rawInput)
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
  'encounter.imaging-request.draft.set': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = saveImagingRequestDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.imaging-request.draft.delete': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = deleteImagingRequestDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.imaging-request.issue': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = issueImagingRequestOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'imaging-request.cancel': (rawInput: unknown) => {
    const {
      requestId: _requestId,
      serviceRequestId,
      serviceRequestVersion,
      taskId,
      taskVersion,
      ...input
    } = cancelImagingRequestOperationInputSchema.parse(rawInput)
    return commandBody({
      [`ServiceRequest/${serviceRequestId}`]: serviceRequestVersion,
      [`Task/${taskId}`]: taskVersion,
    }, input)
  },
  'imaging-request.retry': (rawInput: unknown) => {
    const { requestId: _requestId, taskId, taskVersion, ...input }
      = retryImagingRequestOperationInputSchema.parse(rawInput)
    return commandBody({ [`Task/${taskId}`]: taskVersion }, input)
  },
  'imaging-report.acknowledge': (rawInput: unknown) => {
    const { diagnosticReportId, diagnosticReportVersion, requestId: _requestId, ...input }
      = acknowledgeImagingReportOperationInputSchema.parse(rawInput)
    return commandBody({ [`DiagnosticReport/${diagnosticReportId}`]: diagnosticReportVersion }, input)
  },
  'imaging-report.correct': (rawInput: unknown) => {
    const { diagnosticReportId, diagnosticReportVersion, requestId: _requestId, ...input }
      = correctImagingReportOperationInputSchema.parse(rawInput)
    return commandBody({ [`DiagnosticReport/${diagnosticReportId}`]: diagnosticReportVersion }, input)
  },
  'encounter.pathology-request.draft.set': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = savePathologyRequestDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.pathology-request.draft.delete': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = deletePathologyRequestDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.pathology-request.issue': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = issuePathologyRequestOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'pathology-request.cancel': (rawInput: unknown) => {
    const {
      requestId: _requestId,
      serviceRequestId,
      serviceRequestVersion,
      taskId,
      taskVersion,
      ...input
    } = cancelPathologyRequestOperationInputSchema.parse(rawInput)
    return commandBody({
      [`ServiceRequest/${serviceRequestId}`]: serviceRequestVersion,
      [`Task/${taskId}`]: taskVersion,
    }, input)
  },
  'pathology-request.retry': (rawInput: unknown) => {
    const { requestId: _requestId, taskId, taskVersion, ...input }
      = retryPathologyRequestOperationInputSchema.parse(rawInput)
    return commandBody({ [`Task/${taskId}`]: taskVersion }, input)
  },
  'pathology-report.acknowledge': (rawInput: unknown) => {
    const { diagnosticReportId, diagnosticReportVersion, requestId: _requestId, ...input }
      = acknowledgePathologyReportOperationInputSchema.parse(rawInput)
    return commandBody({ [`DiagnosticReport/${diagnosticReportId}`]: diagnosticReportVersion }, input)
  },
  'pathology-report.correct': (rawInput: unknown) => {
    const { diagnosticReportId, diagnosticReportVersion, requestId: _requestId, ...input }
      = correctPathologyReportOperationInputSchema.parse(rawInput)
    return commandBody({ [`DiagnosticReport/${diagnosticReportId}`]: diagnosticReportVersion }, input)
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
  'payment.recover': (rawInput: unknown) => {
    const { chargeItemId, chargeVersion, expectedPaymentVersion }
      = paymentRecoverOperationInputSchema.parse(rawInput)
    return commandBody({ [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, { expectedPaymentVersion })
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
  { cliPath: ['inpatient', 'financial-adjustments'], id: 'inpatient.financial.read', http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments' },
    input: z.object({ admissionId: inpatientFinancialAdjustmentInputSchema.shape.admissionId }).strict(), output: inpatientFinancialSchema,
    mode: 'query', requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['cashier', 'medical-records'], summary: '分别读取首次冻结费用、后续更正、原款及当前待收退差异', version: 1 },
  { cliPath: ['inpatient', 'adjust-finance'], id: 'inpatient.financial.adjust', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientFinancialAdjustmentInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialAdjustmentInputSchema, output: inpatientFinancialResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'], summary: '审阅当前账目指纹后追加关联原费用的冲减或补计，保留首次冻结事实', version: 2 },
  { cliPath: ['inpatient', 'preview-financial-refund'], id: 'inpatient.financial.refund.preview', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/refunds/preview', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientFinancialRefundPreviewInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialRefundPreviewInputSchema, output: inpatientFinancialRefundPreviewResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['cashier'], summary: '冻结费用冲减依据、当前待退及原交易余额供人工审阅; INPATIENT_FUNDS_PENDING: query the original unknown payment/refund before a new preview or confirmation', version: 1 },
  { cliPath: ['inpatient', 'confirm-financial-refund'], id: 'inpatient.financial.refund.confirm', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/refunds/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientFinancialRefundConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialRefundConfirmInputSchema, output: refundResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'], summary: '按已审阅预览办理后续原款退款，未知保留原尝试; INPATIENT_FUNDS_PENDING: query the original unknown payment/refund before a new preview or confirmation', version: 2 },
  { cliPath: ['inpatient', 'recover-financial-refund'], id: 'inpatient.financial.refund.recover', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/refunds/recover', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientFinancialRefundRecoverInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialRefundRecoverInputSchema, output: refundResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'], summary: '只查询本次后续退款原尝试，不重复退款或倒退清床归档', version: 2 },
  { cliPath: ['inpatient', 'preview-financial-payment'], id: 'inpatient.financial.payment.preview', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/payments/preview', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientFinancialPaymentPreviewInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialPaymentPreviewInputSchema, output: inpatientPaymentPreviewResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['cashier'], summary: '冻结补计依据和组合补收差额供人工审阅; INPATIENT_FUNDS_PENDING: query the original unknown payment/refund before a new preview or confirmation', version: 1 },
  { cliPath: ['inpatient', 'confirm-financial-payment'], id: 'inpatient.financial.payment.confirm', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/payments/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPaymentConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientPaymentConfirmInputSchema, output: inpatientPaymentResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'], summary: '确认结算后费用补收，保留原预览及首次结算; INPATIENT_FUNDS_PENDING: query the original unknown payment/refund before a new preview or confirmation', version: 2 },
  { cliPath: ['inpatient', 'recover-financial-payment'], id: 'inpatient.financial.payment.recover', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/payments/recover', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPaymentRecoverInputSchema.parse(raw); return { input } } },
    input: inpatientPaymentRecoverInputSchema, output: inpatientPaymentResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'], summary: '查询后续原补收结果并追加确定事实，不重新收款', version: 2 },
  {
    cliPath: ['admin', 'laboratory-services', 'candidates', 'search'],
    http: {
      method: 'GET',
      path: '/api/his/v1/admin/laboratory-services/candidates',
    },
    id: 'admin.laboratory-services.candidates.search',
    input: laboratoryServiceCandidateSearchInputSchema,
    mode: 'query',
    output: laboratoryServiceCandidateSearchSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['administrator'],
    summary: '查询默认启用的 laboratory-cn 单项与组合；其他来源须显式指定',
    version: 3,
  },
  {
    cliPath: ['admin', 'laboratory-services', 'publish'],
    http: {
      method: 'POST',
      path: '/api/his/v1/admin/laboratory-services/actions/publish',
    },
    id: 'admin.laboratory-services.publish',
    input: publishLaboratoryServicesOperationInputSchema,
    mode: 'command',
    output: publishLaboratoryServicesResponseSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['administrator'],
    summary: '发布显式选定的检验配置批次，支持 laboratory-cn 单项与组合',
    version: 2,
  },
  {
    cliPath: ['admin', 'laboratory-services', 'job', 'get'],
    http: {
      method: 'GET',
      path: '/api/his/v1/admin/laboratory-services/jobs/:jobId',
    },
    id: 'admin.laboratory-services.job.get',
    input: laboratoryServicePublicationJobInputSchema,
    mode: 'query',
    output: laboratoryServicePublicationJobSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['administrator'],
    summary: 'Read one Laboratory Service publication job',
    version: 1,
  },
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
    roles: ['administrator', 'outpatient-doctor', 'inpatient-doctor'],
    summary: 'Search the active diagnosis reference catalog',
    version: 2,
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
    roles: ['administrator', 'outpatient-doctor', 'inpatient-doctor'],
    summary: 'Search the active medication reference catalog',
    version: 2,
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
    roles: ['administrator', 'outpatient-doctor', 'inpatient-doctor'],
    summary: 'Search the active laboratory reference catalog',
    version: 2,
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
    summary: 'Register a patient with a durable dated outpatient number; REGISTRATION_NUMBER_STATE_INVALID, REGISTRATION_NUMBER_EXHAUSTED, or REGISTRATION_NUMBER_AUTHORITY_RETIRED requires administrator recovery, not a new intent or a guessed number',
    version: 2,
  },
  {
    cliPath: ['registration', 'synthetic-case', 'list'],
    http: {
      method: 'GET',
      path: '/api/his/v1/registration/synthetic-cases',
    },
    id: 'registration.synthetic-case.list',
    input: syntheticCaseRegistrationListInputSchema,
    mode: 'query',
    output: syntheticCaseRegistrationListSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['registrar'],
    summary: 'List ready Synthetic Cases awaiting outpatient registration',
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
    summary: 'Start an outpatient visit from a ready Synthetic Case Instance using the shared durable number allocator; REGISTRATION_NUMBER_STATE_INVALID, REGISTRATION_NUMBER_EXHAUSTED, or REGISTRATION_NUMBER_AUTHORITY_RETIRED requires administrator recovery, not a new intent or a guessed number',
    version: 2,
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
    input: paginationInputSchema.extend({ view: doctorQueueViewSchema.optional() }),
    mode: 'query',
    output: doctorQueueSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['outpatient-doctor'],
    summary: 'List the doctor work queue with the current Registration registrationNumber, or null for an unrecorded legacy number; presentation is null when no triage record exists',
    version: 3,
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
    summary: 'Read the active doctor case with its current Registration registrationNumber (null when unrecorded), incomplete draft and consultationRecording with hasSavedDraft, persistent control version, progress, sourceResults, safe recording failures, fragment ownership and fact-level sources; consultation.replyAttempt exposes executing, blocked, succeeded, failed or unknown with the original deadline and safe error code, including MODEL_CONTROL_BLOCKED, CONSULTATION_CASE_NOT_FOUND and CONSULTATION_PERSONA_OUTDATED; a blocked reply retains the saved question and resumes only while valid within its original deadline, while unknown requests require an explicit clinician retry; source validation precedes persistence, source meaning and recording changes are checked by existing qualityControl; legacy verification counts are zero and issues empty; presentation is null when no triage record exists; qualityControl binds current ten-field content and saved evidence to nonblocking completion and verification prompts',
    version: 15,
  },
  {
    cliPath: ['doctor', 'document-quality', 'get'],
    http: { method: 'GET', path: '/api/his/v1/doctor/cases/:caseId/document-quality-control' },
    id: 'doctor.document-quality.get',
    input: caseIdInputSchema.extend({ clientId: z.string().min(1).max(128).optional() }),
    mode: 'query', output: clinicalDocumentQualityControlStateSchema,
    requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['outpatient-doctor'],
    summary: '读取当前病历质控、输入身份、字段问题及安全失败阶段/原因；clientId 保留未保存候选版本，同完整输入复用持久任务，不保存病历', version: 2,
  },
  {
    cliPath: ['doctor', 'document-quality', 'check'],
    http: { method: 'POST', path: '/api/his/v1/doctor/cases/:caseId/document-quality-control/actions/check' },
    id: 'doctor.document-quality.check', input: documentQualityCheckInputSchema,
    mode: 'command', output: clinicalDocumentQualityControlResponseSchema,
    requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['outpatient-doctor'],
    summary: '检查已保存病历或带 clientId/clientRevision 的候选；同完整输入复用成功、在途及失败任务，refresh 仅用于明确重试；不保存病历或新增签署门禁', version: 2,
  },
  {
    cliPath: ['doctor', 'document-quality', 'retain'],
    http: { method: 'POST', path: '/api/his/v1/doctor/cases/:caseId/document-quality-control/actions/retain' },
    id: 'doctor.document-quality.retain', input: documentQualityRetainInputSchema,
    mode: 'command', output: clinicalDocumentQualityControlResponseSchema,
    requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['outpatient-doctor'],
    summary: '医生核实当前问题后保留正文，原因选填；仅适用于相同相关正文与证据，返回当前共享质控及安全失败说明，记录审计且不成为患者事实', version: 2,
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
    summary: 'Search active orderable Laboratory Services for one doctor case',
    version: 1,
  },
  {
    cliPath: ['encounter', 'consultation', 'ask'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/actions/ask-consultation-question',
    },
    id: 'encounter.consultation.ask',
    input: consultationMessageInputSchema,
    mode: 'command',
    output: sendConsultationMessageResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Send one free-text consultation message; overlapping ask and retry intents share the pending doctor turn execution; the same idempotency key waits for its original deadline or replays its saved reply, failed or unknown outcome without new inference, preserving the original CONSULTATION_CASE_NOT_FOUND or CONSULTATION_PERSONA_OUTDATED classification; MODEL_CONTROL_BLOCKED (409) retains the saved doctor question and exposes a blocked replyAttempt that resumes only while valid within the original deadline; read the case and original receipt instead of resending the question',
    version: 5,
  },
  {
    cliPath: ['encounter', 'consultation', 'retry-reply'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/actions/retry-consultation-reply',
    },
    id: 'encounter.consultation.reply.retry',
    input: consultationRetryInputSchema,
    mode: 'command',
    output: retryConsultationReplyResponseSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: 'Explicitly retry the last unanswered patient reply; an executing or blocked attempt is joined with its original model and deadline; only a new manual intent after termination starts with current model settings; the same key replays failed or unknown outcomes without new inference, preserving the original CONSULTATION_CASE_NOT_FOUND or CONSULTATION_PERSONA_OUTDATED classification; MODEL_CONTROL_BLOCKED (409) retains the saved doctor question and exposes a blocked replyAttempt that resumes only while valid within the original deadline; unknown requests require an explicit clinician retry after termination',
    version: 5,
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
    summary: 'Withdraw before dispensing; WORKFLOW_CONFLICT with active insurance allocations including zero-benefit accrual; cashier must run insurance.cancel first',
    version: 1,
  },
  {
    cliPath: ['encounter', 'consultation-recording', 'control'],
    http: { method: 'POST', path: '/api/his/v1/encounters/:encounterId/consultation-recording/actions/control' },
    id: 'encounter.consultation-recording.control',
    input: controlConsultationRecordingOperationInputSchema,
    mode: 'command', output: controlConsultationRecordingResponseSchema,
    requirements: { expectedVersions: true, idempotency: 'required' },
    risk: 'write', roles: ['outpatient-doctor'],
    summary: 'Pause, resume, explicitly backfill a historical consultation or retry failed recording; retired semantic checks cannot be retried; backfill requires an existing Consultation, otherwise returns WORKFLOW_CONFLICT; requires the current recording version and preserves completed sources and manual edits; model controls retain valid unfinished sources for automatic continuation; MODEL_OUTCOME_UNKNOWN stops automatic resending and requires an explicit clinician retry',
    version: 6,
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
    summary: 'Save a version-protected clinical document draft; empty fields are allowed and field text including whitespace is preserved exactly. Identical saves advance the draft version while retaining valid recommendations. Optional familyHistory and allergyHistory allow empty or missing values meaning not recorded; allergy text does not create AllergyIntolerance. Signing still requires the existing core content. Agent writes declare agentGenerated and optional agentFacts with saved sources; unsupported facts remain writable and get quality prompts',
    version: 5,
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
    summary: 'Prepare a version-bound signing preview even without automatic recording, including doctor-only cases without a Consultation; freeze recording and bind the Consultation or source snapshot; cancel preparation to recover unfinished sources. Include nonblocking quality prompts and pending, stale or failed check status',
    version: 5,
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
    summary: 'Sign an unchanged structured document even without automatic recording; reject a changed Consultation or source snapshot; automatic recording needs no human acknowledgement; completeness, responsibility, preview token and version checks still apply',
    version: 4,
  },
  {
    cliPath: ['encounter', 'clinical-document', 'sign', 'cancel'],
    http: { method: 'POST', path: '/api/his/v1/encounters/:encounterId/clinical-document/actions/cancel-sign' },
    id: clinicalDocumentOperationIds.cancelSign,
    input: cancelClinicalDocumentSignOperationInputSchema,
    mode: 'command', output: cancelClinicalDocumentSignResponseSchema,
    requirements: { expectedVersions: true, idempotency: 'required' },
    risk: 'write', roles: ['outpatient-doctor'],
    summary: 'Cancel an unconsumed signing preparation, including expired previews; a valid cancel-only Agent Grant authorizes recovery of unfinished patient/doctor/report recording without clearing an explicit pause or failed sources; re-read the case before retrying or signing',
    version: 2,
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
    summary: 'Create a new revision from the latest signed clinical document, preserving the immutable original. Optional familyHistory and allergyHistory allow empty or missing values meaning not recorded',
    version: 2,
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
    summary: '保存版本受保护的检验草稿；缺少结果底账时以 LABORATORY_GENERATION_UNSUPPORTED 拒绝，不可重试',
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
    summary: '签发当前检验草稿；缺少结果底账时以 LABORATORY_GENERATION_UNSUPPORTED 拒绝，不可重试',
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
    summary: '取消 issued 或 generation-failed 检验申请；保留原申请及冻结输入',
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
    summary: '按当前模型配置重试生成，自动尝试固定该模型；INVESTIGATION_TRUTH_INCOMPATIBLE 或 INVESTIGATION_UNSUPPORTED 拒绝重试，可取消申请；控制拒绝保留有效待办，MODEL_OUTCOME_UNKNOWN 停止自动重发，仅由医生明确重试生成',
    version: 4,
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
    cliPath: ['doctor', 'case', 'imaging-services', 'list'],
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/cases/:caseId/imaging-services',
    },
    id: 'doctor.case.imaging-services.list',
    input: caseIdInputSchema,
    mode: 'query',
    output: caseImagingServiceCatalogSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['outpatient-doctor'],
    summary: '列出本院放射服务及其是否开展；是否开展取决于医院启用与素材就绪，与病例病情无关',
    version: 1,
  },
  {
    cliPath: ['encounter', 'imaging-request', 'draft', 'set'],
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/imaging-request/draft',
    },
    id: 'encounter.imaging-request.draft.set',
    input: saveImagingRequestDraftOperationInputSchema,
    mode: 'draft',
    output: imagingRequestDraftResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: '保存版本受保护的放射申请草稿（服务与检查指征）',
    version: 1,
  },
  {
    cliPath: ['encounter', 'imaging-request', 'draft', 'delete'],
    http: {
      method: 'DELETE',
      path: '/api/his/v1/encounters/:encounterId/imaging-request/draft',
    },
    id: 'encounter.imaging-request.draft.delete',
    input: deleteImagingRequestDraftOperationInputSchema,
    mode: 'draft',
    output: imagingRequestDraftResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: '按版本删除当前放射申请草稿',
    version: 1,
  },
  {
    cliPath: ['encounter', 'imaging-request', 'issue'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/imaging-request/actions/issue',
    },
    id: 'encounter.imaging-request.issue',
    input: issueImagingRequestOperationInputSchema,
    mode: 'command',
    output: issueImagingRequestResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: '签发当前放射申请草稿；本院当前未开展时以 CATALOG_CONFLICT 拒绝，同一服务已有进行中申请时以 IMAGING_REQUEST_DUPLICATE 拒绝',
    version: 1,
  },
  {
    cliPath: ['imaging-request', 'cancel'],
    http: {
      method: 'POST',
      path: '/api/his/v1/imaging-requests/:requestId/actions/cancel',
    },
    id: 'imaging-request.cancel',
    input: cancelImagingRequestOperationInputSchema,
    mode: 'command',
    output: imagingRequestActionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: '取消尚未开始执行或未取得结果的放射申请',
    version: 1,
  },
  {
    cliPath: ['imaging-request', 'retry'],
    http: {
      method: 'POST',
      path: '/api/his/v1/imaging-requests/:requestId/actions/retry',
    },
    id: 'imaging-request.retry',
    input: retryImagingRequestOperationInputSchema,
    mode: 'command',
    output: imagingRequestActionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: '重试未取得结果的放射申请；素材仍不可用时再次以未取得结果结束',
    version: 1,
  },
  {
    cliPath: ['imaging-report', 'acknowledge'],
    http: {
      method: 'POST',
      path: '/api/his/v1/imaging-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
    },
    id: 'imaging-report.acknowledge',
    input: acknowledgeImagingReportOperationInputSchema,
    mode: 'command',
    output: acknowledgeImagingReportResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: '确认已阅当前放射报告；影像不可读时以 IMAGING_STUDY_UNAVAILABLE 拒绝',
    version: 1,
  },
  {
    cliPath: ['imaging-report', 'correct'],
    http: {
      method: 'POST',
      path: '/api/his/v1/imaging-requests/:requestId/reports/:diagnosticReportId/actions/correct',
    },
    id: 'imaging-report.correct',
    input: correctImagingReportOperationInputSchema,
    mode: 'command',
    output: correctImagingReportResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['administrator'],
    summary: '用同一素材另一份已核对的报告内容修订更正当前放射报告',
    version: 1,
  },
  {
    cliPath: ['doctor', 'case', 'pathology-services', 'list'],
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/cases/:caseId/pathology-services',
    },
    id: 'doctor.case.pathology-services.list',
    input: caseIdInputSchema,
    mode: 'query',
    output: casePathologyServiceCatalogSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['outpatient-doctor'],
    summary: '列出本院病理会诊服务、是否开展，以及该病例可见既往病史中可送检的手术；是否开展与病例病情无关',
    version: 1,
  },
  {
    cliPath: ['encounter', 'pathology-request', 'draft', 'set'],
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/pathology-request/draft',
    },
    id: 'encounter.pathology-request.draft.set',
    input: savePathologyRequestDraftOperationInputSchema,
    mode: 'draft',
    output: pathologyRequestDraftResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: '保存版本受保护的病理会诊申请草稿（服务、送检的既往手术与会诊目的）；所选手术不在可送检清单内时以 PATHOLOGY_SOURCE_PROCEDURE_UNAVAILABLE 拒绝',
    version: 1,
  },
  {
    cliPath: ['encounter', 'pathology-request', 'draft', 'delete'],
    http: {
      method: 'DELETE',
      path: '/api/his/v1/encounters/:encounterId/pathology-request/draft',
    },
    id: 'encounter.pathology-request.draft.delete',
    input: deletePathologyRequestDraftOperationInputSchema,
    mode: 'draft',
    output: pathologyRequestDraftResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: '按版本删除当前病理会诊申请草稿',
    version: 1,
  },
  {
    cliPath: ['encounter', 'pathology-request', 'issue'],
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/pathology-request/actions/issue',
    },
    id: 'encounter.pathology-request.issue',
    input: issuePathologyRequestOperationInputSchema,
    mode: 'command',
    output: issuePathologyRequestResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: '签发当前病理会诊申请草稿；本院当前未开展时以 CATALOG_CONFLICT 拒绝，同一服务已有进行中申请时以 PATHOLOGY_REQUEST_DUPLICATE 拒绝',
    version: 1,
  },
  {
    cliPath: ['pathology-request', 'cancel'],
    http: {
      method: 'POST',
      path: '/api/his/v1/pathology-requests/:requestId/actions/cancel',
    },
    id: 'pathology-request.cancel',
    input: cancelPathologyRequestOperationInputSchema,
    mode: 'command',
    output: pathologyRequestActionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['outpatient-doctor'],
    summary: '取消尚未开始阅片或未取得结果的病理会诊申请',
    version: 1,
  },
  {
    cliPath: ['pathology-request', 'retry'],
    http: {
      method: 'POST',
      path: '/api/his/v1/pathology-requests/:requestId/actions/retry',
    },
    id: 'pathology-request.retry',
    input: retryPathologyRequestOperationInputSchema,
    mode: 'command',
    output: pathologyRequestActionResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: '重试未取得结果的病理会诊申请；切片仍不可用时再次以未取得结果结束',
    version: 1,
  },
  {
    cliPath: ['pathology-report', 'acknowledge'],
    http: {
      method: 'POST',
      path: '/api/his/v1/pathology-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
    },
    id: 'pathology-report.acknowledge',
    input: acknowledgePathologyReportOperationInputSchema,
    mode: 'command',
    output: acknowledgePathologyReportResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'write',
    roles: ['outpatient-doctor'],
    summary: '确认已阅当前病理会诊报告；切片不可读时以 IMAGING_STUDY_UNAVAILABLE 拒绝',
    version: 1,
  },
  {
    cliPath: ['pathology-report', 'correct'],
    http: {
      method: 'POST',
      path: '/api/his/v1/pathology-requests/:requestId/reports/:diagnosticReportId/actions/correct',
    },
    id: 'pathology-report.correct',
    input: correctPathologyReportOperationInputSchema,
    mode: 'command',
    output: correctPathologyReportResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['administrator'],
    summary: '用同一切片素材另一份已核对的报告内容修订更正当前病理会诊报告',
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
    cliPath: ['billing', 'case', 'get'],
    http: {
      method: 'GET',
      path: '/api/his/v1/billing/cases/:caseId',
    },
    id: 'billing.case.get',
    input: billingCaseInputSchema,
    mode: 'query',
    output: billingCaseSchema,
    requirements: {
      expectedVersions: false,
      idempotency: 'none',
    },
    risk: 'read',
    roles: ['cashier'],
    summary: 'Read one unified bill with complete balances, paged payment attempts and unpaid registration charges; registration remains read-only',
    version: 2,
  },
  {
    cliPath:['insurance','get'],id:'insurance.get',http:{method:'GET',path:'/api/his/v1/insurance/:kind/:id'},
    input:insuranceTargetSchema,output:insuranceStateSchema,mode:'query',requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['cashier'],summary:'Read synthetic patient benefits, current balance, annualBalances for original settlement years and immutable settlement/compensation history',version:1,
  },
  {
    cliPath:['insurance','preview'],id:'insurance.preview',http:{method:'POST',path:'/api/his/v1/insurance/:kind/:id/preview',encodeBody:raw=>{const {kind:_kind,id:_id,...input}=insuranceTargetSchema.extend({planCode:insurancePlanCodeSchema}).parse(raw);return {input,expectedVersions:{}}}},
    input:insuranceTargetSchema.extend({planCode:insurancePlanCodeSchema}),output:insurancePreviewResponseSchema,mode:'preview',requirements:{expectedVersions:false,idempotency:'required'},risk:'write',roles:['cashier'],summary:'Preview fixed synthetic employee/resident benefits bound to charge and patient annual balance versions; INSURANCE_FUNDS_CONFLICT: medication benefits require a completed Encounter before preview/confirm',version:1,
  },
  {
    cliPath:['insurance','confirm'],id:'insurance.confirm',http:{method:'POST',path:'/api/his/v1/insurance/:kind/:id/confirm',encodeBody:raw=>{const {kind:_kind,id:_id,...input}=insuranceTargetSchema.extend({previewId:z.string().min(1),commitToken:z.string().min(16).max(256)}).parse(raw);return {input,expectedVersions:{}}}},
    input:insuranceTargetSchema.extend({previewId:z.string().min(1),commitToken:z.string().min(16).max(256)}),output:insuranceResponseSchema,mode:'command',requirements:{expectedVersions:false,idempotency:'required'},risk:'high-risk-write',roles:['cashier'],summary:'Confirm reviewed synthetic benefits; stale charges or patient annual balance require a new preview; INSURANCE_PREVIEW_STALE; INSURANCE_FUNDS_CONFLICT: medication benefits require a completed Encounter before preview/confirm',version:1,
  },
  {
    cliPath:['insurance','cancel'],id:'insurance.cancel',http:{method:'POST',path:'/api/his/v1/insurance/:kind/:id/cancel',encodeBody:raw=>{const {kind:_kind,id:_id,...input}=insuranceTargetSchema.extend({settlementId:z.string().min(1),expectedBalanceVersion:z.number().int().nonnegative()}).parse(raw);return {input,expectedVersions:{}}}},
    input:insuranceTargetSchema.extend({settlementId:z.string().min(1),expectedBalanceVersion:z.number().int().nonnegative()}),output:insuranceResponseSchema,mode:'command',requirements:{expectedVersions:false,idempotency:'required'},risk:'high-risk-write',roles:['cashier'],summary:'Append compensation using expectedBalanceVersion from annualBalances for the original settlement year; preserve later encounters annual and account balances',version:1,
  },
  {
    cliPath: ['billing', 'refunds', 'get'], id: 'billing.refunds.get', mode: 'query', version: 1,
    http: { method: 'GET', path: '/api/his/v1/billing/cases/:caseId/refunds' },
    input: z.object({ caseId: z.string().min(1) }).strict(), output: refundCaseSchema,
    roles: ['cashier'], risk: 'read', requirements: { expectedVersions: false, idempotency: 'none' },
    summary: 'Read original successful payments, fee corrections, refund reservations and channel history',
  },
  {
    cliPath: ['billing', 'charge', 'adjust'], id: 'billing.charge.adjust', mode: 'command', version: 1,
    http: { method: 'POST', path: '/api/his/v1/billing/cases/:caseId/adjustments', encodeBody: raw => {
      const { caseId: _caseId, chargeVersion, ...input } = chargeAdjustmentOperationInputSchema.parse(raw)
      return { expectedVersions: { [`ChargeItem/${input.chargeItemId}`]: String(chargeVersion) }, input }
    } }, input: chargeAdjustmentOperationInputSchema, output: chargeAdjustmentResponseSchema,
    roles: ['cashier'], risk: 'high-risk-write', requirements: { expectedVersions: true, idempotency: 'required' },
    summary: 'Append a reasoned correction to the original charge without reversing clinical execution',
  },
  {
    cliPath: ['refund', 'preview'], id: 'refund.preview', mode: 'preview', version: 1,
    http: { method: 'POST', path: '/api/his/v1/refunds/actions/preview', encodeBody: raw => {
      const { chargeItemId, chargeVersion, ...input } = refundPreviewOperationInputSchema.parse(raw)
      return { expectedVersions: { [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, input }
    } }, input: refundPreviewOperationInputSchema, output: refundPreviewResponseSchema,
    roles: ['cashier'], risk: 'write', requirements: { expectedVersions: true, idempotency: 'required' },
    summary: 'Freeze a partial refund against the original successful payment and recorded fee correction',
  },
  {
    cliPath: ['refund', 'confirm'], id: 'refund.confirm', mode: 'command', version: 1,
    http: { method: 'POST', path: '/api/his/v1/refunds/:previewId/actions/confirm', encodeBody: raw => {
      const { chargeItemId, chargeVersion, previewId: _previewId, ...input } = refundConfirmOperationInputSchema.parse(raw)
      return { expectedVersions: { [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, input }
    } }, input: refundConfirmOperationInputSchema, output: refundResponseSchema,
    roles: ['cashier'], risk: 'high-risk-write', requirements: { expectedVersions: true, idempotency: 'required' },
    summary: 'Confirm the reviewed refund; an ambiguous result reserves original funds and correction allowance',
  },
  {
    cliPath: ['refund', 'recover'], id: 'refund.recover', mode: 'command', version: 2,
    http: { method: 'POST', path: '/api/his/v1/refunds/:refundId/actions/recover', encodeBody: raw => {
      const { chargeItemId, chargeVersion, refundId: _refundId, ...input } = refundRecoverOperationInputSchema.parse(raw)
      return { expectedVersions: { [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, input }
    } }, input: refundRecoverOperationInputSchema, output: refundResponseSchema,
    roles: ['cashier'], risk: 'high-risk-write', requirements: { expectedVersions: true, idempotency: 'required' },
    summary: 'Query the original refund without resending; current-Epoch human cashier may recover in active/completed Scenario Run; closed Run and completed Agent Grant are rejected',
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
    summary: 'Create a version-bound payment preview with optional cash, bank-card, and mobile tenders; recorded ambiguous results require recovery before another payment',
    version: 2,
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
    summary: 'Confirm frozen tenders from a valid preview; only a fully paid charge advances clinical fulfillment',
    version: 2,
  },
  {
    cliPath: ['payment', 'recover'],
    http: {
      method: 'POST',
      path: '/api/his/v1/payments/:paymentId/actions/recover',
    },
    id: 'payment.recover',
    input: paymentRecoverOperationInputSchema,
    mode: 'command',
    output: paymentResponseSchema,
    requirements: {
      expectedVersions: true,
      idempotency: 'required',
    },
    risk: 'high-risk-write',
    roles: ['cashier'],
    summary: 'Recover a recorded ambiguous payment from its channel result; keep pending ambiguous and inspect the original Command receipt after response loss',
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
  { cliPath: ['inpatient','financial-insurance','cancel'], id: 'inpatient.financial.insurance.cancel',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/:adjustmentId/insurance/cancel',
      encodeBody: raw => { const { admissionId: _admission, adjustmentId: _adjustment, ...input } = inpatientFinancialInsuranceCancelInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialInsuranceCancelInputSchema, output: inpatientFinancialResponseSchema, mode: 'command',
    requirements: { expectedVersions: false, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'],
    summary: '在当前财务调整下追加原待遇精确补偿，保留首次结算及其他就诊年度影响；响应丢失查原Command回执', version: 1 },
  { cliPath: ['inpatient','financial-insurance','preview'], id: 'inpatient.financial.insurance.preview',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/:adjustmentId/insurance/preview',
      encodeBody: raw => { const { admissionId: _admission, adjustmentId: _adjustment, ...input } = inpatientFinancialInsurancePreviewInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialInsurancePreviewInputSchema, output: insurancePreviewResponseSchema, mode: 'command',
    requirements: { expectedVersions: false, idempotency: 'required' }, risk: 'write', roles: ['cashier'],
    summary: '按原年度方案、权威更正费用与实时患者累计预览替代待遇，必须重新审阅', version: 1 },
  { cliPath: ['inpatient','financial-insurance','confirm'], id: 'inpatient.financial.insurance.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/:adjustmentId/insurance/confirm',
      encodeBody: raw => { const { admissionId: _admission, adjustmentId: _adjustment, ...input } = inpatientFinancialInsuranceConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialInsuranceConfirmInputSchema, output: inpatientFinancialResponseSchema, mode: 'command',
    requirements: { expectedVersions: false, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'],
    summary: '确认已审阅且原年度余额仍有效的新待遇，追加关联后按患者现金差额办理收退；失效须重新预览，响应丢失查原Command回执', version: 1 },
  { cliPath:['inpatient','record'],id:'inpatient.record.read',http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/record'},input:z.object({admissionId:z.string().min(1)}).strict(),output:inpatientRecordSchema,
    mode:'query',requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['inpatient-doctor','ward-nurse','medical-records'],summary:'读取首页核心字段、当前来源指纹、修订审核或不可变归档',version:1 },
  { cliPath:['inpatient','submit-record'],id:'inpatient.record.submit',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/record/submit',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientRecordSubmitInputSchema.parse(raw);return {input}}},input:inpatientRecordSubmitInputSchema,output:inpatientRecordResponseSchema,
    mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['inpatient-doctor'],summary:'主管医生显式确认本次实际主操作并提交首页修订',version:1 },
  { cliPath:['inpatient','review-record'],id:'inpatient.record.review',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/record/review',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientRecordReviewInputSchema.parse(raw);return {input}}},input:inpatientRecordReviewInputSchema,output:inpatientRecordResponseSchema,
    mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['medical-records'],summary:'编码人员核验固定临床编码与当前来源，审核通过或退回',version:1 },
  { cliPath:['inpatient','archive-record'],id:'inpatient.record.archive',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/record/archive',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientRecordArchiveInputSchema.parse(raw);return {input}}},input:inpatientRecordArchiveInputSchema,output:inpatientRecordResponseSchema,
    mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['medical-records'],summary:'核当前审核、清床结算及完整来源后冻结归档',version:1 },
  { cliPath:['inpatient','drg-pregroup'],id:'inpatient.drg.pregroup',http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/pregroup'},input:z.object({admissionId:z.string().min(1)}).strict(),output:inpatientDrgPregroupResultSchema,
    mode:'query',requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['inpatient-doctor','ward-nurse','medical-records','medical-insurance'],summary:'临床岗位未归档读取当前事实（修订可为0）；医保办仅可读归档冻结分组与支付预估，旧归档不回填',version:4 },
  { cliPath:['inpatient','drg-simulate'],id:'inpatient.drg.simulate',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/simulation',encodeBody:raw=>{const {admissionId:_id,draft}=inpatientDrgSimulationRequestSchema.parse(raw);return {input:draft}}},input:inpatientDrgSimulationRequestSchema,output:inpatientDrgSimulationSchema,
    mode:'preview',requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['inpatient-doctor','medical-records'],summary:'处方推演对照正式收费与承诺，可选择计划主操作；附依赖指纹、双口径分组与合成支付参考',version:3 },
  { cliPath:['inpatient','drg-reservations'],id:'inpatient.drg.reservation.read',http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/reservations'},input:z.object({admissionId:z.string().min(1)}).strict(),output:inpatientMaterialReservationListSchema,
    mode:'query',requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['inpatient-doctor','ward-nurse','medical-records'],summary:'读取治疗材料预留及替换释放历史',version:1 },
  { cliPath:['inpatient','drg-reserve-material'],id:'inpatient.drg.reservation.create',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/reservations',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientMaterialReservationCreateInputSchema.parse(raw);return {input}}},input:inpatientMaterialReservationCreateInputSchema,output:commandResponseSchema(inpatientMaterialReservationListSchema),
    mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['inpatient-doctor'],summary:'为计划手术预留材料，绑定目录版本与原因，不改变临床事实',version:2 },
  { cliPath:['inpatient','drg-release-reservation'],id:'inpatient.drg.reservation.release',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/reservations/:reservationId/release',encodeBody:raw=>{const {admissionId:_id,reservationId:_rid,...input}=inpatientMaterialReservationReleaseInputSchema.parse(raw);return {input}}},input:inpatientMaterialReservationReleaseInputSchema,output:commandResponseSchema(inpatientMaterialReservationListSchema),
    mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['inpatient-doctor'],summary:'释放预留中的材料，仅预留态可释放',version:2 },
  { cliPath:['inpatient','drg-payer-review-preview'],id:'inpatient.drg.payer.review.preview',http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/payer-review-preview'},input:z.object({admissionId:z.string().min(1)}).strict(),output:inpatientDrgPayerReviewPreviewSchema,
    mode:'preview',requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['medical-insurance','medical-records'],summary:'预览冻结病例来源、合成核定与原预估及收费的两项差额，指纹绑定病例、规则及参数版本',version:2 },
  { cliPath:['inpatient','drg-payer-review'],id:'inpatient.drg.payer.review',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/payer-review',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientDrgPayerReviewCreateInputSchema.parse(raw);return {input}}},input:inpatientDrgPayerReviewCreateInputSchema,output:commandResponseSchema(inpatientDrgPayerReviewListSchema),
    mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['medical-insurance'],summary:'医保办审阅预览后按expectedFingerprint核定，记录原预估对账；过期预览要求重新审阅',version:4 },
  { cliPath:['inpatient','drg-payer-reviews'],id:'inpatient.drg.payer.reviews',http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/payer-reviews'},input:z.object({admissionId:z.string().min(1)}).strict(),output:inpatientDrgPayerReviewListSchema,
    mode:'query',requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['medical-insurance','medical-records'],summary:'回查核定依据、原归档预估及两项差额；历史无预估时明确缺失',version:2 },
  { cliPath: ['inpatient','discharge-events'], id: 'inpatient.discharge.read', http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge' }, input: z.object({ admissionId: z.string().min(1) }).strict(), output: inpatientDischargeEventsSchema,
    mode: 'query', requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['inpatient-doctor','ward-nurse','medical-records'], summary: '读取出院、实际出区、召回及清床事件', version: 1 },
  { cliPath: ['inpatient','settlement-preview'], id: 'inpatient.discharge.preview', http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/preview' }, input: z.object({ admissionId: z.string().min(1) }).strict(), output: inpatientSettlementPreviewSchema,
    mode: 'query', requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['cashier'], summary: '一致读取逐项账与原预交金，冻结结算指纹及补退金额', version: 1 },
  { cliPath: ['inpatient','payments'], id: 'inpatient.payment.read', http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/payments' }, input: z.object({ admissionId: z.string().min(1) }).strict(), output: inpatientPaymentsSchema,
    mode: 'query', requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['cashier'], summary: '读取首次结算收退款、原款余额和未知结果', version: 1 },
  { cliPath: ['inpatient','preview-payment'], id: 'inpatient.payment.preview', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/payments/preview', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPaymentInputSchema.parse(raw); return { input } } },
    input: inpatientPaymentInputSchema, output: inpatientPaymentPreviewResponseSchema, mode: 'preview', requirements: { expectedVersions: false, idempotency: 'required' }, risk: 'write', roles: ['cashier'], summary: '冻结当前明细、组合方式和金额，预览预交金或补缴', version: 1 },
  { cliPath: ['inpatient','confirm-payment'], id: 'inpatient.payment.confirm', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/payments/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPaymentConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientPaymentConfirmInputSchema, output: inpatientPaymentResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'], summary: '确认已审阅预览，仅成功预交金投影入原账', version: 2 },
  { cliPath: ['inpatient','recover-payment'], id: 'inpatient.payment.recover', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/payments/recover', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPaymentRecoverInputSchema.parse(raw); return { input } } },
    input: inpatientPaymentRecoverInputSchema, output: inpatientPaymentResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'], summary: '按原尝试与版本查询未知收款，追加唯一结果', version: 2 },
  { cliPath: ['inpatient','preview-refund'], id: 'inpatient.refund.preview', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/refunds/preview', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientRefundInputSchema.parse(raw); return { input } } },
    input: inpatientRefundInputSchema, output: inpatientRefundPreviewResponseSchema, mode: 'preview', requirements: { expectedVersions: false, idempotency: 'required' }, risk: 'write', roles: ['cashier'], summary: '按本次住院原款与应退差额预览退款，单笔上限1000万元，超额须分次办理', version: 1 },
  { cliPath: ['inpatient','confirm-refund'], id: 'inpatient.refund.confirm', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/refunds/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientRefundConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientRefundConfirmInputSchema, output: refundResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'], summary: '确认已审阅退款，沿原方式分配并保留未知占用', version: 2 },
  { cliPath: ['inpatient','recover-refund'], id: 'inpatient.refund.recover', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/refunds/recover', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientRefundRecoverInputSchema.parse(raw); return { input } } },
    input: inpatientRefundRecoverInputSchema, output: refundResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'], summary: '按原退款和版本查询结果，不重复发起退款', version: 2 },
  { cliPath: ['inpatient','issue-discharge'], id: 'inpatient.discharge.issue', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/issue', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDischargeInputSchema.parse(raw); return { input } } },
    input: inpatientDischargeInputSchema, output: inpatientDischargeResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['inpatient-doctor'], summary: '开出院医嘱进入待出院，保留床位与未结算状态', version: 1 },
  { cliPath: ['inpatient','depart'], id: 'inpatient.discharge.depart', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/depart', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDepartInputSchema.parse(raw); return { input } } },
    input: inpatientDepartInputSchema, output: inpatientDischargeResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['ward-nurse'], summary: '护士核对停嘱与在途事项后记录实际出区和离院方式', version: 1 },
  { cliPath: ['inpatient','recall'], id: 'inpatient.discharge.recall', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/recall', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDischargeInputSchema.parse(raw); return { input } } },
    input: inpatientDischargeInputSchema, output: inpatientDischargeResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['inpatient-doctor'], summary: '在已出区未结算且原床保留窗口追加召回逆向事件', version: 1 },
  { cliPath: ['inpatient','clear-bed'], id: 'inpatient.discharge.clear', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/clear', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDischargeInputSchema.parse(raw); return { input } } },
    input: inpatientDischargeInputSchema, output: inpatientDischargeResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['ward-nurse'], summary: '结算后清床并释放床位', version: 1 },
  { cliPath: ['inpatient','settle'], id: 'inpatient.discharge.settle', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/settle', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSettleInputSchema.parse(raw); return { input } } },
    input: inpatientSettleInputSchema, output: inpatientSettlementResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'high-risk-write', roles: ['cashier'], summary: '事务核对原预览逐项指纹与金额，多退少补并封账', version: 2 },
  { cliPath: ['inpatient','surgery-catalog'], id: 'inpatient.surgery.catalog', http: { method: 'GET', path: '/api/his/v1/inpatient/surgery-catalog' }, input: emptyInputSchema, output: inpatientSurgeryCatalogSchema,
    mode: 'query', requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['inpatient-doctor','ward-nurse'], summary: '读取固定手术分类与完整耗材来源；unit-unconfirmed项保留参考价格但不可计费', version: 2 },
  { cliPath: ['inpatient','surgeries'], id: 'inpatient.surgery.read', http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries' }, input: z.object({ admissionId: z.string().min(1) }).strict(), output: inpatientSurgerySchema,
    mode: 'query', requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['inpatient-doctor','ward-nurse','medical-records'], summary: '分别读取计划、术前确认与本次实际实施事实', version: 1 },
  { cliPath: ['inpatient','request-surgery'], id: 'inpatient.surgery.request', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/request', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryRequestInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryRequestInputSchema, output: inpatientSurgeryResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['inpatient-doctor'], summary: '申请手术；保存计划，不代表实际实施', version: 1 },
  { cliPath: ['inpatient','check-surgery-preop'], id: 'inpatient.surgery.check-preop', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/check-preop', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryActionInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryActionInputSchema, output: inpatientSurgeryResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['ward-nurse'], summary: '护士记录术前检查核对事实', version: 1 },
  { cliPath: ['inpatient','confirm-surgery-consent'], id: 'inpatient.surgery.confirm-consent', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/confirm-consent', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryActionInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryActionInputSchema, output: inpatientSurgeryResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['inpatient-doctor'], summary: '医生确认已签署知情同意书；不代替电子签名', version: 1 },
  { cliPath: ['inpatient','cancel-surgery'], id: 'inpatient.surgery.cancel', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/cancel', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryActionInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryActionInputSchema, output: inpatientSurgeryResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['inpatient-doctor'], summary: '取消未实施手术；保留申请与准备事实', version: 1 },
  { cliPath: ['inpatient','execute-surgery'], id: 'inpatient.surgery.execute', http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/execute', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryExecuteInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryExecuteInputSchema, output: inpatientSurgeryResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['inpatient-doctor'], summary: '按双准备门禁记录实际手术和耗材并原子计费', version: 1 },
  {
    cliPath:['inpatient','investigation-catalog'],id:'inpatient.investigation.catalog',http:{method:'GET',path:'/api/his/v1/inpatient/investigation-catalog'},input:emptyInputSchema,output:inpatientInvestigationCatalogSchema,mode:'query',
    requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['inpatient-doctor', 'ward-nurse'],summary:'读取本院已声明住院价格与执行触发的检查目录',version:1,
  },
  {
    cliPath:['inpatient','investigations'],id:'inpatient.investigation.read',http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations'},input:z.object({admissionId:z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)}).strict(),output:inpatientInvestigationsSchema,mode:'query',
    requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['inpatient-doctor', 'ward-nurse'],summary:'读取当前责任科室的住院检查与报告',version:1,
  },
  {
    cliPath:['inpatient','transfer-catalog'],id:'inpatient.transfer.catalog',http:{method:'GET',path:'/api/his/v1/inpatient/transfer-catalog'},input:emptyInputSchema,output:inpatientTransferCatalogSchema,mode:'query',
    requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['inpatient-doctor', 'ward-nurse'],summary:'读取转科目标病区与床位可用性，不含其他患者',version:1,
  },
  {
    cliPath:['inpatient','transfers'],id:'inpatient.transfer.read',http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/transfers'},input:z.object({admissionId:z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)}).strict(),output:inpatientTransfersSchema,mode:'query',
    requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['inpatient-doctor', 'ward-nurse'],summary:'读取本次住院转科历史',version:1,
  },
  {
    cliPath:['inpatient','incoming-transfers'],id:'inpatient.transfer.incoming',http:{method:'GET',path:'/api/his/v1/inpatient/transfers/incoming'},input:emptyInputSchema,output:inpatientIncomingTransfersSchema,mode:'query',
    requirements:{expectedVersions:false,idempotency:'none'},risk:'read',roles:['ward-nurse'],summary:'读取当前目标病区待接收转科，不放宽普通住院详情',version:1,
  },
  {
    cliPath:['inpatient','issue-investigation'],id:'inpatient.investigation.issue',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations/issue',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientInvestigationIssueInputSchema.parse(raw);return {input}}},
    input:inpatientInvestigationIssueInputSchema,output:inpatientInvestigationResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['inpatient-doctor'],summary:'开立住院检验或影像，固定来源与价目，等待护士送检',version:1,
  },
  {
    cliPath:['inpatient','send-investigation'],id:'inpatient.investigation.send',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations/send',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientInvestigationActionInputSchema.parse(raw);return {input}}},
    input:inpatientInvestigationActionInputSchema,output:inpatientInvestigationResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['ward-nurse'],summary:'护士校对送检后进入原LIS/RIS执行',version:1,
  },
  {
    cliPath:['inpatient','cancel-investigation'],id:'inpatient.investigation.cancel',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations/cancel',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientInvestigationActionInputSchema.parse(raw);return {input}}},
    input:inpatientInvestigationActionInputSchema,output:inpatientInvestigationResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['inpatient-doctor'],summary:'取消未送检或明确失败的住院检查',version:1,
  },
  {
    cliPath:['inpatient','retry-investigation'],id:'inpatient.investigation.retry',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations/retry',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientInvestigationActionInputSchema.parse(raw);return {input}}},
    input:inpatientInvestigationActionInputSchema,output:inpatientInvestigationResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['inpatient-doctor'],summary:'当前责任医生重试可恢复的失败检查',version:1,
  },
  {
    cliPath:['inpatient','acknowledge-investigation'],id:'inpatient.investigation.acknowledge',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations/acknowledge',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientInvestigationAcknowledgeInputSchema.parse(raw);return {input}}},
    input:inpatientInvestigationAcknowledgeInputSchema,output:inpatientInvestigationResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['inpatient-doctor'],summary:'当前责任医生确认当前正式报告，影像须当前可读',version:1,
  },
  {
    cliPath:['inpatient','request-transfer'],id:'inpatient.transfer.request',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/transfers/request',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientTransferRequestInputSchema.parse(raw);return {input}}},
    input:inpatientTransferRequestInputSchema,output:inpatientTransferResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['inpatient-doctor'],summary:'医生申请转往另一病区',version:1,
  },
  {
    cliPath:['inpatient','handover-transfer'],id:'inpatient.transfer.handover',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/transfers/handover',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientTransferActionInputSchema.parse(raw);return {input}}},
    input:inpatientTransferActionInputSchema,output:inpatientTransferResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['ward-nurse'],summary:'原病区护士核验停嘱、任务、送检及手术收口后交接',version:1,
  },
  {
    cliPath:['inpatient','receive-transfer'],id:'inpatient.transfer.receive',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/transfers/receive',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientTransferReceiveInputSchema.parse(raw);return {input}}},
    input:inpatientTransferReceiveInputSchema,output:inpatientTransferResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['ward-nurse'],summary:'目标护士重查任务与手术收口后接收，原子切换床位与责任科室',version:1,
  },
  {
    cliPath:['inpatient','cancel-transfer'],id:'inpatient.transfer.cancel',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/transfers/cancel',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientTransferActionInputSchema.parse(raw);return {input}}},
    input:inpatientTransferActionInputSchema,output:inpatientTransferResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['inpatient-doctor'],summary:'原责任医生取消尚未接收的转科任务',version:1,
  },
  {
    cliPath: ['inpatient', 'pharmacy-list'], id: 'inpatient.pharmacy.list',
    http: { method: 'GET', path: '/api/his/v1/inpatient/pharmacy/admissions' }, input: emptyInputSchema, output: inpatientPharmacyListSchema,
    mode: 'query', requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['pharmacist'], summary: '读取有药品医嘱的住院药房清单，不含费用与诊断', version: 1,
  },
  {
    cliPath: ['inpatient', 'pharmacy-read'], id: 'inpatient.pharmacy.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/pharmacy' }, input: z.object({ admissionId: z.string().min(1) }).strict(), output: inpatientPharmacySchema,
    mode: 'query', requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['pharmacist'], summary: '读取本次住院药嘱、发药任务、批次与有效药物过敏风险', version: 1,
  },
  {
    cliPath: ['inpatient', 'charges'], id: 'inpatient.charges.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/charges' }, input: z.object({ admissionId: z.string().min(1) }).strict(), output: inpatientChargesSchema,
    mode: 'query', requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['cashier'], summary: '读取逐项住院账目、净额与财务状态', version: 1,
  },
  {
    cliPath: ['inpatient', 'pci-data'], id: 'inpatient.pci-data.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/pci-data' }, input: emptyInputSchema,
    output: inpatientPciDataSchema, mode: 'query', requirements: { expectedVersions: false, idempotency: 'none' },
    risk: 'read', roles: ['administrator', 'inpatient-doctor'], summary: '读取固定版本 PCI 合成底稿、来源、院内补充和已安装资料，不创建就诊', version: 1,
  },
  {
    cliPath: ['inpatient', 'prepare-pci-data'], id: 'inpatient.pci-data.prepare',
    http: { method: 'POST', path: '/api/his/v1/inpatient/pci-data/prepare', encodeBody: raw => ({ input: inpatientPciDataPrepareRequestSchema.shape.input.parse(raw) }) },
    input: inpatientPciDataPrepareRequestSchema.shape.input, output: inpatientPciDataResponseSchema, mode: 'command',
    requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['administrator'],
    summary: '在当前场景幂等准备 PCI 目录与库存基础数据，保留原配置和业务；不创建患者就诊或临床费用', version: 1,
  },
  {
    cliPath: ['admin', 'pci-case', 'prepare'], id: 'admin.pci-case.prepare',
    http: { method: 'POST', path: '/api/sim/v1/synthetic-cases/pci/prepare', encodeBody: raw => ({ input: pciCaseSourcePrepareRequestSchema.shape.input.parse(raw) }) },
    input: pciCaseSourcePrepareRequestSchema.shape.input, output: pciCaseSourceResponseSchema, mode: 'command',
    requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['administrator'],
    summary: '幂等建立固定 PCI 作者来源与隔离 Case Truth；不启动就诊、执行手术或产生费用', version: 1,
  },
  {
    cliPath: ['registration', 'synthetic-case', 'start-inpatient'], id: 'registration.synthetic-case.start-inpatient',
    http: { method: 'POST', path: '/api/his/v1/synthetic-cases/:caseId/actions/start-inpatient-visit',
      encodeBody: raw => { const { caseId: _caseId, ...input } = startSyntheticInpatientCaseRequestSchema.extend({ caseId: z.string().min(1) }).parse(raw); return input } },
    input: startSyntheticInpatientCaseRequestSchema.extend({ caseId: z.string().min(1) }), output: startSyntheticInpatientCaseResponseSchema, mode: 'command',
    requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['registrar'],
    summary: '从已有选中 Persona 的合成病例直接登记住院；无门诊挂号、排队、收费，后续由病区接诊', version: 1,
  },
  {
    cliPath: ['inpatient', 'catalog-search'], id: 'inpatient.catalog.search',
    http: { method: 'GET', path: '/api/his/v1/inpatient/catalog-search' },
    input: inpatientCatalogSearchInputSchema, output: inpatientCatalogSearchSchema, mode: 'query',
    requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['inpatient-doctor'],
    summary: '按院内或参考来源分页检索住院药品及检验候选，返回具体缺项，仅完整映射提供可开立身份', version: 1,
  },
  {
    cliPath: ['inpatient', 'clinical-catalog'], id: 'inpatient.clinical.catalog',
    http: { method: 'GET', path: '/api/his/v1/inpatient/clinical-catalog' }, input: emptyInputSchema, output: inpatientFullCatalogSchema, mode: 'query',
    requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['inpatient-doctor','ward-nurse'], summary: '读取住院实际可用临床目录', version: 1,
  },
  {
    cliPath: ['inpatient', 'clinical'], id: 'inpatient.clinical.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/clinical' }, input: z.object({ admissionId: z.string().min(1) }).strict(), output: inpatientFullClinicalSchema, mode: 'query',
    requirements: { expectedVersions: false, idempotency: 'none' }, risk: 'read', roles: ['inpatient-doctor','ward-nurse','medical-records'], summary: '读取本次住院诊断医嘱执行及费用', version: 1,
  },
  {
    cliPath: ['inpatient', 'confirm-diagnosis'], id: 'inpatient.diagnosis.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/diagnoses/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDiagnosisConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientDiagnosisConfirmInputSchema, output: inpatientFullClinicalResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['inpatient-doctor'], summary: '确认本次住院主次诊断并生成正式Condition', version: 1,
  },
  {
    cliPath: ['inpatient', 'issue-order'], id: 'inpatient.order.issue',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/orders/issue', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientOrderIssueInputSchema.parse(raw); return { input } } },
    input: inpatientOrderIssueInputSchema, output: inpatientFullClinicalResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['inpatient-doctor'], summary: '签发住院医嘱；按明确单位换算并重验有界剂量、责任、版本及可选 DRG 审阅指纹', version: 4,
  },
  {
    cliPath: ['inpatient', 'verify-order'], id: 'inpatient.order.verify',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/orders/verify', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientOrderActionInputSchema.parse(raw); return { input } } },
    input: inpatientOrderActionInputSchema, output: inpatientFullClinicalResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['ward-nurse'], summary: '住院医嘱verify；校验当前责任与版本', version: 1,
  },
  {
    cliPath: ['inpatient', 'request-stop-order'], id: 'inpatient.order.request-stop',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/orders/request-stop', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientOrderReasonInputSchema.parse(raw); return { input } } },
    input: inpatientOrderReasonInputSchema, output: inpatientFullClinicalResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['inpatient-doctor'], summary: '住院医嘱request-stop；校验当前责任与版本', version: 1,
  },
  {
    cliPath: ['inpatient', 'verify-stop-order'], id: 'inpatient.order.verify-stop',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/orders/verify-stop', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientOrderActionInputSchema.parse(raw); return { input } } },
    input: inpatientOrderActionInputSchema, output: inpatientFullClinicalResponseSchema, mode: 'command', requirements: { expectedVersions: true, idempotency: 'required' }, risk: 'write', roles: ['ward-nurse'], summary: '住院医嘱verify-stop；校验当前责任与版本', version: 1,
  },
  { cliPath:['inpatient','dispense'],id:'inpatient.execution.dispense',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/executions/dispense',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientDispenseInputSchema.parse(raw);return {input}}},
    input:inpatientDispenseInputSchema,output:inpatientPharmacyResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['pharmacist'],summary:'住院实际dispense；按执行单校验版本与责任',version:1 },
  { cliPath:['inpatient','administer'],id:'inpatient.execution.administer',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/executions/administer',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientExecutionActionInputSchema.parse(raw);return {input}}},
    input:inpatientExecutionActionInputSchema,output:inpatientFullClinicalResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['ward-nurse'],summary:'住院实际administer；按执行单校验版本与责任',version:1 },
  { cliPath:['inpatient','complete-service'],id:'inpatient.execution.complete',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/executions/complete',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientExecutionActionInputSchema.parse(raw);return {input}}},
    input:inpatientExecutionActionInputSchema,output:inpatientFullClinicalResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['ward-nurse'],summary:'完成已校对的健康教育服务执行并按声明计费；不执行检查检验',version:1 },
  { cliPath:['inpatient','reverse-charge'],id:'inpatient.charge.reverse',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/charges/reverse',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientChargeReverseInputSchema.parse(raw);return {input}}},
    input:inpatientChargeReverseInputSchema,output:inpatientChargesResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['cashier'],summary:'关联原费用全额冲正；原账保留，不接受任意金额',version:1 },
  { cliPath:['inpatient','request-prn'],id:'inpatient.execution.request-prn',http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/executions/request-prn',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientOrderReasonInputSchema.parse(raw);return {input}}},
    input:inpatientOrderReasonInputSchema,output:inpatientFullClinicalResponseSchema,mode:'command',requirements:{expectedVersions:true,idempotency:'required'},risk:'write',roles:['ward-nurse'],summary:'护士按已校对PRN医嘱和显式理由请求本次执行任务',version:1 },
  {
    cliPath: ['inpatient', 'catalog'], id: 'inpatient.catalog',
    http: { method: 'GET', path: '/api/his/v1/inpatient/catalog' },
    input: emptyInputSchema, output: inpatientCatalogSchema, mode: 'query',
    requirements: { expectedVersions: false, idempotency: 'none' },
    risk: 'read', roles: ['registrar', 'inpatient-doctor', 'ward-nurse', 'medical-records', 'cashier', 'outpatient-doctor'], summary: '读取病区、床位及当前占用；新入院选择 acceptingAdmissions=true 的默认住院病区', version: 3,
  },
  {
    cliPath: ['inpatient', 'list'], id: 'inpatient.admission.list',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions' },
    input: emptyInputSchema, output: inpatientListSchema, mode: 'query',
    requirements: { expectedVersions: false, idempotency: 'none' },
    risk: 'read', roles: ['registrar', 'inpatient-doctor', 'ward-nurse', 'medical-records', 'cashier'], summary: '读取岗位负责的住院清单', version: 2,
  },
  {
    cliPath: ['inpatient', 'read'], id: 'inpatient.admission.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId' },
    input: z.object({ admissionId: z.string().min(1) }).strict(), output: inpatientDetailSchema, mode: 'query',
    requirements: { expectedVersions: false, idempotency: 'none' },
    risk: 'read', roles: ['registrar', 'inpatient-doctor', 'ward-nurse', 'medical-records', 'cashier'], summary: '读取本次住院状态、床位与费用账户', version: 2,
  },
  {
    cliPath: ['inpatient', 'register'], id: 'inpatient.admission.register',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions', encodeBody: raw => ({ input: inpatientRegistrationInputSchema.parse(raw) }) },
    input: inpatientRegistrationInputSchema, output: inpatientCommandResponseSchema, mode: 'command',
    requirements: { expectedVersions: true, idempotency: 'required' },
    risk: 'write', roles: ['registrar'], summary: '默认住院病区登记并收取整数分预交金；已签发住院证可按原目标转收，恢复沿用原输入和幂等键', version: 3,
  },
  {
    cliPath: ['inpatient', 'receive'], id: 'inpatient.admission.receive',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/receive', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientBedInputSchema.parse(raw); return { input } } },
    input: inpatientBedInputSchema, output: inpatientCommandResponseSchema, mode: 'command',
    requirements: { expectedVersions: true, idempotency: 'required' },
    risk: 'write', roles: ['ward-nurse'], summary: '病区护士接诊并分配空床；版本或床位冲突时先刷新', version: 1,
  },
  {
    cliPath: ['inpatient', 'move-bed'], id: 'inpatient.admission.move-bed',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/move-bed', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientBedInputSchema.parse(raw); return { input } } },
    input: inpatientBedInputSchema, output: inpatientCommandResponseSchema, mode: 'command',
    requirements: { expectedVersions: true, idempotency: 'required' },
    risk: 'write', roles: ['ward-nurse'], summary: '病区护士在同病区转至空床；保留原占用历史', version: 1,
  },
  {
    cliPath: ['inpatient', 'swap-bed'], id: 'inpatient.admission.swap-bed',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/swap-bed', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSwapInputSchema.parse(raw); return { input } } },
    input: inpatientSwapInputSchema, output: inpatientSwapResponseSchema, mode: 'command',
    requirements: { expectedVersions: true, idempotency: 'required' },
    risk: 'write', roles: ['ward-nurse'], summary: '病区护士互换同病区两次住院的床位；同时校验两侧版本', version: 1,
  },
  {
    cliPath: ['inpatient', 'referrals'], id: 'inpatient.referral.list',
    http: { method: 'GET', path: '/api/his/v1/inpatient/referrals' },
    input: emptyInputSchema, output: inpatientReferralListSchema, mode: 'query',
    requirements: { expectedVersions: false, idempotency: 'none' },
    risk: 'read', roles: ['registrar', 'outpatient-doctor'], summary: '登记员或负责门诊医生读取住院证', version: 1,
  },
  {
    cliPath: ['inpatient', 'refer'], id: 'inpatient.referral.issue',
    http: { method: 'POST', path: '/api/his/v1/inpatient/referrals', encodeBody: raw => ({ input: inpatientReferralInputSchema.parse(raw) }) },
    input: inpatientReferralInputSchema, output: inpatientReferralResponseSchema, mode: 'command',
    requirements: { expectedVersions: true, idempotency: 'required' },
    risk: 'write', roles: ['outpatient-doctor'], summary: '负责门诊医生向默认住院病区开住院证；病区不可用时重读目录，原输入与幂等键可恢复已完成操作', version: 2,
  },
] as const satisfies readonly HisOperationDeclaration[]

const commandOperationAliases: Readonly<Record<string, string>> = {
  [clinicalDocumentOperationIds.cancelSign]: `clinical-${'document'}.cancel-sign`,
  'admin.laboratory-services.publish': 'laboratory-service-publication.create',
  [clinicalDocumentOperationIds.draftSet]: clinicalDocumentOperationIds.saveDraft,
  'encounter.consultation-recording.control': 'consultation.recording.control',
  [clinicalDocumentOperationIds.previewSign]: clinicalDocumentOperationIds.storedPreviewSign,
  [clinicalDocumentOperationIds.sign]: clinicalDocumentOperationIds.storedSign,
  'encounter.consultation.ask': 'consultation.ask-question',
  'encounter.consultation.reply.retry': 'consultation.reply.retry',
  'encounter.diagnosis.confirm': 'encounter.confirm-diagnosis',
  'encounter.diagnosis.draft.set': 'encounter.save-diagnosis-draft',
  'encounter.imaging-request.draft.delete': 'imaging-request.delete-draft',
  'encounter.imaging-request.draft.set': 'imaging-request.save-draft',
  'encounter.imaging-request.issue': 'imaging-request.issue',
  'encounter.laboratory-request.draft.delete': 'laboratory-request.delete-draft',
  'encounter.laboratory-request.draft.set': 'laboratory-request.save-draft',
  'encounter.laboratory-request.issue': 'laboratory-request.issue',
  'encounter.pathology-request.draft.delete': 'pathology-request.delete-draft',
  'encounter.pathology-request.draft.set': 'pathology-request.save-draft',
  'encounter.pathology-request.issue': 'pathology-request.issue',
  'encounter.medication-conclusion.confirm-none': 'encounter.confirm-no-medication',
  'encounter.prescription.draft.delete': 'encounter.delete-prescription-draft',
  'encounter.prescription.draft.set': 'encounter.save-prescription-draft',
  'encounter.prescription.issue': 'encounter.issue-prescription',
  'patient.create': 'patient.create-synthetic',
  'registration.create': 'registration.register',
  'registration.synthetic-case.start': 'synthetic-case.start-outpatient-visit',
  'registration.synthetic-case.start-inpatient': 'synthetic-case.start-inpatient-visit',
  'admin.pci-case.prepare': 'synthetic-case.pci-source.prepare',
  'service.complete': 'hospital-service.complete',
  'service.order': 'hospital-service.order',
  'triage.record': 'encounter.record-triage',
}

const operationSkills: Readonly<Record<string, z.infer<typeof hisOperationSkillSchema>>> = {
  'doctor.document-quality.get': 'clinmesh-doctor',
  'doctor.document-quality.check': 'clinmesh-doctor',
  'doctor.document-quality.retain': 'clinmesh-doctor',
  'admin.laboratory-services.candidates.search': 'clinmesh-administrator',
  'admin.laboratory-services.job.get': 'clinmesh-administrator',
  'admin.laboratory-services.publish': 'clinmesh-administrator',
  'billing.case.get': 'clinmesh-billing',
  'billing.queue.list': 'clinmesh-billing',
  'catalog.clinical.read': 'clinmesh-doctor',
  'catalog.registration.read': 'clinmesh-registration',
  'catalog.services.search': 'clinmesh-doctor',
  [clinicalDocumentOperationIds.revise]: 'clinmesh-doctor',
  'command.receipt.get': 'clinmesh-shared',
  'doctor.case.get': 'clinmesh-doctor',
  'doctor.case.imaging-services.list': 'clinmesh-doctor',
  'doctor.case.laboratory-catalog.search': 'clinmesh-doctor',
  'doctor.case.pathology-services.list': 'clinmesh-doctor',
  'doctor.completed-cases.get': 'clinmesh-doctor',
  'doctor.completed-cases.list': 'clinmesh-doctor',
  'doctor.queue.list': 'clinmesh-doctor',
  [clinicalDocumentOperationIds.draftSet]: 'clinmesh-doctor',
  'encounter.consultation-recording.control': 'clinmesh-doctor',
  [clinicalDocumentOperationIds.previewSign]: 'clinmesh-doctor',
  [clinicalDocumentOperationIds.cancelSign]: 'clinmesh-doctor',
  [clinicalDocumentOperationIds.sign]: 'clinmesh-doctor',
  'encounter.complete': 'clinmesh-doctor',
  'encounter.completion.preview': 'clinmesh-doctor',
  'encounter.consultation.ask': 'clinmesh-doctor',
  'encounter.consultation.reply.retry': 'clinmesh-doctor',
  'encounter.diagnosis.confirm': 'clinmesh-doctor',
  'encounter.diagnosis.draft.set': 'clinmesh-doctor',
  'encounter.imaging-request.draft.delete': 'clinmesh-doctor',
  'encounter.imaging-request.draft.set': 'clinmesh-doctor',
  'encounter.imaging-request.issue': 'clinmesh-doctor',
  'encounter.pathology-request.draft.delete': 'clinmesh-doctor',
  'encounter.pathology-request.draft.set': 'clinmesh-doctor',
  'encounter.pathology-request.issue': 'clinmesh-doctor',
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
  'imaging-report.acknowledge': 'clinmesh-doctor',
  'imaging-report.correct': 'clinmesh-doctor',
  'imaging-request.cancel': 'clinmesh-doctor',
  'imaging-request.retry': 'clinmesh-doctor',
  'pathology-report.acknowledge': 'clinmesh-doctor',
  'pathology-report.correct': 'clinmesh-doctor',
  'pathology-request.cancel': 'clinmesh-doctor',
  'pathology-request.retry': 'clinmesh-doctor',
  'laboratory-report.acknowledge': 'clinmesh-doctor',
  'laboratory-report.correct': 'clinmesh-doctor',
  'laboratory-request.cancel': 'clinmesh-doctor',
  'laboratory-request.retry-generation': 'clinmesh-doctor',
  'patient.create': 'clinmesh-registration',
  'patient.search': 'clinmesh-registration',
  'insurance.get': 'clinmesh-billing',
  'insurance.preview': 'clinmesh-billing',
  'insurance.confirm': 'clinmesh-billing',
  'insurance.cancel': 'clinmesh-billing',
  'payment.confirm': 'clinmesh-billing',
  'payment.preview': 'clinmesh-billing',
  'payment.recover': 'clinmesh-billing',
  'billing.refunds.get': 'clinmesh-billing',
  'billing.charge.adjust': 'clinmesh-billing',
  'refund.preview': 'clinmesh-billing',
  'refund.confirm': 'clinmesh-billing',
  'refund.recover': 'clinmesh-billing',
  'pharmacy.queue.list': 'clinmesh-pharmacy',
  'prescription.dispense': 'clinmesh-pharmacy',
  'prescription.review': 'clinmesh-pharmacy',
  'prescription.withdraw': 'clinmesh-doctor',
  'reference.diagnoses.search': 'clinmesh-doctor',
  'reference.laboratory.search': 'clinmesh-doctor',
  'reference.medications.search': 'clinmesh-doctor',
  'registration.create': 'clinmesh-registration',
  'registration.list': 'clinmesh-registration',
  'registration.synthetic-case.list': 'clinmesh-registration',
  'registration.synthetic-case.start': 'clinmesh-registration',
  'registration.synthetic-case.start-inpatient': 'clinmesh-registration',
  'admin.pci-case.prepare': 'clinmesh-administrator',
  'service.complete': 'clinmesh-doctor',
  'service.order': 'clinmesh-doctor',
  'triage.queue.list': 'clinmesh-triage',
  'triage.record': 'clinmesh-triage',
}

function handlerOwnerFor(
  operation: HisOperationDeclaration,
): z.infer<typeof hisOperationHandlerOwnerSchema> {
  if (operation.id === 'admin.pci-case.prepare') return 'ScenarioDataService'
  if (operation.id.startsWith('inpatient.')) return 'InpatientService'
  if (operation.http.path === '/fhir/R5/metadata') return 'FhirCapabilities'
  if (operation.http.path.startsWith('/fhir/R5/')) return 'FhirRepository'
  if (operation.http.path.startsWith('/api/his/v1/reference-catalogs/')) {
    return 'ReferenceDataService'
  }
  if (operation.http.path.startsWith('/api/his/v1/admin/laboratory-services/')) {
    return 'LaboratoryServicePublisher'
  }
  if (operation.id.startsWith('insurance.')) return 'InsuranceService'
  if (operation.id.startsWith('registration.synthetic-case.')) return 'SyntheticCaseVisitService'
  return 'WorkflowService'
}

export const hisOperationCatalog: readonly HisOperationDefinition[] = operationDefinitions.map((operation) => {
  const commandOperation = operation.requirements.idempotency === 'required'
    ? commandOperationAliases[operation.id] ?? operation.id
    : undefined
  const skill = operation.id.startsWith('inpatient.') ? 'clinmesh-inpatient' : operationSkills[operation.id]
  if (skill === undefined) throw new Error(`HIS operation has no Agent Skill: ${operation.id}`)
  const metadata = {
    error: hisOperationErrorSchema,
    handlerOwner: handlerOwnerFor(operation),
    identities: hisOperationIdentitySchema.options,
    previewToken: operation.id === clinicalDocumentOperationIds.sign
      || operation.id === 'payment.confirm' || operation.id === 'insurance.confirm' || operation.id === 'refund.confirm'
      || operation.id === 'inpatient.financial.refund.confirm'
      || operation.id === 'inpatient.financial.payment.confirm'
      || operation.id === 'inpatient.payment.confirm' || operation.id === 'inpatient.refund.confirm'
      || operation.id === 'inpatient.financial.insurance.confirm'
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
    method: 'POST',
    path: '/api/his/v1/doctor/cases/:caseId/recommendations/:kind/actions/confirm',
    reason: '医生页面显式确认选中准备项目，复用正式领域内核并在单个受审计 Command 中校验资料；只接受医生 Session，不提供独立 CLI 或 Agent Grant 授权。',
  },
  {
    method: 'GET',
    path: '/api/his/v1/doctor/cases/:caseId/recording-events',
    reason: '医生页面加速 Query 刷新的有界等待通知；事实仍由 doctor.case.get 读取，不登记独立 CLI 或 Agent tool 操作。',
  },
  {
    method: 'GET',
    path: '/api/his/v1/doctor/cases/:caseId/recommendations/:kind',
    reason: '医生页面的诊疗建议状态与依据辅助读取，本期不登记独立 CLI 或 Agent tool 操作。',
  },
  {
    method: 'POST',
    path: '/api/his/v1/doctor/cases/:caseId/recommendations/:kind/actions/generate',
    reason: '医生页面辅助建议生成，本期不提供独立 CLI 或 Agent tool 授权，临床采纳与正式提交沿用既有操作。',
  },
  {
    method: 'POST',
    path: '/api/his/v1/doctor/cases/:caseId/recommendations/:kind/considerations/disposition',
    reason: '医生页面的待核实思路已核实与忽略处置，只接受医生 Session 且不改变临床事实；不提供独立 CLI 或 Agent tool 授权。',
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
  {
    method: 'GET',
    path: '/api/his/v1/imaging-studies/:studyId',
    reason: 'Viewer transport for the human workspace; Agent tools and the CLI do not read images in this phase',
  },
  {
    method: 'GET',
    path: '/api/his/v1/imaging-studies/:studyId/series/:seriesIndex/frames/:frameIndex/blocks/:blockIndex',
    reason: 'Binary pixel transport for the human viewer; Agent tools and the CLI do not read pixels in this phase',
  },
  {
    method: 'GET',
    path: '/api/his/v1/imaging-studies/:studyId/series/:seriesIndex/levels/:level/tiles/:column/:row',
    reason: 'Binary slide tile transport for the human viewer; Agent tools and the CLI do not read pixels in this phase',
  },
] as const satisfies readonly ExcludedHisRoute[]

const operationsById = new Map(hisOperationCatalog.map(operation => [operation.id, operation]))
export const hisOperationIdSchema = z.string().refine(
  id => operationsById.has(id),
  { message: 'Unknown HIS operation ID' },
)
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
