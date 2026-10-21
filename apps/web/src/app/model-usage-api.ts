import { modelUsageAttemptSchema, modelUsageListSchema, modelUsageOverviewSchema,
  type ModelUsageFilter } from '@clinmesh/contracts/model-usage'
import { apiGet } from './api-client.ts'

function query(filters: ModelUsageFilter): string {
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) parameters.set(key, String(value))
  }
  return parameters.toString()
}

export function getModelUsageOverview(filters: ModelUsageFilter, signal?: AbortSignal) {
  return apiGet(`/api/model-usage/overview?${query(filters)}`, modelUsageOverviewSchema, signal)
}

export function getModelUsageRequests(filters: ModelUsageFilter, signal?: AbortSignal) {
  return apiGet(`/api/model-usage/requests?${query(filters)}`, modelUsageListSchema, signal)
}

export function getModelUsageRequest(id: string, signal?: AbortSignal) {
  return apiGet(`/api/model-usage/requests/${encodeURIComponent(id)}`, modelUsageAttemptSchema, signal)
}
