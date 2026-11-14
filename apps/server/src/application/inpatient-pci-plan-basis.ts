import type { InpatientPciSelection, InpatientPciSelectionParameters } from '@clinmesh/contracts/inpatient-pci-selection'

type Category = InpatientPciSelectionParameters['plannedQuantities'][number]['category']
type Measurements = Pick<InpatientPciSelectionParameters, 'measurements'> & { targetSite: string | null }

export const legacyPciQuantityBasis = '合成单病变 PCI 计划：每类耗材1件'

/** 只复述本方案已有测量与明确的合成组合，不据产品规格推算适用性或数量。 */
export function pciPlanQuantityBasis(category: Category, parameters: Measurements, quantity: number,
  evidence: InpatientPciSelection['candidates'][number]['evidence']): string {
  const measurement = (kind: InpatientPciSelectionParameters['measurements'][number]['kind'], label: string) => {
    const value = parameters.measurements.find(item => item.kind === kind)
    return value?.value === null || value === undefined ? `${label}待测`
      : `${label}${value.value}${value.unit === null ? '（单位待核对）' : ` ${value.unit}`}`
  }
  switch (category) {
    case 'guidewire': return `${parameters.targetSite ?? '靶部位待核对'} · 合成方案导丝${quantity}根`
    case 'guiding-catheter': return evidence.compatibility.includes('6F导引导管') && evidence.compatibility.includes('0.014英寸导丝')
      ? '合成兼容组合：6F导引导管配0.014英寸导丝' : `计划${quantity}根导引导管`
    case 'balloon': return evidence.compatibility.includes('2.5×15 mm球囊') && evidence.compatibility.includes('3.0×18 mm支架')
      ? '合成兼容组合：2.5×15 mm预扩球囊配3.0×18 mm支架' : `计划${quantity}个预扩球囊`
    case 'stent': return [measurement('lesion-length', '病变'), measurement('proximal-reference-diameter', '近端参考'),
      measurement('distal-reference-diameter', '远端参考')].join(' · ')
  }
}
