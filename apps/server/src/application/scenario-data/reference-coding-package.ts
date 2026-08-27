import {
  scenarioLoincCodingSchema,
  scenarioUcumUnitSchema,
} from '@clinmesh/contracts/scenario'
import { referenceCodingIdentity } from '@clinmesh/contracts/reference-data'
import { z } from 'zod'
import packageData from '../../../reference-data/loinc-ucum-mappings.json' with { type: 'json' }

const observationMappingSchema = z.object({
  source: scenarioLoincCodingSchema,
  target: z.object({
    catalogItemId: z.string().min(1),
    code: z.string().min(1),
    feeFen: z.number().int().nonnegative(),
    name: z.string().min(1),
    referenceMaximum: z.number().optional(),
    referenceMinimum: z.number().optional(),
    referenceRange: z.string().min(1),
    reportTemplate: z.string().min(1),
    sourceUnits: z.array(z.object({
      multiplier: z.number().positive(),
      unitCode: z.string().min(1),
    }).strict()).min(1),
    tatMinutes: z.number().int().nonnegative(),
    unitCode: z.string().min(1),
  }).strict(),
}).strict()

const codingPackageSchema = z.object({
  loincVersion: z.literal('2.83'),
  observationMappings: z.array(observationMappingSchema),
  schemaVersion: z.literal('1'),
  ucumVersion: z.literal('2.2'),
  units: z.array(scenarioUcumUnitSchema),
}).strict().superRefine((value, context) => {
  const unitCodes = new Set<string>()
  value.units.forEach((unit, index) => {
    if (unitCodes.has(unit.code)) {
      context.addIssue({
        code: 'custom',
        message: 'UCUM unit code was repeated',
        path: ['units', index, 'code'],
      })
    }
    unitCodes.add(unit.code)
  })
  const sourceKeys = new Set<string>()
  const catalogItemIds = new Set<string>()
  value.observationMappings.forEach((mapping, index) => {
    const sourceKey = referenceCodingIdentity(mapping.source)
    if (sourceKeys.has(sourceKey)) {
      context.addIssue({
        code: 'custom',
        message: 'LOINC source coding was repeated',
        path: ['observationMappings', index, 'source'],
      })
    }
    sourceKeys.add(sourceKey)
    if (catalogItemIds.has(mapping.target.catalogItemId)) {
      context.addIssue({
        code: 'custom',
        message: 'Hospital investigation mapping was repeated',
        path: ['observationMappings', index, 'target', 'catalogItemId'],
      })
    }
    catalogItemIds.add(mapping.target.catalogItemId)
    if (!unitCodes.has(mapping.target.unitCode)) {
      context.addIssue({
        code: 'custom',
        message: 'Observation mapping references an unknown UCUM unit',
        path: ['observationMappings', index, 'target', 'unitCode'],
      })
    }
    mapping.target.sourceUnits.forEach((sourceUnit, sourceUnitIndex) => {
      if (!unitCodes.has(sourceUnit.unitCode)) {
        context.addIssue({
          code: 'custom',
          message: 'Observation mapping source uses an unknown UCUM unit',
          path: ['observationMappings', index, 'target', 'sourceUnits', sourceUnitIndex],
        })
      }
    })
  })
})

const codingPackage = codingPackageSchema.parse(packageData)
const unitsByCode = new Map(codingPackage.units.map(unit => [unit.code, unit]))
const unitsByDisplay = new Map(codingPackage.units.map(unit => [unit.display, unit]))
const observationMappingCodes = new Set(
  codingPackage.observationMappings.map(mapping => mapping.source.code),
)

const observationMappings = new Map(codingPackage.observationMappings.map((mapping) => {
  const unit = unitsByCode.get(mapping.target.unitCode)
  if (unit === undefined) throw new Error(`UCUM 2.2 unit was not found: ${mapping.target.unitCode}`)
  return [referenceCodingIdentity(mapping.source), {
    ...mapping.target,
    coding: mapping.source,
    unit,
  }]
}))

export function resolveObservationMapping(input: {
  code?: string
  display?: string
  system?: string
  version?: string
}) {
  if (input.code === undefined || input.system === undefined) return undefined
  const version = input.version ?? (input.system === 'http://loinc.org'
    ? codingPackage.loincVersion
    : undefined)
  const mapping = version === undefined
    ? undefined
    : observationMappings.get(referenceCodingIdentity({ code: input.code, system: input.system, version }))
  return mapping !== undefined
    && (input.display === undefined || input.display === mapping.coding.display)
    ? mapping
    : undefined
}

export function isKnownObservationMappingCode(code: string): boolean {
  return observationMappingCodes.has(code)
}

export function investigationLoincCoding(catalogItemId: string) {
  return codingPackage.observationMappings.find(
    mapping => mapping.target.catalogItemId === catalogItemId,
  )?.source
}

export function isKnownLoincCoding(input: {
  code: string
  display: string
  system: string
  version: string
}): boolean {
  const mapping = observationMappings.get(referenceCodingIdentity(input))
  return mapping !== undefined && mapping.coding.display === input.display
}

export function ucumUnit(code: string) {
  const unit = unitsByCode.get(code)
  if (unit === undefined) throw new Error(`UCUM 2.2 unit was not found: ${code}`)
  return unit
}

export function resolveUcumUnit(input: {
  code?: string
  display?: string
  system?: string
}) {
  if (input.system !== undefined && input.system !== 'http://unitsofmeasure.org') return undefined
  const codeUnit = input.code === undefined ? undefined : unitsByCode.get(input.code)
  const displayUnit = input.display === undefined ? undefined : unitsByDisplay.get(input.display)
  if (input.code !== undefined && codeUnit === undefined) return undefined
  if (input.display !== undefined && displayUnit === undefined) return undefined
  if (codeUnit !== undefined && displayUnit !== undefined && codeUnit.code !== displayUnit.code) {
    return undefined
  }
  return codeUnit ?? displayUnit
}

export function isKnownUcumUnit(input: {
  code: string
  display: string
  system: string
  version: string
}): boolean {
  const unit = unitsByCode.get(input.code)
  return unit !== undefined
    && unit.display === input.display
    && unit.system === input.system
    && unit.version === input.version
}
