import { pciSelectionEvidenceSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { pciDataPackage } from './pci-data.ts'

export const pciSelectionEvidencePackage = {
  id: 'clinmesh-pci-selection-evidence', version: '2026-10-27.r1', synthetic: true as const,
  limitation: '有限合成仿真依据，不是具体真实器械 IFU 或临床推荐金标准。真实价格来源不证明临床适用或器械兼容。',
}
export const pciSelectionEvidence = (['guidewire', 'guiding-catheter', 'balloon', 'stent'] as const).map(category => {
  const materialId = `hospital-material-pci-${category}`
  const definition = pciDataPackage.materials.find(material => material.item.id === materialId)!
  return { category, materialId, materialVersion: definition.item.version,
    evidence: pciSelectionEvidenceSchema.parse({ id: `pci-evidence-${category}`, version: pciSelectionEvidencePackage.version, synthetic: true,
      scope: '仅限医生确认的合成单病变择期 PCI 演示；每类计划数量为一件。',
      applicability: '仿真声明：病变长度为5至16 mm；近端、远端参考管腔直径均为3.0 mm；测量部位及来源明确。此区间是合成协议，不是临床选型阈值。',
      compatibility: '合成组合声明：本包 v1 的0.014英寸导丝、6F导引导管、2.5×15 mm球囊与3.0×18 mm支架仅在此演示组合中兼容；不推及其他产品。',
      specification: definition.hospitalSupplement.specification,
      quantityBasis: '预计数量只消费医生独立确认的本次计划及理由，不从目录、DRG或费用差额推算。',
      sourceLocator: `apps/server/src/application/scenario-data/pci-selection-evidence.ts#${pciSelectionEvidencePackage.version}/${category}`,
    }) }
})
