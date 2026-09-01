import { z } from 'zod'

export const fhirVersionSchema = z.literal('5.0.0')

export const supportedFhirResourceTypes = [
  'Patient',
  'AllergyIntolerance',
  'Condition',
  'Encounter',
  'Task',
  'Account',
  'ChargeItem',
  'Observation',
  'ServiceRequest',
  'Specimen',
  'DiagnosticReport',
  'MedicationRequest',
  'MedicationDispense',
  'Organization',
  'Location',
  'Practitioner',
  'PractitionerRole',
  'Medication',
  'Composition',
  'Bundle',
  'Provenance',
  'InventoryItem',
  'AuditEvent',
] as const

export const supportedFhirResourceTypeSchema = z.enum(supportedFhirResourceTypes)

export type FhirResourceOwnerKind =
  | 'domain-projection'
  | 'fhir-native'
  | 'fhir-native-immutable'

export interface FhirSearchCapability {
  definition: string
  name: string
  paths?: string[]
  target?: string[]
  type: 'reference' | 'string' | 'token'
}

export interface FhirResourceCapability {
  interactions: readonly ['read', 'vread', 'history-instance', 'search-type']
  ownerKind: FhirResourceOwnerKind
  searchParameters: FhirSearchCapability[]
  type: z.infer<typeof supportedFhirResourceTypeSchema>
}

const readSearchInteractions = ['read', 'vread', 'history-instance', 'search-type'] as const

function resource(
  type: z.infer<typeof supportedFhirResourceTypeSchema>,
  ownerKind: FhirResourceOwnerKind = 'fhir-native',
  searchParameters: FhirSearchCapability[] = [],
): FhirResourceCapability {
  return { interactions: readSearchInteractions, ownerKind, searchParameters, type }
}

function referenceSearch(
  name: string,
  definition: string,
  paths: string[],
  target: string[],
): FhirSearchCapability {
  return { definition, name, paths, target, type: 'reference' }
}

function patientSearch(path: string): FhirSearchCapability {
  return referenceSearch(
    'patient',
    'http://hl7.org/fhir/SearchParameter/clinical-patient',
    [path],
    ['Patient'],
  )
}

function encounterSearch(
  definition = 'http://hl7.org/fhir/SearchParameter/clinical-encounter',
): FhirSearchCapability {
  return referenceSearch('encounter', definition, ['encounter'], ['Encounter'])
}

export const fhirCapabilityRegistry = {
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
    resource('Condition', 'fhir-native', [patientSearch('subject'), encounterSearch()]),
    resource('Encounter', 'fhir-native', [patientSearch('subject')]),
    resource('Task', 'fhir-native', [
      patientSearch('for'),
      referenceSearch(
        'focus',
        'http://hl7.org/fhir/SearchParameter/Task-focus',
        ['focus'],
        ['Encounter', 'ServiceRequest'],
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
    resource('Organization'),
    resource('Location'),
    resource('Practitioner'),
    resource('PractitionerRole'),
    resource('Medication'),
    resource('Composition', 'fhir-native-immutable', [patientSearch('subject'), encounterSearch()]),
    resource('Bundle', 'fhir-native-immutable'),
    resource('Provenance', 'fhir-native-immutable', [referenceSearch(
      'target',
      'http://hl7.org/fhir/SearchParameter/Provenance-target',
      ['target'],
      [
        'Bundle',
        'Composition',
        'Condition',
        'DiagnosticReport',
        'Encounter',
        'Observation',
        'ServiceRequest',
        'Specimen',
        'Task',
      ],
    )]),
    resource('InventoryItem', 'domain-projection'),
    resource('AuditEvent', 'domain-projection'),
  ],
} satisfies {
  fhirVersion: z.infer<typeof fhirVersionSchema>
  resources: FhirResourceCapability[]
}

export function getFhirResourceCapability(resourceType: string): FhirResourceCapability | undefined {
  return fhirCapabilityRegistry.resources.find(candidate => candidate.type === resourceType)
}

export function getFhirResourceSearchParameters(resourceType: string): FhirSearchCapability[] {
  return [...(getFhirResourceCapability(resourceType)?.searchParameters ?? [])]
}

export function getFhirResourceOwnership(resourceType: string): FhirResourceOwnerKind | undefined {
  return getFhirResourceCapability(resourceType)?.ownerKind
}

export function isSupportedFhirResourceType(resourceType: string): boolean {
  return getFhirResourceCapability(resourceType) !== undefined
}

export function isSupportedFhirSearchParameter(resourceType: string, parameter: string): boolean {
  return getFhirResourceCapability(resourceType)?.searchParameters.some(
    searchParameter => searchParameter.name === parameter,
  ) ?? false
}

export const fhirReferenceSchema = z.object({
  reference: z.string().regex(/^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/),
  display: z.string().min(1).optional(),
})

export const fhirResourceSchema = z.object({
  resourceType: z.string().regex(/^[A-Z][A-Za-z]+$/),
  id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/),
  meta: z.object({
    versionId: z.string().regex(/^\d+$/),
    lastUpdated: z.iso.datetime({ offset: true }),
  }).loose().optional(),
}).loose()

export const operationOutcomeSchema = z.object({
  resourceType: z.literal('OperationOutcome'),
  issue: z.array(z.object({
    severity: z.enum(['fatal', 'error', 'warning', 'information', 'success']),
    code: z.string().min(1),
    diagnostics: z.string().min(1).optional(),
  }).loose()).min(1),
}).loose()

const fhirBundleEntrySchema = z.object({
  fullUrl: z.url().optional(),
  resource: fhirResourceSchema,
})

export const fhirBundleSchema = z.object({
  resourceType: z.literal('Bundle'),
  type: z.enum(['searchset', 'history']),
  total: z.number().int().nonnegative().optional(),
  link: z.array(z.object({
    relation: z.string().min(1),
    url: z.url(),
  })).optional(),
  entry: z.array(fhirBundleEntrySchema).optional(),
}).loose()

export const fhirDocumentBundleSchema = fhirResourceSchema.extend({
  resourceType: z.literal('Bundle'),
  type: z.literal('document'),
  identifier: z.object({
    system: z.url(),
    value: z.string().min(1),
  }).loose(),
  timestamp: z.iso.datetime({ offset: true }),
  entry: z.array(fhirBundleEntrySchema.extend({ fullUrl: z.url() })).min(1),
}).loose()

export const capabilityStatementSchema = z.object({
  resourceType: z.literal('CapabilityStatement'),
  url: z.url(),
  version: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1),
  status: z.literal('active'),
  experimental: z.boolean(),
  date: z.iso.datetime({ offset: true }),
  publisher: z.string().min(1),
  kind: z.literal('instance'),
  software: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  implementation: z.object({
    description: z.string().min(1),
  }),
  fhirVersion: fhirVersionSchema,
  format: z.array(z.literal('application/fhir+json')).min(1),
  rest: z.array(z.object({
    mode: z.literal('server'),
    resource: z.array(z.object({
      type: z.string().regex(/^[A-Z][A-Za-z]+$/),
      documentation: z.string().min(1).optional(),
      interaction: z.array(z.object({
        code: z.enum(['read', 'vread', 'update', 'create', 'history-instance', 'search-type']),
      })).optional(),
      searchParam: z.array(z.object({
        name: z.string().min(1),
        definition: z.url(),
        target: z.array(z.string().regex(/^[A-Z][A-Za-z]+$/)).min(1).optional(),
        type: z.enum(['number', 'date', 'string', 'token', 'reference', 'composite', 'quantity', 'uri', 'special']),
      })).optional(),
    })).min(1).optional(),
  })).min(1),
})

export type FhirReference = z.infer<typeof fhirReferenceSchema>
export type FhirResource = z.infer<typeof fhirResourceSchema>
export type FhirBundle = z.infer<typeof fhirBundleSchema>
export type FhirDocumentBundle = z.infer<typeof fhirDocumentBundleSchema>
export type OperationOutcome = z.infer<typeof operationOutcomeSchema>
export type CapabilityStatement = z.infer<typeof capabilityStatementSchema>
