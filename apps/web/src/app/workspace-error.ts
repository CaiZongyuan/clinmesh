import { ApiClientError } from './api-client.ts'
import type { WorkspaceMessages } from './workspace-i18n.ts'

function getConflictOwner(
  owner: NonNullable<ApiClientError['conflict']>['owner'],
  messages: WorkspaceMessages,
): string {
  switch (owner) {
    case 'clinical-document': return messages.conflictOwner_clinicalDocument
    case 'imaging-report': return messages.conflictOwner_imagingReport
    case 'imaging-request': return messages.conflictOwner_imagingRequest
    case 'imaging-request-draft': return messages.conflictOwner_imagingRequestDraft
    case 'laboratory-report': return messages.conflictOwner_laboratoryReport
    case 'laboratory-request': return messages.conflictOwner_laboratoryRequest
    case 'laboratory-request-draft': return messages.conflictOwner_laboratoryRequestDraft
    case 'pathology-report': return messages.conflictOwner_pathologyReport
    case 'pathology-request': return messages.conflictOwner_pathologyRequest
    case 'pathology-request-draft': return messages.conflictOwner_pathologyRequestDraft
    case 'prescription': return messages.conflictOwner_prescription
    case 'prescription-draft': return messages.conflictOwner_prescriptionDraft
  }
}

function getConflictStatus(
  owner: NonNullable<ApiClientError['conflict']>['owner'],
  status: NonNullable<NonNullable<ApiClientError['conflict']>['currentStatus']>,
  messages: WorkspaceMessages,
): string {
  switch (status) {
    case 'accepted': return messages.laboratoryRequestStatus_accepted
    case 'acknowledged': return messages.laboratoryRequestStatus_acknowledged
    case 'cancelled': return messages.laboratoryRequestStatus_cancelled
    case 'closed': return messages.conflictStatus_closed
    case 'dispensed': return messages.prescriptionStatus_dispensed
    case 'dispensing-started': return messages.conflictStatus_dispensingStarted
    case 'draft': return messages.conflictStatus_draft
    case 'empty': return messages.conflictStatus_empty
    case 'generation-failed': return messages.laboratoryRequestStatus_generationFailed
    case 'in-progress': return messages.laboratoryRequestStatus_inProgress
    case 'issued': return messages.laboratoryRequestStatus_issued
    case 'missing': return messages.conflictStatus_missing
    case 'paid': return messages.prescriptionStatus_paid
    case 'reported': return messages.laboratoryRequestStatus_reported
    case 'signed': return owner === 'clinical-document'
      ? messages.conflictStatus_clinicalDocumentSigned
      : messages.prescriptionStatus_signed
    case 'superseded': return messages.conflictStatus_superseded
    case 'withdrawn': return messages.prescriptionStatus_withdrawn
  }
}

function getConflictMessage(
  error: ApiClientError,
  messages: WorkspaceMessages,
): string | undefined {
  const conflict = error.conflict
  if (conflict === undefined) return undefined
  const owner = getConflictOwner(conflict.owner, messages)
  if (conflict.currentStatus === undefined) {
    if (conflict.currentVersion !== undefined && conflict.expectedVersion !== undefined) {
      return messages.conflictExpectedVersionDescription
        .replace('{owner}', owner)
        .replace('{currentVersion}', conflict.currentVersion)
        .replace('{expectedVersion}', conflict.expectedVersion)
    }
    if (conflict.currentVersion !== undefined) {
      return messages.conflictVersionDescription
        .replace('{owner}', owner)
        .replace('{currentVersion}', conflict.currentVersion)
    }
    return undefined
  }
  const status = getConflictStatus(conflict.owner, conflict.currentStatus, messages)
  if (conflict.currentVersion !== undefined && conflict.expectedVersion !== undefined) {
    return messages.conflictStatusExpectedVersionDescription
      .replace('{owner}', owner)
      .replace('{status}', status)
      .replace('{currentVersion}', conflict.currentVersion)
      .replace('{expectedVersion}', conflict.expectedVersion)
  }
  if (conflict.currentVersion === undefined) {
    return messages.conflictStatusDescription
      .replace('{owner}', owner)
      .replace('{status}', status)
  }
  return messages.conflictStatusVersionDescription
    .replace('{owner}', owner)
    .replace('{status}', status)
    .replace('{currentVersion}', conflict.currentVersion)
}

export function getWorkspaceErrorTitle(
  error: Error,
  messages: WorkspaceMessages,
  fallback: string,
): string {
  if (!(error instanceof ApiClientError)) return fallback
  if (error.status === 401) return messages.authenticationRequired
  if (error.status === 403) return messages.permissionDenied
  if (error.status === 409) return messages.operationConflict
  return fallback
}

export function getWorkspaceErrorMessage(
  error: Error,
  messages: WorkspaceMessages,
  fallback = messages.serviceErrorDescription,
): string {
  if (!(error instanceof ApiClientError)) return fallback
  if (error.status === 401 || error.code === 'AUTHENTICATION_REQUIRED') {
    return messages.authenticationRequiredDescription
  }
  if (error.status === 403 || ['CSRF_FAILED', 'ROLE_NOT_ALLOWED'].includes(error.code)) {
    return messages.permissionDeniedDescription
  }
  const inpatientMessages: Record<string, string> = {
    INPATIENT_INVESTIGATION_NOT_FOUND: messages.inpatientInvestigationConflictDescription,
    INPATIENT_INVESTIGATION_VERSION_CONFLICT: messages.inpatientInvestigationConflictDescription,
    INPATIENT_INVESTIGATION_STATE_CONFLICT: messages.inpatientInvestigationConflictDescription,
    INPATIENT_INVESTIGATION_UNAVAILABLE: messages.catalogConflictDescription,
    INPATIENT_INVESTIGATION_CATALOG_CONFLICT: messages.catalogConflictDescription,
    INPATIENT_INVESTIGATION_PENDING: messages.inpatientInvestigationPendingDescription,
    INPATIENT_TRANSFER_NOT_FOUND: messages.inpatientTransferConflictDescription,
    INPATIENT_TRANSFER_VERSION_CONFLICT: messages.inpatientTransferConflictDescription,
    INPATIENT_TRANSFER_STATE_CONFLICT: messages.inpatientTransferConflictDescription,
    INPATIENT_TRANSFER_TARGET_INVALID: messages.inpatientTransferConflictDescription,
    INPATIENT_TRANSFER_PENDING: messages.inpatientTransferConflictDescription,
    INPATIENT_TRANSFER_ORDERS_PENDING: messages.inpatientTransferPendingDescription,
    INPATIENT_TRANSFER_EXECUTIONS_PENDING: messages.inpatientTransferPendingDescription,
    INPATIENT_TRANSFER_INVESTIGATIONS_PENDING: messages.inpatientTransferPendingDescription,
    INPATIENT_BED_UNAVAILABLE: messages.inpatientBedOccupiedDescription,
    INPATIENT_BED_OCCUPIED: messages.inpatientBedOccupiedDescription,
    INPATIENT_BED_INVALID: messages.inpatientBedInvalidDescription,
    INPATIENT_WARD_NOT_FOUND: messages.inpatientWardUnavailableDescription,
    INPATIENT_NOT_FOUND: messages.inpatientNotFoundDescription,
    INPATIENT_STATE_CONFLICT: messages.inpatientStateConflictDescription,
    INPATIENT_SWAP_INVALID: messages.inpatientStateConflictDescription,
    INPATIENT_REFERRAL_INVALID: messages.inpatientReferralInvalidDescription,
    INPATIENT_SOURCE_INVALID: messages.inpatientSourceInvalidDescription,
    INPATIENT_SOURCE_AMBIGUOUS: messages.inpatientSourceInvalidDescription,
    INPATIENT_SURGERY_CONFLICT: messages.inpatientSurgeryConflictDescription,
    INPATIENT_SURGERY_NOT_FOUND: messages.inpatientSurgeryConflictDescription,
    INPATIENT_SURGERY_NOT_READY: messages.inpatientSurgeryNotReadyDescription,
    INPATIENT_SURGERY_EXECUTION_REQUIRED: messages.inpatientSurgeryExecutionRequiredDescription,
    INPATIENT_SURGERY_TIME_CONFLICT: messages.inpatientSurgeryTimeDescription,
    INPATIENT_SURGERY_PENDING: messages.inpatientSurgeryPendingDescription,
    INPATIENT_ORDER_CONFLICT: messages.inpatientOrderConflictDescription,
    INPATIENT_ORDER_NOT_FOUND: messages.inpatientOrderConflictDescription,
    INPATIENT_EXECUTION_CONFLICT: messages.inpatientExecutionConflictDescription,
    INPATIENT_EXECUTION_NOT_FOUND: messages.inpatientExecutionConflictDescription,
    INPATIENT_STOCK_CONFLICT: messages.inpatientStockConflictDescription,
    INPATIENT_DISPENSE_CONFLICT: messages.inpatientDispenseConflictDescription,
    INPATIENT_CHARGE_CONFLICT: messages.inpatientChargeConflictDescription,
    INPATIENT_DIAGNOSIS_CONFLICT: messages.inpatientDiagnosisConflictDescription,
    INPATIENT_INTENT_PENDING: messages.inpatientIntentPendingDescription,
    INPATIENT_INTENT_CONTEXT_CHANGED: messages.inpatientContextChangedDescription,
    INPATIENT_EPOCH_CONFLICT: messages.inpatientContextChangedDescription,
    SCENARIO_RUN_MISMATCH: messages.inpatientContextChangedDescription,
    INPATIENT_INTENT_STORAGE_UNAVAILABLE: messages.inpatientIntentStorageDescription,
    VIRTUAL_TIME_CONFLICT: messages.virtualTimeConflictDescription,
    VIRTUAL_TIME_ADVANCE_LIMIT: messages.virtualTimeLimitDescription,
  }
  const inpatientMessage = inpatientMessages[error.code]
  if (inpatientMessage !== undefined) return inpatientMessage
  if (error.code === 'SCENARIO_GENERATION_RUNNING') return messages.scenarioGenerationRunningDescription
  if (error.code === 'INVALID_INPUT') return messages.invalidInputDescription
  if (error.code === 'NETWORK_ERROR') return messages.networkErrorDescription
  if (error.code === 'REQUEST_TIMEOUT') return messages.requestTimeoutDescription
  if (error.code === 'UNEXPECTED_RESPONSE') return messages.unexpectedResponseDescription
  if (error.code === 'AI_AUTH_FAILED') return messages.aiAuthenticationFailedDescription
  if (error.code === 'AI_REQUEST_FAILED') return messages.aiRequestFailedDescription
  if (error.code === 'AI_TIMEOUT') return messages.aiTimeoutDescription
  if (error.code === 'AI_RESPONSE_INVALID') return messages.aiResponseInvalidDescription
  if (error.code === 'AI_REQUEST_TOO_LARGE' || error.code === 'AI_RESPONSE_TOO_LARGE') {
    return messages.aiSizeLimitDescription
  }
  if (error.code === 'LABORATORY_GENERATION_UNSUPPORTED') {
    return messages.laboratoryGenerationUnsupportedDescription
  }
  if (error.code === 'CATALOG_CONFLICT') return messages.catalogConflictDescription
  if (error.code === 'DIAGNOSIS_PRIMARY_REQUIRED') {
    return messages.diagnosisPrimaryRequiredDescription
  }
  if (error.code === 'DUPLICATE_PATIENT') return messages.duplicatePatientDescription
  if (error.code === 'PROFILE_VERSION_CONFLICT') {
    return messages.profileVersionConflictDescription
  }
  if (error.code === 'LABORATORY_REQUEST_DUPLICATE') {
    return messages.laboratoryRequestDuplicateDescription
  }
  const conflictMessage = getConflictMessage(error, messages)
  if (conflictMessage !== undefined) return conflictMessage
  if (error.code === 'LABORATORY_REQUEST_NOT_CANCELLABLE') {
    return messages.laboratoryRequestNotCancellableDescription
  }
  if (error.code === 'LABORATORY_REQUEST_VERSION_CONFLICT') {
    return messages.laboratoryRequestVersionConflictDescription
  }
  if (error.status === 409 || error.code === 'WORKFLOW_CONFLICT') {
    return messages.operationConflictDescription
  }
  return fallback
}
