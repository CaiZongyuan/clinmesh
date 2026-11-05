import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { pciSelectionProcedureCodes, inpatientPciSelectionSchema, inpatientPciSelectionConfirmationSchema, inpatientPciSelectionConfirmInputSchema, inpatientPciSelectionDraftSchema, inpatientPciSelectionSaveInputSchema, type InpatientPciSelectionParameters } from '@clinmesh/contracts/inpatient-pci-selection'
import type { ActorContext, CommandEffect } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { pciSelectionEvidence, pciSelectionEvidencePackage } from './scenario-data/pci-selection-evidence.ts'

export class InpatientPciSelection {
  constructor(readonly owner: InpatientService) {}

  read(context: ActorContext, admissionId: string, requestId?: string, source: 'current' | 'confirmation' = 'current') {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    const rows = z.array(z.object({ confirmation_json: z.string() })).parse(this.owner.database.driver.prepare(
      'SELECT confirmation_json FROM inpatient_pci_selection WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY version DESC')
      .all(context.workspaceId, context.epoch, admissionId))
    const history = rows.map(row => inpatientPciSelectionConfirmationSchema.parse(JSON.parse(row.confirmation_json)))
    const confirmation = (requestId === undefined ? history[0] : history.find(item => item.parameters.requestId === requestId)) ?? null
    const selectionRequestId = requestId ?? confirmation?.parameters.requestId
    const drafts = source === 'confirmation' ? [] : this.drafts(context, admissionId).filter(item => requestId === undefined || item.requestId === requestId)
    const draft = drafts.find(item => (selectionRequestId === undefined ? confirmation === null : item.requestId === selectionRequestId)
      && (confirmation === null || item.confirmedSelectionVersion === confirmation.version || item.edited && item.confirmedSelectionVersion === null))
    const parameters = draft?.parameters ?? confirmation?.parameters
    const installed = this.owner.surgery.catalog(context).materials
    const incomplete: string[] = [], incompatible: string[] = []
    if (!parameters) incomplete.push('尚无医生确认的测量与治疗计划')
    for (const kind of ['lesion-length', 'proximal-reference-diameter', 'distal-reference-diameter'] as const) {
      const measurement = parameters?.measurements.find(item => item.kind === kind)
      if (measurement === undefined || measurement.value === null) { incomplete.push(`缺少测量：${kind}`); continue }
      if (measurement.unit === null) incomplete.push(`测量单位未知：${kind}`)
      else if (measurement.unit !== 'mm') incompatible.push(`测量单位不匹配合成协议：${kind}`)
      const expectedObject = kind === 'lesion-length' ? 'lesion' : 'reference-lumen'
      if (measurement.object === 'unknown') incomplete.push(`测量对象未知：${kind}`)
      else if (measurement.object !== expectedObject) incompatible.push(`测量对象不能替代合成协议要求：${kind}`)
      if (kind === 'lesion-length' && measurement.site !== parameters!.targetSite) incompatible.push('病变测量部位与靶部位矛盾')
      if (!measurement.source.synthetic) incompatible.push('本依据包仅核验合成病例测量，不提供真实临床适用证明')
      if (kind === 'lesion-length' ? measurement.value < 5 || measurement.value > 16 : measurement.value !== 3)
        incompatible.push(`测量不在已核验仿真范围：${kind}`)
    }
    if (parameters?.requestId !== undefined && this.owner.surgery.read(context, admissionId).requests
      .find(request => request.id === parameters.requestId)?.status === 'cancelled') incompatible.push('关联手术计划已取消，需重新确认治疗方向')
    const combinationAvailable = pciSelectionEvidence.every(definition => installed.some(item => item.id === definition.materialId && item.version === definition.materialVersion && 'chargeDefinition' in item))
    const candidates = pciSelectionEvidence.map(definition => {
      const found = installed.find(item => item.id === definition.materialId && item.version === definition.materialVersion)
      const item = found !== undefined && 'chargeDefinition' in found ? found : null
      const quantity = parameters?.plannedQuantities.find(plan => plan.category === definition.category)?.quantity ?? null
      const missing = [...incomplete], notApplicable = [...incompatible]
      if (item === null) missing.push('本院尚未安装此版本的可收费耗材')
      if (!combinationAvailable) missing.push('合成兼容组合存在未安装或版本不匹配的器械')
      if (quantity === null) missing.push('缺少医生独立确认的预计数量及依据')
      else if (quantity !== 1) notApplicable.push('预计数量不在已核验的单病变各一件仿真范围')
      if (!draft && !confirmation?.parameters.approvedMaterialIds.includes(definition.materialId)) missing.push('医生尚未认可此具体候选')
      if (item?.chargeDefinition.priceFen === 0) missing.push('缺少有效正数院内收费价')
      const amount = item === null || quantity === null || item.chargeDefinition.priceFen === 0 ? null : item.chargeDefinition.priceFen * quantity
      if (amount !== null && !Number.isSafeInteger(amount)) missing.push('预计收费超出安全整数范围')
      return { ...definition, item, eligibility: item === null ? 'unavailable' : notApplicable.length > 0 ? 'inapplicable' : missing.length > 0 ? 'incomplete' : 'valid',
        missing: [...missing, ...notApplicable],
        expectedQuantity: quantity, expectedAmountFen: amount !== null && Number.isSafeInteger(amount) ? amount : null }
    })
    return inpatientPciSelectionSchema.parse({ admissionId, confirmation, history, evidencePackage: pciSelectionEvidencePackage, candidates, drafts })
  }

  drafts(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, admissionId: string) {
    return z.array(z.object({ draft_json: z.string() })).parse(this.owner.database.driver.prepare(`SELECT draft_json FROM inpatient_pci_selection_draft
      WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY rowid DESC`).all(context.workspaceId, context.epoch, admissionId))
      .map(row => inpatientPciSelectionDraftSchema.parse(JSON.parse(row.draft_json)))
  }

  prepareDraft(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, admissionId: string, requestId: string) {
    const request = z.object({ planned_procedure_json: z.string(), status: z.string() }).optional().parse(this.owner.database.driver.prepare(
      'SELECT planned_procedure_json,status FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?')
      .get(context.workspaceId, context.epoch, admissionId, requestId))
    if (!request || !['requested', 'ready'].includes(request.status)) return
    const procedure = z.object({ coding: z.object({ code: z.string(), display: z.string() }) }).parse(JSON.parse(request.planned_procedure_json))
    if (!pciSelectionProcedureCodes.includes(procedure.coding.code)) return
    const confirmed = this.owner.database.driver.prepare(`SELECT 1 FROM inpatient_pci_selection WHERE workspace_id=? AND epoch=? AND admission_id=?
      AND json_extract(confirmation_json,'$.parameters.requestId')=? LIMIT 1`).get(context.workspaceId, context.epoch, admissionId, requestId)
    if (confirmed || this.drafts(context, admissionId).some(draft => draft.requestId === requestId)) return
    const report = this.owner.angiography.reports(context, admissionId).find(item => item.status === 'final' || item.status === 'partial')
    if (!report) return
    const draft = inpatientPciSelectionDraftSchema.parse({ requestId, version: 1, reportId: report.id, reportVersion: report.version,
      edited: false, confirmedSelectionVersion: null, parameters: { requestId, treatmentPlan: procedure.coding.display,
        targetSite: report.targetSite, measurements: report.measurements, approvedMaterialIds: [],
        plannedQuantities: pciSelectionEvidence.map(item => ({ category: item.category, quantity: 1,
          basis: `合成单病变方案 ${pciSelectionEvidencePackage.id}/${pciSelectionEvidencePackage.version} 每类一件；不由指南、价格或目录反推数量。` })) } })
    this.owner.database.driver.prepare('INSERT INTO inpatient_pci_selection_draft VALUES(?,?,?,?,?)')
      .run(context.workspaceId, context.epoch, admissionId, requestId, JSON.stringify(draft))
  }

  preparePending(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, admissionId: string) {
    const requests = z.array(z.object({ request_id: z.string() })).parse(this.owner.database.driver.prepare(
      'SELECT request_id FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=?')
      .all(context.workspaceId, context.epoch, admissionId))
    for (const request of requests) this.prepareDraft(context, admissionId, request.request_id)
  }

  save(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientPciSelectionSaveInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.pci-selection.save', expectedVersions: {}, dataSchema: inpatientPciSelectionSchema,
      authorize: () => { this.owner.assertRole(context, ['inpatient-doctor']); this.owner.admissionBinding(context, input.admissionId) } }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      const draft = this.drafts(context, input.admissionId).find(item => item.requestId === input.requestId)
      const request = this.owner.surgery.read(context, input.admissionId).requests.find(item => item.id === input.requestId)
      if (!draft || draft.version !== input.expectedDraftVersion || !request || !['requested', 'ready'].includes(request.status)
        || input.parameters.requestId !== undefined && input.parameters.requestId !== input.requestId
        || this.owner.surgery.read(context, input.admissionId).inProgress.some(item => item.requestId === input.requestId))
        throw new InpatientError('INPATIENT_PCI_SELECTION_CONFLICT', '选型草稿或关联计划已变化，请刷新后核对')
      const plannedQuantities = input.parameters.plannedQuantities.length > 0 ? input.parameters.plannedQuantities : draft.parameters.plannedQuantities
      const approvedMaterialIds = input.parameters.approvedMaterialIds.length > 0 ? input.parameters.approvedMaterialIds : draft.parameters.approvedMaterialIds
      const parameters = { ...input.parameters, plannedQuantities, approvedMaterialIds, requestId: input.requestId }
      const nextMeasurements = this.measurementSources(context, input.admissionId, parameters,
        { reference: `InpatientPciSelectionDraft/${input.requestId}`, version: String(draft.version + 1) })
      const unchanged = !draft.edited && parameters.targetSite === draft.parameters.targetSite
        && parameters.treatmentPlan === draft.parameters.treatmentPlan
        && JSON.stringify(nextMeasurements) === JSON.stringify(draft.parameters.measurements)
        && JSON.stringify(plannedQuantities) === JSON.stringify(draft.parameters.plannedQuantities)
        && JSON.stringify(approvedMaterialIds) === JSON.stringify(draft.parameters.approvedMaterialIds)
      const nextVersion = unchanged ? draft.version : draft.version + 1
      if (!unchanged) {
        this.owner.database.driver.prepare('UPDATE inpatient_pci_selection_draft SET draft_json=? WHERE workspace_id=? AND epoch=? AND request_id=?')
          .run(JSON.stringify({ ...draft, version: nextVersion, edited: true, confirmedSelectionVersion: null,
            parameters: { ...parameters, measurements: nextMeasurements } }), context.workspaceId, context.epoch, input.requestId)
      }
      return { data: this.read(context, input.admissionId, input.requestId), effects: [{ kind: 'updated' as const,
        reference: `InpatientPciSelectionDraft/${input.requestId}`, versionId: String(nextVersion) }] }
    })
  }

  confirm(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientPciSelectionConfirmInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.pci-selection.confirm',
      expectedVersions: {}, dataSchema: inpatientPciSelectionSchema,
      authorize: () => { this.owner.assertRole(context, ['inpatient-doctor']); this.owner.admissionBinding(context, input.admissionId) },
    }, () => {
      const effects: CommandEffect[] = []
      const confirmation = this.confirmInTransaction(context, input, effects)
      const draft = this.drafts(context, input.admissionId).find(item => item.requestId === input.parameters.requestId)
      if (draft) {
        this.owner.database.driver.prepare('UPDATE inpatient_pci_selection_draft SET draft_json=? WHERE workspace_id=? AND epoch=? AND request_id=?')
          .run(JSON.stringify({ ...draft, version: draft.version + 1, edited: true, parameters: confirmation.parameters,
            confirmedSelectionVersion: confirmation.version }), context.workspaceId, context.epoch, draft.requestId)
        effects.push({ kind: 'updated', reference: `InpatientPciSelectionDraft/${draft.requestId}`, versionId: String(draft.version + 1) })
      }
      return { data: this.read(context, input.admissionId), effects }
    })
  }

  confirmDraftInTransaction(context: ActorContext, admissionId: string, requestId: string, materialIds: string[], effects: CommandEffect[]) {
    const selected = this.read(context, admissionId, requestId)
    const draft = selected.drafts?.find(item => item.requestId === requestId
      && (selected.confirmation === null || item.confirmedSelectionVersion === selected.confirmation.version || item.edited && item.confirmedSelectionVersion === null))
    if (!draft) return selected.confirmation
    const current = this.read(context, admissionId).history[0]
    const confirmation = this.confirmInTransaction(context, inpatientPciSelectionConfirmInputSchema.parse({ admissionId,
      expectedVersion: current?.version ?? 0, parameters: { ...draft.parameters, approvedMaterialIds: materialIds } }), effects)
    this.owner.database.driver.prepare('UPDATE inpatient_pci_selection_draft SET draft_json=? WHERE workspace_id=? AND epoch=? AND request_id=?')
      .run(JSON.stringify({ ...draft, confirmedSelectionVersion: confirmation.version }), context.workspaceId, context.epoch, requestId)
    return confirmation
  }

  private confirmInTransaction(context: ActorContext, input: z.infer<typeof inpatientPciSelectionConfirmInputSchema>, effects: CommandEffect[]) {
    this.owner.assertNotArchived(context, input.admissionId)
    this.owner.orders.assertAdmitted(context, input.admissionId)
    const current = this.read(context, input.admissionId).history[0] ?? null
    if ((current?.version ?? 0) !== input.expectedVersion) throw new InpatientError('INPATIENT_PCI_SELECTION_CONFLICT', '选型参数版本已变化，请刷新后重新确认')
    if (input.parameters.requestId !== undefined && !this.owner.surgery.read(context, input.admissionId).requests.some(request => request.id === input.parameters.requestId && ['requested', 'ready'].includes(request.status) && pciSelectionProcedureCodes.includes(request.plannedProcedure.coding.code)))
      throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '关联手术须为本次住院有效 PCI 计划')
    const id = current?.id ?? uuidv7(), version = input.expectedVersion + 1
    const confirmation = inpatientPciSelectionConfirmationSchema.parse({ id, version,
      parameters: { ...input.parameters, measurements: this.measurementSources(context, input.admissionId, input.parameters,
        { reference: `InpatientPciSelection/${id}`, version: String(version) }) }, confirmedBy: context.actorId, practitionerRoleId: context.practitionerRoleId,
      confirmedAt: this.owner.virtualTime(context) })
    this.owner.database.driver.prepare('INSERT INTO inpatient_pci_selection VALUES(?,?,?,?,?,?)')
      .run(context.workspaceId, context.epoch, input.admissionId, confirmation.id, confirmation.version, JSON.stringify(confirmation))
    effects.push({ kind: current === null ? 'created' : 'updated', reference: `InpatientPciSelection/${confirmation.id}`, versionId: String(confirmation.version) })
    return confirmation
  }

  private measurementSources(context: ActorContext, admissionId: string,
    parameters: Pick<InpatientPciSelectionParameters, 'requestId' | 'measurements'>, manual: { reference: string; version: string }) {
    const binding = this.drafts(context, admissionId).find(item => item.requestId === parameters.requestId)
    const reports = this.owner.angiography.reports(context, admissionId).filter(report => ['final', 'partial'].includes(report.status))
    return parameters.measurements.map(measurement => {
      const report = binding ? reports.find(item => item.id === binding.reportId && item.version === binding.reportVersion)
        : reports.find(item => `DiagnosticReport/${item.id}` === measurement.source.reference)
      if (!binding && !measurement.source.reference.startsWith('DiagnosticReport/')) return measurement
      const original = report?.measurements.find(item => item.kind === measurement.kind)
      if (original && (['object', 'site', 'value', 'unit', 'method'] as const).every(field => measurement[field] === original[field])) return original
      return { ...measurement, source: { ...manual, synthetic: report?.synthetic ?? measurement.source.synthetic,
        note: `医生人工修订；${report ? `原报告 DiagnosticReport/${report.id} v${report.version}` : '原报告来源无法核对'}` } }
    })
  }
}
