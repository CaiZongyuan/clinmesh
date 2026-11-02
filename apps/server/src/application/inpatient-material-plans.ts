import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import type { InpatientMaterialEstimate } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialPlanSchema, type InpatientMaterialPlan, type InpatientMaterialPlanBasis } from '@clinmesh/contracts/inpatient-material-plan'
import type { ActorContext, CommandEffect } from './command-executor.ts'
import type { readMaterialEstimateBasis } from './inpatient-material-estimate-basis.ts'
import type { InpatientService } from './inpatient-service.ts'

/** 两种确认来源共享术后依据解析；旧计划保留其原始归属，不迁写历史。 */
export class InpatientMaterialPlans {
  constructor(readonly owner: InpatientService) {}

  #estimates(context: ActorContext, admissionId: string, requestId: string) {
    return z.array(z.object({ snapshot_json: z.string() })).parse(this.owner.database.driver.prepare(`SELECT snapshot_json
      FROM inpatient_material_plan_confirmation WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=? ORDER BY draft_revision DESC`)
      .all(context.workspaceId, context.epoch, admissionId, requestId)).map(row => inpatientMaterialPlanSchema.parse(JSON.parse(row.snapshot_json)))
  }

  forRequest(context: ActorContext, admissionId: string, requestId: string): InpatientMaterialPlanBasis {
    const estimates = this.#estimates(context, admissionId, requestId)
    const legacy: InpatientMaterialPlan[] = this.owner.drgAgent.prePlansForRequest(context, admissionId, requestId).map(plan => ({
      reference: `InpatientDrgPlan/${admissionId}/version/${plan.revision}`,
      requestId, source: 'drg-agent', sourceId: plan.analysisId, sourceVersion: plan.revision,
      basisFingerprint: plan.basisFingerprint, sources: plan.sources, confirmedBy: plan.confirmedBy, confirmedAt: plan.confirmedAt,
      supersedes: null, reservationIds: [], items: plan.items.map(item => {
        const specifications = [...new Set(plan.sources.materialEvidence.filter(evidence => item.evidenceIds.includes(evidence.id)).map(evidence => evidence.specification))]
        return { ...item, specification: specifications.length === 1 ? specifications[0]! : null }
      }),
    }))
    for (let index = 0; index < legacy.length; index++) legacy[index]!.supersedes = legacy[index + 1]?.reference ?? null
    const history = [...estimates, ...legacy]
    const oldConfirmation = z.object({ draft_json: z.string().nullable() }).optional().parse(this.owner.database.driver.prepare(`SELECT draft_json
      FROM inpatient_material_estimate WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?`)
      .get(context.workspaceId, context.epoch, admissionId, requestId))
    // 老工作稿只证明曾确认过，不能证明原确认时的完整材料快照。
    const confirmedRevision = oldConfirmation?.draft_json ? z.object({ confirmedRevision: z.number().nullable() })
      .parse(JSON.parse(oldConfirmation.draft_json)).confirmedRevision : null
    const missingSnapshot = confirmedRevision !== null && !estimates.some(plan => plan.sourceVersion === confirmedRevision)
    const conflict = legacy.length > 0 && (estimates.length > 0 || missingSnapshot)
    return { requestId, status: conflict ? 'conflict' : missingSnapshot ? 'unverifiable'
      : history.length > 0 ? 'confirmed' : 'missing', effectiveReference: conflict || missingSnapshot ? null : history[0]?.reference ?? null, history }
  }

  /** 调用者持有确认 Command 的事务、版本和术前状态校验。 */
  confirmEstimate(context: ActorContext, admissionId: string, input: {
    taskId: string; requestId: string; draft: NonNullable<InpatientMaterialEstimate['draft']>;
    basis: ReturnType<typeof readMaterialEstimateBasis>; reservationIds: string[]
  }, effects: CommandEffect[]) {
    const previous = this.#estimates(context, admissionId, input.requestId)[0]
    const confirmationId = uuidv7(), { selection, estimate } = input.basis.input
    const plan: InpatientMaterialPlan = {
      reference: `InpatientMaterialPlan/${confirmationId}`, requestId: input.requestId, source: 'material-estimate',
      sourceId: input.taskId, sourceVersion: input.draft.revision, basisFingerprint: input.basis.fingerprint,
      sources: { requestId: input.requestId,
        ...(selection.confirmation ? { selectionConfirmationId: selection.confirmation.id, selectionVersion: selection.confirmation.version } : {}),
        evidencePackageId: estimate.evidencePackage.id, evidencePackageVersion: estimate.evidencePackage.version,
        materialEvidence: input.basis.candidates.map(candidate => candidate.evidence) },
      confirmedBy: context.actorId, confirmedAt: this.owner.virtualTime(context),
      supersedes: previous?.reference ?? null, reservationIds: input.reservationIds,
      items: input.draft.items.map(item => {
        const candidate = input.basis.candidates.find(candidate => candidate.materialId === item.materialId && candidate.catalogVersion === item.catalogVersion)!
        const material = candidate.item!
        return { ...item, display: material.display, unit: material.chargeDefinition.unit,
          specification: material.reference?.specification ?? candidate.evidence.specification,
          unitPriceFen: material.chargeDefinition.priceFen, estimatedFen: material.chargeDefinition.priceFen * item.quantity,
          quantityBasis: candidate.quantityBasis, evidenceIds: [candidate.evidence.id] }
      }),
    }
    this.owner.database.driver.prepare('INSERT INTO inpatient_material_plan_confirmation VALUES(?,?,?,?,?,?,?,?)')
      .run(context.workspaceId, context.epoch, admissionId, input.requestId, confirmationId, input.taskId, input.draft.revision, JSON.stringify(plan))
    effects.push({ kind: 'created', reference: plan.reference, versionId: String(plan.sourceVersion) })
  }
}
