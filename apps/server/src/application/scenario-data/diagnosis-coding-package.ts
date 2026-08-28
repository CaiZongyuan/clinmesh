import { z } from 'zod'
import packageData from '../../../reference-data/diagnosis-mappings.json' with { type: 'json' }
import {
  createReferenceMappingPackageSchema,
  referenceMappingCodingSchema,
  resolveReferenceMapping,
} from './reference-mapping-package.ts'

const diagnosisMappingPackageSchema = createReferenceMappingPackageSchema(
  referenceMappingCodingSchema.extend({
    catalogItemId: z.string().min(1),
  }).strict(),
)

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

export function resolveDiagnosisMapping(
  input: { code?: string; display?: string; system?: string; version?: string },
  mappingPackage = diagnosisMappingPackage,
) {
  return resolveReferenceMapping(input, mappingPackage)
}
