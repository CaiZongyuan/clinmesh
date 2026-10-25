import { describe, expect, it } from 'vitest'
import { resolveInpatientDose } from './inpatient-dose.ts'

describe('住院明确剂量与完整制剂数量换算', () => {
  it.each(['constructor', 'toString', '__proto__'])('拒绝非法单位 %s 并返回单位错误', unit => {
    expect(resolveInpatientDose({ unit: '片', doseBasis: { amount: 75, unit: 'mg' }, maxDoseQuantity: 4, doses: [] }, `1 ${unit}`))
      .toEqual({ reason: 'unit-mismatch' })
  })

  it('按已声明的每制剂含量跨克与毫克精确换算，不受常用建议枚举限制', () => {
    expect(resolveInpatientDose({ unit: '片', doses: [{ doseText: '0.1 g', quantity: 1 }], doseBasis: { amount: 0.1, unit: 'g' }, maxDoseQuantity: 3 }, '300 mg')).toEqual({ quantity: 3 })
    expect(resolveInpatientDose({ unit: '片', doses: [], doseBasis: { amount: 75, unit: 'mg' }, maxDoseQuantity: 2 }, '0.15 g')).toEqual({ quantity: 2 })
    expect(resolveInpatientDose({ unit: '支', doses: [], doseBasis: { amount: 12500, unit: 'IU' }, maxDoseQuantity: 2 }, '25000 IU')).toEqual({ quantity: 2 })
  })

  it('直接制剂单位无需质量换算基底，缺基底的质量单位不能猜算', () => {
    const config = { unit: '片', doses: [], maxDoseQuantity: 2 }
    expect(resolveInpatientDose(config, '2片')).toEqual({ quantity: 2 })
    expect(resolveInpatientDose(config, '75 mg')).toEqual({ reason: 'missing-conversion' })
    expect(resolveInpatientDose(config, '0片')).toEqual({ reason: 'invalid-dose' })
    expect(resolveInpatientDose(config, '3片')).toEqual({ reason: 'dose-limit' })
  })

  it('拒绝非完整制剂、不兼容单位，旧配置保守沿用已声明的数量上限', () => {
    const config = { unit: '片', doses: [{ doseText: '75 mg', quantity: 1 }], doseBasis: { amount: 75, unit: 'mg' }, maxDoseQuantity: 2 }
    expect(resolveInpatientDose(config, '37.5 mg')).toEqual({ reason: 'fractional-quantity' })
    expect(resolveInpatientDose(config, '1 mL')).toEqual({ reason: 'unit-mismatch' })
    const legacy = { unit: '片', doses: [{ doseText: '5 mg', quantity: 1 }] }
    expect(resolveInpatientDose(legacy, '5 mg')).toEqual({ quantity: 1 })
    expect(resolveInpatientDose(legacy, '1片')).toEqual({ quantity: 1 })
    expect(resolveInpatientDose(legacy, '2片')).toEqual({ reason: 'dose-limit' })
  })
})
