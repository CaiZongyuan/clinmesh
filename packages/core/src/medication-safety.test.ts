import { describe, expect, it } from 'vitest'
import {
  MEDICATION_ROUTE_CODE_SYSTEM,
  deriveReferenceMedicationRoutes,
  formatMedicationFrequency,
  formatMedicationRoute,
  medicationCombinationConflict,
  medicationDoseConflict,
  medicationIndicationMatches,
  medicationQuantityAllowed,
  medicationRouteAllowed,
  medicationRouteConcept,
  medicationScheduledHours,
} from './medication-safety.ts'

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
  it('将八种受控给药途径统一格式化为中文全角括号小写缩写与英文标准标签，并输出 FHIR R5 CodeableConcept', () => {
    expect(formatMedicationRoute('PO', 'zh-CN')).toBe('口服（po）')
    expect(formatMedicationRoute('IVGTT', 'zh-CN')).toBe('静脉滴注（ivgtt）')
    expect(formatMedicationRoute('IV', 'zh-CN')).toBe('静脉注射（iv）')
    expect(formatMedicationRoute('IM', 'zh-CN')).toBe('肌内注射（im）')
    expect(formatMedicationRoute('IH', 'zh-CN')).toBe('皮下注射（ih）')
    expect(formatMedicationRoute('SL', 'zh-CN')).toBe('舌下含服（sl）')
    expect(formatMedicationRoute('TOP', 'zh-CN')).toBe('外用（top）')
    expect(formatMedicationRoute('INH', 'zh-CN')).toBe('吸入（inh）')
    expect(formatMedicationRoute(' ivgtt ', 'zh-CN')).toBe('静脉滴注（ivgtt）')
    expect(formatMedicationRoute('PO', 'en-US')).toBe('Oral (po)')
    expect(formatMedicationRoute('IVGTT', 'en-US')).toBe('Intravenous infusion (ivgtt)')
    expect(formatMedicationRoute('IV', 'en-US')).toBe('Intravenous injection (iv)')
    expect(formatMedicationRoute('IM', 'en-US')).toBe('Intramuscular injection (im)')
    expect(formatMedicationRoute('IH', 'en-US')).toBe('Subcutaneous injection (ih)')
    expect(formatMedicationRoute('SL', 'en-US')).toBe('Sublingual (sl)')
    expect(formatMedicationRoute('TOP', 'en-US')).toBe('Topical (top)')
    expect(formatMedicationRoute('INH', 'en-US')).toBe('Inhalation (inh)')
    expect(formatMedicationRoute('UNKNOWN', 'zh-CN')).toBe('UNKNOWN')

    expect(medicationRouteAllowed(['IV', 'IVGTT', 'IH'], 'IH')).toBe(true)
    expect(medicationRouteAllowed(['IV', 'IVGTT', 'IH'], 'PO')).toBe(false)

    expect(medicationRouteConcept('IV')).toEqual({
      coding: [{
        system: MEDICATION_ROUTE_CODE_SYSTEM,
        code: 'IV',
        display: '静脉注射',
      }],
      text: '静脉注射（iv）',
    })
    expect(medicationRouteConcept('IVGTT')).toEqual({
      coding: [{
        system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/medication-route',
        code: 'IVGTT',
        display: '静脉滴注',
      }],
      text: '静脉滴注（ivgtt）',
    })
  })
  it('按剂型与通用名确定性派生国家参考目录的默认途径与允许途径集合，完整覆盖 8 种受控途径', () => {
    expect(deriveReferenceMedicationRoutes({ dosageForm: '片剂', genericName: '苯磺酸氨氯地平片' }))
      .toEqual({ defaultRouteCode: 'PO', allowedRouteCodes: ['PO'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '片剂', genericName: '硝酸甘油片' }))
      .toEqual({ defaultRouteCode: 'SL', allowedRouteCodes: ['SL', 'PO'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '片剂(舌下片)', genericName: '硝酸甘油舌下片' }))
      .toEqual({ defaultRouteCode: 'SL', allowedRouteCodes: ['SL'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '吸入粉雾剂', genericName: '布地奈德福莫特罗粉雾剂' }))
      .toEqual({ defaultRouteCode: 'INH', allowedRouteCodes: ['INH'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '气雾剂', genericName: '硫酸沙丁胺醇气雾剂' }))
      .toEqual({ defaultRouteCode: 'INH', allowedRouteCodes: ['INH'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '气雾剂', genericName: '云南白药气雾剂' }))
      .toEqual({ defaultRouteCode: 'TOP', allowedRouteCodes: ['TOP'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '溶液剂(含甘油)', genericName: '开塞露(含甘油)' }))
      .toEqual({ defaultRouteCode: 'TOP', allowedRouteCodes: ['TOP'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '注射剂(外用)', genericName: '外用人表皮生长因子' }))
      .toEqual({ defaultRouteCode: 'TOP', allowedRouteCodes: ['TOP'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '注射剂', genericName: '依诺肝素钠注射液' }))
      .toEqual({ defaultRouteCode: 'IH', allowedRouteCodes: ['IH'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '注射剂', genericName: '门冬胰岛素注射液' }))
      .toEqual({ defaultRouteCode: 'IH', allowedRouteCodes: ['IH', 'IV', 'IVGTT'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '注射剂', genericName: '黄体酮注射液' }))
      .toEqual({ defaultRouteCode: 'IM', allowedRouteCodes: ['IM'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '注射剂(大容量注射剂)', genericName: '0.9%氯化钠注射液' }))
      .toEqual({ defaultRouteCode: 'IVGTT', allowedRouteCodes: ['IVGTT', 'IV'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '注射剂', genericName: '肝素钠注射液' }))
      .toEqual({ defaultRouteCode: 'IV', allowedRouteCodes: ['IV', 'IVGTT', 'IH'] })
    expect(deriveReferenceMedicationRoutes({ dosageForm: '注射剂', genericName: '呋塞米注射液' }))
      .toEqual({ defaultRouteCode: 'IV', allowedRouteCodes: ['IV', 'IVGTT', 'IM', 'IH'] })
  })
})
