import { describe, expect, it } from 'vitest'
import type { OrderSetScreeningRule } from '@clinmesh/contracts/order-set-templates'
import {
  orderSetAllergyReason,
  orderSetDisposition,
  orderSetOutpatientQuantity,
  screenOrderSetRules,
  type OrderSetScreeningFacts,
} from './order-set-screening.ts'

const betaBlockerRules: OrderSetScreeningRule[] = [
  { action: 'exclude', comparator: 'below', input: 'pulseBpm', rationaleZh: '心动过缓时不起始 β 受体阻滞剂', threshold: 50 },
  { action: 'caution', comparator: 'below', input: 'pulseBpm', rationaleZh: '心率偏慢需监测', threshold: 60 },
  { action: 'exclude', comparator: 'below', input: 'systolicMmHg', rationaleZh: '低血压时不起始', threshold: 90 },
]
const normalFacts: OrderSetScreeningFacts = {
  egfr: { reference: 'Observation/scr', value: 88.4 },
  pulseBpm: { reference: 'Observation/vitals', value: 76 },
  systolicMmHg: { reference: 'Observation/vitals', value: 128 },
  weightKg: { reference: 'Observation/vitals', value: 70 },
}

describe('order set screening', () => {
  it('keeps candidates ready when objective facts are within thresholds', () => {
    const reasons = screenOrderSetRules(betaBlockerRules, normalFacts)
    expect(reasons).toEqual([])
    expect(orderSetDisposition(reasons)).toBe('ready')
  })

  it('excludes on bradycardia and hypotension with structured source references', () => {
    const reasons = screenOrderSetRules(betaBlockerRules, { ...normalFacts, pulseBpm: { reference: 'Observation/v2', value: 46 }, systolicMmHg: { reference: 'Observation/v2', value: 86 } })
    expect(reasons.map(reason => [reason.code, reason.severity, reason.observedValue, reason.threshold, reason.sourceReference])).toEqual([
      ['pulse-below-threshold', 'exclude', 46, 50, 'Observation/v2'],
      ['pulse-below-threshold', 'caution', 46, 60, 'Observation/v2'],
      ['systolic-below-threshold', 'exclude', 86, 90, 'Observation/v2'],
    ])
    expect(orderSetDisposition(reasons)).toBe('excluded')
  })

  it('flags a single pending verification when vital signs are missing instead of assuming normal', () => {
    const reasons = screenOrderSetRules(betaBlockerRules, { ...normalFacts, pulseBpm: null, systolicMmHg: null })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatchObject({ code: 'vital-signs-missing', severity: 'pending-verification', observedValue: null })
    expect(reasons[0]!.messageZh).toContain('不按正常值处理')
    expect(orderSetDisposition(reasons)).toBe('needs-review')
  })

  it('evaluates renal thresholds, at-least applicability and required weight', () => {
    const rules: OrderSetScreeningRule[] = [
      { action: 'caution', comparator: 'at-least', input: 'egfr', rationaleZh: '非对比剂肾损高危', threshold: 60 },
      { action: 'caution', comparator: 'required', input: 'weightKg', rationaleZh: '按 1 mL/kg/h 核定滴速', threshold: null },
    ]
    expect(screenOrderSetRules(rules, normalFacts).map(reason => reason.code)).toEqual(['egfr-at-or-above-threshold'])
    expect(screenOrderSetRules(rules, { ...normalFacts, egfr: { reference: null, value: 24.46 } })).toEqual([])
    expect(screenOrderSetRules(rules, { ...normalFacts, egfr: null, weightKg: null }).map(reason => reason.code)).toEqual(['egfr-missing', 'weight-missing'])
    const severe = screenOrderSetRules([{ action: 'exclude', comparator: 'below', input: 'egfr', rationaleZh: '严重肾损', threshold: 30 }], { ...normalFacts, egfr: { reference: null, value: 24.46 } })
    expect(severe[0]).toMatchObject({ code: 'egfr-below-threshold', observedValue: 24.5, severity: 'exclude' })
  })

  it('maps allergy contraindications with structured allergen metadata and dispositions deterministically', () => {
    const allergyReason = orderSetAllergyReason({ code: 'ASPIRIN', display: '阿司匹林', reference: 'AllergyIntolerance/a' })
    expect(allergyReason).toMatchObject({
      allergen: { code: 'ASPIRIN', display: '阿司匹林' },
      code: 'allergy-contraindication',
      severity: 'exclude',
      sourceReference: 'AllergyIntolerance/a',
    })
    expect(orderSetDisposition([allergyReason])).toBe('excluded')
    expect(orderSetDisposition([{ code: 'catalog-unavailable', messageZh: '未开展', observedValue: null, severity: 'unavailable', sourceReference: null, threshold: null }])).toBe('unavailable')
  })

  it('derives outpatient dispensing quantity from strength, frequency and course', () => {
    expect(orderSetOutpatientQuantity({ courseDays: 7, doseText: '20 mg', frequencyCode: 'QN', strength: '10 mg' })).toBe(14)
    expect(orderSetOutpatientQuantity({ courseDays: 7, doseText: '90 mg', frequencyCode: 'BID', strength: '90 mg' })).toBe(14)
    expect(orderSetOutpatientQuantity({ courseDays: 7, doseText: '0.5 mg', frequencyCode: 'PRN', prnQuantity: 10, strength: '0.5 mg' })).toBe(10)
    expect(orderSetOutpatientQuantity({ courseDays: 7, doseText: '1 g', frequencyCode: 'ONCE', strength: '500 mg' })).toBe(2)
    expect(orderSetOutpatientQuantity({ courseDays: 7, doseText: '30 mg', frequencyCode: 'QD', strength: '20 mg' })).toBeUndefined()
    expect(orderSetOutpatientQuantity({ courseDays: 7, doseText: '500 mL', frequencyCode: 'QD', strength: '10 mg' })).toBeUndefined()
  })
})
