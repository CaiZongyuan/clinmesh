import { referenceCodingIdentity } from '@clinmesh/contracts/reference-data'
import { z } from 'zod'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const bindingSchema = z.object({
  catalogItemId: z.string().min(1).max(256),
  coding: z.object({
    code: z.string().min(1).max(256),
    system: z.string().url(),
    version: z.string().min(1).max(256),
  }).strict(),
  kind: z.enum(['diagnosis', 'laboratory', 'medication-product']),
}).strict()

const payloadSchema = z.object({
  bindings: z.array(bindingSchema).min(1).max(100),
  referenceReleaseId: z.string().min(1).max(256),
  schemaVersion: z.literal('1'),
  selectionId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
}).strict().superRefine((selection, context) => {
  const catalogItems = new Set<string>()
  const codings = new Set<string>()
  selection.bindings.forEach((binding, index) => {
    if (catalogItems.has(binding.catalogItemId)) {
      context.addIssue({
        code: 'custom',
        message: 'Hospital catalog binding was repeated',
        path: ['bindings', index, 'catalogItemId'],
      })
    }
    catalogItems.add(binding.catalogItemId)
    const coding = `${binding.kind}\u0000${referenceCodingIdentity(binding.coding)}`
    if (codings.has(coding)) {
      context.addIssue({
        code: 'custom',
        message: 'Reference binding coding was repeated',
        path: ['bindings', index, 'coding'],
      })
    }
    codings.add(coding)
  })
})

const selectionSchema = payloadSchema.extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const selectionInputSchema = payloadSchema.extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()

export type ReferenceHospitalSelection = z.infer<typeof selectionSchema>
export type ReferenceHospitalSelectionInput = z.infer<typeof payloadSchema>

export function createReferenceHospitalSelection(
  input: ReferenceHospitalSelectionInput,
): ReferenceHospitalSelection {
  const payload = payloadSchema.parse(input)
  return selectionSchema.parse({ ...payload, contentHash: canonicalJsonHash(payload) })
}

export function parseReferenceHospitalSelection(input: unknown): ReferenceHospitalSelection {
  const parsed = selectionInputSchema.parse(input)
  const { contentHash, ...payload } = parsed
  const actualContentHash = canonicalJsonHash(payload)
  if (contentHash !== undefined && actualContentHash !== contentHash) {
    throw new Error('Hospital Reference selection content hash does not match')
  }
  return selectionSchema.parse({ ...payload, contentHash: actualContentHash })
}
