import { z } from 'zod'

export const referenceDataItemIdSchema = z.string().min(1).max(256)
export const referenceLaboratorySourceDatasetSchema = z.enum(['laboratory-cn', 'loinc-zh-cn'])

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export function referenceCodingIdentity(input: {
  code: string
  system: string
  version: string
}): string {
  return JSON.stringify([input.system, input.version, input.code])
}

export const referenceDataDomainSchema = z.enum([
  'diagnosis',
  'laboratory',
  'medication',
  'service',
  'unit',
  'other',
])

export const referenceLaboratoryMetadataSchema = z.object({
  category: z.enum(['chemistry', 'hematology', 'vital-sign']),
  referenceRange: z.object({
    high: z.number().finite().optional(),
    low: z.number().finite().optional(),
    text: z.string().min(1).max(500),
  }).strict().optional(),
  resultType: z.enum(['panel', 'quantity']),
  specimen: z.enum(['blood', 'body']),
  unit: z.object({
    code: z.string().min(1).max(128),
    display: z.string().min(1).max(128),
    system: z.literal('http://unitsofmeasure.org'),
  }).strict().optional(),
}).strict().superRefine((metadata, context) => {
  if ((metadata.resultType === 'quantity') !== (metadata.unit !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'Quantity laboratory concepts require a UCUM unit and panels must not have one',
      path: ['unit'],
    })
  }
})

export const referenceConceptSchema = z.object({
  code: z.string().min(1).max(256),
  display: z.string().min(1).max(1_000),
  domain: referenceDataDomainSchema,
  id: referenceDataItemIdSchema,
  laboratory: referenceLaboratoryMetadataSchema.optional(),
  sourceLocator: z.string().min(1).max(1_000),
  status: z.enum(['active', 'inactive']),
  system: z.string().url(),
  version: z.string().min(1).max(256),
}).strict().superRefine((concept, context) => {
  if (concept.laboratory !== undefined && concept.domain !== 'laboratory') {
    context.addIssue({
      code: 'custom',
      message: 'Laboratory metadata is valid only for laboratory concepts',
      path: ['laboratory'],
    })
  }
})

export const referenceConceptSnapshotSchema = z.object({
  code: z.string().min(1).max(256),
  display: z.string().min(1).max(1_000),
  id: z.string().min(1).max(256),
  laboratory: referenceLaboratoryMetadataSchema.optional(),
  sourceLocator: z.string().min(1).max(1_000),
  system: z.string().url(),
  version: z.string().min(1).max(256),
}).strict()

const loincReferenceLaboratoryDefinitionSchema = z.object({
  kind: z.literal('loinc'),
  classCode: z.string().min(1).max(128).nullable(),
  classType: z.number().int().min(1).max(4).nullable(),
  component: z.string().min(1).max(1_000).nullable(),
  conceptId: referenceDataItemIdSchema,
  methodType: z.string().min(1).max(1_000).nullable(),
  orderObservation: z.enum(['Order', 'Observation', 'Both', 'Subset']).nullable(),
  panelType: z.string().min(1).max(128).nullable(),
  property: z.string().min(1).max(128).nullable(),
  scaleType: z.string().min(1).max(128).nullable(),
  sourceLocator: z.string().min(1).max(1_000),
  system: z.string().min(1).max(1_000).nullable(),
  timeAspect: z.string().min(1).max(128).nullable(),
}).strict()

export const referenceLaboratoryAdultRuleSchema = z.object({
  high: z.number().finite().optional(),
  low: z.number().finite().optional(),
  normalValue: z.string().min(1).max(256).optional(),
  notes: z.string().max(1_000),
  referenceKind: z.enum(['range', 'upper-bound', 'lower-bound', 'coded', 'ordinal']),
  sex: z.enum(['all', 'male', 'female']),
  simulationHigh: z.number().finite().optional(),
  simulationLow: z.number().finite().optional(),
  sourceLocation: z.string().min(1).max(1_000),
  sourceStandard: z.string().min(1).max(1_000),
  sourceType: z.enum(['national-standard', 'project-curated']),
  sourceVersion: z.string().min(1).max(256),
}).strict().superRefine((rule, context) => {
  if ((rule.simulationLow === undefined) !== (rule.simulationHigh === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'Laboratory simulation bounds must be present together',
      path: ['simulationLow'],
    })
  }
  if (rule.simulationLow !== undefined && rule.simulationHigh !== undefined
    && rule.simulationLow >= rule.simulationHigh) {
    context.addIssue({
      code: 'custom',
      message: 'Laboratory simulation low must be below simulation high',
      path: ['simulationLow'],
    })
  }
  if (rule.referenceKind === 'range') {
    if (rule.low === undefined || rule.high === undefined || rule.low > rule.high) {
      context.addIssue({
        code: 'custom',
        message: 'A range reference rule requires ordered low and high values',
        path: ['low'],
      })
    }
  } else if (rule.referenceKind === 'upper-bound' && rule.high === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'An upper-bound reference rule requires a high value',
      path: ['high'],
    })
  } else if (rule.referenceKind === 'lower-bound' && rule.low === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'A lower-bound reference rule requires a low value',
      path: ['low'],
    })
  } else if ((rule.referenceKind === 'coded' || rule.referenceKind === 'ordinal')
    && rule.normalValue === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'A coded or ordinal reference rule requires a normal value',
      path: ['normalValue'],
    })
  }
})

const laboratoryCnTestDefinitionSchema = z.object({
  adultReferenceRules: z.array(referenceLaboratoryAdultRuleSchema).min(1).max(3),
  alternateCodings: z.array(z.object({
    code: z.string().min(1).max(256),
    system: z.literal('http://loinc.org'),
    version: z.string().min(1).max(256),
  }).strict()).max(4),
  analyte: z.string().min(1).max(1_000),
  category: z.string().min(1).max(1_000),
  conceptId: referenceDataItemIdSchema,
  datasetReleaseId: z.string().min(1).max(256),
  healthyStrategy: z.enum(['uniform', 'fixed-normal']),
  kind: z.literal('laboratory-cn-test'),
  precision: z.number().int().min(0).max(4),
  resultKind: z.enum(['quantity', 'qualitative', 'ordinal', 'named']),
  scale: z.string().min(1).max(256),
  sourceLocator: z.string().min(1).max(1_000),
  sourceVersion: z.string().min(1).max(256),
  specimen: z.string().min(1).max(1_000),
  unit: z.object({
    code: z.string().min(1).max(128),
    display: z.string().min(1).max(128),
    system: z.literal('http://unitsofmeasure.org'),
  }).strict().optional(),
}).strict().superRefine((definition, context) => {
  if ((definition.resultKind === 'quantity') !== (definition.unit !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'Quantity laboratory definitions require one UCUM unit',
      path: ['unit'],
    })
  }
  if ((definition.healthyStrategy === 'uniform') !== (definition.resultKind === 'quantity')) {
    context.addIssue({
      code: 'custom',
      message: 'Uniform healthy generation is valid only for Quantity definitions',
      path: ['healthyStrategy'],
    })
  }
  const numericRules = definition.adultReferenceRules.every(rule => (
    rule.referenceKind === 'range'
    || rule.referenceKind === 'upper-bound'
    || rule.referenceKind === 'lower-bound'
  ))
  const fixedRules = definition.adultReferenceRules.every(rule => (
    rule.referenceKind === 'coded' || rule.referenceKind === 'ordinal'
  ))
  if (definition.resultKind === 'quantity' ? !numericRules : !fixedRules) {
    context.addIssue({
      code: 'custom',
      message: 'Quantity definitions require numeric rules and fixed definitions require coded rules',
      path: ['adultReferenceRules'],
    })
  }
})

const laboratoryCnPanelDefinitionSchema = z.object({
  conceptId: referenceDataItemIdSchema,
  datasetReleaseId: z.string().min(1).max(256),
  kind: z.literal('laboratory-cn-panel'),
  notes: z.string().max(1_000),
  sourceLocation: z.string().min(1).max(1_000),
  sourceLocator: z.string().min(1).max(1_000),
  sourceType: z.literal('project-authored'),
  sourceVersion: z.string().min(1).max(256),
  specimen: z.string().min(1).max(1_000),
}).strict()

const versionedReferenceLaboratoryDefinitionSchema = z.discriminatedUnion('kind', [
  loincReferenceLaboratoryDefinitionSchema,
  laboratoryCnTestDefinitionSchema,
  laboratoryCnPanelDefinitionSchema,
])

export const referenceLaboratoryDefinitionSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null || 'kind' in value) return value
  return { ...value, kind: 'loinc' }
}, versionedReferenceLaboratoryDefinitionSchema)

export const referenceLaboratoryUnitSchema = z.object({
  code: z.string().min(1).max(128),
  conceptId: referenceDataItemIdSchema,
  kind: z.literal('example'),
  ordinal: z.number().int().positive(),
  sourceLocator: z.string().min(1).max(1_000),
}).strict()

export const referenceLaboratorySpecimenSchema = z.object({
  conceptId: referenceDataItemIdSchema,
  display: z.string().min(1).max(1_000),
  linkType: z.literal('Primary'),
  partName: z.string().min(1).max(1_000),
  partNumber: z.string().min(1).max(128),
  sourceLocator: z.string().min(1).max(1_000),
}).strict()

export const referenceLaboratoryPanelMemberSchema = z.object({
  memberConceptId: referenceDataItemIdSchema,
  memberOrder: z.number().int().nonnegative(),
  panelConceptId: referenceDataItemIdSchema,
  relationship: z.literal('contains'),
  sourceLocator: z.string().min(1).max(1_000),
}).strict()

export const referenceLaboratoryRecordSchema = z.object({
  concept: referenceConceptSchema,
  definition: referenceLaboratoryDefinitionSchema,
  panelMembers: z.array(referenceLaboratoryPanelMemberSchema),
  specimens: z.array(referenceLaboratorySpecimenSchema),
  units: z.array(referenceLaboratoryUnitSchema),
}).strict()

export const referenceMedicationProductSchema = z.object({
  approvalNumber: z.string().min(1).max(256),
  brandName: z.string().min(1).max(500).nullable(),
  code: z.string().min(1).max(256),
  dosageForm: z.string().min(1).max(256),
  genericName: z.string().min(1).max(500),
  id: z.string().min(1).max(256),
  manufacturer: z.string().min(1).max(500),
  packageDescription: z.string().min(1).max(500),
  sourceLocator: z.string().min(1).max(1_000),
  status: z.enum(['active', 'inactive']),
  strength: z.string().min(1).max(256),
  system: z.string().url(),
  version: z.string().min(1).max(256),
}).strict()

export const referenceMedicalServiceSchema = z.object({
  billingUnitCode: z.string().min(1).max(128),
  categoryCode: z.string().min(1).max(128),
  code: z.string().min(1).max(256),
  display: z.string().min(1).max(1_000),
  id: z.string().min(1).max(512),
  sourceLocator: z.string().min(1).max(1_000),
  status: z.enum(['active', 'inactive']),
  system: z.string().url(),
  version: z.string().min(1).max(256),
}).strict()

export const referenceValueSetEntrySchema = z.object({
  code: z.string().min(1).max(128),
  display: z.string().min(1).max(500),
  id: z.string().min(1).max(512),
  sourceLocator: z.string().min(1).max(1_000),
  status: z.enum(['active', 'inactive']),
  system: z.string().url(),
  valueSet: z.string().url(),
  version: z.string().min(1).max(256),
}).strict()

export const referenceArtifactSchema = z.object({
  concepts: z.array(referenceConceptSchema),
  laboratoryDefinitions: z.array(referenceLaboratoryDefinitionSchema).default([]),
  laboratoryPanelMembers: z.array(referenceLaboratoryPanelMemberSchema).default([]),
  laboratorySpecimens: z.array(referenceLaboratorySpecimenSchema).default([]),
  laboratoryUnits: z.array(referenceLaboratoryUnitSchema).default([]),
  medicationProducts: z.array(referenceMedicationProductSchema).default([]),
  schemaVersion: z.literal('1'),
  services: z.array(referenceMedicalServiceSchema).default([]),
  valueSetEntries: z.array(referenceValueSetEntrySchema).default([]),
}).strict()

export const referenceArtifactFormatSchema = z.enum([
  'cn-health-candidate',
  'clinmesh-reference-v1',
  'loinc-csv',
  'nhsa-diagnosis-csv',
  'nhsa-medication-product-csv',
  'nhc-medical-service-csv',
  'ucum-xml',
  'wst-value-set-csv',
])

export const referenceMaterializationProvenanceSchema = z.object({
  cliVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  manifestSha256: sha256Schema,
  registryKeyId: z.string().min(1).max(128),
  registryUrl: z.string().url(),
  sqliteSha256: sha256Schema,
  sqliteSizeBytes: z.number().int().positive(),
}).strict()

export const cnHealthCandidateProvenanceSchema = z.object({
  canonicalSha256: sha256Schema,
  datasetId: z.enum([
    'laboratory-cn',
    'loinc-zh-cn',
    'nhc-icd10-clinical',
    'nhsa-drugs',
  ]),
  datasetSchemaVersion: z.union([z.literal(1), z.literal(2)]),
  recordCount: z.number().int().nonnegative(),
  releaseId: z.string().min(1).max(256),
  sourceVersion: z.string().min(1).max(256),
  sqliteSha256: sha256Schema,
  sqliteSizeBytes: z.number().int().nonnegative(),
}).strict()

export const referenceImportManifestSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  releaseId: z.string().min(1).max(256),
  schemaVersion: z.literal('1'),
  sources: z.array(z.object({
    acquisitionMethod: z.enum(['bundled-fixture', 'documented-api', 'generated', 'manual-download']),
    artifactFormat: referenceArtifactFormatSchema.default('clinmesh-reference-v1'),
    artifactPath: z.string().min(1),
    checksum: sha256Schema,
    licenseId: z.string().min(1).max(256),
    materialization: referenceMaterializationProvenanceSchema.optional(),
    publishedAt: z.iso.date().optional(),
    retrievedAt: z.iso.datetime({ offset: true }),
    sourceId: z.string().min(1).max(256),
    sourceUrl: z.string().url(),
    upstreamVersion: z.string().min(1).max(256),
  }).strict()).min(1),
}).strict()

export const referenceImportDiagnosticsSchema = z.object({
  acceptedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  warnings: z.array(z.string().min(1).max(1_000)).max(1_000),
}).strict()

export const referenceSourceManifestSchema = referenceImportManifestSchema.shape.sources.element.omit({
  artifactPath: true,
}).extend({
  candidate: cnHealthCandidateProvenanceSchema.optional(),
  importDiagnostics: referenceImportDiagnosticsSchema,
  recordCount: z.number().int().nonnegative(),
}).strict().refine(source => (
  source.importDiagnostics.acceptedCount + source.importDiagnostics.rejectedCount === source.recordCount
), { message: 'Import diagnostic counts must equal the source record count' }).superRefine((source, context) => {
  if ((source.artifactFormat === 'cn-health-candidate') !== (source.candidate !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'cn-health Candidate format and provenance must be present together',
      path: ['candidate'],
    })
  }
})

export const referenceDataReleaseSummarySchema = z.object({
  conceptCount: z.number().int().nonnegative(),
  contentHash: sha256Schema,
  createdAt: z.iso.datetime({ offset: true }),
  laboratoryDefinitionCount: z.number().int().nonnegative().default(0),
  laboratoryPanelMemberCount: z.number().int().nonnegative().default(0),
  laboratorySpecimenCount: z.number().int().nonnegative().default(0),
  laboratoryUnitCount: z.number().int().nonnegative().default(0),
  releaseId: z.string().min(1).max(256),
  medicationProductCount: z.number().int().nonnegative().default(0),
  serviceCount: z.number().int().nonnegative().default(0),
  schemaVersion: z.literal('1'),
  sourceCount: z.number().int().positive(),
  sources: z.array(referenceSourceManifestSchema).min(1),
  status: z.literal('published'),
  valueSetEntryCount: z.number().int().nonnegative().default(0),
}).strict()

export const referenceDataReleaseListSchema = z.object({
  items: z.array(referenceDataReleaseSummarySchema),
}).strict()

export const referenceDataProvenanceSchema = referenceDataReleaseSummarySchema.pick({
  contentHash: true,
  releaseId: true,
})

const referenceCatalogPageShape = {
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(50),
  releaseId: z.string().min(1).max(256),
  total: z.number().int().nonnegative(),
}

export const referenceDiagnosisCatalogSearchSchema = z.object({
  ...referenceCatalogPageShape,
  items: z.array(referenceConceptSchema.safeExtend({
    domain: z.literal('diagnosis'),
  }).strict()),
}).strict()

export const referenceLaboratoryCatalogSearchSchema = z.object({
  ...referenceCatalogPageShape,
  items: z.array(referenceConceptSchema.safeExtend({
    domain: z.literal('laboratory'),
  }).strict()),
}).strict()

export const referenceMedicationCatalogSearchSchema = z.object({
  ...referenceCatalogPageShape,
  items: z.array(referenceMedicationProductSchema),
}).strict()

export const referenceMappingPackageProvenanceSchema = z.object({
  contentHash: sha256Schema,
  mappingSetId: z.string().min(1).max(256),
  version: z.string().min(1).max(256),
}).strict()

export type ReferenceArtifact = z.infer<typeof referenceArtifactSchema>
export type ReferenceArtifactFormat = z.infer<typeof referenceArtifactFormatSchema>
export type CnHealthCandidateProvenance = z.infer<typeof cnHealthCandidateProvenanceSchema>
export type ReferenceConcept = z.infer<typeof referenceConceptSchema>
export type ReferenceConceptSnapshot = z.infer<typeof referenceConceptSnapshotSchema>
export type ReferenceDataProvenance = z.infer<typeof referenceDataProvenanceSchema>
export type ReferenceDiagnosisCatalogSearch = z.infer<typeof referenceDiagnosisCatalogSearchSchema>
export type ReferenceLaboratoryCatalogSearch = z.infer<typeof referenceLaboratoryCatalogSearchSchema>
export type ReferenceMedicationCatalogSearch = z.infer<typeof referenceMedicationCatalogSearchSchema>
export type ReferenceDataReleaseList = z.infer<typeof referenceDataReleaseListSchema>
export type ReferenceDataReleaseSummary = z.infer<typeof referenceDataReleaseSummarySchema>
export type ReferenceImportManifest = z.infer<typeof referenceImportManifestSchema>
export type ReferenceImportDiagnostics = z.infer<typeof referenceImportDiagnosticsSchema>
export type ReferenceLaboratoryDefinition = z.infer<typeof referenceLaboratoryDefinitionSchema>
export type ReferenceLaboratoryPanelMember = z.infer<typeof referenceLaboratoryPanelMemberSchema>
export type ReferenceLaboratoryRecord = z.infer<typeof referenceLaboratoryRecordSchema>
export type ReferenceLaboratorySpecimen = z.infer<typeof referenceLaboratorySpecimenSchema>
export type ReferenceLaboratorySourceDataset = z.infer<
  typeof referenceLaboratorySourceDatasetSchema
>
export type ReferenceLaboratoryUnit = z.infer<typeof referenceLaboratoryUnitSchema>
export type ReferenceMedicationProduct = z.infer<typeof referenceMedicationProductSchema>
export type ReferenceMappingPackageProvenance = z.infer<typeof referenceMappingPackageProvenanceSchema>
export type ReferenceMedicalService = z.infer<typeof referenceMedicalServiceSchema>
export type ReferenceSourceManifest = z.infer<typeof referenceSourceManifestSchema>
export type ReferenceValueSetEntry = z.infer<typeof referenceValueSetEntrySchema>
