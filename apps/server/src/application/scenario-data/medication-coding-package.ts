import { z } from 'zod'
import packageData from '../../../reference-data/medication-concept-mappings.json' with { type: 'json' }
import {
  createReferenceMappingPackageSchema,
  referenceMappingCodingSchema,
  resolveReferenceMapping,
} from './reference-mapping-package.ts'

const medicationMappingPackageSchema = createReferenceMappingPackageSchema(
  referenceMappingCodingSchema.extend({
    conceptId: z.string().min(1),
    kind: z.literal('drug-concept'),
  }).strict(),
)

export type MedicationMappingPackage = z.infer<typeof medicationMappingPackageSchema>

export function parseMedicationMappingPackage(input: unknown): MedicationMappingPackage {
  return medicationMappingPackageSchema.parse(input)
}

const medicationMappingPackage = parseMedicationMappingPackage(packageData)

export function medicationMappingPackageProvenance() {
  return {
    contentHash: medicationMappingPackage.contentHash,
    mappingSetId: medicationMappingPackage.mappingSetId,
    version: medicationMappingPackage.version,
  }
}

export function resolveMedicationMapping(
  input: { code?: string; display?: string; system?: string; version?: string },
  mappingPackage = medicationMappingPackage,
) {
  return resolveReferenceMapping(input, mappingPackage)
}

export function medicationMappingSourceVersion(input: {
  system?: string
  version?: string
}): string | undefined {
  return input.system === medicationMappingPackage.sourceSystem
    ? input.version ?? medicationMappingPackage.sourceVersion
    : input.version
}

export function isMedicationMappingSourceSystem(system: string | undefined): boolean {
  return system === medicationMappingPackage.sourceSystem
}
