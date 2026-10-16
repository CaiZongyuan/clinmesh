import { expect, it } from 'vitest'
import { modelBridgeErrorSchema } from '../src/model-bridge.ts'

it('accepts only bounded safe retry metadata on rate-limit bridge errors', () => {
  expect(modelBridgeErrorSchema.parse({ error: 'MODEL_RATE_LIMIT', retryAfterMs: 600_000 }))
    .toEqual({ error: 'MODEL_RATE_LIMIT', retryAfterMs: 600_000 })
  expect(modelBridgeErrorSchema.parse({ error: 'MODEL_RATE_LIMIT' })).toEqual({ error: 'MODEL_RATE_LIMIT' })
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
