import {
  clinicalPromptBundleSchema,
  clinicalPromptDismissResponseSchema,
  inpatientClinicalPromptDismissInputSchema,
  inpatientClinicalPromptReadInputSchema,
  outpatientClinicalPromptDismissInputSchema,
  outpatientClinicalPromptReadInputSchema,
} from './clinical-prompt-cards.ts'
import {
  clinicalOverrideInputSchema,
  clinicalQualityCheckSchema,
  inpatientClinicalQualityInputSchema,
  outpatientClinicalQualityInputSchema,
} from './clinical-quality.ts'
import {
  bedsideQuestionnaireResponseSchema,
  bedsideQuestionnaireStateSchema,
  clinicalScoreBundleSchema,
  inpatientBedsideQuestionnaireReadInputSchema,
  inpatientBedsideQuestionnaireRecordInputSchema,
  inpatientRiskAssessmentInputSchema,
  inpatientVitalSignsInputSchema,
  outpatientBedsideQuestionnaireReadInputSchema,
  outpatientBedsideQuestionnaireRecordInputSchema,
  outpatientRiskAssessmentOperationInputSchema,
  outpatientRiskAssessmentResponseSchema,
} from './clinical-scores.ts'
import {
  clinicalFactLedgerSchema,
  clinicalFactVerificationResponseSchema,
  inpatientClinicalFactLedgerQuerySchema,
  inpatientClinicalFactVerificationInputSchema,
  outpatientClinicalFactLedgerQuerySchema,
  outpatientClinicalFactVerificationInputSchema,
} from './clinical-fact-ledger.ts'
import {
  confirmIdentityQuarantineMergeInputSchema,
  confirmIdentityQuarantineMergeResponseSchema,
  listIdentityQuarantineQuerySchema,
  listIdentityQuarantineResponseSchema,
} from './local-source-ingestion.ts'
import {
  conceptVocabularyCatalogQuerySchema,
  conceptVocabularyCatalogResponseSchema,
} from './concept-vocabulary.ts'
import {
  diseasePackKnowledgeEvaluationSchema,
  inpatientDiseasePackKnowledgeInputSchema,
  outpatientDiseasePackKnowledgeInputSchema,
} from './knowledge-claims.ts'
import {
  adminDiseasePackActivateInputSchema,
  adminDiseasePackExamRunInputSchema,
  diseasePackActivationGateResponseSchema,
  dsapExamRunResponseSchema,
} from './disease-pack-exam.ts'
import {
  diseasePackCatalogListSchema,
  diseasePackRuntimeBundleSchema,
  diseasePackTaskFactsResponseSchema,
  diseasePackTaskReadinessResultSchema,
  diseasePackToggleResponseSchema,
  diseasePackToolAuthorizeResponseSchema,
  inpatientDiseasePackReadQuerySchema,
  inpatientDiseasePackTaskQuerySchema,
  inpatientDiseasePackToggleInputSchema,
  inpatientDiseasePackToolAuthorizeInputSchema,
  outpatientDiseasePackReadQuerySchema,
  outpatientDiseasePackTaskQuerySchema,
  outpatientDiseasePackToggleInputSchema,
  outpatientDiseasePackToolAuthorizeInputSchema,
} from './disease-pack.ts'
import {
  guidelineTopicBundleSchema,
  inpatientGuidelineTopicsInputSchema,
  outpatientGuidelineTopicsInputSchema,
} from './guideline-topics.ts'
import {
  inpatientOrderSetDraftsInputSchema,
  orderSetDraftBundleSchema,
  orderSetTemplateListQuerySchema,
  orderSetTemplateListSchema,
  outpatientOrderSetDraftsInputSchema,
} from './order-set-templates.ts'
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
import { inpatientDischargeInputSchema, inpatientDischargeIssueInputSchema, inpatientDepartInputSchema, inpatientSettleInputSchema, inpatientDischargeResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema, inpatientDischargeEventsSchema,
  inpatientPaymentsSchema, inpatientPaymentInputSchema, inpatientPaymentConfirmInputSchema, inpatientPaymentRecoverInputSchema, inpatientPaymentResponseSchema, inpatientPaymentPreviewResponseSchema,
  inpatientRefundInputSchema, inpatientRefundConfirmInputSchema, inpatientRefundRecoverInputSchema, inpatientRefundPreviewResponseSchema } from './inpatient-discharge.ts'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, inpatientSurgeryResponseSchema, inpatientSurgeryRequestInputSchema, inpatientSurgeryActionInputSchema, inpatientSurgeryConfirmConsentInputSchema, inpatientSurgeryExecuteInputSchema, inpatientSurgeryStartInputSchema, inpatientSurgeryRecordMaterialInputSchema, inpatientSurgeryRecordMedicationInputSchema, inpatientSurgerySupplementMaterialInputSchema, inpatientSurgeryCorrectMaterialInputSchema, inpatientSurgeryCompleteInputSchema, inpatientSurgeryCompletionReviewInputSchema, inpatientSurgeryCompletionPreviewSchema, inpatientSurgeryConvertToPciInputSchema, inpatientSurgeryFinalizeStandbyInputSchema } from './inpatient-surgery.ts'
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
import { inpatientPciDataSchema, inpatientPciDataPrepareRequestSchema, inpatientPciDataResponseSchema, pciCaseSourcePrepareRequestSchema, pciCaseSourceResponseSchema, authoredCasePackPrepareRequestSchema, authoredCasePackPrepareResponseSchema, authoredCasePackSummarySchema, startSyntheticInpatientCaseRequestSchema, startSyntheticInpatientCaseResponseSchema } from './inpatient-pci-data.ts'
import { inpatientAngiographyReportsSchema } from './inpatient-angiography.ts'
import { doctorCaseHistoryInputSchema, doctorCaseHistoryDetailInputSchema, doctorCaseHistorySchema, doctorCaseHistoryDetailSchema } from './doctor-history.ts'
import { z } from 'zod'

const admIdInput = z.object({ admissionId: z.string().min(1) }).strict()
const admGet = (sub: string) => ({ method: 'GET' as const, path: `/api/his/v1/inpatient/admissions/:admissionId${sub}` })
const admPost = <S extends z.ZodType<{ admissionId: string }>>(sub: string, schema: S) => ({
  method: 'POST' as const,
  path: `/api/his/v1/inpatient/admissions/:admissionId${sub}`,
  encodeBody: (raw: unknown) => { const { admissionId: _id, ...input } = schema.parse(raw); return { input } },
})
const admOp = <S extends z.ZodType<{ admissionId: string }>, O extends z.ZodTypeAny>(id: string, sub: string, input: S, output: O) => ({
  id, http: admPost(sub, input), input, output,
})
const admQuery = <O extends z.ZodTypeAny>(id: string, sub: string, output: O, input: z.ZodTypeAny = admIdInput) => ({
  id, http: admGet(sub), input, output,
})
const hisOp = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  id: string,
  method: 'DELETE' | 'GET' | 'POST' | 'PUT',
  path: string,
  input: I,
  output: O,
) => ({ id, http: { method, path }, input, output })

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
  }).strict().refine(value => value.systolicMmHg > value.diastolicMmHg, {
    message: 'Systolic blood pressure must exceed diastolic blood pressure',
    path: ['systolicMmHg'],
  }),
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
  clinicalOverride: clinicalOverrideInputSchema.optional(),
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
  clinicalOverride: clinicalOverrideInputSchema.optional(),
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
    const { encounterId, encounterVersion, ...input } = completeEncounterInputSchema.parse(rawInput)
    return commandBody({ [`Encounter/${encounterId}`]: encounterVersion }, input)
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
    const { clinicalOverride, expectedVersions } = orderHospitalServiceOperationInputSchema.parse(rawInput)
    return commandBody(expectedVersions, clinicalOverride === undefined ? {} : { clinicalOverride })
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
      path: '/api/his/v1/catalogs/order-set-templates',
    },
    id: 'catalog.order-set-templates.list',
    input: orderSetTemplateListQuerySchema,
    output: orderSetTemplateListSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/catalogs/disease-packs',
    },
    id: 'catalog.disease-packs.list',
    input: emptyInputSchema,
    output: diseasePackCatalogListSchema,
  },
  {
    http: {
      method: 'GET',
      path: '/api/his/v1/catalogs/concept-vocabulary',
    },
    id: 'catalog.concept-vocabulary.read',
    input: conceptVocabularyCatalogQuerySchema,
    output: conceptVocabularyCatalogResponseSchema,
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
      path: '/api/his/v1/identity-quarantine',
    },
    id: 'identity-quarantine.list',
    input: listIdentityQuarantineQuerySchema,
    output: listIdentityQuarantineResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/identity-quarantine/:candidateId/confirm-merge',
      encodeBody: (raw) => {
        const { candidateId: _candidateId, ...input } = confirmIdentityQuarantineMergeInputSchema.parse(raw)
        return { input }
      },
    },
    id: 'identity-quarantine.confirm-merge',
    input: confirmIdentityQuarantineMergeInputSchema,
    output: confirmIdentityQuarantineMergeResponseSchema,
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
    http: { method: 'GET', path: '/api/his/v1/outpatient/cases/:caseId/bedside-questionnaire' },
    id: 'doctor.case.bedside-questionnaire.read',
    input: outpatientBedsideQuestionnaireReadInputSchema,
    output: bedsideQuestionnaireStateSchema,
  },
  {
    http: {
      method: 'PUT',
      path: '/api/his/v1/outpatient/cases/:caseId/bedside-questionnaire',
      encodeBody: (raw: unknown) => {
        const { caseId: _caseId, ...input } = outpatientBedsideQuestionnaireRecordInputSchema.parse(raw)
        return { input }
      },
    },
    id: 'doctor.case.bedside-questionnaire.record',
    input: outpatientBedsideQuestionnaireRecordInputSchema,
    output: bedsideQuestionnaireResponseSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/outpatient/cases/:caseId/clinical-fact-ledger' },
    id: 'doctor.case.clinical-fact-ledger.read',
    input: outpatientClinicalFactLedgerQuerySchema,
    output: clinicalFactLedgerSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/outpatient/cases/:caseId/clinical-fact-verifications',
      encodeBody: (raw: unknown) => {
        const { caseId: _id, ...input } = outpatientClinicalFactVerificationInputSchema.parse(raw)
        return { input }
      },
    },
    id: 'doctor.case.clinical-fact-verification.record',
    input: outpatientClinicalFactVerificationInputSchema,
    output: clinicalFactVerificationResponseSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/doctor/cases/:caseId/guideline-topics' },
    id: 'doctor.case.guideline-topics.read',
    input: outpatientGuidelineTopicsInputSchema,
    output: guidelineTopicBundleSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/doctor/cases/:caseId/order-set-drafts' },
    id: 'doctor.case.order-set-drafts.read',
    input: outpatientOrderSetDraftsInputSchema,
    output: orderSetDraftBundleSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/outpatient/cases/:caseId/disease-packs' },
    id: 'doctor.case.disease-packs.read',
    input: outpatientDiseasePackReadQuerySchema,
    output: diseasePackRuntimeBundleSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/outpatient/cases/:caseId/disease-packs/:packId/toggle',
      encodeBody: (raw: unknown) => {
        const { caseId: _caseId, packId: _packId, ...input } = outpatientDiseasePackToggleInputSchema.parse(raw)
        return { input }
      },
    },
    id: 'doctor.case.disease-packs.toggle',
    input: outpatientDiseasePackToggleInputSchema,
    output: diseasePackToggleResponseSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/outpatient/cases/:caseId/disease-packs/:packId/tasks/:taskId/readiness' },
    id: 'doctor.case.disease-pack-task-readiness.read',
    input: outpatientDiseasePackTaskQuerySchema,
    output: diseasePackTaskReadinessResultSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/outpatient/cases/:caseId/disease-packs/:packId/tasks/:taskId/facts' },
    id: 'doctor.case.disease-pack-task-facts.read',
    input: outpatientDiseasePackTaskQuerySchema,
    output: diseasePackTaskFactsResponseSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/outpatient/cases/:caseId/disease-packs/:packId/tools/authorize',
      encodeBody: (raw: unknown) => {
        const { caseId: _caseId, packId: _packId, ...input } = outpatientDiseasePackToolAuthorizeInputSchema.parse(raw)
        return { input }
      },
    },
    id: 'doctor.case.disease-pack-tools.authorize',
    input: outpatientDiseasePackToolAuthorizeInputSchema,
    output: diseasePackToolAuthorizeResponseSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/outpatient/cases/:caseId/disease-packs/:packId/knowledge' },
    id: 'doctor.case.disease-pack-knowledge.read',
    input: outpatientDiseasePackKnowledgeInputSchema,
    output: diseasePackKnowledgeEvaluationSchema,
  },
  {
    http: { method: 'GET', path: '/api/his/v1/doctor/cases/:caseId/clinical-prompts' },
    id: 'doctor.case.clinical-prompts.read',
    input: outpatientClinicalPromptReadInputSchema,
    output: clinicalPromptBundleSchema,
  },
  {
    http: {
      method: 'POST',
      path: '/api/his/v1/doctor/cases/:caseId/clinical-prompts/:cardId/dismiss',
      encodeBody: (raw: unknown) => {
        const { caseId: _caseId, cardId: _cardId, ...input } = outpatientClinicalPromptDismissInputSchema.parse(raw)
        return { input }
      },
    },
    id: 'doctor.case.clinical-prompts.dismiss',
    input: outpatientClinicalPromptDismissInputSchema,
    output: clinicalPromptDismissResponseSchema,
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
      path: '/api/his/v1/encounters/:encounterId/clinical-quality',
    },
    id: 'encounter.clinical-quality.read',
    input: outpatientClinicalQualityInputSchema,
    output: clinicalQualityCheckSchema,
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
  hisOp('encounter.laboratory-request.draft.set', 'PUT', '/api/his/v1/encounters/:encounterId/laboratory-request/draft', saveLaboratoryRequestDraftOperationInputSchema, laboratoryRequestDraftResponseSchema),
  hisOp('encounter.laboratory-request.draft.delete', 'DELETE', '/api/his/v1/encounters/:encounterId/laboratory-request/draft', deleteLaboratoryRequestDraftOperationInputSchema, laboratoryRequestDraftResponseSchema),
  hisOp('encounter.laboratory-request.issue', 'POST', '/api/his/v1/encounters/:encounterId/laboratory-request/actions/issue', issueLaboratoryRequestOperationInputSchema, issueLaboratoryRequestResponseSchema),
  hisOp('laboratory-request.cancel', 'POST', '/api/his/v1/laboratory-requests/:requestId/actions/cancel', cancelLaboratoryRequestOperationInputSchema, laboratoryRequestActionResponseSchema),
  hisOp('laboratory-request.retry-generation', 'POST', '/api/his/v1/laboratory-requests/:requestId/actions/retry-generation', retryLaboratoryResultGenerationOperationInputSchema, laboratoryRequestActionResponseSchema),
  hisOp('laboratory-report.acknowledge', 'POST', '/api/his/v1/laboratory-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge', acknowledgeLaboratoryReportOperationInputSchema, acknowledgeLaboratoryReportResponseSchema),
  hisOp('laboratory-report.correct', 'POST', '/api/his/v1/laboratory-requests/:requestId/reports/:diagnosticReportId/actions/correct', correctLaboratoryReportOperationInputSchema, correctLaboratoryReportResponseSchema),
  hisOp('doctor.case.examination-services.list', 'GET', '/api/his/v1/doctor/cases/:caseId/examination-services', caseIdInputSchema, caseExaminationServiceCatalogSchema),
  hisOp('encounter.examination-request.draft.set', 'PUT', '/api/his/v1/encounters/:encounterId/examination-request/draft', saveExaminationRequestDraftOperationInputSchema, examinationRequestDraftResponseSchema),
  hisOp('encounter.examination-request.draft.delete', 'DELETE', '/api/his/v1/encounters/:encounterId/examination-request/draft', deleteExaminationRequestDraftOperationInputSchema, examinationRequestDraftResponseSchema),
  hisOp('encounter.examination-request.issue', 'POST', '/api/his/v1/encounters/:encounterId/examination-request/actions/issue', issueExaminationRequestOperationInputSchema, issueExaminationRequestResponseSchema),
  hisOp('examination-request.cancel', 'POST', '/api/his/v1/examination-requests/:requestId/actions/cancel', cancelExaminationRequestOperationInputSchema, examinationRequestActionResponseSchema),
  hisOp('examination-request.retry', 'POST', '/api/his/v1/examination-requests/:requestId/actions/retry', retryExaminationRequestOperationInputSchema, examinationRequestActionResponseSchema),
  hisOp('examination-report.acknowledge', 'POST', '/api/his/v1/examination-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge', acknowledgeExaminationReportOperationInputSchema, acknowledgeExaminationReportResponseSchema),
  hisOp('doctor.case.imaging-services.list', 'GET', '/api/his/v1/doctor/cases/:caseId/imaging-services', caseIdInputSchema, caseImagingServiceCatalogSchema),
  hisOp('encounter.imaging-request.draft.set', 'PUT', '/api/his/v1/encounters/:encounterId/imaging-request/draft', saveImagingRequestDraftOperationInputSchema, imagingRequestDraftResponseSchema),
  hisOp('encounter.imaging-request.draft.delete', 'DELETE', '/api/his/v1/encounters/:encounterId/imaging-request/draft', deleteImagingRequestDraftOperationInputSchema, imagingRequestDraftResponseSchema),
  hisOp('encounter.imaging-request.issue', 'POST', '/api/his/v1/encounters/:encounterId/imaging-request/actions/issue', issueImagingRequestOperationInputSchema, issueImagingRequestResponseSchema),
  hisOp('imaging-request.cancel', 'POST', '/api/his/v1/imaging-requests/:requestId/actions/cancel', cancelImagingRequestOperationInputSchema, imagingRequestActionResponseSchema),
  hisOp('imaging-request.retry', 'POST', '/api/his/v1/imaging-requests/:requestId/actions/retry', retryImagingRequestOperationInputSchema, imagingRequestActionResponseSchema),
  hisOp('imaging-report.acknowledge', 'POST', '/api/his/v1/imaging-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge', acknowledgeImagingReportOperationInputSchema, acknowledgeImagingReportResponseSchema),
  hisOp('imaging-report.correct', 'POST', '/api/his/v1/imaging-requests/:requestId/reports/:diagnosticReportId/actions/correct', correctImagingReportOperationInputSchema, correctImagingReportResponseSchema),
  hisOp('doctor.case.pathology-services.list', 'GET', '/api/his/v1/doctor/cases/:caseId/pathology-services', caseIdInputSchema, casePathologyServiceCatalogSchema),
  hisOp('encounter.pathology-request.draft.set', 'PUT', '/api/his/v1/encounters/:encounterId/pathology-request/draft', savePathologyRequestDraftOperationInputSchema, pathologyRequestDraftResponseSchema),
  hisOp('encounter.pathology-request.draft.delete', 'DELETE', '/api/his/v1/encounters/:encounterId/pathology-request/draft', deletePathologyRequestDraftOperationInputSchema, pathologyRequestDraftResponseSchema),
  hisOp('encounter.pathology-request.issue', 'POST', '/api/his/v1/encounters/:encounterId/pathology-request/actions/issue', issuePathologyRequestOperationInputSchema, issuePathologyRequestResponseSchema),
  hisOp('pathology-request.cancel', 'POST', '/api/his/v1/pathology-requests/:requestId/actions/cancel', cancelPathologyRequestOperationInputSchema, pathologyRequestActionResponseSchema),
  hisOp('pathology-request.retry', 'POST', '/api/his/v1/pathology-requests/:requestId/actions/retry', retryPathologyRequestOperationInputSchema, pathologyRequestActionResponseSchema),
  hisOp('pathology-report.acknowledge', 'POST', '/api/his/v1/pathology-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge', acknowledgePathologyReportOperationInputSchema, acknowledgePathologyReportResponseSchema),
  hisOp('pathology-report.correct', 'POST', '/api/his/v1/pathology-requests/:requestId/reports/:diagnosticReportId/actions/correct', correctPathologyReportOperationInputSchema, correctPathologyReportResponseSchema),
  hisOp('service.order', 'POST', '/api/his/v1/encounters/:encounterId/services/:serviceId/actions/order', orderHospitalServiceOperationInputSchema, orderHospitalServiceResponseSchema),
  hisOp('service.complete', 'POST', '/api/his/v1/service-requests/:serviceRequestId/actions/complete', completeHospitalServiceOperationInputSchema, completeHospitalServiceResponseSchema),
  hisOp('billing.queue.list', 'GET', '/api/his/v1/billing/queue', billingQueueInputSchema, billingQueueSchema),
  hisOp('billing.case.get', 'GET', '/api/his/v1/billing/cases/:caseId', billingCaseInputSchema, billingCaseSchema),
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
  admQuery('inpatient.record.read', '/record', inpatientRecordSchema),
  admOp('inpatient.record.submit', '/record/submit', inpatientRecordSubmitInputSchema, inpatientRecordResponseSchema),
  admOp('inpatient.record.review', '/record/review', inpatientRecordReviewInputSchema, inpatientRecordResponseSchema),
  admOp('inpatient.record.archive', '/record/archive', inpatientRecordArchiveInputSchema, inpatientRecordResponseSchema),
  admQuery('inpatient.guideline-advice.read', '/guideline-advice', inpatientGuidelineAdviceListSchema, inpatientGuidelineAdviceReadQuerySchema),
  admQuery('inpatient.guideline-topics.read', '/guideline-topics', guidelineTopicBundleSchema, inpatientGuidelineTopicsInputSchema),
  admOp('inpatient.guideline-advice.request', '/guideline-advice/request', inpatientGuidelineAdviceRequestInputSchema, inpatientGuidelineAdviceResponseSchema),
  admQuery('inpatient.material-estimate.read', '/material-estimates', inpatientMaterialEstimatesSchema),
  admOp('inpatient.material-estimate.request', '/material-estimates/request', inpatientMaterialEstimateRequestInputSchema, inpatientMaterialEstimateResponseSchema),
  admOp('inpatient.material-estimate.cancel', '/material-estimates/cancel', inpatientMaterialEstimateRequestInputSchema, inpatientMaterialEstimateResponseSchema),
  admOp('inpatient.material-estimate.save', '/material-estimates/save', inpatientMaterialEstimateSaveInputSchema, inpatientMaterialEstimateResponseSchema),
  admOp('inpatient.material-estimate.confirm', '/material-estimates/confirm', inpatientMaterialEstimateConfirmInputSchema, inpatientMaterialEstimateResponseSchema),
  admOp('inpatient.drg.reservation.replace-batch', '/drg/reservations/replace-batch', inpatientMaterialReservationBatchInputSchema, commandResponseSchema(inpatientMaterialReservationListSchema)),
  admQuery('inpatient.drg.agent.read', '/drg/agent', inpatientDrgAgentSchema),
  admOp('inpatient.drg.agent.confirm', '/drg/agent/confirm', inpatientDrgAgentConfirmInputSchema, inpatientDrgAgentResponseSchema),
  admQuery('inpatient.drg.record-checks.read', '/drg/record-checks', inpatientDrgRecordChecksSchema),
  admQuery('inpatient.drg.record-checks.explanation.read', '/drg/record-checks/explanation', inpatientDrgExplanationSchema),
  admOp('inpatient.drg.record-checks.explain', '/drg/record-checks/explain', inpatientDrgExplainInputSchema, inpatientDrgExplanationResponseSchema),
  admOp('inpatient.drg.review.todo.act', '/drg/review/todos/act', inpatientDrgReviewTodoActionInputSchema, inpatientDrgReviewResponseSchema),
  admOp('inpatient.drg.review.handoff', '/drg/review/handoff', inpatientDrgReviewHandoffInputSchema, inpatientDrgReviewResponseSchema),
  admQuery('inpatient.drg.review.read', '/drg/review', inpatientDrgReviewSchema),
  admQuery('inpatient.drg.followup.read', '/drg/followup', inpatientDrgFollowupSchema),
  admOp('inpatient.drg.followup.start', '/drg/followup/start', inpatientDrgFollowupStartInputSchema, inpatientDrgFollowupResponseSchema),
  admOp('inpatient.drg.followup.stop', '/drg/followup/stop', inpatientDrgFollowupStopInputSchema, inpatientDrgFollowupResponseSchema),
  admQuery('inpatient.drg.pregroup', '/drg/pregroup', inpatientDrgPregroupResultSchema),
  {
    id:'inpatient.drg.simulate',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/simulation',encodeBody:raw=>{const {admissionId:_id,draft}=inpatientDrgSimulationRequestSchema.parse(raw);return {input:draft}}},
    input:inpatientDrgSimulationRequestSchema,
    output:inpatientDrgSimulationSchema,
  },
  admQuery('inpatient.drg.reservation.read', '/drg/reservations', inpatientMaterialReservationListSchema),
  admOp('inpatient.drg.reservation.create', '/drg/reservations', inpatientMaterialReservationCreateInputSchema, commandResponseSchema(inpatientMaterialReservationListSchema)),
  {
    id:'inpatient.drg.reservation.release',
    http:{method:'POST',path:'/api/his/v1/inpatient/admissions/:admissionId/drg/reservations/:reservationId/release',encodeBody:raw=>{const {admissionId:_id,reservationId:_rid,...input}=inpatientMaterialReservationReleaseInputSchema.parse(raw);return {input}}},
    input:inpatientMaterialReservationReleaseInputSchema,
    output:commandResponseSchema(inpatientMaterialReservationListSchema),
  },
  admQuery('inpatient.drg.payer.review.preview', '/drg/payer-review-preview', inpatientDrgPayerReviewPreviewSchema),
  admOp('inpatient.drg.payer.review', '/drg/payer-review', inpatientDrgPayerReviewCreateInputSchema, commandResponseSchema(inpatientDrgPayerReviewListSchema)),
  admQuery('inpatient.drg.payer.reviews', '/drg/payer-reviews', inpatientDrgPayerReviewListSchema),
  admQuery('inpatient.discharge.read', '/discharge', inpatientDischargeEventsSchema),
  admQuery('inpatient.discharge.preview', '/discharge/preview', inpatientSettlementPreviewSchema),
  admQuery('inpatient.payment.read', '/payments', inpatientPaymentsSchema),
  admOp('inpatient.payment.preview', '/payments/preview', inpatientPaymentInputSchema, inpatientPaymentPreviewResponseSchema),
  admOp('inpatient.payment.confirm', '/payments/confirm', inpatientPaymentConfirmInputSchema, inpatientPaymentResponseSchema),
  admOp('inpatient.payment.recover', '/payments/recover', inpatientPaymentRecoverInputSchema, inpatientPaymentResponseSchema),
  admOp('inpatient.refund.preview', '/refunds/preview', inpatientRefundInputSchema, inpatientRefundPreviewResponseSchema),
  admOp('inpatient.refund.confirm', '/refunds/confirm', inpatientRefundConfirmInputSchema, refundResponseSchema),
  admOp('inpatient.refund.recover', '/refunds/recover', inpatientRefundRecoverInputSchema, refundResponseSchema),
  admOp('inpatient.discharge.issue', '/discharge/issue', inpatientDischargeIssueInputSchema, inpatientDischargeResponseSchema),
  admOp('inpatient.discharge.depart', '/discharge/depart', inpatientDepartInputSchema, inpatientDischargeResponseSchema),
  admOp('inpatient.discharge.recall', '/discharge/recall', inpatientDischargeInputSchema, inpatientDischargeResponseSchema),
  admOp('inpatient.discharge.clear', '/discharge/clear', inpatientDischargeInputSchema, inpatientDischargeResponseSchema),
  admOp('inpatient.discharge.settle', '/discharge/settle', inpatientSettleInputSchema, inpatientSettlementResponseSchema),
  admQuery('inpatient.pci-selection.read', '/pci-selection', inpatientPciSelectionSchema),
  admQuery('inpatient.angiography-reports.read', '/angiography-reports', inpatientAngiographyReportsSchema),
  admOp('inpatient.pci-selection.confirm', '/pci-selection/confirm', inpatientPciSelectionConfirmInputSchema, inpatientPciSelectionResponseSchema),
  admOp('inpatient.pci-selection.save', '/pci-selection/save', inpatientPciSelectionSaveInputSchema, inpatientPciSelectionResponseSchema),
  {
    id: 'inpatient.surgery.catalog',
    http: { method: 'GET', path: '/api/his/v1/inpatient/surgery-catalog' },
    input: emptyInputSchema,
    output: inpatientSurgeryCatalogSchema,
  },
  admQuery('inpatient.surgery.read', '/surgeries', inpatientSurgerySchema),
  admOp('inpatient.surgery.request', '/surgeries/request', inpatientSurgeryRequestInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.check-preop', '/surgeries/check-preop', inpatientSurgeryActionInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.confirm-consent', '/surgeries/confirm-consent', inpatientSurgeryConfirmConsentInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.cancel', '/surgeries/cancel', inpatientSurgeryActionInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.start', '/surgeries/start', inpatientSurgeryStartInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.record-material', '/surgeries/record-material', inpatientSurgeryRecordMaterialInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.record-medication', '/surgeries/record-medication', inpatientSurgeryRecordMedicationInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.correct-material', '/surgeries/correct-material', inpatientSurgeryCorrectMaterialInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.supplement-material', '/surgeries/supplement-material', inpatientSurgerySupplementMaterialInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.preview-completion', '/surgeries/preview-completion', inpatientSurgeryCompletionReviewInputSchema, inpatientSurgeryCompletionPreviewSchema),
  admOp('inpatient.surgery.complete', '/surgeries/complete', inpatientSurgeryCompleteInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.execute', '/surgeries/execute', inpatientSurgeryExecuteInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.convert-to-pci', '/surgeries/convert-to-pci', inpatientSurgeryConvertToPciInputSchema, inpatientSurgeryResponseSchema),
  admOp('inpatient.surgery.finalize-standby', '/surgeries/finalize-standby', inpatientSurgeryFinalizeStandbyInputSchema, inpatientSurgeryResponseSchema),
  {
    id:'inpatient.investigation.catalog',
    http:{method:'GET',path:'/api/his/v1/inpatient/investigation-catalog'},
    input:emptyInputSchema,
    output:inpatientInvestigationCatalogSchema,
  },
  admQuery('inpatient.investigation.read', '/investigations', inpatientInvestigationsSchema, z.object({ admissionId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/) }).strict()),
  {
    id:'inpatient.transfer.catalog',
    http:{method:'GET',path:'/api/his/v1/inpatient/transfer-catalog'},
    input:emptyInputSchema,
    output:inpatientTransferCatalogSchema,
  },
  admQuery('inpatient.transfer.read', '/transfers', inpatientTransfersSchema, z.object({ admissionId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/) }).strict()),
  {
    id:'inpatient.transfer.incoming',
    http:{method:'GET',path:'/api/his/v1/inpatient/transfers/incoming'},
    input:emptyInputSchema,
    output:inpatientIncomingTransfersSchema,
  },
  admOp('inpatient.investigation.issue', '/investigations/issue', inpatientInvestigationIssueInputSchema, inpatientInvestigationResponseSchema),
  admOp('inpatient.investigation.send', '/investigations/send', inpatientInvestigationActionInputSchema, inpatientInvestigationResponseSchema),
  admOp('inpatient.investigation.cancel', '/investigations/cancel', inpatientInvestigationActionInputSchema, inpatientInvestigationResponseSchema),
  admOp('inpatient.investigation.retry', '/investigations/retry', inpatientInvestigationActionInputSchema, inpatientInvestigationResponseSchema),
  admOp('inpatient.investigation.acknowledge', '/investigations/acknowledge', inpatientInvestigationAcknowledgeInputSchema, inpatientInvestigationResponseSchema),
  admOp('inpatient.transfer.request', '/transfers/request', inpatientTransferRequestInputSchema, inpatientTransferResponseSchema),
  admOp('inpatient.transfer.handover', '/transfers/handover', inpatientTransferActionInputSchema, inpatientTransferResponseSchema),
  admOp('inpatient.transfer.receive', '/transfers/receive', inpatientTransferReceiveInputSchema, inpatientTransferResponseSchema),
  admOp('inpatient.transfer.cancel', '/transfers/cancel', inpatientTransferActionInputSchema, inpatientTransferResponseSchema),
  {
    id: 'inpatient.pharmacy.list',
    http: { method: 'GET', path: '/api/his/v1/inpatient/pharmacy/admissions' },
    input: emptyInputSchema,
    output: inpatientPharmacyListSchema,
  },
  admQuery('inpatient.pharmacy.read', '/pharmacy', inpatientPharmacySchema),
  admQuery('inpatient.charges.read', '/charges', inpatientChargesSchema),
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
    id: 'admin.authored-case-pack.read',
    http: { method: 'GET', path: '/api/sim/v1/synthetic-cases/authored-pack' },
    input: emptyInputSchema,
    output: authoredCasePackSummarySchema,
  },
  {
    id: 'admin.authored-case-pack.prepare',
    http: { method: 'POST', path: '/api/sim/v1/synthetic-cases/authored-pack/prepare', encodeBody: raw => ({ input: authoredCasePackPrepareRequestSchema.shape.input.parse(raw) }) },
    input: authoredCasePackPrepareRequestSchema.shape.input,
    output: authoredCasePackPrepareResponseSchema,
  },
  {
    id: 'admin.disease-packs.exam.run',
    http: {
      method: 'POST',
      path: '/api/his/v1/admin/disease-packs/exam/run',
      encodeBody: raw => adminDiseasePackExamRunInputSchema.parse(raw),
    },
    input: adminDiseasePackExamRunInputSchema,
    output: dsapExamRunResponseSchema,
  },
  {
    id: 'admin.disease-packs.activate',
    http: {
      method: 'POST',
      path: '/api/his/v1/admin/disease-packs/:packId/activate',
      encodeBody: (raw: unknown) => {
        const { packId: _packId, ...rest } = adminDiseasePackActivateInputSchema.parse(raw)
        return rest
      },
    },
    input: adminDiseasePackActivateInputSchema,
    output: diseasePackActivationGateResponseSchema,
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
  admQuery('inpatient.clinical.read', '/clinical', inpatientFullClinicalSchema),
  admOp('inpatient.vital-signs.record', '/vital-signs', inpatientVitalSignsInputSchema, inpatientFullClinicalResponseSchema),
  {
    id: 'inpatient.risk-assessment.record',
    http: { method: 'PUT', path: '/api/his/v1/inpatient/admissions/:admissionId/risk-assessment', encodeBody: raw => { const { admissionId: _id, ...input } = inpatientRiskAssessmentInputSchema.parse(raw); return { input } } },
    input: inpatientRiskAssessmentInputSchema,
    output: inpatientFullClinicalResponseSchema,
  },
  admQuery('inpatient.clinical-scores.read', '/clinical-scores', clinicalScoreBundleSchema),
  admQuery('inpatient.bedside-questionnaire.read', '/bedside-questionnaire', bedsideQuestionnaireStateSchema, inpatientBedsideQuestionnaireReadInputSchema),
  {
    id: 'inpatient.bedside-questionnaire.record',
    http: {
      method: 'PUT',
      path: '/api/his/v1/inpatient/admissions/:admissionId/bedside-questionnaire',
      encodeBody: (raw: unknown) => {
        const { admissionId: _id, ...input } = inpatientBedsideQuestionnaireRecordInputSchema.parse(raw)
        return { input }
      },
    },
    input: inpatientBedsideQuestionnaireRecordInputSchema,
    output: bedsideQuestionnaireResponseSchema,
  },
  admQuery('inpatient.clinical-fact-ledger.read', '/clinical-fact-ledger', clinicalFactLedgerSchema, inpatientClinicalFactLedgerQuerySchema),
  admOp('inpatient.clinical-fact-verification.record', '/clinical-fact-verifications', inpatientClinicalFactVerificationInputSchema, clinicalFactVerificationResponseSchema),
  admQuery('inpatient.clinical-quality.read', '/clinical-quality', clinicalQualityCheckSchema, inpatientClinicalQualityInputSchema),
  admQuery('inpatient.order-set-drafts.read', '/order-set-drafts', orderSetDraftBundleSchema, inpatientOrderSetDraftsInputSchema),
  admQuery('inpatient.disease-packs.read', '/disease-packs', diseasePackRuntimeBundleSchema, inpatientDiseasePackReadQuerySchema),
  admQuery('inpatient.clinical-prompts.read', '/clinical-prompts', clinicalPromptBundleSchema, inpatientClinicalPromptReadInputSchema),
  {
    id: 'inpatient.clinical-prompts.dismiss',
    http: {
      method: 'POST',
      path: '/api/his/v1/inpatient/admissions/:admissionId/clinical-prompts/:cardId/dismiss',
      encodeBody: (raw: unknown) => {
        const { admissionId: _admissionId, cardId: _cardId, ...input } = inpatientClinicalPromptDismissInputSchema.parse(raw)
        return { input }
      },
    },
    input: inpatientClinicalPromptDismissInputSchema,
    output: clinicalPromptDismissResponseSchema,
  },
  {
    id: 'inpatient.disease-packs.toggle',
    http: {
      method: 'POST',
      path: '/api/his/v1/inpatient/admissions/:admissionId/disease-packs/:packId/toggle',
      encodeBody: (raw: unknown) => {
        const { admissionId: _admissionId, packId: _packId, ...input } = inpatientDiseasePackToggleInputSchema.parse(raw)
        return { input }
      },
    },
    input: inpatientDiseasePackToggleInputSchema,
    output: diseasePackToggleResponseSchema,
  },
  {
    id: 'inpatient.disease-pack-task-readiness.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/disease-packs/:packId/tasks/:taskId/readiness' },
    input: inpatientDiseasePackTaskQuerySchema,
    output: diseasePackTaskReadinessResultSchema,
  },
  {
    id: 'inpatient.disease-pack-task-facts.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/disease-packs/:packId/tasks/:taskId/facts' },
    input: inpatientDiseasePackTaskQuerySchema,
    output: diseasePackTaskFactsResponseSchema,
  },
  {
    id: 'inpatient.disease-pack-tools.authorize',
    http: {
      method: 'POST',
      path: '/api/his/v1/inpatient/admissions/:admissionId/disease-packs/:packId/tools/authorize',
      encodeBody: (raw: unknown) => {
        const { admissionId: _admissionId, packId: _packId, ...input } = inpatientDiseasePackToolAuthorizeInputSchema.parse(raw)
        return { input }
      },
    },
    input: inpatientDiseasePackToolAuthorizeInputSchema,
    output: diseasePackToolAuthorizeResponseSchema,
  },
  {
    id: 'inpatient.disease-pack-knowledge.read',
    http: { method: 'GET', path: '/api/his/v1/inpatient/admissions/:admissionId/disease-packs/:packId/knowledge' },
    input: inpatientDiseasePackKnowledgeInputSchema,
    output: diseasePackKnowledgeEvaluationSchema,
  },
  admOp('inpatient.diagnosis.confirm', '/diagnoses/confirm', inpatientDiagnosisConfirmInputSchema, inpatientFullClinicalResponseSchema),
  admOp('inpatient.order.issue', '/orders/issue', inpatientOrderIssueInputSchema, inpatientFullClinicalResponseSchema),
  admOp('inpatient.order.verify', '/orders/verify', inpatientOrderActionInputSchema, inpatientFullClinicalResponseSchema),
  admOp('inpatient.order.request-stop', '/orders/request-stop', inpatientOrderReasonInputSchema, inpatientFullClinicalResponseSchema),
  admOp('inpatient.order.verify-stop', '/orders/verify-stop', inpatientOrderActionInputSchema, inpatientFullClinicalResponseSchema),
  admOp('inpatient.execution.dispense', '/executions/dispense', inpatientDispenseInputSchema, inpatientPharmacyResponseSchema),
  admOp('inpatient.execution.administer', '/executions/administer', inpatientExecutionActionInputSchema, inpatientFullClinicalResponseSchema),
  admOp('inpatient.execution.complete', '/executions/complete', inpatientExecutionActionInputSchema, inpatientFullClinicalResponseSchema),
  admOp('inpatient.charge.reverse', '/charges/reverse', inpatientChargeReverseInputSchema, inpatientChargesResponseSchema),
  admOp('inpatient.execution.request-prn', '/executions/request-prn', inpatientOrderReasonInputSchema, inpatientFullClinicalResponseSchema),
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
  admQuery('inpatient.admission.read', '', inpatientDetailSchema),
  {
    id: 'inpatient.admission.register',
    http: { method: 'POST', path: '/api/his/v1/inpatient/admissions', encodeBody: raw => ({ input: inpatientRegistrationInputSchema.parse(raw) }) },
    input: inpatientRegistrationInputSchema,
    output: inpatientCommandResponseSchema,
  },
  admOp('inpatient.admission.receive', '/receive', inpatientBedInputSchema, inpatientCommandResponseSchema),
  admOp('inpatient.admission.move-bed', '/move-bed', inpatientBedInputSchema, inpatientCommandResponseSchema),
  admOp('inpatient.admission.swap-bed', '/swap-bed', inpatientSwapInputSchema, inpatientSwapResponseSchema),
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
