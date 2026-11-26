import { expect, it } from 'vitest'
import {
  dshDefaultModel,
  dshFastModel,
  dshModelForTier,
  dshTierForModel,
  modelBridgeErrorSchema,
  modelBridgeRequestSchema,
  modelCapabilitiesRequestSchema,
  modelCapabilitiesResponseSchema,
  modelTaskTierByFeature,
} from '../src/model-bridge.ts'
import { modelUsageFeatureSchema } from '../src/model-usage.ts'

it('retires the recording verifier at the model boundary while retaining both document quality stages', () => {
  const request = { operation: 'complete', model: 'synthetic', jsonSchema: {}, systemPrompt: 'Synthetic request', userPayload: {} }
  expect(modelBridgeRequestSchema.safeParse({ ...request, schemaName: 'consultation_history_verification' }).success).toBe(false)
  for (const schemaName of ['consultation_history_summary', 'clinical_document_quality', 'clinical_document_quality_verification']) {
    expect(modelBridgeRequestSchema.safeParse({ ...request, schemaName }).success).toBe(true)
  }
})

it('accepts optional resolve tiers while rejecting unknown tiers or extra fields', () => {
  expect(modelBridgeRequestSchema.parse({ operation: 'resolve' })).toEqual({ operation: 'resolve' })
  expect(modelBridgeRequestSchema.parse({ operation: 'resolve', tier: 'strong' })).toEqual({ operation: 'resolve', tier: 'strong' })
  expect(modelBridgeRequestSchema.parse({ operation: 'resolve', tier: 'fast' })).toEqual({ operation: 'resolve', tier: 'fast' })
  expect(modelBridgeRequestSchema.safeParse({ operation: 'resolve', tier: 'medium' }).success).toBe(false)
  expect(modelBridgeRequestSchema.safeParse({ operation: 'resolve', tier: 'fast', extra: true }).success).toBe(false)
})

it('maps every model usage feature to its strong or fast tier and DSH sentinel', () => {
  const allFeatures = modelUsageFeatureSchema.options
  expect(Object.keys(modelTaskTierByFeature).sort()).toEqual([...allFeatures].sort())
  const expectedFast = [
    'doctor_delegation',
    'patient_dialogue_reply',
    'consultation_history_summary',
    'consultation_history_increment',
    'doctor_recommendation_history_selection',
    'doctor_recommendation_history_consolidation',
    'doctor_recommendation_catalog_selection',
    'patient_persona',
    'investigation_result',
    'investigation_service_result',
    'laboratory_service_enrichment',
  ] as const
  const expectedStrong = [
    'doctor_recommendations',
    'doctor_recommendation_verification',
    'clinical_document_quality',
    'clinical_document_quality_verification',
    'inpatient_drg_recommendation',
    'inpatient_drg_verification',
  ] as const
  for (const feature of expectedFast) expect(modelTaskTierByFeature[feature]).toBe('fast')
  for (const feature of expectedStrong) expect(modelTaskTierByFeature[feature]).toBe('strong')
  expect(dshModelForTier('strong')).toBe(dshDefaultModel)
  expect(dshModelForTier('fast')).toBe(dshFastModel)
  expect(dshTierForModel(dshDefaultModel)).toBe('strong')
  expect(dshTierForModel(dshFastModel)).toBe('fast')
  expect(dshTierForModel('dsh:{"provider":"a","model":"b"}')).toBeUndefined()
})

it('validates the narrow read-only model capabilities contract', () => {
  expect(modelCapabilitiesRequestSchema.parse({ provider: 'deepseek', model: 'deepseek-reasoner' }))
    .toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  expect(modelCapabilitiesRequestSchema.safeParse({ provider: 'deepseek', model: 'm', extra: 1 }).success).toBe(false)
  expect(modelCapabilitiesResponseSchema.parse({
    efforts: [
      { id: 'low', name: 'Low', description: 'Fast reasoning' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'high',
  })).toEqual({
    efforts: [
      { id: 'low', name: 'Low', description: 'Fast reasoning' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'high',
  })
  expect(modelCapabilitiesResponseSchema.parse({ efforts: [] })).toEqual({ efforts: [] })
  expect(modelCapabilitiesResponseSchema.safeParse({ efforts: [{ id: '', name: 'Bad' }] }).success).toBe(false)
  expect(modelCapabilitiesResponseSchema.safeParse({ efforts: [], apiKey: 'secret' }).success).toBe(false)
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
