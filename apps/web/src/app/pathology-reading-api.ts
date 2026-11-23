import { pathologyReadingConfigSchema, pathologyReadingMessageSchema, pathologyReadingSessionSchema,
  pathologyReadingSessionStateSchema, pathologyReadingStatusSchema,
  type PathologyReadingConfig, type PathologyReadingMessage, type PathologyReadingSessionInput } from '@clinmesh/contracts/pathology-reading'
import { apiGet, apiMutation } from './api-client.ts'

export const getPathologyReadingStatus = (signal?: AbortSignal) => apiGet('/api/sim/v1/admin/pathology-reading/status', pathologyReadingStatusSchema, signal)
export const configurePathologyReading = (input: Omit<PathologyReadingConfig, 'version'> & { expectedVersion: number }, key: string) =>
  apiMutation('/api/sim/v1/admin/pathology-reading/config', pathologyReadingConfigSchema, input, { method: 'PUT', idempotencyKey: key })
export const openPathologyReading = (requestId: string, input: PathologyReadingSessionInput, key: string) =>
  apiMutation(`/api/his/v1/pathology-requests/${encodeURIComponent(requestId)}/reading-sessions`, pathologyReadingSessionSchema, input, { idempotencyKey: key })
export const getPathologyReading = (id: string, signal?: AbortSignal) =>
  apiGet(`/api/his/v1/pathology-reading/sessions/${encodeURIComponent(id)}`, pathologyReadingSessionStateSchema, signal)
export const markPathologyReadingDisplayed = (id: string, message: PathologyReadingMessage) =>
  apiMutation(`/api/his/v1/pathology-reading/sessions/${encodeURIComponent(id)}/displayed`, pathologyReadingSessionStateSchema, pathologyReadingMessageSchema.parse(message))
export const closePathologyReading = (id: string, key: string) =>
  apiMutation(`/api/his/v1/pathology-reading/sessions/${encodeURIComponent(id)}`, pathologyReadingSessionStateSchema, {}, { method: 'DELETE', idempotencyKey: key })
