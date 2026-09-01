import { describe, expect, it } from 'vitest'
import {
  referenceCodingPackageSchema,
  syntheticInvestigationReferenceRange,
} from '../src/application/scenario-data/reference-coding-package.ts'

const unit = {
  code: 'mg/dL',
  display: 'mg/dL',
  system: 'http://unitsofmeasure.org',
  version: '2.2',
} as const

const mapping = {
  source: {
    code: '2339-0',
    display: 'Glucose [Mass/volume] in Blood',
    system: 'http://loinc.org',
    version: '2.83',
  },
  target: {
    catalogItemId: 'lab-random-glucose',
    code: 'GLUCOSE',
    feeFen: 500,
    name: '随机血糖',
    referenceMaximum: 11.1,
    referenceMinimum: 3.9,
    referenceRange: '3.9-11.1 mmol/L',
    reportTemplate: '随机血糖 {value} {unit}',
    sourceUnits: [{ multiplier: 0.0555075, unitCode: 'mg/dL' }],
    tatMinutes: 30,
    unitCode: 'mg/dL',
  },
} as const

const codingPackage = {
  loincVersion: '2.83',
  observationMappings: [mapping],
  schemaVersion: '1',
  ucumVersion: '2.2',
  units: [unit],
} as const

describe('Reference coding package', () => {
  it('rejects ambiguous units, inverted ranges, and mismatched LOINC versions', () => {
    expect(() => referenceCodingPackageSchema.parse({
      ...codingPackage,
      observationMappings: [{
        ...mapping,
        target: {
          ...mapping.target,
          sourceUnits: [
            { multiplier: 0.0555075, unitCode: 'mg/dL' },
            { multiplier: 1, unitCode: 'mg/dL' },
          ],
        },
      }],
    })).toThrow(/source unit was repeated/)
    expect(() => referenceCodingPackageSchema.parse({
      ...codingPackage,
      observationMappings: [{
        ...mapping,
        target: { ...mapping.target, referenceMaximum: 3.9, referenceMinimum: 11.1 },
      }],
    })).toThrow(/reference range is inverted/)
    expect(() => referenceCodingPackageSchema.parse({
      ...codingPackage,
      observationMappings: [{
        ...mapping,
        source: { ...mapping.source, version: '2.82' },
      }],
    })).toThrow(/expected.*2\.83/)
  })

  it('converts a configured reference range into the requested source unit', () => {
    expect(syntheticInvestigationReferenceRange({
      code: '2339-0',
      system: 'http://loinc.org',
      unitCode: 'mg/dL',
      unitDisplay: 'mg/dL',
      version: '2.83',
    })).toEqual({
      high: 199.973,
      low: 70.2608,
      text: '合成成人演示范围 70.2608-199.973 mg/dL',
    })
  })
})
