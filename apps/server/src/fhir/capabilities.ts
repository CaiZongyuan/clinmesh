import {
  type CapabilityStatement,
  fhirCapabilityRegistry,
  getFhirResourceCapability,
  getFhirResourceOwnership,
  getFhirResourceSearchParameters,
  isSupportedFhirResourceType,
  isSupportedFhirSearchParameter,
  type FhirResourceOwnerKind,
  type FhirSearchCapability,
} from '@clinmesh/contracts/fhir'

export type { FhirResourceOwnerKind }
export type SearchCapability = FhirSearchCapability
export {
  getFhirResourceCapability as getResourceCapability,
  getFhirResourceOwnership as getResourceOwnership,
  getFhirResourceSearchParameters as getResourceSearchParameters,
  isSupportedFhirResourceType as isSupportedResourceType,
  isSupportedFhirSearchParameter as isSupportedSearchParameter,
}

function ownershipDocumentation(ownerKind: FhirResourceOwnerKind): string {
  if (ownerKind === 'domain-projection') {
    return 'Read-only projection of a domain-owned aggregate; generic FHIR writes are not supported.'
  }
  if (ownerKind === 'fhir-native-immutable') {
    return 'Immutable FHIR-native resource; corrections create a new resource through the owning command.'
  }
  return 'FHIR-native resource; workflow state transitions use the owning business command.'
}

export function createCapabilityStatement(options: { includeResources?: boolean } = {}): CapabilityStatement {
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
    fhirVersion: fhirCapabilityRegistry.fhirVersion,
    format: ['application/fhir+json'],
    rest: [{
      mode: 'server',
      ...(options.includeResources === true
        ? {
            resource: fhirCapabilityRegistry.resources.map(resourceCapability => ({
              type: resourceCapability.type,
              documentation: ownershipDocumentation(resourceCapability.ownerKind),
              interaction: resourceCapability.interactions.map(code => ({ code })),
              searchParam: resourceCapability.searchParameters.map(parameter => ({
                name: parameter.name,
                definition: parameter.definition,
                ...(parameter.target === undefined ? {} : { target: parameter.target }),
                type: parameter.type,
              })),
            })),
          }
        : {}),
    }],
  }
}
