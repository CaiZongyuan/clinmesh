import { capabilityStatementSchema } from '@clinmesh/contracts/fhir'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'

describe('FHIR metadata endpoint', () => {
  it('declares only the implemented R5 server capabilities', async () => {
    const response = await createApp().request('/fhir/R5/metadata')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/fhir+json')
    expect(capabilityStatementSchema.parse(await response.json())).toMatchObject({
      resourceType: 'CapabilityStatement',
      status: 'active',
      kind: 'instance',
      fhirVersion: '5.0.0',
      format: ['application/fhir+json'],
      rest: [{ mode: 'server', resource: [] }],
    })
  })
})
