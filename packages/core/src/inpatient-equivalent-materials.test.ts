import { describe, expect, it } from 'vitest'
import { inpatientCostsSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { pciSelectionCandidateSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { equivalentMaterialSuggestions } from './inpatient-equivalent-materials.ts'

const evidence = { id: 'synthetic-stent', version: '1', synthetic: true, scope: '有限合成范围', applicability: '合成测量适用', compatibility: '显式合成组', specification: '3.0×18 mm', quantityBasis: '独立计划一枚', sourceLocator: 'synthetic-group' }
const source = pciSelectionCandidateSchema.parse({ materialId: 'stent-a', materialVersion: 1, category: 'stent', equivalenceGroupId: 'synthetic-stent-group',
  item: { id: 'stent-a', version: 1, display: '合成支架 A', chargeDefinition: { id: 'charge-a', priceFen: 73000, unit: '枚', synthetic: true, trigger: 'execution' } },
  evidence, eligibility: 'valid', missing: [], expectedQuantity: 1, expectedAmountFen: 73000 })
const alternative = pciSelectionCandidateSchema.parse({ ...source, materialId: 'stent-b',
  item: { ...source.item!, id: 'stent-b', display: '合成支架 B', chargeDefinition: { ...source.item!.chargeDefinition, id: 'charge-b', priceFen: 53000 } }, expectedAmountFen: 53000 })
const group = { status: 'grouped', drgCode: 'FM39', mdcCode: 'F', adrgCode: 'FM3', reason: null, steps: [] }
const costs = inpatientCostsSchema.parse({ fingerprint: 'a'.repeat(64), components: { formalChargesFen: 810000, pendingOrdersFen: 0, remainingMaterialsFen: 90000, plannedSurgeryFen: 180000, projectedTotalFen: 1080000 },
  currentGrouping: group, projectedGrouping: group, currentPaymentReference: null,
  projectedPaymentReference: { parameterSetId: 'synthetic', parameterVersion: '1', drgCode: 'FM39', referenceFen: 1200000, note: '合成参考' },
  currentDifferenceFen: null, projectedDifferenceFen: 120000, paymentStatus: 'available', paymentMessage: '合成可用', exceptionAlert: 'below-threshold' })
const selection = { candidates: [source], alternatives: [alternative] }
const selected = [{ materialId: source.materialId, catalogVersion: 1, quantity: 1 }]

describe('公开等效建议规则', () => {
  it('仅相同显式组、类别、规格和单位的更低单价有效候选可被建议，数量保持不变', () => {
    expect(equivalentMaterialSuggestions(selection, selected, { ...costs, projectionComplete: false, projectionMissing: ['未核验价格'] })).toEqual([])
    expect(equivalentMaterialSuggestions(selection, selected, costs)).toMatchObject([{ quantity: 1, unitSavingsFen: 20000, afterTotalFen: 1060000 }])
    for (const change of [ { equivalenceGroupId: null }, { equivalenceGroupId: 'another-group' }, { category: 'balloon' },
      { evidence: { ...evidence, specification: '3.5×18 mm' } }, { eligibility: 'inapplicable' },
      { item: { ...alternative.item!, chargeDefinition: { ...alternative.item!.chargeDefinition, unit: '个' } } },
      { item: { ...alternative.item!, chargeDefinition: { ...alternative.item!.chargeDefinition, priceFen: 73000 } } },
    ]) {
      const candidate = pciSelectionCandidateSchema.parse({ ...alternative, ...change })
      expect(equivalentMaterialSuggestions({ candidates: [source], alternatives: [candidate] }, selected, costs)).toEqual([])
    }
  })
  it('计划外输入计入本笔数量与费用后再判断九成阈值，不把一次替换当成减少用量', () => {
    const before = { ...costs, components: { ...costs.components, projectedTotalFen: 934000 } }
    expect(equivalentMaterialSuggestions(selection, selected, before, true)).toEqual([])
    expect(equivalentMaterialSuggestions(selection, [{ ...selected[0]!, quantity: 2 }], before, true)).toMatchObject([{ quantity: 2, beforeTotalFen: 1080000, totalSavingsFen: 40000, afterTotalFen: 1040000 }])
  })
})
