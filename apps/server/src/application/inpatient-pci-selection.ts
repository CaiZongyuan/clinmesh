import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientPciSelectionSchema, inpatientPciSelectionConfirmationSchema, inpatientPciSelectionConfirmInputSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import type { ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { pciSelectionEvidence, pciSelectionEvidencePackage } from './scenario-data/pci-selection-evidence.ts'

export class InpatientPciSelection {
  constructor(readonly owner: InpatientService) {}

  read(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    const rows = z.array(z.object({ confirmation_json: z.string() })).parse(this.owner.database.driver.prepare(
      'SELECT confirmation_json FROM inpatient_pci_selection WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY version DESC')
      .all(context.workspaceId, context.epoch, admissionId))
    const history = rows.map(row => inpatientPciSelectionConfirmationSchema.parse(JSON.parse(row.confirmation_json)))
    const confirmation = history[0] ?? null
    const installed = this.owner.surgery.catalog(context).materials
    const incomplete: string[] = [], incompatible: string[] = []
    if (confirmation === null) incomplete.push('尚无医生确认的测量与治疗计划')
    for (const kind of ['lesion-length', 'proximal-reference-diameter', 'distal-reference-diameter'] as const) {
      const measurement = confirmation?.parameters.measurements.find(item => item.kind === kind)
      if (measurement === undefined || measurement.value === null) { incomplete.push(`缺少测量：${kind}`); continue }
      if (measurement.unit === null) incomplete.push(`测量单位未知：${kind}`)
      else if (measurement.unit !== 'mm') incompatible.push(`测量单位不匹配合成协议：${kind}`)
      const expectedObject = kind === 'lesion-length' ? 'lesion' : 'reference-lumen'
      if (measurement.object === 'unknown') incomplete.push(`测量对象未知：${kind}`)
      else if (measurement.object !== expectedObject) incompatible.push(`测量对象不能替代合成协议要求：${kind}`)
      if (kind === 'lesion-length' && measurement.site !== confirmation!.parameters.targetSite) incompatible.push('病变测量部位与靶部位矛盾')
      if (!measurement.source.synthetic) incompatible.push('本依据包仅核验合成病例测量，不提供真实临床适用证明')
      if (kind === 'lesion-length' ? measurement.value < 5 || measurement.value > 16 : measurement.value !== 3)
        incompatible.push(`测量不在已核验仿真范围：${kind}`)
    }
    if (confirmation?.parameters.requestId !== undefined && this.owner.surgery.read(context, admissionId).requests
      .find(request => request.id === confirmation.parameters.requestId)?.status === 'cancelled') incompatible.push('关联手术计划已取消，需重新确认治疗方向')
    const combinationAvailable = pciSelectionEvidence.every(definition => installed.some(item => item.id === definition.materialId && item.version === definition.materialVersion && 'chargeDefinition' in item))
    const candidates = pciSelectionEvidence.map(definition => {
      const found = installed.find(item => item.id === definition.materialId && item.version === definition.materialVersion)
      const item = found !== undefined && 'chargeDefinition' in found ? found : null
      const quantity = confirmation?.parameters.plannedQuantities.find(plan => plan.category === definition.category)?.quantity ?? null
      const missing = [...incomplete], notApplicable = [...incompatible]
      if (item === null) missing.push('本院尚未安装此版本的可收费耗材')
      if (!combinationAvailable) missing.push('合成兼容组合存在未安装或版本不匹配的器械')
      if (quantity === null) missing.push('缺少医生独立确认的预计数量及依据')
      else if (quantity !== 1) notApplicable.push('预计数量不在已核验的单病变各一件仿真范围')
      if (!confirmation?.parameters.approvedMaterialIds.includes(definition.materialId)) missing.push('医生尚未认可此具体候选')
      if (item?.chargeDefinition.priceFen === 0) missing.push('缺少有效正数院内收费价')
      return { ...definition, item, eligibility: item === null ? 'unavailable' : notApplicable.length > 0 ? 'inapplicable' : missing.length > 0 ? 'incomplete' : 'valid',
        missing: [...missing, ...notApplicable],
        expectedQuantity: quantity, expectedAmountFen: item === null || quantity === null ? null : item.chargeDefinition.priceFen * quantity }
    })
    return inpatientPciSelectionSchema.parse({ admissionId, confirmation, history, evidencePackage: pciSelectionEvidencePackage, candidates })
  }

  confirm(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientPciSelectionConfirmInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.pci-selection.confirm',
      expectedVersions: {}, dataSchema: inpatientPciSelectionSchema,
      authorize: () => { this.owner.assertRole(context, ['inpatient-doctor']); this.owner.admissionBinding(context, input.admissionId) },
    }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      const current = this.read(context, input.admissionId).confirmation
      if ((current?.version ?? 0) !== input.expectedVersion) throw new InpatientError('INPATIENT_PCI_SELECTION_CONFLICT', '选型参数版本已变化，请刷新后重新确认')
      if (input.parameters.requestId !== undefined && !this.owner.surgery.read(context, input.admissionId).requests.some(request => request.id === input.parameters.requestId && ['requested', 'ready'].includes(request.status)))
        throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '关联手术须为本次住院有效计划')
      const confirmation = inpatientPciSelectionConfirmationSchema.parse({ id: current?.id ?? uuidv7(), version: input.expectedVersion + 1,
        parameters: input.parameters, confirmedBy: context.actorId, practitionerRoleId: context.practitionerRoleId,
        confirmedAt: this.owner.virtualTime(context) })
      this.owner.database.driver.prepare('INSERT INTO inpatient_pci_selection VALUES(?,?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, input.admissionId, confirmation.id, confirmation.version, JSON.stringify(confirmation))
      return { data: this.read(context, input.admissionId), effects: [{ kind: current === null ? 'created' as const : 'updated' as const,
        reference: `InpatientPciSelection/${confirmation.id}`, versionId: String(confirmation.version) }] }
    })
  }
}
