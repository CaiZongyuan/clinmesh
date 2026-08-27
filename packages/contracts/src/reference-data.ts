import { z } from 'zod'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

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

export const referenceArtifactSchema = z.object({
  concepts: z.array(referenceConceptSchema),
  schemaVersion: z.literal('1'),
}).strict()

export const referenceImportManifestSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  releaseId: z.string().min(1).max(256),
  schemaVersion: z.literal('1'),
  sources: z.array(z.object({
    acquisitionMethod: z.enum(['bundled-fixture', 'documented-api', 'generated', 'manual-download']),
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
  importDiagnostics: referenceImportDiagnosticsSchema,
  recordCount: z.number().int().nonnegative(),
}).strict().refine(source => (
  source.importDiagnostics.acceptedCount + source.importDiagnostics.rejectedCount === source.recordCount
), { message: 'Import diagnostic counts must equal the source record count' })

export const referenceDataReleaseSummarySchema = z.object({
  conceptCount: z.number().int().nonnegative(),
  contentHash: sha256Schema,
  createdAt: z.iso.datetime({ offset: true }),
  releaseId: z.string().min(1).max(256),
  schemaVersion: z.literal('1'),
  sourceCount: z.number().int().positive(),
  sources: z.array(referenceSourceManifestSchema).min(1),
  status: z.literal('published'),
}).strict()

export const referenceDataReleaseListSchema = z.object({
  items: z.array(referenceDataReleaseSummarySchema),
}).strict()

export const referenceDataProvenanceSchema = referenceDataReleaseSummarySchema.pick({
  contentHash: true,
  releaseId: true,
})

export type ReferenceArtifact = z.infer<typeof referenceArtifactSchema>
export type ReferenceConcept = z.infer<typeof referenceConceptSchema>
export type ReferenceDataProvenance = z.infer<typeof referenceDataProvenanceSchema>
export type ReferenceDataReleaseList = z.infer<typeof referenceDataReleaseListSchema>
export type ReferenceDataReleaseSummary = z.infer<typeof referenceDataReleaseSummarySchema>
export type ReferenceImportManifest = z.infer<typeof referenceImportManifestSchema>
export type ReferenceImportDiagnostics = z.infer<typeof referenceImportDiagnosticsSchema>
export type ReferenceSourceManifest = z.infer<typeof referenceSourceManifestSchema>
