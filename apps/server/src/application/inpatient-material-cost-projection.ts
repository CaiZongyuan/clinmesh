import { z } from 'zod'
import { inpatientMaterialEstimateDraftSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import type { ActorContext } from './command-executor.ts'
import type { InpatientService } from './inpatient-service.ts'

/** 当前读者在本住院下的明确工作稿；每份只替换自己现有预留，不创建费用或借用原任务权限。 */
export function pendingMaterialDraftCostDelta(owner: InpatientService, context: ActorContext, admissionId: string, overriddenRequestId?: string) {
  const surgery = owner.surgery.read(context, admissionId)
  const requests = surgery.requests.filter(request => request.id !== overriddenRequestId && ['requested', 'ready'].includes(request.status)
    && !surgery.inProgress.some(execution => execution.requestId === request.id))
  if (requests.length === 0) return { deltaFen: 0, missing: [] }
  const rows = z.array(z.object({ request_id: z.string(), draft_json: z.string() })).parse(owner.database.driver.prepare(`
    SELECT request_id,draft_json FROM inpatient_material_estimate
    WHERE workspace_id=? AND epoch=? AND admission_id=? AND status='active' AND draft_json IS NOT NULL`)
    .all(context.workspaceId, context.epoch, admissionId))
  const reservations = owner.drg.reservations(context, admissionId).reservations
  const catalog = owner.surgery.catalog(context).materials
  let deltaFen = 0
  const missing: string[] = []
  for (const row of rows) {
    const request = requests.find(request => request.id === row.request_id)
    if (!request) continue
    const draft = inpatientMaterialEstimateDraftSchema.parse(JSON.parse(row.draft_json))
    if (draft.confirmedRevision === draft.revision) continue
    const selection = pciSelectionProcedureCodes.includes(request.plannedProcedure.coding.code) ? owner.pciSelection.read(context, admissionId, request.id) : null
    const allowed = selection ? [...selection.candidates, ...selection.alternatives].flatMap(candidate => candidate.item === null ? [] : [candidate.item])
      : ['88.5500', '88.5600'].includes(request.plannedProcedure.coding.code) ? catalog.filter(item => item.id === 'hospital-material-catheter' && item.version === 1) : []
    let projectedFen = 0, complete = true
    for (const item of draft.items) {
      const material = allowed.find(candidate => candidate.id === item.materialId && candidate.version === item.catalogVersion)
      if (!material || !('chargeDefinition' in material) || material.chargeDefinition.priceFen <= 0) { complete = false; break }
      projectedFen += material.chargeDefinition.priceFen * item.quantity
    }
    const reservedFen = reservations.filter(item => item.requestId === request.id && item.status === 'reserved')
      .reduce((sum, item) => sum + item.priceFen * (item.remainingQuantity ?? item.quantity - item.consumedQuantity), 0)
    const next = deltaFen + projectedFen - reservedFen
    if (!complete || !Number.isSafeInteger(next)) { missing.push(`${request.plannedProcedure.coding.display}的耗材工作稿缺少可核验价格，预计费用暂不可用`); continue }
    deltaFen = next
  }
  return { deltaFen, missing: [...new Set(missing)] }
}
