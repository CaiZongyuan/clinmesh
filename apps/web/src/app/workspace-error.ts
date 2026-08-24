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
