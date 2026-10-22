import { z } from 'zod'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().min(1).max(1_000)
export const offlineReferenceQuarantineReasonSchema = z.enum([
  'usage-terms-unconfirmed', 'coding-compatibility-unverified', 'missing-payment-parameters',
  'source-applicability-unverified', 'algorithm-unvalidated',
])
const artifact = z.object({ path: text, sha256 }).strict()
const packageBaseSchema = z.object({
  id: text,
  format: z.enum(['prepared-catalogues-v1', 'opendrg-public-data-v1']),
  root: text,
  version: text,
  manifest: artifact,
  checksums: artifact.optional(),
  sourceUrl: z.string().url(),
  quarantineReasons: z.array(offlineReferenceQuarantineReasonSchema).min(1),
}).strict()
const packageSchema = packageBaseSchema.superRefine((value, context) => {
  if (value.format === 'opendrg-public-data-v1' && value.checksums === undefined) {
    context.addIssue({ code: 'custom', message: 'OpenDRG requires a pinned checksum index' })
  }
})
const lockBaseSchema = z.object({
  schemaVersion: z.literal('clinmesh.offline-inventory.v1'),
  inventoryId: text,
  createdAt: z.iso.datetime({ offset: true }),
  scheme: z.literal('CHS-DRG-3.0'),
  packages: z.array(packageSchema).min(1).max(10),
}).strict()
export const offlineReferenceLockSchema = lockBaseSchema.superRefine((value, context) => {
  if (new Set(value.packages.map(item => item.id)).size !== value.packages.length) {
    context.addIssue({ code: 'custom', message: 'Offline package IDs must be unique' })
  }
})

export const offlineReferenceInventorySchema = lockBaseSchema.omit({ packages: true }).extend({
  contentHash: sha256,
  validationScope: z.literal('integrity-only'),
  runtimeEnabled: z.literal(false),
  packages: z.array(packageBaseSchema.omit({ root: true }).extend({
    approvedUse: z.literal('offline-review'),
    runtimeEnabled: z.literal(false),
    verifiedFileCount: z.number().int().nonnegative(),
    selectedGrouper: z.object({
      schemeId: z.literal('chs_drg_30'),
      program: artifact,
      parameters: artifact.extend({
        counts: z.object({ CC: z.number().int(), MCC: z.number().int(), CCE: z.number().int(), SS_VALID: z.number().int() }).strict(),
      }).strict(),
    }).strict().nullable(),
    sourceArtifacts: z.array(z.object({
      id: text, version: text, archiveSha256: sha256, pdfSha256: sha256,
      sourcePublicationVerified: z.boolean(),
    }).strict()),
    tables: z.array(z.object({
      path: text,
      sha256,
      rows: z.number().int().nonnegative(),
      sourceVersion: text,
      sourceUrl: z.string().url().optional(),
      units: z.array(text),
      unitStatus: z.literal('source-only-unverified'),
      scope: z.enum(['source-review', 'selected-scheme', 'excluded-other-scheme']),
      missingParameterCodes: z.array(text),
    }).strict()),
  }).strict()),
}).strict()
export const offlineReferenceInventoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict()
export const offlineReferenceInventoryListSchema = z.object({
  items: z.array(offlineReferenceInventorySchema).max(50),
  page: z.number().int().positive(), pageSize: z.number().int().min(1).max(50), total: z.number().int().nonnegative(),
}).strict()
export type OfflineReferenceInventory = z.infer<typeof offlineReferenceInventorySchema>
export type OfflineReferenceInventoryQuery = z.infer<typeof offlineReferenceInventoryQuerySchema>
export type OfflineReferenceInventoryList = z.infer<typeof offlineReferenceInventoryListSchema>
export type OfflineReferenceLock = z.infer<typeof offlineReferenceLockSchema>
