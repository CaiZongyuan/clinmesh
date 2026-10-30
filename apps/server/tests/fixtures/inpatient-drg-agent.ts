import type { InpatientPciSelectionParameters } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimatesSchema, inpatientMaterialEstimateResponseSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import type { PciPaymentDrgFixture } from './pci-payment-drg.ts'
import assert from 'node:assert/strict'

/** 持续跟进的独立旅程显式取消自动单次意图；两类授权、预算和恢复分别验证。 */
export async function cancelAutomaticMaterialEstimate(fixture: PciPaymentDrgFixture, stay: { path: string; requestId: string }) {
  const state = (await fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates
    .find(item => item.requestId === stay.requestId)
  assert.ok(state)
  const cancelled = await fixture.request('inpatient-doctor', `${stay.path}/material-estimates/cancel`, {
    requestId: state.requestId, expectedVersion: state.version, expectedRequestVersion: state.requestVersion, expectedBasisFingerprint: state.basisFingerprint,
  })
  assert.equal(cancelled.status, 200)
  inpatientMaterialEstimateResponseSchema.parse(await cancelled.json())
}

/** 独立手写的合成正对照；测量和数量由医生输入，不从产品规格或推荐结果导出。 */
export const pciAgentParameters: InpatientPciSelectionParameters = {
  treatmentPlan: '择期单病变 PCI，合成病例的既定治疗方向', targetSite: 'LAD 中段',
  measurements: [
    { kind: 'lesion-length', object: 'lesion', site: 'LAD 中段', value: 12, unit: 'mm', method: 'IVUS 电动回撤',
      source: { reference: 'synthetic-ivus-report', version: '1', note: '医生核对的合成病变长度', synthetic: true } },
    { kind: 'proximal-reference-diameter', object: 'reference-lumen', site: 'LAD 近端参考段', value: 3, unit: 'mm', method: 'IVUS',
      source: { reference: 'synthetic-ivus-report', version: '1', note: '合成近端管腔测量', synthetic: true } },
    { kind: 'distal-reference-diameter', object: 'reference-lumen', site: 'LAD 远端参考段', value: 3, unit: 'mm', method: 'IVUS',
      source: { reference: 'synthetic-ivus-report', version: '1', note: '合成远端管腔测量', synthetic: true } },
  ],
  plannedQuantities: [
    { category: 'guidewire', quantity: 1, basis: '医生确认本次合成操作计划一根导丝' },
    { category: 'guiding-catheter', quantity: 1, basis: '医生确认本次合成操作计划一根导引导管' },
    { category: 'balloon', quantity: 1, basis: '医生确认本次合成操作计划一个预扩球囊' },
    { category: 'stent', quantity: 1, basis: '医生确认本次合成单病变计划一枚支架' },
  ],
  approvedMaterialIds: ['hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter', 'hospital-material-pci-balloon', 'hospital-material-pci-stent'],
}

export const pciAgentGeneration = { items: [
  { materialId: 'hospital-material-pci-guidewire', catalogVersion: 1, quantity: 1, evidenceIds: ['pci-evidence-guidewire'], reason: '已核对合成导丝组合' },
  { materialId: 'hospital-material-pci-guiding-catheter', catalogVersion: 1, quantity: 1, evidenceIds: ['pci-evidence-guiding-catheter'], reason: '已核对合成导管组合' },
  { materialId: 'hospital-material-pci-balloon', catalogVersion: 1, quantity: 1, evidenceIds: ['pci-evidence-balloon'], reason: '已核对合成球囊组合' },
  { materialId: 'hospital-material-pci-stent', catalogVersion: 1, quantity: 1, evidenceIds: ['pci-evidence-stent'], reason: '已核对合成支架组合' },
] }
export const pciAgentVerification = { items: pciAgentGeneration.items.map(item => ({ materialId: item.materialId,
  applicable: true, compatible: true, quantitySupported: true, evidenceSupported: true, reason: '独立受控核验通过，仅限本次合成范围' })) }
