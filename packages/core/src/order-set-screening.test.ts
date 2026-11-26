import { describe, expect, it } from 'vitest'
import type { OrderSetScreeningRule } from '@clinmesh/contracts/order-set-templates'
import {
  orderSetAllergyReason,
  orderSetDisposition,
  orderSetOutpatientQuantity,
  screenOrderSetActiveOrder,
  screenOrderSetInFlightInvestigation,
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

  it('skips already-active orders, mutually-exclusive active medication classes, and in-flight investigations while keeping exclude higher priority than skip', () => {
    const activeOrders = [
      {
        catalogItemId: 'medication-aspirin',
        code: 'ASPIRIN',
        display: '阿司匹林肠溶片',
        duration: 'long' as const,
        kind: 'medication' as const,
        orderId: 'order-asp',
        pharmacologyClasses: ['antiplatelet-aspirin'],
        reference: 'MedicationRequest/order-asp',
      },
      {
        catalogItemId: 'medication-ticagrelor',
        code: 'TICAGRELOR',
        display: '替格瑞洛片',
        duration: 'long' as const,
        kind: 'medication' as const,
        orderId: 'order-tica',
        pharmacologyClasses: ['p2y12'],
        reference: 'MedicationRequest/order-tica',
      },
      {
        catalogItemId: 'hospital-service-postop-ecg-monitoring',
        code: 'POSTOP-ECG-MONITORING',
        display: '术后持续心电监护',
        duration: 'temporary' as const,
        kind: 'service' as const,
        orderId: 'order-ecg-mon',
        reference: 'ServiceRequest/order-ecg-mon',
      },
    ]

    const exactMed = screenOrderSetActiveOrder(
      { catalogItemId: 'medication-aspirin', code: 'ASPIRIN', display: '阿司匹林肠溶片', kind: 'medication', pharmacologyClasses: ['antiplatelet-aspirin'] },
      activeOrders,
    )
    expect(exactMed).toMatchObject({ code: 'already-active-order', severity: 'skip', sourceReference: 'MedicationRequest/order-asp' })
    expect(orderSetDisposition([exactMed!])).toBe('skipped')

    const crossSkuByConcept = screenOrderSetActiveOrder(
      {
        catalogItemId: 'medication-pci-aspirin',
        code: 'XB01AC06',
        display: '阿司匹林肠溶片（冠脉专包）',
        drugConceptCode: 'CM-DRUG-ASPIRIN',
        genericName: '阿司匹林肠溶片',
        kind: 'medication',
        pharmacologyClasses: ['antiplatelet-aspirin'],
      },
      [{
        catalogItemId: 'medication-aspirin',
        code: 'ASPIRIN',
        display: '阿司匹林肠溶片',
        drugConceptCode: 'CM-DRUG-ASPIRIN',
        duration: 'long',
        genericName: '阿司匹林肠溶片',
        kind: 'medication',
        orderId: 'order-asp-alt',
        pharmacologyClasses: ['antiplatelet-aspirin'],
        reference: 'MedicationRequest/order-asp-alt',
      }],
    )
    expect(crossSkuByConcept).toMatchObject({ code: 'already-active-order', severity: 'skip', sourceReference: 'MedicationRequest/order-asp-alt' })

    const crossSkuByGeneric = screenOrderSetActiveOrder(
      {
        catalogItemId: 'medication-generic-amlodipine-10mg',
        code: 'NHSA-AML-10',
        display: '苯磺酸氨氯地平片 10mg',
        genericName: '苯磺酸氨氯地平片',
        kind: 'medication',
      },
      [{
        catalogItemId: 'medication-amlodipine',
        code: 'AMLODIPINE',
        display: '苯磺酸氨氯地平片 5mg',
        duration: 'long',
        genericName: '苯磺酸氨氯地平片',
        kind: 'medication',
        orderId: 'order-aml-5',
        reference: 'MedicationRequest/order-aml-5',
      }],
    )
    expect(crossSkuByGeneric).toMatchObject({ code: 'already-active-order', severity: 'skip', sourceReference: 'MedicationRequest/order-aml-5' })

    const mutexMed = screenOrderSetActiveOrder(
      { catalogItemId: 'medication-clopidogrel', code: 'CLOPIDOGREL', display: '硫酸氢氯吡格雷片', kind: 'medication', pharmacologyClasses: ['p2y12'] },
      activeOrders,
    )
    expect(mutexMed).toMatchObject({ code: 'mutually-exclusive-active-order', severity: 'skip', sourceReference: 'MedicationRequest/order-tica' })
    expect(mutexMed!.messageZh).toContain('替格瑞洛片')

    const exactService = screenOrderSetActiveOrder(
      { catalogItemId: 'hospital-service-postop-ecg-monitoring', code: 'POSTOP-ECG-MONITORING', display: '术后持续心电监护', kind: 'service' },
      activeOrders,
    )
    expect(exactService).toMatchObject({ code: 'already-active-order', severity: 'skip', sourceReference: 'ServiceRequest/order-ecg-mon' })

    const noConflict = screenOrderSetActiveOrder(
      { catalogItemId: 'medication-sodium-chloride', code: 'SODIUM_CHLORIDE_0_9', display: '0.9%氯化钠注射液', kind: 'medication', pharmacologyClasses: ['crystalloid'] },
      activeOrders,
    )
    expect(noConflict).toBeUndefined()

    const inFlight = screenOrderSetInFlightInvestigation(
      { catalogItemId: 'lab-hs-ctni', display: '高敏肌钙蛋白I', kind: 'laboratory', referenceCode: '2100404B' },
      [{ catalogItemId: 'lab-hs-ctni', display: '高敏肌钙蛋白I', kind: 'laboratory', reference: 'ServiceRequest/inv-1', referenceCode: '2100404B', status: 'issued' }],
    )
    expect(inFlight).toMatchObject({ code: 'in-flight-investigation', severity: 'skip', sourceReference: 'ServiceRequest/inv-1' })
    expect(screenOrderSetInFlightInvestigation(
      { catalogItemId: 'examination-ecg-12-lead', display: '十二导联心电图', examCode: 'ecg-12-lead', kind: 'examination' },
      [{ catalogItemId: 'lab-hs-ctni', display: '高敏肌钙蛋白I', kind: 'laboratory', reference: 'ServiceRequest/inv-1', referenceCode: '2100404B', status: 'issued' }],
    )).toBeUndefined()

    const allergyReason = orderSetAllergyReason({ code: 'ASPIRIN', display: '阿司匹林', reference: 'AllergyIntolerance/a' })
    expect(orderSetDisposition([exactMed!, allergyReason])).toBe('excluded')
    expect(orderSetDisposition([exactMed!, { code: 'vital-signs-missing', messageZh: '缺体征', observedValue: null, severity: 'pending-verification', sourceReference: null, threshold: null }])).toBe('skipped')
    expect(orderSetDisposition([exactMed!, { code: 'catalog-unavailable', messageZh: '未开展', observedValue: null, severity: 'unavailable', sourceReference: null, threshold: null }])).toBe('unavailable')
  })
})
