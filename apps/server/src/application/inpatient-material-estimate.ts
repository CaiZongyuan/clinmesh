import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import {
  inpatientMaterialEstimateSchema, inpatientMaterialEstimatesSchema, inpatientMaterialEstimateDraftSchema,
  inpatientMaterialEstimateRequestInputSchema, inpatientMaterialEstimateSaveInputSchema, inpatientMaterialEstimateConfirmInputSchema,
} from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientDrgAgentAnalysisSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientAdHocPciConversionSchema, surgeryExecutionStageSchema, type SurgeryExecutionStage } from '@clinmesh/contracts/inpatient-surgery'
import type { ActorContext, CommandTransaction, CommandEffect } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { materialEstimateBasisSchema, readMaterialEstimateBasis, supportsMaterialEstimate } from './inpatient-material-estimate-basis.ts'
import { WorkspaceContextError } from '../infrastructure/sqlite/workspace-repository.ts'
import { pciEquivalentGroups } from './scenario-data/pci-selection-evidence.ts'
import { readInpatientCosts } from './inpatient-costs.ts'

const contextSchema = z.object({
  workspaceId: z.string(), epoch: z.string(), scenarioRunId: z.string(), actorId: z.string(),
  practitionerId: z.string(), practitionerRoleId: z.string(), roleCode: z.literal('inpatient-doctor'),
  organizationId: z.string(), locationId: z.string(), agentGrantId: z.string().optional()
}).strict()
  .transform(({ agentGrantId, ...context }) => ({ ...context, ...(agentGrantId === undefined ? {} : { agentGrantId }) }))
const rowSchema = z.object({
  workspace_id: z.string(), epoch: z.string(), task_id: z.string(), admission_id: z.string(), request_id: z.string(),
  surgery_stage: surgeryExecutionStageSchema.default('primary'),
  version: z.number().int().positive(), context_json: z.string(),
  authorization_operation: z.enum(['inpatient.surgery.request', 'inpatient.surgery.convert-to-pci', 'inpatient.material-estimate.request']),
  basis_json: z.string(), basis_fingerprint: z.string(), status: z.enum(['active', 'cancelled']), automatic_pending: z.number(),
  draft_json: z.string().nullable(), created_at: z.string()
})
type Row = z.infer<typeof rowSchema>
const estimateReaderOperations = ['inpatient.surgery.request', 'inpatient.surgery.convert-to-pci', 'inpatient.material-estimate.read', 'inpatient.material-estimate.request',
  'inpatient.material-estimate.save', 'inpatient.material-estimate.confirm', 'inpatient.material-estimate.cancel']
function stoppedPlanReason(status: string | undefined, started = false) {
  const reason = status === 'cancelled' ? '计划已取消' : status === 'completed' ? '手术已完成' : started ? '手术已开始' : '手术计划已不可用'
  return `${reason}，原预计不能继续应用`
}

/** 单次预计拥有意图和工作稿，生成/核验/计量/未知恢复沿用住院分析执行器。 */
export class InpatientMaterialEstimate {
  readonly #unsubscribe: () => void
  constructor(readonly owner: InpatientService, readonly contextStatus: (context: ActorContext, operations: readonly string[]) => 'active' | 'inactive' | 'superseded') {
    this.#unsubscribe = owner.commands.subscribe((context, effects) => {
      if (effects.length > 0) this.refreshPending(context.workspaceId, context.epoch)
    })
  }
  close() { this.#unsubscribe() }
  #rows(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, admissionId?: string) {
    return z.array(rowSchema).parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_material_estimate
      WHERE workspace_id=? AND epoch=? ${admissionId === undefined ? '' : 'AND admission_id=?'} ORDER BY created_at,task_id`)
      .all(context.workspaceId, context.epoch, ...(admissionId === undefined ? [] : [admissionId])))
  }
  #row(context: ActorContext, admissionId: string, requestId: string, stage: SurgeryExecutionStage = 'primary') {
    return this.#rows(context, admissionId).find(row => row.request_id === requestId && row.surgery_stage === stage)
  }
  #activeStageForRequest(context: ActorContext, admissionId: string, requestId: string): SurgeryExecutionStage {
    const request = this.owner.surgery.read(context, admissionId).requests.find(item => item.id === requestId)
    return request?.status === 'standby-pci' && request.adHocPci?.status === 'converted' ? 'ad-hoc-pci' : 'primary'
  }
  #authorize(context: ActorContext, admissionId: string, operation: string) {
    this.owner.assertRole(context, ['inpatient-doctor'])
    this.owner.assertNotArchived(context, admissionId)
    this.owner.orders.assertAdmitted(context, admissionId)
    if (this.contextStatus(context, [operation]) !== 'active') throw new InpatientError('INPATIENT_ESTIMATE_FORBIDDEN', '当前岗位不能准备本次预计', 403)
  }
  current(taskId: string) {
    const row = rowSchema.optional().parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_material_estimate WHERE task_id=?').get(taskId))
    if (!row) return undefined
    const context = contextSchema.parse(JSON.parse(row.context_json))
    try { this.#authorize(context, row.admission_id, row.authorization_operation) }
    catch (error) {
      if (error instanceof WorkspaceContextError) throw new InpatientError('INPATIENT_DRG_AGENT_STALE', '原预计所属 Workspace/Epoch 已失效')
      throw error
    }
    if (row.status !== 'active') throw new InpatientError('INPATIENT_DRG_AGENT_STALE', '本次预计已取消')
    // 终态先退出；后面的完整复查仍防止其他连接在装配期间改变状态。
    const request = z.object({ status: z.string(), ad_hoc_pci_json: z.string().nullable().default(null), started: z.number().int().min(0).max(1) }).optional().parse(this.owner.database.driver.prepare(`
      SELECT r.status, r.ad_hoc_pci_json, EXISTS(SELECT 1 FROM inpatient_surgery_execution e WHERE e.workspace_id=r.workspace_id AND e.epoch=r.epoch
        AND e.admission_id=r.admission_id AND e.request_id=r.request_id AND e.execution_stage=?) started
      FROM inpatient_surgery_request r WHERE r.workspace_id=? AND r.epoch=? AND r.admission_id=? AND r.request_id=?`)
      .get(row.surgery_stage, context.workspaceId, context.epoch, row.admission_id, row.request_id))
    const stageActive = row.surgery_stage === 'ad-hoc-pci'
      ? request?.status === 'standby-pci' && request.ad_hoc_pci_json !== null
        && inpatientAdHocPciConversionSchema.parse(JSON.parse(request.ad_hoc_pci_json)).status === 'converted'
      : request !== undefined && ['requested', 'ready'].includes(request.status)
    if (!request || !stageActive || request.started === 1)
      throw new InpatientError('INPATIENT_DRG_AGENT_STALE', stoppedPlanReason(request?.status, request?.started === 1))
    const basis = readMaterialEstimateBasis(this.owner, context, row.admission_id, row.request_id, row.surgery_stage)
    const basisActive = row.surgery_stage === 'ad-hoc-pci'
      ? basis.request.status === 'standby-pci' && basis.request.adHocPci?.status === 'converted'
      : ['requested', 'ready'].includes(basis.request.status)
    if (!basisActive)
      throw new InpatientError('INPATIENT_DRG_AGENT_STALE', stoppedPlanReason(basis.request.status))
    if (this.owner.surgery.read(context, row.admission_id).inProgress.some(item => item.requestId === row.request_id && (item.executionStage ?? 'primary') === row.surgery_stage))
      throw new InpatientError('INPATIENT_DRG_AGENT_STALE', stoppedPlanReason(basis.request.status, true))
    return { ...basis, context, task: { id: row.task_id, admissionId: row.admission_id, version: row.version }, errorCode: null }
  }
  #dto(context: ActorContext, row: Row, currentBasis?: ReturnType<typeof readMaterialEstimateBasis>) {
    let original: ReturnType<InpatientMaterialEstimate['current']>
    let stoppedReason = '原预计记录已不可用；保留快照只读'
    try { original = this.current(row.task_id) } catch (error) {
      if (!(error instanceof InpatientError)) throw error
      stoppedReason = error.code === 'INPATIENT_ESTIMATE_FORBIDDEN'
        ? '原预计岗位授权已失效，保留快照只读；请由当前主管医生重新预计'
        : error.code === 'INPATIENT_SCOPE_FORBIDDEN' ? '原预计岗位已不负责本次住院，保留快照只读；请由当前主管医生重新预计'
          : `${error.message}；保留快照只读`
    }
    const canContinue = original !== undefined
    const snapshot = materialEstimateBasisSchema.parse(JSON.parse(row.basis_json))
    const basis = context.roleCode === 'inpatient-doctor' && (canContinue || this.contextStatus(context, estimateReaderOperations) === 'active')
      ? currentBasis ?? original ?? readMaterialEstimateBasis(this.owner, context, row.admission_id, row.request_id, row.surgery_stage)
      : {
        request: snapshot.request, fingerprint: original?.fingerprint ?? '',
        missing: original?.missing ?? [stoppedReason], candidates: snapshot.candidates
      }
    const liveInput = 'input' in basis ? basis.input : undefined
    const rows = this.owner.drgAgent.analyses(row.workspace_id, row.epoch, row.task_id)
    const latest = rows.find(item => item.task_version === row.version)
    const unresolved = rows.find(item => item.status === 'unknown')
    const published = rows.find(item => item.result_json !== null)
    const analysis = published?.result_json ? inpatientDrgAgentAnalysisSchema.parse(JSON.parse(published.result_json)) : null
    const draft = row.draft_json ? inpatientMaterialEstimateDraftSchema.parse(JSON.parse(row.draft_json)) : null
    const fingerprint = basis.fingerprint || row.basis_fingerprint
    const changed = latest && latest.basis_fingerprint !== fingerprint
    let status: z.infer<typeof inpatientMaterialEstimateSchema>['status'] = latest?.status ?? 'queued'
    if (basis.missing.length > 0) status = 'incomplete'
    if (changed) status = draft?.basisFingerprint === fingerprint ? 'blocked' : 'stale'
    if (!canContinue) status = 'stale'
    if (unresolved) status = 'unknown'
    if (row.status === 'cancelled') status = 'cancelled'
    return inpatientMaterialEstimateSchema.parse({
      id: row.task_id, admissionId: row.admission_id, requestId: row.request_id,
      ...(row.surgery_stage === 'ad-hoc-pci' ? { surgeryStage: 'ad-hoc-pci' as const } : {}),
      version: row.version, requestVersion: basis.request.version, status, basisFingerprint: fingerprint,
      failureCode: unresolved ? 'MODEL_OUTCOME_UNKNOWN' : changed ? 'INPATIENT_ESTIMATE_ANALYSIS_STALE' : latest?.error_code ?? null,
      missing: basis.missing, candidates: basis.candidates, analysis, draft,
      candidateItems: analysis && analysis.basisFingerprint === fingerprint && analysis.id !== draft?.analysisId ? analysis.items : [],
      planBasis: this.owner.materialPlans.forRequest(context, row.admission_id, row.request_id, row.surgery_stage),
      equivalentSuggestions: liveInput?.equivalentSuggestions ?? [],
      materialDraftDeltaFen: draft !== null && draft.confirmedRevision === draft.revision ? null
        : 'materialDraftDeltaFen' in basis ? basis.materialDraftDeltaFen : null,
      materialDraftReservationBasis: 'materialDraftReservationBasis' in basis ? basis.materialDraftReservationBasis : null,
      costs: liveInput?.costs ?? readInpatientCosts(this.owner, context, row.admission_id)
    })
  }
  list(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    const rows = this.#rows(context, admissionId)
    // 使用当前读者的受信权限；非医生读取持久快照，不借用原医生装配权限。
    const estimates = rows.map(row => this.#dto(context, row))
    const canInspectUnprepared = context.roleCode === 'inpatient-doctor' && this.contextStatus(context, estimateReaderOperations) === 'active'
    const unprepared = !canInspectUnprepared ? [] : this.owner.surgery.read(context, admissionId).requests.flatMap(request => {
      const items: Array<{ requestId: string; surgeryStage?: 'ad-hoc-pci'; requestVersion: number; basisFingerprint: string }> = []
      if (supportsMaterialEstimate(request.plannedProcedure.coding.code) && ['requested', 'ready'].includes(request.status)
        && !rows.some(row => row.request_id === request.id && row.surgery_stage === 'primary')) {
        items.push({
          requestId: request.id, requestVersion: request.version,
          basisFingerprint: readMaterialEstimateBasis(this.owner, context, admissionId, request.id, 'primary').fingerprint,
        })
      }
      if (request.status === 'standby-pci' && request.adHocPci?.status === 'converted'
        && supportsMaterialEstimate(request.adHocPci.procedure.coding.code)
        && !rows.some(row => row.request_id === request.id && row.surgery_stage === 'ad-hoc-pci')) {
        items.push({
          requestId: request.id, surgeryStage: 'ad-hoc-pci', requestVersion: request.version,
          basisFingerprint: readMaterialEstimateBasis(this.owner, context, admissionId, request.id, 'ad-hoc-pci').fingerprint,
        })
      }
      return items
    })
    return inpatientMaterialEstimatesSchema.parse({ admissionId, estimates, unprepared })
  }
  #create(context: ActorContext, admissionId: string, requestId: string, operation: Row['authorization_operation'], stage: SurgeryExecutionStage = 'primary') {
    const id = uuidv7()
    const basis = readMaterialEstimateBasis(this.owner, context, admissionId, requestId, stage)
    this.owner.database.driver.prepare(`INSERT INTO inpatient_material_estimate
      (workspace_id,epoch,task_id,admission_id,request_id,surgery_stage,version,context_json,authorization_operation,basis_json,basis_fingerprint,status,created_at) VALUES(?,?,?,?,?,?,1,?,?,?,?,'active',?)`)
      .run(context.workspaceId, context.epoch, id, admissionId, requestId, stage, JSON.stringify(contextSchema.parse(context)), operation, JSON.stringify(basis.input.estimate), basis.fingerprint, this.owner.virtualTime(context))
    return this.#row(context, admissionId, requestId, stage)!
  }
  automatic(context: ActorContext, admissionId: string, requestId: string, transaction: CommandTransaction, stage: SurgeryExecutionStage = 'primary') {
    const request = this.owner.surgery.read(context, admissionId).requests.find(item => item.id === requestId)!
    const code = stage === 'ad-hoc-pci' ? request.adHocPci?.procedure.coding.code : request.plannedProcedure.coding.code
    if (code === undefined || !supportsMaterialEstimate(code)) return
    const operation = stage === 'ad-hoc-pci' ? 'inpatient.surgery.convert-to-pci' : 'inpatient.surgery.request'
    const row = this.#create(context, admissionId, requestId, operation, stage)
    try { this.#queue(row, transaction) } catch (error) { if (!(error instanceof InpatientError)) throw error }
  }
  #queue(row: Row, transaction?: CommandTransaction) {
    const basis = this.current(row.task_id)
    if (!basis || basis.missing.length > 0) return
    this.owner.drgAgent.enqueueEstimate(basis, transaction)
    this.owner.database.driver.prepare('UPDATE inpatient_material_estimate SET automatic_pending=0,basis_json=?,basis_fingerprint=? WHERE workspace_id=? AND epoch=? AND task_id=? AND version=?')
      .run(JSON.stringify(basis.input.estimate), basis.fingerprint, row.workspace_id, row.epoch, row.task_id, row.version)
  }
  /** 在调用方事务内取消指定手术阶段的活动耗材预计（例如放弃已转换的同台 PCI 计划）。 */
  cancelStageInTransaction(
    context: ActorContext,
    admissionId: string,
    requestId: string,
    stage: SurgeryExecutionStage,
    effects: CommandEffect[],
  ) {
    const estimateRow = z.object({ task_id: z.string(), version: z.number() }).optional().parse(
      this.owner.database.driver.prepare(
        "SELECT task_id, version FROM inpatient_material_estimate WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=? AND surgery_stage=? AND status='active'",
      ).get(context.workspaceId, context.epoch, admissionId, requestId, stage),
    )
    if (!estimateRow) return
    this.owner.database.driver.prepare(
      "UPDATE inpatient_material_estimate SET status='cancelled', automatic_pending=0, version=version+1 WHERE workspace_id=? AND epoch=? AND task_id=? AND version=?",
    ).run(context.workspaceId, context.epoch, estimateRow.task_id, estimateRow.version)
    effects.push({ kind: 'updated', reference: `InpatientMaterialEstimate/${estimateRow.task_id}`, versionId: String(estimateRow.version + 1) })
  }
  refreshPending(workspaceId?: string, epoch?: string) {
    const rows = z.array(rowSchema).parse(this.owner.database.driver.prepare(`SELECT * FROM inpatient_material_estimate
      WHERE automatic_pending=1 AND status='active' ${workspaceId === undefined ? '' : 'AND workspace_id=? AND epoch=?'}`)
      .all(...(workspaceId === undefined ? [] : [workspaceId, epoch ?? ''])))
    for (const row of rows) {
      try { this.owner.database.driver.transaction(() => this.#queue(row))() }
      catch (error) { if (!(error instanceof InpatientError)) throw error }
    }
  }
  request(context: ActorContext, raw: unknown, key: string, cancel = false) {
    const input = inpatientMaterialEstimateRequestInputSchema.parse(raw)
    return this.owner.commands.execute({
      context, input, idempotencyKey: key,
      operation: `inpatient.material-estimate.${cancel ? 'cancel' : 'request'}`, expectedVersions: {}, dataSchema: inpatientMaterialEstimateSchema,
      authorize: () => this.#authorize(context, input.admissionId, `inpatient.material-estimate.${cancel ? 'cancel' : 'request'}`)
    }, transaction => {
      const stage = this.#activeStageForRequest(context, input.admissionId, input.requestId)
      let row = this.#row(context, input.admissionId, input.requestId, stage)
      const basis = readMaterialEstimateBasis(this.owner, context, input.admissionId, input.requestId, stage)
      if ((row?.version ?? 0) !== input.expectedVersion || basis.request.version !== input.expectedRequestVersion || basis.fingerprint !== input.expectedBasisFingerprint)
        throw new InpatientError('INPATIENT_ESTIMATE_CONFLICT', '计划、预计或正式依据已变化，请刷新核对')
      const procedureCode = stage === 'ad-hoc-pci' ? basis.request.adHocPci?.procedure.coding.code : basis.request.plannedProcedure.coding.code
      const stageActive = stage === 'ad-hoc-pci'
        ? (basis.request.status === 'standby-pci' && basis.request.adHocPci?.status === 'converted')
        : ['requested', 'ready'].includes(basis.request.status)
      if (procedureCode === undefined || !supportsMaterialEstimate(procedureCode) || !stageActive)
        throw new InpatientError('INPATIENT_DRG_AGENT_STALE', '该计划不支持本次预计')
      if (!row && cancel) throw new InpatientError('INPATIENT_ESTIMATE_CONFLICT', '本计划尚无预计意图，无需取消')
      if (row && !cancel) {
        const rows = this.owner.drgAgent.analyses(context.workspaceId, context.epoch, row.task_id)
        const unknown = this.owner.database.driver.prepare("SELECT 1 FROM model_task_step WHERE workspace_id=? AND task_id=? AND status IN ('unknown','dispatching') LIMIT 1")
          .get(context.workspaceId, row.task_id)
        if (unknown || rows.some(item => item.status === 'unknown' || item.status === 'running'))
          throw new InpatientError('MODEL_OUTCOME_UNKNOWN', '原请求仍在执行或结果未知，请先核查原尝试；不会重新派发')
      }
      if (!row) row = this.#create(context, input.admissionId, input.requestId, 'inpatient.material-estimate.request', stage)
      else this.owner.database.driver.prepare(`UPDATE inpatient_material_estimate SET version=version+1,context_json=?,authorization_operation=?,basis_json=?,basis_fingerprint=?,status=?,automatic_pending=?
        WHERE workspace_id=? AND epoch=? AND task_id=? AND version=?`)
        .run(cancel ? row.context_json : JSON.stringify(contextSchema.parse(context)), cancel ? row.authorization_operation : 'inpatient.material-estimate.request',
          JSON.stringify(basis.input.estimate), basis.fingerprint, cancel ? 'cancelled' : 'active', cancel ? 0 : 1,
          context.workspaceId, context.epoch, row.task_id, row.version)
      row = this.#row(context, input.admissionId, input.requestId, stage)!
      if (!cancel) this.#queue(row, transaction)
      return { data: this.#dto(context, row), effects: [{ kind: 'updated' as const, reference: `InpatientMaterialEstimate/${row.task_id}`, versionId: String(row.version) }] }
    })
  }
  save(context: ActorContext, raw: unknown, key: string) {
    const input = inpatientMaterialEstimateSaveInputSchema.parse(raw)
    return this.owner.commands.execute({
      context, input, idempotencyKey: key, operation: 'inpatient.material-estimate.save',
      expectedVersions: {}, dataSchema: inpatientMaterialEstimateSchema, authorize: () => this.#authorize(context, input.admissionId, 'inpatient.material-estimate.save')
    }, () => {
      const stage = this.#activeStageForRequest(context, input.admissionId, input.requestId)
      const row = this.#row(context, input.admissionId, input.requestId, stage)
      if (!row || row.version !== input.expectedVersion) throw new InpatientError('INPATIENT_ESTIMATE_CONFLICT', '预计版本已变化')
      const state = this.#dto(context, row), previous = state.draft
      if (state.status === 'cancelled' || state.basisFingerprint !== input.expectedBasisFingerprint
        || (previous?.revision ?? 0) !== input.expectedDraftRevision)
        throw new InpatientError('INPATIENT_ESTIMATE_CONFLICT', '工作稿或依据已变化，请审阅最新差异')
      if (input.analysisId !== null && (!state.analysis || state.analysis.id !== input.analysisId || state.analysis.basisFingerprint !== state.basisFingerprint))
        throw new InpatientError('INPATIENT_DRG_AGENT_STALE', '不能采用旧生成结果')
      const draft = inpatientMaterialEstimateDraftSchema.parse({
        items: input.items, note: input.note, analysisId: input.analysisId, revision: input.expectedDraftRevision + 1,
        basisFingerprint: state.basisFingerprint, edited: true, updatedAt: this.owner.virtualTime(context), updatedBy: context.actorId,
        confirmedRevision: previous?.confirmedRevision ?? null, reservationIds: previous?.reservationIds ?? []
      })
      this.#storeDraft(row, draft)
      const currentBasis = readMaterialEstimateBasis(this.owner, context, input.admissionId, input.requestId, stage)
      if (currentBasis.fingerprint !== draft.basisFingerprint)
        this.#storeDraft(row, { ...draft, basisFingerprint: currentBasis.fingerprint, analysisId: null })
      return { data: this.#dto(context, row, currentBasis), effects: [{ kind: 'updated' as const, reference: `InpatientMaterialDraft/${row.task_id}`, versionId: String(draft.revision) }] }
    })
  }
  #storeDraft(row: Row, draft: z.infer<typeof inpatientMaterialEstimateDraftSchema>) {
    this.owner.database.driver.prepare('UPDATE inpatient_material_estimate SET draft_json=? WHERE workspace_id=? AND epoch=? AND task_id=?')
      .run(JSON.stringify(draft), row.workspace_id, row.epoch, row.task_id)
    row.draft_json = JSON.stringify(draft)
  }
  publish(taskId: string, analysis: z.infer<typeof inpatientDrgAgentAnalysisSchema>, version: number) {
    const row = rowSchema.parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_material_estimate WHERE task_id=?').get(taskId))
    if (row.version !== version || row.status !== 'active') return
    const previous = row.draft_json ? inpatientMaterialEstimateDraftSchema.parse(JSON.parse(row.draft_json)) : null
    if (previous !== null) return
    this.#storeDraft(row, inpatientMaterialEstimateDraftSchema.parse({
      revision: 1, basisFingerprint: analysis.basisFingerprint, analysisId: analysis.id,
      items: analysis.items.map(({ materialId, catalogVersion, quantity, reason }) => ({ materialId, catalogVersion, quantity, reason })), note: '',
      edited: false, updatedAt: analysis.createdAt, updatedBy: 'system', confirmedRevision: null, reservationIds: []
    }))
  }
  confirm(context: ActorContext, raw: unknown, key: string) {
    const input = inpatientMaterialEstimateConfirmInputSchema.parse(raw)
    return this.owner.commands.execute({
      context, input, idempotencyKey: key, operation: 'inpatient.material-estimate.confirm',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientMaterialEstimateSchema,
      authorize: () => this.#authorize(context, input.admissionId, 'inpatient.material-estimate.confirm')
    }, () => {
      const stage = this.#activeStageForRequest(context, input.admissionId, input.requestId)
      const row = this.#row(context, input.admissionId, input.requestId, stage)
      if (!row || row.version !== input.expectedVersion) throw new InpatientError('INPATIENT_ESTIMATE_CONFLICT', '预计版本已变化')
      const basis = readMaterialEstimateBasis(this.owner, context, input.admissionId, input.requestId, stage)
      const state = this.#dto(context, row, basis), draft = state.draft
      if (!draft || draft.revision !== input.expectedDraftRevision || state.basisFingerprint !== input.expectedBasisFingerprint
        || draft.basisFingerprint !== state.basisFingerprint || ['stale', 'cancelled', 'unknown', 'queued', 'running'].includes(state.status))
        throw new InpatientError('INPATIENT_ESTIMATE_CONFLICT', '工作稿或依据已变化，请核对后确认')
      if (draft.confirmedRevision === draft.revision) throw new InpatientError('INPATIENT_ESTIMATE_ALREADY_CONFIRMED', '此工作稿已确认，请查看原预留或修改后重新审阅')
      if (draft.items.length === 0 || draft.items.some(item => !state.candidates.some(candidate => candidate.eligibility === 'valid'
        && candidate.materialId === item.materialId && candidate.catalogVersion === item.catalogVersion && candidate.expectedQuantity === item.quantity)))
        throw new InpatientError('INPATIENT_DRG_PLAN_UNSUPPORTED', '清单含未经适用、兼容或数量依据核验的材料，请先核实')
      if (pciEquivalentGroups.some(group => draft.items.filter(item => group.members.some(member => member.materialId === item.materialId)).length > 1))
        throw new InpatientError('INPATIENT_DRG_PLAN_UNSUPPORTED', '同一合成等效组只能选择一种产品，不能增加该类计划数量')
      const effects: CommandEffect[] = []
      const selectionConfirmation = this.owner.pciSelection.confirmDraftInTransaction(context, input.admissionId, input.requestId,
        draft.items.map(item => item.materialId), effects)
      const reservations = this.owner.drg.replaceReservationsInTransaction(context, {
        admissionId: input.admissionId, requestId: input.requestId,
        expectedRequestVersion: input.expectedRequestVersion, encounterVersion: input.encounterVersion, items: draft.items,
        expectedReservationFingerprint: input.expectedReservationFingerprint, reason: input.reason
      }, effects)
      const reservationIds = reservations.reservations.filter(item => item.requestId === input.requestId && (item.surgeryStage ?? 'primary') === stage && item.status === 'reserved').map(item => item.id)
      this.owner.materialPlans.confirmEstimate(context, input.admissionId, {
        taskId: row.task_id, requestId: input.requestId, surgeryStage: stage, draft, basis: {
          ...basis,
          input: { ...basis.input, selection: { ...basis.input.selection, confirmation: selectionConfirmation } }
        }, reservationIds,
      }, effects)
      this.#storeDraft(row, {
        ...draft, confirmedRevision: draft.revision,
        reservationIds
      })
      effects.push({ kind: 'updated', reference: `InpatientMaterialDraft/${row.task_id}`, versionId: String(draft.revision) })
      return { data: this.#dto(context, row, basis), effects }
    })
  }
}
