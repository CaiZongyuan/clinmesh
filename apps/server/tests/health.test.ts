import { healthResponseSchema } from '@clinmesh/contracts/health'
import { describe, expect, it } from 'vitest'
import { app, type ServerBindings } from '../src/app.ts'

const bindings: ServerBindings = {
  ASSETS: {
    fetch: async () => new Response('not found', { status: 404 }),
    connect: () => { throw new Error('Socket connections are not used by this test.') },
  },
}

describe('health endpoint', () => {
  it('returns the declared FHIR version', async () => {
    const response = await app.request('/api/health', undefined, bindings)
    expect(response.status).toBe(200)
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      service: 'clinmesh-server',
      status: 'ok',
      fhirVersion: '5.0.0',
    })
  })
})
