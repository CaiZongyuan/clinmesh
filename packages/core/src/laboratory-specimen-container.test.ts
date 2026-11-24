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

  it('keeps timed or catheter urine and generic non-coagulation plasma unmerged while mapping explicit routine urine and coagulation plasma', () => {
    expect(resolveLaboratorySpecimenContainer({ referenceCode: '0600310D', specimen: '尿液' })).toMatchObject({
      code: 'sterile-urine',
      mergeable: true,
    })
    expect(resolveLaboratorySpecimenContainer({ specimen: { code: 'LP7681-2', display: '尿液' } })).toMatchObject({
      code: 'sterile-urine',
      mergeable: true,
    })
    for (const nonRoutineUrine of [
      { specimen: '24小时尿液' },
      { specimen: '导尿标本' },
      { specimen: '24-hour urine' },
      { specimen: { code: 'urine', display: '24小时尿液' } },
    ]) {
      expect(resolveLaboratorySpecimenContainer(nonRoutineUrine)).toMatchObject({
        code: 'custom-specimen',
        mergeable: false,
      })
    }

    expect(resolveLaboratorySpecimenContainer({ referenceCode: '0500103A', specimen: '血浆' })).toMatchObject({
      code: 'citrate-blue',
      mergeable: true,
    })
    expect(resolveLaboratorySpecimenContainer({ referenceCode: 'CN-LAB-COAGULATION', specimen: '血浆' })).toMatchObject({
      code: 'citrate-blue',
      mergeable: true,
    })
    expect(resolveLaboratorySpecimenContainer({ specimen: { code: 'citrated-plasma', display: '枸橼酸盐抗凝血浆' } })).toMatchObject({
      code: 'citrate-blue',
      mergeable: true,
    })
    for (const genericPlasma of [
      { specimen: '血浆' },
      { referenceCode: 'LOINC-AMMONIA-1', specimen: '血浆' },
      { referenceCode: '05999-1', specimen: { code: 'plas', display: 'Plasma' } },
    ]) {
      expect(resolveLaboratorySpecimenContainer(genericPlasma)).toMatchObject({
        code: 'custom-specimen',
        mergeable: false,
      })
    }

    expect(resolveLaboratorySpecimenContainer({ referenceCode: '0100101A', specimen: '全血' })).toMatchObject({
      code: 'edta-k2-purple',
      mergeable: true,
    })
    expect(resolveLaboratorySpecimenContainer({ specimen: { code: 'edta-blood', display: 'EDTA抗凝全血' } })).toMatchObject({
      code: 'edta-k2-purple',
      mergeable: true,
    })
    for (const nonEdtaWholeBlood of [
      { specimen: '全血' },
      { specimen: '肝素抗凝全血' },
      { specimen: '动脉全血' },
      { specimen: { code: 'whole-blood', display: '肝素抗凝全血' } },
      { specimen: 'EDTA抗凝血浆' },
    ]) {
      expect(resolveLaboratorySpecimenContainer(nonEdtaWholeBlood)).toMatchObject({
        code: 'custom-specimen',
        mergeable: false,
      })
    }
  })

  it('splits mergeable specimen tubes exceeding 20 requests into bounded 20-item collection units', () => {
    const twentyTwoSerum = Array.from({ length: 22 }, (_, index) => ({
      id: `req-serum-${index + 1}`,
      kind: 'laboratory' as const,
      specimen: '血清',
    }))
    const units = groupInvestigationDispatchUnits(twentyTwoSerum)
    expect(units).toHaveLength(2)
    expect(units.map(unit => unit.unitKind === 'tube' ? { groupKey: unit.groupKey, count: unit.items.length } : null)).toEqual([
      { count: 20, groupKey: 'tube:sst-yellow:血清:静脉采血 · 颠倒混匀 5 次后静置促凝分离血清' },
      { count: 2, groupKey: 'tube:sst-yellow:血清:静脉采血 · 颠倒混匀 5 次后静置促凝分离血清#2' },
    ])
  })
})
