import { describe, expect, it } from 'vitest'
import { laboratoryRequestStateSchema, laboratoryResultSchema } from '../src/his.ts'

describe('HIS contracts', () => {
  it('rejects unsupported catalog items in a laboratory request draft', () => {
    expect(laboratoryRequestStateSchema.safeParse({
      draft: {
        catalogItemId: 'lab-fever-panel',
        indicationCode: 'fever',
      },
      draftVersion: 1,
      requests: [],
    }).success).toBe(false)
  })

  it('validates numeric laboratory results, UCUM units, ranges, and interpretation flags', () => {
    const result = {
      code: '1988-5',
      display: 'C 反应蛋白',
      interpretation: 'high',
      observationId: 'observation-crp-1',
      referenceRange: { high: 8, low: 0, text: '0-8 mg/L' },
      unit: {
        code: 'mg/L',
        display: 'mg/L',
        system: 'http://unitsofmeasure.org',
      },
      value: 18.6,
    }
    expect(laboratoryResultSchema.safeParse(result).success).toBe(true)
    expect(laboratoryResultSchema.safeParse({ ...result, value: '18.6' }).success).toBe(false)
    expect(laboratoryResultSchema.safeParse({
      ...result,
      interpretation: 'critical',
    }).success).toBe(false)
    expect(laboratoryResultSchema.safeParse({
      ...result,
      interpretation: 'normal',
    }).success).toBe(false)
    expect(laboratoryResultSchema.safeParse({
      ...result,
      referenceRange: { high: 0, low: 8, text: 'invalid' },
    }).success).toBe(false)
    expect(laboratoryResultSchema.safeParse({
      ...result,
      unit: { ...result.unit, system: 'https://example.test/units' },
    }).success).toBe(false)
  })
})
