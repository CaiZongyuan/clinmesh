import type { InpatientCosts } from '@clinmesh/contracts/inpatient-drg-simulation'
import { type InpatientPciSelection, type InpatientEquivalentMaterialSuggestion } from '@clinmesh/contracts/inpatient-pci-selection'

/** 等效仅由合成依据包显式声明；价格和规格文本不能建立等效关系。 */
export function equivalentMaterialSuggestions(selection: Pick<InpatientPciSelection, 'candidates' | 'alternatives'>,
  selected: ReadonlyArray<{ materialId: string; catalogVersion: number; quantity: number }>, costs: InpatientCosts,
  extra = false) {
  const reference = (costs.projectedGrouping?.status === 'grouped' ? costs.projectedPaymentReference : costs.currentPaymentReference)?.referenceFen
  if (reference === undefined || reference <= 0) return []
  const pool = [...selection.candidates, ...selection.alternatives]
  return selected.flatMap(row => {
    const from = pool.find(candidate => candidate.materialId === row.materialId && candidate.materialVersion === row.catalogVersion)
    if (!from?.item || from.eligibility !== 'valid' || !Number.isSafeInteger(row.quantity) || row.quantity <= 0 || row.quantity > 1000) return []
    const group = from.equivalenceGroupId
    if (!group) return []
    const beforeTotalFen = costs.components.projectedTotalFen + (extra ? from.item.chargeDefinition.priceFen * row.quantity : 0)
    if (!Number.isSafeInteger(beforeTotalFen) || BigInt(beforeTotalFen) * 10n < BigInt(reference) * 9n) return []
    return pool.flatMap(to => {
      if (to.materialId === from.materialId || !to.item || to.eligibility !== 'valid' || to.equivalenceGroupId !== group || to.category !== from.category
        || to.evidence.specification !== from.evidence.specification || to.item.chargeDefinition.unit !== from.item!.chargeDefinition.unit
        || to.item.chargeDefinition.priceFen <= 0 || to.item.chargeDefinition.priceFen >= from.item!.chargeDefinition.priceFen) return []
      const unitSavingsFen = from.item!.chargeDefinition.priceFen - to.item.chargeDefinition.priceFen, totalSavingsFen = unitSavingsFen * row.quantity
      const afterTotalFen = beforeTotalFen - totalSavingsFen
      if (!Number.isSafeInteger(totalSavingsFen) || !Number.isSafeInteger(afterTotalFen) || afterTotalFen < 0) return []
      const suggestion: InpatientEquivalentMaterialSuggestion = { groupId: group, from: from.item!, to: to.item,
        quantity: row.quantity, unitSavingsFen, totalSavingsFen, beforeTotalFen, afterTotalFen, paymentReferenceFen: reference }
      return [suggestion]
    })
  })
}
