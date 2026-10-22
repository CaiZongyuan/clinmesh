import { modelUsageAttemptSchema, modelUsageControlSchema, modelUsageListSchema, modelUsageOverviewSchema, modelUsageRetentionSchema,
  type ModelUsageControlUpdate, type ModelUsageFilter, type ModelUsageRetentionUpdate } from '@clinmesh/contracts/model-usage'
import { modelPricingConfigSchema } from '@clinmesh/contracts/model-pricing'
import { apiGet, apiMutation, newIdempotencyKey } from './api-client.ts'

export function getModelUsageControl(signal?: AbortSignal) {
  return apiGet('/api/model-usage/control', modelUsageControlSchema, signal)
}

export function getModelUsageRetention(signal?: AbortSignal) {
  return apiGet('/api/model-usage/retention', modelUsageRetentionSchema, signal)
}

export function updateModelUsageRetention(input: ModelUsageRetentionUpdate) {
  return apiMutation('/api/model-usage/retention', modelUsageRetentionSchema, input,
    { method: 'PUT', idempotencyKey: newIdempotencyKey() })
}

export function getModelUsagePricing(signal?: AbortSignal) {
  return apiGet('/api/model-usage/pricing', modelPricingConfigSchema, signal)
}

export function reconcileModelUsage(id: string, input: { expectedRevision: number; evidence: string; totalTokens?: number; cny?: number }) {
  return apiMutation(`/api/model-usage/requests/${encodeURIComponent(id)}/reconcile`, modelUsageAttemptSchema, input,
    { method: 'POST', idempotencyKey: newIdempotencyKey() })
}

export function repriceModelUsage(id: string, input: { expectedRevision: number; evidence: string }) {
  return apiMutation(`/api/model-usage/requests/${encodeURIComponent(id)}/reprice`, modelUsageAttemptSchema, input,
    { method: 'POST', idempotencyKey: newIdempotencyKey() })
}

export function updateModelUsageControl(input: ModelUsageControlUpdate) {
  return apiMutation('/api/model-usage/control', modelUsageControlSchema, input,
    { method: 'PUT', idempotencyKey: newIdempotencyKey() })
}

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
