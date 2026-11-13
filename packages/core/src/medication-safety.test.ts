import { describe, expect, it } from 'vitest'
import { medicationCombinationConflict, medicationDoseConflict, medicationIndicationMatches, medicationScheduledHours } from './medication-safety.ts'

describe('共享药事安全规则', () => {
  it('允许跨类联合并拒绝 ACEI/ARB、ACEI/ARNI、双 P2Y12 和双他汀', () => {
    expect(medicationCombinationConflict(['antiplatelet-aspirin'], ['p2y12'])).toBe(false)
    expect(medicationCombinationConflict(['acei'], ['arb'])).toBe(true)
    expect(medicationCombinationConflict(['acei'], ['arni'])).toBe(true)
    expect(medicationCombinationConflict(['p2y12'], ['p2y12'])).toBe(true)
    expect(medicationCombinationConflict(['statin'], ['statin'])).toBe(true)
    expect(medicationCombinationConflict(['beta-blocker'], ['statin'])).toBe(false)
  })
  it('按 ICD-10 前缀匹配并拒绝其他疾病', () => {
    expect(medicationIndicationMatches(['I20', 'I25'], ['I25.103'])).toBe(true)
    expect(medicationIndicationMatches(['I20', 'I25'], ['J06.9'])).toBe(false)
  })
  it('校验换算后的单次与单日极量，并拒绝未知单位', () => {
    const limits = { unit: 'mg' as const, minimumSingleDose: 50, maximumSingleDose: 1000, maximumDailyDose: 3000 }
    expect(medicationDoseConflict(limits, '0.5 g', 'TID')).toBeUndefined()
    expect(medicationDoseConflict(limits, '1.5 g', 'QD')).toBe('single-dose')
    expect(medicationDoseConflict(limits, '1 g', 'PRN')).toBe('daily-dose')
    expect(medicationDoseConflict(limits, '2 tablets', 'QD')).toBe('invalid-dose')
  })
  it('使用声明的执行时点', () => {
    expect(medicationScheduledHours('QD')).toEqual([8])
    expect(medicationScheduledHours('BID')).toEqual([8, 20])
    expect(medicationScheduledHours('TID')).toEqual([8, 14, 20])
    expect(medicationScheduledHours('QN')).toEqual([22])
    expect(medicationScheduledHours('PRN')).toEqual([])
    expect(medicationScheduledHours('ONCE')).toEqual([])
  })
})
