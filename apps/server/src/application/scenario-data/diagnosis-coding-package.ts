import { referenceCodingIdentity } from '@clinmesh/contracts/reference-data'
import { z } from 'zod'
import packageData from '../../../reference-data/diagnosis-mappings.json' with { type: 'json' }
import { canonicalJsonHash } from './canonical-json.ts'

const codingSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1),
  system: z.string().url(),
  version: z.string().min(1),
}).strict()

const diagnosisMappingSchema = z.object({
  direction: z.literal('source-to-target'),
  evidence: z.array(z.string().min(1)).min(1),
  mappingId: z.string().min(1),
  relationship: z.enum(['broader', 'equivalent', 'narrower', 'related']),
  source: codingSchema,
  status: z.enum(['active', 'candidate', 'inactive']),
  target: codingSchema.extend({
    catalogItemId: z.string().min(1),
  }).strict(),
}).strict()

const diagnosisMappingPackageSchema = z.object({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  mappingSetId: z.string().min(1),
  mappings: z.array(diagnosisMappingSchema),
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
      message: 'Diagnosis mapping package content hash does not match its content',
      path: ['contentHash'],
    })
  }
  const mappingIds = new Set<string>()
  value.mappings.forEach((mapping, index) => {
    if (mappingIds.has(mapping.mappingId)) {
      context.addIssue({
        code: 'custom',
        message: 'Diagnosis mapping ID was repeated',
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
        message: 'Diagnosis mapping source does not match its package source',
        path: ['mappings', index, 'source'],
      })
    }
    if (
      mapping.target.system !== value.targetSystem
      || mapping.target.version !== value.targetVersion
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Diagnosis mapping target does not match its package target',
        path: ['mappings', index, 'target'],
      })
    }
  })
})

export type DiagnosisMappingPackage = z.infer<typeof diagnosisMappingPackageSchema>

export function parseDiagnosisMappingPackage(input: unknown): DiagnosisMappingPackage {
  return diagnosisMappingPackageSchema.parse(input)
}

const diagnosisMappingPackage = parseDiagnosisMappingPackage(packageData)

export function diagnosisMappingPackageProvenance() {
  return {
    contentHash: diagnosisMappingPackage.contentHash,
    mappingSetId: diagnosisMappingPackage.mappingSetId,
    version: diagnosisMappingPackage.version,
  }
}

function reviewedMappingResolution(
  candidates: DiagnosisMappingPackage['mappings'],
  display: string | undefined,
) {
  if (candidates.length === 0) return { status: 'unmapped' as const }
  if (display !== undefined && candidates.every(mapping => mapping.source.display !== display)) {
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

export function resolveDiagnosisMapping(
  input: { code?: string; display?: string; system?: string; version?: string },
  mappingPackage = diagnosisMappingPackage,
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
  return reviewedMappingResolution(candidates, input.display)
}
