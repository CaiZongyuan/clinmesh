import {
  clinicalScoreBundleSchema,
  inpatientRiskAssessmentInputSchema,
  inpatientVitalSignsInputSchema,
  outpatientRiskAssessmentOperationInputSchema,
  outpatientRiskAssessmentResponseSchema,
} from './clinical-scores.ts'
import {
  guidelineTopicBundleSchema,
  inpatientGuidelineTopicsInputSchema,
  outpatientGuidelineTopicsInputSchema,
} from './guideline-topics.ts'
import { inpatientDrgRecordChecksSchema, inpatientDrgReviewSchema, inpatientDrgReviewResponseSchema, inpatientDrgReviewTodoActionInputSchema, inpatientDrgReviewHandoffInputSchema } from './inpatient-drg-review.ts'
import { inpatientDrgExplanationSchema, inpatientDrgExplainInputSchema, inpatientDrgExplanationResponseSchema } from './inpatient-drg-explanation.ts'
import { inpatientGuidelineAdviceListSchema, inpatientGuidelineAdviceReadQuerySchema, inpatientGuidelineAdviceRequestInputSchema, inpatientGuidelineAdviceResponseSchema } from './inpatient-guideline-advice.ts'
import { inpatientDrgAgentSchema, inpatientDrgAgentResponseSchema, inpatientDrgAgentConfirmInputSchema } from './inpatient-drg-agent.ts'
import { inpatientMaterialEstimatesSchema, inpatientMaterialEstimateResponseSchema, inpatientMaterialEstimateRequestInputSchema,
  inpatientMaterialEstimateSaveInputSchema, inpatientMaterialEstimateConfirmInputSchema } from './inpatient-material-estimate.ts'
import { inpatientPciSelectionSchema, inpatientPciSelectionConfirmInputSchema, inpatientPciSelectionResponseSchema, inpatientPciSelectionSaveInputSchema } from './inpatient-pci-selection.ts'
import { inpatientDrgFollowupSchema, inpatientDrgFollowupResponseSchema, inpatientDrgFollowupStartInputSchema, inpatientDrgFollowupStopInputSchema } from './inpatient-drg-followup.ts'
import { insuranceTargetSchema, insurancePlanCodeSchema, insurancePreviewResponseSchema, insuranceResponseSchema, insuranceStateSchema } from './insurance.ts'
import { inpatientFinancialInsuranceCancelInputSchema, inpatientFinancialInsurancePreviewInputSchema,
  inpatientFinancialInsuranceConfirmInputSchema } from './inpatient-finance.ts'
import { chargeAdjustmentInputSchema, chargeAdjustmentResponseSchema, refundCaseSchema, refundPreviewInputSchema, refundAllocationPreviewInputSchema, refundPreviewResponseSchema,
  refundConfirmInputSchema, refundRecoverInputSchema, refundResponseSchema } from './refunds.ts'
import { inpatientRecordSchema, inpatientRecordSubmitInputSchema, inpatientRecordReviewInputSchema, inpatientRecordArchiveInputSchema, inpatientRecordResponseSchema } from './inpatient-record.ts'
import { inpatientFinancialSchema, inpatientFinancialResponseSchema, inpatientFinancialAdjustmentInputSchema, inpatientFinancialRefundPreviewInputSchema, inpatientFinancialRefundPreviewResponseSchema, inpatientFinancialRefundConfirmInputSchema, inpatientFinancialRefundRecoverInputSchema, inpatientFinancialPaymentPreviewInputSchema } from './inpatient-finance.ts'
import { inpatientDischargeInputSchema, inpatientDepartInputSchema, inpatientSettleInputSchema, inpatientDischargeResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema, inpatientDischargeEventsSchema,
  inpatientPaymentsSchema, inpatientPaymentInputSchema, inpatientPaymentConfirmInputSchema, inpatientPaymentRecoverInputSchema, inpatientPaymentResponseSchema, inpatientPaymentPreviewResponseSchema,
  inpatientRefundInputSchema, inpatientRefundConfirmInputSchema, inpatientRefundRecoverInputSchema, inpatientRefundPreviewResponseSchema } from './inpatient-discharge.ts'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, inpatientSurgeryResponseSchema, inpatientSurgeryRequestInputSchema, inpatientSurgeryActionInputSchema, inpatientSurgeryExecuteInputSchema, inpatientSurgeryStartInputSchema, inpatientSurgeryRecordMaterialInputSchema, inpatientSurgerySupplementMaterialInputSchema, inpatientSurgeryCorrectMaterialInputSchema, inpatientSurgeryCompleteInputSchema, inpatientSurgeryCompletionReviewInputSchema, inpatientSurgeryCompletionPreviewSchema } from './inpatient-surgery.ts'
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
  inpatientMaterialReservationCreateInputSchema, inpatientMaterialReservationReleaseInputSchema, inpatientMaterialReservationBatchInputSchema } from './inpatient-drg-simulation.ts'
import { inpatientDrgPayerReviewListSchema, inpatientDrgPayerReviewCreateInputSchema, inpatientDrgPayerReviewPreviewSchema } from './inpatient-drg-payer.ts'
import { inpatientPciDataSchema, inpatientPciDataPrepareRequestSchema, inpatientPciDataResponseSchema, pciCaseSourcePrepareRequestSchema, pciCaseSourceResponseSchema, startSyntheticInpatientCaseRequestSchema, startSyntheticInpatientCaseResponseSchema } from './inpatient-pci-data.ts'
import { doctorCaseHistoryInputSchema, doctorCaseHistoryDetailInputSchema, doctorCaseHistorySchema, doctorCaseHistoryDetailSchema } from './doctor-history.ts'
import { z } from 'zod'

const inpatientDrgSimulationRequestSchema = z.object({ admissionId: z.string().min(1), draft: inpatientDrgSimulationInputSchema.optional() }).strict()
import {
  capabilityStatementSchema,
  fhirResourceSchema,
  isSupportedFhirSearchParameter,
  supportedFhirResourceTypeSchema,
} from './fhir.ts'
import {
  acknowledgeExaminationReportRequestSchema,
  acknowledgeExaminationReportResponseSchema,
  cancelExaminationRequestRequestSchema,
  deleteExaminationRequestDraftRequestSchema,
  issueExaminationRequestRequestSchema,
  retryExaminationRequestRequestSchema,
  saveExaminationRequestDraftRequestSchema,
  caseExaminationServiceCatalogSchema,
  examinationRequestActionResponseSchema,
  examinationRequestDraftResponseSchema,
  issueExaminationRequestResponseSchema,
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
  multiChargePaymentPreviewInputSchema,
  multiChargePaymentPreviewResponseSchema,
  multiChargePaymentConfirmInputSchema,
  multiChargePaymentRecoverInputSchema,
  multiChargePaymentResponseSchema,
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

export const clinicalDocumentOperationIds = {
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

const referenceMedicationCatalogSearchInputSchema = referenceCatalogSearchInputSchema.extend({
  query: z.string().trim().min(1).max(100).optional(),
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
  heightCm: z.number().finite().min(30).max(260).optional(),
  oxygenSaturationPct: z.number().min(0).max(100),
  pulseBpm: z.number().positive(),
  respirationBpm: z.number().positive(),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
  temperatureC: z.number(),
  weightKg: z.number().finite().min(1).max(400).optional(),
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

const saveExaminationRequestDraftOperationInputSchema = saveExaminationRequestDraftRequestSchema.shape.input
  .extend(encounterVersionInputShape).strict()

const deleteExaminationRequestDraftOperationInputSchema = deleteExaminationRequestDraftRequestSchema.shape.input
  .extend(encounterVersionInputShape).strict()

const issueExaminationRequestOperationInputSchema = issueExaminationRequestRequestSchema.shape.input
  .extend(encounterVersionInputShape).strict()

const cancelExaminationRequestOperationInputSchema = cancelExaminationRequestRequestSchema.shape.input.extend({
  requestId: z.string().min(1),
  serviceRequestId: z.string().min(1),
  serviceRequestVersion: z.string().regex(/^\d+$/),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
}).strict()

const retryExaminationRequestOperationInputSchema = retryExaminationRequestRequestSchema.shape.input.extend({
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
}).strict()

const acknowledgeExaminationReportOperationInputSchema = acknowledgeExaminationReportRequestSchema.shape.input
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
  category: z.enum(['laboratory', 'imaging', 'pathology', 'examination', 'medication']),
  status: z.enum(['ambiguous', 'declined', 'paid', 'pending']),
}).strict()

const billingCaseInputSchema = paginationInputSchema.extend({ caseId: z.string().min(1) }).strict()
const refundChargeVersionShape = { chargeVersion: z.number().int().positive() }
const chargeAdjustmentOperationInputSchema = chargeAdjustmentInputSchema.extend({ caseId: z.string().min(1), ...refundChargeVersionShape }).strict()
const refundPreviewOperationInputSchema = refundPreviewInputSchema.extend({ chargeItemId: z.string().min(1), ...refundChargeVersionShape }).strict()
export const refundAllocationPreviewOperationInputSchema = refundAllocationPreviewInputSchema.extend(refundChargeVersionShape).strict()
const refundConfirmOperationInputSchema = refundConfirmInputSchema.extend({ previewId: z.string().min(1), chargeItemId: z.string().min(1), ...refundChargeVersionShape }).strict()
const refundRecoverOperationInputSchema = refundRecoverInputSchema.extend({ refundId: z.string().min(1), chargeItemId: z.string().min(1), ...refundChargeVersionShape }).strict()

const paymentPreviewOperationInputSchema = z.object({
  caseId: z.string().min(1),
  category: z.enum(['laboratory', 'imaging', 'pathology', 'examination', 'medication']),
  chargeItemId: z.string().min(1),
  chargeVersion: z.number().int().positive(),
  simulatorRule: paymentSimulatorRuleSchema,
  tenders: paymentTendersSchema.optional(),
}).strict()

export const multiChargePaymentPreviewOperationInputSchema = multiChargePaymentPreviewInputSchema.omit({ chargeItemIds: true }).extend({
  charges: z.array(z.object({ chargeItemId: z.string().min(1), chargeVersion: z.number().int().positive() }).strict()).min(2).max(20)
    .refine(charges => new Set(charges.map(charge => charge.chargeItemId)).size === charges.length, 'Charge items must be unique'),
}).strict()

export const multiChargePaymentConfirmOperationInputSchema = multiChargePaymentConfirmInputSchema.extend({
  previewId: z.string().min(1), charges: multiChargePaymentPreviewOperationInputSchema.shape.charges,
}).strict()
export const multiChargePaymentRecoverOperationInputSchema = multiChargePaymentRecoverInputSchema.extend({
  paymentId: z.string().min(1), charges: multiChargePaymentPreviewOperationInputSchema.shape.charges,
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
  'encounter.risk-assessment.record': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = outpatientRiskAssessmentOperationInputSchema.parse(rawInput)
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
  'encounter.examination-request.draft.set': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = saveExaminationRequestDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.examination-request.draft.delete': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = deleteExaminationRequestDraftOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'encounter.examination-request.issue': (rawInput: unknown) => {
    const { encounterId, encounterVersion, ...input } = issueExaminationRequestOperationInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
  },
  'examination-request.cancel': (rawInput: unknown) => {
    const {
      requestId: _requestId,
      serviceRequestId,
      serviceRequestVersion,
      taskId,
      taskVersion,
      ...input
    } = cancelExaminationRequestOperationInputSchema.parse(rawInput)
    return commandBody({
      [`ServiceRequest/${serviceRequestId}`]: serviceRequestVersion,
      [`Task/${taskId}`]: taskVersion,
    }, input)
  },
  'examination-request.retry': (rawInput: unknown) => {
    const { requestId: _requestId, taskId, taskVersion, ...input }
      = retryExaminationRequestOperationInputSchema.parse(rawInput)
    return commandBody({ [`Task/${taskId}`]: taskVersion }, input)
  },
  'examination-report.acknowledge': (rawInput: unknown) => {
    const { diagnosticReportId, diagnosticReportVersion, requestId: _requestId, ...input }
      = acknowledgeExaminationReportOperationInputSchema.parse(rawInput)
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
  'payment.multi-charge.preview': (rawInput: unknown) => {
    const { charges, ...input } = multiChargePaymentPreviewOperationInputSchema.parse(rawInput)
    return commandBody(Object.fromEntries(charges.map(charge => [`ChargeItem/${charge.chargeItemId}`, String(charge.chargeVersion)])), {
      ...input, chargeItemIds: charges.map(charge => charge.chargeItemId),
    })
  },
  'payment.preview': (rawInput: unknown) => {
    const { chargeItemId, chargeVersion, ...input } = paymentPreviewOperationInputSchema.parse(rawInput)
    return commandBody({ [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, { ...input, chargeItemId })
  },
  'payment.confirm': (rawInput: unknown) => {
    const { chargeItemId, chargeVersion, commitToken } = paymentConfirmOperationInputSchema.parse(rawInput)
    return commandBody({ [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, { commitToken })
  },
  'payment.multi-charge.confirm': (rawInput: unknown) => {
    const { charges, commitToken } = multiChargePaymentConfirmOperationInputSchema.parse(rawInput)
    return commandBody(Object.fromEntries(charges.map(charge => [`ChargeItem/${charge.chargeItemId}`, String(charge.chargeVersion)])), { commitToken })
  },
  'payment.multi-charge.recover': (rawInput: unknown) => {
    const { charges, expectedPaymentVersion } = multiChargePaymentRecoverOperationInputSchema.parse(rawInput)
    return commandBody(Object.fromEntries(charges.map(charge => [`ChargeItem/${charge.chargeItemId}`, String(charge.chargeVersion)])), { expectedPaymentVersion })
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

export interface HisOperationRuntimeDefinition {
  http: {
    encodeBody?: (input: unknown) => unknown
    encodeQuery?: (input: unknown) => Record<string, string | string[]>
    method: 'DELETE' | 'GET' | 'POST' | 'PUT'
    path: string
  }
  id: string
  input: z.ZodType
  output: z.ZodType
}

const rawOperationRuntimeDefinitions = [
  {
    id: 'payment.multi-charge.confirm',
    http: { method: 'POST', path: '/api/his/v1/payments/:previewId/actions/confirm-multi-charge' },
    input: multiChargePaymentConfirmOperationInputSchema,
    output: multiChargePaymentResponseSchema,
  },
  {
    id: 'payment.multi-charge.recover',
    http: { method: 'POST', path: '/api/his/v1/payments/:paymentId/actions/recover-multi-charge' },
    input: multiChargePaymentRecoverOperationInputSchema,
    output: multiChargePaymentResponseSchema,
  },
  {
    id: 'payment.multi-charge.preview',
    http: { method: 'POST', path: '/api/his/v1/payments/actions/preview-multi-charge' },
    input: multiChargePaymentPreviewOperationInputSchema,
    output: multiChargePaymentPreviewResponseSchema,
  },
  {
    id: 'inpatient.financial.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments' },
    input: z.object({ admissionId: inpatientFinancialAdjustmentInputSchema.shape.admissionId }).strict(),
    output: inpatientFinancialSchema,
  },
  {
    id: 'inpatient.financial.adjust',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientFinancialAdjustmentInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialAdjustmentInputSchema,
    output: inpatientFinancialResponseSchema,
  },
  {
    id: 'inpatient.financial.refund.preview',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/refunds/preview', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientFinancialRefundPreviewInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialRefundPreviewInputSchema,
    output: inpatientFinancialRefundPreviewResponseSchema,
  },
  {
    id: 'inpatient.financial.refund.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/refunds/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientFinancialRefundConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialRefundConfirmInputSchema,
    output: refundResponseSchema,
  },
  {
    id: 'inpatient.financial.refund.recover',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/refunds/recover', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientFinancialRefundRecoverInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialRefundRecoverInputSchema,
    output: refundResponseSchema,
  },
  {
    id: 'inpatient.financial.payment.preview',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/payments/preview', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientFinancialPaymentPreviewInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialPaymentPreviewInputSchema,
    output: inpatientPaymentPreviewResponseSchema,
  },
  {
    id: 'inpatient.financial.payment.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/payments/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPaymentConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientPaymentConfirmInputSchema,
    output: inpatientPaymentResponseSchema,
  },
  {
    id: 'inpatient.financial.payment.recover',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/payments/recover', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPaymentRecoverInputSchema.parse(raw); return { input } } },
    input: inpatientPaymentRecoverInputSchema,
    output: inpatientPaymentResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/admin/laboratory-services/candidates',
    },
    id: 'admin.laboratory-services.candidates.search',
    input: laboratoryServiceCandidateSearchInputSchema,
    output: laboratoryServiceCandidateSearchSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/admin/laboratory-services/actions/publish',
    },
    id: 'admin.laboratory-services.publish',
    input: publishLaboratoryServicesOperationInputSchema,
    output: publishLaboratoryServicesResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/admin/laboratory-services/jobs/:jobId',
    },
    id: 'admin.laboratory-services.job.get',
    input: laboratoryServicePublicationJobInputSchema,
    output: laboratoryServicePublicationJobSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/reference-catalogs/diagnoses',
    },
    id: 'reference.diagnoses.search',
    input: referenceCatalogSearchInputSchema,
    output: referenceDiagnosisCatalogSearchSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/reference-catalogs/medications',
    },
    id: 'reference.medications.search',
    input: referenceMedicationCatalogSearchInputSchema,
    output: referenceMedicationCatalogSearchSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/reference-catalogs/laboratory',
    },
    id: 'reference.laboratory.search',
    input: referenceCatalogSearchInputSchema,
    output: referenceLaboratoryCatalogSearchSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/catalogs/registration',
    },
    id: 'catalog.registration.read',
    input: emptyInputSchema,
    output: registrationCatalogSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/catalogs/clinical',
    },
    id: 'catalog.clinical.read',
    input: emptyInputSchema,
    output: clinicalCatalogSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/catalogs/services',
    },
    id: 'catalog.services.search',
    input: serviceCatalogSearchInputSchema,
    output: serviceCatalogSearchSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/patients',
    },
    id: 'patient.search',
    input: patientSearchInputSchema,
    output: patientSearchSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/patients',
    },
    id: 'patient.create',
    input: patientCreateInputSchema,
    output: createPatientResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/registrations',
    },
    id: 'registration.list',
    input: paginationInputSchema,
    output: registrationQueueSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/registrations/actions/register',
    },
    id: 'registration.create',
    input: registrationCreateInputSchema,
    output: registrationResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/registration/synthetic-cases',
    },
    id: 'registration.synthetic-case.list',
    input: syntheticCaseRegistrationListInputSchema,
    output: syntheticCaseRegistrationListSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/synthetic-cases/:caseId/actions/start-outpatient-visit',
    },
    id: 'registration.synthetic-case.start',
    input: startSyntheticCaseOperationInputSchema,
    output: commandResponseSchema(startSyntheticCaseResultSchema),
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/triage/queue',
    },
    id: 'triage.queue.list',
    input: triageQueueInputSchema,
    output: triageQueueSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/actions/record-triage',
    },
    id: 'triage.record',
    input: triageRecordInputSchema,
    output: triageResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/queue',
    },
    id: 'doctor.queue.list',
    input: paginationInputSchema.extend({ view: doctorQueueViewSchema.optional() }),
    output: doctorQueueSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/doctor/cases/:caseId/history' },
    id: 'doctor.case.history.search',
    input: doctorCaseHistoryInputSchema.extend({ caseId: z.string().min(1) }).strict(),
    output: doctorCaseHistorySchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/doctor/cases/:caseId/history/detail' },
    id: 'doctor.case.history.read',
    input: doctorCaseHistoryDetailInputSchema.extend({ caseId: z.string().min(1) }).strict(),
    output: doctorCaseHistoryDetailSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/completed-cases',
    },
    id: 'doctor.completed-cases.list',
    input: doctorCompletedCasesInputSchema,
    output: doctorCompletedCaseListSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/completed-cases/:caseId',
    },
    id: 'doctor.completed-cases.get',
    input: caseIdInputSchema,
    output: doctorCompletedCaseDetailSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/cases/:caseId',
    },
    id: 'doctor.case.get',
    input: caseIdInputSchema,
    output: doctorCaseDetailSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/doctor/cases/:caseId/clinical-scores' },
    id: 'doctor.case.clinical-scores.read',
    input: caseIdInputSchema,
    output: clinicalScoreBundleSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/doctor/cases/:caseId/guideline-topics' },
    id: 'doctor.case.guideline-topics.read',
    input: outpatientGuidelineTopicsInputSchema,
    output: guidelineTopicBundleSchema,
  },
  {
    http: { method: 'PUT', path: '/api/his/v1/encounters/:encounterId/risk-assessment' },
    id: 'encounter.risk-assessment.record',
    input: outpatientRiskAssessmentOperationInputSchema,
    output: outpatientRiskAssessmentResponseSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/doctor/cases/:caseId/document-quality-control' },
    id: 'doctor.document-quality.get',
    input: caseIdInputSchema.extend({ clientId: z.string().min(1).max(128).optional() }),
    output: clinicalDocumentQualityControlStateSchema,
  },
  {
    http: { method: 'POST', path: '/api/his/v1/doctor/cases/:caseId/document-quality-control/actions/check' },
    id: 'doctor.document-quality.check',
    input: documentQualityCheckInputSchema,
    output: clinicalDocumentQualityControlResponseSchema,
  },
  {
    http: { method: 'POST', path: '/api/his/v1/doctor/cases/:caseId/document-quality-control/actions/retain' },
    id: 'doctor.document-quality.retain',
    input: documentQualityRetainInputSchema,
    output: clinicalDocumentQualityControlResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/cases/:caseId/reference-catalogs/laboratory',
    },
    id: 'doctor.case.laboratory-catalog.search',
    input: caseLaboratoryCatalogSearchInputSchema,
    output: caseLaboratoryCatalogSearchSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/actions/ask-consultation-question',
    },
    id: 'encounter.consultation.ask',
    input: consultationMessageInputSchema,
    output: sendConsultationMessageResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/actions/retry-consultation-reply',
    },
    id: 'encounter.consultation.reply.retry',
    input: consultationRetryInputSchema,
    output: retryConsultationReplyResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/encounters/:encounterId/completion',
    },
    id: 'encounter.completion.preview',
    input: encounterIdInputSchema,
    output: encounterCompletionPreviewSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/actions/complete',
    },
    id: 'encounter.complete',
    input: completeEncounterInputSchema,
    output: encounterCompletionResponseSchema,
  },
  {
    http: {
      encodeBody: encodeSaveDiagnosisDraftBody,
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/diagnosis/draft',
    },
    id: 'encounter.diagnosis.draft.set',
    input: saveDiagnosisDraftOperationInputSchema,
    output: diagnosisDraftResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/diagnosis/actions/confirm',
    },
    id: 'encounter.diagnosis.confirm',
    input: confirmDiagnosisOperationInputSchema,
    output: confirmDiagnosisResponseSchema,
  },
  {
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/prescription/draft',
    },
    id: 'encounter.prescription.draft.set',
    input: savePrescriptionDraftOperationInputSchema,
    output: prescriptionDraftResponseSchema,
  },
  {
    http: {
      method: 'DELETE',
      path: '/api/his/v1/encounters/:encounterId/prescription/draft',
    },
    id: 'encounter.prescription.draft.delete',
    input: deletePrescriptionDraftOperationInputSchema,
    output: prescriptionDraftResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/prescription/actions/issue',
    },
    id: 'encounter.prescription.issue',
    input: issuePrescriptionOperationInputSchema,
    output: issuePrescriptionResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/medication-conclusion/actions/confirm-no-medication',
    },
    id: 'encounter.medication-conclusion.confirm-none',
    input: confirmNoMedicationOperationInputSchema,
    output: confirmNoMedicationResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/prescriptions/:prescriptionId/actions/withdraw',
    },
    id: 'prescription.withdraw',
    input: withdrawPrescriptionOperationInputSchema,
    output: withdrawPrescriptionResponseSchema,
  },
  {
    http: { method: 'POST', path: '/api/his/v1/encounters/:encounterId/consultation-recording/actions/control' },
    id: 'encounter.consultation-recording.control',
    input: controlConsultationRecordingOperationInputSchema,
    output: controlConsultationRecordingResponseSchema,
  },
  {
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/clinical-document/draft',
    },
    id: clinicalDocumentOperationIds.draftSet,
    input: saveClinicalDocumentDraftOperationInputSchema,
    output: clinicalDocumentDraftResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/clinical-document/actions/preview-sign',
    },
    id: clinicalDocumentOperationIds.previewSign,
    input: previewClinicalDocumentSignOperationInputSchema,
    output: clinicalDocumentSignPreviewResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/clinical-document/actions/sign',
    },
    id: clinicalDocumentOperationIds.sign,
    input: signClinicalDocumentOperationInputSchema,
    output: clinicalDocumentSignResponseSchema,
  },
  {
    http: { method: 'POST', path: '/api/his/v1/encounters/:encounterId/clinical-document/actions/cancel-sign' },
    id: clinicalDocumentOperationIds.cancelSign,
    input: cancelClinicalDocumentSignOperationInputSchema,
    output: cancelClinicalDocumentSignResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/clinical-documents/:compositionId/actions/revise',
    },
    id: clinicalDocumentOperationIds.revise,
    input: reviseClinicalDocumentOperationInputSchema,
    output: clinicalDocumentRevisionResponseSchema,
  },
  {
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/laboratory-request/draft',
    },
    id: 'encounter.laboratory-request.draft.set',
    input: saveLaboratoryRequestDraftOperationInputSchema,
    output: laboratoryRequestDraftResponseSchema,
  },
  {
    http: {
      method: 'DELETE',
      path: '/api/his/v1/encounters/:encounterId/laboratory-request/draft',
    },
    id: 'encounter.laboratory-request.draft.delete',
    input: deleteLaboratoryRequestDraftOperationInputSchema,
    output: laboratoryRequestDraftResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/laboratory-request/actions/issue',
    },
    id: 'encounter.laboratory-request.issue',
    input: issueLaboratoryRequestOperationInputSchema,
    output: issueLaboratoryRequestResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/laboratory-requests/:requestId/actions/cancel',
    },
    id: 'laboratory-request.cancel',
    input: cancelLaboratoryRequestOperationInputSchema,
    output: laboratoryRequestActionResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/laboratory-requests/:requestId/actions/retry-generation',
    },
    id: 'laboratory-request.retry-generation',
    input: retryLaboratoryResultGenerationOperationInputSchema,
    output: laboratoryRequestActionResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/laboratory-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
    },
    id: 'laboratory-report.acknowledge',
    input: acknowledgeLaboratoryReportOperationInputSchema,
    output: acknowledgeLaboratoryReportResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/laboratory-requests/:requestId/reports/:diagnosticReportId/actions/correct',
    },
    id: 'laboratory-report.correct',
    input: correctLaboratoryReportOperationInputSchema,
    output: correctLaboratoryReportResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/cases/:caseId/examination-services',
    },
    id: 'doctor.case.examination-services.list',
    input: caseIdInputSchema,
    output: caseExaminationServiceCatalogSchema,
  },
  {
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/examination-request/draft',
    },
    id: 'encounter.examination-request.draft.set',
    input: saveExaminationRequestDraftOperationInputSchema,
    output: examinationRequestDraftResponseSchema,
  },
  {
    http: {
      method: 'DELETE',
      path: '/api/his/v1/encounters/:encounterId/examination-request/draft',
    },
    id: 'encounter.examination-request.draft.delete',
    input: deleteExaminationRequestDraftOperationInputSchema,
    output: examinationRequestDraftResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/examination-request/actions/issue',
    },
    id: 'encounter.examination-request.issue',
    input: issueExaminationRequestOperationInputSchema,
    output: issueExaminationRequestResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/examination-requests/:requestId/actions/cancel',
    },
    id: 'examination-request.cancel',
    input: cancelExaminationRequestOperationInputSchema,
    output: examinationRequestActionResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/examination-requests/:requestId/actions/retry',
    },
    id: 'examination-request.retry',
    input: retryExaminationRequestOperationInputSchema,
    output: examinationRequestActionResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/examination-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
    },
    id: 'examination-report.acknowledge',
    input: acknowledgeExaminationReportOperationInputSchema,
    output: acknowledgeExaminationReportResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/cases/:caseId/imaging-services',
    },
    id: 'doctor.case.imaging-services.list',
    input: caseIdInputSchema,
    output: caseImagingServiceCatalogSchema,
  },
  {
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/imaging-request/draft',
    },
    id: 'encounter.imaging-request.draft.set',
    input: saveImagingRequestDraftOperationInputSchema,
    output: imagingRequestDraftResponseSchema,
  },
  {
    http: {
      method: 'DELETE',
      path: '/api/his/v1/encounters/:encounterId/imaging-request/draft',
    },
    id: 'encounter.imaging-request.draft.delete',
    input: deleteImagingRequestDraftOperationInputSchema,
    output: imagingRequestDraftResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/imaging-request/actions/issue',
    },
    id: 'encounter.imaging-request.issue',
    input: issueImagingRequestOperationInputSchema,
    output: issueImagingRequestResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/imaging-requests/:requestId/actions/cancel',
    },
    id: 'imaging-request.cancel',
    input: cancelImagingRequestOperationInputSchema,
    output: imagingRequestActionResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/imaging-requests/:requestId/actions/retry',
    },
    id: 'imaging-request.retry',
    input: retryImagingRequestOperationInputSchema,
    output: imagingRequestActionResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/imaging-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
    },
    id: 'imaging-report.acknowledge',
    input: acknowledgeImagingReportOperationInputSchema,
    output: acknowledgeImagingReportResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/imaging-requests/:requestId/reports/:diagnosticReportId/actions/correct',
    },
    id: 'imaging-report.correct',
    input: correctImagingReportOperationInputSchema,
    output: correctImagingReportResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/doctor/cases/:caseId/pathology-services',
    },
    id: 'doctor.case.pathology-services.list',
    input: caseIdInputSchema,
    output: casePathologyServiceCatalogSchema,
  },
  {
    http: {
      method: 'PUT',
      path: '/api/his/v1/encounters/:encounterId/pathology-request/draft',
    },
    id: 'encounter.pathology-request.draft.set',
    input: savePathologyRequestDraftOperationInputSchema,
    output: pathologyRequestDraftResponseSchema,
  },
  {
    http: {
      method: 'DELETE',
      path: '/api/his/v1/encounters/:encounterId/pathology-request/draft',
    },
    id: 'encounter.pathology-request.draft.delete',
    input: deletePathologyRequestDraftOperationInputSchema,
    output: pathologyRequestDraftResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/pathology-request/actions/issue',
    },
    id: 'encounter.pathology-request.issue',
    input: issuePathologyRequestOperationInputSchema,
    output: issuePathologyRequestResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/pathology-requests/:requestId/actions/cancel',
    },
    id: 'pathology-request.cancel',
    input: cancelPathologyRequestOperationInputSchema,
    output: pathologyRequestActionResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/pathology-requests/:requestId/actions/retry',
    },
    id: 'pathology-request.retry',
    input: retryPathologyRequestOperationInputSchema,
    output: pathologyRequestActionResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/pathology-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
    },
    id: 'pathology-report.acknowledge',
    input: acknowledgePathologyReportOperationInputSchema,
    output: acknowledgePathologyReportResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/pathology-requests/:requestId/reports/:diagnosticReportId/actions/correct',
    },
    id: 'pathology-report.correct',
    input: correctPathologyReportOperationInputSchema,
    output: correctPathologyReportResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/encounters/:encounterId/services/:serviceId/actions/order',
    },
    id: 'service.order',
    input: orderHospitalServiceOperationInputSchema,
    output: orderHospitalServiceResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/service-requests/:serviceRequestId/actions/complete',
    },
    id: 'service.complete',
    input: completeHospitalServiceOperationInputSchema,
    output: completeHospitalServiceResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/billing/queue',
    },
    id: 'billing.queue.list',
    input: billingQueueInputSchema,
    output: billingQueueSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/billing/cases/:caseId',
    },
    id: 'billing.case.get',
    input: billingCaseInputSchema,
    output: billingCaseSchema,
  },
  {
    id:'insurance.get',
    http:{method:'GET',path:'/api/his/v1/insurance/:kind/:id'},
    input:insuranceTargetSchema,
    output:insuranceStateSchema,
  },
  {
    id:'insurance.preview',
    http:{method:'POST',path:'/api/his/v1/insurance/:kind/:id/preview',encodeBody:raw=>{const {kind:_kind,id:_id,...input}=insuranceTargetSchema.extend({planCode:insurancePlanCodeSchema}).parse(raw);return {input,expectedVersions:{}}}},
    input:insuranceTargetSchema.extend({planCode:insurancePlanCodeSchema}),
    output:insurancePreviewResponseSchema,
  },
  {
    id:'insurance.confirm',
    http:{method:'POST',path:'/api/his/v1/insurance/:kind/:id/confirm',encodeBody:raw=>{const {kind:_kind,id:_id,...input}=insuranceTargetSchema.extend({previewId:z.string().min(1),commitToken:z.string().min(16).max(256)}).parse(raw);return {input,expectedVersions:{}}}},
    input:insuranceTargetSchema.extend({previewId:z.string().min(1),commitToken:z.string().min(16).max(256)}),
    output:insuranceResponseSchema,
  },
  {
    id:'insurance.cancel',
    http:{method:'POST',path:'/api/his/v1/insurance/:kind/:id/cancel',encodeBody:raw=>{const {kind:_kind,id:_id,...input}=insuranceTargetSchema.extend({settlementId:z.string().min(1),expectedBalanceVersion:z.number().int().nonnegative()}).parse(raw);return {input,expectedVersions:{}}}},
    input:insuranceTargetSchema.extend({settlementId:z.string().min(1),expectedBalanceVersion:z.number().int().nonnegative()}),
    output:insuranceResponseSchema,
  },
  {
    id: 'billing.refunds.get',
    http: { method: 'GET', path: '/api/his/v1/billing/cases/:caseId/refunds' },
    input: z.object({ caseId: z.string().min(1) }).strict(),
    output: refundCaseSchema,
  },
  {
    id: 'billing.charge.adjust',
    http: { method: 'POST', path: '/api/his/v1/billing/cases/:caseId/adjustments', encodeBody: raw => {
      const { caseId: _caseId, chargeVersion, ...input } = chargeAdjustmentOperationInputSchema.parse(raw)
      return { expectedVersions: { [`ChargeItem/${input.chargeItemId}`]: String(chargeVersion) }, input }
    } },
    input: chargeAdjustmentOperationInputSchema,
    output: chargeAdjustmentResponseSchema,
  },
  {
    id: 'refund.allocation.preview',
    http: { method: 'POST', path: '/api/his/v1/refunds/actions/preview-allocation', encodeBody: raw => {
      const { chargeVersion, ...input } = refundAllocationPreviewOperationInputSchema.parse(raw)
      return { expectedVersions: { [`ChargeItem/${input.chargeItemId}`]: String(chargeVersion) }, input }
    } },
    input: refundAllocationPreviewOperationInputSchema,
    output: refundPreviewResponseSchema,
  },
  {
    id: 'refund.preview',
    http: { method: 'POST', path: '/api/his/v1/refunds/actions/preview', encodeBody: raw => {
      const { chargeItemId, chargeVersion, ...input } = refundPreviewOperationInputSchema.parse(raw)
      return { expectedVersions: { [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, input }
    } },
    input: refundPreviewOperationInputSchema,
    output: refundPreviewResponseSchema,
  },
  {
    id: 'refund.confirm',
    http: { method: 'POST', path: '/api/his/v1/refunds/:previewId/actions/confirm', encodeBody: raw => {
      const { chargeItemId, chargeVersion, previewId: _previewId, ...input } = refundConfirmOperationInputSchema.parse(raw)
      return { expectedVersions: { [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, input }
    } },
    input: refundConfirmOperationInputSchema,
    output: refundResponseSchema,
  },
  {
    id: 'refund.recover',
    http: { method: 'POST', path: '/api/his/v1/refunds/:refundId/actions/recover', encodeBody: raw => {
      const { chargeItemId, chargeVersion, refundId: _refundId, ...input } = refundRecoverOperationInputSchema.parse(raw)
      return { expectedVersions: { [`ChargeItem/${chargeItemId}`]: String(chargeVersion) }, input }
    } },
    input: refundRecoverOperationInputSchema,
    output: refundResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/payments/actions/preview',
    },
    id: 'payment.preview',
    input: paymentPreviewOperationInputSchema,
    output: paymentPreviewResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/payments/:previewId/actions/confirm',
    },
    id: 'payment.confirm',
    input: paymentConfirmOperationInputSchema,
    output: paymentResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/payments/:paymentId/actions/recover',
    },
    id: 'payment.recover',
    input: paymentRecoverOperationInputSchema,
    output: paymentResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/pharmacy/queue',
    },
    id: 'pharmacy.queue.list',
    input: pharmacyQueueInputSchema,
    output: pharmacyQueueSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/prescriptions/:prescriptionId/actions/review',
    },
    id: 'prescription.review',
    input: prescriptionReviewOperationInputSchema,
    output: prescriptionReviewResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/prescriptions/:prescriptionId/actions/dispense',
    },
    id: 'prescription.dispense',
    input: prescriptionDispenseOperationInputSchema,
    output: dispenseResponseSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/command-receipts',
    },
    id: 'command.receipt.get',
    input: commandReceiptLookupInputSchema,
    output: commandReceiptLookupSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/fhir/R5/metadata',
    },
    id: 'fhir.metadata.read',
    input: emptyInputSchema,
    output: capabilityStatementSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/fhir/R5/:resourceType/:resourceId',
    },
    id: 'fhir.resource.read',
    input: fhirResourceInputSchema,
    output: fhirResourceSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/fhir/R5/:resourceType/:resourceId/_history/:versionId',
    },
    id: 'fhir.resource.vread',
    input: fhirVersionReadInputSchema,
    output: fhirResourceSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/fhir/R5/:resourceType/:resourceId/_history',
    },
    id: 'fhir.resource.history',
    input: fhirResourceInputSchema,
    output: fhirBundleSchema,
  },
  {
    http: {
      encodeQuery: encodeFhirSearchQuery,
      method: 'GET',
      path: '/fhir/R5/:resourceType',
    },
    id: 'fhir.resource.search',
    input: fhirSearchInputSchema,
    output: fhirBundleSchema,
  },
  {
    id: 'inpatient.financial.insurance.cancel',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/:adjustmentId/insurance/cancel',
      encodeBody: raw => { const { admissionId: _admission, adjustmentId: _adjustment, ...input } = inpatientFinancialInsuranceCancelInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialInsuranceCancelInputSchema,
    output: inpatientFinancialResponseSchema,
  },
  {
    id: 'inpatient.financial.insurance.preview',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/:adjustmentId/insurance/preview',
      encodeBody: raw => { const { admissionId: _admission, adjustmentId: _adjustment, ...input } = inpatientFinancialInsurancePreviewInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialInsurancePreviewInputSchema,
    output: insurancePreviewResponseSchema,
  },
  {
    id: 'inpatient.financial.insurance.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/:adjustmentId/insurance/confirm',
      encodeBody: raw => { const { admissionId: _admission, adjustmentId: _adjustment, ...input } = inpatientFinancialInsuranceConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientFinancialInsuranceConfirmInputSchema,
    output: inpatientFinancialResponseSchema,
  },
  {
    id:'inpatient.record.read',
    http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/record'},
    input:z.object({admissionId:z.string().min(1)}).strict(),
    output:inpatientRecordSchema,
  },
  {
    id:'inpatient.record.submit',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/record/submit',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientRecordSubmitInputSchema.parse(raw);return {input}}},
    input:inpatientRecordSubmitInputSchema,
    output:inpatientRecordResponseSchema,
  },
  {
    id:'inpatient.record.review',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/record/review',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientRecordReviewInputSchema.parse(raw);return {input}}},
    input:inpatientRecordReviewInputSchema,
    output:inpatientRecordResponseSchema,
  },
  {
    id:'inpatient.record.archive',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/record/archive',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientRecordArchiveInputSchema.parse(raw);return {input}}},
    input:inpatientRecordArchiveInputSchema,
    output:inpatientRecordResponseSchema,
  },
  {
    id: 'inpatient.guideline-advice.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/guideline-advice' },
    input: inpatientGuidelineAdviceReadQuerySchema,
    output: inpatientGuidelineAdviceListSchema,
  },
  {
    id: 'inpatient.guideline-topics.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/guideline-topics' },
    input: inpatientGuidelineTopicsInputSchema,
    output: guidelineTopicBundleSchema,
  },
  {
    id: 'inpatient.guideline-advice.request',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/guideline-advice/request',
      encodeBody: raw => { const { admissionId: _id, ...input } = inpatientGuidelineAdviceRequestInputSchema.parse(raw); return { input } } },
    input: inpatientGuidelineAdviceRequestInputSchema,
    output: inpatientGuidelineAdviceResponseSchema,
  },
  {
    id: 'inpatient.material-estimate.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/material-estimates' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientMaterialEstimatesSchema,
  },
  {
    id: 'inpatient.material-estimate.request',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/material-estimates/request',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientMaterialEstimateRequestInputSchema.parse(raw); return { input } } },
    input: inpatientMaterialEstimateRequestInputSchema,
    output: inpatientMaterialEstimateResponseSchema,
  },
  {
    id: 'inpatient.material-estimate.cancel',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/material-estimates/cancel',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientMaterialEstimateRequestInputSchema.parse(raw); return { input } } },
    input: inpatientMaterialEstimateRequestInputSchema,
    output: inpatientMaterialEstimateResponseSchema,
  },
  {
    id: 'inpatient.material-estimate.save',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/material-estimates/save',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientMaterialEstimateSaveInputSchema.parse(raw); return { input } } },
    input: inpatientMaterialEstimateSaveInputSchema,
    output: inpatientMaterialEstimateResponseSchema,
  },
  {
    id: 'inpatient.material-estimate.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/material-estimates/confirm',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientMaterialEstimateConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientMaterialEstimateConfirmInputSchema,
    output: inpatientMaterialEstimateResponseSchema,
  },
  {
    id: 'inpatient.drg.reservation.replace-batch',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/reservations/replace-batch',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientMaterialReservationBatchInputSchema.parse(raw); return { input } } },
    input: inpatientMaterialReservationBatchInputSchema,
    output: commandResponseSchema(inpatientMaterialReservationListSchema),
  },
  {
    id: 'inpatient.drg.agent.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/agent' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientDrgAgentSchema,
  },
  {
    id: 'inpatient.drg.agent.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/agent/confirm',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDrgAgentConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientDrgAgentConfirmInputSchema,
    output: inpatientDrgAgentResponseSchema,
  },
  {
    id: 'inpatient.drg.record-checks.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/record-checks' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientDrgRecordChecksSchema,
  },
  {
    id: 'inpatient.drg.record-checks.explanation.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/record-checks/explanation' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientDrgExplanationSchema,
  },
  {
    id: 'inpatient.drg.record-checks.explain',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/record-checks/explain',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDrgExplainInputSchema.parse(raw); return { input } } },
    input: inpatientDrgExplainInputSchema,
    output: inpatientDrgExplanationResponseSchema,
  },
  {
    id: 'inpatient.drg.review.todo.act',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/review/todos/act',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDrgReviewTodoActionInputSchema.parse(raw); return { input } } },
    input: inpatientDrgReviewTodoActionInputSchema,
    output: inpatientDrgReviewResponseSchema,
  },
  {
    id: 'inpatient.drg.review.handoff',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/review/handoff',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDrgReviewHandoffInputSchema.parse(raw); return { input } } },
    input: inpatientDrgReviewHandoffInputSchema,
    output: inpatientDrgReviewResponseSchema,
  },
  {
    id: 'inpatient.drg.review.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/review' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientDrgReviewSchema,
  },
  {
    id: 'inpatient.drg.followup.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/followup' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientDrgFollowupSchema,
  },
  {
    id: 'inpatient.drg.followup.start',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/followup/start',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDrgFollowupStartInputSchema.parse(raw); return { input } } },
    input: inpatientDrgFollowupStartInputSchema,
    output: inpatientDrgFollowupResponseSchema,
  },
  {
    id: 'inpatient.drg.followup.stop',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/drg/followup/stop',
    encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDrgFollowupStopInputSchema.parse(raw); return { input } } },
    input: inpatientDrgFollowupStopInputSchema,
    output: inpatientDrgFollowupResponseSchema,
  },
  {
    id:'inpatient.drg.pregroup',
    http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/pregroup'},
    input:z.object({admissionId:z.string().min(1)}).strict(),
    output:inpatientDrgPregroupResultSchema,
  },
  {
    id:'inpatient.drg.simulate',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/simulation',encodeBody:raw=>{const {admissionId:_id,draft}=inpatientDrgSimulationRequestSchema.parse(raw);return {input:draft}}},
    input:inpatientDrgSimulationRequestSchema,
    output:inpatientDrgSimulationSchema,
  },
  {
    id:'inpatient.drg.reservation.read',
    http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/reservations'},
    input:z.object({admissionId:z.string().min(1)}).strict(),
    output:inpatientMaterialReservationListSchema,
  },
  {
    id:'inpatient.drg.reservation.create',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/reservations',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientMaterialReservationCreateInputSchema.parse(raw);return {input}}},
    input:inpatientMaterialReservationCreateInputSchema,
    output:commandResponseSchema(inpatientMaterialReservationListSchema),
  },
  {
    id:'inpatient.drg.reservation.release',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/reservations/:reservationId/release',encodeBody:raw=>{const {admissionId:_id,reservationId:_rid,...input}=inpatientMaterialReservationReleaseInputSchema.parse(raw);return {input}}},
    input:inpatientMaterialReservationReleaseInputSchema,
    output:commandResponseSchema(inpatientMaterialReservationListSchema),
  },
  {
    id:'inpatient.drg.payer.review.preview',
    http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/payer-review-preview'},
    input:z.object({admissionId:z.string().min(1)}).strict(),
    output:inpatientDrgPayerReviewPreviewSchema,
  },
  {
    id:'inpatient.drg.payer.review',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/payer-review',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientDrgPayerReviewCreateInputSchema.parse(raw);return {input}}},
    input:inpatientDrgPayerReviewCreateInputSchema,
    output:commandResponseSchema(inpatientDrgPayerReviewListSchema),
  },
  {
    id:'inpatient.drg.payer.reviews',
    http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/payer-reviews'},
    input:z.object({admissionId:z.string().min(1)}).strict(),
    output:inpatientDrgPayerReviewListSchema,
  },
  {
    id: 'inpatient.discharge.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientDischargeEventsSchema,
  },
  {
    id: 'inpatient.discharge.preview',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/preview' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientSettlementPreviewSchema,
  },
  {
    id: 'inpatient.payment.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/payments' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientPaymentsSchema,
  },
  {
    id: 'inpatient.payment.preview',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/payments/preview', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPaymentInputSchema.parse(raw); return { input } } },
    input: inpatientPaymentInputSchema,
    output: inpatientPaymentPreviewResponseSchema,
  },
  {
    id: 'inpatient.payment.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/payments/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPaymentConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientPaymentConfirmInputSchema,
    output: inpatientPaymentResponseSchema,
  },
  {
    id: 'inpatient.payment.recover',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/payments/recover', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPaymentRecoverInputSchema.parse(raw); return { input } } },
    input: inpatientPaymentRecoverInputSchema,
    output: inpatientPaymentResponseSchema,
  },
  {
    id: 'inpatient.refund.preview',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/refunds/preview', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientRefundInputSchema.parse(raw); return { input } } },
    input: inpatientRefundInputSchema,
    output: inpatientRefundPreviewResponseSchema,
  },
  {
    id: 'inpatient.refund.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/refunds/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientRefundConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientRefundConfirmInputSchema,
    output: refundResponseSchema,
  },
  {
    id: 'inpatient.refund.recover',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/refunds/recover', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientRefundRecoverInputSchema.parse(raw); return { input } } },
    input: inpatientRefundRecoverInputSchema,
    output: refundResponseSchema,
  },
  {
    id: 'inpatient.discharge.issue',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/issue', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDischargeInputSchema.parse(raw); return { input } } },
    input: inpatientDischargeInputSchema,
    output: inpatientDischargeResponseSchema,
  },
  {
    id: 'inpatient.discharge.depart',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/depart', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDepartInputSchema.parse(raw); return { input } } },
    input: inpatientDepartInputSchema,
    output: inpatientDischargeResponseSchema,
  },
  {
    id: 'inpatient.discharge.recall',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/recall', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDischargeInputSchema.parse(raw); return { input } } },
    input: inpatientDischargeInputSchema,
    output: inpatientDischargeResponseSchema,
  },
  {
    id: 'inpatient.discharge.clear',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/clear', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDischargeInputSchema.parse(raw); return { input } } },
    input: inpatientDischargeInputSchema,
    output: inpatientDischargeResponseSchema,
  },
  {
    id: 'inpatient.discharge.settle',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/discharge/settle', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSettleInputSchema.parse(raw); return { input } } },
    input: inpatientSettleInputSchema,
    output: inpatientSettlementResponseSchema,
  },
  {
    id: 'inpatient.pci-selection.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/pci-selection' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientPciSelectionSchema,
  },
  {
    id: 'inpatient.pci-selection.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/pci-selection/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPciSelectionConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientPciSelectionConfirmInputSchema,
    output: inpatientPciSelectionResponseSchema,
  },
  {
    id: 'inpatient.pci-selection.save',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/pci-selection/save', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientPciSelectionSaveInputSchema.parse(raw); return { input } } },
    input: inpatientPciSelectionSaveInputSchema,
    output: inpatientPciSelectionResponseSchema,
  },
  {
    id: 'inpatient.surgery.catalog',
    http: { method: 'GET', path: '/api/his/v1/inpatient/surgery-catalog' },
    input: emptyInputSchema,
    output: inpatientSurgeryCatalogSchema,
  },
  {
    id: 'inpatient.surgery.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientSurgerySchema,
  },
  {
    id: 'inpatient.surgery.request',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/request', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryRequestInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryRequestInputSchema,
    output: inpatientSurgeryResponseSchema,
  },
  {
    id: 'inpatient.surgery.check-preop',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/check-preop', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryActionInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryActionInputSchema,
    output: inpatientSurgeryResponseSchema,
  },
  {
    id: 'inpatient.surgery.confirm-consent',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/confirm-consent', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryActionInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryActionInputSchema,
    output: inpatientSurgeryResponseSchema,
  },
  {
    id: 'inpatient.surgery.cancel',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/cancel', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryActionInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryActionInputSchema,
    output: inpatientSurgeryResponseSchema,
  },
  {
    id: 'inpatient.surgery.start',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/start', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryStartInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryStartInputSchema,
    output: inpatientSurgeryResponseSchema,
  },
  {
    id: 'inpatient.surgery.record-material',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/record-material', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryRecordMaterialInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryRecordMaterialInputSchema,
    output: inpatientSurgeryResponseSchema,
  },
  {
    id: 'inpatient.surgery.correct-material',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/correct-material', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryCorrectMaterialInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryCorrectMaterialInputSchema,
    output: inpatientSurgeryResponseSchema,
  },
  {
    id: 'inpatient.surgery.supplement-material',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/supplement-material', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgerySupplementMaterialInputSchema.parse(raw); return { input } } },
    input: inpatientSurgerySupplementMaterialInputSchema,
    output: inpatientSurgeryResponseSchema,
  },
  {
    id: 'inpatient.surgery.preview-completion',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/preview-completion', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryCompletionReviewInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryCompletionReviewInputSchema,
    output: inpatientSurgeryCompletionPreviewSchema,
  },
  {
    id: 'inpatient.surgery.complete',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/complete', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryCompleteInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryCompleteInputSchema,
    output: inpatientSurgeryResponseSchema,
  },
  {
    id: 'inpatient.surgery.execute',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/surgeries/execute', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSurgeryExecuteInputSchema.parse(raw); return { input } } },
    input: inpatientSurgeryExecuteInputSchema,
    output: inpatientSurgeryResponseSchema,
  },
  {
    id:'inpatient.investigation.catalog',
    http:{method:'GET',path:'/api/his/v1/inpatient/investigation-catalog'},
    input:emptyInputSchema,
    output:inpatientInvestigationCatalogSchema,
  },
  {
    id:'inpatient.investigation.read',
    http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations'},
    input:z.object({admissionId:z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)}).strict(),
    output:inpatientInvestigationsSchema,
  },
  {
    id:'inpatient.transfer.catalog',
    http:{method:'GET',path:'/api/his/v1/inpatient/transfer-catalog'},
    input:emptyInputSchema,
    output:inpatientTransferCatalogSchema,
  },
  {
    id:'inpatient.transfer.read',
    http:{method:'GET',path:'/api/his/v1/inpatient/admissions/:admissionId/transfers'},
    input:z.object({admissionId:z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)}).strict(),
    output:inpatientTransfersSchema,
  },
  {
    id:'inpatient.transfer.incoming',
    http:{method:'GET',path:'/api/his/v1/inpatient/transfers/incoming'},
    input:emptyInputSchema,
    output:inpatientIncomingTransfersSchema,
  },
  {
    id:'inpatient.investigation.issue',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations/issue',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientInvestigationIssueInputSchema.parse(raw);return {input}}},
    input:inpatientInvestigationIssueInputSchema,
    output:inpatientInvestigationResponseSchema,
  },
  {
    id:'inpatient.investigation.send',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations/send',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientInvestigationActionInputSchema.parse(raw);return {input}}},
    input:inpatientInvestigationActionInputSchema,
    output:inpatientInvestigationResponseSchema,
  },
  {
    id:'inpatient.investigation.cancel',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations/cancel',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientInvestigationActionInputSchema.parse(raw);return {input}}},
    input:inpatientInvestigationActionInputSchema,
    output:inpatientInvestigationResponseSchema,
  },
  {
    id:'inpatient.investigation.retry',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations/retry',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientInvestigationActionInputSchema.parse(raw);return {input}}},
    input:inpatientInvestigationActionInputSchema,
    output:inpatientInvestigationResponseSchema,
  },
  {
    id:'inpatient.investigation.acknowledge',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/investigations/acknowledge',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientInvestigationAcknowledgeInputSchema.parse(raw);return {input}}},
    input:inpatientInvestigationAcknowledgeInputSchema,
    output:inpatientInvestigationResponseSchema,
  },
  {
    id:'inpatient.transfer.request',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/transfers/request',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientTransferRequestInputSchema.parse(raw);return {input}}},
    input:inpatientTransferRequestInputSchema,
    output:inpatientTransferResponseSchema,
  },
  {
    id:'inpatient.transfer.handover',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/transfers/handover',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientTransferActionInputSchema.parse(raw);return {input}}},
    input:inpatientTransferActionInputSchema,
    output:inpatientTransferResponseSchema,
  },
  {
    id:'inpatient.transfer.receive',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/transfers/receive',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientTransferReceiveInputSchema.parse(raw);return {input}}},
    input:inpatientTransferReceiveInputSchema,
    output:inpatientTransferResponseSchema,
  },
  {
    id:'inpatient.transfer.cancel',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/transfers/cancel',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientTransferActionInputSchema.parse(raw);return {input}}},
    input:inpatientTransferActionInputSchema,
    output:inpatientTransferResponseSchema,
  },
  {
    id: 'inpatient.pharmacy.list',
    http: { method: 'GET', path: '/api/his/v1/inpatient/pharmacy/admissions' },
    input: emptyInputSchema,
    output: inpatientPharmacyListSchema,
  },
  {
    id: 'inpatient.pharmacy.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/pharmacy' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientPharmacySchema,
  },
  {
    id: 'inpatient.charges.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/charges' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientChargesSchema,
  },
  {
    id: 'inpatient.pci-data.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/pci-data' },
    input: emptyInputSchema,
    output: inpatientPciDataSchema,
  },
  {
    id: 'inpatient.pci-data.prepare',
    http: { method: 'POST', path: '/api/his/v1/inpatient/pci-data/prepare', encodeBody: raw => ({ input: inpatientPciDataPrepareRequestSchema.shape.input.parse(raw) }) },
    input: inpatientPciDataPrepareRequestSchema.shape.input,
    output: inpatientPciDataResponseSchema,
  },
  {
    id: 'admin.pci-case.prepare',
    http: { method: 'POST', path: '/api/sim/v1/synthetic-cases/pci/prepare', encodeBody: raw => ({ input: pciCaseSourcePrepareRequestSchema.shape.input.parse(raw) }) },
    input: pciCaseSourcePrepareRequestSchema.shape.input,
    output: pciCaseSourceResponseSchema,
  },
  {
    id: 'registration.synthetic-case.start-inpatient',
    http: { method: 'POST', path: '/api/his/v1/synthetic-cases/:caseId/actions/start-inpatient-visit',
      encodeBody: raw => { const { caseId: _caseId, ...input } = startSyntheticInpatientCaseRequestSchema.extend({ caseId: z.string().min(1) }).parse(raw); return input } },
    input: startSyntheticInpatientCaseRequestSchema.extend({ caseId: z.string().min(1) }),
    output: startSyntheticInpatientCaseResponseSchema,
  },
  {
    id: 'inpatient.catalog.search',
    http: { method: 'GET', path: '/api/his/v1/inpatient/catalog-search' },
    input: inpatientCatalogSearchInputSchema,
    output: inpatientCatalogSearchSchema,
  },
  {
    id: 'inpatient.clinical.catalog',
    http: { method: 'GET', path: '/api/his/v1/inpatient/clinical-catalog' },
    input: emptyInputSchema,
    output: inpatientFullCatalogSchema,
  },
  {
    id: 'inpatient.clinical.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/clinical' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientFullClinicalSchema,
  },
  {
    id: 'inpatient.vital-signs.record',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/vital-signs', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientVitalSignsInputSchema.parse(raw); return { input } } },
    input: inpatientVitalSignsInputSchema,
    output: inpatientFullClinicalResponseSchema,
  },
  {
    id: 'inpatient.risk-assessment.record',
    http: { method: 'PUT', path: '/api/his/v1/inpatient/admissions/:admissionId/risk-assessment', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientRiskAssessmentInputSchema.parse(raw); return { input } } },
    input: inpatientRiskAssessmentInputSchema,
    output: inpatientFullClinicalResponseSchema,
  },
  {
    id: 'inpatient.clinical-scores.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/clinical-scores' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: clinicalScoreBundleSchema,
  },
  {
    id: 'inpatient.diagnosis.confirm',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/diagnoses/confirm', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientDiagnosisConfirmInputSchema.parse(raw); return { input } } },
    input: inpatientDiagnosisConfirmInputSchema,
    output: inpatientFullClinicalResponseSchema,
  },
  {
    id: 'inpatient.order.issue',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/orders/issue', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientOrderIssueInputSchema.parse(raw); return { input } } },
    input: inpatientOrderIssueInputSchema,
    output: inpatientFullClinicalResponseSchema,
  },
  {
    id: 'inpatient.order.verify',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/orders/verify', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientOrderActionInputSchema.parse(raw); return { input } } },
    input: inpatientOrderActionInputSchema,
    output: inpatientFullClinicalResponseSchema,
  },
  {
    id: 'inpatient.order.request-stop',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/orders/request-stop', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientOrderReasonInputSchema.parse(raw); return { input } } },
    input: inpatientOrderReasonInputSchema,
    output: inpatientFullClinicalResponseSchema,
  },
  {
    id: 'inpatient.order.verify-stop',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/orders/verify-stop', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientOrderActionInputSchema.parse(raw); return { input } } },
    input: inpatientOrderActionInputSchema,
    output: inpatientFullClinicalResponseSchema,
  },
  {
    id:'inpatient.execution.dispense',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/executions/dispense',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientDispenseInputSchema.parse(raw);return {input}}},
    input:inpatientDispenseInputSchema,
    output:inpatientPharmacyResponseSchema,
  },
  {
    id:'inpatient.execution.administer',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/executions/administer',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientExecutionActionInputSchema.parse(raw);return {input}}},
    input:inpatientExecutionActionInputSchema,
    output:inpatientFullClinicalResponseSchema,
  },
  {
    id:'inpatient.execution.complete',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/executions/complete',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientExecutionActionInputSchema.parse(raw);return {input}}},
    input:inpatientExecutionActionInputSchema,
    output:inpatientFullClinicalResponseSchema,
  },
  {
    id:'inpatient.charge.reverse',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/charges/reverse',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientChargeReverseInputSchema.parse(raw);return {input}}},
    input:inpatientChargeReverseInputSchema,
    output:inpatientChargesResponseSchema,
  },
  {
    id:'inpatient.execution.request-prn',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/executions/request-prn',encodeBody:raw=>{const {admissionId:_id,...input}=inpatientOrderReasonInputSchema.parse(raw);return {input}}},
    input:inpatientOrderReasonInputSchema,
    output:inpatientFullClinicalResponseSchema,
  },
  {
    id: 'inpatient.catalog',
    http: { method: 'GET', path: '/api/his/v1/inpatient/catalog' },
    input: emptyInputSchema,
    output: inpatientCatalogSchema,
  },
  {
    id: 'inpatient.admission.list',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions' },
    input: emptyInputSchema,
    output: inpatientListSchema,
  },
  {
    id: 'inpatient.admission.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId' },
    input: z.object({ admissionId: z.string().min(1) }).strict(),
    output: inpatientDetailSchema,
  },
  {
    id: 'inpatient.admission.register',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions', encodeBody: raw => ({ input: inpatientRegistrationInputSchema.parse(raw) }) },
    input: inpatientRegistrationInputSchema,
    output: inpatientCommandResponseSchema,
  },
  {
    id: 'inpatient.admission.receive',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/receive', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientBedInputSchema.parse(raw); return { input } } },
    input: inpatientBedInputSchema,
    output: inpatientCommandResponseSchema,
  },
  {
    id: 'inpatient.admission.move-bed',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/move-bed', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientBedInputSchema.parse(raw); return { input } } },
    input: inpatientBedInputSchema,
    output: inpatientCommandResponseSchema,
  },
  {
    id: 'inpatient.admission.swap-bed',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions/:admissionId/swap-bed', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientSwapInputSchema.parse(raw); return { input } } },
    input: inpatientSwapInputSchema,
    output: inpatientSwapResponseSchema,
  },
  {
    id: 'inpatient.referral.list',
    http: { method: 'GET', path: '/api/his/v1/inpatient/referrals' },
    input: emptyInputSchema,
    output: inpatientReferralListSchema,
  },
  {
    id: 'inpatient.referral.issue',
    http: { method: 'POST', path: '/api/his/v1/inpatient/referrals', encodeBody: raw => ({ input: inpatientReferralInputSchema.parse(raw) }) },
    input: inpatientReferralInputSchema,
    output: inpatientReferralResponseSchema,
  },
] as const satisfies readonly HisOperationRuntimeDefinition[]

export const hisOperationRuntimeCatalog: readonly HisOperationRuntimeDefinition[] = rawOperationRuntimeDefinitions.map((operation) => {
  if (operation.http.method === 'GET' || 'encodeBody' in operation.http) return operation
  const encodeBody = bodyEncoders[operation.id as keyof typeof bodyEncoders]
  return {
    ...operation,
    http: {
      ...operation.http,
      ...(encodeBody === undefined ? {} : { encodeBody }),
    },
  }
})

const runtimeOperationsById = new Map(hisOperationRuntimeCatalog.map(operation => [operation.id, operation]))
export const hisOperationIdSchema = z.string().refine(
  id => runtimeOperationsById.has(id),
  { message: 'Unknown HIS operation ID' },
)

export function getHisOperation(id: string): HisOperationRuntimeDefinition {
  const operation = runtimeOperationsById.get(id)
  if (operation === undefined) throw new Error(`Unknown HIS operation: ${id}`)
  return operation
}
