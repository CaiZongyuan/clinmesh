import { healthResponseSchema } from '@clinmesh/contracts/health'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'

describe('health endpoint', () => {
  it('returns the declared FHIR version', async () => {
    const response = await createApp().request('/api/health')
    expect(response.status).toBe(200)
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      service: 'clinmesh-server',
      status: 'ok',
      fhirVersion: '5.0.0',
    })
  })
})
