import type { CapabilityStatement } from '@clinmesh/contracts/fhir'

const capabilityRegistry = {
  fhirVersion: '5.0.0',
  resources: [],
} as const

export function createCapabilityStatement(): CapabilityStatement {
  return {
    resourceType: 'CapabilityStatement',
    url: 'https://caizongyuan.github.io/clinmesh/fhir/CapabilityStatement/clinmesh-server',
    version: '0.0.0',
    name: 'ClinMeshServerCapabilityStatement',
    title: 'ClinMesh FHIR R5 Server Capability Statement',
    status: 'active',
    experimental: true,
    date: '2026-08-23T00:00:00Z',
    publisher: 'ClinMesh',
    kind: 'instance',
    software: {
      name: 'clinmesh-server',
      version: '0.0.0',
    },
    implementation: {
      description: 'ClinMesh synthetic hospital simulation FHIR R5 endpoint',
    },
    fhirVersion: capabilityRegistry.fhirVersion,
    format: ['application/fhir+json'],
    rest: [{
      mode: 'server',
      resource: [...capabilityRegistry.resources],
    }],
  }
}
