import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientMaterialPlanSchema, inpatientMaterialPlanBasisSchema, type InpatientMaterialPlan } from '@clinmesh/contracts/inpatient-material-plan'
import type { ActorContext, CommandEffect } from './command-executor.ts'
import type { InpatientService } from './inpatient-service.ts'

/** 两种确认来源共享术后依据解析；旧计划保留其原始归属，不迁写历史。 */
export class InpatientMaterialPlans {
  constructor(readonly owner: InpatientService) {}

  forRequest(context: ActorContext, admissionId: string, requestId: string) {
    const estimates = z.array(z.object({ snapshot_json: z.string() })).parse(this.owner.database.driver.prepare(`SELECT snapshot_json
      FROM inpatient_material_plan_confirmation WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=? ORDER BY draft_revision DESC`)
      .all(context.workspaceId, context.epoch, admissionId, requestId)).map(row => inpatientMaterialPlanSchema.parse(JSON.parse(row.snapshot_json)))
    const confirmations = this.owner.pciSelection.read(context, admissionId).history
    const legacy: InpatientMaterialPlan[] = []
    for (const plan of this.owner.drgAgent.plans(context, admissionId).filter(plan => plan.stage === 'preoperative')) {
      const selection = confirmations.find(item => item.id === plan.sources.selectionConfirmationId && item.version === plan.sources.selectionVersion
        && item.parameters.requestId === requestId)
      if (!selection) continue
      legacy.push(inpatientMaterialPlanSchema.parse({ reference: `InpatientDrgPlan/${admissionId}/version/${plan.revision}`,
        requestId, source: 'drg-agent', sourceId: plan.analysisId, sourceVersion: plan.revision,
        basisFingerprint: plan.basisFingerprint, confirmedBy: plan.confirmedBy, confirmedAt: plan.confirmedAt,
        supersedes: null, reservationIds: [], items: plan.items.map(item => ({ ...item, specification: null })) }))
    }
    for (let index = 0; index < legacy.length; index++) legacy[index]!.supersedes = legacy[index + 1]?.reference ?? null
    const history = [...estimates, ...legacy]
    const oldConfirmation = z.object({ draft_json: z.string().nullable() }).optional().parse(this.owner.database.driver.prepare(`SELECT draft_json
      FROM inpatient_material_estimate WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?`)
      .get(context.workspaceId, context.epoch, admissionId, requestId))
    // 老工作稿只证明曾确认过，不能证明原确认时的完整材料快照。
    const missingSnapshot = estimates.length === 0 && oldConfirmation?.draft_json !== null && oldConfirmation?.draft_json !== undefined
      && z.object({ confirmedRevision: z.number().nullable() }).parse(JSON.parse(oldConfirmation.draft_json)).confirmedRevision !== null
    const conflict = estimates.length > 0 && legacy.length > 0
    return inpatientMaterialPlanBasisSchema.parse({ requestId, status: conflict ? 'conflict' : history.length > 0 ? 'confirmed'
      : missingSnapshot ? 'unverifiable' : 'missing', effectiveReference: conflict ? null : history[0]?.reference ?? null, history })
  }

  /** 调用者持有确认 Command 的事务、版本和术前状态校验。 */
  confirmEstimate(context: ActorContext, admissionId: string, input: Omit<InpatientMaterialPlan, 'reference' | 'supersedes'>, effects: CommandEffect[]) {
    const previous = this.forRequest(context, admissionId, input.requestId).history.find(item => item.source === 'material-estimate')
    const confirmationId = uuidv7()
    const plan = inpatientMaterialPlanSchema.parse({ ...input, reference: `InpatientMaterialPlan/${confirmationId}`, supersedes: previous?.reference ?? null })
    this.owner.database.driver.prepare('INSERT INTO inpatient_material_plan_confirmation VALUES(?,?,?,?,?,?,?,?)')
      .run(context.workspaceId, context.epoch, admissionId, input.requestId, confirmationId, input.sourceId, input.sourceVersion, JSON.stringify(plan))
    effects.push({ kind: 'created', reference: plan.reference, versionId: String(plan.sourceVersion) })
  }
}
