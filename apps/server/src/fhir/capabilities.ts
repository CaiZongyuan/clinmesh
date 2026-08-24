import type { CapabilityStatement } from '@clinmesh/contracts/fhir'

const readSearchInteractions = ['read', 'vread', 'history-instance', 'search-type'] as const

export type FhirResourceOwnerKind =
  | 'domain-projection'
  | 'fhir-native'
  | 'fhir-native-immutable'

interface SearchCapability {
  definition: string
  name: string
  type: 'reference' | 'string' | 'token'
}

interface ResourceCapability {
  interactions: typeof readSearchInteractions
  ownerKind: FhirResourceOwnerKind
  searchParameters: SearchCapability[]
  type: string
}

function resource(
  type: string,
  ownerKind: FhirResourceOwnerKind = 'fhir-native',
  searchParameters: SearchCapability[] = [],
): ResourceCapability {
  return { interactions: readSearchInteractions, ownerKind, searchParameters, type }
}

const capabilityRegistry = {
  fhirVersion: '5.0.0',
  resources: [
    resource('Patient', 'fhir-native', [{
      name: 'name',
      definition: 'http://hl7.org/fhir/SearchParameter/Patient-name',
      type: 'string',
    }, {
      name: 'identifier',
      definition: 'http://hl7.org/fhir/SearchParameter/Patient-identifier',
      type: 'token',
    }]),
    resource('AllergyIntolerance', 'fhir-native', [{
      name: 'patient',
      definition: 'http://hl7.org/fhir/SearchParameter/clinical-patient',
      type: 'reference',
    }]),
    ...[
      'Organization',
      'Location',
      'Practitioner',
      'PractitionerRole',
      'Encounter',
      'Task',
      'Account',
      'ChargeItem',
      'Observation',
      'ServiceRequest',
      'Specimen',
      'DiagnosticReport',
      'Condition',
      'Medication',
      'MedicationRequest',
      'MedicationDispense',
    ].map(type => resource(type)),
    resource('Composition', 'fhir-native-immutable'),
    resource('Bundle', 'fhir-native-immutable'),
    resource('Provenance', 'fhir-native-immutable'),
    resource('InventoryItem', 'domain-projection'),
    resource('AuditEvent', 'domain-projection'),
  ],
} as const

export function getResourceCapability(resourceType: string): ResourceCapability | undefined {
  return capabilityRegistry.resources.find(candidate => candidate.type === resourceType)
}

export function getResourceOwnership(resourceType: string): FhirResourceOwnerKind | undefined {
  return getResourceCapability(resourceType)?.ownerKind
}

export function isSupportedResourceType(resourceType: string): boolean {
  return getResourceCapability(resourceType) !== undefined
}

export function isSupportedSearchParameter(resourceType: string, parameter: string): boolean {
  return getResourceCapability(resourceType)?.searchParameters.some(
    searchParameter => searchParameter.name === parameter,
  ) ?? false
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
    fhirVersion: capabilityRegistry.fhirVersion,
    format: ['application/fhir+json'],
    rest: [{
      mode: 'server',
      ...(options.includeResources === true
        ? {
            resource: capabilityRegistry.resources.map(resourceCapability => ({
              type: resourceCapability.type,
              documentation: ownershipDocumentation(resourceCapability.ownerKind),
              interaction: resourceCapability.interactions.map(code => ({ code })),
              searchParam: resourceCapability.searchParameters.map(parameter => ({
                name: parameter.name,
                definition: parameter.definition,
                type: parameter.type,
              })),
            })),
          }
        : {}),
    }],
  }
}
