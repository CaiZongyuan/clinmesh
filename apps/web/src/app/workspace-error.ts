import { ApiClientError } from './api-client.ts'
import type { WorkspaceMessages } from './workspace-i18n.ts'

function getConflictOwner(
  owner: NonNullable<ApiClientError['conflict']>['owner'],
  messages: WorkspaceMessages,
): string {
  switch (owner) {
    case 'clinical-document': return messages.conflictOwner_clinicalDocument
    case 'laboratory-report': return messages.conflictOwner_laboratoryReport
    case 'laboratory-request': return messages.conflictOwner_laboratoryRequest
    case 'laboratory-request-draft': return messages.conflictOwner_laboratoryRequestDraft
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
  if (!(error instanceof ApiClientError)) return error.message
  if (error.status === 401 || error.code === 'AUTHENTICATION_REQUIRED') {
    return messages.authenticationRequiredDescription
  }
  if (error.status === 403 || ['CSRF_FAILED', 'ROLE_NOT_ALLOWED'].includes(error.code)) {
    return messages.permissionDeniedDescription
  }
  if (error.code === 'INVALID_INPUT') return messages.invalidInputDescription
  if (error.code === 'CATALOG_CONFLICT') return messages.catalogConflictDescription
  if (error.code === 'DIAGNOSIS_PRIMARY_REQUIRED') {
    return messages.diagnosisPrimaryRequiredDescription
  }
  if (error.code === 'DUPLICATE_PATIENT') return messages.duplicatePatientDescription
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
