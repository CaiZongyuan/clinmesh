import { z } from 'zod'

export const pathologyReadingProtocol = 'clinmesh.pathology-reading.v1' as const
const id = z.string().min(1).max(256)
const reportVersion = z.string().regex(/^[1-9][0-9]*$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const origin = z.url().refine(value => {
  const parsed = new URL(value)
  return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === value && !parsed.username && !parsed.password
}, 'An exact HTTP or HTTPS origin is required')

export const readingContextSchema = z.object({ workspaceId: id, epochId: id, encounterId: id,
  requestId: id, reportId: id, reportVersion }).strict()
export const readingCapabilitySchema = z.object({ taskCode: id, modelVersion: id, modelDigest: sha256,
  organ: z.enum(['colorectal', 'thyroid']), specimenTypes: z.array(id).min(1).max(32), stain: z.literal('HE'),
  available: z.boolean(), limitations: z.array(z.string().min(1).max(2000)).max(32) }).strict()
export const readingCapabilitiesSchema = z.object({ protocol: z.literal(pathologyReadingProtocol), instanceId: id,
  capabilities: z.array(readingCapabilitySchema).max(100) }).strict()
export const readingBindingSchema = z.object({ bindingId: id, instanceId: id, slideId: id, contentHash: sha256 }).strict()
export const readingBindingStatusSchema = readingBindingSchema.extend({ available: z.boolean(), revision: z.number().int().nonnegative().safe() }).strict()
export const readingAssetStatusSchema = z.object({ assetKey: id, contentHash: sha256, organ: z.enum(['colorectal', 'thyroid']),
  specimenType: id, stain: z.literal('HE'), available: z.boolean() }).strict()
export const readingAuthorizationInputSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('authorize'), bindingId: id, revision: z.number().int().nonnegative().safe(), intentId: id.optional() }).strict(),
  z.object({ event: z.literal('committed'), bindingId: id, previousRevision: z.number().int().nonnegative().safe(),
    revision: z.number().int().nonnegative().safe(), intentId: id }).strict(),
])
export const readingSessionCreatedSchema = z.object({ sessionId: id, launchToken: z.string().min(16).max(4096),
  expiresAt: z.iso.datetime({ offset: true }), viewerPath: z.literal('/clinmesh/reading') }).strict()
export const readingOperationSchema = z.object({ intentId: id, status: z.enum(['applied', 'not-found', 'unknown']),
  result: z.json().optional(), httpStatus: z.number().int().min(100).max(599).optional() }).strict()
  .refine(value => value.status !== 'applied' || value.result !== undefined, 'Applied operations require the original result')

export const pathologyReadingConfigInputSchema = z.object({ expectedVersion: z.number().int().nonnegative(),
  enabled: z.boolean(), instanceId: id, endpoint: origin, viewerOrigin: origin }).strict()
export const pathologyReadingConfigSchema = pathologyReadingConfigInputSchema.omit({ expectedVersion: true }).extend({
  version: z.number().int().positive(),
}).strict()
export const pathologyReadingStatusSchema = z.object({
  state: z.enum(['not-configured', 'disabled', 'ready', 'offline', 'incompatible', 'credentials-unavailable', 'repair-required']),
  config: pathologyReadingConfigSchema.nullable(), capabilities: z.array(readingCapabilitySchema),
}).strict()
export const pathologyReadingSessionInputSchema = z.object({ reportId: id, reportVersion, requestVersion: z.number().int().positive(),
  generation: z.uuid(), parentOrigin: origin }).strict()
export const pathologyReadingSessionSchema = z.object({ id: z.uuid(), sessionId: id,
  requestId: id, reportId: id, reportVersion, generation: z.uuid(),
  viewerUrl: z.url(), viewerOrigin: origin, launchToken: z.string().min(16).max(4096),
  expiresAt: z.iso.datetime({ offset: true }), writable: z.boolean(),
}).strict()
export const pathologyReadingSessionStateSchema = z.object({ id: z.uuid(), active: z.boolean(), writable: z.boolean(),
  displayed: z.boolean(), expiresAt: z.iso.datetime({ offset: true }),
}).strict()
export const pathologyReadingMessageSchema = z.object({ protocol: z.literal(pathologyReadingProtocol),
  type: z.enum(['displayed', 'failed', 'invalidated', 'closed']), sessionId: id, generation: z.uuid(),
  requestId: id, reportId: id, reportVersion }).strict()
export const pathologyReadingReadySchema = z.object({ protocol: z.literal(pathologyReadingProtocol), type: z.literal('ready') }).strict()
export const pathologyReadingAuthorizationSchema = z.object({ active: z.boolean(), writable: z.boolean() }).strict()

export type ReadingContext = z.infer<typeof readingContextSchema>
export type ReadingCapability = z.infer<typeof readingCapabilitySchema>
export type PathologyReadingConfig = z.infer<typeof pathologyReadingConfigSchema>
export type PathologyReadingSession = z.infer<typeof pathologyReadingSessionSchema>
export type PathologyReadingSessionInput = z.infer<typeof pathologyReadingSessionInputSchema>
export type PathologyReadingMessage = z.infer<typeof pathologyReadingMessageSchema>
