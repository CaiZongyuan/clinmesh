import { describe, expect, it } from 'vitest'
import { formatMedicationFrequency, medicationCombinationConflict, medicationDoseConflict, medicationIndicationMatches, medicationQuantityAllowed, medicationScheduledHours } from './medication-safety.ts'

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
  it('按疗程上限校验发药总量，ONCE 频次不乘多日疗程', () => {
    const config = {
      allowedQuantities: [1],
      safety: { pharmacologyClasses: ['calcium-channel-blocker'], indicationPrefixes: ['I10'], doseLimits: { unit: 'mg' as const, minimumSingleDose: 5, maximumSingleDose: 10, maximumDailyDose: 10 }, maximumDailyQuantity: 2 },
    }
    expect(medicationQuantityAllowed(config, 28, 14, 'QD')).toBe(true)
    expect(medicationQuantityAllowed(config, 29, 14, 'QD')).toBe(false)
    expect(medicationQuantityAllowed(config, 2, 14, 'ONCE')).toBe(true)
    expect(medicationQuantityAllowed(config, 3, 14, 'ONCE')).toBe(false)
  })
  it('使用声明的执行时点', () => {
    expect(medicationScheduledHours('QD')).toEqual([8])
    expect(medicationScheduledHours('BID')).toEqual([8, 20])
    expect(medicationScheduledHours('TID')).toEqual([8, 14, 20])
    expect(medicationScheduledHours('QN')).toEqual([22])
    expect(medicationScheduledHours('PRN')).toEqual([])
    expect(medicationScheduledHours('ONCE')).toEqual([])
  })
  it('将标准频次编码统一格式化为中英文带括号缩写文本，并在需要时保留执行时点', () => {
    expect(formatMedicationFrequency('QD', 'zh-CN')).toBe('每日一次（QD）')
    expect(formatMedicationFrequency('BID', 'zh-CN')).toBe('每日两次（BID）')
    expect(formatMedicationFrequency('TID', 'zh-CN')).toBe('每日三次（TID）')
    expect(formatMedicationFrequency('QN', 'zh-CN')).toBe('每晚一次（QN）')
    expect(formatMedicationFrequency('PRN', 'zh-CN')).toBe('必要时（PRN）')
    expect(formatMedicationFrequency('ONCE', 'zh-CN')).toBe('仅一次（ONCE）')
    expect(formatMedicationFrequency('bid', 'zh-CN')).toBe('每日两次（BID）')
    expect(formatMedicationFrequency('BID', 'zh-CN', { withTime: true })).toBe('每日两次（BID） · 08:00、20:00')
    expect(formatMedicationFrequency('PRN', 'zh-CN', { withTime: true })).toBe('必要时（PRN）')
    expect(formatMedicationFrequency('BID', 'en-US')).toBe('Twice daily (BID)')
    expect(formatMedicationFrequency('PRN', 'en-US')).toBe('As needed (PRN)')
    expect(formatMedicationFrequency('TID', 'en-US', { withTime: true })).toBe('Three times daily (TID) · 08:00, 14:00, 20:00')
    expect(formatMedicationFrequency('自定义外延频次', 'zh-CN')).toBe('自定义外延频次')
  })
})
