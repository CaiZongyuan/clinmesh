import type { CapabilityStatement } from '@clinmesh/contracts/fhir'

const readSearchInteractions = ['read', 'vread', 'history-instance', 'search-type'] as const

export type FhirResourceOwnerKind =
  | 'domain-projection'
  | 'fhir-native'
  | 'fhir-native-immutable'

export interface SearchCapability {
  definition: string
  name: string
  paths?: string[]
  target?: string[]
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

function referenceSearch(
  name: string,
  definition: string,
  paths: string[],
  target: string[],
): SearchCapability {
  return { definition, name, paths, target, type: 'reference' }
}

function patientSearch(path: string): SearchCapability {
  return referenceSearch(
    'patient',
    'http://hl7.org/fhir/SearchParameter/clinical-patient',
    [path],
    ['Patient'],
  )
}

function encounterSearch(definition = 'http://hl7.org/fhir/SearchParameter/clinical-encounter'): SearchCapability {
  return referenceSearch('encounter', definition, ['encounter'], ['Encounter'])
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
    resource('AllergyIntolerance', 'fhir-native', [patientSearch('patient')]),
    resource('Condition', 'fhir-native', [patientSearch('subject')]),
    resource('Encounter', 'fhir-native', [patientSearch('subject')]),
    resource('Task', 'fhir-native', [
      patientSearch('for'),
      referenceSearch(
        'focus',
        'http://hl7.org/fhir/SearchParameter/Task-focus',
        ['focus'],
        ['Encounter'],
      ),
    ]),
    resource('Account', 'fhir-native', [patientSearch('subject')]),
    resource('ChargeItem', 'fhir-native', [patientSearch('subject'), encounterSearch()]),
    resource('Observation', 'fhir-native', [patientSearch('subject'), encounterSearch()]),
    resource('ServiceRequest', 'fhir-native', [patientSearch('subject'), encounterSearch()]),
    resource('Specimen', 'fhir-native', [patientSearch('subject')]),
    resource('DiagnosticReport', 'fhir-native', [patientSearch('subject'), encounterSearch()]),
    resource('MedicationRequest', 'fhir-native', [
      patientSearch('subject'),
      encounterSearch('http://hl7.org/fhir/SearchParameter/medications-encounter'),
    ]),
    resource('MedicationDispense', 'fhir-native', [
      patientSearch('subject'),
      encounterSearch(),
      referenceSearch(
        'prescription',
        'http://hl7.org/fhir/SearchParameter/medications-prescription',
        ['authorizingPrescription'],
        ['MedicationRequest'],
      ),
    ]),
    ...[
      'Organization',
      'Location',
      'Practitioner',
      'PractitionerRole',
      'Medication',
    ].map(type => resource(type)),
    resource('Composition', 'fhir-native-immutable', [patientSearch('subject'), encounterSearch()]),
    resource('Bundle', 'fhir-native-immutable'),
    resource('Provenance', 'fhir-native-immutable', [referenceSearch(
      'target',
      'http://hl7.org/fhir/SearchParameter/Provenance-target',
      ['target'],
      ['Bundle', 'Composition'],
    )]),
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

export function getResourceSearchParameters(resourceType: string): SearchCapability[] {
  return [...(getResourceCapability(resourceType)?.searchParameters ?? [])]
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
                ...(parameter.target === undefined ? {} : { target: parameter.target }),
                type: parameter.type,
              })),
            })),
          }
        : {}),
    }],
  }
}
