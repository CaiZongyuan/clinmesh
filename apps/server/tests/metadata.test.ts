import { capabilityStatementSchema } from '@clinmesh/contracts/fhir'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { createCapabilityStatement } from '../src/fhir/capabilities.ts'

describe('FHIR metadata endpoint', () => {
  it('declares only the implemented R5 server capabilities', async () => {
    const response = await createApp().request('/fhir/R5/metadata')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/fhir+json')
    const statement = capabilityStatementSchema.parse(await response.json())

    expect(statement).toMatchObject({
      resourceType: 'CapabilityStatement',
      status: 'active',
      kind: 'instance',
      fhirVersion: '5.0.0',
      format: ['application/fhir+json'],
    })
    expect(statement.rest).toEqual([{ mode: 'server' }])
  })

  it('publishes ownership-aware read capabilities from the same registry', () => {
    const statement = capabilityStatementSchema.parse(
      createCapabilityStatement({ includeResources: true }),
    )
    const resources = statement.rest[0]?.resource ?? []
    expect(resources.find(resource => resource.type === 'InventoryItem')).toMatchObject({
      documentation: expect.stringContaining('Read-only projection'),
      interaction: [
        { code: 'read' },
        { code: 'vread' },
        { code: 'history-instance' },
        { code: 'search-type' },
      ],
    })
    expect(resources.find(resource => resource.type === 'Composition')).toMatchObject({
      documentation: expect.stringContaining('Immutable FHIR-native resource'),
    })
    expect(resources.find(resource => resource.type === 'AuditEvent')).toMatchObject({
      documentation: expect.stringContaining('Read-only projection'),
    })
    expect(resources.find(resource => resource.type === 'Condition')).toMatchObject({
      searchParam: [{
        name: 'patient',
        target: ['Patient'],
        type: 'reference',
      }],
    })
    expect(resources.find(resource => resource.type === 'DiagnosticReport')).toMatchObject({
      searchParam: expect.arrayContaining([
        expect.objectContaining({ name: 'patient', target: ['Patient'], type: 'reference' }),
        expect.objectContaining({ name: 'encounter', target: ['Encounter'], type: 'reference' }),
      ]),
    })
    expect(resources.find(resource => resource.type === 'MedicationDispense')).toMatchObject({
      searchParam: expect.arrayContaining([
        expect.objectContaining({ name: 'patient', target: ['Patient'], type: 'reference' }),
        expect.objectContaining({ name: 'prescription', target: ['MedicationRequest'], type: 'reference' }),
      ]),
    })
    expect(resources.find(resource => resource.type === 'Provenance')).toMatchObject({
      searchParam: [{
        name: 'target',
        target: [
          'Bundle',
          'Composition',
          'DiagnosticReport',
          'Observation',
          'ServiceRequest',
          'Specimen',
          'Task',
        ],
        type: 'reference',
      }],
    })
  })
})
