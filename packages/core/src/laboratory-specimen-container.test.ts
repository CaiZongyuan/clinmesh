import { describe, expect, it } from 'vitest'
import {
  groupInvestigationDispatchUnits,
  isBloodDrawSpecimenContainer,
  resolveLaboratorySpecimenContainer,
} from './laboratory-specimen-container.ts'

describe('laboratory specimen container resolution and tube merging', () => {
  it('merges the 9 PCI preoperative indicators into purple, yellow, and blue vacutainers', () => {
    const pciRequests = [
      { id: 'req-wbc', kind: 'laboratory' as const, referenceCode: '6690-2', specimen: { code: 'whole-blood', display: '全血' } },
      { id: 'req-hgb', kind: 'laboratory' as const, referenceCode: '718-7', specimen: { code: 'whole-blood', display: '全血' } },
      { id: 'req-plt', kind: 'laboratory' as const, referenceCode: '777-3', specimen: { code: 'whole-blood', display: '全血' } },
      { id: 'req-cr', kind: 'laboratory' as const, referenceCode: '2160-0', specimen: { code: 'serum', display: '血清' } },
      { id: 'req-inr', kind: 'laboratory' as const, referenceCode: '6301-6', specimen: { code: 'citrated-plasma', display: '枸橼酸盐抗凝血浆' } },
      { id: 'req-alt', kind: 'laboratory' as const, referenceCode: '1742-6', specimen: { code: 'serum', display: '血清' } },
      { id: 'req-ast', kind: 'laboratory' as const, referenceCode: '1920-8', specimen: { code: 'serum', display: '血清' } },
      { id: 'req-k', kind: 'laboratory' as const, referenceCode: '2823-3', specimen: { code: 'serum', display: '血清' } },
      { id: 'req-na', kind: 'laboratory' as const, referenceCode: '2951-2', specimen: { code: 'serum', display: '血清' } },
    ]

    const units = groupInvestigationDispatchUnits(pciRequests)
    expect(units).toHaveLength(3)
    expect(units.map(unit => (
      unit.unitKind === 'tube'
        ? {
            bloodDraw: isBloodDrawSpecimenContainer(unit.container),
            capColor: unit.container.capColor,
            code: unit.container.code,
            containerNameZh: unit.container.containerNameZh,
            ids: unit.items.map(item => item.id),
            specimenCategoryZh: unit.container.specimenCategoryZh,
          }
        : { id: unit.item.id, unitKind: unit.unitKind }
    ))).toEqual([
      {
        bloodDraw: true,
        capColor: 'purple',
        code: 'edta-k2-purple',
        containerNameZh: 'EDTA-K2 紫头管',
        ids: ['req-wbc', 'req-hgb', 'req-plt'],
        specimenCategoryZh: '全血',
      },
      {
        bloodDraw: true,
        capColor: 'yellow',
        code: 'sst-yellow',
        containerNameZh: '促凝黄头管',
        ids: ['req-cr', 'req-alt', 'req-ast', 'req-k', 'req-na'],
        specimenCategoryZh: '血清',
      },
      {
        bloodDraw: true,
        capColor: 'blue',
        code: 'citrate-blue',
        containerNameZh: '枸橼酸钠蓝头管 (1:9)',
        ids: ['req-inr'],
        specimenCategoryZh: '抗凝血浆',
      },
    ])
  })

  it('isolates ESR black-top tubes, mixed-specimen panels, unknown specimens, unmerged rows, and non-specimen examinations', () => {
    const units = groupInvestigationDispatchUnits([
      { id: 'req-cbc', kind: 'laboratory' as const, referenceCode: 'CN-LAB-CBC-5DIFF', specimen: '全血', unavailable: false },
      { id: 'req-cbc-sent', kind: 'laboratory' as const, referenceCode: 'CN-LAB-CBC', specimen: '全血', unavailable: true },
      { id: 'req-hba1c', kind: 'laboratory' as const, referenceCode: 'CN-LAB-HBA1C', specimen: '全血', unavailable: false },
      { id: 'req-esr', kind: 'laboratory' as const, referenceCode: '0300101A', specimen: '全血', unavailable: false },
      { id: 'req-liver', kind: 'laboratory' as const, referenceCode: 'CN-LAB-LIVER', specimen: '血清、血浆', unavailable: false },
      { id: 'req-k-ion', kind: 'laboratory' as const, referenceCode: '1400605A', specimen: '全血、血清、血浆', unavailable: false },
      { id: 'req-inflam-1', kind: 'laboratory' as const, referenceCode: 'CN-LAB-INFLAMMATION', specimen: '混合标本', unavailable: false },
      { id: 'req-inflam-2', kind: 'laboratory' as const, referenceCode: 'CN-LAB-INFLAMMATION', specimen: '混合标本', unavailable: false },
      { id: 'req-urine-1', kind: 'laboratory' as const, referenceCode: 'CN-LAB-URINALYSIS', specimen: '尿液', unavailable: false },
      { id: 'req-urine-2', kind: 'laboratory' as const, referenceCode: '0600210D', specimen: '尿液', unavailable: false },
      { id: 'req-csf', kind: 'laboratory' as const, referenceCode: 'LOINC-CSF-1', specimen: '脑脊液', unavailable: false },
      { id: 'req-pleural', kind: 'laboratory' as const, referenceCode: 'LOINC-PLEURAL-1', specimen: '胸腔积液', unavailable: false },
      { id: 'req-ecg', kind: 'examination' as const, unavailable: false },
      { id: 'req-ct', kind: 'imaging' as const, unavailable: false },
    ], { unmerged: item => item.unavailable })

    expect(units.map(unit => (
      unit.unitKind === 'tube'
        ? {
            bloodDraw: isBloodDrawSpecimenContainer(unit.container),
            code: unit.container.code,
            ids: unit.items.map(item => item.id),
            mergeable: unit.container.mergeable,
          }
        : unit.unitKind === 'unmerged'
          ? { id: unit.item.id, unitKind: unit.unitKind }
          : { id: unit.item.id, kind: unit.kind, unitKind: unit.unitKind }
    ))).toEqual([
      { bloodDraw: true, code: 'edta-k2-purple', ids: ['req-cbc', 'req-hba1c'], mergeable: true },
      { id: 'req-cbc-sent', unitKind: 'unmerged' },
      { bloodDraw: true, code: 'esr-black', ids: ['req-esr'], mergeable: true },
      { bloodDraw: true, code: 'sst-yellow', ids: ['req-liver', 'req-k-ion'], mergeable: true },
      { bloodDraw: false, code: 'mixed-specimen', ids: ['req-inflam-1'], mergeable: false },
      { bloodDraw: false, code: 'mixed-specimen', ids: ['req-inflam-2'], mergeable: false },
      { bloodDraw: false, code: 'sterile-urine', ids: ['req-urine-1', 'req-urine-2'], mergeable: true },
      { bloodDraw: false, code: 'custom-specimen', ids: ['req-csf'], mergeable: false },
      { bloodDraw: false, code: 'custom-specimen', ids: ['req-pleural'], mergeable: false },
      { id: 'req-ecg', kind: 'examination', unitKind: 'non-specimen' },
      { id: 'req-ct', kind: 'imaging', unitKind: 'non-specimen' },
    ])

    expect(resolveLaboratorySpecimenContainer({ specimen: null }).mergeable).toBe(false)
  })
})
