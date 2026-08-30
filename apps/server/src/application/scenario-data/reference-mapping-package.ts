import { referenceCodingIdentity } from '@clinmesh/contracts/reference-data'
import { z } from 'zod'
import { canonicalJsonHash } from './canonical-json.ts'

export const referenceMappingCodingSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1),
  system: z.string().url(),
  version: z.string().min(1),
}).strict()

const referenceMappingShape = {
  direction: z.literal('source-to-target'),
  evidence: z.array(z.string().min(1)).min(1),
  mappingId: z.string().min(1),
  relationship: z.enum(['broader', 'equivalent', 'narrower', 'related']),
  source: referenceMappingCodingSchema,
  status: z.enum(['active', 'candidate', 'inactive']),
}

export function createReferenceMappingPackageSchema<
  Target extends z.ZodObject<z.ZodRawShape>,
>(targetSchema: Target) {
  const mappingSchema = z.object({ ...referenceMappingShape, target: targetSchema }).strict()
  return z.object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    mappingSetId: z.string().min(1),
    mappings: z.array(mappingSchema),
    schemaVersion: z.literal('1'),
    sourceSystem: z.string().url(),
    sourceVersion: z.string().min(1),
    targetSystem: z.string().url(),
    targetVersion: z.string().min(1),
    version: z.string().min(1),
  }).strict().superRefine((value, context) => {
    const { contentHash, ...content } = value
    if (canonicalJsonHash(content) !== contentHash) {
      context.addIssue({
        code: 'custom',
        message: 'Reference mapping package content hash does not match its content',
        path: ['contentHash'],
      })
    }
    const mappingIds = new Set<string>()
    const mappingTargets = z.array(z.object({
      target: referenceMappingCodingSchema.passthrough(),
    }).passthrough()).parse(value.mappings)
    value.mappings.forEach((mapping, index) => {
      if (mappingIds.has(mapping.mappingId)) {
        context.addIssue({
          code: 'custom',
          message: 'Reference mapping ID was repeated',
          path: ['mappings', index, 'mappingId'],
        })
      }
      mappingIds.add(mapping.mappingId)
      if (
        mapping.source.system !== value.sourceSystem
        || mapping.source.version !== value.sourceVersion
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Reference mapping source does not match its package source',
          path: ['mappings', index, 'source'],
        })
      }
      const target = mappingTargets[index]!.target
      if (
        target.system !== value.targetSystem
        || target.version !== value.targetVersion
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Reference mapping target does not match its package target',
          path: ['mappings', index, 'target'],
        })
      }
    })
  })
}

interface MappingCoding {
  code: string
  display: string
  system: string
  version: string
}

interface ResolvableMapping {
  direction: 'source-to-target'
  relationship: 'broader' | 'equivalent' | 'narrower' | 'related'
  source: MappingCoding
  status: 'active' | 'candidate' | 'inactive'
}

interface ResolvablePackage<Mapping extends ResolvableMapping> {
  mappings: Mapping[]
  sourceSystem: string
  sourceVersion: string
}

export function resolveReferenceMapping<Mapping extends ResolvableMapping>(
  input: { code?: string; display?: string; system?: string; version?: string },
  mappingPackage: ResolvablePackage<Mapping>,
) {
  if (
    input.code === undefined
    || input.system === undefined
    || input.system !== mappingPackage.sourceSystem
  ) {
    return { status: 'unmapped' as const }
  }
  const sourceIdentity = referenceCodingIdentity({
    code: input.code,
    system: input.system,
    version: input.version ?? mappingPackage.sourceVersion,
  })
  const candidates = mappingPackage.mappings.filter(mapping => (
    referenceCodingIdentity(mapping.source) === sourceIdentity
  ))
  if (candidates.length === 0) return { status: 'unmapped' as const }
  if (input.display !== undefined && candidates.every(mapping => mapping.source.display !== input.display)) {
    return { status: 'display-mismatch' as const }
  }
  const applicable = candidates.filter(mapping => (
    mapping.status === 'active'
    && mapping.direction === 'source-to-target'
    && mapping.relationship === 'equivalent'
  ))
  if (applicable.length === 0) return { status: 'not-equivalent' as const }
  if (applicable.length > 1) return { status: 'ambiguous' as const }
  return { mapping: applicable[0]!, status: 'mapped' as const }
}
