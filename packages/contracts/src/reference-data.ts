import { z } from 'zod'

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

export const referenceConceptSchema = z.object({
  code: z.string().min(1).max(256),
  display: z.string().min(1).max(1_000),
  domain: referenceDataDomainSchema,
  id: z.string().min(1).max(256),
  sourceLocator: z.string().min(1).max(1_000),
  status: z.enum(['active', 'inactive']),
  system: z.string().url(),
  version: z.string().min(1).max(256),
}).strict()

export const referenceConceptSnapshotSchema = referenceConceptSchema.pick({
  code: true,
  display: true,
  id: true,
  sourceLocator: true,
  system: true,
  version: true,
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

export const cnHealthCandidateProvenanceSchema = z.object({
  canonicalSha256: sha256Schema,
  datasetId: z.enum([
    'laboratory-cn',
    'loinc-zh-cn',
    'nhc-icd10-clinical',
    'nhsa-drugs',
  ]),
  datasetSchemaVersion: z.literal(1),
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

export const referenceMappingPackageProvenanceSchema = z.object({
  contentHash: sha256Schema,
  mappingSetId: z.string().min(1).max(256),
  version: z.string().min(1).max(256),
}).strict()

export type ReferenceArtifact = z.infer<typeof referenceArtifactSchema>
export type ReferenceArtifactFormat = z.infer<typeof referenceArtifactFormatSchema>
export type CnHealthCandidateProvenance = z.infer<typeof cnHealthCandidateProvenanceSchema>
export type ReferenceConcept = z.infer<typeof referenceConceptSchema>
export type ReferenceDataProvenance = z.infer<typeof referenceDataProvenanceSchema>
export type ReferenceDataReleaseList = z.infer<typeof referenceDataReleaseListSchema>
export type ReferenceDataReleaseSummary = z.infer<typeof referenceDataReleaseSummarySchema>
export type ReferenceImportManifest = z.infer<typeof referenceImportManifestSchema>
export type ReferenceImportDiagnostics = z.infer<typeof referenceImportDiagnosticsSchema>
export type ReferenceMedicationProduct = z.infer<typeof referenceMedicationProductSchema>
export type ReferenceMappingPackageProvenance = z.infer<typeof referenceMappingPackageProvenanceSchema>
export type ReferenceMedicalService = z.infer<typeof referenceMedicalServiceSchema>
export type ReferenceSourceManifest = z.infer<typeof referenceSourceManifestSchema>
export type ReferenceValueSetEntry = z.infer<typeof referenceValueSetEntrySchema>
