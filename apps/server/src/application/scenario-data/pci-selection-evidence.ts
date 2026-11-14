import { pciSelectionEvidenceSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { pciDataPackage } from './pci-data.ts'

export const pciSelectionEvidencePackage = {
  id: 'clinmesh-pci-selection-evidence', version: '2026-11-13.r1', synthetic: true as const,
  limitation: '有限合成仿真依据，不是具体真实器械 IFU 或临床推荐金标准。真实价格来源不证明临床适用或器械兼容。',
}
export const pciSelectionEvidence = (['guidewire', 'guiding-catheter', 'balloon', 'stent'] as const).map(category => {
  const materialId = `hospital-material-pci-${category}`
  const definition = pciDataPackage.materials.find(material => material.item.id === materialId)!
  return { category, materialId, materialVersion: definition.item.version,
    evidence: pciSelectionEvidenceSchema.parse({ id: `pci-evidence-${category}`, version: pciSelectionEvidencePackage.version, synthetic: true,
      scope: '仅限正式 PCI 计划和报告测量支持的合成单病变择期演示，或医生确认的同范围人工参数；每类计划数量为一件，清单由医生最终确认。',
      applicability: '仿真声明：病变长度为5至16 mm；近端、远端参考管腔直径均为3.0 mm；测量部位及来源明确。此区间是合成协议，不是临床选型阈值。',
      compatibility: '合成组合声明：本包 v1 的0.014英寸导丝、6F导引导管、2.5×15 mm球囊与3.0×18 mm支架仅在此演示组合中兼容；不推及其他产品。',
      specification: definition.hospitalSupplement.specification,
      quantityBasis: '数量来自本次明确的人工计划，或报告测量适用的有限合成单病变方案（每类一件）；医生在清单确认时核对，不从目录、DRG或费用差额推算。',
      sourceLocator: `apps/server/src/application/scenario-data/pci-selection-evidence.ts#${pciSelectionEvidencePackage.version}/${category}`,
    }) }
})


/** 显式合成等效组；同组每次只选一件，不从产品名称或价格推断等效。 */
export const pciEquivalentGroups = [{
  id: 'synthetic-pci-stent-3.0x18', category: 'stent', specification: '药物洗脱支架，3.0×18 mm，合成院内规格', unit: '枚',
  members: [{ materialId: 'hospital-material-pci-stent', version: 1 }, { materialId: 'hospital-material-pci-stent-equivalent-b', version: 1 }],
}] as const

export const pciSelectionAlternatives = [{
  ...pciSelectionEvidence.find(item => item.category === 'stent')!, materialId: 'hospital-material-pci-stent-equivalent-b', materialVersion: 1,
  evidence: pciSelectionEvidenceSchema.parse({ ...pciSelectionEvidence.find(item => item.category === 'stent')!.evidence,
    id: 'pci-evidence-stent-equivalent-b',
    compatibility: '合成等效组 synthetic-pci-stent-3.0x18：A/B 支架同类别、同 3.0×18 mm 规格、同枚计量；两者均与本包 0.014 英寸导丝、6F 导引导管及 2.5×15 mm 球囊兼容。每次择一，不增加数量。',
    sourceLocator: 'apps/server/src/application/scenario-data/pci-selection-evidence.ts#synthetic-pci-stent-3.0x18',
  }),
}]
