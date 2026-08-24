import { ApiClientError } from './api-client.ts'
import type { WorkspaceMessages } from './workspace-i18n.ts'

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
  if (error.code === 'DUPLICATE_PATIENT') return messages.duplicatePatientDescription
  if (error.status === 409 || error.code === 'WORKFLOW_CONFLICT') {
    return messages.operationConflictDescription
  }
  return fallback
}
