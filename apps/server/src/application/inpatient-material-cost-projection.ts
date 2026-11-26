import { z } from 'zod'
import { inpatientMaterialEstimateDraftSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { surgeryExecutionStageSchema, type SurgeryExecutionStage } from '@clinmesh/contracts/inpatient-surgery'
import type { ActorContext } from './command-executor.ts'
import type { InpatientService } from './inpatient-service.ts'

/** 仅纳入尚未确认、尚未开始且仍有效的当前住院工作稿。 */
export function readPendingMaterialDrafts(
  owner: InpatientService,
  context: ActorContext,
  admissionId: string,
  overridden?: string | { requestId: string; surgeryStage: SurgeryExecutionStage },
) {
  const overriddenRequestId = typeof overridden === 'string' ? overridden : overridden?.requestId
  const overriddenStage = typeof overridden === 'string' ? undefined : overridden?.surgeryStage
  const surgery = owner.surgery.read(context, admissionId)
  const activePairs = surgery.requests.flatMap(request => {
    const stage: SurgeryExecutionStage | undefined = ['requested', 'ready'].includes(request.status)
      ? 'primary'
      : request.status === 'standby-pci' && request.adHocPci?.status === 'converted'
        ? 'ad-hoc-pci'
        : undefined
    if (stage === undefined) return []
    if (request.id === overriddenRequestId && (overriddenStage === undefined || overriddenStage === stage)) return []
    if (surgery.inProgress.some(execution => execution.requestId === request.id && (execution.executionStage ?? 'primary') === stage)) return []
    const procedure = stage === 'ad-hoc-pci' ? request.adHocPci!.procedure : request.plannedProcedure
    return [{ request, stage, procedure }]
  })
  if (activePairs.length === 0) return []
  const rows = z.array(z.object({ request_id: z.string(), surgery_stage: surgeryExecutionStageSchema.default('primary'), draft_json: z.string() })).parse(owner.database.driver.prepare(`
    SELECT request_id,surgery_stage,draft_json FROM inpatient_material_estimate
    WHERE workspace_id=? AND epoch=? AND admission_id=? AND status='active' AND draft_json IS NOT NULL`)
    .all(context.workspaceId, context.epoch, admissionId))
  return rows.flatMap(row => {
    const matched = activePairs.find(item => item.request.id === row.request_id && item.stage === row.surgery_stage)
    if (!matched) return []
    const draft = inpatientMaterialEstimateDraftSchema.parse(JSON.parse(row.draft_json))
    return draft.confirmedRevision === draft.revision ? [] : [{ request: matched.request, stage: matched.stage, procedure: matched.procedure, draft }]
  })
}

/** 当前读者在本住院下的明确工作稿；每份只替换自己现有预留，不创建费用或借用原任务权限。 */
export function pendingMaterialDraftCostDelta(
  owner: InpatientService,
  context: ActorContext,
  admissionId: string,
  overridden?: string | { requestId: string; surgeryStage: SurgeryExecutionStage },
) {
  const pending = readPendingMaterialDrafts(owner, context, admissionId, overridden)
  if (pending.length === 0) return { deltaFen: 0, missing: [] }
  const reservations = owner.drg.reservations(context, admissionId).reservations
  const catalog = owner.surgery.catalog(context).materials
  let deltaFen = 0
  const missing: string[] = []
  for (const { request, stage, procedure, draft } of pending) {
    const selection = pciSelectionProcedureCodes.includes(procedure.coding.code) ? owner.pciSelection.read(context, admissionId, request.id) : null
    const allowed = selection ? [...selection.candidates, ...selection.alternatives].flatMap(candidate => candidate.item === null ? [] : [candidate.item])
      : ['88.5500', '88.5600'].includes(procedure.coding.code) ? catalog.filter(item => item.id === 'hospital-material-catheter' && item.version === 1) : []
    let projectedFen = 0, complete = true
    for (const item of draft.items) {
      const material = allowed.find(candidate => candidate.id === item.materialId && candidate.version === item.catalogVersion)
      if (!material || !('chargeDefinition' in material) || material.chargeDefinition.priceFen <= 0) { complete = false; break }
      projectedFen += material.chargeDefinition.priceFen * item.quantity
    }
    const reservedFen = reservations.filter(item => item.requestId === request.id && (item.surgeryStage ?? 'primary') === stage && item.status === 'reserved')
      .reduce((sum, item) => sum + item.priceFen * (item.remainingQuantity ?? item.quantity - item.consumedQuantity), 0)
    const next = deltaFen + projectedFen - reservedFen
    if (!complete || !Number.isSafeInteger(next)) { missing.push(`${procedure.coding.display}的耗材工作稿缺少可核验价格，预计费用暂不可用`); continue }
    deltaFen = next
  }
  return { deltaFen, missing: [...new Set(missing)] }
}
