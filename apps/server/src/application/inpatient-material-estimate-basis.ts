import { z } from 'zod'
import { inpatientMaterialEstimateCandidateSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientDiagnosisSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { pciSelectionProcedureCodes, pciSelectionEvidenceSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import type { ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { readInpatientCosts } from './inpatient-costs.ts'

export const materialEstimateBasisSchema = z.object({
  request: inpatientSurgeryRequestSchema.omit({ preopCheck: true, consentConfirmation: true }),
  diagnosis: inpatientDiagnosisSchema,
  investigations: inpatientInvestigationsSchema,
  candidates: z.array(inpatientMaterialEstimateCandidateSchema),
  evidencePackage: z.object({ id: z.string(), version: z.string() }).strict(),
}).strict()
export const supportsMaterialEstimate = (code: string) => ['88.5500', '88.5600', ...pciSelectionProcedureCodes].includes(code)

/** 只读取本岗位正式资料；未结构化的测量保留缺项，不从病例作者底稿推断。 */
export function readMaterialEstimateBasis(owner: InpatientService, context: ActorContext, admissionId: string, requestId: string) {
  const surgery = owner.surgery.read(context, admissionId)
  const request = surgery.requests.find(item => item.id === requestId)
  if (!request) throw new InpatientError('INPATIENT_SURGERY_NOT_FOUND', '未找到本次住院的手术计划', 404)
  const { virtualTime: _time, encounterVersion: _version, ...surgeryFacts } = surgery
  const { history: _history, ...selected } = owner.pciSelection.read(context, admissionId, requestId)
  const selectionDraft = selected.drafts?.find(draft => draft.requestId === requestId
    && (selected.confirmation === null || draft.confirmedSelectionVersion === selected.confirmation.version || draft.edited && draft.confirmedSelectionVersion === null))
  // 人工一次确认只追加确认事实，不改变已经审阅的同一草稿临床依据。
  const selection = selectionDraft ? { ...selected, confirmation: null,
    drafts: [{ ...selectionDraft, confirmedSelectionVersion: null }] } : selected
  const candidates: z.infer<typeof inpatientMaterialEstimateCandidateSchema>[] = []
  const missing: string[] = []
  const code = request.plannedProcedure.coding.code
  const angiography = code === '88.5500' || code === '88.5600'
  const evidencePackage = angiography ? { id: 'clinmesh-angiography-estimate', version: '2026-10-28.r1' }
    : { id: selection.evidencePackage.id, version: selection.evidencePackage.version }
  if (angiography) {
    const quantity = code === '88.5500' ? 1 : 2
    const material = owner.surgery.catalog(context).materials.find(item => item.id === 'hospital-material-catheter' && item.version === 1)
    const item = material && 'chargeDefinition' in material ? material : null
    const problems = item === null ? ['本院缺少已核验版本的造影导管或计价单位'] : item.chargeDefinition.unit !== '根'
      ? ['当前目录单位不匹配已核验的造影根数依据'] : item.chargeDefinition.priceFen <= 0 ? ['造影导管缺少有效正数院内价'] : []
    const quantityBasis = `正式计划 ${code} 明确${quantity}根导管；仅适用于本合成造影方案，不适用于 PCI 或真实临床选型。`
    candidates.push({ materialId: 'hospital-material-catheter', catalogVersion: 1, item, expectedQuantity: quantity,
      eligibility: problems.length > 0 ? 'unavailable' : 'valid', missing: problems, quantityBasis,
      evidence: pciSelectionEvidenceSchema.parse({ id: quantity === 1 ? 'angiography-one-catheter' : 'angiography-two-catheter',
        version: evidencePackage.version, synthetic: true, scope: `仅限正式选择 ${code} 的合成冠脉造影计划。`,
        applicability: '仅核验合成目录的诊断性冠脉造影，不推断病变长度、管径或支架需求。',
        compatibility: '合成方案仅核验 hospital-material-catheter v1；不等价于 PCI 导引导管，不扩展至其他器械。',
        specification: '合成造影导管 v1（不声明真实器械型号）', quantityBasis,
        sourceLocator: `apps/server/src/application/inpatient-material-estimate-basis.ts#${evidencePackage.version}/${code}` }) })
  } else {
    const matched = selection.confirmation?.parameters.requestId === requestId || selectionDraft !== undefined
    const parameters = selectionDraft?.parameters ?? selection.confirmation?.parameters
    if (!matched) missing.push('请核实本计划真实缺少的 PCI 测量、部位、数量来源与具体候选；已有正式确认会自动带入')
    for (const candidate of selection.candidates) {
      const basis = parameters?.plannedQuantities.find(item => item.category === candidate.category)?.basis ?? '尚无本计划正式数量依据'
      candidates.push({ materialId: candidate.materialId, catalogVersion: candidate.materialVersion, item: candidate.item,
        evidence: candidate.evidence, quantityBasis: basis, expectedQuantity: matched ? candidate.expectedQuantity : null,
        eligibility: matched ? candidate.eligibility : 'incomplete',
        missing: matched ? candidate.missing : ['尚无本计划确认的适用与数量依据', ...candidate.missing] })
    }
    // 手填路径只消费已认可集合；报告草稿按明确的合成数量依据核验。
    if (selectionDraft) {
      for (const candidate of candidates) if (candidate.eligibility !== 'valid') missing.push(...candidate.missing)
    } else if (selection.confirmation?.parameters.requestId === requestId) {
      const approved = selection.confirmation.parameters.approvedMaterialIds
      for (const materialId of approved) if (!candidates.some(candidate => candidate.materialId === materialId)) missing.push(`${materialId}: 不在已发布的 PCI 候选中`)
      for (const candidate of candidates.filter(item => approved.includes(item.materialId))) missing.push(...candidate.missing)
      if (approved.length === 0) missing.push('尚无医生确认的具体 PCI 候选')
    }
  }
  if (!supportsMaterialEstimate(code)) missing.push('本次术式尚无已核验耗材方案')
  for (const candidate of candidates) if (candidate.eligibility === 'unavailable') missing.push(...candidate.missing)
  const { preopCheck: _check, consentConfirmation: _consent, ...plan } = request
  const estimate = materialEstimateBasisSchema.parse({ request: plan,
    diagnosis: owner.orders.diagnosis(context, admissionId), investigations: owner.investigations.read(context, admissionId), candidates, evidencePackage })
  const remaining = candidates.filter(item => item.eligibility === 'valid').map(item => ({ materialId: item.materialId, quantity: item.expectedQuantity! }))
  const input = { selection: angiography ? { ...selection, confirmation: null, candidates: [], drafts: [] } : selection,
    surgery: { ...surgeryFacts, requests: [estimate.request], executions: [], inProgress: [] },
    rulesFingerprint: canonicalJsonHash({ diagnosis: estimate.diagnosis, investigations: estimate.investigations }),
    stage: 'preoperative' as const, remaining, estimate,
    costs: readInpatientCosts(owner, context, admissionId, remaining.length === 0 ? undefined : { requestId,
      items: candidates.filter(candidate => candidate.eligibility === 'valid' && candidate.item !== null).map(candidate => ({
        materialId: candidate.materialId, catalogVersion: candidate.catalogVersion, quantity: candidate.expectedQuantity!,
        unitPriceFen: candidate.item!.chargeDefinition.priceFen, display: candidate.item!.display })) }) }
  return { input, missing: [...new Set(missing)], fingerprint: canonicalJsonHash(input), request, candidates }
}
