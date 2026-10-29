import { expect, it } from 'vitest'
import { modelBridgeErrorSchema, modelBridgeRequestSchema } from '../src/model-bridge.ts'

it('retires the recording verifier at the model boundary while retaining both document quality stages', () => {
  const request = { operation: 'complete', model: 'synthetic', jsonSchema: {}, systemPrompt: 'Synthetic request', userPayload: {} }
  expect(modelBridgeRequestSchema.safeParse({ ...request, schemaName: 'consultation_history_verification' }).success).toBe(false)
  for (const schemaName of ['consultation_history_summary', 'clinical_document_quality', 'clinical_document_quality_verification']) {
    expect(modelBridgeRequestSchema.safeParse({ ...request, schemaName }).success).toBe(true)
  }
})

it('accepts only bounded safe retry metadata on rate-limit bridge errors', () => {
  expect(modelBridgeErrorSchema.parse({ error: 'MODEL_RATE_LIMIT', retryAfterMs: 600_000 }))
    .toEqual({ error: 'MODEL_RATE_LIMIT', retryAfterMs: 600_000 })
  expect(modelBridgeErrorSchema.parse({ error: 'MODEL_RATE_LIMIT' })).toEqual({ error: 'MODEL_RATE_LIMIT' })
})

it.each(['inpatient_drg_recommendation', 'inpatient_drg_verification'])('accepts the inpatient DRG stage %s at the same bridge boundary', schemaName => {
  expect(modelBridgeRequestSchema.safeParse({ operation: 'complete', model: 'synthetic', jsonSchema: {},
    systemPrompt: 'Synthetic inpatient request', userPayload: {}, schemaName }).success).toBe(true)
})

it.each([
  { error: 'MODEL_RATE_LIMIT', retryAfterMs: -1 },
  { error: 'MODEL_RATE_LIMIT', retryAfterMs: 0 },
  { error: 'MODEL_RATE_LIMIT', retryAfterMs: 0.5 },
  { error: 'MODEL_RATE_LIMIT', retryAfterMs: 600_001 },
  { error: 'MODEL_RATE_LIMIT', retryAfterMs: '1000' },
  { error: 'MODEL_RATE_LIMIT', message: 'private synthetic provider detail' },
  { error: 'MODEL_AUTH_FAILED', retryAfterMs: 1000 },
])('rejects invalid or private bridge error metadata: %j', value => {
  expect(modelBridgeErrorSchema.safeParse(value).success).toBe(false)
})
